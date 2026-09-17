/**
 * service-kb · 知识库集合与文档（版本链 + hash 幂等）
 *
 * 纪律：
 *  - upsertDocument：同 (workspace_id, hash) 命中即幂等返回（不重切分不建版）；
 *    同 (collection_id, title) 新版本 version = max(version)+1 并存（旧版不删，检索仅看 active）；
 *  - 切块经 chunkMarkdown（标题路径保留）；embedder 注入式——无 embedder 时 embedding 置 NULL，
 *    检索自动降级关键词兜底（search.ts）。
 *  - DB 经 Queryable 最小接口隔离（pg.Pool 结构兼容；测试注入内存假库）。
 */
import { newId } from "@workloom/shared";
import { chunkMarkdown, hashContent, type KbChunkDraft } from "./chunk.js";

/** pg.Pool / PoolClient 结构兼容的最小查询接口（测试注入内存假库） */
export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface KbCollection {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
}

export interface KbDocument {
  id: string;
  workspace_id: string;
  collection_id: string;
  title: string;
  source_kind: "upload" | "official_site" | "manual";
  source_url: string | null;
  version: number;
  status: "active" | "disabled" | "pending_review";
  content_md: string;
  hash: string | null;
  created_at: string;
}

/** Embedder seam（与 workdata/memory.ts 同构，避免跨模块耦合） */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export async function createCollection(
  db: Queryable,
  input: { workspaceId: string; name: string; description?: string },
): Promise<KbCollection> {
  const id = newId("KBC");
  const r = await db.query<KbCollection>(
    `INSERT INTO kb_collections (id, workspace_id, name, description) VALUES ($1,$2,$3,$4) RETURNING *`,
    [id, input.workspaceId, input.name, input.description ?? ""],
  );
  return r.rows[0]!;
}

export interface UpsertDocumentInput {
  workspaceId: string;
  collectionId: string;
  title: string;
  sourceKind: "upload" | "official_site" | "manual";
  sourceUrl?: string;
  contentMd: string;
  /** 默认 active；官网抓取链路（crawlAndStructure/diffScan）传 pending_review */
  status?: "active" | "disabled" | "pending_review";
}

export interface UpsertDocumentResult {
  document: KbDocument;
  chunks: KbChunkDraft[];
  /** true = 同 hash 已存在，幂等返回（未新建版本） */
  deduped: boolean;
  /** true = 新文档为首版（version=1），false = 既有标题的版本递增 */
  firstVersion: boolean;
}

export async function upsertDocument(
  db: Queryable,
  input: UpsertDocumentInput,
  embedder?: Embedder,
): Promise<UpsertDocumentResult> {
  const hash = hashContent(input.contentMd);

  // hash 幂等：同内容已入库 → 原样返回最新同 hash 文档，不建版不重切
  const dup = await db.query<KbDocument>(
    `SELECT * FROM kb_documents WHERE workspace_id=$1 AND hash=$2 ORDER BY version DESC LIMIT 1`,
    [input.workspaceId, hash],
  );
  if (dup.rows[0]) {
    return { document: dup.rows[0], chunks: [], deduped: true, firstVersion: false };
  }

  // 版本链：同集合同标题 version+1 并存（旧版保留可回溯；检索只看 active）
  const ver = await db.query<{ v: number | null }>(
    `SELECT MAX(version) AS v FROM kb_documents WHERE workspace_id=$1 AND collection_id=$2 AND title=$3`,
    [input.workspaceId, input.collectionId, input.title],
  );
  const version = (ver.rows[0]?.v ?? 0) + 1;

  // H8 版本链纪律：新版本落库前，同 (collection_id,title) 旧 active 版同事务置 disabled
  // （任一时刻同标题至多一个 active 版本；pending_review 历史版不动，留审批台处理）
  await db.query(
    `UPDATE kb_documents SET status='disabled'
     WHERE workspace_id=$1 AND collection_id=$2 AND title=$3 AND status='active'`,
    [input.workspaceId, input.collectionId, input.title],
  );

  const id = newId("KBD");
  const doc = await db.query<KbDocument>(
    `INSERT INTO kb_documents
       (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      id, input.workspaceId, input.collectionId, input.title, input.sourceKind,
      input.sourceUrl ?? null, version, input.status ?? "active", input.contentMd, hash,
    ],
  );

  const chunks = chunkMarkdown(input.contentMd);
  for (const c of chunks) {
    const embedding = embedder ? await embedder.embed(`${c.heading}\n${c.content}`) : null;
    await db.query(
      `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content, embedding, keywords)
       VALUES ($1,$2,$3,$4,$5,$6, to_tsvector('simple', $5))
       ON CONFLICT (document_id, chunk_index) DO UPDATE
         SET heading=EXCLUDED.heading, content=EXCLUDED.content,
             embedding=EXCLUDED.embedding, keywords=EXCLUDED.keywords`,
      [input.workspaceId, id, c.chunkIndex, c.heading, c.content,
        embedding ? `[${embedding.join(",")}]` : null],
    );
  }
  return { document: doc.rows[0]!, chunks, deduped: false, firstVersion: version === 1 };
}

export async function listDocuments(
  db: Queryable,
  filter: { workspaceId: string; collectionId?: string; status?: string; limit?: number },
): Promise<KbDocument[]> {
  const conds = ["workspace_id = $1"];
  const params: unknown[] = [filter.workspaceId];
  if (filter.collectionId) { params.push(filter.collectionId); conds.push(`collection_id = $${params.length}`); }
  if (filter.status) { params.push(filter.status); conds.push(`status = $${params.length}`); }
  params.push(Math.min(filter.limit ?? 100, 500));
  const r = await db.query<KbDocument>(
    `SELECT * FROM kb_documents WHERE ${conds.join(" AND ")}
     ORDER BY collection_id, title, version DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export async function setDocumentStatus(
  db: Queryable,
  input: { workspaceId: string; documentId: string; status: "active" | "disabled" | "pending_review" },
): Promise<KbDocument> {
  const r = await db.query<KbDocument>(
    `UPDATE kb_documents SET status=$3 WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [input.documentId, input.workspaceId, input.status],
  );
  if (!r.rows[0]) throw new Error(`文档 ${input.documentId} 不存在`);
  return r.rows[0];
}
