/**
 * inspection · 定时只读巡检主流程（F9.1/F9.2，L9.1–L9.3，E9.1/E9.2）
 *
 * 铁律落点：
 *  - L9.1 只读由「工具集裁剪」保证：跑前断言 inspection preset readonly=true 且全部工具 access=read，
 *         否则视为巡检失败（出事件，不静默）
 *  - L9.2/E9.1 失败不允许静默跳过：任一环节失败 → 重试（默认 2 次）→ 最终写 inspect.run.failed
 *    告警事件（P0），函数照常返回报告（不吞异常、不假装平安）
 *  - F9.2 异常即事件：inspect.anomaly（高/中/低分级）；高优 → inspect.notify 立即推送（G3 ≤5min，
 *         首版 channel=inapp 本地回环——D7）
 *  - L9.3 幂等去重：当日同 (checkId+objectId) 未解决异常不重复写、不重复推送
 *  - E9.2 推送风暴：同源异常聚合为一条摘要推送，详单进面板（事件可检索）
 *  - 全部事件经 gatewayAppend 三段瀑布（G8 留痕），巡检 agent 为只读 actor（inspect.* 为读类动作）
 */
import type pg from "pg";
import { gatewayAppend } from "../workdata/gateway.js";
import {
  aggregateBySource,
  DEFAULT_PROBES,
  DEFAULT_CHECKS,
  runChecks,
  type CheckDef,
  type Finding,
  type InspectionSnapshot,
  type Probe,
  type Severity,
} from "./checks.js";

interface Scope { tenantId: string; workspaceId: string }

export class InspectionPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionPreflightError";
  }
}

export interface ScanReport {
  runId: string;
  at: string;
  ok: boolean;
  /** 检项总数 / 正常项数 / 异常数（nodata 不计入正常） */
  totalChecks: number;
  okCount: number;
  anomalies: Array<{ checkId: string; severity: Severity; summary: string; objectType: string; objectId?: string; eventId?: string; deduped?: boolean }>;
  /** 推送摘要事件 ID（同源聚合，E9.2） */
  notifyEventIds: string[];
  /** 失败时：失败事件 ID + 重试次数（L9.2） */
  failedEventId?: string;
  attempts?: number;
}

const ACTOR = { id: "inspection-agent", type: "agent" as const, readonly: true };

