/**
 * workdata · 组织统一记忆（B3）：三级作用域 + 归因 + pgvector 检索 + 使用记录（F1.4/F6.1）
 *
 * 口径：
 *  - 三级作用域 workspace / agent / run（F1.4）；种类 preference / pattern / sop / forbidden
 *  - 写入必脱敏（内容经 maskDeep，F1.8 脱敏后回流）；来源事件归因 source_events[]
 *  - 引用必写使用记录 memory_usage（F1.4 闭环）；任一记忆可反查来源事件（验收断言）
 *  - 向量检索：pgvector cosine（embedding vector(1536)，D3）；embedding 经 Embedder seam——
 *    Mock 确定性伪向量（D4 无 Key 可跑）/ OpenAI 兼容 /embeddings（真实语义）
 *  - 生命周期：active → superseded（被新记忆取代）/ recalled（回收区 F1.11），禁物理删除
 */
import type pg from "pg";
import {
  EMBEDDING_DIM,
  MEMORY_DEFAULT_CONFIDENCE,
  type BusinessEvent,
} from "@workloom/shared";
import { maskDeep, maskText } from "./pii.js";

/* ================= Embedder seam（D4：Mock 先行） ================= */

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/**
 * Mock Embedder：确定性伪向量（文本 → sha256 流 → 单位球面投影）。
 * 无语义但有确定性相似性（同文本同向量、共享前缀部分相近），供无 Key 演示与测试。
 */
export class MockEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const { createHash } = await import("node:crypto");
    const vec = new Array<number>(EMBEDDING_DIM).fill(0);
    let counter = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      if (i % 16 === 0) counter++;
      const digest = createHash("sha256").update(`${text}#${counter}`, "utf-8").digest();
      vec[i] = (digest[i % 32]! - 128) / 128;
    }
    // 归一化到单位球面（cosine 距离等价内积）
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    return vec.map((x) => x / norm);
  }
}

