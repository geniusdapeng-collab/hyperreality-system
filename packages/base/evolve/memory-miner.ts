/**
 * evolve · 记忆提炼器（自我进化飞轮 M2，D24；做实 memory.calibrate 机制位 G3）
 *
 * 夜班窗口运行的提炼节拍（与 captain 回测节拍同构：advisory 锁防双写）：
 *  ① 驳回强化：近 30 天 approval.gesture 驳回按 reason_enum 聚类，≥MINER_PATTERN_THRESHOLD 次
 *     → 强化 mem-reject-<enum> 偏好记忆（content 附统计口径，confidence 随次数递增封顶 0.9）；
 *  ② 改稿模式：edit 手势按被审动作聚类，≥MINER_PATTERN_THRESHOLD 次
 *     → 产出 mem-pat-edit-<action> pattern 记忆（纠错/口味按 editKind 分列，M1.3 归因分流）；
 *  ③ 每次提炼写 memory.calibrate 五元事件（who=system evolve-miner，links 溯源样本事件）——
 *     机制位自 B6 起在 workdata/memory.ts 注释中预留，本节拍是第一个真实发出方。
 *
 * 统计闸（D24 修订 7）：窗口内手势样本 <EVOLUTION_MIN_SIGNAL_SAMPLES 时只观察不提炼，
 * 防止小样本噪声驱动进化（酒店 30 天数字孪生仅 10 条审批的实证教训）。
 */
import type pg from "pg";
import {
  EVOLUTION_MIN_SIGNAL_SAMPLES,
  MEMORY_SOURCE_EVENTS_CAP,
  MINER_PATTERN_THRESHOLD,
} from "@workloom/shared";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { MockEmbedder, upsertMemoryInTx, type Embedder } from "../workdata/memory.js";

interface Scope {
  tenantId: string;
  workspaceId: string;
}

export interface MinerResult {
  /** 窗口内手势样本量（统计闸依据） */
  samples: number;
  /** 强化的驳回偏好记忆数 */
  reinforced: number;
  /** 产出的改稿模式记忆数 */
  editPatterns: number;
  /** 发出的 memory.calibrate 事件 */
  calibrateEventIds: string[];
  /** 统计闸拦截说明（样本不足时） */
  skipped?: string;
}

const MINER_LOCK_KEY = 761214; // advisory 锁键（防双写，与回测节拍同构）

/** 事务内发 memory.calibrate 事件（who=system；links 溯源样本手势事件） */
async function emitCalibrateInTx(
  client: pg.PoolClient,
  scope: Scope,
  args: { memoryId: string; kind: string; summary: string; sampleEventIds: string[] },
): Promise<string> {
  const res = await gatewayAppendOnClient(client, {
    ...scope,
    actor: { id: "evolve-miner", type: "system" },
  }, {
    who: { type: "system", id: "evolve-miner" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "memory", id: args.memoryId },
    decision: {
      action: "memory.calibrate",
      after: {
        memory_id: args.memoryId,
        kind: args.kind,
        summary: args.summary,
        sample_count: args.sampleEventIds.length,
      },
      basis: ["记忆提炼器：反馈信号聚类达到阈值，沉淀/强化组织记忆（D24 自我进化飞轮 M2）"],
    },
    rule_impact: [],
    links: args.sampleEventIds,
  });
  return res.eventId;
}

/**
 * 记忆提炼节拍（夜班调度/手动触发共用；可重入——advisory 锁未获得即跳过本轮）。
 * @param app 业务池（RLS 读） @param gateway 网关池（事件写；本实现全部走 app 池单事务，参数保留与节拍签名一致）
 */
