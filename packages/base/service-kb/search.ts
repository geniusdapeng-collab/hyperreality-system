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

/**
 * 活动 Bundle 可注入的检索词表。基座默认值为空：不预判任何行业的同义词，
 * 也不把任何业务名词擅自降为弱词。
 */
export interface KbSearchLexicon {
  synonyms?: ReadonlyArray<readonly [source: string, canonical: string]>;
  weakTokens?: readonly string[];
}

/** 查询分词（中英混排：英文/数字按词，中文按 2-gram 防单字噪声命中，纯函数） */
/** 疑问/语气停用字：只包含通用语法字；业务词必须由活动 Bundle 词表声明。 */
const STOPCHARS = new Set([..."什么怎几多哪吗呢了的要是可有在把被让请帮我你他她它们这那和与或就不都也很还又再各每谁为啥啊呀吧嘛哦嗯想能够"]);

function normalizedWeakTokens(lexicon?: KbSearchLexicon): Set<string> {
  return new Set((lexicon?.weakTokens ?? []).map((token) => token.trim().toLowerCase()).filter(Boolean));
}

export function isWeakKbToken(token: string, lexicon?: KbSearchLexicon): boolean {
  return normalizedWeakTokens(lexicon).has(token.trim().toLowerCase());
}

export function tokenizeQuery(query: string, lexicon?: KbSearchLexicon): string[] {
  const tokens = new Set<string>();
  const lower = query.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]+/g)) tokens.add(m[0]);
  // 连字符拉丁串（Wi-Fi/C-Store 等）补去连字符整体 token，保证 wifi 问法能命中 wi-fi 知识
  for (const m of lower.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)+/g)) tokens.add(m[0].replaceAll("-", ""));
  const cjk = query.replace(/[a-z0-9\s\p{P}]/giu, "");
  if (cjk.length === 1) tokens.add(cjk);
  for (let i = 0; i + 1 < cjk.length; i++) {
    const bg = cjk.slice(i, i + 2);
    if ([...bg].some((ch) => STOPCHARS.has(ch))) continue; // 停用字过滤
    tokens.add(bg);
  }
  // 同义词只能由已验证的活动 Bundle/显式调用方注入；基座不内置业务词义。
  for (const [source, canonical] of lexicon?.synonyms ?? []) {
    const normalizedSource = source.trim().toLowerCase();
    const normalizedCanonical = canonical.trim().toLowerCase();
    if (normalizedSource && normalizedCanonical && lower.includes(normalizedSource)) {
      tokens.add(normalizedCanonical);
    }
  }
  return [...tokens].filter((t) => t.length > 0);
}

/**
 * 关键词兜底打分（确定性纯函数）：
 * 命中词占比为主，标题命中加权，长度惩罚抑制灌水长块；归一化到 0..0.98。
 */
export function scoreChunkFallback(
  query: string,
  chunk: { heading: string; content: string },
  lexicon?: KbSearchLexicon,
): number {
  const tokens = tokenizeQuery(query, lexicon);
  if (tokens.length === 0) return 0;
  const stripHyphen = (t: string) => t.toLowerCase().replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, "");
  const hay = stripHyphen(`${chunk.heading}\n${chunk.content}`);
  const head = stripHyphen(chunk.heading);
  let matched = 0;
  let headHits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) matched += 1;
    if (head.includes(t) && !isWeakKbToken(t, lexicon)) headHits += 1;
  }
  if (matched === 0) return 0;
  const coverage = matched / tokens.length;
  const headBoost = Math.min(0.2, headHits * 0.08);
  const lenPenalty = Math.min(0.15, chunk.content.length / 4000);
  // 拉丁词全中加成：显式标识完整命中是强相关信号（CJK bigram 噪声不应淹没它）
  const latin = tokens.filter((t) => /^[a-z0-9]+$/.test(t) && t.length >= 2);
  const latinAllHit = latin.length > 0 && latin.every((t) => hay.includes(t));
  const latinBoost = latinAllHit ? 0.12 : 0;
  const base = Math.min(0.98, Math.max(0, coverage * 0.85 + headBoost + latinBoost - lenPenalty + 0.05));
  // 区分度地板（评测校准 v2）：命中证据按强度分档兜底——
  // ① 标题命中：FAQ 小库中 heading 命中是最强主题信号
  // ② 多 token 命中正文（≥2）
  // ③ 单个区分度 token 命中（未被显式词表声明为弱词）
  const matchedTokens = tokens.filter((t) => hay.includes(t));
  const contentHits = matchedTokens.filter((t) => stripHyphen(chunk.content).includes(t)).length;
  const distinctive = matchedTokens.filter((t) => !isWeakKbToken(t, lexicon) && !/^[a-z0-9]$/.test(t));
  let floor = 0;
  if (headHits > 0) floor = Math.max(floor, 0.55 + 0.05 * Math.min(headHits, 3) + coverage * 0.2);
  if (contentHits >= 2) floor = Math.max(floor, 0.5 + 0.04 * Math.min(contentHits, 4) + coverage * 0.2);
  if (distinctive.length >= 1) floor = Math.max(floor, 0.5 + coverage * 0.2);
  return Math.min(0.98, Math.max(base, floor));
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
  lexicon?: KbSearchLexicon,
): Promise<KbSearchHit[]> {
  const tokens = tokenizeQuery(query, lexicon);
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
      score: scoreChunkFallback(query, row, lexicon),
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface SearchOptions {
  workspaceId: string;
  limit?: number;
  /** 必须来自已验证的活动 Bundle 投影或受信调用方；省略时使用纯通用检索。 */
  lexicon?: KbSearchLexicon;
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
  const hits = await keywordSearch(db, query, opts.workspaceId, limit, opts.lexicon);
  return { hits, degraded: !extra.embedder };
}