async function emit(
  gateway: pg.Pool,
  scope: Scope,
  at: Date,
  decision: Record<string, unknown>,
  object: { type: string; id?: string },
  links?: string[],
): Promise<string> {
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId, actor: ACTOR,
  }, {
    who: { type: "agent", id: "inspection-agent", version: "v1.2" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: at.toISOString(), channel: "inapp" },
    object,
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

/** L9.1 前置断言：巡检 preset 只读（工具集裁剪保证，非提示词约束） */
export async function assertReadonlyPreset(app: pg.Pool, scope: Scope, presetKey = "inspection-agent"): Promise<void> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ readonly: boolean; meta: { tools?: Array<{ name: string; access: string }> } }>(
      `SELECT readonly, meta FROM agents WHERE workspace_id=$1 AND preset_key=$2`,
      [scope.workspaceId, presetKey],
    );
    const agent = r.rows[0];
    if (!agent) throw new InspectionPreflightError(`巡检 preset「${presetKey}」未注册`);
    if (!agent.readonly) throw new InspectionPreflightError(`巡检 preset「${presetKey}」readonly=false，违反 L9.1（只读由工具集裁剪保证）`);
    const writeTool = (agent.meta?.tools ?? []).find((t) => t.access !== "read");
    if (writeTool) {
      throw new InspectionPreflightError(`巡检 preset「${presetKey}」加载了写工具 ${writeTool.name}，违反 L9.1`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** 只读快照装载（profiles.archive.inspection；缺项由探针报 nodata，不编造） */
export async function loadSnapshot(app: pg.Pool, scope: Scope): Promise<InspectionSnapshot> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ archive: Record<string, unknown> }>(
      `SELECT archive FROM profiles WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const insp = (r.rows[0]?.archive as { inspection?: InspectionSnapshot } | undefined)?.inspection;
    return insp ?? {};
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** L9.3 去重键 */
export function anomalyDedupeKey(f: Finding): string {
  return `${f.checkId}:${f.objectId ?? "-"}`;
}

/** 查询当日仍未解决的异常键（已有 inspect.anomaly 且无对应 inspect.resolved 回链） */
export async function listOpenAnomalyKeys(app: pg.Pool, scope: Scope, day: Date): Promise<Set<string>> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
    const anomalies = await client.query<{ event_id: string; payload: { decision: { after?: { dedupeKey?: string } } } }>(
      `SELECT event_id, payload FROM biz_events
       WHERE workspace_id=$1 AND created_at >= $2 AND payload->'decision'->>'action' = 'inspect.anomaly'`,
      [scope.workspaceId, dayStart.toISOString()],
    );
    const resolved = await client.query<{ payload: { links?: string[] } }>(
      `SELECT payload FROM biz_events
       WHERE workspace_id=$1 AND created_at >= $2 AND payload->'decision'->>'action' IN ('inspect.resolved','inspect.escalated')`,
      [scope.workspaceId, dayStart.toISOString()],
    );
    const resolvedIds = new Set(resolved.rows.flatMap((r) => r.payload.links ?? []));
    const keys = new Set<string>();
    for (const a of anomalies.rows) {
      if (resolvedIds.has(a.event_id)) continue;
      const k = a.payload.decision.after?.dedupeKey;
      if (k) keys.add(k);
    }
    return keys;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/**
 * 跑一轮巡检（默认检项=内置四检，F9.1；时刻=每日 07:00 可配，由触发器引擎 F4.7 调度——
 * 首版演示手动/触发器调用 runInspectionScan，定时挂接见 B9 tickTriggers）
 */
export async function runInspectionScan(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  opts: {
    at?: Date;
    checks?: CheckDef[];
    probes?: Record<string, Probe>;
    snapshot?: InspectionSnapshot;
    retries?: number;
  } = {},
): Promise<ScanReport> {
  const at = opts.at ?? new Date();
  const retries = opts.retries ?? 2;
  const runId = `insp-${at.toISOString().slice(0, 10)}`;

  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt <= retries) {
    attempt += 1;
    try {
      return await scanOnce(app, gateway, scope, runId, at, opts);
    } catch (err) {
      lastErr = err;
      // E9.1：重试语义；最终失败落告警事件（L9.2 不静默）
    }
  }
  const failedEventId = await emit(gateway, scope, at, {
    action: "inspect.run.failed",
    after: {
      runId, attempts: attempt, level: "p0",
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      action_required: "转人工巡检（E9.4 降级路径）",
    },
    basis: ["巡检失败必出事件不静默（L9.2/E9.1）", `重试 ${attempt - 1} 次后最终告警`],
  }, { type: "store", id: scope.workspaceId });
  return {
    runId, at: at.toISOString(), ok: false,
    totalChecks: 0, okCount: 0, anomalies: [], notifyEventIds: [],
    failedEventId, attempts: attempt,
  };
}

async function scanOnce(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  runId: string,
  at: Date,
  opts: { checks?: CheckDef[]; probes?: Record<string, Probe>; snapshot?: InspectionSnapshot },
): Promise<ScanReport> {
  await assertReadonlyPreset(app, scope); // L9.1 前置
  const snapshot = opts.snapshot ?? (await loadSnapshot(app, scope));
  const findings = runChecks(opts.checks ?? DEFAULT_CHECKS, snapshot, (opts.probes as never) ?? DEFAULT_PROBES);

  const effective = findings.filter((f) => f.status !== "nodata");
  const okCount = effective.filter((f) => f.status === "ok").length;
  const anomalies = effective.filter((f) => f.status === "anomaly");

  // L9.3：当日未解决异常去重（不重复写、不重复推送）
  const openKeys = await listOpenAnomalyKeys(app, scope, at);
  const fresh = anomalies.filter((f) => !openKeys.has(anomalyDedupeKey(f)));
  const deduped = anomalies.filter((f) => openKeys.has(anomalyDedupeKey(f)));

  // F9.2：异常即事件（分级高/中/低）
  const anomalyEventIds = new Map<string, string>();
  for (const f of fresh) {
    const id = await emit(gateway, scope, at, {
      action: "inspect.anomaly",
      after: {
        runId, checkId: f.checkId, severity: f.severity, summary: f.summary,
        dedupeKey: anomalyDedupeKey(f), source: f.source,
      },
    }, { type: f.objectType, id: f.objectId });
    anomalyEventIds.set(anomalyDedupeKey(f), id);
  }

  // G3/E9.2：高优异常 → 同源聚合为一条摘要推送（≤5min 机制=立即推送，inapp 本地回环）
  const notifyEventIds: string[] = [];
  const groups = aggregateBySource(fresh).filter((g) => g.severity === "high");
  for (const g of groups) {
    const id = await emit(gateway, scope, at, {
      action: "inspect.notify",
      after: {
        runId, severity: "high", channel: "inapp", slaMinutes: 5,
        summary: `【巡检高优】${g.source} 源 ${g.count} 项异常：${g.items[0]!.summary}${g.count > 1 ? ` 等 ${g.count} 项` : ""}`,
        detailEventIds: g.items.map((i) => anomalyEventIds.get(anomalyDedupeKey(i))).filter(Boolean),
      },
      basis: ["高优异常 IM 推送 ≤5min（G3）", "同源聚合一条摘要，详单进面板（E9.2）"],
    }, { type: "store", id: scope.workspaceId }, g.items.map((i) => anomalyEventIds.get(anomalyDedupeKey(i))!).filter(Boolean));
    notifyEventIds.push(id);
  }

  // 巡检通过事件（M9.3：正常写巡检通过事件）——汇总一条（状态条投影数据源，F9.4）
  const totalChecks = effective.length;
  await emit(gateway, scope, at, {
    action: "inspect.run.completed",
    after: {
      runId, totalChecks, okCount,
      anomalyCount: anomalies.length, dedupedCount: deduped.length,
      nodataCount: findings.length - effective.length,
    },
    basis: ["巡检状态条纯日志投影（F9.4/H-7 同源纪律，不建额外报表管道）"],
  }, { type: "store", id: scope.workspaceId });

  return {
    runId, at: at.toISOString(), ok: true,
    totalChecks, okCount,
    anomalies: [
      ...fresh.map((f) => ({
        checkId: f.checkId, severity: f.severity ?? "low" as Severity, summary: f.summary,
        objectType: f.objectType, objectId: f.objectId, eventId: anomalyEventIds.get(anomalyDedupeKey(f)),
      })),
      ...deduped.map((f) => ({
        checkId: f.checkId, severity: f.severity ?? "low" as Severity, summary: f.summary,
        objectType: f.objectType, objectId: f.objectId, deduped: true,
      })),
    ],
    notifyEventIds,
  };
}
