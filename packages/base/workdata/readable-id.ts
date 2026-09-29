/**
 * 可读编号（T-104 / VID-1042）取号与落库的**唯一机制入口**。
 *
 * 为什么要有这个模块（2026-09-29 二次修复，GR-02 复发复盘，来自 WorkLoom-growth 独立验收）：
 *   号源历史上被改过两轮——0048 改纯 `nextval`（原子，但种子/手写 id 领先序列时撞号），
 *   0050 又加回 `GREATEST(nextval, max(...))`（把原子性交还给了 max 竞争，12 路并发实测 1 个 500）。
 *   两次都是在"函数里做文章"，没有任何一处**可复用的取号+落库**口径，于是每个调用点各写各的
 *   （+1 与否、失败怎么退）——这正是缺陷能反复复发的原因。
 *
 * 本模块固定三条不变量：
 *   ① 号源只由数据库序列产生：一次 `nextval` 一个号，**返回值直接可用**（调用方不再 +1）；
 *   ② 序列落后于手写/历史 id 时，靠 `SAVEPOINT` 回滚重试收敛——**不回滚整个事务**，
 *      保住"建单与事件同一 COMMIT"（D16）的事务不变式；旧实现的重试写在已中止事务里，
 *      从诞生起就不可能成功（PG：`current transaction is aborted`）；
 *   ③ 重试是有限次且**只对 23505**（撞号）；其它错误原样抛出，不静默改号、不吞异常。
 */
import type pg from "pg";
import { makeReadableId } from "@workloom/shared";

/** 撞号重试上限：序列落后于手写号段时，每次 nextval 必然前进一格，有限次内收敛。 */
export const READABLE_ID_MAX_ATTEMPTS = 8;

export interface ReadableIdSource {
  /** 编号前缀（makeReadableId 口径）："T" → T-104 */
  prefix: string;
  /** 取号 SQL 表达式（必须是纯序列 nextval 的 SECURITY DEFINER 包装） */
  nextNumberSql: string;
  /** 撞号时可读的号源名（日志/报错用） */
  label: string;
}

export const THREAD_ID_SOURCE: ReadableIdSource = {
  prefix: "T",
  nextNumberSql: "public.threads_max_t_no()",
  label: "线程号 T-*",
};

export const VIDEO_PROJECT_ID_SOURCE: ReadableIdSource = {
  prefix: "VID",
  nextNumberSql: "public.video_projects_max_vid_no()",
  label: "视频项目号 VID-*",
};

export interface ReadableIdInsertOutcome<T> {
  id: string;
  value: T;
}

/**
 * 取下一个可读编号并落库；撞号自动换号重试（同事务内，SAVEPOINT 级回滚）。
 *
 * 调用方必须已经处于显式事务内（BEGIN + set_config RLS 上下文），并在 `insert` 里
 * 完成**所有**与该编号相关的行写入；本函数只保证"编号唯一"与"撞号可退"。
 */
export async function insertWithReadableId<T>(
  client: pg.PoolClient,
  source: ReadableIdSource,
  insert: (id: string) => Promise<T>,
): Promise<ReadableIdInsertOutcome<T>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READABLE_ID_MAX_ATTEMPTS; attempt += 1) {
    const savepoint = `readable_id_${attempt}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    const row = await client.query<{ n: string | number }>(`SELECT ${source.nextNumberSql} AS n`);
    const next = Number(row.rows[0]?.n);
    if (!Number.isFinite(next) || next <= 0) {
      // 号源不可用属配置/迁移错误：立刻抛出留痕，绝不"顺手造一个 id"
      throw new Error(`${source.label} 取号失败：${source.nextNumberSql} 返回 ${String(row.rows[0]?.n)}`);
    }
    const id = makeReadableId(source.prefix, next);
    try {
      const value = await insert(id);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { id, value };
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
      lastError = err;
      if ((err as { code?: string }).code !== "23505") throw err;
      console.warn(`[readable-id] ${source.label} 撞号 ${id}（第 ${attempt}/${READABLE_ID_MAX_ATTEMPTS} 次），换号重试`);
    }
  }
  throw lastError ?? new Error(`${source.label} 连续 ${READABLE_ID_MAX_ATTEMPTS} 次撞号：序列严重落后于现存号段，请先对齐序列`);
}

/**
 * 把序列抬到"现存最大号"之上（幂等，只抬不降）。
 *
 * 何时调用：**手写 id 的写入方**（种子/回填脚本/迁移）跑完之后。放在这里而不是取号函数里，
 * 是因为取号函数一旦读 `max()` 就把并发原子性交还给了 max 竞争——0050 的翻车点。
 * 用 `GREATEST(现值, 现存最大)` 保证不会把序列往回拨。
 *
 * `videoProjects` 默认跟随"本仓是否存在 video_projects 表"（基座无视频模块时自动跳过）。
 */
export async function alignReadableIdSequences(
  client: pg.PoolClient,
  options: { threads?: boolean; videoProjects?: boolean } = { threads: true },
): Promise<{ threads: number | null; videoProjects: number | null }> {
  const out: { threads: number | null; videoProjects: number | null } = { threads: null, videoProjects: null };
  if (options.threads !== false) {
    const r = await client.query<{ v: string }>(
      `SELECT setval('public.thread_no_seq',
                      GREATEST((SELECT last_value FROM public.thread_no_seq),
                               (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 100)
                                  FROM public.threads WHERE id ~ '^T-[0-9]+$')),
                      true) AS v`,
    );
    out.threads = Number(r.rows[0]?.v);
  }
  if (options.videoProjects === true) {
    const r = await client.query<{ v: string }>(
      `SELECT setval('public.video_project_no_seq',
                      GREATEST((SELECT last_value FROM public.video_project_no_seq),
                               (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 1000)
                                  FROM public.video_projects WHERE id ~ '^VID-[0-9]+$')),
                      true) AS v`,
    );
    out.videoProjects = Number(r.rows[0]?.v);
  }
  return out;
}
