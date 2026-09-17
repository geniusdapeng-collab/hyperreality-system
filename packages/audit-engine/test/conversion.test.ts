/**
 * 转化健康线单测：主页组件 / 私信自动回复 / 线索跟进断点 / 爆款挂载。
 */
import { describe, expect, it } from "vitest";
import { analyzeConversion } from "../src/analyzers/conversion.js";
import { baseAccount, baseLead, baseVideo, daysAgo, emptySnapshot, hoursAgo, NOW } from "./helpers.js";

const ctx = { now: NOW };

describe("转化健康线 · 主页转化组件", () => {
  it("橱窗/预约/联系方式全无 → P1（零承接），按粉丝×0.02% 估月度线索损失", () => {
    const s = emptySnapshot({
      accounts: [baseAccount({ followers: 12000, profile: { avatar: true, bio: true, showcase: false, booking: false, contact: false } })],
      videos: [baseVideo()],
    });
    const f = analyzeConversion(s, ctx).find((x) => x.title.includes("零转化组件"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    // 12000 × 0.0002 = 2.4 → 2 LEADS
    expect(f!.estimatedImpact?.amount).toBe(2);
    expect(f!.estimatedImpact?.period).toBe("monthly");
    expect(f!.estimatedImpact?.confidence).toBe("estimate");
  });

  it("缺 1-2 项 → P2", () => {
    const s = emptySnapshot({
      accounts: [baseAccount({ profile: { avatar: true, bio: true, showcase: true, booking: false, contact: false } })],
      videos: [baseVideo()],
    });
    const f = analyzeConversion(s, ctx).find((x) => x.title.includes("转化组件不全"));
    expect(f!.severity).toBe("P2");
  });

  it("组件齐全 → 不报", () => {
    const s = emptySnapshot({ accounts: [baseAccount()], videos: [baseVideo()] });
    expect(analyzeConversion(s, ctx).find((x) => x.title.includes("组件"))).toBeUndefined();
  });
});

describe("转化健康线 · 私信自动回复", () => {
  it("未配置 → P1；已配置但失效 → P1", () => {
    const s = emptySnapshot({
      accounts: [
        baseAccount({ accountId: "a1", accountName: "甲号", autoReply: { configured: false, active: false } }),
        baseAccount({ accountId: "a2", accountName: "乙号", autoReply: { configured: true, active: false } }),
      ],
      videos: [baseVideo(), baseVideo({ accountId: "a2", videoId: "v-2" })],
      leads: [baseLead({ accountId: "a1" })],
    });
    const fs = analyzeConversion(s, ctx);
    expect(fs.find((x) => x.title.includes("未配置"))!.severity).toBe("P1");
    expect(fs.find((x) => x.title.includes("已失效"))!.severity).toBe("P1");
  });

  it("autoReply 字段未采集 → 跳过不判", () => {
    const acc = baseAccount();
    delete acc.autoReply;
    const s = emptySnapshot({ accounts: [acc], videos: [baseVideo()] });
    expect(analyzeConversion(s, ctx).find((x) => x.title.includes("自动回复"))).toBeUndefined();
  });
});

describe("转化健康线 · 线索跟进断点与爆款挂载", () => {
  it("询盘 60h 未跟进 → P1，计 1 条线索流失", () => {
    const s = emptySnapshot({
      accounts: [baseAccount()],
      videos: [baseVideo()],
      leads: [baseLead({ leadId: "lead-x", inquiryAt: hoursAgo(60) })],
    });
    const f = analyzeConversion(s, ctx).find((x) => x.title.includes("跟进断点"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.result).toBe("60h > 48h");
    expect(f!.estimatedImpact?.amount).toBe(1);
    expect(f!.estimatedImpact?.currency).toBe("LEADS");
  });

  it("询盘 48h 内未跟进或已跟进 → 不报", () => {
    const s = emptySnapshot({
      accounts: [baseAccount()],
      videos: [baseVideo()],
      leads: [baseLead({ leadId: "l1", inquiryAt: hoursAgo(40) }), baseLead({ leadId: "l2", inquiryAt: hoursAgo(70), followedUpAt: hoursAgo(60) })],
    });
    expect(analyzeConversion(s, ctx).find((x) => x.title.includes("跟进断点"))).toBeUndefined();
  });

  it("爆款（≥3×基准）未挂组件 → P1，按播放×0.1% 估线索损失", () => {
    const videos = [
      ...Array.from({ length: 5 }, (_, i) => baseVideo({ videoId: `old-${i}`, publishedAt: daysAgo(10 + i), plays: 10000 })),
      baseVideo({ videoId: "hit", title: "现象级爆款", publishedAt: daysAgo(10), plays: 30000, hasConversionComponent: false }),
    ];
    const s = emptySnapshot({ accounts: [baseAccount()], videos });
    const f = analyzeConversion(s, ctx).find((x) => x.title.includes("爆款未挂转化组件"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    // 30000 × 0.001 = 30 LEADS
    expect(f!.estimatedImpact?.amount).toBe(30);
    expect(f!.estimatedImpact?.confidence).toBe("baseline");
  });

  it("爆款已挂组件 → 不报", () => {
    const videos = [
      ...Array.from({ length: 5 }, (_, i) => baseVideo({ videoId: `old-${i}`, publishedAt: daysAgo(10 + i), plays: 10000 })),
      baseVideo({ videoId: "hit", publishedAt: daysAgo(10), plays: 30000, hasConversionComponent: true }),
    ];
    const s = emptySnapshot({ accounts: [baseAccount()], videos });
    expect(analyzeConversion(s, ctx).find((x) => x.title.includes("爆款未挂"))).toBeUndefined();
  });
});
