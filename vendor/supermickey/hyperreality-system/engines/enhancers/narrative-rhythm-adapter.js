/**
 * Narrative Rhythm Adapter — 叙事节奏引擎 (SuperMickey 适配版)
 *
 * 来源: 暴风战斧 narrative-rhythm-engine.js
 * 适配: SuperMickey 四层架构，在 Layer 2 制作引擎中调用
 *
 * 核心能力：
 * - 三幕式结构：SETUP → DEVELOPMENT → CLIMAX/RESOLUTION
 * - 情绪曲线：build/release/wave/collapse
 * - 节拍设计：camera/action/lighting/reveal/emotion
 * - 动静对比：6 种模式
 *
 * 注入点：ProductionEngine 生成每个镜头提示词时，自动注入叙事节奏描述
 */

const path = require('path');
const fs = require('fs');

// 复用暴风战斧的叙事节奏引擎核心逻辑
class NarrativeRhythmEngine {
  constructor() {
    this.version = 'v2.0-Peng-SuperMickey';

    this.THREE_ACT_TEMPLATE = {
      setup: {
        range: [0, 0.4],
        name: 'SETUP',
        description: '建立空间、引入主体、设定基调',
        actionIntensity: 'low',
        pace: 'slow or static',
        purpose: 'establish, accumulate, introduce'
      },
      development: {
        range: [0.3, 0.7],
        name: 'DEVELOPMENT',
        description: '动作展开、冲突/穿越、张力累积',
        actionIntensity: 'medium to high',
        pace: 'accelerating',
        purpose: 'develop, escalate, conflict'
      },
      climax: {
        range: [0.6, 1.0],
        name: 'CLIMAX/RESOLUTION',
        description: '高潮揭示、情绪释放、定格收束',
        actionIntensity: 'peak then freeze',
        pace: 'peak → solidify',
        purpose: 'climax, release, resolve'
      }
    };

    this.EMOTION_CURVES = {
      build: {
        stages: [
          { pos: 0, intensity: 'low', label: '建立，安静进入' },
          { pos: 0.1, intensity: 'low-mid', label: '发展，信息积累' },
          { pos: 0.3, intensity: 'mid', label: '转折，节奏变化' },
          { pos: 0.5, intensity: 'mid-high', label: '加速，张力上升' },
          { pos: 0.7, intensity: 'high', label: '高潮，峰值体验' },
          { pos: 0.9, intensity: 'frozen', label: '定格，余韵' }
        ]
      },
      release: {
        stages: [
          { pos: 0, intensity: 'high', label: '冲击开场' },
          { pos: 0.2, intensity: 'high-mid', label: '维持张力' },
          { pos: 0.4, intensity: 'mid', label: '释放' },
          { pos: 0.6, intensity: 'mid-low', label: '回落' },
          { pos: 0.8, intensity: 'low', label: '平静' },
          { pos: 1.0, intensity: 'low', label: '余韵' }
        ]
      },
      wave: {
        stages: [
          { pos: 0, intensity: 'low', label: '平缓' },
          { pos: 0.25, intensity: 'mid', label: '第一次波动' },
          { pos: 0.5, intensity: 'low', label: '回落' },
          { pos: 0.75, intensity: 'high', label: '第二次波动（更高）' },
          { pos: 0.9, intensity: 'peak', label: '峰值' },
          { pos: 1.0, intensity: 'frozen', label: '定格' }
        ]
      },
      collapse: {
        stages: [
          { pos: 0, intensity: 'peak', label: '冲击开始' },
          { pos: 0.15, intensity: 'high', label: '维持' },
          { pos: 0.3, intensity: 'mid', label: '开始崩塌' },
          { pos: 0.5, intensity: 'low', label: '加速下落' },
          { pos: 0.75, intensity: 'low', label: '触底' },
          { pos: 1.0, intensity: 'frozen', label: '凝固' }
        ]
      }
    };

    this.BEAT_TYPES = {
      camera: {
        name: '机位节拍',
        description: '镜头运动或切换',
        examples: ['从水下到破出水面', '推进到角色面部', '环绕 360°']
      },
      action: {
        name: '动作节拍',
        description: '主体或环境的新动作',
        examples: ['浪从涌起到破碎', '角色开始奔跑', '门突然打开']
      },
      lighting: {
        name: '光影节拍',
        description: '光线的显著变化',
        examples: ['从暗到亮', '轮廓光出现', '闪电照亮场景']
      },
      reveal: {
        name: '揭示节拍',
        description: '新信息的展现',
        examples: ['人物从黑暗中显现', '镜头揭示全貌', '关键道具出现']
      },
      emotion: {
        name: '情绪节拍',
        description: '情绪基调的转换',
        examples: ['从紧张到宁静', '希望出现', '绝望加深']
      }
    };

    // 【P0-NE-01 新增】镜头级呼吸节奏模板
    this.BREATHING_RHYTHM = {
      // 紧张-放松交替模式
      tensionRelease: [
        { shot: 0, intensity: 0.3, hold: '2s', note: 'establish, let audience settle' },
        { shot: 1, intensity: 0.6, hold: '1.5s', note: 'building, breath shortens' },
        { shot: 2, intensity: 0.4, hold: '2.5s', note: 'brief release, audience exhales' },
        { shot: 3, intensity: 0.8, hold: '1s', note: 'peak tension, breath held' },
        { shot: 4, intensity: 0.3, hold: '3s', note: 'deep release, emotional landing' }
      ],
      // 渐进式加速
      acceleration: [
        { shot: 0, intensity: 0.2, hold: '3s', note: 'slow, contemplative' },
        { shot: 1, intensity: 0.4, hold: '2s', note: 'picking up' },
        { shot: 2, intensity: 0.6, hold: '1.5s', note: 'accelerating' },
        { shot: 3, intensity: 0.8, hold: '1s', note: 'near peak' },
        { shot: 4, intensity: 1.0, hold: '0.8s', note: 'maximum intensity' }
      ],
      // 波浪式起伏（适合抒情/治愈类）
      wave: [
        { shot: 0, intensity: 0.3, hold: '2.5s', note: 'gentle opening, soft focus' },
        { shot: 1, intensity: 0.5, hold: '2s', note: 'rising warmth' },
        { shot: 2, intensity: 0.3, hold: '2.5s', note: 'easing back, breath' },
        { shot: 3, intensity: 0.7, hold: '1.5s', note: 'deeper wave' },
        { shot: 4, intensity: 0.4, hold: '3s', note: 'gentle resolution' }
      ]
    };

    this.DYNAMIC_MODES = {
      movingSubject_staticEnv: {
        name: '动主体+静环境',
        effect: '主体突出，孤独感',
        terms: ['person running through still landscape', 'figure walking in empty space', 'solo dancer against static backdrop']
      },
      staticSubject_movingEnv: {
        name: '静主体+动环境',
        effect: '环境力量，主体脆弱',
        terms: ['person standing still in raging storm', 'character facing advancing flames', 'warrior holding ground against tide']
      },
      sync: {
        name: '动+动同步',
        effect: '和谐，融入',
        terms: ['dancer moving with flowing water', 'runner matching pace with wind', 'surfer riding wave in harmony']
      },
      conflict: {
        name: '动+动对抗',
        effect: '冲突，张力',
        terms: ['person running against strong wind', 'swimmer battling current', 'soldier advancing under fire']
      },
      allMotion: {
        name: '全动',
        effect: '混乱，失控',
        terms: ['everything in motion, chaotic scene', 'storm raging, debris flying, waves crashing', 'crowd surging forward']
      },
      allStatic: {
        name: '全静',
        effect: '凝固，永恒',
        terms: ['completely still, frozen in time', 'scene locked in moment of silence', 'everything suspended']
      }
    };
  }

