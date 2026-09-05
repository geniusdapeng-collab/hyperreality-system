/**
 * service-kb 单测（内存假库隔离 pg，不依赖真实数据库）
 * 覆盖：Markdown 切块与标题路径 / 文档版本链与 hash 幂等 / 抓取结构化降级 / diffScan / searchKB 兜底
 */
import { describe, expect, it } from "vitest";
import { chunkMarkdown, hashContent, MAX_CHUNK_CHARS } from "./chunk.js";
import { scoreChunkFallback, searchKB, tokenizeQuery } from "./search.js";
import { htmlToText, crawlAndStructure, diffScan, registerSiteSource, type StructuringLlm } from "./sources.js";
import { createCollection, listDocuments, setDocumentStatus, upsertDocument, type KbDocument } from "./kb.js";
import { FakeDb, nextSerial } from "../testing/fake-pg.js";

/* ---------- 假库 handler：只模拟 kb 链路真实发出的 SQL ---------- */

function wireKbDb(db: FakeDb): FakeDb {
  db.on(/^INSERT INTO kb_collections/, (p, d) => {
    const row = { id: p[0], workspace_id: p[1], name: p[2], description: p[3], status: "active", created_at: new Date().toISOString() };
    d.table("kb_collections").push(row);
    return { rows: [row] };
  });
  db.on(/^SELECT \* FROM kb_documents WHERE workspace_id=\$1 AND hash=\$2/, (p, d) => ({
    rows: d.table("kb_documents")
      .filter((r) => r["workspace_id"] === p[0] && r["hash"] === p[1])
      .sort((a, b) => Number(b["version"]) - Number(a["version"])).slice(0, 1),
  }));
  db.on(/^SELECT MAX\(version\) AS v FROM kb_documents/, (p, d) => {
    const vs = d.table("kb_documents")
      .filter((r) => r["workspace_id"] === p[0] && r["collection_id"] === p[1] && r["title"] === p[2])
      .map((r) => Number(r["version"]));
    return { rows: [{ v: vs.length ? Math.max(...vs) : null }] };
  });
  db.on(/^INSERT INTO kb_documents/, (p, d) => {
    const row: KbDocument = {
      id: p[0] as string, workspace_id: p[1] as string, collection_id: p[2] as string,
      title: p[3] as string, source_kind: p[4] as KbDocument["source_kind"],
      source_url: p[5] as string | null, version: p[6] as number,
      status: p[7] as KbDocument["status"], content_md: p[8] as string,
      hash: p[9] as string, created_at: new Date().toISOString(),
    };
    d.table("kb_documents").push(row as unknown as Record<string, unknown>);
    return { rows: [row as unknown as Record<string, unknown>] };
  });
  db.on(/^INSERT INTO kb_chunks/, (p, d) => {
    const t = d.table("kb_chunks");
    const exist = t.findIndex((r) => r["document_id"] === p[1] && r["chunk_index"] === p[2]);
    const row = {
      id: exist >= 0 ? t[exist]!["id"] : nextSerial(d, "kb_chunks"),
      workspace_id: p[0], document_id: p[1], chunk_index: p[2],
      heading: p[3], content: p[4], embedding: p[5], keywords: p[4],
    };
    if (exist >= 0) t[exist] = row; else t.push(row);
    return { rows: [] };
  });
  db.on(/^SELECT \* FROM kb_documents WHERE workspace_id = \$1/, (p, d) => {
    let rows = d.table("kb_documents").filter((r) => r["workspace_id"] === p[0]);
    let idx = 1;
    if (p.length >= 2 && typeof p[1] === "string" && String(p[1]).startsWith("KBC")) {
      rows = rows.filter((r) => r["collection_id"] === p[1]); idx = 2;
    }
    if (p.length > idx && typeof p[idx] === "string" && ["active", "disabled", "pending_review"].includes(String(p[idx]))) {
      rows = rows.filter((r) => r["status"] === p[idx]);
    }
    return { rows };
  });
  // H8：新版本落库前同 (collection_id,title) 旧 active 版置 disabled
  db.on(/^UPDATE kb_documents SET status='disabled'/, (p, d) => {
    const hit = d.table("kb_documents").filter((r) =>
      r["workspace_id"] === p[0] && r["collection_id"] === p[1] && r["title"] === p[2] && r["status"] === "active");
    for (const row of hit) row["status"] = "disabled";
    return { rows: hit };
  });
  db.on(/^UPDATE kb_documents SET status=\$3/, (p, d) => {
    const row = d.table("kb_documents").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (!row) return { rows: [] };
    row["status"] = p[2];
    return { rows: [row] };
  });
  db.on(/^INSERT INTO kb_sources/, (p, d) => {
    const t = d.table("kb_sources");
    const exist = t.find((r) => r["workspace_id"] === p[1] && r["url"] === p[2]);
    if (exist) { exist["schedule_cron"] = p[3]; exist["status"] = "active"; return { rows: [exist] }; }
    const row = { id: p[0], workspace_id: p[1], url: p[2], schedule_cron: p[3], fingerprint: null, last_crawled_at: null, status: "active" };
    t.push(row);
    return { rows: [row] };
  });
  db.on(/^SELECT \* FROM kb_sources WHERE id=\$1/, (p, d) => ({
    rows: d.table("kb_sources").filter((r) => r["id"] === p[0] && r["workspace_id"] === p[1]),
  }));
  db.on(/^UPDATE kb_sources SET fingerprint=\$3/, (p, d) => {
    const row = d.table("kb_sources").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (row) { row["fingerprint"] = p[2]; row["last_crawled_at"] = new Date().toISOString(); }
    return { rows: row ? [row] : [] };
  });
  db.on(/^UPDATE kb_sources SET last_crawled_at=now\(\)/, (p, d) => {
    const row = d.table("kb_sources").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (row) row["last_crawled_at"] = new Date().toISOString();
    return { rows: row ? [row] : [] };
  });
  // searchKB 关键词兜底候选召回（宽进：任一词命中即候选）
  db.on(/^SELECT c\.content, c\.heading, c\.document_id, d\.title AS document_title/, (p, d) => {
    const tokens = p.slice(2, -1).map(String);
    const activeDocs = new Set(d.table("kb_documents").filter((r) => r["status"] === "active").map((r) => r["id"]));
    const rows = d.table("kb_chunks")
      .filter((r) => r["workspace_id"] === p[0] && activeDocs.has(r["document_id"]))
      .filter((r) => tokens.some((t) => String(r["content"]).toLowerCase().includes(t.toLowerCase())))
      .map((r) => ({
        content: r["content"], heading: r["heading"], document_id: r["document_id"],
        document_title: (d.table("kb_documents").find((x) => x["id"] === r["document_id"])?.["title"] ?? ""),
      }));
    return { rows };
  });
  return db;
}

