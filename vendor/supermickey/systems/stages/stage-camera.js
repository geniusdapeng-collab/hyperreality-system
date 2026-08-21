'use strict';

const { createLogger } = require('../logger');
const { ValidationError } = require('../errors');

class StageCameraService {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('stage-camera');
    this.pipeline = options.pipeline || null;
  }

  async run(ctx) {
    const storyboard = ctx.getShared('storyboard');

    if (!storyboard || !Array.isArray(storyboard.shots)) {
      throw new ValidationError('StageCamera 缺少 storyboard.shots');
    }

    if (this.pipeline && typeof this.pipeline.stageCamera === 'function') {
      this.logger.info('调用已有 pipeline.stageCamera');
      return await this.pipeline.stageCamera(storyboard);
    }

    this.logger.warn('未找到 pipeline.stageCamera，使用兜底运镜');
    return buildFallbackCamera(storyboard);
  }
}

function buildFallbackCamera(storyboard) {
  return {
    shots: storyboard.shots.map((shot) => ({
      ...shot,
      cameraMovement: shot.cameraMovement || {
        type: 'static',
        direction: 'hold',
        timeline: {
          segmentCount: 1,
          totalDuration: shot.duration || 5,
          segments: [
            {
              start: 0,
              end: shot.duration || 5,
              movement: 'hold',
              shotSize: 'medium'
            }
          ]
        }
      }
    }))
  };
}

module.exports = { StageCameraService };