  /**
   * 构建情绪曲线描述
   */
  buildEmotionCurve(curveType, totalDuration = 10) {
    const curve = this.EMOTION_CURVES[curveType] || this.EMOTION_CURVES.build;
    const stages = curve.stages;

    let parts = [];
    stages.forEach(stage => {
      const time = Math.round(stage.pos * totalDuration);
      parts.push(`[${time}s] ${stage.label}`);
    });

    return `emotion arc: ${curveType} | ${parts.join(' → ')}`;
  }

  /**
   * 构建三幕结构
   */
  buildThreeActStructure(totalDuration = 10, breathingPattern = 'tensionRelease') {
    const result = {};
    for (const [key, act] of Object.entries(this.THREE_ACT_TEMPLATE)) {
      const start = Math.round(act.range[0] * totalDuration);
      const end = Math.round(act.range[1] * totalDuration);
      result[key] = {
        name: act.name,
        timeRange: `[${start}s-${end}s]`,
        description: act.description,
        intensity: act.actionIntensity,
        pace: act.pace
      };
    }
    // 【P0-NE-01】增加呼吸节奏
    const pattern = this.BREATHING_RHYTHM[breathingPattern] || this.BREATHING_RHYTHM.tensionRelease;
    result._breathingPattern = {
      type: breathingPattern,
      pattern: pattern.map(p => `${p.shot}: intensity=${p.intensity}, hold=${p.hold}`).join(' | ')
    };
    return result;
  }

