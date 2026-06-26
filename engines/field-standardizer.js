'use strict';

/**
 * 全局字段标准化器 v1.0
 * 适配超现实系统四层架构
 * 
 * 设计原则：
 * 1. 兼容中英文字段并存（不强制全中文，保持与下游API兼容性）
 * 2. 统一字段真相源，消除多模块重复组装
 * 3. 自动归一化历史遗留字段名
 * 4. 关键字段强制保留
 */

// 【审计修复】统一片头判定：兼容 SC00 / S00 / S00-xx，避免正则 ^S00 漏掉 SC00
function isOpeningShot(raw = {}) {
  if (!raw) return false;
  const type = raw.type || raw.sceneType || raw.shotType;
  if (type === 'opening' || type === '片头') return true;
  const id = String(raw.id || raw.shotId || '');
  if (/^S?C?00($|-|_)/i.test(id)) return true; // 匹配 S00 / SC00 / S00-01
  if (raw.mainTitle || (raw.title && raw.title !== '未命名')) return true;
  return false;
}

const FIELD_ALIAS_MAP = {
  // v2.1.4-fix9-P25: 25字段体系
  // 创作意图层 (P0)
  director_instruction: 'director_instruction',
  导演指令: 'director_instruction',
  
  // 画面基底 (P0)
  constraint: 'constraint',
  约束: 'constraint',
  baseline: 'baseline',
  基础: 'baseline',
  
  // 空间层 (P0)
  scene: 'scene',
  sceneName: 'scene',
  场景名称: 'scene',
  sceneDescription: 'sceneDescription',
  场景描述: 'sceneDescription',
  lighting: 'lighting',
  灯光: 'lighting',
  灯光照明: 'lighting',
  
  // 镜头语言层 (P0/P1)
  cameraMovement: 'camera_movement',
  运镜: 'camera_movement',
  运镜设计: 'camera_movement',
  composition: 'composition',
  构图: 'composition',
  color_palette: 'color_palette',
  色彩: 'color_palette',
  色调: 'color_palette',
  depth_of_field: 'depth_of_field',
  景深: 'depth_of_field',
  
  // 人物层 (P0/P2/P3)
  character: 'character',
  角色: 'character',
  costume: 'costume',
  服装: 'costume',
  makeup: 'makeup',
  化妆: 'makeup',
  action: 'action',
  动作: 'action',
  
  // 物件层 (P2)
  props: 'props',
  道具: 'props',
  
  // 质量/调度/渲染/过渡/音频/叙事层
  portraits: 'portraits',
  referenceImages: 'portraits',
  绑定定妆照: 'portraits',
  定妆照: 'portraits',
  dialogue: 'dialogue',
  narration: 'dialogue',
  line: 'dialogue',
  lines: 'dialogue',
  台词: 'dialogue',
  timeline: 'timeline',
  _timeline: 'timeline',
  镜头时间轴: 'timeline',
  时间轴: 'timeline',
  mood: 'mood',
  情绪: 'mood',
  pacing: 'pacing',
  节奏: 'pacing',
  transition: 'transition',
  转场: 'transition',
  audio: 'audio',
  音频: 'audio',
  backgroundSound: 'audio',
  背景音效: 'audio',
  
  // 约束层 (P0/P1)
  negative: 'negative',
  负面约束: 'negative',
  negativeConstraints: 'negative',
  bright_constraint: 'bright_constraint',
  明亮约束: 'bright_constraint',
  character_constraint: 'character_constraint',
  角色约束: 'character_constraint',
  consistency: 'consistency',
  角色一致性: 'consistency',
  
  // 片头专属字段（后处理环节生成）
  title_content: 'title_content',
  主标题: 'title_content',
  subtitle_content: 'subtitle_content',
  副标题: 'subtitle_content',
  title_animation: 'title_animation',
  标题动画: 'title_animation',
  title_font_design: 'title_font_design',
  字体设计: 'title_font_design',
  opening_audio_design: 'opening_audio_design',
  开场音效: 'opening_audio_design',
  shotId: 'shotId',
  镜头编号: 'shotId',
  type: 'sceneType',
  shotType: 'sceneType',
  sceneType: 'sceneType',
  镜头类型: 'sceneType',
  duration: 'duration',
  镜头时长: 'duration',
  timing: 'timing',
  时序: 'timing',
  
  // Prompt
  prompt: 'prompt',
  visualPrompt: 'prompt',
  renderPrompt: 'prompt',
  视觉提示词: 'prompt',
  
  // 口型
  mouthAction: 'mouthAction',
  mouth_action: 'mouthAction',
  口型动作: 'mouthAction',
  
  // 角色/定妆照
  characters: 'characters',
  角色列表: 'characters',
  characterRef: 'characterRef',
  角色引用: 'characterRef',
  
  // 人物卡片
  characterCards: 'characterCards',
  peopleCards: 'characterCards',
  人物介绍卡片: 'characterCards',
  
  // 片头
  title: 'title',
  mainTitle: 'title',
  主标题: 'title',
  subTitle: 'subtitle',
  subtitle: 'subtitle',
  副标题: 'subtitle',
  producer: 'producer',
  出品信息: 'producer',
  beastVoice: 'beastVoice',
  神兽开场白: 'beastVoice',
  openingHook: 'openingHook',
  片头钩子文案: 'openingHook',
  
  // 情绪/质量
  emotionPhase: 'emotionPhase',
  情绪阶段: 'emotionPhase',
  qualityScore: 'qualityScore',
  质量评分: 'qualityScore',
  
  // 降级标记
  degraded: 'degraded',
  降级标记: 'degraded',
  degradeReason: 'degradeReason',
  降级原因: 'degradeReason',
  
  // 其他
  camera: 'camera',
  镜头: 'camera',
  
  // 超现实系统特有
  sceneFunction: 'sceneFunction',
  场景功能: 'sceneFunction',
  emotionalTarget: 'emotionalTarget',
  情绪目标: 'emotionalTarget',
  visualDirection: 'visualDirection',
  视觉方向: 'visualDirection',
  worldId: 'worldId',
  世界ID: 'worldId',
  
  // 后期字段
  audioLayer: 'audioLayer',
  音频层: 'audioLayer',
  titleOverlay: 'titleOverlay',
  标题叠加: 'titleOverlay',
  
  // 约束
  styleConstraints: 'styleConstraints',
  风格约束: 'styleConstraints'
};

