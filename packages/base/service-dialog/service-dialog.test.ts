/**
 * service-dialog 单测（内存假库 + 注入式 emitter/search/llm）
 * 覆盖：意图路由规则与兜底 / 置信度三档分流（高置信直答、中置信提示、低置信拒答+建单草稿）/
 *      complaint/service_request 建单草稿 / biz_query 工具契约 / 落消息 + 事件留痕 / 无 LLM mock 标注
 */
import { describe, expect, it } from "vitest";
import { routeIntent, type IntentLlm } from "./intents.js";
import {
  bizToolFor,
  classifyConfidence,
  handleMessage,
  ticketKindForServiceRequest,
  type DialogDeps,
  type ServiceEventDraft,
  type SearchFn,
} from "./dialog.js";
import { FakeDb, nextSerial } from "../testing/fake-pg.js";
import type { KbSearchHit } from "../service-kb/search.js";

/* ---------- 假库 handler：dialog 链路 ---------- */
function wireDialogDb(db: FakeDb): FakeDb {
  db.on(/^SELECT id FROM c_conversations WHERE id=\$1/, (p, d) => ({
    rows: d.table("c_conversations").filter((r) => r["id"] === p[0] && r["workspace_id"] === p[1])
      .map((r) => ({ id: r["id"] })),
  }));
  db.on(/^INSERT INTO c_conversations/, (p, d) => {
    const row = { id: p[0], workspace_id: p[1], c_user_id: p[2], channel: p[3], status: "open", created_at: new Date().toISOString() };
    d.table("c_conversations").push(row);
    return { rows: [{ id: p[0] }] };
  });
  db.on(/^INSERT INTO c_messages/, (p, d) => {
    const id = nextSerial(d, "c_messages");
    // 用户消息 3 参（ws, conv, content）；助手消息 7 参（ws, conv, content, intent, confidence, citations, latency）
    const isAssistant = p.length > 3;
    const row = {
      id, workspace_id: p[0], conversation_id: p[1],
      role: isAssistant ? "assistant" : "user",
      content: p[2],
      intent: isAssistant ? p[3] : null,
      confidence: isAssistant ? p[4] : null,
      citations: isAssistant ? p[5] : "[]",
      latency_ms: isAssistant ? p[6] : null,
      created_at: new Date().toISOString(),
    };
    d.table("c_messages").push(row);
    return { rows: [{ id }] };
  });
  db.on(/^UPDATE c_conversations SET last_message_at=now\(\)/, (p, d) => {
    const row = d.table("c_conversations").find((r) => r["id"] === p[0]);
    if (row) row["last_message_at"] = new Date().toISOString();
    return { rows: [] };
  });
  return db;
}

function makeDeps(over: Partial<DialogDeps> = {}): { deps: DialogDeps; db: FakeDb; events: ServiceEventDraft[] } {
  const db = wireDialogDb(new FakeDb());
  const events: ServiceEventDraft[] = [];
  const deps: DialogDeps = {
    db,
    emit: async (_ctx, draft) => { events.push(draft); return { eventId: `E-${events.length}` }; },
    ...over,
  };
  return { deps, db, events };
}

const INPUT = { workspaceId: "ws-test", tenantId: "tenant-demo", cUserId: "cu-1", channel: "wechat-mini" };

const hit = (score: number): KbSearchHit => ({
  content: "标准营业时间为每日 9:00 至 21:00。",
  heading: "服务政策 / 营业时间",
  documentTitle: "服务政策",
  documentId: "doc-1",
  score,
});

/* ================= 意图路由 ================= */

describe("routeIntent 规则先行 + LLM 兜底", () => {
  it("关键词命中各意图（投诉>服务>业务>问答优先级）", async () => {
    expect((await routeIntent("我要投诉现场太吵")).intent).toBe("complaint");
    expect((await routeIntent("帮我送两瓶水")).intent).toBe("service_request");
    expect((await routeIntent("查一下我的订单")).intent).toBe("biz_query");
    expect((await routeIntent("营业几点开始")).intent).toBe("kb_qa");
    // 投诉优先于服务请求（「送」+「投诉」同时出现落投诉）
    expect((await routeIntent("送错东西了我要投诉")).intent).toBe("complaint");
  });

  it("规则未命中 → LLM 兜底；无 LLM → chat + degraded", async () => {
    const llm: IntentLlm = { async classify() { return "kb_qa"; } };
    const withLlm = await routeIntent("那个啥咋弄", llm);
    expect(withLlm).toMatchObject({ intent: "kb_qa", source: "llm", degraded: false });
    const noLlm = await routeIntent("今天天气不错");
    expect(noLlm).toMatchObject({ intent: "chat", source: "fallback", degraded: true });
  });

  it("M8 典型句：complaint>biz_query>service_request>kb_qa；疑问句优先 kb_qa；报修词直连建单", async () => {
    const cases: Array<[string, string]> = [
      ["我要投诉隔壁太吵", "complaint"],           // 投诉最高优先
      ["查一下我的订单", "biz_query"],              // 业务查询先于服务请求
      ["我的会员积分还有多少", "biz_query"],        // 会员/积分 → 业务查询
      ["配送车辆几点发车", "kb_qa"],               // 含服务词「送」但疑问句 → kb_qa 不建单
      ["营业几点开始？收费吗", "kb_qa"],           // 疑问句（几点/吗）→ kb_qa
      ["Wi-Fi 密码是多少呢", "kb_qa"],             // 疑问词「呢」→ kb_qa
      ["设备坏了，帮我修一下", "service_request"],  // 坏了/修一下 直连建单（不被疑问拦截）
      ["帮我送两瓶水", "service_request"],          // 指令型服务词 → 建单
    ];
    for (const [text, intent] of cases) {
      expect((await routeIntent(text)).intent, `「${text}」应为 ${intent}`).toBe(intent);
    }
  });
});

