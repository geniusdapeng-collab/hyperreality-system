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

    // 【2026-07-17 升级】优先委托 OpeningCinematicAgent（电影级片头方案：
    // 标题动效节拍表 + 角色入场编舞 + 五层音效 + 四维字体）。
    // 任何失败都回落到下方原有轻量 LLM 流程，契约不变。
    try {
      const { OpeningCinematicAgent } = require('../../../../systems/opening-cinematic');
      if (!this._cinematicAgent) {
        this._cinematicAgent = new OpeningCinematicAgent({
          llmModel: this.llmModel,
          llmTimeout: this.llmTimeout,
          llmMaxRetries: this.llmMaxRetries,
          enabled: this.enabled
        });
        if (this._globalDeadline) this._cinematicAgent.setDeadline(this._globalDeadline);
      }
      const { plan, promptTimeline, postProduction, degraded, degradeReason } =
        await this._cinematicAgent.process(blueprint, { durationSec: 8 });

      // 映射到既有 opening 契约（字段不变，内容升级）+ 新增 cinematic/promptTimeline 扩展
      const opening = {
        shotId: 'S00',
        scene: (plan.beats.find(b => b.phase === 'hook') || plan.beats[0]).visual,
        mood: postProduction.meta.mood,
        camera: { shot_size: 'wide', movement: 'per_beats', angle: 'per_beats' },
        cameraString: plan.beats.map(b => `${b.tStart}-${b.tEnd}s:${b.camera || '缓推'}`).join('；'),
        lighting: { key_light: 'per_plan', atmosphere: postProduction.meta.mood },
        lightingString: plan.typography.description,
        audioLayer: { bgm: plan.audio.bgm, sound_effects: plan.audio.signature },
        audioLayerString: `${plan.audio.signature}；${plan.audio.bgm}；${plan.audio.syncNotes}`,
        titleOverlay: {
          main_title: plan.title_content,
          sub_title: plan.subtitle_content,
          style: plan.typography.description,
          animation_pattern: plan.animation_pattern_id
        },
        titleOverlayString: `${plan.title_content} / ${plan.subtitle_content}`,
        duration: plan.duration,
        // 新增扩展字段：完整电影级方案（下游 phase1 注入 / 后期消费）
        cinematic: plan,
        promptTimeline
      };
      console.log(`[OpeningDesignAgent] 完成（OpeningCinematic ${degraded ? '规则库' : 'LLM'}方案）✓`);
      return { opening, degraded, degradeReason };
    } catch (e) {
      console.warn(`[OpeningDesignAgent] OpeningCinematicAgent 不可用(${e.message})，回落到轻量方案`);
    }

    // ===== 以下为原有轻量流程，一字不动 =====
    const prompt = this._buildPrompt(blueprint);

    const schema = {
      required: ['opening']
    };

    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(blueprint);
    });

    if (llmResult.degraded) {
      // 【P0-1 修复】降级时 llmResult.result 是 _fallback() 的返回值 { opening: {...} }
      // 必须取 .opening 提取内层对象，与成功分支保持一致，避免双重包裹
      const opening = (llmResult.result && llmResult.result.opening)
        ? llmResult.result.opening
        : llmResult.result;
      return { opening, degraded: true, degradeReason: llmResult.degradeReason };
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
    // 【fix】从 blueprint 补齐已确认元数据（找不到时的兜底）
    const themeMeta = blueprint?._creativeTheme || blueprint?.creativeTheme || {};
    const genre = blueprint?.type || themeMeta.type || '通用';
    const mood = blueprint?.tone || themeMeta.tone || 'epic';
    const visualStyle = blueprint?.visual_style || themeMeta.visual_style || 'cinematic';
    const characters = blueprint?.characterSystem?.characters || blueprint?.characters || [];
    const protagonistDesc = characters.find(c => c.role === '主角' || c.role === 'protagonist');
    const protagonistLabel = protagonistDesc
      ? `${protagonistDesc.name}（${(protagonistDesc.appearance || '').slice(0, 20)}…）`
      : (blueprint?.protagonist || '主角');

    return `## 片头信息
标题: ${title}
类型: ${isSeries ? '系列第' + episodeNumber + '集' : '单集'}
题材: ${genre}
情绪基调: ${mood}
视觉风格: ${visualStyle}
主角: ${protagonistLabel}
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

【片头心法】
1. 片头是正片的第一颗镜头，不是贴片广告：动效素材必须从故事里长出来（绳结故事=麻绳纤维汇聚成字），禁止与主题无关的通用能量爆发。
2. 3 秒定律：hook 段（0-1.5s）只给一个'悬念颗粒'（一粒光/一只手/一段绳），信息越少钩子越强。
3. 标题即剧透：主标题+副标题合起来要让观众预期到'一个小人物与一个大仪式'的故事，标题气质必须与正片美学同族（书法/纤维质感/暖橙勾边）。
4. freeze 段必须留'一拍静默'作为向正片第一帧的交接，声画上无缝：片头最后一拍的环境音=正片第一帧的环境音。
5. entrance 三阶段服务于'人小物大'的第一印象：先给手的特写（前兆），再给剪影与巨物的体量对撞（登场），最后定格在人物与标题同框（关系确立）。

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