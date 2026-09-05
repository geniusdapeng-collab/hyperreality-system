/**
 * service-dialog · 大规模功能场景套件（B：C 端问答对话）
 * 覆盖：意图五类路由（complaint 优先/疑问句优先 kb_qa 不建单/修坏了直连建单/订单·会员·目录
 * 查询/闲聊兜底）、置信度三档边界（0.72/0.5 临界）、无据不答铁律（低置信拒答 + ticketDraft）、
 * 引用结构完整性、多轮会话（conversationId 续聊/归属校验）、mock 标注、latencyMs 记录、
 * 五元事件 emitter 留痕。DB 走内存 FakeDb。
 */
import { describe, expect, it } from "vitest";
import { FakeDb } from "../testing/fake-pg.js";
import { routeIntent, ruleBasedIntent, type IntentLlm } from "./intents.js";
import {
  bizToolFor, classifyConfidence, handleMessage, ticketKindForServiceRequest,
  CONFIDENCE_HIGH, CONFIDENCE_MEDIUM,
  type HandleMessageResult, type ServiceEventDraft,
} from "./dialog.js";
import type { KbSearchHit } from "../service-kb/search.js";

const WS = "ws-scen-dlg";
const TENANT = "tenant-demo";

/* ================= FakeDb 接线（c_conversations / c_messages） ================= */

function wireDialogDb(db: FakeDb): FakeDb {
  db.on(/^SELECT id FROM c_conversations WHERE id=\$1 AND workspace_id=\$2/, (p, d) => ({
    rows: d.table("c_conversations").filter((r) => r["id"] === p[0] && r["workspace_id"] === p[1])
      .map((r) => ({ id: r["id"] })),
  }));
  db.on(/^INSERT INTO c_conversations/, (p, d) => {
    d.table("c_conversations").push({
      id: p[0], workspace_id: p[1], c_user_id: p[2], channel: p[3], last_message_at: null,
    });
    return { rows: [{ id: p[0] }] };
  });
  db.on(/^INSERT INTO c_messages .*'user'/, (p, d) => {
    d.table("c_messages").push({
      id: d.table("c_messages").length + 1, workspace_id: p[0], conversation_id: p[1],
      role: "user", content: p[2], citations: [],
    });
    return { rows: [] };
  });
  db.on(/^INSERT INTO c_messages .*'assistant'/, (p, d) => {
    d.table("c_messages").push({
      id: d.table("c_messages").length + 1, workspace_id: p[0], conversation_id: p[1],
      role: "assistant", content: p[2], intent: p[3], confidence: p[4],
      citations: JSON.parse(String(p[5])), latency_ms: p[6],
    });
    return { rows: [] };
  });
  db.on(/^UPDATE c_conversations SET last_message_at=now\(\)/, (p, d) => {
    const row = d.table("c_conversations").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (row) row["last_message_at"] = new Date().toISOString();
    return { rows: [] };
  });
  return db;
}

function hit(content: string, score: number, over: Partial<KbSearchHit> = {}): KbSearchHit {
  return {
    content, heading: "服务须知 / 营业时间", documentTitle: "客户服务须知",
    documentId: "kbd-1", score, ...over,
  };
}

function memoryEmit(sink: Array<{ action: string; draft: ServiceEventDraft }>) {
  return async (_ctx: unknown, draft: ServiceEventDraft) => {
    sink.push({ action: draft.action, draft });
    return { eventId: `E-${sink.length}` };
  };
}

function base(cUserId = "cu-1") {
  return { workspaceId: WS, tenantId: TENANT, cUserId, channel: "h5" };
}

/* ================= B1. 意图路由（规则五类） ================= */

