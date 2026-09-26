/** 织球 LoomBall · 桶导出（业务方只从这里引入） */
export { LoomBall, loomBallBrandSkin, eyeScaleFor, type LoomBallProps } from "./LoomBall";
export {
  ACTIVE_WINDOW_MS,
  EMOTION_LABEL,
  FAILURE_WINDOW_MS,
  TONE_CLASS,
  emotionLabelOf,
  emotionOfAgent,
  emotionOfRun,
  emotionOfSystem,
  emotionOfThread,
  emotionToneOf,
  type AgentStatusSignal,
  type EmotionTone,
  type RunStatusSignal,
  type SystemStatusSignal,
  type ThreadStatusSignal,
} from "./agent-emotion";
export { MIN_DWELL_MS, FAILURE_HOLD_MS, nextStableEmotion, useStableEmotion, type EmotionDwellState } from "./useStableEmotion";
export { WORKLOOM_EMOTION_IDS, WORKLOOM_EMOTIONS } from "./emotions-workloom";
export { ensureLoomBallEngine, loomBallEnabled, type LoomBallEngineInit } from "./engine";
