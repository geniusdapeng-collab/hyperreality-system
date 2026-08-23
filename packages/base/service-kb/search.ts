/**
 * service-kb · 混合检索（searchKB）
 *
 * 双链路：
 *  - 有 embedder：pgvector 余弦（embedding <=> 查询向量，score = 1 - distance）；
 *  - 无 embedder（或向量链路无命中）：关键词兜底——SQL 召回候选（ILIKE 任一词 / tsvector），
 *    确定性打分 scoreChunkFallback（纯函数，可单测）在 TS 侧排序截断。
 * 检索范围：仅 status='active' 文档（pending_review/disabled 不外发）。
 */
import type { Embedder, Queryable } from "./kb.js";

export interface KbSearchHit {
  content: string;
  heading: string;
  documentTitle: string;
  documentId: string;
  /** 归一化 0..1（dialog 置信度三档分流依据） */
  score: number;
}

/** 查询分词（中英混排：英文/数字按词，中文按 2-gram 防单字噪声命中，纯函数） */
export function tokenizeQuery(query: string): string[] {
  const tokens = new Set<string>();
  for (const m of query.toLowerCase().matchAll(/[a-z0-9]+/g)) tokens.add(m[0]);
  const cjk = query.replace(/[a-z0-9\s\p{P}]/giu, "");
  if (cjk.length === 1) tokens.add(cjk);
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk.slice(i, i + 2));
  return [...tokens].filter((t) => t.length > 0);
}

/**
 * 关键词兜底打分（确定性纯函数）：
 * 命中词占比为主，标题命中加权，长度惩罚抑制灌水长块；归一化到 0..0.98。
 */
export function scoreChunkFallback(
  query: string,
  chunk: { heading: string; content: string },
): number {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 0;
  const hay = `${chunk.heading}\n${chunk.content}`.toLowerCase();
  const head = chunk.heading.toLowerCase();
  let matched = 0;
  let headHits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) matched += 1;
    if (head.includes(t)) headHits += 1;
  }
  if (matched === 0) return 0;
  const coverage = matched / tokens.length;
  const headBoost = Math.min(0.2, headHits * 0.08);
  const lenPenalty = Math.min(0.15, chunk.content.length / 4000);
  return Math.min(0.98, Math.max(0, coverage * 0.85 + headBoost - lenPenalty + 0.05));
}

interface CandidateRow {
  content: string;
  heading: string;
  document_id: string;
  document_title: string;
}

async function vectorSearch(
  db: Queryable,
  queryVec: number[],
  workspaceId: string,
  limit: number,
): Promise<KbSearchHit[]> {
  const r = await db.query<CandidateRow & { score: number }>(
    `SELECT c.content, c.heading, c.document_id, d.title AS document_title,
            1 - (c.embedding <=> $1::vector) AS score
     FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
     WHERE c.workspace_id=$2 AND d.status='active' AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector ASC
     LIMIT $3`,
    [`[${queryVec.join(",")}]`, workspaceId, limit],
  );
  return r.rows.map((row) => ({
    content: row.content,
    heading: row.heading,
    documentTitle: row.document_title,
    documentId: row.document_id,
    score: Math.max(0, Math.min(1, Number(row.score))),
  }));
}

async function keywordSearch(
  db: Queryable,
  query: string,
  workspaceId: string,
  limit: number,
): Promise<KbSearchHit[]> {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  // 候选召回：任一词 ILIKE 或 tsvector 命中（宽进严出，精排在 TS 侧确定性完成）
  const likeConds = tokens.map((_, i) => `c.content ILIKE '%' || $${i + 3} || '%'`).join(" OR ");
  const r = await db.query<CandidateRow>(
    `SELECT c.content, c.heading, c.document_id, d.title AS document_title
     FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
     WHERE c.workspace_id=$1 AND d.status='active'
       AND (${likeConds} OR c.keywords @@ plainto_tsquery('simple', $2))
     LIMIT $${tokens.length + 3}`,
    [workspaceId, query, ...tokens, Math.max(limit * 10, 50)],
  );
  return r.rows
    .map((row) => ({
      content: row.content,
      heading: row.heading,
      documentTitle: row.document_title,
      documentId: row.document_id,
      score: scoreChunkFallback(query, row),
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface SearchOptions {
  workspaceId: string;
  limit?: number;
}

/** 混合检索主入口：有 embedder 走向量链路，无则关键词兜底（degraded 标注供调用方留痕） */
export async function searchKB(
  db: Queryable,
  query: string,
  opts: SearchOptions,
  extra: { embedder?: Embedder } = {},
): Promise<{ hits: KbSearchHit[]; degraded: boolean }> {
  const limit = Math.min(opts.limit ?? 5, 20);
  if (extra.embedder) {
    const vec = await extra.embedder.embed(query);
    const hits = await vectorSearch(db, vec, opts.workspaceId, limit);
    if (hits.length > 0) return { hits, degraded: false };
    // 向量链路零命中（如全库无 embedding）→ 关键词兜底
  }
  const hits = await keywordSearch(db, query, opts.workspaceId, limit);
  return { hits, degraded: !extra.embedder };
}