/** OpenAI 兼容 Embedder（真实语义；B7 计量接入 model_trace） */
export class OpenAiEmbedder implements Embedder {
  constructor(private readonly cfg: { baseUrl: string; apiKey: string; model: string }) {}
  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.cfg.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model: this.cfg.model, input: text }),
    });
    if (!res.ok) throw new Error(`embedding 失败：HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const emb = data.data?.[0]?.embedding;
    if (!emb || emb.length !== EMBEDDING_DIM) throw new Error("embedding 维度不符（期望 1536）");
    return emb;
  }
}

/* ================= 记忆读写 ================= */

export type MemoryScope = "workspace" | "agent" | "run";
export type MemoryKind = "preference" | "pattern" | "sop" | "forbidden";
export type MemoryStatus = "active" | "superseded" | "recalled";

export interface MemoryInput {
  memoryId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  /** 来源事件 ID 列表（归因，F1.4） */
  sourceEvents: string[];
  /** 作用域细分（agent/run 作用域的归属 id） */
  subjectId?: string;
  confidence?: number;
}

async function withScope<T>(
  pool: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
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

/** 事务内写入/更新记忆（D16：调用方持有事务；与业务状态/事件同一 COMMIT） */
export async function upsertMemoryInTx(
  client: pg.PoolClient,
  scope: { tenantId: string; workspaceId: string },
  input: MemoryInput,
  embedder: Embedder,
): Promise<{ memoryId: string; piiHits: number }> {
  const masked = maskText(input.content);
  const embedding = await embedder.embed(masked.text);
  const vecLiteral = `[${embedding.map((x) => x.toFixed(8)).join(",")}]`;
  await client.query(
    `INSERT INTO org_memory (memory_id, tenant_id, workspace_id, scope, kind, content, embedding, source_events, confidence, subject_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10)
     ON CONFLICT (memory_id) DO UPDATE
       SET content = EXCLUDED.content, embedding = EXCLUDED.embedding,
           source_events = EXCLUDED.source_events, status = 'active',
           subject_id = EXCLUDED.subject_id`,
    [
      input.memoryId,
      scope.tenantId,
      scope.workspaceId,
      input.scope,
      input.kind,
      masked.text,
      vecLiteral,
      input.sourceEvents,
      input.confidence ?? MEMORY_DEFAULT_CONFIDENCE,
      input.subjectId ?? null,
    ],
  );
  return { memoryId: input.memoryId, piiHits: masked.hits };
}

/** 写入/更新记忆（脱敏后落库；embedding 由 Embedder 产出） */
export async function upsertMemory(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  input: MemoryInput,
  embedder: Embedder,
): Promise<{ memoryId: string; piiHits: number }> {
  const masked = maskText(input.content);
  const embedding = await embedder.embed(masked.text);
  const vecLiteral = `[${embedding.map((x) => x.toFixed(8)).join(",")}]`;
  await withScope(app, scope, (c) =>
    c.query(
      `INSERT INTO org_memory (memory_id, tenant_id, workspace_id, scope, kind, content, embedding, source_events, confidence, subject_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10)
       ON CONFLICT (memory_id) DO UPDATE
         SET content = EXCLUDED.content, embedding = EXCLUDED.embedding,
             source_events = EXCLUDED.source_events, status = 'active',
             subject_id = EXCLUDED.subject_id`,
      [
        input.memoryId,
        scope.tenantId,
        scope.workspaceId,
        input.scope,
        input.kind,
        masked.text,
        vecLiteral,
        input.sourceEvents,
        input.confidence ?? MEMORY_DEFAULT_CONFIDENCE,
        input.subjectId ?? null,
      ],
    ),
  );
  return { memoryId: input.memoryId, piiHits: masked.hits };
}

export interface MemoryHit {
  memory_id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  confidence: number;
  source_events: string[];
  /** 作用域归属 id（agent/run 作用域的主体；workspace 作用域为 null，M3/M4） */
  subject_id: string | null;
  /** cosine 距离（结构化过滤检索时为 null） */
  distance: number | null;
}

/** 记忆检索：结构化（作用域/种类/主体）+ 可选语义相似（传 query 时按 cosine 升序） */
export async function searchMemories(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  q: { scope?: MemoryScope; kind?: MemoryKind; status?: MemoryStatus; subjectId?: string; query?: string; limit?: number },
  embedder?: Embedder,
): Promise<MemoryHit[]> {
  const limit = Math.min(q.limit ?? 10, 50);
  const clauses = ["tenant_id = $1", "workspace_id = $2"];
  const params: unknown[] = [scope.tenantId, scope.workspaceId];
  if (q.scope) { params.push(q.scope); clauses.push(`scope = $${params.length}`); }
  if (q.kind) { params.push(q.kind); clauses.push(`kind = $${params.length}`); }
  if (q.subjectId) { params.push(q.subjectId); clauses.push(`subject_id = $${params.length}`); }
  params.push(q.status ?? "active");
  clauses.push(`status = $${params.length}`);

  let order = "created_at DESC";
  if (q.query && embedder) {
    const emb = await embedder.embed(q.query);
    params.push(`[${emb.map((x) => x.toFixed(8)).join(",")}]`);
    order = `embedding <=> $${params.length}::vector ASC NULLS LAST, created_at DESC`;
  }
  return withScope(app, scope, async (c) => {
    const r = await c.query<MemoryHit & { dist: number | null }>(
      `SELECT memory_id, scope, kind, content, confidence, source_events, subject_id,
              ${q.query && embedder ? `embedding <=> $${params.length}::vector` : "NULL"} AS dist
       FROM org_memory WHERE ${clauses.join(" AND ")}
       ORDER BY ${order} LIMIT ${limit}`,
      params,
    );
    return r.rows.map((row) => ({ ...row, distance: row.dist }));
  });
}

/**
 * 使用记录（F1.4：引用必写；复合主键幂等）
 * M3/M4：带 workspace_id 落库（RLS 入列）；先校验记忆归属本工作区——
 * 跨工作区记忆不得被本区事件引用（归属伪造拒绝）。
 */
export async function recordMemoryUsage(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  memoryId: string,
  eventId: string,
): Promise<void> {
  await withScope(app, scope, async (c) => {
    const owned = await c.query(
      `SELECT 1 FROM org_memory WHERE memory_id = $1 AND tenant_id = $2 AND workspace_id = $3`,
      [memoryId, scope.tenantId, scope.workspaceId],
    );
    if (owned.rows.length === 0) {
      throw new Error(`记忆 ${memoryId} 不存在或不归属工作区 ${scope.workspaceId}（M3/M4 归属校验拒绝）`);
    }
    await c.query(
      `INSERT INTO memory_usage (memory_id, event_id, workspace_id) VALUES ($1,$2,$3)
       ON CONFLICT (memory_id, event_id) DO NOTHING`,
      [memoryId, eventId, scope.workspaceId],
    );
  });
}

/** 归因反查（验收断言：任一记忆可反查来源事件） */
export async function getMemorySources(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  memoryId: string,
): Promise<{ memory: MemoryHit | null; sourceEvents: BusinessEvent[]; usedBy: string[] }> {
  return withScope(app, scope, async (c) => {
    const m = await c.query<MemoryHit>(
      `SELECT memory_id, scope, kind, content, confidence, source_events, subject_id
       FROM org_memory WHERE memory_id = $1 AND tenant_id = $2 AND workspace_id = $3`,
      [memoryId, scope.tenantId, scope.workspaceId],
    );
    if (!m.rows[0]) return { memory: null, sourceEvents: [], usedBy: [] };
    const mem = m.rows[0];
    const ev = await c.query<{ payload: BusinessEvent }>(
      `SELECT payload FROM biz_events WHERE tenant_id=$1 AND event_id = ANY($2) ORDER BY seq`,
      [scope.tenantId, mem.source_events],
    );
    // M3/M4：memory_usage 已入 RLS（workspace_id 列），显式按本工作区过滤
    const usage = await c.query<{ event_id: string }>(
      `SELECT event_id FROM memory_usage WHERE memory_id = $1 AND workspace_id = $2 ORDER BY used_at`,
      [memoryId, scope.workspaceId],
    );
    return {
      memory: { ...mem, distance: null },
      sourceEvents: ev.rows.map((r) => r.payload),
      usedBy: usage.rows.map((r) => r.event_id),
    };
  });
}

/**
 * 生命周期迁移（superseded / recalled；禁物理删除——回收区口径 F1.11）
 * 手势回流校准的写路径在 B6 review-console 触发，此处提供机制位。
 */
export async function transitionMemory(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  memoryId: string,
  to: "superseded" | "recalled",
  replacedBy?: string,
): Promise<void> {
  await withScope(app, scope, async (c) => {
    const r = await c.query(
      `UPDATE org_memory SET status = $4
       WHERE memory_id = $1 AND tenant_id = $2 AND workspace_id = $3 AND status = 'active'`,
      [memoryId, scope.tenantId, scope.workspaceId, to],
    );
    if (r.rowCount === 0) throw new Error(`记忆 ${memoryId} 不存在或已非 active（幂等约束）`);
    // 取代链留痕：superseded 时被谁取代（写进 content 前缀会破坏语义，故仅日志口径——
    // 完整取代关系在 B6 校准回流事件（memory.calibrate）中事件化）
    if (to === "superseded" && replacedBy) {
      await c.query(
        `UPDATE org_memory SET confidence = LEAST(confidence + 0.1, 1.0)
         WHERE memory_id = $1 AND tenant_id = $2 AND workspace_id = $3`,
        [replacedBy, scope.tenantId, scope.workspaceId],
      );
    }
  });
}

/** 供 B6 校准回流复用：脱敏检查出口（禁止明文 PII 写入记忆，F1.8） */
export function assertMemoryContentSafe(content: string): { safe: boolean; hits: number } {
  const r = maskDeep(content);
  return { safe: r.hits === 0, hits: r.hits };
}
