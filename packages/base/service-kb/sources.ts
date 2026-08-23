/**
 * service-kb · 官网抓取源（registerSiteSource / crawlAndStructure / diffScan）
 *
 * 链路：fetch 页面 → 清洗（htmlToText）→ LLM 结构化抽取为条目化知识 {title,content}[]
 *      → 生成 pending_review 文档（人工审稿后才 active，服务台质量闸）。
 * 降级：无 LLM 时用可读文本直接切块兜底，产出标注 degraded:true（禁止静默换链路）。
 * diffScan：重抓 → 指纹对比 → 变化才生成 pending_review 新版本（附 diff 摘要），未变只回写 last_crawled_at。
 */
import { newId } from "@workloom/shared";
import { hashContent } from "./chunk.js";
import { upsertDocument, type KbDocument, type Queryable } from "./kb.js";

export interface KbSource {
  id: string;
  workspace_id: string;
  url: string;
  fingerprint: string | null;
  last_crawled_at: string | null;
  schedule_cron: string;
  status: string;
}

/** 页面抓取 seam（测试注入内存假页面） */
export type Fetcher = (url: string) => Promise<string>;

/** LLM 结构化抽取 seam：页面可读文本 → 条目化知识 */
export interface StructuringLlm {
  extractKnowledge(pageText: string, url: string): Promise<Array<{ title: string; content: string }>>;
}

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}（${url}）`);
  return res.text();
};

/** HTML → 可读文本（去 script/style/标签/实体，纯函数） */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function registerSiteSource(
  db: Queryable,
  input: { workspaceId: string; url: string; scheduleCron?: string },
): Promise<KbSource> {
  const r = await db.query<KbSource>(
    `INSERT INTO kb_sources (id, workspace_id, url, schedule_cron) VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, url) DO UPDATE SET schedule_cron=EXCLUDED.schedule_cron, status='active'
     RETURNING *`,
    [newId("KBS"), input.workspaceId, input.url, input.scheduleCron ?? "0 3 * * *"],
  );
  return r.rows[0]!;
}

/** 条目化知识 → Markdown 文档正文（一级标题=源 URL，二级标题=条目） */
function itemsToMarkdown(items: Array<{ title: string; content: string }>, url: string): string {
  const body = items.map((i) => `## ${i.title}\n\n${i.content}`).join("\n\n");
  return `# 官网知识：${url}\n\n${body}\n`;
}

export interface CrawlResult {
  source: KbSource;
  document: KbDocument;
  items: number;
  /** true = 无 LLM，走可读文本切块兜底（禁止静默降级） */
  degraded: boolean;
}

/** 抓取并结构化（生成 pending_review 文档 + 回写指纹） */
export async function crawlAndStructure(
  db: Queryable,
  input: { workspaceId: string; sourceId: string; collectionId: string; url?: string },
  llm?: StructuringLlm,
  fetcher: Fetcher = defaultFetcher,
): Promise<CrawlResult> {
  const src = await db.query<KbSource>(
    `SELECT * FROM kb_sources WHERE id=$1 AND workspace_id=$2`,
    [input.sourceId, input.workspaceId],
  );
  const source = src.rows[0];
  if (!source) throw new Error(`抓取源 ${input.sourceId} 不存在`);
  const url = input.url ?? source.url;

  const text = htmlToText(await fetcher(url));
  const fingerprint = hashContent(text);

  let degraded = false;
  let items: Array<{ title: string; content: string }>;
  if (llm) {
    items = await llm.extractKnowledge(text, url);
  } else {
    // 无 LLM 兜底：按段落切条目，标注 degraded
    degraded = true;
    items = text.split(/\n{2,}/).filter((p) => p.trim().length > 0)
      .map((p, i) => ({ title: `片段 ${i + 1}`, content: p.trim() }));
  }
  const title = `官网抓取 ${url}`;
  const up = await upsertDocument(db, {
    workspaceId: input.workspaceId,
    collectionId: input.collectionId,
    title,
    sourceKind: "official_site",
    sourceUrl: url,
    contentMd: itemsToMarkdown(items, url),
    status: "pending_review",
  });

  const updated = await db.query<KbSource>(
    `UPDATE kb_sources SET fingerprint=$3, last_crawled_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [input.sourceId, input.workspaceId, fingerprint],
  );
  return { source: updated.rows[0] ?? source, document: up.document, items: items.length, degraded };
}

export interface DiffScanResult {
  changed: boolean;
  source: KbSource;
  /** 变化时生成的新版本文档（pending_review） */
  document?: KbDocument;
  /** diff 摘要（变化条目计数 + 指纹前后比对） */
  diffSummary?: string;
  degraded: boolean;
}

/** 定时重抓：指纹对比，变化 → 生成 pending_review 新版本（附 diff 摘要） */
export async function diffScan(
  db: Queryable,
  input: { workspaceId: string; sourceId: string; collectionId: string },
  llm?: StructuringLlm,
  fetcher: Fetcher = defaultFetcher,
): Promise<DiffScanResult> {
  const src = await db.query<KbSource>(
    `SELECT * FROM kb_sources WHERE id=$1 AND workspace_id=$2`,
    [input.sourceId, input.workspaceId],
  );
  const source = src.rows[0];
  if (!source) throw new Error(`抓取源 ${input.sourceId} 不存在`);

  const text = htmlToText(await fetcher(source.url));
  const fingerprint = hashContent(text);

  if (source.fingerprint === fingerprint) {
    const touched = await db.query<KbSource>(
      `UPDATE kb_sources SET last_crawled_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *`,
      [input.sourceId, input.workspaceId],
    );
    return { changed: false, source: touched.rows[0] ?? source, degraded: false };
  }

  const before = source.fingerprint ?? "(none)";
  const r = await crawlAndStructure(db, {
    workspaceId: input.workspaceId, sourceId: input.sourceId, collectionId: input.collectionId,
  }, llm, async () => text); // 复用已抓文本，避免二次抓取
  return {
    changed: true,
    source: r.source,
    document: r.document,
    diffSummary: `内容变化：指纹 ${before.slice(0, 12)} → ${fingerprint.slice(0, 12)}，结构化条目 ${r.items} 条，已生成 v${r.document.version} 待审稿`,
    degraded: r.degraded,
  };
}