// v2.0.7: 字段中文显示名映射（用于最终输出）
const FIELD_NAME_CN = {
  director_instruction: '导演指令',
  constraint: '约束',
  baseline: '基础',
  scene: '场景',
  lighting: '灯光',
  composition: '构图',
  color_palette: '色彩',
  depth_of_field: '景深',
  camera_movement: '运镜',
  character: '角色',
  costume: '服装',
  makeup: '化妆',
  action: '动作',
  props: '道具',
  portraits: '定妆照',
  dialogue: '台词',
  timeline: '时间轴',
  mood: '情绪',
  pacing: '节奏',
  transition: '转场',
  audio: '音频',
  negative: '负面约束',
  bright_constraint: '明亮约束',
  character_constraint: '角色约束',
  consistency: '角色一致性',
  title_content: '主标题',
  subtitle_content: '副标题',
  title_animation: '标题动画',
  title_font_design: '字体设计',
  opening_audio_design: '开场音效',
  shotId: '镜头编号',
  sceneType: '镜头类型',
  duration: '时长',
  prompt: '提示词'
};

const CRITICAL_FIELDS = {
  // v2.1.4-fix9-P25: 25字段体系
  // P0 致命级（12个字段）- 缺失会导致视频不可用
  p0: [
    'director_instruction',  // 创作意图层
    'constraint',            // 画面基底
    'baseline',              // 画面基底
    'scene',                 // 空间层
    'lighting',              // 空间层
    'camera_movement',        // 镜头语言层
    'character',             // 人物层
    'action',                // 人物层
    'portraits',             // 质量层
    'dialogue',              // 叙事层
    'negative',              // 约束层
    'consistency'            // 质量层
  ],
  // P1 核心级（7个字段）- 缺失会导致质量显著降低
  p1: [
    'composition',           // 镜头语言层
    'color_palette',          // 镜头语言层
    'depth_of_field',          // 镜头语言层
    'timeline',              // 调度层
    'mood',                  // 渲染层
    'bright_constraint',      // 约束层
    'character_constraint'    // 约束层
  ],
  // P2 增强级（4个字段）- 缺失不影响主体表达
  p2: [
    'costume',               // 人物层
    'props',                 // 物件层
    'pacing',                // 渲染层
    'audio'                  // 音频层
  ],
  // P3 可选级（2个字段）
  p3: [
    'makeup',                // 人物层
    'transition'             // 过渡层
  ],
  // 基础标识（所有镜头必须）
  common: ['shotId', 'sceneType', 'prompt'],
  // 片头专用
  opening: ['title', 'subtitle'],
  // 内容镜头专用
  content: ['scene']
};

