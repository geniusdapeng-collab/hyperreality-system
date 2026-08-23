/**
 * service · 知识库（接口对齐 packages/base/service-kb 签名；表结构为底座迁移版）
 *  - 切块：Markdown 二级标题分段（store.splitChunks → kb_chunks.chunk_index）
 *  - 检索：确定性关键词打分（标题权重 ×3；CJK 二字切词），仅命中 status='active' 文档
 *  - 状态枚举（底座 CHECK）：active | pending_review | disabled；来源：manual | upload | official_site
 *  - 站点源：fetch 抓取 → 去标签纯文本 →（可选）LLM 结构化为 FAQ；无 LLM 降级直存（degraded:true）
 * 全部读写经 svcQuery/serviceTx（RLS 事务上下文）。
 */
import { createHash } from "node:crypto";
import { ensureServiceSchema, indexChunks } from "./store.js";
import { serviceTx, svcQuery } from "./events.js";
import type { LlmCall } from "./llm.js";

let seq = 0;
function newId(prefix: string): string {
  seq = (seq + 1) % 46656;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export interface KbCollection { id: string; workspaceId: string; name: string; description: string; createdAt: string }
export interface KbDocument {
  id: string; workspaceId: string; collectionId: string; title: string;
  sourceKind: string; sourceUrl: string | null; version: number; status: string; createdAt: string;
}
export interface KbHit { content: string; heading: string; documentTitle: string; documentId: string; score: number }

function collectionOf(x: Record<string, unknown>): KbCollection {
  return { id: String(x.id), workspaceId: String(x.workspace_id), name: String(x.name), description: String(x.description ?? ""), createdAt: new Date(String(x.created_at)).toISOString() };
}
function documentOf(x: Record<string, unknown>): KbDocument {
  return {
    id: String(x.id), workspaceId: String(x.workspace_id), collectionId: String(x.collection_id),
    title: String(x.title), sourceKind: String(x.source_kind), sourceUrl: x.source_url as string | null,
    version: Number(x.version), status: String(x.status), createdAt: new Date(String(x.created_at)).toISOString(),
  };
}

export async function createCollection(input: { workspaceId: string; name: string; description?: string }): Promise<KbCollection> {
  await ensureServiceSchema();
  const rows = await svcQuery(
    input.workspaceId,
    `INSERT INTO kb_collections (id, workspace_id, name, description) VALUES ($1,$2,$3,$4) RETURNING *`,
    [newId("kbc"), input.workspaceId, input.name, input.description ?? ""],
  );
  return collectionOf(rows[0]!);
}

export async function listCollections(input: { workspaceId: string }): Promise<KbCollection[]> {
  await ensureServiceSchema();
  const rows = await svcQuery(input.workspaceId, `SELECT * FROM kb_collections WHERE workspace_id=$1 ORDER BY created_at`, [input.workspaceId]);
  return rows.map(collectionOf);
}

/** upsert：同工作区同标题（或同 sourceUrl）→ 版本 +1 重建切块；否则新建（pending_review 待审批生效） */
export async function upsertDocument(input: {
  workspaceId: string; collectionId: string; title: string;
  sourceKind: string; sourceUrl?: string; contentMd: string;
}): Promise<{ documentId: string; version: number; chunks: number }> {
  await ensureServiceSchema();
  const hash = createHash("sha256").update(input.contentMd).digest("hex");
  return serviceTx(input.workspaceId, async (client) => {
    const exist = await client.query(
      `SELECT id, version FROM kb_documents
       WHERE workspace_id=$1 AND (title=$2 OR ($3::text IS NOT NULL AND source_url=$3)) LIMIT 1`,
      [input.workspaceId, input.title, input.sourceUrl ?? null],
    );
    let documentId: string;
    let version: number;
    if (exist.rows[0]) {
      documentId = String(exist.rows[0].id);
      version = Number(exist.rows[0].version) + 1;
      await client.query(
        `UPDATE kb_documents SET collection_id=$3, source_kind=$4, source_url=$5, content_md=$6, version=$7, hash=$8
         WHERE workspace_id=$1 AND id=$2`,
        [input.workspaceId, documentId, input.collectionId, input.sourceKind, input.sourceUrl ?? null, input.contentMd, version, hash],
      );
    } else {
      documentId = newId("kbd");
      version = 1;
      await client.query(
        `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, content_md, hash, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_review')`,
        [documentId, input.workspaceId, input.collectionId, input.title, input.sourceKind, input.sourceUrl ?? null, input.contentMd, hash],
      );
    }
    const chunks = await indexChunks(
      client as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
      input.workspaceId, documentId, input.contentMd,
    );
    return { documentId, version, chunks };
  });
}

export async function listDocuments(input: { workspaceId: string; collectionId?: string }): Promise<KbDocument[]> {
  await ensureServiceSchema();
  const rows = await svcQuery(
    input.workspaceId,
    `SELECT * FROM kb_documents WHERE workspace_id=$1 AND ($2::text IS NULL OR collection_id=$2) ORDER BY created_at DESC`,
    [input.workspaceId, input.collectionId ?? null],
  );
  return rows.map(documentOf);
}

export async function setDocumentStatus(input: { workspaceId: string; documentId: string; status: string }): Promise<void> {
  await ensureServiceSchema();
  await svcQuery(
    input.workspaceId,
    `UPDATE kb_documents SET status=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [input.workspaceId, input.documentId, input.status],
  );
}

export async function registerSiteSource(input: { workspaceId: string; url: string }): Promise<{ sourceId: string }> {
  await ensureServiceSchema();
  await svcQuery(
    input.workspaceId,
    `INSERT INTO kb_site_sources (id, workspace_id, url) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, url) DO NOTHING RETURNING id`,
    [newId("kbs"), input.workspaceId, input.url],
  );
  const rows = await svcQuery(input.workspaceId, `SELECT id FROM kb_site_sources WHERE workspace_id=$1 AND url=$2`, [input.workspaceId, input.url]);
  return { sourceId: String(rows[0]!.id) };
}

/** HTML → 纯文本（演示级去标签） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);
  return htmlToText(await res.text());
}

async function defaultCollection(workspaceId: string): Promise<string> {
  const rows = await svcQuery(workspaceId, `SELECT id FROM kb_collections WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [workspaceId]);
  if (rows[0]) return String(rows[0].id);
  const c = await createCollection({ workspaceId, name: "默认知识库" });
  return c.id;
}

