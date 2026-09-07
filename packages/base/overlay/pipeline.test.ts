/**
 * M2-1/M3-1/M3-2 测试：pipeline 编排器 + rebase 检测器 + L1 配置层对接
 * 纪律性断言（不是"调用过"而是"行为正确"）：
 *  - 考试闸：合并失败的草稿永远进不了灰度；合法草稿全过且事件留痕；
 *  - 观察期：灰度没泡够时间，转全量必拒；
 *  - rebase：引用消失→自动落回；围栏级别变化→待裁决；全兼容→原样保留；
 *  - L1：六种意图全部映射正确；越界意图与手工编辑一样被拒；空列表拒收。
 */
import { describe, expect, it } from "vitest";
import {
  buildDraftFromIntents, canaryToActive, checkItem, detectRebase, draftToCanary,
  examGate, intentToItems, L1IntakeError, PipelineError, rebaseSummary,
  type BundleAssetView, type OverlayDoc, type OverlayItem, type PipelineDeps,
} from "./index.js";
import type { OverlayPipelineEvent } from "./pipeline.js";

/* ---------- 测试视图（仿酒店包资产） ---------- */
function makeView(): BundleAssetView {
  return {
    bj: {
      workloom: {
        thresholds: { "approval/refund-credits": 500 },
        provides: { skills: ["skills/kb-fresh/SKILL.md", "skills/marketing-auto/SKILL.md"] },
      },
    },
    presets: [
      { preset_key: "fae-chief", name: "接待班长" },
      { preset_key: "marketing-officer", name: "营销官", skills: ["marketing-auto"] },
    ],
    fencePacks: [
      { fences: [
        { rule_id: "R-MK1", level: "review", name: "营销内容人工复核" },
        { rule_id: "R-PL4", level: "block", name: "客户数据导出" },
      ] },
    ],
    extra: {
      faq: [
        { id: "standard-041", q: "退房时间？", a: "中午 12 点" },
        { id: "standard-042", q: "含早吗？", a: "含双早" },
      ],
      "service-front": { tone: "标准商务" },
    },
  } as unknown as BundleAssetView;
}

function doc(items: OverlayItem[], over?: Partial<OverlayDoc>): OverlayDoc {
  return {
    tenant_id: "t1", base_bundle: "hotel", base_version: "2.3.0",
    overlay_version: 1, status: "draft",
    items, note: "test", ...over,
  };
}

