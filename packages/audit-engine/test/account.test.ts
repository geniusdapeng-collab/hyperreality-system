/**
 * 账号健康线单测：限流信号 / 违规与敏感操作 / 资料完整度 / 矩阵搬运。
 */
import { describe, expect, it } from "vitest";
import { analyzeAccount, LIMIT_STREAK_P0 } from "../src/analyzers/account.js";
import type { AuditSnapshot } from "../src/types.js";
import { baseAccount, baseVideo, daysAgo, emptySnapshot, NOW } from "./helpers.js";

const ctx = { now: NOW };

/** 构造限流场景：n 条老视频基准 10000，streak 条新视频播放 3000 */
function limitFlowSnapshot(streak: number): AuditSnapshot {
  const old = Array.from({ length: 6 }, (_, i) =>
    baseVideo({ videoId: `old-${i}`, publishedAt: daysAgo(10 + i), plays: 10000 }),
  );
  const recent = Array.from({ length: streak }, (_, i) =>
    baseVideo({ videoId: `new-${i}`, publishedAt: daysAgo(i + 1), plays: 3000 }),
  );
  return emptySnapshot({ accounts: [baseAccount()], videos: [...old, ...recent] });
}

describe("账号健康线 · 限流风险信号", () => {
  it("连续 3 条播放 < 基准 50% → P1，播放缺口×0.3% 估算涨粉损失", () => {
    const fs = analyzeAccount(limitFlowSnapshot(3), ctx);
    const f = fs.find((x) => x.title.includes("疑似限流"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.inputs["streak"]).toBe(3);
    expect(f!.calculation.inputs["baseline"]).toBe(10000);
    // 缺口 3×(10000−3000)=21000 × 0.003 = 63 FANS
    expect(f!.estimatedImpact?.amount).toBe(63);
    expect(f!.estimatedImpact?.currency).toBe("FANS");
    expect(f!.estimatedImpact?.confidence).toBe("baseline");
  });

  it(`连续 ${LIMIT_STREAK_P0} 条 → 升级 P0`, () => {
    const fs = analyzeAccount(limitFlowSnapshot(LIMIT_STREAK_P0), ctx);
    expect(fs.find((x) => x.title.includes("疑似限流"))!.severity).toBe("P0");
  });

  it("连续 2 条不达标 → 不报", () => {
    const fs = analyzeAccount(limitFlowSnapshot(2), ctx);
    expect(fs.find((x) => x.title.includes("疑似限流"))).toBeUndefined();
  });

  it("中间一条播放恢复 → 连击中断不报", () => {
    const s = limitFlowSnapshot(3);
    s.videos.find((v) => v.videoId === "new-1")!.plays = 9000;
    const fs = analyzeAccount(s, ctx);
    expect(fs.find((x) => x.title.includes("疑似限流"))).toBeUndefined();
  });
});

describe("账号健康线 · 违规记录与敏感操作", () => {
  it("90 天内 major 违规 → P0；minor → P1；warning → P2", () => {
    const s = emptySnapshot({
      accounts: [
        baseAccount({
          violations: [
            { violationId: "vio-1", type: "搬运判定", occurredAt: daysAgo(10), level: "major" },
            { violationId: "vio-2", type: "导流警告", occurredAt: daysAgo(20), level: "minor" },
            { violationId: "vio-3", type: "标题党", occurredAt: daysAgo(30), level: "warning" },
          ],
        }),
      ],
      videos: [baseVideo()],
    });
    const fs = analyzeAccount(s, ctx);
    expect(fs.find((x) => x.title.includes("搬运判定"))!.severity).toBe("P0");
    expect(fs.find((x) => x.title.includes("导流警告"))!.severity).toBe("P1");
    expect(fs.find((x) => x.title.includes("标题党"))!.severity).toBe("P2");
  });

  it("超 90 天的违规不追溯", () => {
    const s = emptySnapshot({
      accounts: [baseAccount({ violations: [{ violationId: "vio-old", type: "搬运判定", occurredAt: daysAgo(120), level: "major" }] })],
      videos: [baseVideo()],
    });
    expect(analyzeAccount(s, ctx).find((x) => x.title.includes("搬运判定"))).toBeUndefined();
  });

  it("近 30 天敏感操作 ≥3 次 → P1", () => {
    const s = emptySnapshot({ accounts: [baseAccount({ sensitiveOps30d: 4 })], videos: [baseVideo()] });
    const f = analyzeAccount(s, ctx).find((x) => x.title.includes("敏感操作"));
    expect(f!.severity).toBe("P1");
  });
});

describe("账号健康线 · 资料完整度与矩阵搬运", () => {
  it("缺头像/简介 → P2 且列出缺失项", () => {
    const s = emptySnapshot({
      accounts: [baseAccount({ profile: { avatar: false, bio: false, showcase: true, booking: true, contact: true } })],
      videos: [baseVideo()],
    });
    const f = analyzeAccount(s, ctx).find((x) => x.title.includes("资料不完整"));
    expect(f!.severity).toBe("P2");
    expect(f!.title).toContain("头像");
    expect(f!.title).toContain("简介");
  });

  it("同 contentHash 多号发布 → 首发之外账号记 P1", () => {
    const s = emptySnapshot({
      accounts: [baseAccount(), baseAccount({ accountId: "acc-2", accountName: "矩阵小号" })],
      videos: [
        baseVideo({ videoId: "v-origin", contentHash: "hash-abc", publishedAt: daysAgo(5) }),
        baseVideo({ videoId: "v-dup", accountId: "acc-2", contentHash: "hash-abc", publishedAt: daysAgo(3) }),
      ],
    });
    const fs = analyzeAccount(s, ctx);
    const f = fs.find((x) => x.title.includes("重复发布"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.accountId).toBe("acc-2");
    expect(f!.calculation.inputs["originAccount"]).toBe("acc-1");
  });

  it("同 hash 同账号自发 → 不报", () => {
    const s = emptySnapshot({
      accounts: [baseAccount()],
      videos: [
        baseVideo({ videoId: "v-a", contentHash: "hash-x", publishedAt: daysAgo(5) }),
        baseVideo({ videoId: "v-b", contentHash: "hash-x", publishedAt: daysAgo(3) }),
      ],
    });
    expect(analyzeAccount(s, ctx).find((x) => x.title.includes("重复发布"))).toBeUndefined();
  });
});
