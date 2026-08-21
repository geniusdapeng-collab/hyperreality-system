// beat-sheet-engine.js — StoryCraft Engine v1.1
// 叙事节拍器：将高概念种子转化为5节拍结构，严格适配60秒
// v1.1升级：集成VisualActionTranslator，直观动作替代概念叙述

const { VisualActionTranslator } = require('./visual-action-translator');

class BeatSheetEngine {
  constructor(options = {}) {
    this.duration = options.duration || 15; // 总时长（秒）
    this.beatsPerStory = 5; // 固定5节拍
    this.beatDuration = Math.floor(this.duration / this.beatsPerStory); // 每节拍时长
    this.emotionCurve = options.emotionCurve || this.getDefaultEmotionCurve();
    
    // v1.1新增：视觉动作翻译器
    this.visualTranslator = new VisualActionTranslator(options.visualAction || {});
  }

  // 默认情绪曲线：好奇→紧张→困惑→震撼→释然
  getDefaultEmotionCurve() {
    return [
      { phase: 'hook', emotion: 'curious', intensity: 0.3, target: 0.12 },
      { phase: 'deepen', emotion: 'tension', intensity: 0.5, target: 0.24 },
      { phase: 'crack', emotion: 'confusion', intensity: 0.7, target: 0.36 },
      { phase: 'twist', emotion: 'awe', intensity: 0.9, target: 0.48 },
      { phase: 'resonance', emotion: 'relief', intensity: 0.8, target: 0.60 }
    ];
  }

  // 核心方法：将概念种子转化为5节拍结构（v2.0升级：60秒三幕引擎映射）
  generateBeatSheet(conceptSeed, beastProfile, options = {}) {
    const { theme, coreTwist, emotionalAnchor } = conceptSeed;
    
    // 提取v2.0感知蓝图（如果可用）
    const sensoryBlueprint = beastProfile.psyche?.sensoryBlueprint || null;
    
    // 生成5节拍
    const beats = [
      this.generateBeat1_Hook(theme, beastProfile, options, sensoryBlueprint),
      this.generateBeat2_Deepen(theme, beastProfile, options, sensoryBlueprint),
      this.generateBeat3_Crack(theme, coreTwist, beastProfile, options, sensoryBlueprint),
      this.generateBeat4_Twist(theme, coreTwist, emotionalAnchor, beastProfile, options, sensoryBlueprint),
      this.generateBeat5_Resonance(theme, emotionalAnchor, beastProfile, options, sensoryBlueprint)
    ];

    // 分配时间和情绪
    const timedBeats = this.allocateTimeAndEmotion(beats);
    
    // v1.1新增：视觉动作翻译（直观动作替代概念叙述）
    const visualTranslatedBeats = this.translateBeatsToVisual(timedBeats, beastProfile);
    
    // v2.0新增：60秒三幕引擎映射 + 感知锚点 + 静默高潮
    const threeActBeats = this.applyThreeActEngine(visualTranslatedBeats, beastProfile, conceptSeed);
    
    // 验证结构完整性
    const validation = this.validateBeatSheet(threeActBeats);
    
    return {
      beats: threeActBeats,
      validation,
      metadata: {
        totalDuration: this.duration,
        beatDuration: this.beatDuration,
        emotionCurve: this.emotionCurve,
        conceptSeed,
        visualTranslation: threeActBeats.visualStats, // v1.1新增
        threeActEngine: { // v2.0新增
          actBreaks: [0, 12, 40, 60],
          actNames: ['入侵(0-12s)', '震颤(12-40s)', '蜕变(40-60s)'],
          silenceBudget: 8,
          sensoryAnchor: sensoryBlueprint?.primary || '主要感官'
        }
      }
    };
  }

  // Beat-1: 钩子 (0-12s) — 建立异兽的日常/孤独状态
  generateBeat1_Hook(theme, beastProfile, options) {
    const { name, signatureFeatures, habitat, psyche } = beastProfile;
    
    return {
      id: 'B1',
      name: '钩子',
      timeRange: { start: 0, end: this.beatDuration },
      narrativeFunction: '建立异兽的日常/孤独状态，展示它在做什么',
      visualTask: `展示${name}在${habitat}的日常行为（不是"登场"，是"生活"）`,
      emotionTarget: { emotion: 'curious', intensity: 0.3 },
      requiredElements: [
        '异兽在做什么（具体动作）',
        '环境细节（Nirath专属元素）',
        '一个"不对劲"的细节（暗示异常）'
      ],
      // 生成narration和visualPrompt的模板
      narrationTemplate: this.generateNarrationTemplate('hook', beastProfile, theme),
      visualPromptTemplate: this.generateVisualTemplate('hook', beastProfile, theme),
      // 异兽内心独白（Psyche Generator会填充）
      beastMonologue: null,
      // 人类视角
      humanPerspective: '看到异兽，感到好奇和轻微不安'
    };
  }

