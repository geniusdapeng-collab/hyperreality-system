/**
 * service-kb · 大规模功能场景套件（A：C 端客服底座 · 知识库）
 * 覆盖：Markdown 切块（标题层级/表格/无标题/超长段落碎块/尾块合并）、版本链（新版激活旧版
 * disabled/同 hash 幂等）、状态机（active/disabled/pending_review 检索可见性）、官网源
 * （注册幂等/抓取降级/diffScan 变更检测/fingerprint）、SSRF 守卫（各私网段/协议白名单/2MB
 * 上限）、检索（2-gram 切词/中英混合/无命中/多命中排序/大小写/特殊字符注入/向量链路降级）。
 * 纪律：仅新增测试，不改源码；DB 走内存 FakeDb（只模拟被测代码真实发出的 SQL）。
 */
import { describe, expect, it } from "vitest";
import { chunkMarkdown, hashContent, MAX_CHUNK_CHARS, MIN_CHUNK_CHARS, parseSections } from "./chunk.js";
import { scoreChunkFallback, searchKB, tokenizeQuery } from "./search.js";
import { crawlAndStructure, diffScan, htmlToText, registerSiteSource, type StructuringLlm } from "./sources.js";
import { createCollection, listDocuments, setDocumentStatus, upsertDocument } from "./kb.js";
import {
  assertPublicHttpUrl, isPrivateAddress, readResponseLimited,
} from "./fetch-guard.js";
import { FakeDb, nextSerial } from "../testing/fake-pg.js";

const WS = "ws-scen-kb";