describe("B1 意图路由 · 规则表优先级", () => {
  it("complaint：投诉关键词直判", () => {
    expect(ruleBasedIntent("我要投诉，现场卫生差")).toBe("complaint");
  });

  it("complaint 优先于 biz_query（同句含订单词）", () => {
    expect(ruleBasedIntent("我要投诉，我的订单被取消了")).toBe("complaint");
  });

  it("biz_query：订单查询", () => {
    expect(ruleBasedIntent("帮我查一下我的订单")).toBe("biz_query");
  });

  it("biz_query：会员/积分/余额查询", () => {
    expect(ruleBasedIntent("我的会员积分还有多少余额")).toBe("biz_query");
  });

  it("biz_query：售价查询（售价词+多少钱）", () => {
    expect(ruleBasedIntent("这款售价多少钱")).toBe("biz_query"); // 含「售价」→ 业务查询
    expect(ruleBasedIntent("售价多少")).toBe("biz_query");
  });

  it("kb_qa：非订单语境的价格疑问走知识库（面膜多少钱/加购多少钱）", () => {
    expect(ruleBasedIntent("面膜多少钱")).toBe("kb_qa");
    expect(ruleBasedIntent("加购一件多少钱")).toBe("kb_qa"); // 评测校准：无订单语境不触发售价查询
  });

  it("疑问句优先 kb_qa 不建单（含服务词「送」）", () => {
    expect(ruleBasedIntent("配送车辆几点发车")).toBe("kb_qa");
  });

  it("疑问句标记：吗/呢/怎么/如何/时间/什么时候", () => {
    expect(ruleBasedIntent("可以带宠物吗")).toBe("kb_qa");
    expect(ruleBasedIntent("服务费怎么收呢")).toBe("kb_qa");
    expect(ruleBasedIntent("如何办理会员")).toBe("kb_qa");
    expect(ruleBasedIntent("门店营业时间")).toBe("kb_qa");
  });

  it("修坏了直连 service_request（疑问句也不拦）", () => {
    expect(ruleBasedIntent("设备坏了帮我修一下")).toBe("service_request");
    expect(ruleBasedIntent("水管漏水了")).toBe("service_request");
    expect(ruleBasedIntent("设备不运转怎么回事")).toBe("kb_qa"); // 「怎么回事」是诊断疑问 → kb_qa（未覆盖则拒答+工单草稿，评测校准口径）
  });

  it("指令型服务词 → service_request（送/拿/清洁/更换/开发票/续费）", () => {
    expect(ruleBasedIntent("帮我送两瓶矿泉水")).toBe("service_request");
    expect(ruleBasedIntent("货架需要清洁")).toBe("service_request");
    expect(ruleBasedIntent("帮我开发票")).toBe("service_request");
    expect(ruleBasedIntent("我要续费一年")).toBe("service_request");
  });

  it("kb_qa：政策/营业/会员/优惠类问句", () => {
    expect(ruleBasedIntent("营业几点开始")).toBe("kb_qa");
    expect(ruleBasedIntent("优惠码怎么用")).toBe("kb_qa");
    expect(ruleBasedIntent("退换时间政策")).toBe("kb_qa");
  });

  it("规则未命中 → null（闲聊交 LLM/兜底）", () => {
    expect(ruleBasedIntent("今天天气不错")).toBeNull();
  });

  it("routeIntent 无 LLM 未命中 → chat + fallback + degraded", async () => {
    const r = await routeIntent("今天心情不错");
    expect(r).toMatchObject({ intent: "chat", source: "fallback", degraded: true });
  });

  it("routeIntent 规则命中不走 LLM（source=rule，不 degraded）", async () => {
    const spy: IntentLlm = { async classify() { throw new Error("不应调用 LLM"); } };
    const r = await routeIntent("我要投诉", spy);
    expect(r).toMatchObject({ intent: "complaint", source: "rule", degraded: false });
  });

  it("routeIntent LLM 兜底命中（source=llm）", async () => {
    const llm: IntentLlm = { async classify() { return "kb_qa"; } };
    const r = await routeIntent("屋顶上有什么", llm);
    expect(r).toMatchObject({ intent: "kb_qa", source: "llm", degraded: false });
  });

  it("routeIntent LLM 返回非法意图 → 保守落 chat（degraded:false）", async () => {
    const llm: IntentLlm = { async classify() { return "hack" as never; } };
    const r = await routeIntent("屋顶上有什么", llm);
    expect(r).toMatchObject({ intent: "chat", source: "fallback", degraded: false });
  });
});

/* ================= B2. 置信度三档边界 ================= */

describe("B2 置信度三档 · 0.72 / 0.5 临界值", () => {
  it("阈值常量：HIGH=0.72、MEDIUM=0.5", () => {
    expect(CONFIDENCE_HIGH).toBe(0.72);
    expect(CONFIDENCE_MEDIUM).toBe(0.5);
  });

  it("undefined → low（无命中即低置信）", () => {
    expect(classifyConfidence(undefined)).toBe("low");
  });

  it("0.72 临界 → high（≥ 直答）", () => {
    expect(classifyConfidence(0.72)).toBe("high");
  });

  it("0.719 → medium", () => {
    expect(classifyConfidence(0.719)).toBe("medium");
  });

  it("0.5 临界 → medium（≥ 附提示）", () => {
    expect(classifyConfidence(0.5)).toBe("medium");
  });

  it("0.499 → low（拒答）", () => {
    expect(classifyConfidence(0.499)).toBe("low");
  });

  it("0 与 1 两端", () => {
    expect(classifyConfidence(0)).toBe("low");
    expect(classifyConfidence(1)).toBe("high");
  });
});

/* ================= B3. 工具/类型映射纯函数 ================= */

