'use strict';

const { createLogger } = require('../logger');
const { ValidationError } = require('../errors');

class StageScriptService {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('stage-script');
    this.pipeline = options.pipeline || null;
  }

  async run(ctx) {
    const input = ctx.getInput();

    if (!input) {
      throw new ValidationError('StageScript 缺少输入');
    }

    // 优先调用 pipeline 已有方法，减少侵入
    if (this.pipeline && typeof this.pipeline.stageScript === 'function') {
      this.logger.info('调用已有 pipeline.stageScript');
      const output = await this.pipeline.stageScript(input);
      return normalizeScriptOutput(output, input);
    }

    // 兜底：如果没有 stageScript，就尝试从 scenes 直接构造
    this.logger.warn('未找到 pipeline.stageScript，使用兜底脚本构造');
    return buildFallbackScript(input);
  }
}

function normalizeScriptOutput(output, input) {
  if (!output) {
    return buildFallbackScript(input);
  }

  // 常见兼容：有些实现可能直接返回 scenes
  if (Array.isArray(output)) {
    return { scenes: output };
  }

  if (output.scenes && Array.isArray(output.scenes)) {
    return output;
  }

  return buildFallbackScript(input);
}

function buildFallbackScript(input) {
  const scenes = Array.isArray(input.scenes) ? input.scenes : [];

  return {
    scenes: scenes.map((scene, index) => ({
      id: scene.id || `S${String(index + 1).padStart(2, '0')}`,
      scene: scene.scene || scene.title || `场景${index + 1}`,
      // v6.5.62-P1: dialogue字段（统一格式：SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES）
      dialogue: scene.dialogue || buildDialogue(scene),
      // v6.5.62-P1: action字段（核心动词+交互目标+身体运动）
      action: scene.action || buildAction(scene),
      // v6.5.62-P1: mood字段（3-5情绪关键词）
      mood: scene.mood || buildMood(scene),
      narration: scene.narration || '',
      type: scene.type || 'building',
      characters: scene.characters || [],
      duration: scene.duration || 5,
      emotionPhase: scene.emotionPhase || 'exposition'
    }))
  };
}

// v6.5.62-P1: 构建 dialogue 字段
function buildDialogue(scene) {
  if (scene.narration || scene.line) {
    const speaker = scene.characters && scene.characters[0] ? scene.characters[0] : '角色';
    const text = scene.narration || scene.line || '';
    return `${speaker}|独白|平静|${text}|LIP_SYNC:YES`;
  }
  return '';
}

// v6.5.62-P1: 构建 action 字段
function buildAction(scene) {
  const actions = ['缓步前行', '转身', '注视', '伸手触碰', '微微抬头'];
  const type = scene.type || 'building';
  
  const actionMap = {
    'building': '缓步前行，观察周围环境',
    'discovery': '主动靠近，发现目标物',
    'confrontation': '停下脚步，正视前方',
    'climax': '坚定迈出一步，面对挑战',
    'closing': '温柔注视，微笑转身'
  };
  
  return actionMap[type] || actions[0];
}

// v6.5.62-P1: 构建 mood 字段
function buildMood(scene) {
  const moodMap = {
    'building': 'mysterious, anticipation, wonder',
    'discovery': 'curious, excited, surprised',
    'confrontation': 'tense, determined, brave',
    'climax': 'epic, emotional, powerful',
    'closing': 'peaceful, warm, nostalgic'
  };
  
  return moodMap[scene.type] || 'neutral, calm, steady';
}

module.exports = { StageScriptService };