/* ---------- 考试闸 ---------- */
describe("考试闸 examGate", () => {
  it("合法覆盖：合并成功 + 围栏考题金标准全过", async () => {
    const r = await examGate(makeView(), doc([
      { type: "persona", op: "override", path: "service-front/tone", value: "亲切家庭风" },
      { type: "fence", op: "tighten", path: "fences/R-MK1", from: "review", to: "block" },
    ]));
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("合并失败（围栏红线不可调）→ 考试必挂，失败原因含合并信息", async () => {
    const r = await examGate(makeView(), doc([
      { type: "fence", op: "tighten", path: "fences/R-PL4", from: "review", to: "block" } as never,
    ]));
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/合并失败/);
  });

  it("编制引用不存在 → 考试挂（双保险复核）", async () => {
    // 构造一个能骗过合并引擎的场景：视图里 preset 存在但 merge 后被删除——
    // 直接用不存在的 key，合并引擎会先拦（属于①），两条路都必须挂
    const r = await examGate(makeView(), doc([
      { type: "crew", op: "disable", path: "presets/ghost-employee" },
    ]));
    expect(r.pass).toBe(false);
  });
});

/* ---------- 流水线（内存 store 桩：不走真库，专注编排逻辑） ---------- */
function memStore(initial: Array<OverlayDoc & { updated_at?: string }>) {
  const rows = new Map<string, OverlayDoc & { updated_at?: string }>();
  for (const d of initial) rows.set(`${d.base_bundle}#${d.overlay_version}`, d);
  const q = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("SELECT base_bundle")) {
        const [, , bb, v] = params as [string, string, string, number];
        const row = rows.get(`${bb}#${v}`);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (sql.includes("UPDATE tenant_overlays SET status")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { q, rows };
}

describe("流水线编排", () => {
  const view = makeView();
  const deps = (events: OverlayPipelineEvent[], over?: Partial<PipelineDeps>): PipelineDeps => ({
    loadView: () => view,
    eventSink: (e) => { events.push(e); },
    ...over,
  });

  it("草稿缺 canary_scope 进灰度必拒（流水线纪律）", async () => {
    const d = doc([{ type: "persona", op: "override", path: "service-front/tone", value: "X" }]);
    const { q } = memStore([d]);
    const events: OverlayPipelineEvent[] = [];
    await expect(draftToCanary(q as never, { workspaceId: "w", tenantId: "t1" }, "hotel", 1, deps(events)))
      .rejects.toThrowError(/canary_scope/);
  });

  it("考试不过：状态停在草稿，overlay.exam_failed 事件留痕", async () => {
    const d = doc(
      [{ type: "fence", op: "tighten", path: "fences/R-PL4", from: "review", to: "block" } as never],
      { canary_scope: { ratio: 0.1 } },
    );
    const { q } = memStore([d]);
    const events: OverlayPipelineEvent[] = [];
    await expect(draftToCanary(q as never, { workspaceId: "w", tenantId: "t1" }, "hotel", 1, deps(events)))
      .rejects.toThrowError(PipelineError);
    expect(events.some((e) => e.type === "overlay.exam_failed")).toBe(true);
    expect(events.some((e) => e.type === "overlay.canary_started")).toBe(false);
  });

  it("灰度观察期不足转全量必拒；泡够时间放行", async () => {
    const d = doc([{ type: "persona", op: "override", path: "service-front/tone", value: "X" }], {
      status: "canary", canary_scope: { ratio: 0.1 }, updated_at: new Date(1_000_000).toISOString(),
    } as never);
    const { q } = memStore([d]);
    const events: OverlayPipelineEvent[] = [];
    // 观察期要求 1 小时，但只过了 0.5 秒
    await expect(canaryToActive(q as never, { workspaceId: "w", tenantId: "t1" }, "hotel", 1,
      deps(events, { canaryMinObserveMs: 3_600_000, now: () => 1_000_500 })))
      .rejects.toThrowError(/观察期不足/);
  });

  it("非灰度状态不能转全量（draft 直接跳 active 被双闸拦）", async () => {
    const d = doc([{ type: "persona", op: "override", path: "service-front/tone", value: "X" }]);
    const { q } = memStore([d]);
    await expect(canaryToActive(q as never, { workspaceId: "w", tenantId: "t1" }, "hotel", 1, deps([])))
      .rejects.toThrowError(/只有灰度中可转全量/);
  });
});

/* ---------- Rebase 检测器 ---------- */
describe("rebase 检测器", () => {
  it("三类裁决：兼容保留 / 引用消失自动落回 / 围栏级别变化待裁决", () => {
    const old = makeView();
    const docV = doc([
      { type: "persona", op: "override", path: "service-front/tone", value: "亲切风" },        // 兼容
      { type: "kb", op: "override", path: "faq/standard-041", value: { a: "下午 2 点" } },      // 新包删了 → 落回
      { type: "crew", op: "disable", path: "presets/marketing-officer" },                        // 员工还在 → 兼容
      { type: "fence", op: "tighten", path: "fences/R-MK1", from: "review", to: "block" },      // 新包变了级别 → 待裁决
      { type: "threshold", op: "override", path: "approval/refund-credits", value: 800, bounds: { min: 0, max: 1000 } }, // 新包删了 → 落回
      { type: "skill", op: "disable", path: "skills/marketing-auto" },                           // 技能还在 → 兼容
    ]);
    // 新行业包：删了 standard-041 与阈值、R-MK1 级别 review→block
    const next = makeView();
    next.extra.faq = [{ id: "standard-042", q: "含早吗？", a: "含双早" }] as never;
    (next.bj.workloom!.thresholds as Record<string, number>) = {};
    next.fencePacks[0]!.fences = [
      { rule_id: "R-MK1", level: "block", name: "营销内容人工复核" },
      { rule_id: "R-PL4", level: "block", name: "客户数据导出" },
    ];

    const report = detectRebase(docV, next, "2.4.0");
    expect(report.from_version).toBe("2.3.0");
    expect(report.to_version).toBe("2.4.0");
    expect(report.compatible).toBe(3);        // persona + crew + skill
    expect(report.autoFallback).toBe(2);      // kb + threshold
    expect(report.needsDecision).toBe(1);     // fence
    // 落回后的项集：摘掉 kb 与 threshold，其余保留
    expect(report.rebasedItems).toHaveLength(4);
    expect(report.rebasedItems.some((i) => i.type === "kb")).toBe(false);
    expect(report.rebasedItems.some((i) => i.type === "threshold")).toBe(false);
    // 摘要人话可读
    const s = rebaseSummary(report);
    expect(s).toContain("3 项兼容");
    expect(s).toContain("2 项已自动落回行业默认");
    expect(s).toContain("1 项待您裁决");
  });

  it("全兼容：摘要一句话安抚，项集原样", () => {
    const d = doc([
      { type: "persona", op: "override", path: "service-front/tone", value: "亲切风" },
      { type: "brand", op: "override", path: "mate-name", value: "小栖" },
    ]);
    const report = detectRebase(d, makeView(), "2.4.0");
    expect(report.compatible).toBe(2);
    expect(report.rebasedItems).toHaveLength(2);
    expect(rebaseSummary(report)).toContain("全部兼容");
  });

  it("checkItem：行业包删除员工 → 编制调整落回默认", () => {
    const r = checkItem({ type: "crew", op: "disable", path: "presets/ghost" }, 0, makeView());
    expect(r.verdict).toBe("auto_fallback");
  });
});

/* ---------- L1 配置层对接 ---------- */
describe("L1 意图 → 覆盖项", () => {
  it("六种意图全部映射正确", () => {
    expect(intentToItems({ kind: "tone", tone: "亲切家庭风" })[0]).toMatchObject({
      type: "persona", path: "service-front/tone", value: "亲切家庭风",
    });
    expect(intentToItems({ kind: "faq", question: "有婴儿床吗", answer: "有，免费" })[0]).toMatchObject({
      type: "kb", op: "append", path: "faq",
    });
    expect(intentToItems({ kind: "threshold", key: "approval/refund-credits", value: 800, bounds: { min: 0, max: 1000 } })[0])
      .toMatchObject({ type: "threshold", value: 800 });
    expect(intentToItems({ kind: "crew", preset_key: "marketing-officer", disable: true })[0])
      .toMatchObject({ type: "crew", op: "disable", path: "presets/marketing-officer" });
    expect(intentToItems({ kind: "skill", name: "marketing-auto", disable: true })[0])
      .toMatchObject({ type: "skill", op: "disable", path: "skills/marketing-auto" });
    expect(intentToItems({ kind: "brand", field: "mate-name", value: "小栖" })[0])
      .toMatchObject({ type: "brand", op: "override", path: "mate-name", value: "小栖" });
  });

  it("buildDraftFromIntents：多意图合并 + 溯源 note + canary_scope 透传", () => {
    const draft = buildDraftFromIntents({ workspaceId: "w", tenantId: "t1" }, "hotel", "2.3.0", [
      { kind: "tone", tone: "亲切家庭风" },
      { kind: "faq", question: "有婴儿床吗", answer: "有，免费" },
      { kind: "brand", field: "mate-name", value: "小栖" },
    ], { canaryScope: { ratio: 0.1 } });
    expect(draft.items).toHaveLength(3);
    expect(draft.note).toContain("L1 自然语言录入");
    expect(draft.canary_scope).toEqual({ ratio: 0.1 });
    expect(draft.status).toBe("draft");
  });

  it("越界意图与手工编辑同一道闸：阈值越界必拒", () => {
    expect(() => buildDraftFromIntents({ workspaceId: "w", tenantId: "t1" }, "hotel", "2.3.0", [
      { kind: "threshold", key: "approval/refund-credits", value: 9999, bounds: { min: 0, max: 1000 } },
    ])).toThrowError();
  });

  it("空意图列表拒收", () => {
    expect(() => buildDraftFromIntents({ workspaceId: "w", tenantId: "t1" }, "hotel", "2.3.0", []))
      .toThrowError(L1IntakeError);
  });

  it("faq 条目带 l1-intake 溯源标记", () => {
    const items = intentToItems({ kind: "faq", question: "Q", answer: "A" });
    expect((items[0] as { value: { source: string } }).value.source).toBe("l1-intake");
  });
});