function deepClone(obj) {
  // v2.1.5-audit: 使用 WeakMap 防止循环引用，支持特殊类型
  const seen = new WeakMap();
  const clone = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return new RegExp(value.source, value.flags);
    if (Array.isArray(value)) {
      const arr = [];
      seen.set(value, arr);
      for (const item of value) arr.push(clone(item));
      return arr;
    }
    if (seen.has(value)) return seen.get(value);
    const result = {};
    seen.set(value, result);
    for (const [k, v] of Object.entries(value)) {
      result[k] = clone(v);
    }
    return result;
  };
  return clone(obj ?? {});
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeDialogue(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') {
        return { speaker: '', text: item };
      }
      if (item && typeof item === 'object') {
        return {
          speaker: item.speaker || item.说话人 || item.role || '',
          text: item.text || item.内容 || item.line || item.text || ''
        };
      }
      return { speaker: '', text: String(item || '') };
    });
  }
  if (typeof value === 'string') {
    return [{ speaker: '', text: value }];
  }
  return [];
}

function normalizeTimeline(value, raw = {}) {
  if (Array.isArray(value)) return value;
  // v6.37+: 支持对象格式（如 {object, string}）转数组
  if (value && typeof value === 'object' && !Array.isArray(value)) return [value];
  if (Array.isArray(raw._timeline)) return raw._timeline;
  if (Array.isArray(raw.timeline)) return raw.timeline;
  if (Array.isArray(raw.cameraMovement?.timeline)) return raw.cameraMovement.timeline;
  return [];
}

function normalizePortraits(value, raw = {}) {
  const result = [];
  // v2.1.4-fix9-P25-fix7: 支持字符串格式的定妆照路径（PromptFusionAgent fields.portraits 为字符串）
  if (typeof value === 'string' && value.trim()) {
    result.push(value.trim());
  }
  if (Array.isArray(value)) result.push(...value);
  if (Array.isArray(raw.referenceImages)) result.push(...raw.referenceImages);
  if (Array.isArray(raw.portraits)) result.push(...raw.portraits);
  if (raw.generatedAssets?.portraits) {
    const gp = raw.generatedAssets.portraits;
    if (Array.isArray(gp)) {
      result.push(...gp);
    } else if (typeof gp === 'object') {
      Object.entries(gp).forEach(([angle, path]) => {
        result.push({ character: raw.id || raw.name || '', angle, path });
      });
    }
  }
  return result;
}

