/**
 * fence-engine · 版本化 + dry-run 回放 + 对象写锁（F2.4/F2.5/F2.6/L2.4/E2.5）
 *
 *  - dryRunReplay：新规则版本激活前，回放最近 10 条历史动作做模拟判定（DRY_RUN_REPLAY_LIMIT），
 *    报告落 fence_dry_runs（pending）；未确认不得激活（L2.4）
 *  - activateRuleVersion：dry-run 已确认 + 审批事件 ID 齐备才允许激活（F2.4 留痕）
 *  - withObjectLock：对象写锁（pg advisory try-lock；超时转「需介入」，禁强制抢锁，E2.5）
 */
import type pg from "pg";
import { DRY_RUN_REPLAY_LIMIT, OBJECT_LOCK_TIMEOUT_MS, type BusinessEvent } from "@workloom/shared";
import { judge, type JudgeVerdict, type RuntimeRule } from "./judge.js";
import { checkCandidateAgainstBaseline } from "./dsl.js";

/* ---------- dry-run 回放（F2.5） ---------- */

export interface DryRunReport {
  ruleId: string;
  ruleVersion: string;
  replayed: number;
  wouldBlock: string[]; // event_id 列表
  wouldReview: string[];
  unchanged: number;
  impact: string; // 人读摘要
  /** 与现行规则集的差量（提供 baseline 时给出；HP-02 补 F2.5 证据缺口） */
  delta?: DryRunDelta;
}

/**
 * HP-02：dry-run 差量。原实现只回放候选规则，报告里没有"相对现行规则发生了什么"，
 * 于是「原本 block、候选放行」的宽松化补丁与「无影响」补丁在报告里长得一模一样，
 * 人工确认（L2.4）失去判断依据。newlyAuto 是必须人工确认的危险方向。
 */
export interface DryRunDelta {
  newlyAuto: string[]; // 原非 auto → 候选 auto（放宽，须人工确认）
  newlyBlocked: string[]; // 原非 block → 候选 block（加严）
  newlyReview: string[]; // 原非 review → 候选 review（新增挂起）
  summary: string;
}

/** HP-02：dry-run 差量（纯函数，可单测）：按 event_id 对齐现行与候选判定，归三联。 */
export function diffDryRunVerdicts(
  baseline: Array<{ eventId: string; verdict: JudgeVerdict }>,
  candidate: Array<{ eventId: string; verdict: JudgeVerdict }>,
): DryRunDelta {
  const beforeById = new Map(baseline.map((v) => [v.eventId, v.verdict.level]));
  const newlyAuto: string[] = [];
  const newlyBlocked: string[] = [];
  const newlyReview: string[] = [];
  for (const v of candidate) {
    const before = beforeById.get(v.eventId) ?? "auto";
    const after = v.verdict.level;
    if (after === before) continue;
    if (after === "auto") newlyAuto.push(v.eventId);
    else if (after === "block") newlyBlocked.push(v.eventId);
    else newlyReview.push(v.eventId);
  }
  return {
    newlyAuto, newlyBlocked, newlyReview,
    summary:
      `相对现行规则：放宽 ${newlyAuto.length} · 加严 ${newlyBlocked.length} · 转挂起 ${newlyReview.length}` +
      (newlyAuto.length > 0 ? "（存在放宽，须人工确认）" : ""),
  };
}

/** 从五元事件还原判定输入 */
export function eventToJudgeInput(ev: BusinessEvent): {
  object: { type: string; id?: string };
  action: string;
  params?: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
  context?: Record<string, unknown>;
} {
  return {
    object: { type: ev.object.type, id: ev.object.id },
    action: ev.decision.action,
    params: (ev.decision as Record<string, unknown>).params as Record<string, unknown> | undefined,
    before: ev.decision.before,
    after: ev.decision.after,
    context: ev.context as Record<string, unknown>,
  };
}

/** 纯回放：给定历史事件与候选规则集，产出模拟判定报告（纯函数） */
export function replayRules(
  events: BusinessEvent[],
  rules: RuntimeRule[],
  defaultLevel: "auto" | "review" | "block",
): { verdicts: Array<{ eventId: string; verdict: JudgeVerdict }> } {
  return {
    verdicts: events.map((ev) => ({
      eventId: ev.event_id,
      verdict: judge(eventToJudgeInput(ev), rules, defaultLevel),
    })),
  };
}

