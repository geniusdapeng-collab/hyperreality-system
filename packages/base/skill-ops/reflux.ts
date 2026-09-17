/**
 * skill-ops · 上行回流（客户端侧，方案 v0.2 §4.2，D19 四条红线）
 *
 * ① opt-in：reflux_opt_in 默认 false，未开启直接拒发（客户可随时关闭）；
 * ② 预览即所发：refluxPreview 返回的就是 sendReflux 上送的 payload（同函数构造，可对照可编辑）；
 * ③ PII 脱敏管道：body/description 过 maskText + 敏感凭据词扫描（D15-① 同款），
 *    命中敏感词直接拒发；payload 只含技能本体与使用统计摘要，不含客户经营数据；
 * ④ 发送行为入事件库：skill.reflux.sent / skill.reflux.policy 全留痕。
 * 使用统计（六信号）在客户侧本地计算（官方拿不到客户本地信号——数据主权），
 * 官方只负责按摘要排序；样本稀疏（<20 手势/调用）标记 sparse，供官方降权。
 */
import type pg from "pg";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { maskText } from "../workdata/pii.js";
import { scanSkillForPublish } from "../skills/publish.js";
import { createHmac } from "node:crypto";

interface Scope { tenantId: string; workspaceId: string }

export class RefluxError extends Error {
  constructor(
    public readonly code: "OPT_IN_REQUIRED" | "NOT_FOUND" | "MASK_BLOCKED" | "SEND_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "RefluxError";
  }
}

/* ---------- 六信号使用摘要（客户侧本地计算；权重见方案 §4.4） ---------- */

export interface SkillSignals {
  adoption: number | null;        // 采用率：本租户内安装工作区占比（0-1）
  completionRate: number | null;  // 完成率：绑定 Agent 线程 completed 占比（30d）
  approvalRate: number | null;    // 审批通过率：绑定 Agent 产出物手势（30d）
  praiseRate: number | null;      // 好评率：赞/(赞+踩)（无赞踩数据=null）
  reworkRate: number | null;      // 返工率：edit 手势占比（30d，反向信号）
  errorRate: number | null;       // 稳定性：绑定 Agent 失败/熔断事件占比（30d，反向信号）
  samples: number;                // 样本量（手势+调用总数；<20=sparse）
  sparse: boolean;
}

/** 六信号权重（方案 §4.4）；反向信号按 (1-x) 计入 */
export const SIGNAL_WEIGHTS = {
  adoption: 0.25, completionRate: 0.20, praiseRate: 0.15,
  approvalRate: 0.15, reworkRate: 0.15, errorRate: 0.10,
} as const;

/** 加权评分（纯函数）：null 信号剔除后权重归一；反向信号反转；样本稀疏降权 ×0.5 */
export function scoreSignals(s: SkillSignals): number {
  const entries: Array<[keyof typeof SIGNAL_WEIGHTS, number]> = [];
  if (s.adoption !== null) entries.push(["adoption", s.adoption]);
  if (s.completionRate !== null) entries.push(["completionRate", s.completionRate]);
  if (s.praiseRate !== null) entries.push(["praiseRate", s.praiseRate]);
  if (s.approvalRate !== null) entries.push(["approvalRate", s.approvalRate]);
  if (s.reworkRate !== null) entries.push(["reworkRate", 1 - s.reworkRate]);
  if (s.errorRate !== null) entries.push(["errorRate", 1 - s.errorRate]);
  if (entries.length === 0) return 0;
  const wSum = entries.reduce((acc, [k]) => acc + SIGNAL_WEIGHTS[k], 0);
  const raw = entries.reduce((acc, [k, v]) => acc + SIGNAL_WEIGHTS[k] * v, 0) / wSum;
  return Math.round(raw * (s.sparse ? 0.5 : 1) * 1000) / 1000;
}