/* ================= FakeDb 接线（kb / sources / search 链路真实 SQL） ================= */

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
  db.on(/^UPDATE kb_documents SET status='disabled'/, (p, d) => {
    const hit = d.table("kb_documents").filter((r) =>
      r["workspace_id"] === p[0] && r["collection_id"] === p[1] && r["title"] === p[2] && r["status"] === "active");
    for (const row of hit) row["status"] = "disabled";
    return { rows: hit };
  });
  db.on(/^INSERT INTO kb_documents/, (p, d) => {
    const row = {
      id: p[0], workspace_id: p[1], collection_id: p[2], title: p[3], source_kind: p[4],
      source_url: p[5], version: p[6], status: p[7], content_md: p[8], hash: p[9],
      created_at: new Date().toISOString(),
    };
    d.table("kb_documents").push(row);
    return { rows: [row] };
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
  // listDocuments（条件参数：collectionId/status 可选，末位 LIMIT）
  db.on(/^SELECT \* FROM kb_documents WHERE workspace_id = \$1/, (p, d) => {
    let rows = d.table("kb_documents").filter((r) => r["workspace_id"] === p[0]);
    for (const extra of p.slice(1, -1)) {
      if (["active", "disabled", "pending_review"].includes(String(extra))) {
        rows = rows.filter((r) => r["status"] === extra);
      } else {
        rows = rows.filter((r) => r["collection_id"] === extra);
      }
    }
    return { rows: rows.slice(0, Number(p[p.length - 1])) };
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
    const row = {
      id: p[0], workspace_id: p[1], url: p[2], fingerprint: null,
      last_crawled_at: null, schedule_cron: p[3], status: "active",
    };
    t.push(row);
    return { rows: [row] };
  });
  db.on(/^SELECT \* FROM kb_sources WHERE id=\$1 AND workspace_id=\$2/, (p, d) => ({
    rows: d.table("kb_sources").filter((r) => r["id"] === p[0] && r["workspace_id"] === p[1]),
  }));
  db.on(/^UPDATE kb_sources SET fingerprint=\$3, last_crawled_at=now\(\)/, (p, d) => {
    const row = d.table("kb_sources").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (!row) return { rows: [] };
    row["fingerprint"] = p[2];
    row["last_crawled_at"] = new Date().toISOString();
    return { rows: [row] };
  });
  db.on(/^UPDATE kb_sources SET last_crawled_at=now\(\)/, (p, d) => {
    const row = d.table("kb_sources").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (!row) return { rows: [] };
    row["last_crawled_at"] = new Date().toISOString();
    return { rows: [row] };
  });
  // searchKB 向量链路（先注册，含 embedding <=> 特征）
  db.on(/embedding <=> \$1::vector/, (p, d) => {
    const activeIds = new Set(d.table("kb_documents").filter((r) => r["status"] === "active").map((r) => r["id"]));
    const rows = d.table("kb_chunks")
      .filter((r) => r["workspace_id"] === p[1] && r["embedding"] !== null && activeIds.has(r["document_id"]))
      .map((r, i) => ({
        content: r["content"], heading: r["heading"], document_id: r["document_id"],
        document_title: d.table("kb_documents").find((x) => x["id"] === r["document_id"])?.["title"],
        score: 0.9 - i * 0.05,
      }));
    return { rows: rows.slice(0, Number(p[2])) };
  });
  // searchKB 关键词兜底（末位 LIMIT；$2=query；中间为 tokens，ILIKE 语义模拟）
  db.on(/^SELECT c\.content, c\.heading, c\.document_id, d\.title AS document_title FROM kb_chunks/, (p, d) => {
    const tokens = p.slice(2, -1).map((t) => String(t).toLowerCase());
    const activeIds = new Set(d.table("kb_documents").filter((r) => r["status"] === "active").map((r) => r["id"]));
    const rows = d.table("kb_chunks")
      .filter((r) => r["workspace_id"] === p[0] && activeIds.has(r["document_id"]))
      .filter((r) => tokens.some((t) => String(r["content"]).toLowerCase().includes(t)))
      .map((r) => ({
        content: r["content"], heading: r["heading"], document_id: r["document_id"],
        document_title: d.table("kb_documents").find((x) => x["id"] === r["document_id"])?.["title"],
      }));
    return { rows: rows.slice(0, Number(p[p.length - 1])) };
  });
  return db;
}

async function seedCollection(db: FakeDb, name = "客服知识库"): Promise<string> {
  const col = await createCollection(db, { workspaceId: WS, name });
  return col.id;
}

/* ================= A1. Markdown 切块 ================= */

describe("A1 切块 · 标题层级与段落语义", () => {
  it("多级标题生成「 / 」连接的标题路径", () => {
    const md = `# 服务政策\n\n总述内容一段，长度需要超过六十个字符才能独立成块不被合并，继续补充一些文字。\n\n## 退换时间\n\n退换为签收后七天。\n`;
    const chunks = chunkMarkdown(md);
    const checkout = chunks.find((c) => c.heading === "服务政策 / 退换时间");
    expect(checkout).toBeDefined();
    expect(checkout!.content).toContain("退换为签收后七天");
  });

  it("同级标题重置路径（不串层级）", () => {
    const md = `# A\n\n## B\n\n内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一内容一\n\n## C\n\n内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二内容二\n`;
    const paths = parseSections(md).map((s) => s.headingPath.join(" / "));
    expect(paths).toContain("A / B");
    expect(paths).toContain("A / C");
    expect(paths).not.toContain("A / B / C");
  });

  it("无标题文档 → 单块且 heading 为空串", () => {
    const chunks = chunkMarkdown("纯文本一段没有标题的内容，需要足够长以免被当作尾块处理，继续写字。\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("");
  });

  it("表格行作为段落内容原样保留", () => {
    const md = `## 价目表\n\n| 品类 | 价格 |\n| --- | --- |\n| 标准款 | 588 |\n| 豪华款 | 688 |\n`;
    const chunks = chunkMarkdown(md);
    expect(chunks[0]!.content).toContain("| 标准款 | 588 |");
    expect(chunks[0]!.heading).toBe("价目表");
  });

  it("超长段落硬切为 ≤MAX_CHUNK_CHARS 的连续碎块（不丢内容）", () => {
    const para = "云".repeat(MAX_CHUNK_CHARS * 2 + 100);
    const chunks = chunkMarkdown(para);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.map((c) => c.content).join("")).toBe(para);
  });

  it("过短尾块并入同标题前块", () => {
    const long = "长".repeat(MIN_CHUNK_CHARS + 40);
    const md = `## 须知\n\n${long}\n\n短尾\n`;
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("短尾");
  });

  it("空文档 → 0 块", () => {
    expect(chunkMarkdown("\n\n  \n")).toHaveLength(0);
  });

  it("hashContent 稳定且内容敏感", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
    expect(hashContent("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ================= A2. 版本链与状态机（FakeDb） ================= */

describe("A2 版本链 · 激活/幂等/状态可见性", () => {
  it("首版 version=1、firstVersion=true、按章节切块落库", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const r = await upsertDocument(db, {
      workspaceId: WS, collectionId: colId, title: "顾客须知", sourceKind: "upload",
      contentMd: `## 退换\n\n退换时限为签收后七天，超过时间需要客服审核，请知悉并提前安排。\n`,
    });
    expect(r.document.version).toBe(1);
    expect(r.firstVersion).toBe(true);
    expect(r.deduped).toBe(false);
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(db.table("kb_chunks").filter((c) => c["document_id"] === r.document.id).length).toBe(r.chunks.length);
  });

  it("同 hash 重复上传 → 幂等返回（deduped，不建版不重切）", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const md = `## 会员\n\n会员码为手机号后四位，覆盖全部门店与线上商城，免费办理使用。\n`;
    const a = await upsertDocument(db, { workspaceId: WS, collectionId: colId, title: "会员说明", sourceKind: "upload", contentMd: md });
    const b = await upsertDocument(db, { workspaceId: WS, collectionId: colId, title: "会员说明", sourceKind: "upload", contentMd: md });
    expect(b.deduped).toBe(true);
    expect(b.document.id).toBe(a.document.id);
    expect(b.chunks).toHaveLength(0);
    expect(db.table("kb_documents")).toHaveLength(1);
  });

  it("新内容同标题 → version+1 且旧 active 版置 disabled", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const v1 = await upsertDocument(db, {
      workspaceId: WS, collectionId: colId, title: "会员政策", sourceKind: "upload",
      contentMd: `## 会员\n\n会员积分每消费一元计一分自动到账，线上商城与门店通用，内容需要足够长一点。\n`,
    });
    const v2 = await upsertDocument(db, {
      workspaceId: WS, collectionId: colId, title: "会员政策", sourceKind: "upload",
      contentMd: `## 会员\n\n会员积分活动期每消费一元计两分，线上商城与门店通用，内容足够长一点。\n`,
    });
    expect(v2.document.version).toBe(2);
    expect(v2.firstVersion).toBe(false);
    const old = db.table("kb_documents").find((r) => r["id"] === v1.document.id)!;
    expect(old["status"]).toBe("disabled");
    expect(db.table("kb_documents").find((r) => r["id"] === v2.document.id)!["status"]).toBe("active");
  });

  it("pending_review 状态落库可见，setDocumentStatus 可推进 active", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const doc = await upsertDocument(db, {
      workspaceId: WS, collectionId: colId, title: "官网政策", sourceKind: "official_site",
      contentMd: `## 配送\n\n会员免费配送，签收前请与客服确认地址，具体内容需要足够长一些。\n`,
      status: "pending_review",
    });
    const pending = await listDocuments(db, { workspaceId: WS, status: "pending_review" });
    expect(pending.map((d) => d.id)).toContain(doc.document.id);
    const act = await setDocumentStatus(db, { workspaceId: WS, documentId: doc.document.id, status: "active" });
    expect(act.status).toBe("active");
    const actives = await listDocuments(db, { workspaceId: WS, status: "active" });
    expect(actives.map((d) => d.id)).toContain(doc.document.id);
  });

  it("setDocumentStatus 不存在文档 → 抛错", async () => {
    const db = wireKbDb(new FakeDb());
    await expect(setDocumentStatus(db, { workspaceId: WS, documentId: "KBD-none", status: "active" }))
      .rejects.toThrow("不存在");
  });

  it("listDocuments 按集合过滤", async () => {
    const db = wireKbDb(new FakeDb());
    const c1 = await seedCollection(db, "集合一");
    const c2 = await seedCollection(db, "集合二");
    const md = `## 条目\n\n内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容\n`;
    await upsertDocument(db, { workspaceId: WS, collectionId: c1, title: "文档A", sourceKind: "manual", contentMd: md });
    await upsertDocument(db, { workspaceId: WS, collectionId: c2, title: "文档B", sourceKind: "manual", contentMd: md + "异" });
    const only = await listDocuments(db, { workspaceId: WS, collectionId: c1 });
    expect(only).toHaveLength(1);
    expect(only[0]!.title).toBe("文档A");
  });
});

/* ================= A3. 官网源（注册/抓取/diffScan/指纹） ================= */

describe("A3 官网源 · 注册/抓取结构化/diffScan", () => {
  it("registerSiteSource 同 URL 重复注册幂等（返回同一源）", async () => {
    const db = wireKbDb(new FakeDb());
    const a = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example/faq" });
    const b = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example/faq" });
    expect(b.id).toBe(a.id);
    expect(db.table("kb_sources")).toHaveLength(1);
  });

  it("crawlAndStructure 无 LLM → degraded:true + pending_review 文档 + 回写指纹", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const src = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example/faq" });
    const html = `<html><body><p>退换时限为签收后七天。超过时限需客服审核。</p><p>营业九点到二十一点。</p></body></html>`;
    const r = await crawlAndStructure(db, { workspaceId: WS, sourceId: src.id, collectionId: colId }, undefined, async () => html);
    expect(r.degraded).toBe(true);
    expect(r.document.status).toBe("pending_review");
    expect(r.document.source_kind).toBe("official_site");
    expect(r.items).toBeGreaterThan(0);
    expect(r.source.fingerprint).toBe(hashContent(htmlToText(html)));
    expect(r.source.last_crawled_at).toBeTruthy();
  });

  it("crawlAndStructure 有 LLM → 条目化结构 + degraded:false", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const src = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example/policy" });
    const llm: StructuringLlm = {
      async extractKnowledge() {
        return [
          { title: "退换时间", content: "签收后七天内退换。" },
          { title: "营业时间", content: "每日九点到二十一点。" },
        ];
      },
    };
    const r = await crawlAndStructure(db, { workspaceId: WS, sourceId: src.id, collectionId: colId }, llm, async () => "<p>页面</p>");
    expect(r.degraded).toBe(false);
    expect(r.items).toBe(2);
    const docRow = db.table("kb_documents").find((x) => x["id"] === r.document.id)!;
    expect(String(docRow["content_md"])).toContain("## 退换时间");
  });

  it("diffScan 指纹未变 → changed:false 仅回写 last_crawled_at", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const src = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example/same" });
    const html = "<p>内容固定不变的一段页面文本。</p>";
    await crawlAndStructure(db, { workspaceId: WS, sourceId: src.id, collectionId: colId }, undefined, async () => html);
    const before = db.table("kb_documents").length;
    const r = await diffScan(db, { workspaceId: WS, sourceId: src.id, collectionId: colId }, undefined, async () => html);
    expect(r.changed).toBe(false);
    expect(r.document).toBeUndefined();
    expect(db.table("kb_documents")).toHaveLength(before); // 未生成新版本
    expect(r.source.last_crawled_at).toBeTruthy();
  });

  it("diffScan 内容变化 → changed:true + 新版本 pending_review + diffSummary 指纹前后比对", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const src = await registerSiteSource(db, { workspaceId: WS, url: "https://www.example/changing" });
    await crawlAndStructure(db, { workspaceId: WS, sourceId: src.id, collectionId: colId }, undefined, async () => "<p>旧版页面内容。</p>");
    const r = await diffScan(db, { workspaceId: WS, sourceId: src.id, collectionId: colId }, undefined, async () => "<p>新版页面内容，有更新。</p>");
    expect(r.changed).toBe(true);
    expect(r.document).toBeDefined();
    expect(r.document!.status).toBe("pending_review");
    expect(r.diffSummary).toContain("→");
    expect(r.diffSummary).toMatch(/v\d+ 待审稿/);
    // 指纹已更新为新版
    expect(r.source.fingerprint).toBe(hashContent(htmlToText("<p>新版页面内容，有更新。</p>")));
  });

  it("crawlAndStructure 默认抓取器命中内网源 → SSRF 守卫抛错（不发起抓取）", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const src = await registerSiteSource(db, { workspaceId: WS, url: "http://127.0.0.1:9999/internal" });
    await expect(crawlAndStructure(db, { workspaceId: WS, sourceId: src.id, collectionId: colId }))
      .rejects.toThrow(/内网|回环|禁止/);
  });

  it("htmlToText 去 script/style/标签并解码实体", () => {
    const text = htmlToText(`<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><p>Wi-Fi &amp; 会员</p><br><p>第二条</p></body></html>`);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color");
    expect(text).toContain("Wi-Fi & 会员");
    expect(text).toContain("第二条");
  });
});

