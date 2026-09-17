/**
 * B2 测试：过滤器 SQL 构建（纯函数）+ Mock NL 直译 + 超时降级（E1.6）+ PG 集成检索
 * PG 集成同样仅 RUN_DB_TESTS=1 时启用（读侧走 workloom_app，验证 RLS 口径）。
 */
import { describe, expect, it } from "vitest";
import {
  buildWhere,
  MockNlTranslator,
  nlSearchEvents,
  NL_TRANSLATE_TIMEOUT_MS,
  type EventFilter,
  type NlTranslatorLexicon,
  type NlTranslator,
} from "./recall.js";

const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
const hotelLexicon: NlTranslatorLexicon = {
  objects: [
    { terms: ["差评", "评价"], value: "review" },
    { terms: ["房价", "调价", "价格"], value: "room_price" },
    { terms: ["订单", "退款", "对账"], value: "order" },
  ],
  actions: [
    { terms: ["退款"], value: "order.refund" },
    { terms: ["调价"], value: "price.adjust" },
    { terms: ["回复"], value: "review.reply" },
  ],
  ruleIds: ["R1", "R2", "R3", "R4", "R5", "R6"],
};

describe("buildWhere（结构化过滤）", () => {
  it("强制租户+工作区范围（越权返回空的第一道）", () => {
    const { sql, params } = buildWhere({}, scope);
    expect(sql).toContain("tenant_id = $1");
    expect(sql).toContain("workspace_id = $2");
    expect(params).toEqual(["tenant-demo", "ws-yunqi"]);
  });

  it("对象/动作/规则结果组合过滤，全参数化", () => {
    const { sql, params } = buildWhere(
      { objectType: "review", ruleResult: "review", action: "review.reply" },
      scope,
    );
    expect(sql).toContain("payload->'object'->>'type' = $3");
    expect(sql).toContain("@>");
    expect(params).toEqual(["tenant-demo", "ws-yunqi", "review", "review.reply", "review"]);
  });

  it("非法字符直接拒绝（防注入底线）", () => {
    expect(() => buildWhere({ objectType: "x'; DROP TABLE biz_events;--" }, scope)).toThrow(/非法字符/);
  });

  it("游标分页生成 seq < N", () => {
    const { sql } = buildWhere({}, scope, "123");
    expect(sql).toContain("seq < $3::bigint");
  });
});

describe("MockNlTranslator（D4 无 Key 演示）", () => {
  const t = new MockNlTranslator(hotelLexicon);

  it("「昨天的差评」→ review + 昨日时间窗", async () => {
    const f = await t.translate("昨天的差评有哪些", scope);
    expect(f.objectType).toBe("review");
    expect(f.from).toBeDefined();
    expect(f.to).toBeDefined();
  });

  it("「R2 熔断记录」→ ruleId+blocked", async () => {
    const f = await t.translate("给我看 R2 熔断记录", scope);
    expect(f.ruleId).toBe("R2");
    expect(f.ruleResult).toBe("blocked");
  });

  it("「退款」→ order.refund", async () => {
    const f = await t.translate("昨晚有哪些退款", scope);
    expect(f.action).toBe("order.refund");
  });
});

describe("NL 超时降级（E1.6）", () => {
  it("翻译超时 → degraded=true，不伪造结果", async () => {
    const slow: NlTranslator = {
      translate: () => new Promise<EventFilter>(() => setTimeout(() => undefined, 10_000)),
    };
    const fakePool = {} as never; // 降级路径不触 DB
    const r = await nlSearchEvents(fakePool, scope, "随便", slow, { timeoutMs: 50 });
    expect(r.degraded).toBe(true);
    expect(r.page).toBeNull();
  });

  it("翻译失败同样降级", async () => {
    const bad: NlTranslator = { translate: () => Promise.reject(new Error("LLM down")) };
    const r = await nlSearchEvents({} as never, scope, "随便", bad);
    expect(r.degraded).toBe(true);
  });

  it("超时口径常量为 3s（与 P1 意图路由同机制）", () => {
    expect(NL_TRANSLATE_TIMEOUT_MS).toBe(3_000);
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成检索（种子 100 事件）", async () => {
  const pg = (await import("pg")).default;
  const { searchEvents } = await import("./recall.js");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });

  it("action=price.adjust 命中种子剧本（每 10 条 2 条 → 共 20 条）", async () => {
    const page = await searchEvents(pool, scope, { action: "price.adjust" }, { limit: 100 });
    expect(page.total).toBeGreaterThanOrEqual(20); // 种子 20 + B1 集成测试追加
    for (const e of page.events) expect(e.decision.action).toBe("price.adjust");
  });

  it("ruleResult=blocked 命中 R2 保底价熔断样本", async () => {
    const page = await searchEvents(pool, scope, { ruleResult: "blocked" }, { limit: 100 });
    expect(page.total).toBeGreaterThanOrEqual(10);
    for (const e of page.events)
      expect(e.rule_impact.some((r) => r.result === "blocked")).toBe(true);
  });

  it("NL 端到端（Mock 翻译器）：「夜班被熔断的调价」", async () => {
    const r = await nlSearchEvents(pool, scope, "夜班被熔断的调价", new MockNlTranslator(hotelLexicon), { limit: 100 });
    expect(r.degraded).toBe(false);
    expect(r.filter?.ruleResult).toBe("blocked");
    // #39 修复：原断言「窗口内必有事件」依赖种子剧本时间恰好落在「昨夜 22:00→今晨 08:30」
    // ——跨天运行即假红（种子 created_at 是固定剧本日期）。NL 链路验证与时间窗解耦：
    // 结构断言为主；窗口内若有事件则校验结果纯净
    expect(r.filter?.from).toBeDefined();
    expect(r.filter?.to).toBeDefined();
    expect(r.page).not.toBeNull();
    for (const e of r.page!.events)
      expect(e.rule_impact.some((x) => x.result === "blocked")).toBe(true);
  });

  it("越权工作区返回空（L7.1）", async () => {
    const page = await searchEvents(pool, { tenantId: "tenant-demo", workspaceId: "ws-other" }, {}, { limit: 10 });
    expect(page.events).toEqual([]);
    expect(page.total).toBe(0);
  });
});