  // Beat-2: 深入 (12-24s) — 人类闯入，异兽的第一反应
  generateBeat2_Deepen(theme, beastProfile, options) {
    const { name, habitat } = beastProfile;
    
    return {
      id: 'B2',
      name: '深入',
      timeRange: { start: this.beatDuration, end: this.beatDuration * 2 },
      narrativeFunction: '人类闯入，异兽的第一反应（警觉/评估）',
      visualTask: `异兽视角："这是什么？危险吗？"`,
      emotionTarget: { emotion: 'tension', intensity: 0.5 },
      requiredElements: [
        '小G的出现方式（意外闯入/主动探索/被吸引）',
        '异兽的警觉反应（不是攻击，是评估）',
        '双方第一次"看见"对方'
      ],
      narrationTemplate: this.generateNarrationTemplate('deepen', beastProfile, theme),
      visualPromptTemplate: this.generateVisualTemplate('deepen', beastProfile, theme),
      beastMonologue: null,
      humanPerspective: '面对巨兽，心跳加速但没有逃跑'
    };
  }

  // Beat-3: 裂缝 (24-36s) — 第一个真相碎片
  generateBeat3_Crack(theme, coreTwist, beastProfile, options) {
    const { name, signatureFeatures } = beastProfile;
    
    return {
      id: 'B3',
      name: '裂缝',
      timeRange: { start: this.beatDuration * 2, end: this.beatDuration * 3 },
      narrativeFunction: '第一个真相碎片——观众开始怀疑之前的理解',
      visualTask: `展示${name}的"可怕特征"实际上是"守护工具"的第一个证据`,
      emotionTarget: { emotion: 'confusion', intensity: 0.7 },
      requiredElements: [
        '一个"反常"动作（与异兽"恐怖"形象矛盾）',
        '小G注意到这个反常',
        '观众和小G同时产生疑问'
      ],
      narrationTemplate: this.generateNarrationTemplate('crack', beastProfile, theme, coreTwist),
      visualPromptTemplate: this.generateVisualTemplate('crack', beastProfile, theme, coreTwist),
      beastMonologue: null,
      humanPerspective: '困惑："它在……做什么？这不是攻击……"'
    };
  }

  // Beat-4: 翻转 (36-48s) — 核心真相揭露
  generateBeat4_Twist(theme, coreTwist, emotionalAnchor, beastProfile, options) {
    const { name, signatureFeatures } = beastProfile;
    
    return {
      id: 'B4',
      name: '翻转',
      timeRange: { start: this.beatDuration * 3, end: this.beatDuration * 4 },
      narrativeFunction: '核心真相揭露，完全颠覆前3个Beat的理解',
      visualTask: `${name}的"可怕特征"原来是"${coreTwist}"`,
      emotionTarget: { emotion: 'awe', intensity: 0.9 },
      requiredElements: [
        '核心真相的视觉呈现（必须震撼）',
        '异兽的"脆弱/温柔"一面暴露',
        '小G的反应（从恐惧到理解）'
      ],
      narrationTemplate: this.generateNarrationTemplate('twist', beastProfile, theme, coreTwist, emotionalAnchor),
      visualPromptTemplate: this.generateVisualTemplate('twist', beastProfile, theme, coreTwist, emotionalAnchor),
      beastMonologue: null,
      humanPerspective: '震撼："原来……它是这样的……"'
    };
  }

  // Beat-5: 余韵 (48-60s) — 和解/礼物/代价
  generateBeat5_Resonance(theme, emotionalAnchor, beastProfile, options) {
    const { name, habitat } = beastProfile;
    
    return {
      id: 'B5',
      name: '余韵',
      timeRange: { start: this.beatDuration * 4, end: this.duration },
      narrativeFunction: '和解/礼物/代价，主题定格',
      visualTask: `${name}和小G的共同画面，主题${theme}的视觉化`,
      emotionTarget: { emotion: 'relief', intensity: 0.8 },
      requiredElements: [
        '和解的视觉符号（触碰/共享/并肩）',
        '环境的变化（呼应Beat-1，但已不同）',
        '主题的"一帧定格"'
      ],
      narrationTemplate: this.generateNarrationTemplate('resonance', beastProfile, theme, emotionalAnchor),
      visualPromptTemplate: this.generateVisualTemplate('resonance', beastProfile, theme, emotionalAnchor),
      beastMonologue: null,
      humanPerspective: '释然："它被理解了……"'
    };
  }

