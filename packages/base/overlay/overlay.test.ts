/**
 * overlay/overlay.test.ts —— 租户覆盖层测试（DoD 验收口径）
 * ① 双租户同一行业包行为分化；② 放宽围栏被拒；③ 阈值越界被拒；
 * ④ 优先级（租户>行业包>基座）；⑤ 墓碑语义；⑥ 真实酒店包试点（双租户）。
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseOverlay, OverlayError, type OverlayDoc } from "./model.js";
import { mergeOverlay, kbEntriesOf, isPresetDisabled, thresholdOf, type BundleAssetView } from "./merge.js";

/* ---------- 测试资产（模拟行业包） ---------- */
function makeView(): BundleAssetView {
  return {
    bj: { name: "hotel", workloom: { provides: { skills: ["skills/kb-fresh/SKILL.md", "skills/care-outreach/SKILL.md"] } } },
    presets: [
      { preset_key: "fae-chief", name: "工单主管" },
      { preset_key: "marketing-officer", name: "营销专员" },
    ],
    fencePacks: [{
      version: 1,
      fences: [
        { rule_id: "R-MK2", level: "review", name: "营销触达" },
        { rule_id: "R-PL4", level: "block", name: "数据导出红线" },
        { rule_id: "R-PL1", level: "review", name: "资金操作" },
      ],
    }],
    extra: {
      faq: [
        { id: "standard-041", q: "退房时间？", a: "中午 12 点" },
        { id: "standard-042", q: "能带宠物吗？", a: "抱歉不能" },
      ],
      "service-front": { tone: "标准商务" },
    },
  };
}

function doc(items: OverlayDoc["items"], patch: Partial<OverlayDoc> = {}): OverlayDoc {
  return parseOverlay({
    tenant_id: "t-001", base_bundle: "hotel", base_version: "2.3.0",
    overlay_version: 1, status: "active", items, ...patch,
  });
}

describe("覆盖层模型校验", () => {
  it("拒绝放宽围栏（review→auto）", () => {
    expect(() => doc([{ type: "fence", op: "tighten", path: "fences/R-MK2", from: "review", to: "auto" }]))
      .toThrowError(/只允许收紧/);
  });

  it("拒绝修改 block 红线（from=block）", () => {
    expect(() => doc([{ type: "fence", op: "tighten", path: "fences/R-PL4", from: "block", to: "block" }]))
      .toThrowError(/不可调|红线/);
  });

  it("拒绝越界阈值", () => {
    expect(() => doc([{ type: "threshold", op: "override", path: "approval/refund-credits", value: 9999, bounds: { min: 0, max: 2000 } }]))
      .toThrowError(/超出基座允许区间/);
  });

  it("canary 必须带灰度范围", () => {
    expect(() => doc([], { status: "canary" })).toThrowError(/canary_scope/);
  });
});

