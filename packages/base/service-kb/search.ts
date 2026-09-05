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
/** 疑问/语气停用字：含其一的 CJK bigram 不计入相关度分子分母（评测校准：口语长句稀释问题） */
const STOPCHARS = new Set([..."什么怎几多哪吗呢了的要是可有在把被让请帮我你他她它们这那和与或就不都也很还又再各每谁为啥啊呀吧嘛哦嗯办证想能够"]);
/** 子串同义词扩展：口语词 → KB 规范词（小体量 FAQ 库的确定性桥接） */
const SYNONYMS: Array<[string, string]> = [
  ["会员", "会员卡"], ["优惠", "折扣"], ["配送", "送货"], ["开票", "发票"], ["退换", "售后"],
];
/** 弱词表：单独命中不构成「区分度证据」的泛用词 */
const WEAK_TOKENS = new Set(["时间", "免费", "收费", "可以", "服务", "商品", "店铺", "半天", "一份", "一瓶", "东西", "地方", "怎么", "如何", "一下", "价格", "多少钱", "订单", "买家", "顾客", "客服", "工作", "两张", "一张", "几位", "一些"]);

export function tokenizeQuery(query: string): string[] {
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
  // 同义词扩展（子串命中即补规范词 token）
  for (const [colloq, canon] of SYNONYMS) if (lower.includes(colloq) || cjk.includes(colloq)) tokens.add(canon);
  if (cjk.includes("水") && (cjk.includes("瓶") || cjk.includes("送"))) tokens.add("矿泉水");
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
  const stripHyphen = (t: string) => t.toLowerCase().replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, "");
  const hay = stripHyphen(`${chunk.heading}\n${chunk.content}`);
  const head = stripHyphen(chunk.heading);
  let matched = 0;
  let headHits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) matched += 1;
    if (head.includes(t) && !WEAK_TOKENS.has(t)) headHits += 1; // 弱词命中标题不构成主题信号（「收费」不该点亮「收费配送」）
  }
  if (matched === 0) return 0;
  const coverage = matched / tokens.length;
  const headBoost = Math.min(0.2, headHits * 0.08);
  const lenPenalty = Math.min(0.15, chunk.content.length / 4000);
  // 拉丁词全中加成：wifi/SPA 等专有名词完整命中是强相关信号（CJK bigram 噪声不应淹没它）
  const latin = tokens.filter((t) => /^[a-z0-9]+$/.test(t) && t.length >= 2);
  const latinAllHit = latin.length > 0 && latin.every((t) => hay.includes(t));
  const latinBoost = latinAllHit ? 0.12 : 0;
  const base = Math.min(0.98, Math.max(0, coverage * 0.85 + headBoost + latinBoost - lenPenalty + 0.05));
  // 区分度地板（评测校准 v2）：命中证据按强度分档兜底——
  // ① 标题命中：FAQ 小库中 heading 命中是最强主题信号
  // ② 多 token 命中正文（≥2）
  // ③ 单个区分度 token 命中（非弱词，如「拖鞋」「蛋糕」「红酒」）
  const matchedTokens = tokens.filter((t) => hay.includes(t));
  const contentHits = matchedTokens.filter((t) => stripHyphen(chunk.content).includes(t)).length;
  const distinctive = matchedTokens.filter((t) => !WEAK_TOKENS.has(t) && !/^[a-z0-9]$/.test(t));
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
