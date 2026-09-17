// engines/script-engine/core/scene-type-normalizer.js
// Scene Type Normalizer - 场景类型归一化（全系统唯一真相源）
// 版本：v1.0 | 日期：2026-07-19
//
// 【背景 v2.1.22-fix 片头字段丢失】
// LLM 生成剧本时，会把模板 beats 的英雄之旅词汇（hook/setup/rising_action/...）
// 误用为 scene_type，导致下游 phase-1-scene-design._injectOpeningData
// （严格匹配 sceneType === 'opening'）静默跳过，片头 7 字段全部丢失。
// 本模块提供确定性归一化：任何来源的 scene_type 都在进入系统前被映射到标准五型，
// 并保证第一个场景恒为 opening（与系统"永远生成片头"的设计一致）。

'use strict';

/**
 * 标准场景类型白名单（系统唯一合法取值）
 */
const VALID_SCENE_TYPES = ['opening', 'establishing', 'conflict', 'emotional_climax', 'resolution'];

/**
 * 别名映射表：英雄之旅 / Save the Cat / 常见变体 / 中文 → 标准五型
 * key 一律小写
 */
const SCENE_TYPE_ALIAS_MAP = {
  // → opening（片头/开场）
  hook: 'opening',
  prologue: 'opening',
  intro: 'opening',
  introduction: 'opening',
  teaser: 'opening',
  cold_open: 'opening',
  coldopen: 'opening',
  opening: 'opening',
  title_card: 'opening',
  '片头': 'opening',
  '开场': 'opening',
  '引子': 'opening',

  // → establishing（建立/展开/铺垫）
  setup: 'establishing',
  exposition: 'establishing',
  establish: 'establishing',
  establishing: 'establishing',
  inciting_incident: 'establishing',
  catalyst: 'establishing',
  ordinary_world: 'establishing',
  call_to_adventure: 'establishing',
  '建立': 'establishing',
  '展开': 'establishing',
  '铺垫': 'establishing',

  // → conflict（冲突/上升/转折/低谷）
  rising_action: 'conflict',
  rising: 'conflict',
  building: 'conflict',
  development: 'conflict',
  complication: 'conflict',
  midpoint: 'conflict',
  turning_point: 'conflict',
  tests_allies_enemies: 'conflict',
  approach: 'conflict',
  abyss: 'conflict',
  all_is_lost: 'conflict',
  dark_night_of_the_soul: 'conflict',
  dark_night: 'conflict',
  lowest_point: 'conflict',
  ordeal: 'conflict',
  crisis: 'conflict',
  conflict: 'conflict',
  '冲突': 'conflict',
  '上升': 'conflict',
  '转折': 'conflict',
  '低谷': 'conflict',

  // → emotional_climax（高潮）
  climax: 'emotional_climax',
  emotional_climax: 'emotional_climax',
  peak: 'emotional_climax',
  showdown: 'emotional_climax',
  finale_battle: 'emotional_climax',
  resurrection: 'emotional_climax',
  '高潮': 'emotional_climax',

  // → resolution（结局/收束）
  resolution: 'resolution',
  resolve: 'resolution',
  ending: 'resolution',
  denouement: 'resolution',
  falling: 'resolution',
  falling_action: 'resolution',
  transformation: 'resolution',
  return_with_elixir: 'resolution',
  tag: 'resolution',
  epilogue: 'resolution',
  '结局': 'resolution',
  '结尾': 'resolution',
  '收束': 'resolution'
};

/**
 * 单场景类型归一化
 * @param {string} rawType - 原始 scene_type（可能是非标准词汇/中文/空）
 * @param {number} index - 场景在列表中的位置
 * @param {number} totalCount - 场景总数
 * @returns {string} 标准五型之一
 */
function normalizeSceneType(rawType, index = 0, totalCount = 1) {
  const key = String(rawType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

  // 1. 白名单直过
  if (VALID_SCENE_TYPES.includes(key)) return key;

  // 2. 别名映射
  if (SCENE_TYPE_ALIAS_MAP[key]) return SCENE_TYPE_ALIAS_MAP[key];

  // 3. 包含式模糊匹配（如 "the_hook"、"final_climax_scene" 等长尾变体）
  if (/open|hook|intro|prologue|teaser/.test(key)) return 'opening';
  if (/climax|peak|showdown/.test(key)) return 'emotional_climax';
  if (/resol|ending|denouement|epilogue|transformation|falling/.test(key)) return 'resolution';
  if (/conflict|rising|midpoint|abyss|crisis|ordeal|turning/.test(key)) return 'conflict';
  if (/establish|setup|exposition|catalyst|inciting/.test(key)) return 'establishing';

  // 4. 位置推断（完全不认识的词）：首→opening，尾→resolution，中间→conflict
  if (index === 0) return 'opening';
  if (index === totalCount - 1) return 'resolution';
  return 'conflict';
}

/**
 * 全量场景归一化（含片头唯一性约束）
 * - 每个场景类型映射到标准五型
 * - 强制 scenes[0].scene_type = 'opening'（系统永远生成片头；
 *   系列非第一集的 opening→establishing 降级由 production-engine._extractScenes 下游处理，不冲突）
 * - 非首位出现 opening 的降级为 establishing（保证全片只有一个片头）
 *
 * @param {Array} scenes - 场景数组（就地修改 scene_type 字段）
 * @param {object} [options]
 * @param {function} [options.logger] - 变更日志回调，默认 console.warn
 * @returns {Array} 同一个 scenes 数组（便于链式调用）
 */
function normalizeSceneTypes(scenes, options = {}) {
  if (!Array.isArray(scenes) || scenes.length === 0) return scenes;
  const logger = options.logger || ((msg) => console.warn(`[SceneTypeNormalizer] ${msg}`));
  const total = scenes.length;

  scenes.forEach((scene, index) => {
    const raw = scene.scene_type;
    const normalized = normalizeSceneType(raw, index, total);
    if (raw !== normalized) {
      logger(`scene_type 归一化: scenes[${index}] "${raw}" → "${normalized}"`);
      scene.scene_type = normalized;
    }
  });

  // 片头唯一性：第一个必须是 opening
  if (scenes[0].scene_type !== 'opening') {
    logger(`第一个场景类型 "${scenes[0].scene_type}" 被强制修正为 "opening"（片头专用类型）`);
    scenes[0].scene_type = 'opening';
  }
  // 其余位置不允许 opening（防止注入层命中错误镜头）
  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i].scene_type === 'opening') {
      logger(`scenes[${i}] 多余的 opening 被降级为 "establishing"（全片只允许一个片头）`);
      scenes[i].scene_type = 'establishing';
    }
  }

  return scenes;
}

/**
 * 生成 Prompt 约束文本（script-generator 与校验器共用，口径唯一）
 */
function buildSceneTypeConstraintText() {
  return `scene_type 只能取以下 ${VALID_SCENE_TYPES.length} 个值之一：${VALID_SCENE_TYPES.join(', ')}。` +
    `第一个场景（scenes[0]）的 scene_type 必须是 "opening"（片头专用类型，用于注入标题卡与片头音效，全片有且仅有一个）。` +
    `禁止把上方"剧本结构模板"中 acts.beats 的 beat_type（hook/setup/inciting_incident/rising_action/midpoint/abyss/climax 等英雄之旅节拍词汇）用作 scene_type——beat_type 是幕内节拍词汇，scene_type 是场景类型，两者不可混用。`;
}

module.exports = {
  VALID_SCENE_TYPES,
  SCENE_TYPE_ALIAS_MAP,
  normalizeSceneType,
  normalizeSceneTypes,
  buildSceneTypeConstraintText
};
