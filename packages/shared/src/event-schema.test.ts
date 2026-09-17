/**
 * A2 验收测试：对 PRD 示例事件「校验通过 / 拒绝」各 1 例
 * 运行：pnpm -C packages/shared test
 */
import { describe, expect, it } from "vitest";
import { BusinessEventSchema, safeParseBusinessEvent } from "./event-schema.js";

/** 合法事件：字段对齐 PRD V2.5 附录 E（酒店版调价场景，P3/P4 同款） */
const VALID_EVENT = {
  event_id: "E-8806",
  who: { type: "agent", id: "pricing-agent", version: "v2.3" },
  context: {
    tenant_id: "tenant-demo",
    workspace_id: "ws-yunqi",
    time: "2026-08-16T04:10:00+08:00",
    channel: "meituan",
    stage: "stable",
  },
  object: { type: "room_price", id: "meituan:deluxe-king:2026-08-21" },
  decision: {
    action: "price.adjust",
    before: { price: 398 },
    after: { price: 428 },
    basis: ["competitor-avg-445", "occ-82.4"],
    memory_refs: ["MEM-041"],
  },
  rule_impact: [{ rule_id: "R1", version: "v3", result: "review" }],
  receipt: { synced: false },
  model_trace: { model_id: "mock-flagship", tier: "flagship", window: "off-peak", credits: 32 },
  links: ["E-8755"],
  ts: "2026-08-16T04:10:01+08:00",
};

describe("五元事件 Schema v1（PRD 附录 E）", () => {
  it("接受合法五元事件", () => {
    const parsed = BusinessEventSchema.parse(VALID_EVENT);
    expect(parsed.event_id).toBe("E-8806");
    expect(parsed.who.version).toBe("v2.3");
  });

  it("拒绝非法 event_id（不满足 ^E-\\d+$）", () => {
    const bad = { ...VALID_EVENT, event_id: "8806" };
    const r = safeParseBusinessEvent(bad);
    expect(r.success).toBe(false);
  });

  it("拒绝缺失 decision.action", () => {
    const bad = { ...VALID_EVENT, decision: { before: {} } };
    expect(safeParseBusinessEvent(bad).success).toBe(false);
  });

  it("拒绝非法 rule_impact.result 枚举", () => {
    const bad = {
      ...VALID_EVENT,
      rule_impact: [{ rule_id: "R1", version: "v3", result: "approved" }],
    };
    expect(safeParseBusinessEvent(bad).success).toBe(false);
  });
});
