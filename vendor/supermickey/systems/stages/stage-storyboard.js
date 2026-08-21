'use strict';

const { createLogger } = require('../logger');
const { ValidationError } = require('../errors');

class StageStoryboardService {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('stage-storyboard');
    this.pipeline = options.pipeline || null;
  }

  async run(ctx) {
    const durationPlan = ctx.getShared('durationPlan');
    const input = ctx.getInput();

    if (!durationPlan) {
      throw new ValidationError('StageStoryboard 缺少 durationPlan');
    }

    if (this.pipeline && typeof this.pipeline.stageStoryboard === 'function') {
      this.logger.info('调用已有 pipeline.stageStoryboard');
      return await this.pipeline.stageStoryboard(durationPlan, input);
    }

    this.logger.warn('未找到 pipeline.stageStoryboard，使用兜底故事板');
    return buildFallbackStoryboard(durationPlan);
  }
}

// v6.5.62-P1: 五维空间描述法
// 1. 宏观地理：星球/大陆/区域
// 2. 中观地貌：地形/地貌
// 3. 微观材质：表面材质/纹理
// 4. 天气时间：时间/天气/光照
// 5. 空间深度：前景/中景/背景层次
function buildFiveDimensionScene(shot) {
  const fiveDimensions = [
    shot.macroGeo || 'Nirath东部大陆',           // 宏观地理
    shot.mesoscopicLandform || '晶体峡谷迷宫',   // 中观地貌
    shot.microscopicMaterial || '六角火山岩裂缝', // 微观材质
    shot.weatherTime || '双恒星日落，紫金色边缘光', // 天气时间
    shot.spatialDepth || '空间深度：前景岩石，中景主体，背景峡谷壁'  // 空间深度
  ];
  
  return fiveDimensions.join('，');
}

function buildFallbackStoryboard(durationPlan) {
  const shots = Array.isArray(durationPlan.shots) ? durationPlan.shots : [];

  return {
    shots: shots.map((shot, index) => ({
      id: shot.id || `S${String(index + 1).padStart(2, '0')}`,
      shotId: shot.id || `S${String(index + 1).padStart(2, '0')}`,
      sequence: index + 1,
      // v6.5.62-P1: 五维空间描述法（scene字段优化）
      // 1. 宏观地理 2. 中观地貌 3. 微观材质 4. 天气时间 5. 空间深度
      scene: buildFiveDimensionScene(shot),
      type: shot.type || 'building',
      duration: shot.duration || 5,
      narration: shot.narration || '',
      characters: shot.characters || [],
      visualPrompt: shot.visualPrompt || shot.narration || shot.scene || '',
      emotionPhase: shot.emotionPhase || 'exposition'
    }))
  };
}

module.exports = { StageStoryboardService };