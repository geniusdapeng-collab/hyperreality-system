/**
 * 事件账本物理序列维护。
 *
 * `biz_events.seq` 是全库主键（BIGSERIAL），与业务事件号 `event_id` 的
 * `biz_events_eid_seq` 完全独立。历史种子曾显式写入 `seq`，可能令表中最大值
 * 超前于 BIGSERIAL 序列；下一次正常追加便会撞 `biz_events_pkey`。
 *
 * 仅供迁移/种子账号在离线夹具准备阶段调用：只在落后时向前推进，绝不回退、
 * 删除或改写任何事件。ACCESS EXCLUSIVE 锁使“读取水位→推进序列”与正常 INSERT
 * 互斥，避免修复窗口内再次分配到旧号。
 */
import type pg from "pg";

export interface EventStorageSequenceRepair {
  maxStoredSeq: bigint;
  nextBefore: bigint;
  nextAfter: bigint;
  repaired: boolean;
}

export async function reconcileEventStorageSequenceForSeed(
  client: Pick<pg.ClientBase, "query">,
): Promise<EventStorageSequenceRepair> {
  await client.query("BEGIN");
  try {
    await client.query("LOCK TABLE biz_events IN ACCESS EXCLUSIVE MODE");
    const state = await client.query<{ max_seq: string; last_value: string; is_called: boolean }>(
      `SELECT (SELECT COALESCE(MAX(e.seq), 0) FROM biz_events e)::text AS max_seq,
              s.last_value::text AS last_value,
              s.is_called
         FROM biz_events_seq_seq s`,
    );
    const row = state.rows[0];
    if (!row) throw new Error("无法读取事件账本物理序列状态");

    const maxStoredSeq = BigInt(row.max_seq);
    const lastValue = BigInt(row.last_value);
    const nextBefore = row.is_called ? lastValue + 1n : lastValue;
    const repaired = maxStoredSeq >= nextBefore;
    if (repaired) {
      // pg_get_serial_sequence 避免把实际序列名称复制成第二事实源；这里只向前推进。
      await client.query(
        `SELECT setval(pg_get_serial_sequence('biz_events', 'seq')::regclass, $1::bigint, true)`,
        [maxStoredSeq.toString()],
      );
    }
    await client.query("COMMIT");
    return {
      maxStoredSeq,
      nextBefore,
      nextAfter: repaired ? maxStoredSeq + 1n : nextBefore,
      repaired,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
