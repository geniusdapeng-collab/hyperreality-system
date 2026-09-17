/**
 * skills · 意识系统（F8.4，E8.3）——组织的「观察员」
 *  - 消费会话事件流做高频相似任务检测：聚类（对象类型 × 动作类别）+ 频次阈值（默认同类 ≥3 次/周，
 *    AWARENESS_WEEKLY_THRESHOLD），产出「建议固化为技能 / 定时任务」卡片
 *  - 人类一键确认 → 生成触发器（复用 B9 upsertTrigger，F4.7）或新技能草稿（forge.ts）
 *  - E8.3 校准闭环：建议卡片可驳回；驳回手势抬高该类建议阈值（×2，近 30 天窗口），降低误报权重
 *  - 幂等：同类 key 已有未处理建议 / 已确认过 → 不重复产出
 */
import type pg from "pg";
import { AWARENESS_WEEKLY_THRESHOLD, type BusinessEvent } from "@workloom/shared";
import { gatewayAppend } from "../workdata/gateway.js";
import { upsertTrigger } from "../night-shift/triggers.js";
import { createSkillDraft, type SkillTriplet } from "./forge.js";

interface Scope { tenantId: string; workspaceId: string }

export interface Suggestion {
  /** 聚类键：objectType::actionCategory */
  key: string;
  objectType: string;
  actionCategory: string;
  count: number;
  windowDays: number;
  /** 生效阈值（含驳回校准加成） */
  threshold: number;
  sampleEventIds: string[];
}

/** 任务类动作类别（聚类维度；系统/巡检/审批自身动作不入观察） */
const SYSTEM_ACTION_PREFIXES = ["inspect.", "skill.", "trigger.", "night.", "approval.", "thread.", "awareness.", "fence.", "memory.", "model."];

/** 动作类别 = action 前两段（如 price.adjust / review.reply）；系统动作返回 null（纯函数） */
export function actionCategory(action: string): string | null {
  if (SYSTEM_ACTION_PREFIXES.some((p) => action.startsWith(p))) return null;
  const parts = action.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null;
}

/** 聚类（纯函数）：事件 → key → {count, ids} */
export function clusterEvents(events: BusinessEvent[]): Map<string, { count: number; ids: string[] }> {
  const out = new Map<string, { count: number; ids: string[] }>();
  for (const ev of events) {
    const cat = actionCategory(ev.decision.action);
    if (!cat) continue;
    const key = `${ev.object.type}::${cat}`;
    const cur = out.get(key) ?? { count: 0, ids: [] };
    cur.count += 1;
    if (cur.ids.length < 5) cur.ids.push(ev.event_id); // 样本上限 5 条
    out.set(key, cur);
  }
  return out;
}

/** 驳回校准（E8.3，纯函数）：近 30 天被驳回的 key 阈值 ×2 */
export function calibratedThreshold(base: number, rejectedKeys: Set<string>, key: string): number {
  return rejectedKeys.has(key) ? base * 2 : base;
}