  // 生成narration模板（供后续填充）
  generateNarrationTemplate(phase, beastProfile, theme, coreTwist = null, emotionalAnchor = null) {
    // 🔥 修复：habitat可能是对象，提取name字段
    const habitatName = typeof beastProfile.habitat === 'string' ? beastProfile.habitat : (beastProfile.habitat?.name || 'Nirath荒原');
    
    const templates = {
      hook: `${beastProfile.name}在${habitatName}的日复一日……但今天，有些不同。`,
      deepen: `一个8岁的男孩闯入了这片领地。${beastProfile.name}的第一反应不是攻击——是评估。`,
      crack: `${beastProfile.name}做出了一个"反常"的举动。那不是攻击……那是……？`,
      twist: `真相揭露：${beastProfile.name}的${beastProfile.signatureFeatures?.[0] || '特征'}，原来是${coreTwist || '被误解的守护'}。`,
      resonance: `${emotionalAnchor || '理解'}比征服更有力量。${beastProfile.name}终于……被看见了。`
    };
    return templates[phase] || '';
  }

  // 生成visualPrompt模板（供后续填充）
  generateVisualTemplate(phase, beastProfile, theme, coreTwist = null, emotionalAnchor = null) {
    const { name, habitat, signatureFeatures } = beastProfile;
    // 🔥 修复：habitat可能是对象，提取name字段
    const habitatName = typeof habitat === 'string' ? habitat : (habitat?.name || 'Nirath荒原');
    const feature = signatureFeatures?.[0] || '独特特征';
    
    const templates = {
      hook: `Nirath ${habitatName}，${name}在进行日常行为（不是攻击姿态），环境细节暗示异常`,
      deepen: `${name}警觉反应（毛发竖立/低吼/眼神变化），小G意外闯入，双方第一次对视`,
      crack: `${name}展示${feature}，但动作是"守护/创造"而非"攻击/毁灭"，小G注意到矛盾`,
      twist: `${name}的核心真相视觉化：${feature} = ${coreTwist}，环境发生剧变，小G表情从恐惧到理解`,
      resonance: `${name}和小G同框（触碰/共享/并肩），${habitatName}环境呼应开场但已重生/改变，主题定格画面`
    };
    return templates[phase] || '';
  }

  // 分配时间和情绪
  allocateTimeAndEmotion(beats) {
    return beats.map((beat, index) => {
      const curve = this.emotionCurve[index];
      return {
        ...beat,
        timeRange: {
          start: index * this.beatDuration,
          end: (index + 1) * this.beatDuration
        },
        emotionTarget: {
          emotion: curve.emotion,
          intensity: curve.intensity,
          targetTime: curve.target
        }
      };
    });
  }