/* ================= 置信度三档 ================= */

describe("置信度三档分流", () => {
  it("classifyConfidence 阈值边界", () => {
    expect(classifyConfidence(0.72)).toBe("high");
    expect(classifyConfidence(0.9)).toBe("high");
    expect(classifyConfidence(0.5)).toBe("medium");
    expect(classifyConfidence(0.71)).toBe("medium");
    expect(classifyConfidence(0.49)).toBe("low");
    expect(classifyConfidence(undefined)).toBe("low");
  });

  it("高置信（≥0.72）直答且 citations 非空", async () => {
    const search: SearchFn = async () => [hit(0.85)];
    const { deps, db, events } = makeDeps({ search });
    const r = await handleMessage(deps, { ...INPUT, text: "营业时间是几点" });
    expect(r.intent).toBe("kb_qa");
    expect(r.tier).toBe("high");
    expect(r.answer).toContain("9:00");
    expect(r.answer).not.toContain("可能不完全准确");
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.citations[0]!.documentId).toBe("doc-1");
    // 用户+助手两条消息落库，助手消息带 citations
    const msgs = db.table("c_messages");
    expect(msgs.length).toBe(2);
    expect(JSON.parse(String(msgs[1]!["citations"]))).toHaveLength(1);
    // 五元事件留痕
    expect(events[0]!.action).toBe("service.message.handle");
  });

  it("中置信（0.5–0.72）附「可能不完全准确」提示且仍带引用", async () => {
    const search: SearchFn = async () => [hit(0.6)];
    const { deps } = makeDeps({ search });
    const r = await handleMessage(deps, { ...INPUT, text: "营业时间是几点" });
    expect(r.tier).toBe("medium");
    expect(r.answer).toContain("可能不完全准确");
    expect(r.citations.length).toBeGreaterThan(0);
  });

  it("低置信（<0.5）诚实拒答 + ticketDraft 自动建单草稿；无据不答", async () => {
    const search: SearchFn = async () => [hit(0.3)];
    const { deps } = makeDeps({ search });
    const r = await handleMessage(deps, { ...INPUT, text: "附近网点几点营业" });
    expect(r.tier).toBe("low");
    expect(r.answer).toContain("无法准确回答");
    expect(r.citations).toEqual([]);
    expect(r.ticketDraft).toMatchObject({ kind: "other" });
  });

  it("检索零命中同样拒答 + 建单草稿", async () => {
    const search: SearchFn = async () => [];
    const { deps } = makeDeps({ search });
    const r = await handleMessage(deps, { ...INPUT, text: "网点营业吗" });
    expect(r.answer).toContain("无法准确回答");
    expect(r.ticketDraft).toBeDefined();
  });
});

/* ================= 工单草稿与工具契约 ================= */

describe("complaint / service_request / biz_query 分支", () => {
  it("complaint → complaint 建单草稿（priority high）", async () => {
    const { deps } = makeDeps();
    const r = await handleMessage(deps, { ...INPUT, text: "我要投诉，现场太吵了" });
    expect(r.intent).toBe("complaint");
    expect(r.ticketDraft).toMatchObject({ kind: "complaint", priority: "high" });
    expect(r.answer).toContain("抱歉");
  });

  it("service_request → 按内容映射 delivery/repair 工单类型", async () => {
    expect(ticketKindForServiceRequest("帮我送两瓶水")).toBe("delivery");
    expect(ticketKindForServiceRequest("设备坏了来修一下")).toBe("repair");
    expect(ticketKindForServiceRequest("开发票")).toBe("other");
    const { deps } = makeDeps();
    const r = await handleMessage(deps, { ...INPUT, text: "帮我送两瓶水" });
    expect(r.ticketDraft).toMatchObject({ kind: "delivery" });
  });

  it("biz_query → 返回工具调用描述（dialog 不碰业务数据）", async () => {
    expect(bizToolFor("我的订单", "cu-1").tool).toBe("biz.query_orders");
    expect(bizToolFor("费用账单", "cu-1").tool).toBe("biz.query_bill");
    expect(bizToolFor("积分余额", "cu-1").tool).toBe("biz.query_member");
    const { deps } = makeDeps();
    const r = await handleMessage(deps, { ...INPUT, text: "查一下我的订单" });
    expect(r.intent).toBe("biz_query");
    expect(r.bizTool).toEqual({ tool: "biz.query_orders", params: { cUserId: "cu-1" } });
  });
});

/* ================= chat 兜底与会话复用 ================= */

describe("chat 兜底与会话", () => {
  it("无 LLM 全链路确定性 mock 应答，标注 mock/degraded", async () => {
    const { deps } = makeDeps();
    const r = await handleMessage(deps, { ...INPUT, text: "今天心情不错" });
    expect(r.intent).toBe("chat");
    expect(r.mock).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.answer).toContain("[mock]");
  });

  it("复用已存在的 conversationId；不存在的会话拒绝", async () => {
    const { deps, db } = makeDeps();
    const r1 = await handleMessage(deps, { ...INPUT, text: "你好呀" });
    const r2 = await handleMessage(deps, { ...INPUT, text: "接着聊", conversationId: r1.conversationId });
    expect(r2.conversationId).toBe(r1.conversationId);
    expect(db.table("c_conversations").length).toBe(1);
    expect(db.table("c_messages").length).toBe(4);
    await expect(handleMessage(deps, { ...INPUT, text: "x", conversationId: "CCV-none" }))
      .rejects.toThrow(/不存在/);
  });
});