async function emit(
  gateway: pg.Pool,
  scope: Scope,
  by: string,
  decision: Record<string, unknown>,
  links?: string[],
): Promise<string> {
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: by === "awareness" ? "system" : "human" },
  }, {
    who: { type: by === "awareness" ? "system" : "human", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "staff", id: (decision.after as { key?: string } | undefined)?.key },
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

/** 近 N 天事件流（观察窗口） */
async function loadRecentEvents(app: pg.Pool, scope: Scope, days: number): Promise<BusinessEvent[]> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const r = await client.query<{ payload: BusinessEvent }>(
      `SELECT payload FROM biz_events WHERE workspace_id=$1 AND created_at >= $2 ORDER BY seq`,
      [scope.workspaceId, since.toISOString()],
    );
    return r.rows.map((x) => x.payload);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** 近 30 天驳回/已确认的 key（校准与幂等的数据源，纯日志投影） */
async function loadFeedbackKeys(app: pg.Pool, scope: Scope): Promise<{ rejected: Set<string>; confirmed: Set<string> }> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const r = await client.query<{ payload: { decision: { action: string; after?: { key?: string } } } }>(
      `SELECT payload FROM biz_events
       WHERE workspace_id=$1 AND created_at >= $2
         AND payload->'decision'->>'action' IN ('awareness.rejected','awareness.confirmed')`,
      [scope.workspaceId, since.toISOString()],
    );
    const rejected = new Set<string>();
    const confirmed = new Set<string>();
    for (const row of r.rows) {
      const key = row.payload.decision.after?.key;
      if (!key) continue;
      if (row.payload.decision.action === "awareness.rejected") rejected.add(key);
      else confirmed.add(key);
    }
    return { rejected, confirmed };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/**
 * 高频相似任务检测（F8.4）：≥3 次/周 → 建议卡片
 * 已确认过的 key 不再重复建议（幂等）；被驳回过的 key 阈值 ×2（E8.3 校准闭环）
 */
export async function detectSuggestions(
  app: pg.Pool,
  scope: Scope,
  opts: { windowDays?: number; threshold?: number } = {},
): Promise<Suggestion[]> {
  const windowDays = opts.windowDays ?? 7;
  const base = opts.threshold ?? AWARENESS_WEEKLY_THRESHOLD;
  const [events, feedback] = await Promise.all([
    loadRecentEvents(app, scope, windowDays),
    loadFeedbackKeys(app, scope),
  ]);
  const clusters = clusterEvents(events);
  const out: Suggestion[] = [];
  for (const [key, v] of clusters) {
    if (feedback.confirmed.has(key)) continue; // 已固化，不重复建议
    const threshold = calibratedThreshold(base, feedback.rejected, key);
    if (v.count < threshold) continue;
    const [objectType, actionCategory_] = key.split("::");
    out.push({
      key, objectType: objectType!, actionCategory: actionCategory_!,
      count: v.count, windowDays, threshold, sampleEventIds: v.ids,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * 一键确认（F8.4）：target='trigger' → 生成定时触发器（F4.7 复用）；target='skill' → 生成技能草稿
 * 确认即写 awareness.confirmed（此后同类不再建议）
 */
export async function confirmSuggestion(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: { suggestion: Suggestion; target: "trigger" | "skill"; by: string; schedule?: string },
): Promise<{ artifactId: string; eventId: string }> {
  let artifactId: string;
  if (input.target === "trigger") {
    artifactId = `trg-auto-${input.suggestion.key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    await upsertTrigger(app, gateway, scope, {
      id: artifactId,
      name: `自动固化：${input.suggestion.actionCategory}（${input.suggestion.count} 次/${input.suggestion.windowDays} 天）`,
      kind: "cron",
      schedule: input.schedule ?? "0 7 * * *",
      action: { dispatch: input.suggestion.actionCategory, objectType: input.suggestion.objectType },
      createdBy: input.by,
    });
  } else {
    const triplet: SkillTriplet = {
      trigger: `出现「${input.suggestion.objectType}」类对象的 ${input.suggestion.actionCategory} 任务时`,
      steps: [`按高频样本（${input.suggestion.sampleEventIds.join("、")}）归纳的打法执行 ${input.suggestion.actionCategory}`],
      boundary: "不越出围栏绑定声明；写动作照常过围栏瀑布",
    };
    const draft = await createSkillDraft(app, gateway, scope, {
      name: `auto-${input.suggestion.actionCategory}`,
      description: `意识系统固化：${input.suggestion.key}（${input.suggestion.count} 次/${input.suggestion.windowDays} 天）`,
      triplet,
      by: input.by,
    });
    artifactId = draft.skillId;
  }
  const eventId = await emit(gateway, scope, input.by, {
    action: "awareness.confirmed",
    after: { key: input.suggestion.key, target: input.target, artifactId, count: input.suggestion.count },
    basis: ["人类一键确认 → 生成触发器或新技能（F8.4）"],
  }, input.suggestion.sampleEventIds);
  return { artifactId, eventId };
}

/** 驳回建议（E8.3）：写 awareness.rejected；同类建议阈值 ×2（校准闭环） */
export async function rejectSuggestion(
  gateway: pg.Pool,
  scope: Scope,
  input: { key: string; by: string; reason?: string },
): Promise<string> {
  return emit(gateway, scope, input.by, {
    action: "awareness.rejected",
    after: { key: input.key, reason: input.reason ?? "", calibration: "该类建议阈值 ×2（E8.3）" },
    basis: ["意识系统误报可驳回；驳回手势降低该类建议权重（E8.3）"],
  });
}

export { AWARENESS_WEEKLY_THRESHOLD };