describe("合并引擎", () => {
  it("① 双租户同一行业包行为分化（话术/阈值/编制）", () => {
    const base = makeView();
    const a = mergeOverlay(base, doc([
      { type: "persona", op: "override", path: "service-front/tone", value: "亲切家庭风" },
      { type: "threshold", op: "override", path: "approval/refund-credits", value: 500, bounds: { min: 0, max: 2000 } },
    ]));
    const b = mergeOverlay(base, doc([
      { type: "persona", op: "override", path: "service-front/tone", value: "克制商务风" },
      { type: "threshold", op: "override", path: "approval/refund-credits", value: 1500, bounds: { min: 0, max: 2000 } },
      { type: "crew", op: "disable", path: "presets/marketing-officer" },
    ]));
    expect((a.assets.extra["service-front"] as Record<string, unknown>).tone).toBe("亲切家庭风");
    expect((b.assets.extra["service-front"] as Record<string, unknown>).tone).toBe("克制商务风");
    expect(thresholdOf(a.assets, "approval/refund-credits")).toBe(500);
    expect(thresholdOf(b.assets, "approval/refund-credits")).toBe(1500);
    expect(isPresetDisabled(a.assets, "marketing-officer")).toBe(false);
    expect(isPresetDisabled(b.assets, "marketing-officer")).toBe(true);
    // 原始资产不被污染（不可变合并）
    expect((base.extra["service-front"] as Record<string, unknown>).tone).toBe("标准商务");
  });

  it("② 合并期拒绝放宽围栏（block 当前级不可调）", () => {
    const view = makeView();
    view.fencePacks[0]!.fences!.push({ rule_id: "R-X9", level: "block", name: "内部红线" } as never);
    expect(() => mergeOverlay(view, doc([
      { type: "fence", op: "tighten", path: "fences/R-X9", from: "review", to: "block",
      // from 写的 review（绕过模型校验），但行业包当前是 block —— 合并期必须拦下
    } as never]))).toThrowError(/block 红线级|不可调/);
    // 平台红线 R-PL4 走不可覆盖清单，同样必拒
    expect(() => mergeOverlay(makeView(), doc([
      { type: "fence", op: "tighten", path: "fences/R-PL4", from: "review", to: "block" } as never,
    ]))).toThrowError(OverlayError);
  });

  it("②b 围栏收紧生效（review→block），且 from 不匹配时拒绝", () => {
    const ok = mergeOverlay(makeView(), doc([
      { type: "fence", op: "tighten", path: "fences/R-MK2", from: "review", to: "block" },
    ]));
    expect(ok.assets.fencePacks[0]?.fences?.find((r) => r.rule_id === "R-MK2")?.level).toBe("block");
    expect(ok.audit.some((a) => a.action === "fence.tighten")).toBe(true);

    expect(() => mergeOverlay(makeView(), doc([
      { type: "fence", op: "tighten", path: "fences/R-PL1", from: "auto", to: "block" } as never,
    ]))).toThrowError(/不一致/);
  });

  it("③ 合并期拒绝越界阈值（模型层放行的边界由合并层复核）", () => {
    expect(() => mergeOverlay(makeView(), doc([
      { type: "threshold", op: "override", path: "sla/first-response-min", value: 120, bounds: { min: 1, max: 60 } },
    ]))).toThrowError(/超出基座允许区间/);
  });

  it("④ 优先级：租户覆盖 > 行业包默认（知识按 id 覆盖）", () => {
    const r = mergeOverlay(makeView(), doc([
      { type: "kb", op: "override", path: "faq/standard-041", value: { a: "下午 2 点（本店规则）" } },
    ]));
    const faq = kbEntriesOf(r.assets, "faq");
    expect(faq.find((e) => e.id === "standard-041")?.a).toBe("下午 2 点（本店规则）");
  });

  it("⑤ 墓碑：删除的知识项不出现在合并结果，且留痕", () => {
    const r = mergeOverlay(makeView(), doc([
      { type: "kb", op: "tombstone", path: "faq/standard-042" },
    ]));
    const faq = kbEntriesOf(r.assets, "faq");
    expect(faq.find((e) => e.id === "standard-042")).toBeUndefined();
    expect(faq.find((e) => e.id === "standard-041")).toBeDefined();
    expect(r.audit.some((a) => a.action === "kb.tombstone")).toBe(true);
  });

  it("知识新增与技能停用", () => {
    const r = mergeOverlay(makeView(), doc([
      { type: "kb", op: "append", path: "faq", value: { q: "凌晨能加床吗？", a: "请拨 0 找值班经理" } },
      { type: "skill", op: "disable", path: "skills/care-outreach" },
    ]));
    expect(kbEntriesOf(r.assets, "faq").some((e) => e.q === "凌晨能加床吗？")).toBe(true);
    const disabled = (r.assets.bj.workloom as Record<string, unknown>).disabled_skills as string[];
    expect(disabled).toContain("care-outreach");
  });

  it("不可覆盖路径命中即拒（账本/考试院/积分底层）", () => {
    expect(() => mergeOverlay(makeView(), doc([
      { type: "persona", op: "override", path: "ledger/rules", value: "x" } as never,
    ]))).toThrowError(OverlayError);
    expect(() => mergeOverlay(makeView(), doc([
      { type: "threshold", op: "override", path: "credits/pool-rate", value: 1, bounds: { min: 0, max: 2 } } as never,
    ]))).toThrowError(/不可覆盖清单/);
  });

  it("编制/技能引用不存在的对象即拒（宁拒不错合）", () => {
    expect(() => mergeOverlay(makeView(), doc([
      { type: "crew", op: "disable", path: "presets/ghost" } as never,
    ]))).toThrowError(/不存在于行业包/);
    expect(() => mergeOverlay(makeView(), doc([
      { type: "skill", op: "disable", path: "skills/ghost" } as never,
    ]))).toThrowError(/不存在于行业包/);
  });
});