  /**
   * 【v6.0-patch22 新增】POV视角锁定器
   * 将通用visualPrompt转化为异兽主观视角（POV）
   * 
   * POV锁定规则：
   * 1. 镜头高度 = 异兽眼高（非人类眼高）
   * 2. 画面边缘有异兽身体部分入镜（暗示"这是它的眼睛"）
   * 3. 环境解读带异兽主观色彩（如"这些植物闻起来像记忆"）
   * 
   * @param {String} visualPrompt - 原始visualPrompt
   * @param {String} phase - 节拍阶段（hook/deepen/crack/twist/resonance）
   * @param {Object} beastProfile - 异兽档案
   * @returns {String} POV锁定后的visualPrompt
   */
  applyPOVLock(visualPrompt, phase, beastProfile) {
    const { name, signatureFeatures = [] } = beastProfile;
    const feature = signatureFeatures[0] || '独特特征';
    
    // 根据phase选择POV策略
    const povStrategies = {
      hook: {
        eyeLevel: '从异兽眼高拍摄（约2.5米，非人类1.6米）',
        edgeFrame: `画面右下角隐约可见${name}的${feature}边缘，暗示这是它的主观视角`,
        subjective: `环境细节带有${name}的主观感知：气味、温度、磁场的微弱震颤`
      },
      deepen: {
        eyeLevel: `从${name}的眼睛高度拍摄，小G在画面中显得渺小（8岁男孩仅及${name}胸部）`,
        edgeFrame: `画面左侧边缘可见${name}的毛发/皮肤纹理，强调"这是它的眼睛在看"`,
        subjective: `${name}的视角下，小G的动作被慢放解读——他的手势是友好还是威胁？`
      },
      crack: {
        eyeLevel: '低角度从异兽胸口高度向上拍摄，小G和天空同时入镜',
        edgeFrame: `画面上方边缘${name}的下颚/毛发入镜，暗示它在低头注视`,
        subjective: `${name}注意到小G眼中的变化——从恐惧到困惑，这是300年来第一次`
      },
      twist: {
        eyeLevel: `从${name}腋下双眼的高度拍摄（暗红色竖瞳视角），世界呈现出不同的光谱`,
        edgeFrame: `画面四角被${name}的毛发/皮肤包围，形成天然画框——"透过它的眼睛看世界"`,
        subjective: `腋下双眼看到的"黑暗"其实是正在过滤的毒素，色彩在红外光谱中呈现为温暖的金橙色`
      },
      resonance: {
        eyeLevel: `从${name}低头的高度拍摄，小G在画面中央，${name}的前肢/身体在画面边缘形成保护性包围`,
        edgeFrame: `画面上方边缘${name}的下巴/嘴角入镜（不再可怕，而是温柔的弧度）`,
        subjective: `${name}的视角：小G手掌中的种子发出与孢子相同频率的微光——这是它300年来第一次"被看见"`
      }
    };
    
    const strategy = povStrategies[phase] || povStrategies.hook;
    
    // 构建POV注入文本
    const povInjection = [
      `【POV：${name}主观视角】`,
      strategy.eyeLevel,
      strategy.edgeFrame,
      strategy.subjective
    ].join('，');
    
    // 将POV注入到visualPrompt末尾
    const separator = visualPrompt.endsWith('。') ? '' : '。';
    return visualPrompt + separator + povInjection + '。';
  }

  /**
   * 【v6.0-patch22 新增】为所有节拍应用POV锁定
   * 在 mapBeatsToShots 后调用，统一锁定所有镜头的POV
   */
  applyPOVToAllShots(shots, beastProfile) {
    return shots.map(shot => {
      const phaseMap = {
        '钩子': 'hook', '深入': 'deepen', '裂缝': 'crack', '翻转': 'twist', '余韵': 'resonance',
        'hook': 'hook', 'deepen': 'deepen', 'crack': 'crack', 'twist': 'twist', 'resonance': 'resonance'
      };
      const phase = phaseMap[shot.beatName] || 'hook';
      
      const povVisualPrompt = this.applyPOVLock(shot.visualPrompt, phase, beastProfile);
      
      return {
        ...shot,
        visualPrompt: povVisualPrompt,
        _povLock: {
          phase,
          beastName: beastProfile.name,
          applied: true
        }
      };
    });
  }

  // 验证5节拍结构完整性
  validateBeatSheet(beats) {
    const errors = [];
    const warnings = [];

    // 检查1：必须有5个节拍
    if (beats.length !== 5) {
      errors.push(`节拍数量错误：${beats.length}（应为5）`);
    }

    // 检查2：每个节拍必须有明确的叙事功能
    beats.forEach((beat, index) => {
      if (!beat.narrativeFunction || beat.narrativeFunction.length < 10) {
        errors.push(`Beat-${index + 1} 叙事功能缺失或过于简单`);
      }
    });

    // 检查3：情绪曲线必须有峰值（Beat-4）
    const peakBeat = beats.find(b => b.id === 'B4');
    if (!peakBeat || peakBeat.emotionTarget.intensity < 0.7) {
      errors.push('Beat-4（翻转）情绪强度不足，缺少情绪峰值');
    }

    // 检查4：时间连续性
    for (let i = 1; i < beats.length; i++) {
      if (beats[i].timeRange.start !== beats[i-1].timeRange.end) {
        errors.push(`Beat-${i+1} 时间不连续`);
      }
    }

    // 检查5：总时长是否匹配
    const totalTime = beats[beats.length - 1]?.timeRange.end || 0;
    if (totalTime !== this.duration) {
      warnings.push(`总时长 ${totalTime}s 与目标 ${this.duration}s 不匹配`);
    }

    // 检查6：必须有反转锚点（Beat-3和Beat-4）
    const hasCrack = beats.some(b => b.id === 'B3');
    const hasTwist = beats.some(b => b.id === 'B4');
    if (!hasCrack || !hasTwist) {
      errors.push('缺少裂缝(B3)或翻转(B4)节拍，无反转结构');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      summary: {
        totalBeats: beats.length,
        totalDuration: totalTime,
        hasHook: beats.some(b => b.id === 'B1'),
        hasDeepen: beats.some(b => b.id === 'B2'),
        hasCrack,
        hasTwist,
        hasResonance: beats.some(b => b.id === 'B5'),
        peakIntensity: Math.max(...beats.map(b => b.emotionTarget.intensity))
      }
    };
  }

