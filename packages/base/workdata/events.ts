/**
 * workdata · 事件写入段（B1）
 * 纪律（铁律 1/2）：
 *  - 一切写入必经 gateway.appendEvent（本模块唯一入口；DB 层另有「仅 workloom_gateway 可 INSERT」双保险，F1.2）
 *  - append-only：回滚=逆向补偿事件，原事件永不修改（L1.1/F1.6，由触发器兜底）
 *  - 幂等：UNIQUE(tenant_id,event_id) 冲突丢弃不报错（L1.4）
 *  - 哈希链：prev_hash/hash = sha256(prev_hash || canonical(payload))（技术新增量 A1）
 *
 * 事件编号（P0-3）：全局序列 biz_events_eid_seq 分配（E-<seq> 全局唯一），
 * 不再 MAX(seq)+1（多写入者/回放通道下可碰撞被抢占）；append_event_insert 冲突时
 * 比对 payload hash——不一致即抢占攻击（报错），一致才幂等丢弃。
 * 调用方自选 event_id（回放/补偿通道）必须在独立前缀空间（E-SEED-/E-RPL-），
 * 与序列分配的 E-<digits> 命名空间硬隔离，否则拒绝。
 * 链粒度（P1-5）：advisory 锁与链尾读取统一 tenant+workspace 粒度（与 DB 函数同口径）。
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import {
  formatEventId,
  safeParseBusinessEvent,
  type BusinessEvent,
  type Decision,
  type EventContext,
  type EventObject,
  type ModelTrace,
  type Receipt,
  type RuleImpact,
  type Who,
} from "@workloom/shared";
import { maskDeep } from "./pii.js";

/**
 * 事件草稿：不带 event_id/hash/ts（由写入段分配/计算）。
 * 显式罗列字段而非 Omit——BusinessEvent 源自 z.looseObject，索引签名会让 Omit 丢失字段类型。
 * 行业扩展字段经 context/object/decision 的 loose 位透传（附录 E 冻结纪律）。
 */
export interface EventDraft {
  who: Who;
  context: EventContext;
  object: EventObject;
  decision: Decision;
  rule_impact: RuleImpact[];
  receipt?: Receipt;
  model_trace?: ModelTrace;
  links?: string[];
}

export const GENESIS_HASH = "GENESIS";

/** 回放/补偿通道的调用方自选 event_id 必须落在独立前缀空间（P0-3 命名空间隔离） */
export const REPLAY_EVENT_ID_PREFIXES = ["E-SEED-", "E-RPL-"] as const;

export function isReplayEventId(eventId: string): boolean {
  return REPLAY_EVENT_ID_PREFIXES.some((p) => eventId.startsWith(p));
}

/**
 * 回放事件的 zod 校验缝：shared 附录 E schema 冻结（event_id 必须 ^E-\d+$），
 * 而回放通道 ID 在独立前缀空间（E-SEED-/E-RPL-）——用占位 ID 过结构校验后还原真 ID。
 * 仅换 event_id 一个字段，其余五元结构校验强度不打折。
 */
export function safeParseReplayAwareEvent(event: BusinessEvent): ReturnType<typeof safeParseBusinessEvent> {
  if (!isReplayEventId(event.event_id)) return safeParseBusinessEvent(event);
  const probe = safeParseBusinessEvent({ ...event, event_id: "E-0" });
  if (!probe.success) return probe;
  return { success: true, data: { ...probe.data, event_id: event.event_id } };
}

/** workspace 粒度链锁 key（P1-5：与 DB 函数 append_event_insert 同口径，可重入） */
function chainLockKey(scope: { tenantId: string; workspaceId: string }): string {
  return `event-chain:${scope.tenantId}:${scope.workspaceId}`;
}

/** 规范化序列化（键序稳定，保证哈希链可复算） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function eventHash(prevHash: string, payload: unknown): string {
  return createHash("sha256").update(prevHash + canonicalJson(payload), "utf-8").digest("hex");
}

export interface AppendInput {
  /** 不带 event_id/hash 的五元事件（由写入段分配） */
  event: EventDraft;
  sessionId?: string | null;
}

export interface AppendResult {
  eventId: string;
  seq: bigint;
  hash: string;
  /** true = 同 (tenant_id,event_id) 已存在，本次为幂等丢弃（L1.4） */
  deduped: boolean;
  /** 脱敏命中次数（第二段瀑布留痕） */
  piiHits: number;
}

/**
 * 事务内追加一条五元事件（D16 核心原语）
 * 调用方必须已持有事务（BEGIN + set_config 双 GUC）——本函数不再自行开关事务，
 * 使「业务状态写 + 事件写」可在同一 COMMIT 原子提交（#1/A）。
 * 事件插入经 append_event_insert（SECURITY DEFINER）完成：app/gateway 角色均可调用，
 * DB 层自校验上下文一致性与链式接龙（断链拒写）。
 */