function createEmptyShot() {
  return {
    // 基础标识
    shotId: '',
    sceneType: 'establishing',
    duration: 0,
    timing: { start: 0, duration: 0, end: 0 },
    
    // 创作意图层 (P0)
    director_instruction: '',
    
    // 画面基底 (P0)
    constraint: '',
    baseline: '',
    
    // 空间层 (P0)
    scene: '',
    sceneDescription: '',
    lighting: null,
    
    // 镜头语言层 (P0/P1)
    camera_movement: {},
    composition: '',
    color_palette: '',
    depth_of_field: '',
    
    // 人物层 (P0/P2/P3)
    character: '',
    costume: '',
    makeup: '',
    action: '',
    
    // 物件层 (P2)
    props: '',
    
    // 质量/调度/渲染/过渡/音频/叙事层
    portraits: [],
    dialogue: [],
    timeline: [],
    mood: '',
    pacing: '',
    transition: '',
    audio: null,
    
    // 约束层 (P0/P1)
    negative: '',
    bright_constraint: '',
    character_constraint: '',
    consistency: '',
    
    // Prompt
    prompt: '',
    
    // 口型
    mouth_action: '',
    
    // 角色/定妆照
    characters: [],
    character_ref: '',
    
    // 人物卡片
    character_cards: [],
    
    // 情绪/质量
    emotion_phase: '',
    quality_score: null,
    
    // 降级标记
    degraded: false,
    degrade_reason: '',
    
    // 超现实系统特有
    scene_function: '',
    emotional_target: { valence: 0, arousal: 0.5 },
    visual_direction: {},
    world_id: 'default',
    
    // 后期字段
    audio_layer: null,
    title_overlay: null,
    
    // 片头字段
    title: '',
    subtitle: '',
    producer: '',
    beast_voice: '',
    opening_hook: '',
    
    // v2.1.4-fix12: 片头专属字段（OpeningTitleOptimizer生成）
    title_content: '',
    subtitle_content: '',
    title_animation: '',
    title_font_design: '',
    opening_audio_design: '',
    
    // 约束（兼容旧版）
    negative_constraints: [],
    style_constraints: []
  };
}

function inferShotType(raw = {}) {
  // 【审计修复】统一片头判定，兼容 SC00/S00
  return isOpeningShot(raw) ? 'opening' : 'content';
}

function standardizeShot(rawInput = {}) {
  const raw = deepClone(rawInput);
  const shotType = inferShotType(raw);
  const standard = createEmptyShot();

  // v2.1.4-fix9-P25: 处理 PromptFusionAgent 输出的 fields 对象
  // 将 fields 内的25字段展开到 shot 级别
  if (raw.fields && typeof raw.fields === 'object') {
    for (const [fieldName, value] of Object.entries(raw.fields)) {
      // 将 snake_case 转为 camelCase（如 bright_constraint -> brightConstraint）
      const camelField = fieldName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      const targetField = FIELD_ALIAS_MAP[camelField] || FIELD_ALIAS_MAP[fieldName] || camelField;
      if (targetField in standard) {
        standard[targetField] = value;
      }
    }
  }

  // 映射所有字段
  for (const [originalField, value] of Object.entries(raw)) {
    const targetField = FIELD_ALIAS_MAP[originalField] || originalField;
    if (targetField in standard) {
      standard[targetField] = value;
    }
  }

  // 【审计修复】统一用驼峰主键，避免同时存在 shotId(空) 和 shot_id(有值) 的幽灵字段
  standard.shotId = standard.shotId || raw.id || raw.shotId || raw.shot_id || '';
  standard.sceneType = shotType === 'opening' ? 'opening' : (standard.sceneType || standard.scene_type || 'establishing');
  standard.duration = standard.duration || raw.duration || raw.shotDuration || (raw.timing?.duration) || 0;
  standard.timing = standard.timing || raw.timing || { start: 0, duration: standard.duration, end: standard.duration };
  standard.scene = standard.scene || raw.scene || raw.sceneName || '';
  standard.sceneDescription = standard.sceneDescription || standard.scene_description || raw.sceneDescription || raw.setting || '';
  // 【v2.1.5-fix】补充 lighting 字段提取
  standard.lighting = standard.lighting || raw.lighting || raw.lightingString || '';
  standard.prompt = standard.prompt || raw.visualPrompt || raw.prompt || raw.renderPrompt || '';
  standard.dialogue = normalizeDialogue(standard.dialogue || raw.dialogue || raw.narration || raw.line || raw.lines);
  standard.timeline = normalizeTimeline(standard.timeline, raw);
  standard.portraits = normalizePortraits(standard.portraits, raw);
  standard.characterCards = standard.characterCards || standard.character_cards || toArray(raw.characterCards || raw.peopleCards);
  standard.characters = standard.characters || toArray(raw.characters);
  standard.mouthAction = standard.mouthAction || standard.mouth_action || raw.mouthAction || raw.mouth_action || '';
  standard.cameraMovement = standard.cameraMovement || standard.camera_movement || raw.cameraMovement || raw.camera_movement || {};
  standard.degraded = Boolean(standard.degraded || raw.degraded);
  standard.degradeReason = standard.degradeReason || standard.degrade_reason || raw.degradeReason || raw.degrade_reason || '';
  standard.emotionPhase = standard.emotionPhase || standard.emotion_phase || raw.emotionPhase || raw.emotion_phase || '';
  
  // 片头字段（始终保留，即使不是opening类型）
  standard.title = standard.title || raw.mainTitle || raw.title || '';
  standard.subtitle = standard.subtitle || raw.subTitle || raw.subtitle || '';
  standard.title_content = standard.title_content || raw.title_content || '';
  standard.subtitle_content = standard.subtitle_content || raw.subtitle_content || '';
  standard.title_animation = standard.title_animation || raw.title_animation || '';
  standard.title_font_design = standard.title_font_design || raw.title_font_design || '';
  standard.opening_audio_design = standard.opening_audio_design || raw.opening_audio_design || '';
  standard.producer = standard.producer || raw.producer || '';
  standard.beast_voice = standard.beast_voice || raw.beastVoice || raw.beast_voice || '';
  standard.opening_hook = standard.opening_hook || raw.openingHook || raw.opening_hook || '';
  
  if (shotType === 'opening') {
    standard.sceneType = 'opening';
  }

  return standard;
}