/** dry-run 入库：回放最近 10 条 → fence_dry_runs（pending，待人类确认） */
export async function createDryRun(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  input: {
    ruleId: string;
    ruleVersion: string;
    rules: RuntimeRule[];
    defaultLevel: "auto" | "review" | "block";
    createdBy: string;
    /** 现行生效规则集（提供则产出差量；HP-02） */
    baseline?: { rules: RuntimeRule[]; defaultLevel: "auto" | "review" | "block" };
  },
): Promise<{ dryRunId: string; report: DryRunReport }> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const rows = await client.query<{ payload: BusinessEvent }>(
      `SELECT payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2
       ORDER BY seq DESC LIMIT $3`,
      [scope.tenantId, scope.workspaceId, DRY_RUN_REPLAY_LIMIT],
    );
    const events = rows.rows.map((r) => r.payload);
    const { verdicts } = replayRules(events, input.rules, input.defaultLevel);
    let delta: DryRunDelta | undefined;
    if (input.baseline) {
      const base = replayRules(events, input.baseline.rules, input.baseline.defaultLevel);
      delta = diffDryRunVerdicts(base.verdicts, verdicts);
    }
    const report: DryRunReport = {
      ruleId: input.ruleId,
      ruleVersion: input.ruleVersion,
      replayed: events.length,
      wouldBlock: verdicts.filter((v) => v.verdict.level === "block").map((v) => v.eventId),
      wouldReview: verdicts.filter((v) => v.verdict.level === "review").map((v) => v.eventId),
      unchanged: verdicts.filter((v) => v.verdict.level === "auto").length,
      impact:
        `回放最近 ${events.length} 条：熔断 ${verdicts.filter((v) => v.verdict.level === "block").length} · ` +
        `挂起 ${verdicts.filter((v) => v.verdict.level === "review").length} · ` +
        `放行 ${verdicts.filter((v) => v.verdict.level === "auto").length}` +
        (delta ? ` · ${delta.summary}` : ""),
      delta,
    };
    const dryRunId = `fdr-${input.ruleId.toLowerCase()}-${Date.now().toString(36)}`;
    await client.query(
      `INSERT INTO fence_dry_runs (id, workspace_id, rule_id, rule_version, report, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [dryRunId, scope.workspaceId, input.ruleId, input.ruleVersion, JSON.stringify(report), input.createdBy],
    );
    // HP-02：COMMIT 必须走成功路径。原先放在 finally 且 .catch 吞错，提交失败会静默返回"成功"，
    // 人审依据（dry-run 报告）实际未落库却无人知晓（L2.4 证据失真）。
    await client.query("COMMIT");
    return { dryRunId, report };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- 审批 → 激活联调接线（E1 · PF.5/F2.4） ---------- */

/**
 * 候选规则行 ID 的唯一生成口径（confirmDryRun 入库与审批激活接线共用，防漂移）。
 *
 * MC-102：必须带版本号。修复前固定 `vnext` 后缀，同一 rule_id 的第二次加严提案必然撞主键，
 * 被 `ON CONFLICT (id) DO NOTHING` 静默丢弃——审批留痕 approved，但规则永不生效。
 * 版本号口径与 seed 行一致（`fr-r7-v1-ws-yunqi`），同 rule_id 的多次提案各自落在独立行上。
 */
export function fenceRuleRowId(ruleId: string, workspaceId: string, version: string): string {
  const normalized = version.trim().toLowerCase().replace(/^v/, "");
  return `fr-${ruleId.toLowerCase()}-v${normalized}-${workspaceId}`;
}

/** 版本号行尾数字（hotel-baseline/v1 → 1；v2 → 2；v-next → null，不参与递增计算） */
export function ruleVersionNumber(version: string): number | null {
  const m = /(\d+)\s*$/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

export interface RuleRowIdentity {
  rowId: string;
  /** 提案行版本号（v<max+1>）：与行 ID 同源，激活时按此口径落库 */
  version: string;
  /**
   * 同 rule_id 是否已存在基线行（平台/出厂基线锚点 F2.3）。
   * 有锚点时提案行是「覆盖层」，守卫按最严 active 行比对；无锚点为纯自定义规则。
   */
  inheritedBaseline: boolean;
}

/**
 * 事务内分配下一条规则行身份（MC-102 + MC-109）：
 *  - version = 同 rule_id 现存所有行（含 rolled_back）的最大版本号 + 1，版本号永不复用；
 *  - rowId 由 version 派生，保证同 rule_id 的第 N 次提案落在新行上（不再撞主键）；
 *  - inheritedBaseline 记录该 rule_id 是否已有基线行（提案事件留痕用，见 MC-109 的锚点口径）。
 */
export async function nextRuleRowIdentity(
  client: Pick<pg.PoolClient, "query">,
  scope: { workspaceId: string },
  ruleId: string,
): Promise<RuleRowIdentity> {
  const r = await client.query<{ version: string; is_baseline: boolean }>(
    `SELECT version, is_baseline FROM fence_rules
      WHERE (workspace_id=$1 OR workspace_id='*') AND lower(rule_id)=lower($2)`,
    [scope.workspaceId, ruleId],
  );
  const maxVersion = r.rows.reduce((max, row) => Math.max(max, ruleVersionNumber(row.version) ?? 0), 0);
  const version = `v${maxVersion + 1}`;
  return {
    rowId: fenceRuleRowId(ruleId, scope.workspaceId, version),
    version,
    inheritedBaseline: r.rows.some((row) => row.is_baseline),
  };
}

/**
 * 从事件 payload 提取围栏激活参数（纯函数，可单测）：
 * 仅当 decision.action === 'fence.rule.propose' 且 after 携带 ruleId/dryRunId 时返回参数，否则 null。
 * 消费点：server 层 approvals 手势通过后的副作用分发（P4 手势 → activateRuleVersion）。
 */
export function fenceActivationFromProposal(
  payload: unknown,
  workspaceId: string,
): { ruleRowId: string; dryRunId: string; allowWhenChange?: boolean } | null {
  const p = payload as
    | {
      decision?: {
        action?: string;
        after?: {
          ruleId?: unknown; dryRunId?: unknown; ruleRowId?: unknown; version?: unknown; allowWhenChange?: unknown;
        };
      };
    }
    | null
    | undefined;
  if (p?.decision?.action !== "fence.rule.propose") return null;
  const { ruleId, dryRunId, ruleRowId, version, allowWhenChange } = p.decision.after ?? {};
  if (typeof ruleId !== "string" || typeof dryRunId !== "string" || !ruleId || !dryRunId) return null;
  // MC-102：提案事件必须携带本行 ID（带版本），激活据此回写对应行；旧事件（无 row id）退回版本号派生。
  // MC-103：when 改写放行位必须随提案留痕带到激活期——否则提案期放行、激活期又被同一守卫拒绝，
  // 审批手势返回 500 且规则停在 pending_approval（"已批准但未生效"）。
  const extra = allowWhenChange === true ? { allowWhenChange: true as const } : {};
  if (typeof ruleRowId === "string" && ruleRowId) return { ruleRowId, dryRunId, ...extra };
  if (typeof version === "string" && version) {
    return { ruleRowId: fenceRuleRowId(ruleId, workspaceId, version), dryRunId, ...extra };
  }
  return null;
}

/**
 * 确认 dry-run 的事务内实现（pending→confirmed）。未确认不得激活（L2.4）。
 * 抽成 client 版：提案行入库、提案事件、审批行与 dry-run 确认必须同一事务同一 COMMIT
 * （confirmDryRun 走独立连接时，确认与入库之间的失败会留下"已确认但没有提案行"的半态）。
 */
export async function confirmDryRunOnTx(
  client: Pick<pg.PoolClient, "query">,
  scope: { workspaceId: string },
  dryRunId: string,
): Promise<void> {
  const r = await client.query(
    `UPDATE fence_dry_runs SET status='confirmed' WHERE id=$1 AND workspace_id=$2 AND status='pending'`,
    [dryRunId, scope.workspaceId],
  );
  if (r.rowCount === 0) throw new Error(`dry-run ${dryRunId} 不存在或非 pending（幂等约束）`);
}

/** 确认 dry-run（人类看过报告；pending→confirmed）。未确认不得激活（L2.4） */
export async function confirmDryRun(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  dryRunId: string,
): Promise<void> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await confirmDryRunOnTx(client, scope, dryRunId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 激活新版本（F2.4）：dry-run 已确认 + 审批事件 ID 齐备 */
export async function activateRuleVersion(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  input: {
    ruleRowId: string;
    dryRunId: string;
    approvalEventId: string;
    /** MC-103：提案事件携带的 when 改写放行位（须 dry-run 回放 + 人工确认后才由调用方传入） */
    allowWhenChange?: boolean;
  },
): Promise<{ version: string }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const dr = await client.query<{ status: string }>(
      `SELECT status FROM fence_dry_runs WHERE id=$1 AND workspace_id=$2`,
      [input.dryRunId, scope.workspaceId],
    );
    if (dr.rows[0]?.status !== "confirmed") {
      throw new Error(`dry-run ${input.dryRunId} 未确认，禁止激活（L2.4）`);
    }
    // ① 审批绑定验真（HP-02）：approvalEventId 必须指向本工作区真实的 approval.gesture 事件，
    //    其 after.approvalId 对应的审批行已 approved，且被审事件正是本规则的 fence.rule.propose。
    //    修复前该字段只被原样写库（伪造 event id 也能过），审批与规则行没有绑定关系。
    const gesture = await client.query<{ proposal_event_id: string }>(
      `SELECT a.event_id AS proposal_event_id
         FROM biz_events g
         JOIN approvals a
           ON a.workspace_id = g.workspace_id
          AND a.approval_id = g.payload->'decision'->'after'->>'approvalId'
         JOIN biz_events p ON p.event_id = a.event_id AND p.workspace_id = a.workspace_id
        WHERE g.workspace_id=$1 AND g.event_id=$2
          AND g.payload->'decision'->>'action' = 'approval.gesture'
          AND a.status = 'approved'
          AND p.payload->'decision'->>'action' = 'fence.rule.propose'`,
      [scope.workspaceId, input.approvalEventId],
    );
    if (!gesture.rows[0]) {
      throw new Error(`审批事件 ${input.approvalEventId} 与围栏变更提案未绑定（伪造/未绑定引用，拒绝激活）`);
    }
    // ② 候选行 + 基线单调守卫（HP-02：checkMonotonic 此前只在测试里被调用）
    const cand = await client.query<{
      rule_id: string; version: string; name: string; level: RuntimeRule["level"]; is_baseline: boolean;
      match_spec: { object_types?: string[]; actions?: string[]; when?: string };
    }>(
      `SELECT rule_id, version, name, level, is_baseline, match_spec FROM fence_rules
        WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','pending_approval')`,
      [input.ruleRowId, scope.workspaceId],
    );
    const row = cand.rows[0];
    if (!row) throw new Error(`规则 ${input.ruleRowId} 状态不允许激活`);
    const current = await loadActiveRulesInTx(client, scope, input.ruleRowId);
    const verdict = checkCandidateAgainstBaseline(current, {
      rule_id: row.rule_id,
      version: "v-next",
      name: row.name,
      level: row.level,
      is_baseline: row.is_baseline,
      objectTypes: row.match_spec.object_types ?? [],
      actions: row.match_spec.actions ?? [],
      when: row.match_spec.when ?? "",
    }, { allowWhenChange: input.allowWhenChange === true });
    if (!verdict.ok) {
      throw new Error(`基线规则只可加严，本次变更被拒：${verdict.violations.map((v) => v.reason).join("；")}`);
    }
    // ③ 版本可追溯（HP-02 + MC-102）：候选行在提案期已分配版本号（见 nextRuleRowIdentity），
    //    激活时以候选行版本为准，历史最大版本**排除候选行本身**——否则每激活一次版本号都会 +1。
    //    并发提案导致候选版本落后于已激活行时取较大值，保证不会撞 (rule_id, version, workspace_id) 唯一键。
    const hist = await client.query<{ version: string }>(
      `SELECT version FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 AND id<>$3`,
      [scope.workspaceId, row.rule_id, input.ruleRowId],
    );
    const maxVersion = hist.rows.reduce((max, r) => Math.max(max, ruleVersionNumber(r.version) ?? 0), 0);
    const version = `v${Math.max(maxVersion + 1, ruleVersionNumber(row.version) ?? 0)}`;
    // MC-109：只回滚同 rule_id 的旧租户覆盖行（is_baseline=false）；平台/出厂基线行保持 active。
    // 修复前把基线行一起 rolled_back，首次自定义后该 rule_id 就再没有比较锚点，
    // 守卫（checkCandidateAgainstBaseline）直接放行任何放宽提案。
    await client.query(
      `UPDATE fence_rules SET status='rolled_back'
        WHERE workspace_id=$1 AND rule_id=$2 AND status='active' AND is_baseline=false AND id<>$3`,
      [scope.workspaceId, row.rule_id, input.ruleRowId],
    );
    const r = await client.query(
      `UPDATE fence_rules SET status='active', version=$4, approved_event_id=$3
       WHERE id=$1 AND workspace_id=$2 AND status IN ('draft','pending_approval')`,
      [input.ruleRowId, scope.workspaceId, input.approvalEventId, version],
    );
    if (r.rowCount === 0) throw new Error(`规则 ${input.ruleRowId} 状态不允许激活`);
    await client.query("COMMIT");
    return { version };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 载入工作区当前生效规则（含全局 '*' 基线），可排除指定行（激活中的候选行）。
 * 供激活路径与提案路径（router）复用，保证两处判定输入口径一致。
 */