  // v1.1新增：将节拍翻译为视觉动作版本
  translateBeatsToVisual(beats, beastProfile) {
    const translatedBeats = [];
    let visualStats = {
      totalTranslated: 0,
      totalChanges: 0,
      fullyVisualBeats: 0,
      confidenceSum: 0
    };
    
    for (const beat of beats) {
      const context = {
        beatPhase: beat.id?.toLowerCase()?.replace('b', '') || 'unknown',
        beastName: beastProfile?.name,
        habitat: beastProfile?.habitat
      };
      
      // 翻译narrationTemplate
      let narrationTemplate = beat.narrationTemplate;
      let visualPromptTemplate = beat.visualPromptTemplate;
      let beastMonologue = beat.beastMonologue;
      let beatChanges = 0;
      let beatConfidence = 1.0;
      
      // 翻译narration（核心）
      if (narrationTemplate) {
        const narResult = this.visualTranslator.translateNarration(narrationTemplate, context);
        if (narResult.translated !== narResult.original) {
          narrationTemplate = narResult.translated;
          beatChanges += narResult.changes?.length || 0;
          beatConfidence = Math.min(beatConfidence, narResult.confidence);
          visualStats.totalChanges += narResult.changes?.length || 0;
        }
      }
      
      // 翻译visualPrompt
      if (visualPromptTemplate) {
        const visResult = this.visualTranslator.translateNarration(visualPromptTemplate, context);
        if (visResult.translated !== visResult.original) {
          visualPromptTemplate = visResult.translated;
          beatChanges += visResult.changes?.length || 0;
          visualStats.totalChanges += visResult.changes?.length || 0;
        }
      }
      
      // 翻译monologue
      if (beastMonologue) {
        const monoResult = this.visualTranslator.translateMonologue(beastMonologue, beastProfile);
        if (monoResult.translated !== monoResult.original) {
          beastMonologue = monoResult.translated;
          beatChanges += monoResult.totalChanges || 0;
          beatConfidence = Math.min(beatConfidence, monoResult.confidence);
          visualStats.totalChanges += monoResult.totalChanges || 0;
        }
      }
      
      // 统计
      if (beatChanges > 0) {
        visualStats.totalTranslated++;
        visualStats.confidenceSum += beatConfidence;
        if (beatChanges >= 2) {
          visualStats.fullyVisualBeats++;
        }
      }
      
      translatedBeats.push({
        ...beat,
        narrationTemplate,
        visualPromptTemplate,
        beastMonologue,
        _visualTranslation: {
          changes: beatChanges,
          confidence: beatConfidence,
          isFullyVisual: beatChanges >= 2
        }
      });
    }
    
    // 附加统计到返回数组
    translatedBeats.visualStats = visualStats;
    
    return translatedBeats;
  }

