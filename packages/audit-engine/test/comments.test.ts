/**
 * 评论与口碑线单测：负面未处理 / 高意向咨询 / 敏感词 / 高频问题。
 */
import { describe, expect, it } from "vitest";
import { analyzeComments } from "../src/analyzers/comments.js";
import { baseAccount, baseComment, emptySnapshot, hoursAgo, NOW } from "./helpers.js";

const ctx = { now: NOW };
const acc = baseAccount();

describe("评论与口碑线 · 负面评论未处理", () => {
  it("负面评论 30h 未处理 → P1", () => {
    const s = emptySnapshot({
      accounts: [acc],
      comments: [baseComment({ commentId: "c-neg", text: "产品太差了体验很糟糕", sentiment: "negative", createdAt: hoursAgo(30) })],
    });
    const f = analyzeComments(s, ctx).find((x) => x.title.includes("负面评论"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.result).toBe("30h > 24h");
  });

  it("负面评论 80h 未处理 → P0（舆情发酵区）", () => {
    const s = emptySnapshot({
      accounts: [acc],
      comments: [baseComment({ text: "质量有问题态度还差", sentiment: "negative", createdAt: hoursAgo(80) })],
    });
    expect(analyzeComments(s, ctx).find((x) => x.title.includes("负面评论"))!.severity).toBe("P0");
  });

  it("负面评论已回复 → 不报", () => {
    const s = emptySnapshot({
      accounts: [acc],
      comments: [baseComment({ text: "不太满意这次体验", sentiment: "negative", createdAt: hoursAgo(90), repliedAt: hoursAgo(80) })],
    });
    expect(analyzeComments(s, ctx)).toHaveLength(0);
  });
});

describe("评论与口碑线 · 高意向咨询未回复", () => {
  it("高意向咨询 18h 未回 → P1，线索流失 0.5 条（baseline）", () => {
    const s = emptySnapshot({
      accounts: [acc],
      comments: [baseComment({ commentId: "c-inq", text: "这个怎么买多少钱", isInquiry: true, sentiment: "neutral", createdAt: hoursAgo(18) })],
    });
    const f = analyzeComments(s, ctx).find((x) => x.title.includes("高意向咨询"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.estimatedImpact?.amount).toBe(0.5);
    expect(f!.estimatedImpact?.currency).toBe("LEADS");
    expect(f!.estimatedImpact?.confidence).toBe("baseline");
  });

  it("高意向咨询 50h 未回 → P0（线索已凉）", () => {
    const s = emptySnapshot({
      accounts: [acc],
      comments: [baseComment({ text: "求链接哪里下单", isInquiry: true, sentiment: "neutral", createdAt: hoursAgo(50) })],
    });
    expect(analyzeComments(s, ctx).find((x) => x.title.includes("高意向咨询"))!.severity).toBe("P0");
  });

  it("高意向咨询 12h 内 → 不报", () => {
    const s = emptySnapshot({
      accounts: [acc],
      comments: [baseComment({ text: "还有货吗想买", isInquiry: true, sentiment: "neutral", createdAt: hoursAgo(11) })],
    });
    expect(analyzeComments(s, ctx)).toHaveLength(0);
  });
});

describe("评论与口碑线 · 敏感词与高频问题", () => {
  it("命中内置敏感词（投诉）未处置 → P0，不分时长", () => {
    const s = emptySnapshot({
      accounts: [acc],
      comments: [baseComment({ text: "再不解决我就去投诉平台", sentiment: "neutral", createdAt: hoursAgo(2) })],
    });
    const f = analyzeComments(s, ctx).find((x) => x.title.includes("敏感词"));
    expect(f!.severity).toBe("P0");
  });

  it("命中客户自带敏感词 → P0；平台标记 hasSensitiveWord → P0", () => {
    const s = emptySnapshot({
      accounts: [acc],
      sensitiveWords: ["退钱"],
      comments: [
        baseComment({ commentId: "c-1", text: "不退钱我就曝光", sentiment: "neutral", createdAt: hoursAgo(3) }),
        baseComment({ commentId: "c-2", text: "随便一句话而已", sentiment: "neutral", hasSensitiveWord: true, createdAt: hoursAgo(4) }),
      ],
    });
    const fs = analyzeComments(s, ctx).filter((x) => x.title.includes("敏感词"));
    expect(fs).toHaveLength(2);
    expect(fs.every((f) => f.severity === "P0")).toBe(true);
  });

  it("近 30 天同问题 ≥3 次 → P2（沉淀选题库）", () => {
    const comments = Array.from({ length: 3 }, (_, i) =>
      baseComment({ commentId: `c-q${i}`, text: "油皮适合用这款吗", createdAt: hoursAgo(10 + i), repliedAt: hoursAgo(5 + i) }),
    );
    const s = emptySnapshot({ accounts: [acc], comments });
    const f = analyzeComments(s, ctx).find((x) => x.title.includes("高频问题"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P2");
    expect(f!.calculation.result).toBe("3 ≥ 3");
  });
});