export async function loadActiveRulesInTx(
  client: Pick<pg.PoolClient, "query">,
  scope: { tenantId: string; workspaceId: string },
  excludeRowId?: string,
): Promise<RuntimeRule[]> {
  const r = await client.query<{
    rule_id: string; version: string; name: string; level: RuntimeRule["level"];
    is_baseline: boolean; match_spec: { object_types?: string[]; actions?: string[]; when?: string };
  }>(
    `SELECT rule_id, version, name, level, is_baseline, match_spec
       FROM fence_rules
      WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'
        AND ($2::text IS NULL OR id <> $2)`,
    [scope.workspaceId, excludeRowId ?? null],
  );
  return r.rows.map((row) => ({
    rule_id: row.rule_id, version: row.version, name: row.name, level: row.level,
    is_baseline: row.is_baseline, objectTypes: row.match_spec.object_types ?? [],
    actions: row.match_spec.actions ?? [], when: row.match_spec.when ?? "",
  }));
}

/* ---------- 对象写锁（E2.5） ---------- */

export class ObjectLockTimeout extends Error {
  constructor(public readonly objectKey: string) {
    super(`对象写锁超时：${objectKey}（转「需介入」，禁止强制抢锁，E2.5）`);
    this.name = "ObjectLockTimeout";
  }
}

