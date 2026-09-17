/**
 * scripts/cleanup-ttl.ts · TTL 生命周期清扫（P1-9）
 *
 * 部署（cron，周频低峰；仓库根目录执行）：
 *   0 4 * * 0 cd /path/to/wl-im-full && pnpm tsx --env-file=.env scripts/cleanup-ttl.ts >> /var/log/workloom-ttl.log 2>&1
 * 也可手动：`pnpm tsx --env-file=.env scripts/cleanup-ttl.ts [--dry-run]`
 *
 * 清扫口径：
 *  ① c_messages / c_notifications：90 天归档删除——先把到期行 INSERT 进同构
 *     _archive 表（归档表随脚本 CREATE IF NOT EXISTS，LIKE 源表含默认值），同事务
 *     再 DELETE 源表；归档与删除原子完成，崩溃不留「已删未归档」窗口。
 *  ② im_inbound_dedupe：30 天删除。event_id='' 且占位超 10 分钟的异常占位
 *     【只告警不删】——与入站修复口径一致：占位行等待事件回填，删除会丢去重键
 *     导致同消息重放；超期未回填说明入站管道卡死，需人工排查而非静默清扫。
 *  ③ biz_events：append-only 铁律（L1.1），永不删除——仅输出各 workspace 统计
 *     （条数/时间跨度/最新 seq），供容量规划参考。
 *  --dry-run：只统计将归档/删除的行数，不写库（含归档表也不建）。
 * 退出码：0 正常；1 执行错误。
 */
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const DRY_RUN = process.argv.includes("--dry-run");

const MESSAGE_TTL_DAYS = 90;
const DEDUPE_TTL_DAYS = 30;
const ORPHAN_PLACEHOLDER_MINUTES = 10;

/** 需 TTL 归档的消息类表（源表 → 归档表） */
const ARCHIVE_TABLES = [
  { src: "c_messages", dst: "c_messages_archive" },
  { src: "c_notifications", dst: "c_notifications_archive" },
] as const;

async function main(): Promise<void> {
  // owner/种子连接：归档表建设与跨 workspace 清扫不逐区切 GUC（D10 运维通道）
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log(`== TTL 生命周期清扫（P1-9）== ${DRY_RUN ? "【dry-run 只统计不写库】" : ""}`);
  try {
    /* ---------- ① 消息类表：90 天归档删除 ---------- */
    if (!DRY_RUN) {
      for (const { src, dst } of ARCHIVE_TABLES) {
        // 归档表随脚本建设（同构：LIKE 源表含默认值/约束；bigserial id 序列共享，显式 id 插入无冲突）
        await client.query(`CREATE TABLE IF NOT EXISTS ${dst} (LIKE ${src} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
      }
    }
    for (const { src, dst } of ARCHIVE_TABLES) {
      const due = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${src} WHERE created_at < now() - interval '${MESSAGE_TTL_DAYS} days'`,
      );
      const n = Number(due.rows[0]?.n ?? 0);
      if (DRY_RUN) {
        console.log(`· [dry-run] ${src}：${n} 条超 ${MESSAGE_TTL_DAYS} 天将归档删除 → ${dst}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        // 先归档后删除，同一事务原子提交（INSERT … SELECT 与 DELETE 同窗口，无丢失缝）
        await client.query(
          `INSERT INTO ${dst} SELECT * FROM ${src}
           WHERE created_at < now() - interval '${MESSAGE_TTL_DAYS} days'
           ON CONFLICT DO NOTHING`,
        );
        const del = await client.query(
          `DELETE FROM ${src} WHERE created_at < now() - interval '${MESSAGE_TTL_DAYS} days'`,
        );
        await client.query("COMMIT");
        console.log(`✓ ${src}：归档删除 ${del.rowCount ?? 0} 条（>${MESSAGE_TTL_DAYS} 天）→ ${dst}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    }

    /* ---------- ② im_inbound_dedupe：30 天删除；异常占位只告警不删 ---------- */
    const orphans = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM im_inbound_dedupe
       WHERE event_id='' AND created_at < now() - interval '${ORPHAN_PLACEHOLDER_MINUTES} minutes'`,
    );
    const orphanN = Number(orphans.rows[0]?.n ?? 0);
    if (orphanN > 0) {
      // 与入站修复口径一致：占位超期未回填 = 入站管道异常，告警人工排查，不删（删则丢去重键）
      console.warn(`⚠ im_inbound_dedupe：${orphanN} 条 event_id='' 异常占位超过 ${ORPHAN_PLACEHOLDER_MINUTES} 分钟未回填——保留不删，请排查入站管道`);
    }
    const dedupeDue = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM im_inbound_dedupe
       WHERE created_at < now() - interval '${DEDUPE_TTL_DAYS} days' AND event_id <> ''`,
    );
    const dedupeN = Number(dedupeDue.rows[0]?.n ?? 0);
    if (DRY_RUN) {
      console.log(`· [dry-run] im_inbound_dedupe：${dedupeN} 条超 ${DEDUPE_TTL_DAYS} 天将删除（异常占位 ${orphanN} 条保留告警）`);
    } else {
      const del = await client.query(
        `DELETE FROM im_inbound_dedupe
         WHERE created_at < now() - interval '${DEDUPE_TTL_DAYS} days' AND event_id <> ''`,
      );
      console.log(`✓ im_inbound_dedupe：删除 ${del.rowCount ?? 0} 条（>${DEDUPE_TTL_DAYS} 天；异常占位 ${orphanN} 条保留）`);
    }

    /* ---------- ③ biz_events：append-only 铁律，只统计不删除 ---------- */
    const stats = await client.query<{
      workspace_id: string; n: string; first_at: string; last_at: string; max_seq: string;
    }>(
      `SELECT workspace_id, count(*)::text AS n,
              min(created_at)::text AS first_at, max(created_at)::text AS last_at,
              max(seq)::text AS max_seq
       FROM biz_events GROUP BY workspace_id ORDER BY 1`,
    );
    console.log(`✓ biz_events：append-only 不删除（L1.1 铁律），各 workspace 统计：`);
    for (const s of stats.rows) {
      console.log(`    [${s.workspace_id}] ${s.n} 条 · ${s.first_at.slice(0, 10)} → ${s.last_at.slice(0, 10)} · 最新 seq ${s.max_seq}`);
    }

    console.log(DRY_RUN ? "== dry-run 完成（未写库）==" : "== 清扫完成 ==");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("❌ TTL 清扫失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