describe("B3 映射 · 工单类型与业务工具", () => {
  it("ticketKindForServiceRequest：修/坏/漏水/设备 → repair", () => {
    expect(ticketKindForServiceRequest("水管漏水了")).toBe("repair");
    expect(ticketKindForServiceRequest("设备坏了")).toBe("repair");
  });

  it("ticketKindForServiceRequest：送/拿/清洁/多要 → delivery", () => {
    expect(ticketKindForServiceRequest("送两条毛巾")).toBe("delivery");
    expect(ticketKindForServiceRequest("多要一床被子")).toBe("delivery");
  });

  it("ticketKindForServiceRequest：其余 → other", () => {
    expect(ticketKindForServiceRequest("帮我安排安静工位")).toBe("other");
  });

  it("bizToolFor：账单/费用/发票 → query_bill", () => {
    expect(bizToolFor("我的账单呢", "u1")).toEqual({ tool: "biz.query_bill", params: { cUserId: "u1" } });
  });

  it("bizToolFor：积分/会员/余额 → query_member", () => {
    expect(bizToolFor("会员积分查询", "u1").tool).toBe("biz.query_member");
  });

  it("bizToolFor：默认 → query_orders", () => {
    expect(bizToolFor("我的订单", "u1").tool).toBe("biz.query_orders");
  });
});

/* ================= B4. handleMessage 主链路（FakeDb） ================= */

describe("B4 handleMessage · kb_qa 三档分流", () => {
  it("高置信（0.9）直答：答案含内容与来源，citations 非空，tier=high", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage(
      { db, search: async () => [hit("营业时间为每日九点起", 0.9)] },
      { ...base(), text: "营业时间是几点" },
    );
    expect(r.intent).toBe("kb_qa");
    expect(r.tier).toBe("high");
    expect(r.answer).toContain("营业时间为每日九点起");
    expect(r.answer).toContain("来源：客户服务须知");
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.confidence).toBe(0.9);
    expect(r.ticketDraft).toBeUndefined();
  });

  it("中置信（0.6）附「可能不完全准确」提示", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage(
      { db, search: async () => [hit("营业九点到二十一点", 0.6)] },
      { ...base(), text: "营业几点" },
    );
    expect(r.tier).toBe("medium");
    expect(r.answer).toContain("可能不完全准确");
    expect(r.citations.length).toBeGreaterThan(0);
  });

  it("低置信（0.3）诚实拒答 + ticketDraft（无据不答）", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage(
      { db, search: async () => [hit("擦边内容", 0.3)] },
      { ...base(), text: "附近地铁站怎么走" },
    );
    expect(r.tier).toBe("low");
    expect(r.answer).toContain("无法准确回答");
    expect(r.answer).not.toContain("擦边内容"); // 铁律：低置信不外发检索内容
    expect(r.citations).toHaveLength(0);
    expect(r.ticketDraft).toMatchObject({ kind: "other", priority: "normal" });
    expect(r.ticketDraft!.title).toContain("知识库未覆盖咨询");
  });

  it("零命中 → 拒答 + ticketDraft，confidence=null", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage(
      { db, search: async () => [] },
      { ...base(), text: "营业几点开始" },
    );
    expect(r.tier).toBe("low");
    expect(r.confidence).toBeNull();
    expect(r.ticketDraft).toBeDefined();
  });

  it("引用结构完整性：documentId/documentTitle/heading/snippet/score 五字段", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage(
      { db, search: async () => [hit("内容".repeat(100), 0.85)] },
      { ...base(), text: "营业时间" },
    );
    const c = r.citations[0]!;
    expect(c).toMatchObject({ documentId: "kbd-1", documentTitle: "客户服务须知", heading: "服务须知 / 营业时间" });
    expect(typeof c.score).toBe("number");
    expect(c.snippet.length).toBeLessThanOrEqual(120);
  });
});