/** 计算某技能在本租户事件库中的六信号（30 天窗口；归因=agents.skills 声明绑定） */
export async function computeSkillSignals(app: pg.Pool, scope: Scope, skillId: string): Promise<SkillSignals> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const short = skillId.replace(/^skill-[ti]?-?/, "");
    // 绑定 Agent（与 skills.usage 同口径：短名/全 id 双形态）
    const agents = await client.query<{ preset_key: string }>(
      `SELECT preset_key FROM agents WHERE workspace_id=$1 AND (skills ? $2 OR skills ? $3)`,
      [scope.workspaceId, short, skillId]);
    const keys = agents.rows.map((a) => a.preset_key);

    // 采用率：本租户内已装工作区 / 本租户工作区总数
    const adop = await client.query<{ installed: string; total: string }>(
      `SELECT (SELECT count(DISTINCT workspace_id) FROM skill_installs i JOIN workspaces w ON w.id=i.workspace_id
               WHERE i.skill_id=$1 AND w.tenant_id=$2) AS installed,
              (SELECT count(*) FROM workspaces WHERE tenant_id=$2) AS total`,
      [skillId, scope.tenantId]);
    const total = Number(adop.rows[0]?.total ?? 0);
    const adoption = total > 0 ? Number(adop.rows[0]?.installed ?? 0) / total : null;

    if (keys.length === 0) {
      await client.query("COMMIT");
      return { adoption, completionRate: null, approvalRate: null, praiseRate: null, reworkRate: null, errorRate: null, samples: 0, sparse: true };
    }

    // 完成率：绑定 Agent 的线程状态（30d）
    const threads = await client.query<{ status: string; c: string }>(
      `SELECT status, count(*) AS c FROM threads
       WHERE workspace_id=$1 AND agent_id = ANY(SELECT id FROM agents WHERE workspace_id=$1 AND preset_key = ANY($2))
         AND created_at > now() - interval '30 days' GROUP BY status`,
      [scope.workspaceId, keys]);
    const tDone = Number(threads.rows.find((r) => r.status === "completed")?.c ?? 0);
    const tAll = threads.rows.reduce((s, r) => s + Number(r.c), 0);
    const completionRate = tAll > 0 ? tDone / tAll : null;

    // 审批手势（30d）：通过/驳回/修改 + 赞踩
    const gestures = await client.query<{ status: string; c: string }>(
      `SELECT a.status, count(*) AS c FROM approvals a
       JOIN biz_events e ON e.event_id = a.event_id
       WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = ANY($2)
         AND a.created_at > now() - interval '30 days' GROUP BY a.status`,
      [scope.workspaceId, keys]);
    const gApproved = Number(gestures.rows.find((r) => r.status === "approved")?.c ?? 0);
    const gEdited = Number(gestures.rows.find((r) => r.status === "edited")?.c ?? 0);
    const gRejected = Number(gestures.rows.find((r) => r.status === "rejected")?.c ?? 0);
    const gAll = gApproved + gEdited + gRejected;
    const approvalRate = gAll > 0 ? gApproved / gAll : null;
    const reworkRate = gAll > 0 ? gEdited / gAll : null;

    // 赞踩（best-effort：无此数据=null）
    const thumbs = await client.query<{ up: string; down: string }>(
      `SELECT count(*) FILTER (WHERE a.gesture->>'thumb'='up') AS up,
              count(*) FILTER (WHERE a.gesture->>'thumb'='down') AS down
       FROM approvals a JOIN biz_events e ON e.event_id=a.event_id
       WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = ANY($2)
         AND a.created_at > now() - interval '30 days'`,
      [scope.workspaceId, keys]);
    const up = Number(thumbs.rows[0]?.up ?? 0), down = Number(thumbs.rows[0]?.down ?? 0);
    const praiseRate = up + down > 0 ? up / (up + down) : null;

    // 稳定性：绑定 Agent 的失败/熔断事件占比（30d）
    const stability = await client.query<{ total: string; bad: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE payload->'decision'->'after'->>'error' IS NOT NULL
                               OR payload->'rule_impact'::text LIKE '%"blocked"%') AS bad
       FROM biz_events
       WHERE workspace_id=$1 AND payload->'who'->>'id' = ANY($2)
         AND created_at > now() - interval '30 days'`,
      [scope.workspaceId, keys]);
    const evTotal = Number(stability.rows[0]?.total ?? 0);
    const errorRate = evTotal > 0 ? Number(stability.rows[0]?.bad ?? 0) / evTotal : null;

    await client.query("COMMIT");
    const samples = gAll + evTotal + tAll;
    return { adoption, completionRate, approvalRate, praiseRate, reworkRate, errorRate, samples, sparse: samples < 20 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/* ---------- 回流包构造（预览即所发：preview 与 send 共用） ---------- */

export interface RefluxPayload {
  skillId: string;
  name: string;
  version: string;
  description: string;   // 已脱敏
  body: string;          // 已脱敏
  meta: Record<string, unknown>;
  signals: SkillSignals & { score: number };
  from: { tenantId: string; workspaceId: string };
}

export async function buildRefluxPayload(app: pg.Pool, scope: Scope, skillId: string): Promise<{ payload: RefluxPayload; maskHits: number }> {
  const r = await app.query<{
    id: string; name: string; version: string; description: string; body: string; dist_meta: Record<string, unknown>;
  }>(`SELECT id, name, version, description, body, dist_meta FROM skills WHERE id=$1`, [skillId]);
  const skill = r.rows[0];
  if (!skill) throw new RefluxError("NOT_FOUND", `技能 ${skillId} 不存在`);
  const body = maskText(skill.body);
  const desc = maskText(skill.description);
  // 敏感凭据词命中 = 拒发（脱敏管道不是橡皮擦——凭据类内容根本不该出站）
  const termHits = scanSkillForPublish(body.text, desc.text).filter((h) => h.kind === "sensitive_term");
  if (termHits.length > 0) {
    throw new RefluxError("MASK_BLOCKED", `脱敏管道拦截：${termHits.map((h) => h.detail).join("；")}（D19 红线③，拒发）`);
  }
  const signals = await computeSkillSignals(app, scope, skillId);
  return {
    payload: {
      skillId: skill.id,
      name: skill.name,
      version: skill.version,
      description: desc.text,
      body: body.text,
      meta: skill.dist_meta ?? {},
      signals: { ...signals, score: scoreSignals(signals) },
      from: { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    },
    maskHits: body.hits + desc.hits,
  };
}

/** 预览（预览即所发：返回的 payload 就是 send 时上送的内容，前端可编辑后放弃发送） */
export async function previewReflux(app: pg.Pool, scope: Scope, skillId: string) {
  return buildRefluxPayload(app, scope, skillId);
}

/* ---------- opt-in 开关 ---------- */

export async function setRefluxOptIn(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { optIn: boolean; by: string },
): Promise<{ optIn: boolean }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `INSERT INTO skill_dist_policy (workspace_id, reflux_opt_in, updated_by, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (workspace_id) DO UPDATE SET reflux_opt_in=$2, updated_by=$3, updated_at=now()`,
      [scope.workspaceId, input.optIn, input.by]);
    await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: input.by, type: "human" },
    }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "skill_dist_policy", id: scope.workspaceId },
      decision: {
        action: "skill.reflux.policy",
        after: { refluxOptIn: input.optIn },
        basis: ["D19 红线①：回流 opt-in 默认关闭，发送前预览可编辑、PII 脱敏、发送行为留痕"],
      } as never,
      rule_impact: [],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
  return { optIn: input.optIn };
}

export async function getRefluxOptIn(app: pg.Pool, scope: Scope): Promise<boolean> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ reflux_opt_in: boolean }>(
      `SELECT reflux_opt_in FROM skill_dist_policy WHERE workspace_id=$1`, [scope.workspaceId]);
    await client.query("COMMIT");
    return r.rows[0]?.reflux_opt_in ?? false;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/* ---------- 发送 ---------- */

/** 上送签名（HMAC-SHA256，官方侧同 key 验签——与下行分发同一把钥匙，P1 简化；正式运营可拆双钥） */
export function signReflux(key: string, payload: RefluxPayload): string {
  return createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
}

export async function sendReflux(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; by: string; endpoint?: string; signingKey?: string; poster?: (url: string, body: unknown, signature: string) => Promise<void> },
): Promise<{ outboxId: string; status: "sent" | "queued"; maskHits: number }> {
  // 红线①：opt-in 未开启拒发
  if (!(await getRefluxOptIn(app, scope))) {
    throw new RefluxError("OPT_IN_REQUIRED", "技能回流未开启（opt-in）。请在技能中心开启后再发送（D19 红线①：默认不发送）");
  }
  // 红线②③：重建 payload（与预览同函数）+ 脱敏管道
  const { payload, maskHits } = await buildRefluxPayload(app, scope, input.skillId);
  const outboxId = `rfo-${input.skillId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const endpoint = input.endpoint ?? process.env.SKILL_REFLUX_ENDPOINT ?? "";
  const signingKey = input.signingKey ?? process.env.SKILL_DIST_SIGNING_KEY ?? "";
  let status: "sent" | "queued" = "queued";
  let sendError: string | null = null;

  if (endpoint && signingKey) {
    try {
      const poster = input.poster ?? (async (url: string, body: unknown, signature: string) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-reflux-signature": signature },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new RefluxError("SEND_FAILED", `回流端点 HTTP ${res.status}`);
      });
      await poster(endpoint, payload, signReflux(signingKey, payload));
      status = "sent";
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }
  }

  // outbox 落库 + 发送事件（D16 同事务）
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `INSERT INTO skill_reflux_outbox (id, workspace_id, skill_id, payload, status, error, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5='sent' THEN now() ELSE NULL END)`,
      [outboxId, scope.workspaceId, input.skillId, JSON.stringify(payload), sendError ? "failed" : status, sendError]);
    await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: input.by, type: "human" },
    }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "skill", id: input.skillId },
      decision: {
        action: "skill.reflux.sent",
        after: {
          skillId: input.skillId, outboxId, status: sendError ? "failed" : status,
          maskHits, signalsScore: payload.signals.score, samples: payload.signals.samples,
          endpoint: endpoint ? new URL(endpoint).host : null,
        },
        basis: [
          "D19 四条红线全过：opt-in 已开启 / 预览即所发 / PII 脱敏管道 / 发送留痕",
          sendError ? `上送失败（${sendError}），草案留 outbox 待重试` : (status === "sent" ? "已上送官方运营台" : "未配置回流端点，草案留 outbox"),
        ],
      } as never,
      rule_impact: [],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
  return { outboxId, status: sendError ? "queued" : status, maskHits };
}