function standardizeShots(shots = []) {
  return shots.map(standardizeShot);
}

function validateShot(shot) {
  const errors = [];
  const warnings = [];
  const isOpening = shot.sceneType === 'opening';

  // v2.1.4-fix9-P25: 检查P0致命级字段（12个）
  for (const key of CRITICAL_FIELDS.p0) {
    const value = shot[key];
    if (value === undefined || value === null || value === '') {
      errors.push(`P0 Missing: ${key}`);
    } else if (Array.isArray(value) && value.length === 0) {
      warnings.push(`P0 Empty array: ${key}`);
    }
  }

  // v2.1.4-fix9-P25: 检查P1核心级字段（7个）
  for (const key of CRITICAL_FIELDS.p1) {
    const value = shot[key];
    if (value === undefined || value === null || value === '') {
      warnings.push(`P1 Missing: ${key}`);
    }
  }

  // 基础标识检查
  for (const key of CRITICAL_FIELDS.common) {
    if (!(key in shot)) {
      errors.push(`Missing critical field: ${key}`);
      continue;
    }
    if (Array.isArray(shot[key]) && shot[key].length === 0) {
      warnings.push(`Empty critical array: ${key}`);
    }
    if (typeof shot[key] === 'string' && shot[key].trim() === '') {
      warnings.push(`Empty critical string: ${key}`);
    }
  }

  // 片头/内容镜头检查
  if (isOpening) {
    for (const key of CRITICAL_FIELDS.opening) {
      if (!shot[key] || String(shot[key]).trim() === '') {
        errors.push(`Opening shot missing: ${key}`);
      }
    }
  } else {
    for (const key of CRITICAL_FIELDS.content) {
      if (!shot[key] || String(shot[key]).trim() === '') {
        errors.push(`Content shot missing: ${key}`);
      }
    }
  }

  // v2.1.4-fix9-P25: 字符数检查
  const promptLength = shot.promptCharCount || (typeof shot.prompt === 'string' ? shot.prompt.length : 0);
  if (promptLength > 12000) {
    warnings.push(`Prompt length ${promptLength} exceeds 12000 char limit`);
  }

  // 片头专属字段检查（强制，但分层处理）
  // 【v2.1.5-fix】Layer 2时片头字段还未生成（OpeningTitleOptimizer后处理），只报warning
  // Final-Export时才严格检查
  if (isOpening) {
    const openingExclusiveFields = ['title_content', 'subtitle_content', 'title_animation', 'title_font_design', 'opening_audio_design'];
    const missingOpeningFields = openingExclusiveFields.filter(k => !shot[k] || String(shot[k]).trim() === '');
    if (missingOpeningFields.length > 0) {
      if (shot._context === 'Final-Export') {
        // 【v2.1.4-fix13】最终导出时严格检查
        errors.push(`Opening exclusive fields missing: ${missingOpeningFields.join(', ')} (use OpeningTitleOptimizer to generate)`);
      } else {
        // Layer 2时片头字段还未生成，只报warning
        warnings.push(`Opening fields not yet generated (will be filled by OpeningTitleOptimizer): ${missingOpeningFields.join(', ')}`);
      }
    }
  }
  if (!shot.negative || !shot.negative.includes('no text')) {
    errors.push(`Missing critical negative constraint: no text`);
  }

  // 【v2.1.4-fix11-F】最终导出前严格检查：所有25字段必须有非空内容
  if (shot._context === 'Final-Export') {
    const allFields = [...CRITICAL_FIELDS.p0, ...CRITICAL_FIELDS.p1, ...CRITICAL_FIELDS.common];
    const emptyFields = allFields.filter(k => !shot[k] || String(shot[k]).trim() === '');
    if (emptyFields.length > 0) {
      errors.push(`Final-Export strict: ${emptyFields.length} fields empty: ${emptyFields.join(', ')}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    p0Missing: CRITICAL_FIELDS.p0.filter(k => !shot[k] || shot[k] === '').length,
    p1Missing: CRITICAL_FIELDS.p1.filter(k => !shot[k] || shot[k] === '').length,
    promptLength
  };
}

function validateShots(shots = []) {
  const details = shots.map(validateShot);
  const totalP0Missing = details.reduce((sum, d) => sum + (d.p0Missing || 0), 0);
  const totalP1Missing = details.reduce((sum, d) => sum + (d.p1Missing || 0), 0);
  
  return {
    passed: details.every(d => d.passed),
    errors: details.flatMap(d => d.errors),
    warnings: details.flatMap(d => d.warnings),
    details,
    summary: {
      totalShots: shots.length,
      totalP0Missing,
      totalP1Missing,
      avgPromptLength: Math.round(details.reduce((sum, d) => sum + (d.promptLength || 0), 0) / shots.length)
    }
  };
}

function markDegraded(shot, reason) {
  if (!shot || typeof shot !== 'object') return shot;
  shot.degraded = true;
  shot.degradeReason = reason || 'Unknown degradation';
  return shot;
}

function markDegradedArray(shots, reason) {
  return shots.map(shot => markDegraded(shot, reason));
}

function normalizeFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    const targetKey = FIELD_ALIAS_MAP[snakeKey] || snakeKey;
    if (value !== undefined && value !== null && value !== '') {
      result[targetKey] = normalizeValue(value);
    }
  }
  return result;
}

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => normalizeValue(v)).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}: ${normalizeValue(v)}`).join(', ');
  }
  return String(value);
}

function makeGetter(fields) {
  return function getField(...names) {
    for (const name of names) {
      if (fields[name] !== undefined && fields[name] !== null && fields[name] !== '') {
        return fields[name];
      }
    }
    return undefined;
  };
}

function asString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => asString(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function asStringLower(value) {
  return asString(value).toLowerCase();
}

function safeSlice(value, start, end) {
  const str = asString(value);
  if (end === undefined) return str.slice(start);
  return str.slice(start, end);
}

function safeIncludes(value, searchString) {
  return asString(value).includes(searchString);
}

module.exports = {
  FIELD_ALIAS_MAP,
  FIELD_NAME_CN,
  CRITICAL_FIELDS,
  isOpeningShot,
  standardizeShot,
  standardizeShots,
  validateShot,
  validateShots,
  markDegraded,
  markDegradedArray,
  inferShotType,
  createEmptyShot,
  normalizeFields,
  normalizeValue,
  makeGetter,
  asString,
  asStringLower,
  safeSlice,
  safeIncludes
};