  /**
   * 构建节拍设计
   */
  buildBeats(totalDuration = 10, beatInterval = 2.5, beatTypes = ['action', 'camera']) {
    let beats = [];
    let currentTime = 0;
    let beatIndex = 0;

    while (currentTime < totalDuration) {
      const beatType = beatTypes[beatIndex % beatTypes.length];
      const beatDef = this.BEAT_TYPES[beatType];
      const example = beatDef.examples[Math.floor(Math.random() * beatDef.examples.length)];
      beats.push(`[${Math.round(currentTime)}s] ${beatDef.name}: ${example}`);
      currentTime += beatInterval + (Math.random() * 1 - 0.5);
      beatIndex++;
    }

    return beats.join(' | ');
  }

  /**
   * 获取动静对比模式
   */
  getDynamicMode(modeKey) {
    const mode = this.DYNAMIC_MODES[modeKey];
    if (!mode) return '';
    const term = mode.terms[Math.floor(Math.random() * mode.terms.length)];
    return `${mode.name} | ${mode.effect} | ${term}`;
  }

  /**
   * 构建完整叙事节奏
   */
  build(config = {}) {
    const { curveType = 'build', duration = 10, dynamicMode = '', beatInterval = 2.5, breathingPattern = 'tensionRelease' } = config;

    let parts = [];
    parts.push(this.buildEmotionCurve(curveType, duration));
    const threeAct = this.buildThreeActStructure(duration, breathingPattern);
    parts.push(`narrative structure: SETUP${threeAct.setup.timeRange} ${threeAct.setup.intensity} → DEVELOP${threeAct.development.timeRange} ${threeAct.development.intensity} → CLIMAX${threeAct.climax.timeRange} ${threeAct.climax.intensity}`);
    parts.push(`breathing: ${threeAct._breathingPattern.type}`);
    if (dynamicMode && this.DYNAMIC_MODES[dynamicMode]) {
      const mode = this.DYNAMIC_MODES[dynamicMode];
      parts.push(`dynamic contrast: ${mode.name} — ${mode.effect}`);
    }
    return parts.join(' | ');
  }

  getRecommendedBeatInterval(duration) {
    if (duration <= 5) return 1.5;
    if (duration <= 10) return 2.5;
    if (duration <= 15) return 3;
    return 4;
  }

  listEmotionCurves() {
    return Object.keys(this.EMOTION_CURVES);
  }

  listDynamicModes() {
    return Object.keys(this.DYNAMIC_MODES);
  }
}

// ========== SuperMickey 适配器 ==========

