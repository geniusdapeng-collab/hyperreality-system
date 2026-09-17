'use strict';

const { createLogger } = require('../logger');
const { ValidationError } = require('../errors');

class StageRenderPrepService {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('stage-render-prep');
    this.pipeline = options.pipeline || null;
  }

  async run(ctx) {
    const cameraResult = ctx.getShared('cameraResult') || ctx.getShared('storyboardWithCamera') || ctx.getShared('storyboard');

    if (!cameraResult || !Array.isArray(cameraResult.shots)) {
      throw new ValidationError('StageRenderPrep 缺少 cameraResult.shots');
    }

    // 优先用 pipeline 自己的方法
    if (this.pipeline && typeof this.pipeline.stageRender === 'function') {
      this.logger.info('调用已有 pipeline.stageRender');
      return await this.pipeline.stageRender(cameraResult);
    }

    // 兜底：统一生成 render_prompt
    this.logger.warn('未找到 pipeline.stageRender，使用兜底渲染前准备');
    return {
      prompts: cameraResult.shots.map((shot) => {
        const promptText = 
          shot.render_prompt || 
          shot.renderPrompt || 
          shot.prompt || 
          shot.visualPrompt || 
          shot.narration || 
          shot.scene || 
          '';

        return {
          ...shot,
          render_prompt: promptText,
          promptLength: promptText.length
        };
      })
    };
  }
}

module.exports = { StageRenderPrepService };