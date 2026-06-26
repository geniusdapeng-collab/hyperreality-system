/**
 * OpeningDesignAgent - 片头设计Agent
 * 负责: 片头S00的完整设计（片头专属字段）
 */
const { BaseAgent } = require('./base-agent');

class OpeningDesignAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'OpeningDesignAgent', ...options });
  }

  _getSystemPrompt() {
    return `你是一位专业的电影片头设计师。根据系列信息，设计片头S00的完整方案。

输出JSON格式:
{
  "opening": {
    "shotId": "S00",
    "scene": "片头场景描述",
    "mood": "片头情绪",
    "camera": { "shot_size": "", "movement": "", "angle": "" },
    "cameraString": "运镜描述",
    "lighting": { "key_light": "", "atmosphere": "" },
    "lightingString": "灯光描述",
    "audioLayer": {
      "bgm": "背景音乐描述",
      "sound_effects": "音效描述"
    },
    "audioLayerString": "音频描述文本",
    "titleOverlay": {
      "main_title": "主标题",
      "sub_title": "副标题",
      "style": "标题样式"
    },
    "titleOverlayString": "标题信息文本",
    "duration": 8
  }
}

设计原则:
1. 片头要有视觉冲击力，让观众一眼记住;
2. 标题设计要简洁有力;
3. 背景音乐要有系列辨识度;`;
  }

  async process(blueprint) {
    console.log(`[OpeningDesignAgent] 开始设计片头...`);

    const prompt = this._buildPrompt(blueprint);

    const schema = {
      required: ['opening']
    };

    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(blueprint);
    });

    if (llmResult.degraded) {
      return { opening: llmResult.result, degraded: true, degradeReason: llmResult.degradeReason };
    }

    console.log(`[OpeningDesignAgent] 完成 ✓`);
    return { opening: llmResult.result.opening, degraded: false, degradeReason: null };
  }

  _buildPrompt(blueprint) {
    // v2.1.5-fix: 优先从 config.title 或 metadata.title 获取，适配 AdaptedBlueprint 数据结构
    const title = blueprint.config?.title || blueprint.metadata?.title || blueprint.title || '未命名';
    const meta = blueprint._metadata || blueprint.config?._metadata || {};
    const isSeries = meta.isSeries || false;
    const episodeNumber = meta.episodeNumber || 1;

    return `## 片头信息
标题: ${title}
类型: ${isSeries ? '系列第' + episodeNumber + '集' : '单集'}
画幅: ${blueprint.config?.aspectRatio || '16:9'}

## 任务
设计片头S00（时长5-10秒）:
1. scene: 片头场景描述（30-50字，要有视觉冲击力）
2. camera/cameraString: 运镜方案
3. lighting/lightingString: 灯光方案
4. audioLayer/audioLayerString: 背景音乐和音效
5. titleOverlay/titleOverlayString: 主标题+副标题
6. duration: 时长（秒）

要求:
- 片头要有电影感
- 标题要简洁有力
- 整体时长控制在5-10秒

直接输出JSON。`;
  }

  _fallback(blueprint) {
    console.log(`[OpeningDesignAgent] 使用降级规则...`);
    const title = blueprint.title || '未命名';
    return {
      opening: {
        shotId: 'S00',
        scene: `${title} 片头场景`,
        mood: 'epic',
        camera: { shot_size: 'wide', movement: 'static', angle: 'eye_level' },
        cameraString: 'wide shot, static, eye-level',
        lighting: { key_light: 'dramatic', atmosphere: 'cinematic' },
        lightingString: 'dramatic cinematic lighting',
        audioLayer: { bgm: 'epic orchestral', sound_effects: 'ambient' },
        audioLayerString: 'epic orchestral music with ambient sound',
        titleOverlay: { main_title: title, sub_title: '', style: 'cinematic' },
        titleOverlayString: `Title: ${title}`,
        duration: 8
      }
    };
  }
}

module.exports = { OpeningDesignAgent };