/** 抓取并结构化：LLM 在场 → 提炼 FAQ；否则降级直存原文（degraded:true）。文档进 pending_review 待审批生效。 */
export async function crawlAndStructure(input: {
  workspaceId: string; sourceId: string; llm?: LlmCall;
}): Promise<{ documentId: string; entryCount: number; degraded?: boolean }> {
  await ensureServiceSchema();
  const src = await svcQuery(input.workspaceId, `SELECT * FROM kb_site_sources WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.sourceId]);
  const source = src[0];
  if (!source) throw new Error(`站点源不存在：${input.sourceId}`);
  const url = String(source.url);
  const text = await fetchPage(url);
  const hash = createHash("sha256").update(text).digest("hex");

  let md: string;
  let degraded = false;
  if (input.llm) {
    try {
      md = await input.llm(
        `把以下网页内容结构化为住客服务 FAQ（Markdown，二级标题为问题，正文为答案，不要编造原文没有的信息）：\n\n${text.slice(0, 6000)}`,
      );
    } catch {
      md = `# ${url}\n\n${text.slice(0, 8000)}`;
      degraded = true;
    }
  } else {
    md = `# ${url}\n\n${text.slice(0, 8000)}`;
    degraded = true;
  }
  const up = await upsertDocument({
    workspaceId: input.workspaceId,
    collectionId: await defaultCollection(input.workspaceId),
    title: `站点抓取 ${url}`,
    sourceKind: "official_site",
    sourceUrl: url,
    contentMd: md,
  });
  await svcQuery(
    input.workspaceId,
    `UPDATE kb_site_sources SET document_id=$3, last_hash=$4 WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [input.workspaceId, input.sourceId, up.documentId, hash],
  );
  return { documentId: up.documentId, entryCount: up.chunks, degraded };
}

/** 定时复扫：内容哈希变化 → 生成新版本文档（pending_review），返回 changed/newDocumentId */
export async function diffScan(input: { workspaceId: string; sourceId: string }): Promise<{ changed: boolean; newDocumentId?: string }> {
  await ensureServiceSchema();
  const src = await svcQuery(input.workspaceId, `SELECT * FROM kb_site_sources WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.sourceId]);
  const source = src[0];
  if (!source) throw new Error(`站点源不存在：${input.sourceId}`);
  const text = await fetchPage(String(source.url));
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash === (source.last_hash as string | null)) return { changed: false };
  const up = await upsertDocument({
    workspaceId: input.workspaceId,
    collectionId: await defaultCollection(input.workspaceId),
    title: `站点抓取 ${String(source.url)}`,
    sourceKind: "official_site",
    sourceUrl: String(source.url),
    contentMd: `# ${String(source.url)}\n\n${text.slice(0, 8000)}`,
  });
  await svcQuery(
    input.workspaceId,
    `UPDATE kb_site_sources SET document_id=$3, last_hash=$4 WHERE workspace_id=$1 AND id=$2 RETURNING id`,
    [input.workspaceId, input.sourceId, up.documentId, hash],
  );
  return { changed: true, newDocumentId: up.documentId };
}

/** 查询切词：英文数字按词，CJK 连续段切二字元（演示级确定性检索） */
function termsOf(query: string): string[] {
  const terms = new Set<string>();
  for (const m of query.toLowerCase().matchAll(/[a-z0-9]+/g)) terms.add(m[0]);
  for (const m of query.matchAll(/[一-鿿]+/g)) {
    const s = m[0];
    if (s.length <= 2) terms.add(s);
    for (let i = 0; i < s.length - 1; i++) terms.add(s.slice(i, i + 2));
  }
  return [...terms].filter((t) => t.length > 0);
}

function scoreOf(terms: string[], heading: string, content: string): number {
  let score = 0;
  const h = heading.toLowerCase();
  const c = content.toLowerCase();
  for (const t of terms) {
    if (h.includes(t)) score += 3;
    if (c.includes(t)) score += 1;
  }
  return score;
}

export async function searchKB(input: { workspaceId: string; query: string; limit?: number }): Promise<KbHit[]> {
  await ensureServiceSchema();
  const terms = termsOf(input.query);
  if (terms.length === 0) return [];
  const rows = await svcQuery<{ document_id: string; heading: string; content: string; title: string }>(
    input.workspaceId,
    `SELECT ch.document_id, ch.heading, ch.content, d.title
     FROM kb_chunks ch JOIN kb_documents d ON d.id = ch.document_id AND d.workspace_id = ch.workspace_id
     WHERE ch.workspace_id=$1 AND d.status='active'`,
    [input.workspaceId],
  );
  return rows
    .map((x) => ({
      content: x.content, heading: x.heading, documentTitle: x.title, documentId: x.document_id,
      score: scoreOf(terms, x.heading, x.content),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 5);
}