describe("B4 handleMessage · complaint / service_request / biz_query / chat", () => {
  it("complaint：高优先级工单草稿 + 致歉文案（confidence=1 规则源）", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage({ db }, { ...base(), text: "我要投诉，现场太吵了" });
    expect(r.intent).toBe("complaint");
    expect(r.confidence).toBe(1);
    expect(r.ticketDraft).toMatchObject({ kind: "complaint", priority: "high" });
    expect(r.answer).toContain("客服主管");
  });

  it("service_request 报修 → repair 草稿", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage({ db }, { ...base(), text: "设备坏了帮我修一下" });
    expect(r.intent).toBe("service_request");
    expect(r.ticketDraft).toMatchObject({ kind: "repair", priority: "normal" });
  });

  it("service_request 配送 → delivery 草稿", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage({ db }, { ...base(), text: "帮我送两瓶矿泉水" });
    expect(r.ticketDraft).toMatchObject({ kind: "delivery" });
  });

  it("biz_query：只产工具调用描述，不答业务数据", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage({ db }, { ...base(), text: "我的订单查一下" });
    expect(r.intent).toBe("biz_query");
    expect(r.bizTool).toEqual({ tool: "biz.query_orders", params: { cUserId: "cu-1" } });
    expect(r.answer).not.toContain("我的订单"); // 不碰业务数据
  });

  it("chat 无 LLM：确定性 mock 应答（mock:true + degraded + confidence 0.3）", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage({ db }, { ...base(), text: "今天心情不错" });
    expect(r.intent).toBe("chat");
    expect(r.mock).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.answer).toContain("[mock]");
    expect(r.confidence).toBe(0.3);
  });

  it("chat 有 LLM：答案来自注入实现（不标 mock）", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage(
      { db, chatLlm: { async reply(t: string) { return `LLM 回复：${t}`; } } },
      { ...base(), text: "今天心情不错" },
    );
    expect(r.answer).toBe("LLM 回复：今天心情不错");
    expect(r.mock).toBeUndefined();
    expect(r.confidence).toBe(0.8);
  });
});

describe("B4 handleMessage · 会话与留痕", () => {
  it("无 conversationId → 新建会话（CCV 前缀）", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage({ db }, { ...base(), text: "我要投诉噪音" });
    expect(r.conversationId).toMatch(/^CCV/);
    expect(db.table("c_conversations")).toHaveLength(1);
  });

  it("conversationId 续聊 → 复用同一会话", async () => {
    const db = wireDialogDb(new FakeDb());
    const r1 = await handleMessage({ db }, { ...base(), text: "我要投诉噪音" });
    const r2 = await handleMessage({ db }, { ...base(), text: "而且卫生也差", conversationId: r1.conversationId });
    expect(r2.conversationId).toBe(r1.conversationId);
    expect(db.table("c_conversations")).toHaveLength(1);
  });

  it("conversationId 归属校验：不存在的会话 → 抛错", async () => {
    const db = wireDialogDb(new FakeDb());
    await expect(handleMessage({ db }, { ...base(), text: "我要投诉", conversationId: "CCV-others" }))
      .rejects.toThrow("不存在");
  });

  it("多轮消息落库：两轮后 2 条 user + 2 条 assistant", async () => {
    const db = wireDialogDb(new FakeDb());
    const r1 = await handleMessage({ db }, { ...base(), text: "我要投诉噪音" });
    await handleMessage({ db }, { ...base(), text: "卫生也差", conversationId: r1.conversationId });
    const msgs = db.table("c_messages");
    expect(msgs.filter((m) => m["role"] === "user")).toHaveLength(2);
    expect(msgs.filter((m) => m["role"] === "assistant")).toHaveLength(2);
  });

  it("助手消息留痕 intent/confidence/citations/latencyMs", async () => {
    const db = wireDialogDb(new FakeDb());
    await handleMessage(
      { db, search: async () => [hit("内容", 0.9)] },
      { ...base(), text: "营业时间" },
    );
    const assistant = db.table("c_messages").find((m) => m["role"] === "assistant")!;
    expect(assistant["intent"]).toBe("kb_qa");
    expect(assistant["confidence"]).toBe(0.9);
    expect(Array.isArray(assistant["citations"])).toBe(true);
    expect(typeof assistant["latency_ms"]).toBe("number");
  });

  it("latencyMs 非负整数", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage({ db }, { ...base(), text: "我要投诉" });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(r.latencyMs)).toBe(true);
  });

  it("五元事件：service.message.handle 带意图/置信度/耗时", async () => {
    const db = wireDialogDb(new FakeDb());
    const sink: Array<{ action: string; draft: ServiceEventDraft }> = [];
    const r: HandleMessageResult = await handleMessage(
      { db, emit: memoryEmit(sink), search: async () => [hit("内容", 0.9)] },
      { ...base(), text: "营业时间" },
    );
    expect(sink).toHaveLength(1);
    expect(sink[0]!.action).toBe("service.message.handle");
    const after = sink[0]!.draft.after as Record<string, unknown>;
    expect(after).toMatchObject({ intent: "kb_qa", tier: "high", latencyMs: r.latencyMs });
    expect(sink[0]!.draft.object).toMatchObject({ type: "c_conversation", id: r.conversationId });
  });

  it("emitter 缺省时不写事件也不报错", async () => {
    const db = wireDialogDb(new FakeDb());
    const r = await handleMessage({ db }, { ...base(), text: "我要投诉" });
    expect(r.intent).toBe("complaint");
  });
});