class NarrativeRhythmAdapter {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.engine = new NarrativeRhythmEngine();
    this.intensity = options.intensity || 0.5; // 0.0-1.0
    this.logPath = options.logPath || path.join(__dirname, '..', '..', 'output', 'narrative-rhythm-log.json');
  }

  /**
   * SuperMickey 主入口：增强剧本的叙事节奏
   * @param {Object} blueprint - 剧本蓝图 (ScriptEngine 输出)
   * @param {Object} metadata - 元数据
   * @returns {Object} { blueprint, rhythmProfile }
   */
  enhance(blueprint, metadata = {}) {
    if (!this.enabled || !blueprint || !blueprint.scenes) {
      return { blueprint, rhythmProfile: null };
    }

    console.log('\n🎼 [NarrativeRhythm] 叙事节奏增强...');

    const duration = metadata.targetDuration || blueprint.duration || 10;
    const curveType = this._selectCurveType(metadata);
    const dynamicMode = this._selectDynamicMode(blueprint);
    const beatInterval = this.engine.getRecommendedBeatInterval(duration);

    // 构建整体叙事节奏描述
    const breathingPattern = this._selectBreathingPattern(metadata, blueprint.scenes.length);
    const rhythmProfile = this.engine.build({
      curveType,
      duration,
      dynamicMode,
      beatInterval,
      breathingPattern
    });

    // 为每个场景分配情绪目标 + 呼吸节奏
    const breathingPatternData = this.engine.BREATHING_RHYTHM[breathingPattern] || this.engine.BREATHING_RHYTHM.tensionRelease;
    const enhancedScenes = [];
    for (let i = 0; i < blueprint.scenes.length; i++) {
      const scene = blueprint.scenes[i];
      const scenePosition = blueprint.scenes.length > 1 ? i / (blueprint.scenes.length - 1) : 0;
      const emotionTarget = this._getEmotionTarget(curveType, scenePosition);
      const breath = breathingPatternData[i % breathingPatternData.length];

      enhancedScenes.push({
        ...scene,
        _rhythm: {
          position: scenePosition,
          emotionTarget,
          act: this._getActForPosition(scenePosition),
          beatInterval,
          // 【P0-NE-01】增加呼吸节奏
          breath: {
            intensity: breath.intensity,
            hold: breath.hold,
            note: breath.note
          }
        }
      });
    }

    const enhancedBlueprint = {
      ...blueprint,
      scenes: enhancedScenes,
      _rhythmProfile: {
        curveType,
        duration,
        dynamicMode,
        beatInterval,
        fullDescription: rhythmProfile
      }
    };

    console.log(`   ✅ 叙事节奏增强完成`);
    console.log(`      情绪曲线: ${curveType} | 动静模式: ${dynamicMode || 'auto'}`);
    console.log(`      节拍间隔: ${beatInterval}s | 场景数: ${enhancedScenes.length}`);

    // 保存报告
    this._saveReport({
      curveType,
      duration,
      dynamicMode,
      beatInterval,
      scenes: enhancedScenes.length
    });

    return { blueprint: enhancedBlueprint, rhythmProfile };
  }

  // ========== 私有方法 ==========

  _selectBreathingPattern(metadata, sceneCount) {
    // 【P0-NE-01】根据类型和场景数选择呼吸模式
    const type = metadata.type || '';
    const tone = metadata.tone || metadata.emotion || '';

    // 抒情/治愈/家庭温情类 → 波浪式
    if (/温情|治愈|抒情|浪漫|家庭/.test(type) || /温暖|柔和|治愈/.test(tone)) {
      return 'wave';
    }
    // 动作/悬疑/恐怖类 → 渐进加速
    if (/动作|悬疑|恐怖|科幻/.test(type) || /紧张|刺激|高能/.test(tone)) {
      return 'acceleration';
    }
    // 场景数较少（≤3）→ 波浪式，避免紧张释放过于急促
    if (sceneCount <= 3) {
      return 'wave';
    }
    // 默认：紧张-放松交替
    return 'tensionRelease';
  }

  _selectCurveType(metadata) {
    // 从 metadata 中推断情绪曲线类型
    const intent = metadata.intent || '';
    const style = metadata.style || {};

    if (intent.includes('回忆') || intent.includes('怀旧') || intent.includes('过去')) {
      return 'wave';
    }
    if (intent.includes('冲击') || intent.includes('震撼') || intent.includes('高潮')) {
      return 'build';
    }
    if (intent.includes('释然') || intent.includes('平静') || intent.includes('结束')) {
      return 'release';
    }
    if (intent.includes('崩塌') || intent.includes('坠落') || intent.includes('崩溃')) {
      return 'collapse';
    }
    if (style.primary === '悬疑' || style.primary === '紧张') {
      return 'build';
    }
    if (style.primary === '抒情' || style.primary === '治愈') {
      return 'wave';
    }

    return 'build'; // 默认
  }

  _selectDynamicMode(blueprint) {
    // 从场景内容推断动静对比模式
    const scenes = blueprint.scenes || [];
    if (scenes.length === 0) return '';

    // 简单启发式：如果场景描述中包含环境运动词，选择静主体+动环境
    const hasEnvMotion = scenes.some(s =>
      /风|雨|浪|火|雪|烟|雾|流|飘|旋|涌/.test(s.description || s.text || '')
    );
    const hasSubjectMotion = scenes.some(s =>
      /跑|跳|飞|追|逃|战|舞|奔|冲/.test(s.description || s.text || '')
    );

    if (hasEnvMotion && !hasSubjectMotion) return 'staticSubject_movingEnv';
    if (!hasEnvMotion && hasSubjectMotion) return 'movingSubject_staticEnv';
    if (hasEnvMotion && hasSubjectMotion) return 'conflict';
    return '';
  }

  _getEmotionTarget(curveType, position) {
    const curve = this.engine.EMOTION_CURVES[curveType] || this.engine.EMOTION_CURVES.build;
    const stages = curve.stages;

    // 找到最近的阶段
    let closestStage = stages[0];
    let minDist = Math.abs(stages[0].pos - position);
    for (const stage of stages) {
      const dist = Math.abs(stage.pos - position);
      if (dist < minDist) {
        minDist = dist;
        closestStage = stage;
      }
    }

    return {
      intensity: closestStage.intensity,
      label: closestStage.label
    };
  }

  _getActForPosition(position) {
    if (position <= 0.4) return 'setup';
    if (position <= 0.7) return 'development';
    return 'climax';
  }

  _saveReport(data) {
    try {
      const report = {
        timestamp: new Date().toISOString(),
        ...data
      };
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      let logs = [];
      if (fs.existsSync(this.logPath)) {
        logs = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
      }
      logs.push(report);
      fs.writeFileSync(this.logPath, JSON.stringify(logs, null, 2));
    } catch (e) {
      console.warn('⚠️ NarrativeRhythm 报告保存失败:', e.message);
    }
  }
}

module.exports = { NarrativeRhythmAdapter, NarrativeRhythmEngine };
