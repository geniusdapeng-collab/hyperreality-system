/**
 * 织球 LoomBall · 状态 → 表情映射层（**唯一事实源**）
 *
 * 三条铁律：
 *  1. **只映射真实信号**：输入全部来自事件账本 / approvals / studio run 注册表的真实投影，
 *     没有信号就回落到「待机放空」（02），绝不用随机数或计时器假装在干活；
 *  2. **文字与球同源**：名册卡的文案 chip（`emotionLabelOf`）与球的表情由同一个 signal 派生，
 *     不允许出现「球在忙、文字说待命」；
 *  3. **改这里就要改三处走查**：P8 名册 / 织伴 mini / P2 线程（见 docs/loomball.md 映射表）。
 */
import type { LoomBallEmotionId } from "../../vendor/loomball";
import { WORKLOOM_EMOTION_IDS } from "./emotions-workloom";

/** 近期动作生效窗口：窗口内视为「正在干活」（服务端名册 10s 轮询，90s 足够覆盖一拍） */
export const ACTIVE_WINDOW_MS = 90_000;
/** 失败/阻断信号窗口：近 1 小时内的阻断事件视为「出错」（驻留由 useStableEmotion 负责） */
export const FAILURE_WINDOW_MS = 3_600_000;

/** 名册信号（apps/server/src/trpc/router.ts rosterRouter.list 投影） */
export interface AgentStatusSignal {
  /** agents.status：ready / invalid */
  status: string;
  /** preset 校验失败原因（status=invalid 时非空） */
  invalidReason?: string | null;
  readonly: boolean;
  /** 夜班岗位（meta.night_shift） */
  nightShift: boolean;
  /** 夜班窗口内自动上线（服务端口径，不伪造 presence） */
  online: boolean;
  /** 最近一条事件的动作码（biz_events.decision.action） */
  lastAction: string | null;
  /** 最近一条事件时间（ISO；无事件为 null） */
  lastActionAt: string | null;
  /** 该岗位当前挂起的审批数（approvals.status='pending'） */
  pendingApprovals: number;
  /** 近 1 小时被围栏阻断的事件数（rule_impact.result='blocked'） */
  blockedRecent: number;
}

/** 视频 run 状态（apps/server/src/video/router.ts studio.status 投影） */
export interface RunStatusSignal {
  status: string;
  currentGate?: string | null;
}

/** 全局系统信号（织伴 mini 态：studio.active 聚合 + 收件箱 + 勿扰时段） */
export interface SystemStatusSignal {
  activeRuns: number;
  awaitingApprovals: number;
  recentFailure: boolean;
  quietHours: boolean;
}

/** 线程信号（P2 任务页：threads.detail 投影 + 最近事件） */
export interface ThreadStatusSignal {
  status: string;
  awaitingApproval: boolean;
}

/** 渲染/合成类动作：长耗时产出工位 */
const RENDER_ACTION = /(render|gen\.|gen_|bgmwrite|subtitlewrite|colorwrite|visualwrite|produce|compose|mix|grade|burn)/i;
/** 情报/检索类动作：取证与调研 */
const RESEARCH_ACTION = /(intel|research|search|collect|scan|retrieve|lookup|probe|inspect)/i;
/** 对外输出类动作：发布、回复、提交 */
const OUTPUT_ACTION = /(publish|reply|comment|post|send|submit|draft|deliver|export)/i;

function withinWindow(iso: string | null, now: number, windowMs: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  return now - at <= windowMs && now - at >= -60_000; // 允许 1 分钟时钟漂移
}

/**
 * 数字员工卡（名册）→ 表情。
 * 优先级：配置校验失败 > 待审批 > 近 1h 被阻断 > 90s 内动作族 > 夜班值守 > 待机。
 */
export function emotionOfAgent(agent: AgentStatusSignal, now: number = Date.now()): LoomBallEmotionId {
  if (agent.status === "invalid") return "34";                       // 岗位配置校验失败：写操作被阻断
  if (agent.pendingApprovals > 0) return WORKLOOM_EMOTION_IDS.awaitingApproval;
  if (agent.blockedRecent > 0) return "34";                          // 围栏拦下了动作，需要人看
  if (withinWindow(agent.lastActionAt, now, ACTIVE_WINDOW_MS)) {
    const action = agent.lastAction ?? "";
    if (RENDER_ACTION.test(action)) return WORKLOOM_EMOTION_IDS.rendering;
    if (RESEARCH_ACTION.test(action)) return "40";
    if (OUTPUT_ACTION.test(action)) return "39";
    return "32";                                                     // 其他近期动作：处理中忙碌
  }
  if (agent.nightShift && agent.online) return WORKLOOM_EMOTION_IDS.nightWatch;
  return "02";                                                       // 待机放空（无信号即无表演）
}

