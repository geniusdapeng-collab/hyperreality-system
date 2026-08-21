/**
 * opening-cinematic — 通用片头电影级设计系统
 *
 * 模块地图：
 * title-animation-library 标题动效库（10 种模式 × 秒级节拍表）
 * typography-designer     字体排印引擎（结构×材质×光照×动态）
 * character-entrance-designer 角色入场编舞（前兆/登场/定格）
 * opening-audio-architect 音效架构（五层 + 画面同步表）
 * opening-cinematic-agent LLM 总编排（创意决策 + 方案编译）
 *
 * 快速上手：
 * const { OpeningCinematicAgent } = require('./opening-cinematic');
 * const agent = new OpeningCinematicAgent({ llmTimeout: 180000 });
 * const { plan, promptTimeline, postProduction } = await agent.process(blueprint, { durationSec: 8 });
 */

const { OpeningCinematicAgent, PLAN_SCHEMA } = require('./opening-cinematic-agent');
const titleAnimation = require('./title-animation-library');
const typography = require('./typography-designer');
const entrance = require('./character-entrance-designer');
const audio = require('./opening-audio-architect');

module.exports = {
  OpeningCinematicAgent,
  PLAN_SCHEMA,
  // 子库（可独立使用）
  titleAnimation,
  typography,
  entrance,
  audio
};
