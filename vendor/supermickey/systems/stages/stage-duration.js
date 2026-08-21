'use strict';

const { createLogger } = require('../logger');
const { ValidationError } = require('../errors');

class StageDurationService {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('stage-duration');
    this.pipeline = options.pipeline || null;
  }

  async run(ctx) {
    const script = ctx.getShared('script');
    const input = ctx.getInput();

    if (!script || !Array.isArray(script.scenes)) {
      throw new ValidationError('StageDuration 缺少 script.scenes');
    }

    // 1. 优先使用 pipeline 既有方法
    if (this.pipeline && typeof this.pipeline.stageDuration === 'function') {
      this.logger.info('调用已有 pipeline.stageDuration');
      return await this.pipeline.stageDuration(script, input);
    }

    // 2. 兜底：按原 scenes duration 透传
    this.logger.warn('未找到 pipeline.stageDuration，使用兜底时长分配');
    return {
      shots: script.scenes.map((scene, index) => ({
        id: scene.id || `S${String(index + 1).padStart(2, '0')}`,
        scene: scene.scene,
        narration: scene.narration || '',
        type: scene.type || 'building',
        characters: scene.characters || [],
        duration: normalizeDuration(scene.duration)
      }))
    };
  }
}

function normalizeDuration(duration) {
  const d = Number(duration || 5);
  if (d < 3) return 3;
  if (d > 15) return 15;
  return d;
}

module.exports = { StageDurationService };