/**
 * 织球 LoomBall · WorkLoom 自定义工作状态表情（ID 段 50+ = 官方预留的自定义段）
 *
 * 纪律：
 *  1. 引擎**不支持继承/变体**（`config.register()` 只接受完整声明式配置，`validate()` 会校验
 *     id/name/group/anims，`normalize()` 再把缺省字段深合并成完整定义）——因此下面三条都是
 *     **完整定义**，不是「复用 39/35/00 的变体」；
 *  2. 只使用引擎已有的 25 组眼环（`pool` 索引 0..24）与既有动画原语
 *     （sine / pulse / jitter / scan / glance / blink），不新增几何、不改上游文件；
 *  3. 这三条是「工作状态」而非情绪表演，语义必须与映射层（agent-emotion.ts）一一对应。
 */

/** WorkLoom 自定义表情 ID（改动即契约变更：映射层、文档、走查清单三处必须同步） */
export const WORKLOOM_EMOTION_IDS = {
  /** 渲染/合成等长耗时产出中的工位 */
  rendering: "50",
  /** 等老板拍板（花钱、对外发布等高风险动作停在审批门） */
  awaitingApproval: "51",
  /** 夜班值守：安静但有岗（半闭眼 + 轻微 zzz） */
  nightWatch: "52",
} as const;

/** 渲染中：圆睁眼环轻微脉动，像进度条一节一节推进 */
export const EMOTION_RENDERING = {
  id: WORKLOOM_EMOTION_IDS.rendering,
  name: "渲染中",
  group: "agent",
  desc: "圆睁眼环随产出节奏轻微脉动，头微低，像盯着渲染进度",
  transition: 320,
  pool: [3, 21, 0],
  poolMs: [2200, 3600],
  blinkMs: [2400, 5200],
  body: { y: 2, breathe: 0.008, color: "#DDE7F5" },
  eyes: { both: { y: 1 } },
  anims: [
    { target: "eyes", prop: "scale", type: "pulse", amp: 0.08, period: 900 },
    { target: "body", prop: "y", type: "sine", amp: 1.4, period: 900 },
  ],
};

/** 待审批：上翻眼环定格 + 琥珀色球体，像把话头递到老板面前等回话 */
export const EMOTION_AWAITING_APPROVAL = {
  id: WORKLOOM_EMOTION_IDS.awaitingApproval,
  name: "待审批",
  group: "agent",
  desc: "眼睛上翻并缓慢扫读，球体转琥珀色——等你拍板，动作停在门口",
  transition: 420,
  pool: [10, 1],
  poolMs: [3200, 5200],
  blinkMs: [3200, 7000],
  body: { color: "#EFC169", breathe: 0.012 },
  eyes: { both: { y: -4 } },
  anims: [
    { target: "eyes", prop: "lookY", type: "sine", amp: 3, period: 2600 },
  ],
};

/** 夜班值守：半闭眼 + 轻微 zzz，表示「有岗但安静」 */
export const EMOTION_NIGHT_WATCH = {
  id: WORKLOOM_EMOTION_IDS.nightWatch,
  name: "夜班值守",
  group: "agent",
  desc: "半闭眼环 + 头顶轻微呼吸粒子，安静但有岗，只在有事时才叫醒你",
  transition: 700,
  gaze: false,
  pool: [13, 22, 4],
  poolMs: [6000, 10000],
  blinkMs: null,
  openness: 0.55,
  body: { y: 3, breathe: 0.006, zzz: 0.35 },
  eyes: { both: { y: 3 } },
  anims: [
    { target: "eyes", prop: "y", type: "sine", amp: 1.1, period: 4200 },
  ],
};

/** 注册清单（顺序固定，便于初始化结果逐条校验） */
export const WORKLOOM_EMOTIONS = [
  EMOTION_RENDERING,
  EMOTION_AWAITING_APPROVAL,
  EMOTION_NIGHT_WATCH,
] as const;