/* ---------- ⑥ 真实酒店行业包试点（双租户） ---------- */
describe("真实行业包试点（bundles/hotel 双租户）", () => {
  const hotelDir = join(process.cwd(), "bundles/hotel");
  const skip = !existsSync(join(hotelDir, "bundle.json"));

  it.skipIf(skip)("云栖亲子店 vs 云栖商务店：同一酒店包两种脾气", async () => {
    const { loadBundleDiskAssets } = await import("../bundles/assembly.js") as never as {
      loadBundleDiskAssets: (dir: string, slug: string) => BundleAssetView & { presets: Array<{ preset_key?: string }>; fencePacks: Array<{ fences?: Array<{ rule_id?: string; level?: string }> }> };
    };
    // 直接以磁盘资产构造视图（与装配钩子同路径）
    const { readFileSync, readdirSync } = await import("node:fs");
    const YAML = (await import("yaml")).default;
    const presetsDir = join(hotelDir, "presets");
    const fencesDir = join(hotelDir, "fences");
    const view = (): BundleAssetView => ({
      bj: JSON.parse(readFileSync(join(hotelDir, "bundle.json"), "utf-8")),
      presets: readdirSync(presetsDir).filter((f) => f.endsWith(".yml")).sort()
        .map((f) => YAML.parse(readFileSync(join(presetsDir, f), "utf-8"))),
      fencePacks: readdirSync(fencesDir).filter((f) => f.endsWith(".yml")).sort()
        .map((f) => YAML.parse(readFileSync(join(fencesDir, f), "utf-8"))),
      extra: {},
    });

    const family = mergeOverlay(view(), doc([
      { type: "persona", op: "override", path: "service-front/tone", value: "亲切亲子风：主动询问儿童需求" },
      { type: "kb", op: "append", path: "faq", value: { q: "有儿童拖鞋吗？", a: "有的，入住时告知前台即可准备" } },
      { type: "brand", op: "override", path: "mate-name", value: "小栖" },
    ]));
    const biz = mergeOverlay(view(), doc([
      { type: "persona", op: "override", path: "service-front/tone", value: "克制商务风：称呼姓氏+先生/女士" },
      { type: "threshold", op: "override", path: "approval/refund-credits", value: 800, bounds: { min: 0, max: 2000 } },
      { type: "brand", op: "override", path: "mate-name", value: "云管家" },
    ]));

    // 分化断言
    expect((family.assets.extra["service-front"] as Record<string, unknown>).tone as string).toContain("亲子");
    expect((biz.assets.extra["service-front"] as Record<string, unknown>).tone as string).toContain("商务");
    expect(kbEntriesOf(family.assets, "faq").some((e) => e.q === "有儿童拖鞋吗？")).toBe(true);
    expect(kbEntriesOf(biz.assets, "faq").some((e) => e.q === "有儿童拖鞋吗？")).toBe(false);
    expect(thresholdOf(biz.assets, "approval/refund-credits")).toBe(800);
    expect(thresholdOf(family.assets, "approval/refund-credits")).toBeUndefined();
    // 品牌落入 bundle.json workloom.brand
    const famBrand = (family.assets.bj.workloom as Record<string, unknown>).brand as Record<string, unknown>;
    const bizBrand = (biz.assets.bj.workloom as Record<string, unknown>).brand as Record<string, unknown>;
    expect(famBrand["mate-name"]).toBe("小栖");
    expect(bizBrand["mate-name"]).toBe("云管家");
    // 真实酒店包的 preset 可以被租户停用
    const presetKey = view().presets[0]?.preset_key as string;
    const noMarket = mergeOverlay(view(), doc([{ type: "crew", op: "disable", path: `presets/${presetKey}` }]));
    expect(isPresetDisabled(noMarket.assets, presetKey)).toBe(true);
  });
});
