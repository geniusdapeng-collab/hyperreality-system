/**
 * 织球 LoomBall · 引擎生命周期（一次初始化 + 幂等注册）
 *
 * 为什么单独一层：上游注册表（`config.register`）在引擎脚本求值后才存在，
 * 而 React 组件可能被 StrictMode 双调用、被多页面并发挂载。
 * 这里用「模块级一次性初始化 + 结果可见」替代组件内的布尔标志：
 *  - 初始化失败必须能被看到（抛错或 console.error 带具体 id/errors），不静默降级；
 *  - 初始化幂等：重复调用返回同一结果，不重复注册（重复注册会覆盖注册表项）。
 */
import { loomBallEngine, registerEmotion, emotionCount, type EmotionRegisterResult } from "../../vendor/loomball";
import { WORKLOOM_EMOTIONS } from "./emotions-workloom";

/** 织球总开关：`VITE_LOOMBALL=0` 一键回退到既有静态形象（默认开）。 */
export const loomBallEnabled: boolean = (import.meta.env.VITE_LOOMBALL ?? "1") !== "0";

export interface LoomBallEngineInit {
  enabled: boolean;
  registered: EmotionRegisterResult[];
  emotionCount: number;
}

let init: LoomBallEngineInit | null = null;

/**
 * 确保引擎可用且 WorkLoom 自定义表情已注册。
 * 关闭开关时不做任何初始化（零帧成本、零副作用）。
 */
export function ensureLoomBallEngine(): LoomBallEngineInit {
  if (init) return init;
  if (!loomBallEnabled) {
    init = { enabled: false, registered: [], emotionCount: 0 };
    return init;
  }
  const registered = WORKLOOM_EMOTIONS.map((emotion) => registerEmotion(emotion));
  const failed = registered.filter((result) => !result.ok);
  if (failed.length > 0) {
    // 注册失败不静默：表情 ID 是契约，缺失会让状态球停在待机态（假状态）。
    console.error(
      "[LoomBall] 自定义工作状态表情注册失败：",
      failed.map((result) => `${result.id ?? "?"}: ${(result.errors ?? []).join("；")}`).join(" | "),
    );
  }
  init = { enabled: true, registered, emotionCount: emotionCount() };
  return init;
}

/** 运行期引擎句柄（仅组件内部使用；调用前必须先 ensureLoomBallEngine） */
export function loomBallApi() {
  return loomBallEngine;
}
