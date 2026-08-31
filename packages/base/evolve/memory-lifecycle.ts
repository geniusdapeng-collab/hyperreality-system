/**
 * evolve · 记忆生命周期与人工治理（自我进化飞轮 M2，D24）
 *
 * 四条路径，全部写 memory.calibrate 事件留痕（append-only，回收区口径 F1.11，禁物理删除）：
 *  ① decayMemories——衰减扫描：MEMORY_DECAY_DAYS 天未被引用且未被强化的 active 记忆
 *     confidence ×MEMORY_DECAY_FACTOR（地板 MEMORY_MIN_CONFIDENCE，不自动回收）；
 *  ② recallMemoriesByMember——来源人一键清算：成员离任/换岗时，作废其手势沉淀的全部
 *     偏好记忆（D24 修订 2：偏好绑定来源人，防个人口味过拟合为组织真理）；
 *  ③ editMemoryContent——人类编辑记忆内容（M2.1 可读可改；禁明文 PII，F1.8）；
 *  ④ disableMemory——人类禁用（→ recalled，可由再次写入复活，upsertMemory 语义）。
 */
import type pg from "pg";
import {
  MEMORY_DECAY_DAYS,
  MEMORY_DECAY_FACTOR,
  MEMORY_MIN_CONFIDENCE,
} from "@workloom/shared";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { assertMemoryContentSafe, MockEmbedder, upsertMemoryInTx, type Embedder } from "../workdata/memory.js";

interface Scope {
  tenantId: string;
  workspaceId: string;
}

export class MemoryGovernanceError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "PII_UNSAFE" | "EMPTY_CONTENT",
    message: string,
  ) {
    super(message);
    this.name = "MemoryGovernanceError";
  }
}

async function emitCalibrate(
  client: pg.PoolClient,
  scope: Scope,
  actor: { id: string; type: "human" | "system" },
  args: { memoryId: string; kind: string; summary: string; links?: string[] },
): Promise<string> {
  const res = await gatewayAppendOnClient(client, {
    ...scope,
    actor: { id: actor.id, type: actor.type },
  }, {
    who: { type: actor.type, id: actor.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "memory", id: args.memoryId },
    decision: {
      action: "memory.calibrate",
      after: { memory_id: args.memoryId, kind: args.kind, summary: args.summary },
      basis: ["记忆生命周期治理（D24 自我进化飞轮 M2；append-only，可反查可回放）"],
    },
    rule_impact: [],
    ...(args.links?.length ? { links: args.links } : {}),
  });
  return res.eventId;
}