  // 【v2.0新增】60秒三幕引擎映射
  // 将5节拍映射到60秒三幕结构：入侵(0-12s) → 震颤(12-40s) → 蜕变(40-60s)
  applyThreeActEngine(beats, beastProfile, conceptSeed) {
    const { psyche } = beastProfile;
    const sensoryBlueprint = psyche?.sensoryBlueprint;
    const desireCore = psyche?.desireCore;
    
    // 三幕映射
    const actMapping = [
      { act: 1, name: '入侵', timeRange: [0, 12], beats: ['B1'], subBeats: ['感知炸弹(0-3s)', '世界规则(3-8s)', '入侵信号(8-12s)'] },
      { act: 2, name: '震颤', timeRange: [12, 40], beats: ['B2', 'B3', 'B4'], subBeats: ['抵抗(12-16s)', '好奇(16-20s)', '震颤(20-26s)', '退缩(26-32s)', '沦陷(32-40s)'] },
      { act: 3, name: '蜕变', timeRange: [40, 60], beats: ['B5'], subBeats: ['转变(40-46s)', '意志传递(46-52s)', '余震(52-60s)'] }
    ];
    
    return beats.map(beat => {
      const act = actMapping.find(a => a.beats.includes(beat.id));
      if (!act) return beat;
      
      // 注入三幕元数据（不改动现有字段，软注入到新字段 _threeAct）
      return {
        ...beat,
        _threeAct: {
          actNumber: act.act,
          actName: act.name,
          actTimeRange: { start: act.timeRange[0], end: act.timeRange[1] },
          subBeats: act.subBeats,
          sensoryAnchor: this.getSensoryAnchorForAct(act.act, sensoryBlueprint),
          emotionalArc: this.getEmotionalArcForAct(act.act, desireCore),
          silenceRequired: act.act === 3
        }
      };
    });
  }

  // 【v2.0新增】获取每幕的感知锚点
  getSensoryAnchorForAct(actNumber, sensoryBlueprint) {
    if (!sensoryBlueprint) return '主要感官';
    
    const anchors = {
      1: sensoryBlueprint.primary,
      2: sensoryBlueprint.hyper,
      3: `${sensoryBlueprint.primary}+${sensoryBlueprint.hyper}`
    };
    
    return anchors[actNumber] || sensoryBlueprint.primary;
  }

  // 【v2.0新增】获取每幕的情感曲线
  getEmotionalArcForAct(actNumber, desireCore) {
    if (!desireCore) return '好奇→紧张→释然';
    
    const arcs = {
      1: '好奇→警觉',
      2: `${desireCore.want.split('，')[0]}→${desireCore.need.split('，')[0]}`,
      3: '转变→宁静'
    };
    
    return arcs[actNumber] || '好奇→紧张→释然';
  }

  // 将5节拍映射为shots（供Stage-6时长分配使用）
  mapBeatsToShots(beats, options = {}) {
    // 默认：1节拍 = 1镜，但允许配置
    const shotsPerBeat = options.shotsPerBeat || 1;
    
    const shots = [];
    let shotIndex = 0;

    beats.forEach((beat, beatIndex) => {
      for (let i = 0; i < shotsPerBeat; i++) {
        const duration = (beat.timeRange.end - beat.timeRange.start) / shotsPerBeat;
        
        shots.push({
          id: `S${String(shotIndex + 1).padStart(2, '0')}`,
          beatId: beat.id,
          beatName: beat.name,
          narrativeFunction: beat.narrativeFunction,
          narration: beat.narrationTemplate,
          visualPrompt: beat.visualPromptTemplate,
          emotionTarget: beat.emotionTarget,
          beastMonologue: beat.beastMonologue,
          humanPerspective: beat.humanPerspective,
          duration: duration,
          timeRange: {
            start: beat.timeRange.start + i * duration,
            end: beat.timeRange.start + (i + 1) * duration
          }
        });
        
        shotIndex++;
      }
    });

    return shots;
  }
}

module.exports = { BeatSheetEngine };

// 如果直接运行，执行测试
if (require.main === module) {
  const engine = new BeatSheetEngine({ duration: 15 });
  
  const conceptSeed = {
    theme: '永恒饥饿',
    coreTwist: '吞噬黑暗，吐出光明',
    emotionalAnchor: '理解比征服更有力量'
  };
  
  const beastProfile = {
    name: '饕餮',
    habitat: '钩吾山荒原',
    signatureFeatures: ['巨口占面部2/3', '腋下双眼', '永不满足的饥饿'],
    psyche: {
      motivation: '300年孤独，渴望被理解',
      fear: '被误解（每次人类看到我就逃）',
      desire: '有人能看到我吞噬的是黑暗，吐出的是种子'
    }
  };
  
  const result = engine.generateBeatSheet(conceptSeed, beastProfile);
  console.log('=== BeatSheet Engine 测试 ===');
  console.log('验证结果:', result.validation);
  console.log('节拍数:', result.beats.length);
  console.log('情绪曲线:', result.beats.map(b => `${b.name}: ${b.emotionTarget.emotion}(${b.emotionTarget.intensity})`));
  
  const shots = engine.mapBeatsToShots(result.beats);
  console.log('\n映射为Shots:', shots.map(s => `${s.id}(${s.beatName}): ${s.duration}s`));
}