const WS = "ws-test";

async function seedCollection(db: FakeDb): Promise<string> {
  const c = await createCollection(db, { workspaceId: WS, name: "客服知识" });
  return c.id;
}

/* ================= 切块（纯函数） ================= */

describe("Markdown 语义切块", () => {
  it("按标题层级切分并保留标题路径", () => {
    const md = [
      "# 服务政策", "", "## 退换时间", "", "标准退换时限为签收后 7 天，特殊可延至 15 天。", "",
      "## 会员", "", "会员积分消费 1 元计 1 分，自动到账。", "",
      "# 设施", "", "## 门店", "", "门店 9:00-21:00 营业，凭会员码进入。",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain("服务政策 / 退换时间");
    expect(headings).toContain("服务政策 / 会员");
    expect(headings).toContain("设施 / 门店");
    const checkout = chunks.find((c) => c.heading.includes("退换时间"))!;
    expect(checkout.content).toContain("7 天");
    // chunkIndex 连续
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it("超长章节按段落边界二次切分，不截断段落", () => {
    const paras = Array.from({ length: 8 }, (_, i) => `第${i}段`.repeat(40));
    const md = `# 长章节\n\n${paras.join("\n\n")}`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS + 20);
    // 段落完整性：每块由完整段落组成
    for (const c of chunks) expect(paras.some((p) => c.content.includes(p.slice(0, 20)))).toBe(true);
  });

  it("hashContent 确定性（同文同指纹）", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});

/* ================= 文档版本链与幂等 ================= */

describe("upsertDocument 版本链 + hash 幂等", () => {
  it("同标题新版本 version+1 并存；同 hash 幂等返回不建版", async () => {
    const db = wireKbDb(new FakeDb());
    const collId = await seedCollection(db);
    const base = { workspaceId: WS, collectionId: collId, title: "退换政策", sourceKind: "manual" as const };

    const v1 = await upsertDocument(db, { ...base, contentMd: "## 退换\n\n7 天退换。" });
    expect(v1.document.version).toBe(1);
    expect(v1.firstVersion).toBe(true);
    expect(v1.chunks.length).toBeGreaterThan(0);

    const v2 = await upsertDocument(db, { ...base, contentMd: "## 退换\n\n15 天退换（新政策）。" });
    expect(v2.document.version).toBe(2);
    expect(v2.firstVersion).toBe(false);

    // H8：旧版同标题 active → disabled（版本链唯一 active）
    const v1Row = db.table("kb_documents").find((r) => r["id"] === v1.document.id)!;
    expect(v1Row["status"]).toBe("disabled");
    expect(v2.document.status).toBe("active");

    // 同内容再 upsert → 幂等
    const dup = await upsertDocument(db, { ...base, contentMd: "## 退换\n\n15 天退换（新政策）。" });
    expect(dup.deduped).toBe(true);
    expect(dup.document.id).toBe(v2.document.id);

    // 三版并存可列
    const docs = await listDocuments(db, { workspaceId: WS, collectionId: collId });
    expect(docs.length).toBe(2);
  });

  it("setDocumentStatus 状态流转", async () => {
    const db = wireKbDb(new FakeDb());
    const collId = await seedCollection(db);
    const up = await upsertDocument(db, {
      workspaceId: WS, collectionId: collId, title: "t", sourceKind: "manual",
      contentMd: "## a\n\n内容内容内容内容内容内容。", status: "pending_review",
    });
    const act = await setDocumentStatus(db, { workspaceId: WS, documentId: up.document.id, status: "active" });
    expect(act.status).toBe("active");
    await expect(setDocumentStatus(db, { workspaceId: WS, documentId: "none", status: "active" }))
      .rejects.toThrow(/不存在/);
  });
});

/* ================= 抓取结构化与 diffScan ================= */

const PAGE_V1 = "<html><body><h1>示例门店</h1><p>营业 9:00-21:00。</p><p>退换时限 7 天。</p></body></html>";
const PAGE_V2 = PAGE_V2_HTML();
function PAGE_V2_HTML(): string {
  return "<html><body><h1>示例门店</h1><p>营业 8:30-21:30。</p><p>退换时限 7 天。</p><p>新增：会员日双倍积分。</p></body></html>";
}

describe("crawlAndStructure / diffScan", () => {
  it("htmlToText 清洗标签", () => {
    const text = htmlToText("<p>营业 <b>9:00</b></p><script>var x=1;</script>");
    expect(text).toContain("营业 9:00");
    expect(text).not.toContain("script");
  });

  it("无 LLM 走可读文本兜底并标注 degraded:true，文档 pending_review", async () => {
    const db = wireKbDb(new FakeDb());
    const collId = await seedCollection(db);
    const src = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example.com/faq" });
    const r = await crawlAndStructure(db, { workspaceId: WS, sourceId: src.id, collectionId: collId },
      undefined, async () => PAGE_V1);
    expect(r.degraded).toBe(true);
    expect(r.document.status).toBe("pending_review");
    expect(r.items).toBeGreaterThan(0);
    expect(r.source.fingerprint).toBe(hashContent(htmlToText(PAGE_V1)));
  });

  it("有 LLM 结构化抽取为条目化知识", async () => {
    const db = wireKbDb(new FakeDb());
    const collId = await seedCollection(db);
    const src = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example.com/faq" });
    const llm: StructuringLlm = {
      async extractKnowledge() {
        return [{ title: "营业时间", content: "9:00-21:00" }, { title: "退换时间", content: "签收后 7 天" }];
      },
    };
    const r = await crawlAndStructure(db, { workspaceId: WS, sourceId: src.id, collectionId: collId },
      llm, async () => PAGE_V1);
    expect(r.degraded).toBe(false);
    expect(r.items).toBe(2);
    expect(r.document.content_md).toContain("## 营业时间");
  });

  it("diffScan：指纹未变不建版；变化生成 pending_review 新版本 + diff 摘要", async () => {
    const db = wireKbDb(new FakeDb());
    const collId = await seedCollection(db);
    const src = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example.com/faq" });
    let page = PAGE_V1;
    const fetcher = async () => page;
    await crawlAndStructure(db, { workspaceId: WS, sourceId: src.id, collectionId: collId }, undefined, fetcher);

    const same = await diffScan(db, { workspaceId: WS, sourceId: src.id, collectionId: collId }, undefined, fetcher);
    expect(same.changed).toBe(false);

    page = PAGE_V2;
    const changed = await diffScan(db, { workspaceId: WS, sourceId: src.id, collectionId: collId }, undefined, fetcher);
    expect(changed.changed).toBe(true);
    expect(changed.document!.version).toBe(2);
    expect(changed.document!.status).toBe("pending_review");
    expect(changed.diffSummary).toContain("内容变化");
  });
});

/* ================= searchKB 关键词兜底 ================= */

describe("searchKB 混合检索（无 embedder 走关键词兜底）", () => {
  it("兜底检索命中并按 score 排序；degraded=true", async () => {
    const db = wireKbDb(new FakeDb());
    const collId = await seedCollection(db);
    await upsertDocument(db, {
      workspaceId: WS, collectionId: collId, title: "服务政策", sourceKind: "manual",
      contentMd: "## 退换时间\n\n标准退换时限为签收后 7 天，特殊可到 15 天。\n\n## 会员\n\n会员积分 1 元 1 分。",
    });
    const r = await searchKB(db, "退换时限多久", { workspaceId: WS, limit: 5 });
    expect(r.degraded).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.heading).toContain("退换时间");
    expect(r.hits[0]!.documentTitle).toBe("服务政策");
    expect(r.hits[0]!.score).toBeGreaterThanOrEqual(r.hits[r.hits.length - 1]!.score);
    expect(r.hits[0]!.score).toBeLessThanOrEqual(1);
  });

  it("scoreChunkFallback：标题命中加权 > 仅内容命中 > 不命中", () => {
    const q = "退换时间";
    const inHeading = scoreChunkFallback(q, { heading: "服务政策 / 退换时间", content: "详见正文说明。" });
    const inContent = scoreChunkFallback(q, { heading: "服务政策", content: "本店退换时限为签收后七天。" });
    const miss = scoreChunkFallback(q, { heading: "门店", content: "9 点营业。" });
    expect(inHeading).toBeGreaterThan(inContent);
    expect(inContent).toBeGreaterThan(0);
    expect(miss).toBe(0);
  });

  it("tokenizeQuery 中英混排分词", () => {
    const t = tokenizeQuery("wifi 密码是什么");
    expect(t).toContain("wifi");
    expect(t.some((x) => x.includes("密码"))).toBe(true);
  });
});