/** 花钱/对外发布门：停在这三档门上的 run 视为「等人拍板」 */
const APPROVAL_GATES = new Set(["G8", "G9", "G10"]);

/** 视频 run（预生产/渲染/发布）→ 表情 */
export function emotionOfRun(run: RunStatusSignal | null): LoomBallEmotionId {
  if (!run) return "02";
  switch (run.status) {
    case "running":
      return run.currentGate && APPROVAL_GATES.has(run.currentGate)
        ? WORKLOOM_EMOTION_IDS.awaitingApproval
        : "32";
    case "awaiting_approval":
      return WORKLOOM_EMOTION_IDS.awaitingApproval;
    case "finished":
      return "33";
    case "failed":
      return "34";
    default:
      return "02";
  }
}

/**
 * 全局系统状态（织伴 mini 态）→ 表情。
 * 顺序即优先级：先报丧，再等我拍板，再看班组是否在干活，最后才是夜班与待机。
 */
export function emotionOfSystem(signal: SystemStatusSignal): LoomBallEmotionId {
  if (signal.recentFailure) return "34";
  if (signal.awaitingApprovals > 0) return WORKLOOM_EMOTION_IDS.awaitingApproval;
  if (signal.activeRuns > 0) return "32";
  if (signal.quietHours) return WORKLOOM_EMOTION_IDS.nightWatch;
  return "02";
}

/** 线程（P2 任务页）→ 表情 */
export function emotionOfThread(thread: ThreadStatusSignal): LoomBallEmotionId {
  // pending_review 是线程投影里真实存在的「待人审」状态（P2 左栏状态点同源）
  if (thread.awaitingApproval || thread.status === "pending_review") return WORKLOOM_EMOTION_IDS.awaitingApproval;
  switch (thread.status) {
    case "running":
    case "active":
    case "open":
      return "32";
    case "completed":
      return "33";
    case "failed":
      return "34";
    default:
      return "02";                                                     // draft / paused / 空态
  }
}

/** 表情 → 中文文案（球 aria-hidden，语义靠这行文字传达，也用于 tooltip） */
export const EMOTION_LABEL: Record<string, string> = {
  "02": "待机",
  "32": "处理中",
  "33": "已完成",
  "34": "出错",
  "39": "输出中",
  "40": "检索资料",
  [WORKLOOM_EMOTION_IDS.rendering]: "渲染中",
  [WORKLOOM_EMOTION_IDS.awaitingApproval]: "待审批",
  [WORKLOOM_EMOTION_IDS.nightWatch]: "夜班值守",
};

export function emotionLabelOf(emotion: LoomBallEmotionId): string {
  return EMOTION_LABEL[String(emotion)] ?? "待机";
}

/** 文案 chip 的语义色档（与球的表情同源） */
export type EmotionTone = "idle" | "busy" | "wait" | "error" | "done" | "night";

export function emotionToneOf(emotion: LoomBallEmotionId): EmotionTone {
  switch (String(emotion)) {
    case "34":
      return "error";
    case WORKLOOM_EMOTION_IDS.awaitingApproval:
      return "wait";
    case "33":
      return "done";
    case WORKLOOM_EMOTION_IDS.nightWatch:
      return "night";
    case "32":
    case "39":
    case "40":
    case WORKLOOM_EMOTION_IDS.rendering:
      return "busy";
    default:
      return "idle";
  }
}

/** chip 样式（Tailwind class 片段，供三处接入面共用，避免各写一份） */
export const TONE_CLASS: Record<EmotionTone, string> = {
  idle: "border-line bg-bg800/60 text-ink3",
  busy: "border-holo/40 bg-holo/10 text-holo",
  wait: "border-gold/50 bg-gold/12 text-goldhi",
  error: "border-alert/50 bg-alert/10 text-alert",
  done: "border-go/45 bg-go/10 text-go",
  night: "border-holo/30 bg-holo/8 text-holo",
};
