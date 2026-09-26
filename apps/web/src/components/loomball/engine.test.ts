// @vitest-environment jsdom
/**
 * 引擎适配层契约：一次性初始化、三条自定义表情注册成功、上游门面不残留。
 * 这是「表情 ID 是契约」的闸门——注册失败必须让测试红，而不是让产品停在待机态。
 */
import { describe, expect, it } from "vitest";
import { ensureLoomBallEngine, loomBallApi, loomBallEnabled } from "./engine";
import { WORKLOOM_EMOTION_IDS } from "./emotions-workloom";

describe("织球引擎适配层", () => {
  it("默认开启（未显式关闭时不静默禁用）", () => {
    expect(loomBallEnabled).toBe(true);
  });

  it("初始化幂等：重复调用返回同一结果，不重复注册", () => {
    const first = ensureLoomBallEngine();
    const second = ensureLoomBallEngine();
    expect(second).toBe(first);
    expect(second.enabled).toBe(true);
  });

  it("三条自定义工作状态表情全部注册成功，且出现在注册表里", () => {
    const ready = ensureLoomBallEngine();
    expect(ready.registered.map((r) => r.ok)).toEqual([true, true, true]);
    expect(ready.registered.map((r) => r.id)).toEqual([
      WORKLOOM_EMOTION_IDS.rendering,
      WORKLOOM_EMOTION_IDS.awaitingApproval,
      WORKLOOM_EMOTION_IDS.nightWatch,
    ]);
    const ids = loomBallApi().config.list().map((item) => (item as { id?: string } | null)?.id);
    for (const id of Object.values(WORKLOOM_EMOTION_IDS)) expect(ids).toContain(id);
    // 上游 32 条 + 本仓 3 条
    expect(ready.emotionCount).toBeGreaterThanOrEqual(35);
  });

  it("品牌边界：上游兼容门面被删除，引擎真实名保留", () => {
    ensureLoomBallEngine();
    expect((window as { GrokBall?: unknown }).GrokBall).toBeUndefined();
    expect((window as { EmotionBall?: { version?: string } }).EmotionBall?.version).toBeTruthy();
  });
});
