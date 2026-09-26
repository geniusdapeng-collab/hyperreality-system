/**
 * 织球映射层单测：全部走真实信号形状，逐分支覆盖（无随机、无时间依赖——now 显式注入）。
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_MS,
  emotionLabelOf,
  emotionOfAgent,
  emotionOfRun,
  emotionOfSystem,
  emotionOfThread,
  emotionToneOf,
  type AgentStatusSignal,
} from "./agent-emotion";
import { WORKLOOM_EMOTION_IDS } from "./emotions-workloom";

const NOW = Date.parse("2026-09-27T00:00:00+08:00");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const agent = (patch: Partial<AgentStatusSignal> = {}): AgentStatusSignal => ({
  status: "ready",
  invalidReason: null,
  readonly: false,
  nightShift: false,
  online: false,
  lastAction: null,
  lastActionAt: null,
  pendingApprovals: 0,
  blockedRecent: 0,
  ...patch,
});

describe("emotionOfAgent（名册）", () => {
  it("无信号 = 待机：绝不假装在干活", () => {
    expect(emotionOfAgent(agent(), NOW)).toBe("02");
  });

  it("岗位配置校验失败优先报错", () => {
    expect(emotionOfAgent(agent({ status: "invalid", pendingApprovals: 2 }), NOW)).toBe("34");
  });

  it("有待审批单 → 51 待审批（先等人拍板，再谈别的）", () => {
    expect(emotionOfAgent(agent({ pendingApprovals: 1, lastAction: "video.publish", lastActionAt: ago(1000) }), NOW))
      .toBe(WORKLOOM_EMOTION_IDS.awaitingApproval);
  });

  it("近 1h 被围栏阻断 → 34 出错", () => {
    expect(emotionOfAgent(agent({ blockedRecent: 3 }), NOW)).toBe("34");
  });

  it("90s 内动作按族分类：渲染 / 检索 / 输出 / 其他", () => {
    expect(emotionOfAgent(agent({ lastAction: "render.submit", lastActionAt: ago(5_000) }), NOW))
      .toBe(WORKLOOM_EMOTION_IDS.rendering);
    expect(emotionOfAgent(agent({ lastAction: "subtitlewrite.burn", lastActionAt: ago(5_000) }), NOW))
      .toBe(WORKLOOM_EMOTION_IDS.rendering);
    expect(emotionOfAgent(agent({ lastAction: "intel.collect", lastActionAt: ago(5_000) }), NOW)).toBe("40");
    expect(emotionOfAgent(agent({ lastAction: "geo.publish", lastActionAt: ago(5_000) }), NOW)).toBe("39");
    expect(emotionOfAgent(agent({ lastAction: "ceo.decision", lastActionAt: ago(5_000) }), NOW)).toBe("32");
  });

  it("动作超出 90s 窗口即回落（不拿旧动作当现在）", () => {
    expect(emotionOfAgent(agent({ lastAction: "render.submit", lastActionAt: ago(ACTIVE_WINDOW_MS + 1_000) }), NOW)).toBe("02");
    expect(emotionOfAgent(agent({ lastAction: "render.submit", lastActionAt: "不是时间" }), NOW)).toBe("02");
  });

  it("夜班窗口内在线 → 52 夜班值守", () => {
    expect(emotionOfAgent(agent({ nightShift: true, online: true }), NOW)).toBe(WORKLOOM_EMOTION_IDS.nightWatch);
    expect(emotionOfAgent(agent({ nightShift: true, online: false }), NOW)).toBe("02");
  });
});

describe("emotionOfRun（视频 run）", () => {
  it("空 run = 待机；四态各有映射", () => {
    expect(emotionOfRun(null)).toBe("02");
    expect(emotionOfRun({ status: "running" })).toBe("32");
    expect(emotionOfRun({ status: "running", currentGate: "G9" })).toBe(WORKLOOM_EMOTION_IDS.awaitingApproval);
    expect(emotionOfRun({ status: "running", currentGate: "G3" })).toBe("32");
    expect(emotionOfRun({ status: "awaiting_approval" })).toBe(WORKLOOM_EMOTION_IDS.awaitingApproval);
    expect(emotionOfRun({ status: "finished" })).toBe("33");
    expect(emotionOfRun({ status: "failed" })).toBe("34");
    expect(emotionOfRun({ status: "未知" })).toBe("02");
  });
});

describe("emotionOfSystem（织伴 mini）", () => {
  const sys = (patch = {}) => ({ activeRuns: 0, awaitingApprovals: 0, recentFailure: false, quietHours: false, ...patch });

  it("优先级：报丧 > 待拍板 > 在干活 > 夜班 > 待机", () => {
    expect(emotionOfSystem(sys({ recentFailure: true, awaitingApprovals: 5, activeRuns: 9 }))).toBe("34");
    expect(emotionOfSystem(sys({ awaitingApprovals: 1, activeRuns: 9 }))).toBe(WORKLOOM_EMOTION_IDS.awaitingApproval);
    expect(emotionOfSystem(sys({ activeRuns: 2 }))).toBe("32");
    expect(emotionOfSystem(sys({ quietHours: true }))).toBe(WORKLOOM_EMOTION_IDS.nightWatch);
    expect(emotionOfSystem(sys())).toBe("02");
  });
});

describe("emotionOfThread（P2 任务页）", () => {
  it("pending_review 待人审；运行/完成/失败/草稿各归其位", () => {
    expect(emotionOfThread({ status: "pending_review", awaitingApproval: false })).toBe(WORKLOOM_EMOTION_IDS.awaitingApproval);
    expect(emotionOfThread({ status: "running", awaitingApproval: false })).toBe("32");
    expect(emotionOfThread({ status: "completed", awaitingApproval: false })).toBe("33");
    expect(emotionOfThread({ status: "failed", awaitingApproval: false })).toBe("34");
    expect(emotionOfThread({ status: "draft", awaitingApproval: false })).toBe("02");
    expect(emotionOfThread({ status: "draft", awaitingApproval: true })).toBe(WORKLOOM_EMOTION_IDS.awaitingApproval);
  });
});

describe("文字与色档（球 aria-hidden，语义靠文字）", () => {
  it("每个映射结果都有中文文案与语义色档", () => {
    const ids = ["02", "32", "33", "34", "39", "40", WORKLOOM_EMOTION_IDS.rendering, WORKLOOM_EMOTION_IDS.awaitingApproval, WORKLOOM_EMOTION_IDS.nightWatch];
    for (const id of ids) {
      expect(emotionLabelOf(id)).not.toBe("");
    }
    expect(emotionToneOf("02")).toBe("idle");
    expect(ids.filter((id) => id !== "02").filter((id) => emotionToneOf(id) === "idle")).toEqual([]);
    expect(emotionLabelOf("unknown-id")).toBe("待机");
    expect(emotionToneOf("unknown-id")).toBe("idle");
  });
});