export async function runMemoryMinerBeat(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  opts: { embedder?: Embedder; windowDays?: number } = {},
): Promise<MinerResult> {
  void gateway; // 事件经 gatewayAppendOnClient 落在 app 池单事务内（D16），网关池由调度方持有备扩展
  const embedder = opts.embedder ?? new MockEmbedder();
  const windowDays = opts.windowDays ?? 30;

  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);

    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [MINER_LOCK_KEY]);
    if (!lock.rows[0]?.ok) {
      await client.query("COMMIT");
      return { samples: 0, reinforced: 0, editPatterns: 0, calibrateEventIds: [], skipped: "提炼节拍已在进行中（advisory 锁未获得，M1 防双写）" };
    }

    // 窗口内全部手势事件（approval.gesture；统计闸样本量 = 手势总数）
    const gestures = await client.query<{
      event_id: string; gesture: string; reason_enum: string | null;
      edit_kind: string | null; reviewed_action: string | null;
    }>(
      `SELECT e.event_id,
              e.payload->'decision'->'after'->>'gesture' AS gesture,
              e.payload->'decision'->'after'->>'reason_enum' AS reason_enum,
              e.payload->'decision'->'after'->>'edit_kind' AS edit_kind,
              rv.payload->'decision'->>'action' AS reviewed_action
       FROM biz_events e
       LEFT JOIN biz_events rv ON rv.tenant_id = e.tenant_id AND rv.event_id = e.payload->'links'->>0
       WHERE e.tenant_id=$1 AND e.workspace_id=$2
         AND e.payload->'decision'->>'action' = 'approval.gesture'
         AND e.created_at > now() - ($3 || ' days')::interval`,
      [scope.tenantId, scope.workspaceId, String(windowDays)],
    );

    const samples = gestures.rows.length;
    if (samples < EVOLUTION_MIN_SIGNAL_SAMPLES) {
      await client.query("COMMIT");
      return {
        samples, reinforced: 0, editPatterns: 0, calibrateEventIds: [],
        skipped: `统计闸：窗口内手势样本 ${samples} 条 < ${EVOLUTION_MIN_SIGNAL_SAMPLES} 条，只观察不提炼（D24 修订 7）`,
      };
    }

    const calibrateEventIds: string[] = [];
    let reinforced = 0;
    let editPatterns = 0;

    /* ① 驳回强化：reason_enum 聚类 ≥阈值 → 强化 mem-reject-<enum> */
    const rejects = new Map<string, string[]>();
    for (const g of gestures.rows) {
      if (g.gesture !== "reject" || !g.reason_enum) continue;
      const arr = rejects.get(g.reason_enum) ?? [];
      arr.push(g.event_id);
      rejects.set(g.reason_enum, arr);
    }
    for (const [reasonEnum, eventIds] of rejects) {
      if (eventIds.length < MINER_PATTERN_THRESHOLD) continue;
      const memoryId = `mem-reject-${reasonEnum}`;
      const confidence = Math.min(0.5 + 0.1 * eventIds.length, 0.9);
      await upsertMemoryInTx(client, scope, {
        memoryId,
        scope: "workspace",
        kind: "preference",
        content: `驳回偏好模式「${reasonEnum}」：近 ${windowDays} 天共 ${eventIds.length} 次以该原因驳回 Agent 提案——后续提案生成必须先自查是否触碰此模式（提炼器强化，样本 ${eventIds.length} 条）`,
        sourceEvents: eventIds.slice(-MEMORY_SOURCE_EVENTS_CAP),
        confidence,
      }, embedder);
      const evId = await emitCalibrateInTx(client, scope, {
        memoryId, kind: "reject-reinforce",
        summary: `驳回原因「${reasonEnum}」${eventIds.length} 次/窗，偏好记忆强化至 confidence=${confidence.toFixed(2)}`,
        sampleEventIds: eventIds.slice(-MEMORY_SOURCE_EVENTS_CAP),
      });
      calibrateEventIds.push(evId);
      reinforced++;
    }

    /* ② 改稿模式：edit 手势按被审动作聚类 ≥阈值 → mem-pat-edit-<action> */
    const edits = new Map<string, { eventIds: string[]; correction: number; preference: number }>();
    for (const g of gestures.rows) {
      if (g.gesture !== "edit" || !g.reviewed_action) continue;
      const cur = edits.get(g.reviewed_action) ?? { eventIds: [], correction: 0, preference: 0 };
      cur.eventIds.push(g.event_id);
      if (g.edit_kind === "correction") cur.correction++;
      if (g.edit_kind === "preference") cur.preference++;
      edits.set(g.reviewed_action, cur);
    }
    for (const [action, agg] of edits) {
      if (agg.eventIds.length < MINER_PATTERN_THRESHOLD) continue;
      const memoryId = `mem-pat-edit-${action}`;
      const confidence = Math.min(0.4 + 0.08 * agg.eventIds.length, 0.85);
      await upsertMemoryInTx(client, scope, {
        memoryId,
        scope: "workspace",
        kind: "pattern",
        content: `人类改稿模式「${action}」：近 ${windowDays} 天 ${agg.eventIds.length} 次编辑后采纳（纠错 ${agg.correction} 次 / 口味 ${agg.preference} 次）——生成该类提案时应先对照历史修改点自检，减少重复改稿`,
        sourceEvents: agg.eventIds.slice(-MEMORY_SOURCE_EVENTS_CAP),
        confidence,
      }, embedder);
      const evId = await emitCalibrateInTx(client, scope, {
        memoryId, kind: "edit-pattern",
        summary: `「${action}」改稿 ${agg.eventIds.length} 次/窗（纠错 ${agg.correction}/口味 ${agg.preference}），pattern 记忆沉淀`,
        sampleEventIds: agg.eventIds.slice(-MEMORY_SOURCE_EVENTS_CAP),
      });
      calibrateEventIds.push(evId);
      editPatterns++;
    }

    await client.query("COMMIT");
    return { samples, reinforced, editPatterns, calibrateEventIds };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
