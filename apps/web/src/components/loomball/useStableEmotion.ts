/**
 * 织球 LoomBall · 表情驻留（防「神经质」抖动）
 *
 * 名册 10s / 织伴 20s 轮询，服务端信号在边界附近来回跳时（例如刚跑完的任务与下一条动作之间），
 * 球不应该跟着抽搐。规则：
 *  - 普通切换最小驻留 `minDwellMs`（默认 1.5s）；
 *  - 出错（34）**立即生效**（报丧优先），且驻留 `FAILURE_HOLD_MS` 后允许被别的状态覆盖；
 *  - 相同状态不重置计时（避免长期状态每拍刷新把驻留窗口无限延后）。
 *
 * 纯函数 `nextStableEmotion` 承担全部判定，React hook 只是薄壳（可单测、可复用）。
 */
import { useEffect, useRef, useState } from "react";
import type { LoomBallEmotionId } from "../../vendor/loomball";

export const MIN_DWELL_MS = 1500;
/** 出错态驻留：让主人有足够时间看见（一小节拍） */
export const FAILURE_HOLD_MS = 6000;

export interface EmotionDwellState {
  emotion: LoomBallEmotionId;
  since: number;
}

export function nextStableEmotion(
  prev: EmotionDwellState,
  next: LoomBallEmotionId,
  now: number,
  minDwellMs: number = MIN_DWELL_MS,
): EmotionDwellState {
  if (String(prev.emotion) === String(next)) return prev;              // 同状态：保持计时
  const isFailureNext = String(next) === "34";
  const isFailurePrev = String(prev.emotion) === "34";
  if (isFailureNext) return { emotion: next, since: now };            // 报丧立即生效
  const held = now - prev.since;
  if (isFailurePrev) {
    return held >= FAILURE_HOLD_MS ? { emotion: next, since: now } : prev;
  }
  return held >= minDwellMs ? { emotion: next, since: now } : prev;
}

/** React 薄壳：把高频信号收敛成有驻留的表情（now 由 Date.now() 提供，保持可测的纯函数在上一文件） */
export function useStableEmotion(next: LoomBallEmotionId, options?: { minDwellMs?: number }): LoomBallEmotionId {
  const minDwellMs = options?.minDwellMs ?? MIN_DWELL_MS;
  const stateRef = useRef<EmotionDwellState>({ emotion: next, since: Date.now() });
  const [, force] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const applied = nextStableEmotion(stateRef.current, next, now, minDwellMs);
    if (applied !== stateRef.current) {
      stateRef.current = applied;
      force((value) => value + 1); // 收敛成功：触发一次重渲染把新表情交给引擎
      return;
    }
    if (String(stateRef.current.emotion) === String(next)) return; // 已在目标态：无需定时
    // 被驻留挡住时挂一个定时器，窗口一到再收敛（保证状态最终一致，不永久卡住）
    const holdMs = String(stateRef.current.emotion) === "34" ? FAILURE_HOLD_MS : minDwellMs;
    const wait = holdMs - (now - stateRef.current.since);
    if (wait <= 0) return;
    const timer = window.setTimeout(() => {
      const again = nextStableEmotion(stateRef.current, next, Date.now(), minDwellMs);
      if (again !== stateRef.current) {
        stateRef.current = again;
        force((value) => value + 1);
      }
    }, wait);
    return () => window.clearTimeout(timer);
  }, [next, minDwellMs]);

  return stateRef.current.emotion;
}