/* ================= A4. SSRF 守卫（各私网段/协议/上限） ================= */

describe("A4 SSRF 守卫 · assertPublicHttpUrl / isPrivateAddress / 读取上限", () => {
  it("localhost 与 *.localhost / *.local / *.internal 主机名拒绝", async () => {
    await expect(assertPublicHttpUrl("http://localhost/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://a.localhost/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://nas.local/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://svc.internal/x")).rejects.toThrow();
  });

  it("IPv4 私网段全谱拒绝：127/8、10/8、172.16/12、192.168/16、169.254/16、0/8", () => {
    for (const ip of ["127.0.0.1", "127.255.0.1", "10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.1.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("IPv4 公网段放行：172.32 起、8.8.8.8、1.1.1.1", () => {
    for (const ip of ["172.32.0.1", "8.8.8.8", "1.1.1.1", "203.0.113.10"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("IPv6 私网拒绝：::1、::、fe80::/10、fc00::/7、IPv4-mapped 回环", () => {
    for (const ip of ["::1", "::", "fe80::1", "feb0::1", "fc00::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("无法识别的地址一律按私网拒绝（安全默认）", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });

  it("公网 IP 字面量 URL 通过校验并返回规范化 URL", async () => {
    const url = await assertPublicHttpUrl("http://8.8.8.8/path?q=1");
    expect(url.hostname).toBe("8.8.8.8");
  });

  it("非 http/https 协议拒绝（ftp/file/gopher）", async () => {
    await expect(assertPublicHttpUrl("ftp://8.8.8.8/x")).rejects.toThrow(/http/);
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpUrl("gopher://8.8.8.8/")).rejects.toThrow();
  });

  it("非法 URL 直接拒绝", async () => {
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow(/非法抓取 URL/);
  });

  it("readResponseLimited 超限抛错、限内正常读取", async () => {
    await expect(readResponseLimited(new Response("x".repeat(100)), 10)).rejects.toThrow(/上限/);
    const ok = await readResponseLimited(new Response("短内容"), 1024);
    expect(ok).toBe("短内容");
  });
});

/* ================= A5. 检索（切词/打分/混合链路） ================= */

describe("A5 检索 · 2-gram 切词与确定性打分（纯函数）", () => {
  it("中文按 2-gram 切分（防单字噪声）", () => {
    expect(tokenizeQuery("退换时间")).toEqual(["退换", "换时", "时间", "售后"]);
  });

  it("单字中文保留单字", () => {
    expect(tokenizeQuery("猫")).toEqual(["猫"]);
  });

  it("英文数字按词且小写化", () => {
    expect(tokenizeQuery("WiFi PASSWORD123")).toEqual(["wifi", "password123"]);
  });

  it("中英混排：英文按词 + 中文 2-gram（含停用字过滤）", () => {
    const t = tokenizeQuery("WiFi密码是多少");
    expect(t).toContain("wifi");
    expect(t).toContain("密码");
    expect(t).not.toContain("是多"); // 「是」为停用字，疑问 bigram 被过滤（评测校准口径）
    expect(t).not.toContain("多少");
  });

  it("标点与空白剔除", () => {
    expect(tokenizeQuery("退换，时间？！")).toEqual(["退换", "换时", "时间", "售后"]);
    expect(tokenizeQuery("！！！")).toEqual([]);
  });

  it("scoreChunkFallback：无命中 0 分", () => {
    expect(scoreChunkFallback("门店", { heading: "会员", content: "积分每日到账" })).toBe(0);
  });

  it("scoreChunkFallback：命中越多分越高", () => {
    const chunk = { heading: "退换政策", content: "退换时间为签收后七天，超过时间需客服审核" };
    const full = scoreChunkFallback("退换时间", chunk);
    const half = scoreChunkFallback("退换门店", chunk);
    expect(full).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(0);
  });

  it("scoreChunkFallback：标题命中加权", () => {
    const inHead = scoreChunkFallback("退换", { heading: "退换政策", content: "内容无关词" });
    const inBody = scoreChunkFallback("退换", { heading: "其他", content: "退换相关说明" });
    expect(inHead).toBeGreaterThan(inBody);
  });

  it("scoreChunkFallback：封顶 0.98 且空查询 0 分", () => {
    const s = scoreChunkFallback("退换", { heading: "退换", content: "退换 退换 退换" });
    expect(s).toBeLessThanOrEqual(0.98);
    expect(scoreChunkFallback("", { heading: "x", content: "y" })).toBe(0);
  });

  it("scoreChunkFallback：大小写不敏感", () => {
    const a = scoreChunkFallback("wifi", { heading: "", content: "免费 WiFi 覆盖" });
    const b = scoreChunkFallback("WIFI", { heading: "", content: "免费 WiFi 覆盖" });
    expect(a).toBeGreaterThan(0);
    expect(a).toBe(b);
  });
});

describe("A5 检索 · searchKB 混合链路（FakeDb）", () => {
  async function seedSearchable(db: FakeDb) {
    const colId = await seedCollection(db);
    await upsertDocument(db, {
      workspaceId: WS, collectionId: colId, title: "顾客须知", sourceKind: "manual",
      contentMd: [
        `## 退换时间\n\n本店标准退换时间为签收后 7 天内，特殊最晚至 15 天，需客服审核，超过按服务费计。\n`,
        `## 营业时间\n\n门店营业时间为每日 9:00 至 21:00，会员凭会员码入场，线上商城全天可用。\n`,
      ].join("\n"),
    });
    return colId;
  }

  it("无 embedder → 关键词兜底命中且 degraded:true", async () => {
    const db = wireKbDb(new FakeDb());
    await seedSearchable(db);
    const r = await searchKB(db, "退换时间是多久", { workspaceId: WS });
    expect(r.degraded).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.content).toContain("7 天");
    expect(r.hits[0]!.documentTitle).toBe("顾客须知");
  });

  it("无命中 → hits 为空", async () => {
    const db = wireKbDb(new FakeDb());
    await seedSearchable(db);
    const r = await searchKB(db, "量子力学入门", { workspaceId: WS });
    expect(r.hits).toHaveLength(0);
  });

  it("多命中按 score 降序", async () => {
    const db = wireKbDb(new FakeDb());
    await seedSearchable(db);
    const r = await searchKB(db, "时间", { workspaceId: WS, limit: 5 });
    expect(r.hits.length).toBeGreaterThan(1);
    for (let i = 1; i < r.hits.length; i++) expect(r.hits[i]!.score).toBeLessThanOrEqual(r.hits[i - 1]!.score);
  });

  it("特殊字符注入（引号/分号/百分号/注释符）不报错且不影响语义", async () => {
    const db = wireKbDb(new FakeDb());
    await seedSearchable(db);
    const r = await searchKB(db, `退换'; DROP TABLE kb_chunks; -- %`, { workspaceId: WS });
    expect(r.hits.length).toBeGreaterThan(0); // 2-gram「退换」仍命中，注入片段被切词剔除
    expect(db.table("kb_chunks").length).toBeGreaterThan(0);
  });

  it("仅检索 active 文档：disabled 后不再命中", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedSearchable(db);
    const doc = (await listDocuments(db, { workspaceId: WS, collectionId: colId }))[0]!;
    const hitBefore = await searchKB(db, "退换时间", { workspaceId: WS });
    expect(hitBefore.hits.length).toBeGreaterThan(0);
    await setDocumentStatus(db, { workspaceId: WS, documentId: doc.id, status: "disabled" });
    const hitAfter = await searchKB(db, "退换时间", { workspaceId: WS });
    expect(hitAfter.hits).toHaveLength(0);
  });

  it("pending_review 文档检索不可见", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    await upsertDocument(db, {
      workspaceId: WS, collectionId: colId, title: "待审政策", sourceKind: "official_site",
      contentMd: `## 会员中心\n\n会员中心开放时间为每日十点到二十一点，会员免费使用，需要足够的正文长度。\n`,
      status: "pending_review",
    });
    const r = await searchKB(db, "会员中心开放时间", { workspaceId: WS });
    expect(r.hits).toHaveLength(0);
  });

  it("有 embedder 且向量链路有命中 → degraded:false", async () => {
    const db = wireKbDb(new FakeDb());
    const colId = await seedCollection(db);
    const embedder = { async embed() { return [0.1, 0.2, 0.3]; } };
    await upsertDocument(db, {
      workspaceId: WS, collectionId: colId, title: "向量文档", sourceKind: "manual",
      contentMd: `## 门店\n\n门店二十四小时营业，位于三层，刷会员码进入，正文需要足够长度。\n`,
    }, embedder);
    const r = await searchKB(db, "门店营业吗", { workspaceId: WS }, { embedder });
    expect(r.degraded).toBe(false);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.score).toBeGreaterThan(0);
  });

  it("有 embedder 但全库无 embedding → 向量零命中自动降级关键词兜底", async () => {
    const db = wireKbDb(new FakeDb());
    await seedSearchable(db); // 无 embedder 切块 → embedding 为 NULL
    const embedder = { async embed() { return [0.1, 0.2]; } };
    const r = await searchKB(db, "营业几点", { workspaceId: WS }, { embedder });
    expect(r.degraded).toBe(false); // embedder 在场，走兜底但不算 degraded
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.content).toContain("9:00");
  });

  it("limit 截断生效", async () => {
    const db = wireKbDb(new FakeDb());
    await seedSearchable(db);
    const r = await searchKB(db, "时间", { workspaceId: WS, limit: 1 });
    expect(r.hits).toHaveLength(1);
  });
});