export async function appendEventInTx(
  client: pg.PoolClient,
  scope: { tenantId: string; workspaceId: string },
  input: AppendInput,
): Promise<AppendResult> {
  {
    // workspace 级写串行化（P1-5：链尾读取与插入必须原子；DB 函数体内同 key 可重入）
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [chainLockKey(scope)]);

    const tail = await client.query<{ seq: string; hash: string }>(
      `SELECT seq, hash FROM biz_events WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY seq DESC LIMIT 1`,
      [scope.tenantId, scope.workspaceId],
    );
    const prevHash = tail.rows[0]?.hash ?? GENESIS_HASH;
    // P0-3：事件号走全局序列（E-<seq> 全局唯一），不再 MAX(seq)+1
    const eid = await client.query<{ v: string }>(`SELECT nextval('biz_events_eid_seq') AS v`);
    const eventId = formatEventId(BigInt(eid.rows[0]!.v));

    // 第二段瀑布产物：payload 已脱敏（gateway 调用 maskDeep 后传入；此处双保险再脱一遍也无副作用——占位符不含 PII 模式）
    const event: BusinessEvent = {
      ...input.event,
      event_id: eventId,
      context: { ...input.event.context, tenant_id: scope.tenantId, workspace_id: scope.workspaceId },
    };
    const checked = safeParseBusinessEvent(event);
    if (!checked.success) {
      throw new Error(`事件未过附录 E 校验：${checked.error.issues[0]?.message ?? "unknown"}`);
    }
    const payload = checked.data;
    const hash = eventHash(prevHash, payload);

    const res = await client.query<{ seq: string | null; inserted: boolean }>(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        eventId,
        scope.tenantId,
        scope.workspaceId,
        input.sessionId ?? null,
        JSON.stringify(payload),
        prevHash,
        hash,
        payload.context.time,
      ],
    );
    if (res.rows[0]?.inserted) {
      return { eventId, seq: BigInt(res.rows[0]!.seq!), hash, deduped: false, piiHits: 0 };
    }
    // 幂等丢弃（同 event_id 同 payload 不报错——L1.4；payload 不一致由 DB 函数按抢占攻击抛错，P0-3）
    // #26 修复：去重时从 DB 取回已存在事件的真实 hash/seq 返回（同 #4 对
    // appendEventIdempotent 的修法），避免调用方拿到按本 payload 新算的 hash 续链断裂
    const existing = await client.query<{ seq: string; hash: string }>(
      `SELECT seq, hash FROM biz_events WHERE tenant_id = $1 AND event_id = $2`,
      [scope.tenantId, eventId],
    );
    return {
      eventId,
      seq: BigInt(existing.rows[0]?.seq ?? 0),
      hash: existing.rows[0]?.hash ?? hash,
      deduped: true,
      piiHits: 0,
    };
  }
}

/**
 * 追加一条五元事件（自带事务的便捷包装：connect → BEGIN → set_config → InTx → COMMIT）
 * 纯事件写（无配套业务状态写）场景使用；有业务写配套时请用 appendEventInTx 并入同一事务。
 */
export async function appendEvent(
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  input: AppendInput,
): Promise<AppendResult> {
  const client = await gateway.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await appendEventInTx(client, scope, input);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 显式幂等写入：调用方自带 event_id（回放/补偿场景，E3.3）
 * 与 appendEvent 的区别：不分配编号，直接以调用方 event_id 写入；
 * 冲突时 DB 函数比对 payload hash——一致丢弃（deduped），不一致按抢占攻击报错（P0-3）。
 * P0-3 命名空间纪律：自选 event_id 必须 E-SEED-/E-RPL- 前缀（与序列分配的 E-<digits> 隔离）。
 */
export async function appendEventIdempotent(
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  event: BusinessEvent,
  sessionId?: string | null,
): Promise<AppendResult> {
  if (!isReplayEventId(event.event_id)) {
    throw new Error(
      `回放通道 event_id 必须使用独立前缀空间（${REPLAY_EVENT_ID_PREFIXES.join("/")} 开头），拒绝：${event.event_id}（P0-3）`,
    );
  }
  const masked = maskDeep(event);
  const ev = masked.value;
  const checked = safeParseReplayAwareEvent(ev);
  if (!checked.success) {
    throw new Error(`事件未过附录 E 校验：${checked.error.issues[0]?.message ?? "unknown"}`);
  }
  const client = await gateway.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [chainLockKey(scope)]);
    const tail = await client.query<{ seq: string; hash: string }>(
      `SELECT seq, hash FROM biz_events WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY seq DESC LIMIT 1`,
      [scope.tenantId, scope.workspaceId],
    );
    const prevHash = tail.rows[0]?.hash ?? GENESIS_HASH;
    const payload = checked.data;
    const hash = eventHash(prevHash, payload);
    const res = await client.query<{ seq: string | null; inserted: boolean }>(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
      [payload.event_id, scope.tenantId, scope.workspaceId, sessionId ?? null,
        JSON.stringify(payload), prevHash, hash, payload.context.time],
    );
    const deduped = !(res.rows[0]?.inserted ?? false);
    let outSeq = BigInt(res.rows[0]?.seq ?? 0);
    let outHash = hash;
    if (deduped) {
      // #4 修复：去重时返回 DB 中已存在事件的真实 hash/seq，避免调用方拿到错误 hash 断链
      // M2 修复：回查移到 COMMIT 之前（事务内可见性确定，不受并发提交影响）
      const existing = await client.query<{ seq: string; hash: string }>(
        `SELECT seq, hash FROM biz_events WHERE tenant_id = $1 AND event_id = $2`,
        [scope.tenantId, payload.event_id],
      );
      outSeq = BigInt(existing.rows[0]?.seq ?? 0);
      outHash = existing.rows[0]?.hash ?? hash;
    }
    await client.query("COMMIT");
    return { eventId: payload.event_id, seq: outSeq, hash: outHash, deduped, piiHits: masked.hits };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
