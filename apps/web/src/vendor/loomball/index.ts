/**
 * 织球 LoomBall · vendor 适配层（引擎桥）
 *
 * 上游：grok-ball（MIT，tycoding，https://github.com/tycoding/grok-ball，commit 见 ./PINNED）。
 * 纪律：
 *  1. `grok-ball.js` / `grok-ball.ts` / `LICENSE` 为上游**原样**文件（逐字节），升级必须走评审并重跑
 *     「表情巡展 + 映射单测」（见 docs/loomball.md）；
 *  2. 品牌：产品内一律叫「织球 LoomBall」；上游兼容门面 `window.GrokBall` 在本模块捕获后即删除，
 *     不再暴露为全局标识（引擎真实名 `window.EmotionBall` 保留，供引擎自身与巡展页使用）；
 *  3. 业务代码只从这里取引擎 API 与类型，不允许直接 import `grok-ball.js`（单一入口，便于升级）。
 */
import "./grok-ball.js";
import type {
  EmotionId,
  GrokBallCreateOptions,
  GrokBallEngine,
  GrokBallStatic,
} from "./grok-ball.js";

export type { EmotionId, GrokBallCreateOptions, GrokBallEngine, GrokBallStatic };
/**
 * 对外（业务层）类型别名：业务代码只认 LoomBall 命名，上游名字留在 vendor 内部。
 * 这样仓库的「零上游商标」闸门（components/loomball/provenance.test.ts）才能覆盖业务代码。
 */
export type LoomBallEmotionId = EmotionId;
export type LoomBallEngine = GrokBallEngine;
export type LoomBallCreateOptions = GrokBallCreateOptions;
export type LoomBallEngineApi = GrokBallStatic;
/** 引擎自定义表情注册结果（上游 `config.register` 的真实返回形状） */
export interface EmotionRegisterResult {
  ok: boolean;
  id?: string;
  errors?: string[];
}

/** 上游兼容门面：捕获后立刻删除全局，业务代码不再接触上游商标名。 */
function takeEngine(): GrokBallStatic {
  const api = window.GrokBall;
  if (!api) throw new Error("织球引擎未载入：vendor/loomball/grok-ball.js 未执行");
  delete (window as { GrokBall?: GrokBallStatic }).GrokBall;
  return api;
}

/** 引擎 API（本模块求值即完成捕获；`window.EmotionBall` 为引擎真实全局名） */
export const loomBallEngine: GrokBallStatic = takeEngine();

/** 注册一个自定义表情（类型化薄封装，返回值不吞错） */
export function registerEmotion(config: unknown): EmotionRegisterResult {
  const result = loomBallEngine.config.register(config) as EmotionRegisterResult | null | undefined;
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    return { ok: false, id: (config as { id?: string } | null)?.id, errors: ["注册表返回了非法结果"] };
  }
  return result;
}

/** 当前引擎内已注册的表情数（含自定义） */
export function emotionCount(): number {
  return loomBallEngine.config.list().length;
}