/**
 * 对象写锁：pg advisory 阻塞锁（64位 key，碰撞概率可忽略）+ statement_timeout 超时。
 * #14/#15 修复：改用 pg_advisory_xact_lock（阻塞版，内核管理等待队列）+ 64位 hash key，
 * 避免轮询占用 gateway 连接 5 秒（#15）和 hashtext 32位碰撞（#14）。
 * 锁随事务释放；超时抛 ObjectLockTimeout（调用方写「需介入」事件，L4.2）。
 */
export async function withObjectLock<T>(
  gateway: pg.Pool,
  objectKey: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  timeoutMs = OBJECT_LOCK_TIMEOUT_MS,
  /** 进入业务回调后的语句超时（0 = 用数据库默认，不设限；HP-02 起与锁等待超时解耦） */
  businessTimeoutMs = 0,
): Promise<T> {
  const client = await gateway.connect();
  const lockKey = `obj:${objectKey}`;
  const lockWaitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : OBJECT_LOCK_TIMEOUT_MS;
  const businessMs = Number.isFinite(businessTimeoutMs) && businessTimeoutMs > 0 ? Math.floor(businessTimeoutMs) : 0;
  try {
    // 用 statement_timeout 控制锁等待超时，超时后 PG 自动 abort 当前语句。
    // SET LOCAL 必须在 BEGIN 之后才生效（事务外 SET LOCAL 仅警告且无效果）。
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${lockWaitMs}`);
    // 64位确定性 hash key：md5 前 16 位转 bigint，碰撞概率远低于 hashtext 32位
    const r = await client.query<{ k: string }>(
      `SELECT ('x' || substr(md5($1), 1, 16))::bit(64)::bigint AS k`,
      [lockKey],
    );
    const lockKeyBig = r.rows[0]?.k;
    // 阻塞版 advisory lock：拿不到锁时 PG 内核排队等待，不占用 Node 侧连接轮询
    // HP-02：超时只允许发生在「取锁」这一段；取锁后立即复位，否则 fn 内的业务语句
    // （批量写 / 长查询）会被锁等待超时误杀，并被误报成 ObjectLockTimeout「对象写锁超时（需介入）」。
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [lockKeyBig]);
    } catch (err) {
      if (err instanceof Error && /statement timeout|canceling statement/i.test(err.message)) {
        throw new ObjectLockTimeout(objectKey);
      }
      throw err;
    }
    await client.query(`SET LOCAL statement_timeout = ${businessMs}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
