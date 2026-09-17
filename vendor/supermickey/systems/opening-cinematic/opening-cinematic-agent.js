/**
 * 片头电影级设计总编排 Agent v1.0 — opening-cinematic
 *
 * 定位：大系统通用的片头开场动画设计器（替代/增强 OpeningDesignAgent 的粗糙方案）
 * 覆盖用户四大诉求：
 * 1. 主标题开场动画（动效模式 + 秒级节拍表）
 * 2. 主角入场编舞（前兆/登场/定格 三阶段）
 * 3. 对应音效设计（五层架构 + 画面同步表）
 * 4. 字体设计（结构×材质×光照×动态 四维规范）
 *
 * 工作方式（LLM 优先，规则库兜底）：
 * 1. 规则库按 genre/mood/visualStyle 初筛候选（动效模式 top3、字体预设、入场编舞、音效配置）
 * 2. 把候选库摘要 + 项目上下文注入 prompt，LLM 做最终创意决策与细节填充
 * 3. 输出严格 JSON 契约（见 PLAN_SCHEMA），校验 + 编译为：
 *    - promptTimeline: 秒级时间轴文本（直接注入片头镜头的渲染 prompt / 25字段 timeline）
 *    - postProduction: 后期可用的标题卡/音效提示元数据
 * 4. LLM 失败时：规则库按预设组装完整方案（远高于"epic orchestral"一句话的旧 fallback）
 *
 * 依赖：BaseAgent（LLM 调用与重试体系）
 * @module opening-cinematic/opening-cinematic-agent
 * @version 1.0.0
 */

const path = require('path');
const { BaseAgent } = require('../../hyperreality-system/engines/production-engine/agents/base-agent');
const {
  selectPatterns, getPattern, renderPatternBeats, buildLibrarySummary
} = require('./title-animation-library');
const { designTypography, buildTypographySummary } = require('./typography-designer');
const { designEntrance, buildEntranceSummary, inferArchetype } = require('./character-entrance-designer');
const { designAudio, buildAudioSummary } = require('./opening-audio-architect');

// ============================================================
// 输出契约
// ============================================================
const PLAN_SCHEMA = {
  required: ['title_content', 'animation_pattern_id', 'beats', 'typography', 'audio'],
  title_content: '主标题文字（≤15字，围绕主题）',
  subtitle_content: '副标题文字（≤25字）',
  animation_pattern_id: '从候选库选择的动效模式 id（或 custom_ 开头的自定义 id）',
  beats: [
    { tStart: 0.0, tEnd: 1.5, phase: 'hook', visual: '画面描述', camera: '运镜', audio: '音效事件' }
  ],
  typography: { structure: '', material: '', lighting: '', motion: '', description: '字体设计完整描述（100-150字）' },
  entrance: {
    character: '主角名',
    stages: [
      { stage: 'foreshadow', tStart: 0, tEnd: 2.4, description: '', audio: '' },
      { stage: 'emerge', tStart: 2.4, tEnd: 5.6, description: '', camera: '', audio: '' },
      { stage: 'settle', tStart: 5.6, tEnd: 8.0, description: '', audio: '' }
    ]
  },
  audio: {
    signature: '声音签名描述',
    bgm: 'BGM 完整描述',
    syncNotes: '音画同步要点'
  },
  duration: 8
};

class OpeningCinematicAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'OpeningCinematicAgent', ...options });
    this.defaultDuration = options.duration || 8;
  }

  _getSystemPrompt() {
    return `你是一位电影级片头导演，精通标题动效设计、角色入场编舞、音效架构与字体排印。
你的任务是为视频设计 3-15 秒的开场片头方案。

设计信条：
1. 片头不是装饰，是叙事事件 —— 第一帧就要锁住注意力
2. 标题出现 = 情绪峰值 moment，要让观众忍不住截图
3. 角色入场必须三阶段：前兆(悬念)→登场(峰值)→定格(关系确立)
4. 音效与画面逐拍对齐，第一帧就有声音签名
5. 所有设计必须服务项目主题与情绪基调，禁止炫技式跑偏

只输出严格 JSON，不要 markdown 代码块，不要解释。`;
  }

  /**
   * 主入口：设计完整片头方案
   * @param {Object} blueprint - 剧本蓝图（含 title/genre/style/characters/config）
   * @param {Object} options - { durationSec, openingShot }
   * @returns {Object} { plan, promptTimeline, postProduction, degraded, degradeReason }
   */
  async process(blueprint, options = {}) {
    const ctx = this._extractContext(blueprint, options);
    console.log(`[OpeningCinematicAgent] 设计片头 | 题材=${ctx.genre} 情绪=${ctx.mood} 时长=${ctx.durationSec}s 主角=${ctx.mainCharacter || '无'}`);

    // 1. 规则库初筛（作为 LLM 的候选知识，也是最终 fallback）
    const candidates = selectPatterns({ genre: ctx.genre, mood: ctx.mood, visualStyle: ctx.visualStyle }, 3);
    const typoPreset = designTypography({ genre: ctx.genre, mood: ctx.mood });
    const entrancePreset = ctx.mainCharacter
      ? designEntrance({ name: ctx.mainCharacter, type: ctx.characterType, description: ctx.characterDesc }, { mood: ctx.mood, durationSec: ctx.durationSec, hasTitle: true })
      : null;

    // 2. LLM 创意决策
    const prompt = this._buildDesignPrompt(ctx, candidates, typoPreset, entrancePreset);
    const schema = { required: PLAN_SCHEMA.required };

    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._libraryFallback(ctx, candidates, typoPreset, entrancePreset);
    });

    let plan;
    let degraded = llmResult.degraded;
    let degradeReason = llmResult.degradeReason || null;

    if (llmResult.degraded) {
      plan = llmResult.result; // fallback 已返回完整 plan
    } else {
      // 3. LLM 方案校验与补全（宽容合并：LLM 缺的字段用规则预设补）
      plan = this._reconcilePlan(llmResult.result, ctx, candidates, typoPreset, entrancePreset);
    }

    // 4. 编译：秒级时间轴文本（注入渲染 prompt）
    const promptTimeline = this._compilePromptTimeline(plan, ctx);

    // 5. 编译：后期元数据
    const postProduction = this._compilePostProduction(plan, ctx);

    console.log(`[OpeningCinematicAgent] 完成 ${degraded ? '(规则库方案)' : '(LLM方案)'} | 动效=${plan.animation_pattern_id} | 节拍=${plan.beats.length}段`);

    return {
      plan,
      promptTimeline,
      postProduction,
      degraded,
      degradeReason
    };
  }

  // ============================================================
  // 上下文提取
  // ============================================================
  _extractContext(blueprint, options) {
    const meta = blueprint._metadata || blueprint.config?._metadata || {};
    const requirementList = blueprint.requirementList || blueprint.config?.requirementList || {};
    const creativeTheme = meta._creativeTheme || {};

    const characters = blueprint.character_system?.characters || blueprint.characters || [];
    const mainChar = characters[0] || null;

    return {
      title: blueprint.config?.title || blueprint.metadata?.title || blueprint.title || creativeTheme.theme || '未命名',
      genre: blueprint.genre || requirementList.genre || creativeTheme.type || '通用',
      mood: creativeTheme.tone || blueprint.mood || meta.mood || 'epic',
      visualStyle: creativeTheme.visual_style || blueprint.style || 'cinematic',
      theme: creativeTheme.theme || blueprint.theme || '',
      description: creativeTheme.description || blueprint.logline || blueprint.summary || '',
      targetAudience: creativeTheme.target_audience || blueprint.targetAudience || '通用受众',
      aspectRatio: blueprint.config?.aspectRatio || '16:9',
      durationSec: Math.max(3, Math.min(15, options.durationSec || this.defaultDuration)),
      mainCharacter: options.mainCharacter || mainChar?.name || mainChar?.id || null,
      characterType: mainChar?.type || mainChar?.species || '',
      characterDesc: mainChar?.description || mainChar?.appearance || '',
      isSeries: meta.isSeries || false,
      episodeNumber: meta.episodeNumber || 1
    };
  }

  // ============================================================
  // LLM Prompt 构建（注入三个库的知识摘要）
  // ============================================================
  _buildDesignPrompt(ctx, candidates, typoPreset, entrancePreset) {
    const candidateIds = candidates.map(c => c.id);
    const librarySummary = buildLibrarySummary(candidateIds);

    return `## 项目信息
- 标题: ${ctx.title}
- 题材: ${ctx.genre} | 情绪基调: ${ctx.mood} | 视觉风格: ${ctx.visualStyle}
- 主题: ${ctx.theme} | 目标受众: ${ctx.targetAudience}
- 简介: ${ctx.description || '（无）'}
- 画幅: ${ctx.aspectRatio} | 片头时长: ${ctx.durationSec}秒
- 类型: ${ctx.isSeries ? `系列第${ctx.episodeNumber}集` : '单集'}
${ctx.mainCharacter ? `- 主角: ${ctx.mainCharacter}（${ctx.characterType || '人类'}）${ctx.characterDesc}` : '- 主角: 无（纯标题片头）'}

## 候选动效模式（规则库初筛 top${candidates.length}，你必须从中选一个或说明理由自定义）
${librarySummary}

## 字体设计参考（四维规范库）
${buildTypographySummary()}
当前题材推荐预设: ${JSON.stringify(typoPreset.spec.names)}

## 角色入场编舞参考（三阶段）
${buildEntranceSummary()}
${entrancePreset ? `当前主角原型推荐: ${entrancePreset.archetypeName}，建议节奏=${entrancePreset.pacing}` : ''}

## 音效配置参考（按情绪）
${buildAudioSummary()}

## 任务
输出完整片头方案 JSON，严格遵守以下要求：

1. title_content: 主标题（≤15字，必须围绕"${ctx.title}"主题，有冲击力/悬念）
2. subtitle_content: 副标题（≤25字，${ctx.isSeries ? `含"第${ctx.episodeNumber}集"信息，` : ''}补充价值点）
3. animation_pattern_id: 从候选模式中选择（也可写 "custom_xxx" 自定义，但需在 beats 中完整描述）
4. beats: 秒级节拍表（3-5 段，覆盖 0-${ctx.durationSec}s 全程）：
   - 每段: { tStart, tEnd, phase(hook/reveal/freeze), visual(画面描述30-60字), camera(运镜), audio(音效事件) }
   - 标题的出现必须落在 reveal 段，且是情绪峰值
   - phase 只允许 hook / reveal / freeze 三个值
5. typography: { structure, material, lighting, motion, description } — 从四维库选词，description 为 100-150 字完整字体设计描述
6. entrance: ${ctx.mainCharacter ? `为 ${ctx.mainCharacter} 设计三阶段入场（foreshadow/emerge/settle），含各阶段时间、画面、运镜、音效` : 'null（无角色片头）'}
7. audio: { signature(0-1秒声音签名), bgm(BGM完整描述), syncNotes(音画同步要点) }
8. duration: ${ctx.durationSec}

硬性约束：
- 禁止出现与主题无关的夸张表述
- 所有描述必须可在真实拍摄/CG渲染中执行，禁止抽象形容词堆砌
- beats 时间必须连续且覆盖全程，最后一段 tEnd 必须等于 ${ctx.durationSec}

直接输出 JSON。`;
  }

  // ============================================================
  // LLM 方案校验与宽容合并
  // ============================================================
  _reconcilePlan(raw, ctx, candidates, typoPreset, entrancePreset) {
    const plan = raw && typeof raw === 'object' ? { ...raw } : {};

    // 标题
    plan.title_content = (plan.title_content || '').trim() || ctx.title;
    plan.subtitle_content = (plan.subtitle_content || '').trim() ||
      (ctx.isSeries ? `第${ctx.episodeNumber}集` : '');

    // 动效模式：LLM 选的不在库里也不在候选里 → 回落到初筛第一名
    const validIds = new Set([...candidates.map(c => c.id)]);
    const isCustom = typeof plan.animation_pattern_id === 'string' && plan.animation_pattern_id.startsWith('custom_');
    if (!plan.animation_pattern_id || (!validIds.has(plan.animation_pattern_id) && !isCustom)) {
      console.warn(`[OpeningCinematicAgent] LLM 选择的动效模式 "${plan.animation_pattern_id}" 无效，回落到 ${candidates[0]?.id}`);
      plan.animation_pattern_id = candidates[0]?.id || 'particle_convergence';
    }

    // beats：缺失/不合法 → 用所选模式的库节拍换算
    const dur = ctx.durationSec;
    const beatsValid = Array.isArray(plan.beats) && plan.beats.length >= 2 &&
      plan.beats.every(b => typeof b.tStart === 'number' && typeof b.tEnd === 'number' && b.tEnd > b.tStart && b.visual);
    if (!beatsValid) {
      console.warn('[OpeningCinematicAgent] LLM beats 不合法，用模式库节拍重建');
      plan.beats = renderPatternBeats(plan.animation_pattern_id, dur).map(b => ({
        ...b, camera: b.camera || '缓推'
      }));
    } else {
      // 强制时间覆盖全程：首段从 0 开始，末段到 dur
      plan.beats[0].tStart = 0;
      plan.beats[plan.beats.length - 1].tEnd = dur;
      // 规范化 phase
      plan.beats = plan.beats.map((b, i) => ({
        ...b,
        phase: ['hook', 'reveal', 'freeze'].includes(b.phase)
          ? b.phase
          : (i === 0 ? 'hook' : (i === plan.beats.length - 1 ? 'freeze' : 'reveal'))
      }));
    }

    // typography：合并 LLM 选择与预设
    const typoLLM = plan.typography || {};
    plan.typography = {
      structure: typoLLM.structure || typoPreset.spec.structure,
      material: typoLLM.material || typoPreset.spec.material,
      lighting: typoLLM.lighting || typoPreset.spec.lighting,
      motion: typoLLM.motion || typoPreset.spec.motion,
      description: (typoLLM.description || '').trim() || typoPreset.promptText
    };

    // entrance：有主角但 LLM 没给 → 用编舞引擎预设
    if (ctx.mainCharacter) {
      if (!plan.entrance || !Array.isArray(plan.entrance.stages) || plan.entrance.stages.length === 0) {
        plan.entrance = entrancePreset
          ? { character: ctx.mainCharacter, stages: entrancePreset.stages }
          : null;
      }
    } else {
      plan.entrance = plan.entrance || null;
    }

    // audio：用音效架构引擎补全
    const audioPreset = designAudio({ mood: ctx.mood, durationSec: dur, beats: plan.beats, character: ctx.mainCharacter, hasVoice: !!ctx.mainCharacter });
    const audioLLM = plan.audio || {};
    plan.audio = {
      signature: (audioLLM.signature || '').trim() || (audioPreset.layers.find(l => l.layer === 'L1-signature')?.content || '品牌声音签名'),
      bgm: (audioLLM.bgm || '').trim() || (audioPreset.layers.find(l => l.layer === 'L2-bed')?.content || ''),
      syncNotes: (audioLLM.syncNotes || '').trim() || audioPreset.mixingNotes.join('；'),
      layers: audioPreset.layers,
      syncMap: audioPreset.syncMap
    };

    plan.duration = dur;
    return plan;
  }

  // ============================================================
  // 规则库完整兜底（LLM 彻底失败时）
  // ============================================================
  _libraryFallback(ctx, candidates, typoPreset, entrancePreset) {
    console.warn('[OpeningCinematicAgent] 使用规则库兜底方案（动效库+字体预设+编舞引擎+音效架构）');
    const patternId = candidates[0]?.id || 'particle_convergence';
    const beats = renderPatternBeats(patternId, ctx.durationSec);
    const pattern = getPattern(patternId);
    // 【修复】全部节拍统一填充槽位（原实现只填标题段，其余段残留 {character} 占位符）
    const fillSlots = (text) => String(text || '')
      .replace(/\{mainTitle\}/g, ctx.title)
      .replace(/\{character\}/g, ctx.mainCharacter || '主角')
      .replace(/\{material\}/g, '材质')
      .replace(/\{trail\}/g, '光尾')
      .replace(/\{carrier\}/g, '载体')
      .replace(/\{environment\}/g, ctx.theme || '环境');
    for (let i = 0; i < beats.length; i++) {
      beats[i] = { ...beats[i], visual: fillSlots(beats[i].visual), audio: fillSlots(beats[i].audio) };
    }
    // 标题槽位注入 reveal 段
    const titleBeatIdx = beats.findIndex(b => b.phase === 'reveal');
    if (titleBeatIdx >= 0 && pattern) {
      beats[titleBeatIdx] = {
        ...beats[titleBeatIdx],
        visual: `${beats[titleBeatIdx].visual}。标题呈现：${fillSlots(pattern.titleSlot)}`
      };
    }

    const audioPreset = designAudio({ mood: ctx.mood, durationSec: ctx.durationSec, beats, character: ctx.mainCharacter, hasVoice: !!ctx.mainCharacter });

    return {
      title_content: ctx.title,
      subtitle_content: ctx.isSeries ? `第${ctx.episodeNumber}集` : '',
      animation_pattern_id: patternId,
      beats: beats.map(b => ({ ...b, camera: '缓推/固定（按 phase 调整）' })),
      typography: {
        ...typoPreset.spec,
        description: typoPreset.promptText
      },
      entrance: entrancePreset
        ? { character: ctx.mainCharacter, stages: entrancePreset.stages }
        : null,
      audio: {
        signature: audioPreset.layers.find(l => l.layer === 'L1-signature')?.content || '品牌声音签名',
        bgm: audioPreset.layers.find(l => l.layer === 'L2-bed')?.content || '',
        syncNotes: audioPreset.mixingNotes.join('；'),
        layers: audioPreset.layers,
        syncMap: audioPreset.syncMap
      },
      duration: ctx.durationSec
    };
  }

  // ============================================================
  // 编译：秒级时间轴文本（注入渲染 prompt / timeline 字段）
  // ============================================================
  _compilePromptTimeline(plan, ctx) {
    const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    const lines = plan.beats.map(b =>
      `T${fmt(b.tStart)}-${fmt(b.tEnd)} [${b.phase}] ${b.visual}${b.camera ? `（运镜:${b.camera}）` : ''}${b.audio ? `（音效:${b.audio}）` : ''}`
    );

    // 角色入场阶段并入时间轴（若与 beats 不重复）
    if (plan.entrance && Array.isArray(plan.entrance.stages)) {
      lines.push('--- 角色入场编舞 ---');
      for (const s of plan.entrance.stages) {
        lines.push(`T${fmt(s.tStart)}-${fmt(s.tEnd)} [${s.stage}] ${s.description}${s.camera ? `（运镜:${s.camera}）` : ''}${s.audio ? `（音效:${s.audio}）` : ''}`);
      }
    }

    lines.push(`--- 标题呈现 ---`);
    lines.push(`主标题「${plan.title_content}」${plan.subtitle_content ? ` / 副标题「${plan.subtitle_content}」` : ''}`);
    lines.push(`字体: ${plan.typography.description}`);

    return lines.join('\n');
  }

  // ============================================================
  // 编译：后期制作元数据
  // ============================================================
  _compilePostProduction(plan, ctx) {
    return {
      titleCard: {
        mainTitle: plan.title_content,
        subTitle: plan.subtitle_content,
        typography: plan.typography,
        animationPattern: plan.animation_pattern_id,
        duration: plan.duration
      },
      audioCues: {
        signature: plan.audio.signature,
        bgm: plan.audio.bgm,
        layers: plan.audio.layers || [],
        syncMap: plan.audio.syncMap || []
      },
      entranceChoreography: plan.entrance || null,
      meta: {
        genre: ctx.genre,
        mood: ctx.mood,
        episodeNumber: ctx.episodeNumber,
        isSeries: ctx.isSeries
      }
    };
  }
}

module.exports = { OpeningCinematicAgent, PLAN_SCHEMA };