/** 事务封装（事务级 RLS 双 GUC，与全库一致） */
async function inTx<T>(app: pg.Pool, scope: Scope, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= ① 衰减扫描（夜班节拍） ================= */

export interface DecayResult {
  scanned: number;
  decayed: number;
  calibrateEventId?: string;
}

export async function decayMemories(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  opts: { now?: Date } = {},
): Promise<DecayResult> {
  void gateway;
  void opts;
  return inTx(app, scope, async (c) => {
    // 候选：active 且最近 MEMORY_DECAY_DAYS 天零引用（memory_usage 左连接为空）
    // 且自身创建也早于窗口（新记忆有观察期，不落地即衰）
    const candidates = await c.query<{ memory_id: string }>(
      `SELECT m.memory_id
       FROM org_memory m
       WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND m.status='active'
         AND m.created_at < now() - ($3 || ' days')::interval
         AND m.confidence > $4
         AND NOT EXISTS (
           SELECT 1 FROM memory_usage u
           WHERE u.memory_id = m.memory_id AND u.workspace_id = m.workspace_id
             AND u.used_at > now() - ($3 || ' days')::interval
         )`,
      [scope.tenantId, scope.workspaceId, String(MEMORY_DECAY_DAYS), MEMORY_MIN_CONFIDENCE],
    );
    let decayed = 0;
    for (const row of candidates.rows) {
      const r = await c.query(
        `UPDATE org_memory
         SET confidence = GREATEST(confidence * $4, $5)
         WHERE memory_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='active'`,
        [row.memory_id, scope.tenantId, scope.workspaceId, MEMORY_DECAY_FACTOR, MEMORY_MIN_CONFIDENCE],
      );
      decayed += r.rowCount ?? 0;
    }
    let calibrateEventId: string | undefined;
    if (decayed > 0) {
      calibrateEventId = await emitCalibrate(c, scope, { id: "evolve-lifecycle", type: "system" }, {
        memoryId: "mem-lifecycle-sweep",
        kind: "decay",
        summary: `衰减扫描：${decayed} 条超 ${MEMORY_DECAY_DAYS} 天未引用记忆 confidence ×${MEMORY_DECAY_FACTOR}（地板 ${MEMORY_MIN_CONFIDENCE}，不自动回收）`,
      });
    }
    return { scanned: candidates.rows.length, decayed, calibrateEventId };
  });
}

/* ================= ② 来源人一键清算 ================= */

export interface RecallByMemberResult {
  memberId: string;
  recalled: string[];
  calibrateEventIds: string[];
}

export async function recallMemoriesByMember(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  actor: { memberNo: string },
  targetMemberId: string,
): Promise<RecallByMemberResult> {
  void gateway;
  return inTx(app, scope, async (c) => {
    // 目标记忆：active，且任一来源事件的 who.id = 目标成员（偏好归因到来源人，D24 修订 2）
    const rows = await c.query<{ memory_id: string; source_events: string[] }>(
      `SELECT m.memory_id, m.source_events
       FROM org_memory m
       WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND m.status='active'
         AND EXISTS (
           SELECT 1 FROM biz_events e
           WHERE e.tenant_id = m.tenant_id AND e.event_id = ANY(m.source_events)
             AND e.payload->'who'->>'id' = $3
         )`,
      [scope.tenantId, scope.workspaceId, targetMemberId],
    );
    const recalled: string[] = [];
    const calibrateEventIds: string[] = [];
    for (const row of rows.rows) {
      const r = await c.query(
        `UPDATE org_memory SET status='recalled'
         WHERE memory_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='active'`,
        [row.memory_id, scope.tenantId, scope.workspaceId],
      );
      if ((r.rowCount ?? 0) === 0) continue;
      recalled.push(row.memory_id);
      calibrateEventIds.push(await emitCalibrate(c, scope, { id: actor.memberNo, type: "human" }, {
        memoryId: row.memory_id,
        kind: "recall-by-member",
        summary: `来源人「${targetMemberId}」清算：该记忆含其手势沉淀，一键作废（换人不过拟合旧口味，D24 修订 2）`,
        links: row.source_events.slice(0, 5),
      }));
    }
    return { memberId: targetMemberId, recalled, calibrateEventIds };
  });
}

/* ================= ③ 人类编辑记忆内容 ================= */

export async function editMemoryContent(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  actor: { memberNo: string },
  memoryId: string,
  newContent: string,
  opts: { embedder?: Embedder } = {},
): Promise<{ calibrateEventId: string }> {
  void gateway;
  const content = newContent.trim();
  if (!content) throw new MemoryGovernanceError("EMPTY_CONTENT", "记忆内容不能为空");
  const safe = assertMemoryContentSafe(content);
  if (!safe.safe) {
    throw new MemoryGovernanceError("PII_UNSAFE", `记忆内容含 ${safe.hits} 处明文 PII，拒绝写入（F1.8）`);
  }
  const embedder = opts.embedder ?? new MockEmbedder();
  return inTx(app, scope, async (c) => {
    const cur = await c.query<{ scope: string; kind: string; source_events: string[]; confidence: number; subject_id: string | null }>(
      `SELECT scope, kind, source_events, confidence, subject_id FROM org_memory
       WHERE memory_id=$1 AND tenant_id=$2 AND workspace_id=$3`,
      [memoryId, scope.tenantId, scope.workspaceId],
    );
    const row = cur.rows[0];
    if (!row) throw new MemoryGovernanceError("NOT_FOUND", `记忆 ${memoryId} 不存在`);
    await upsertMemoryInTx(c, scope, {
      memoryId,
      scope: row.scope as "workspace" | "agent" | "run",
      kind: row.kind as "preference" | "pattern" | "sop" | "forbidden",
      content,
      sourceEvents: row.source_events,
      subjectId: row.subject_id ?? undefined,
      confidence: Number(row.confidence),
    }, embedder);
    const calibrateEventId = await emitCalibrate(c, scope, { id: actor.memberNo, type: "human" }, {
      memoryId,
      kind: "human-edit",
      summary: `人类编辑记忆内容（M2.1 可读可改；来源与置信度保持，内容以最新为准）`,
    });
    return { calibrateEventId };
  });
}

/* ================= ④ 人类禁用 ================= */

export async function disableMemory(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  actor: { memberNo: string },
  memoryId: string,
): Promise<{ calibrateEventId: string }> {
  void gateway;
  return inTx(app, scope, async (c) => {
    const r = await c.query(
      `UPDATE org_memory SET status='recalled'
       WHERE memory_id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='active'`,
      [memoryId, scope.tenantId, scope.workspaceId],
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new MemoryGovernanceError("NOT_FOUND", `记忆 ${memoryId} 不存在或已非 active（幂等约束）`);
    }
    const calibrateEventId = await emitCalibrate(c, scope, { id: actor.memberNo, type: "human" }, {
      memoryId,
      kind: "human-disable",
      summary: `人类禁用记忆（回收区口径 F1.11，禁物理删除；纠偏通道，防记忆污染越用越偏）`,
    });
    return { calibrateEventId };
  });
}
