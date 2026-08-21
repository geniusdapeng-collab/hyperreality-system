// encounter-dynamics.js — StoryCraft Engine v1.0
// 相遇动力学引擎：控制异兽和小G的5阶段互动模型

class EncounterDynamics {
  constructor(options = {}) {
    this.stages = 5; // 5阶段互动
    this.stageDuration = options.stageDuration || 12; // 每阶段12秒
    this.psycheResult = null; // 异兽心理画像（由BeastPsycheGenerator提供）
    this.dialogueResult = null; // 台词结果（由DialogueDistiller提供）
  }

  // 核心方法：生成5阶段互动模型（v2.0升级：60秒节拍堆叠+情感曲线）
  generateDynamics(beatSheet, psycheResult, dialogueResult, options = {}) {
    this.psycheResult = psycheResult;
    this.dialogueResult = dialogueResult;
    
    const beats = beatSheet.beats;
    const dynamics = [];
    
    // v2.0：获取三幕引擎信息
    const threeActInfo = this.extractThreeActInfo(beats);
    
    // 5阶段互动（保持v1.0兼容）
    const stages = [
      { id: 'alert', name: '警觉', beatId: 'B1', humanAction: '接近/观察', beastAction: '评估/警戒' },
      { id: 'probe', name: '试探', beatId: 'B2', humanAction: '不退缩/展示善意', beastAction: '靠近/嗅闻' },
      { id: 'conflict', name: '冲突', beatId: 'B3', humanAction: '困惑/质疑', beastAction: '警告/展示力量' },
      { id: 'pause', name: '停顿', beatId: 'B4', humanAction: '理解/接纳', beastAction: '静止/暴露脆弱' },
      { id: 'reconcile', name: '和解', beatId: 'B5', humanAction: '触碰/共享', beastAction: '低头/让出' }
    ];

    stages.forEach((stage, index) => {
      const beat = beats.find(b => b.id === stage.beatId);
      if (!beat) return;

      // v2.0：获取当前beat的三幕信息
      const beatThreeAct = beat._threeAct || {};
      const subBeats = beatThreeAct.subBeats || [];
      
      const dynamic = this.generateStageDynamicV2(stage, beat, index, {
        subBeats,
        actNumber: beatThreeAct.actNumber,
        emotionalArc: beatThreeAct.emotionalArc
      });
      dynamics.push(dynamic);
    });

    return {
      stages: dynamics,
      interactionMap: this.generateInteractionMap(dynamics),
      emotionalTrajectory: this.generateEmotionalTrajectory(dynamics),
      // v2.0新增：60秒节拍堆叠信息
      beatStacking: threeActInfo,
      metadata: {
        totalStages: dynamics.length,
        totalDuration: dynamics.length * this.stageDuration,
        generatedAt: new Date().toISOString(),
        version: 'v2.0'
      }
    };
  }

  // 【v2.0新增】提取三幕信息
  extractThreeActInfo(beats) {
    const actInfo = {
      act1: { beats: [], subBeats: [], sensoryAnchor: '' },
      act2: { beats: [], subBeats: [], sensoryAnchor: '' },
      act3: { beats: [], subBeats: [], sensoryAnchor: '' }
    };
    
    beats.forEach(beat => {
      const ta = beat._threeAct;
      if (!ta) return;
      
      const act = actInfo[`act${ta.actNumber}`];
      if (act) {
        act.beats.push(beat.id);
        act.subBeats.push(...(ta.subBeats || []));
        act.sensoryAnchor = ta.sensoryAnchor;
      }
    });
    
    return actInfo;
  }

  // 【v2.0新增】生成单个阶段的动态（含节拍堆叠）
  generateStageDynamicV2(stage, beat, index, threeActInfo) {
    const { psyche } = this.psycheResult || {};
    const beastDialogue = this.dialogueResult?.beastLines?.[beat.id];
    const humanDialogue = this.dialogueResult?.humanLines?.[beat.id];
    const { subBeats, actNumber, emotionalArc } = threeActInfo;

    // v2.0：生成节拍堆叠（每个阶段包含微观情绪转折）
    const beatStacking = this.generateBeatStacking(stage, subBeats, actNumber);

    return {
      id: stage.id,
      name: stage.name,
      beatId: beat.id,
      timeRange: {
        start: index * this.stageDuration,
        end: (index + 1) * this.stageDuration
      },
      
      // v2.0新增：三幕信息
      threeAct: {
        actNumber,
        actName: actNumber === 1 ? '入侵' : (actNumber === 2 ? '震颤' : '蜕变'),
        emotionalArc,
        subBeats
      },
      
      // v2.0新增：节拍堆叠
      beatStacking,
      
      // 人类（小G）行为
      human: {
        action: stage.humanAction,
        emotionalState: this.getHumanEmotion(stage.id),
        bodyLanguage: this.getHumanBodyLanguage(stage.id),
        dialogue: humanDialogue || null,
        intention: this.getHumanIntention(stage.id)
      },
      
      // 异兽行为
      beast: {
        action: stage.beastAction,
        emotionalState: this.getBeastEmotion(stage.id, psyche),
        bodyLanguage: this.getBeastBodyLanguage(stage.id),
        dialogue: beastDialogue || null,
        intention: this.getBeastIntention(stage.id, psyche),
        innerMonologue: this.psycheResult?.monologues?.[beat.id] || null,
        // v2.0新增：钻石台词标记
        isDiamondLine: beastDialogue?.isDiamond || false,
        diamondLayers: beastDialogue?.diamondLayers || null
      },
      
      // 互动特征
      interaction: {
        type: this.getInteractionType(stage.id),
        powerDynamic: this.getPowerDynamic(stage.id),
        spatialRelationship: this.getSpatialRelationship(stage.id),
        visualFocus: this.getVisualFocus(stage.id)
      },
      
      // 观众认知
      audience: {
        perceives: this.getAudiencePerception(stage.id),
        shouldFeel: beat.emotionTarget,
        misdirection: this.getMisdirection(stage.id),
        payoff: this.getPayoff(stage.id),
        // v2.0新增：情感曲线
        emotionalArc: emotionalArc || '好奇→紧张→释然'
      }
    };
  }

  // 【v2.0新增】生成节拍堆叠（微观情绪转折）
  // 第二幕（12-40秒）包含5个微观情绪转折，每个3-5秒
  generateBeatStacking(stage, subBeats, actNumber) {
    if (!subBeats || subBeats.length === 0) {
      // 默认节拍堆叠
      const defaultStacks = {
        'alert': [{ emotion: '日常→警觉', time: '0-3s', action: '感知炸弹' }],
        'probe': [
          { emotion: '抵抗', time: '12-16s', action: '战意绷紧' },
          { emotion: '好奇', time: '16-20s', action: '扫描对方频率' }
        ],
        'conflict': [
          { emotion: '震颤', time: '20-26s', action: '战魂颤抖' },
          { emotion: '退缩', time: '26-32s', action: '内在冲突' }
        ],
        'pause': [
          { emotion: '沦陷', time: '32-40s', action: 'Need浮现' },
          { emotion: '转变', time: '40-46s', action: '边界溶解' }
        ],
        'reconcile': [
          { emotion: '意志传递', time: '46-52s', action: '核心意象绽放' },
          { emotion: '余震', time: '52-60s', action: '静默律动' }
        ]
      };
      return defaultStacks[stage.id] || [];
    }
    
    // 将subBeats转化为节拍堆叠
    return subBeats.map((sb, i) => ({
      emotion: sb.split('(')[0] || '未知',
      time: sb.match(/\(([^)]+)\)/)?.[1] || `${index * 12}-${(index + 1) * 12}s`,
      action: sb,
      actNumber
    }));
  }

  // 生成单个阶段的动态（v1.0兼容版本）
  generateStageDynamic(stage, beat, index, options) {
    const { psyche } = this.psycheResult || {};
    const beastDialogue = this.dialogueResult?.beastLines?.[beat.id];
    const humanDialogue = this.dialogueResult?.humanLines?.[beat.id];

    return {
      id: stage.id,
      name: stage.name,
      beatId: beat.id,
      timeRange: {
        start: index * this.stageDuration,
        end: (index + 1) * this.stageDuration
      },
      
      // 人类（小G）行为
      human: {
        action: stage.humanAction,
        emotionalState: this.getHumanEmotion(stage.id),
        bodyLanguage: this.getHumanBodyLanguage(stage.id),
        dialogue: humanDialogue || null,
        intention: this.getHumanIntention(stage.id)
      },
      
      // 异兽行为
      beast: {
        action: stage.beastAction,
        emotionalState: this.getBeastEmotion(stage.id, psyche),
        bodyLanguage: this.getBeastBodyLanguage(stage.id),
        dialogue: beastDialogue || null,
        intention: this.getBeastIntention(stage.id, psyche),
        innerMonologue: this.psycheResult?.monologues?.[beat.id] || null
      },
      
      // 互动特征
      interaction: {
        type: this.getInteractionType(stage.id),
        powerDynamic: this.getPowerDynamic(stage.id), // 谁主导？
        spatialRelationship: this.getSpatialRelationship(stage.id), // 空间关系
        visualFocus: this.getVisualFocus(stage.id) // 镜头焦点
      },
      
      // 观众认知
      audience: {
        perceives: this.getAudiencePerception(stage.id),
        shouldFeel: beat.emotionTarget,
        misdirection: this.getMisdirection(stage.id), // 误导信息
        payoff: this.getPayoff(stage.id) // 回报信息
      }
    };
  }

  // 获取人类情绪状态
  getHumanEmotion(stageId) {
    const emotions = {
      alert: { primary: '好奇', secondary: '谨慎', intensity: 0.3 },
      probe: { primary: '紧张', secondary: '坚定', intensity: 0.5 },
      conflict: { primary: '困惑', secondary: '恐惧', intensity: 0.7 },
      pause: { primary: '震撼', secondary: '理解', intensity: 0.8 },
      reconcile: { primary: '温暖', secondary: '释然', intensity: 0.9 }
    };
    return emotions[stageId] || { primary: '中性', intensity: 0.5 };
  }

  // 获取异兽情绪状态
  getBeastEmotion(stageId, psyche) {
    const baseEmotions = {
      alert: { primary: '警觉', secondary: '评估', intensity: 0.4 },
      probe: { primary: '困惑', secondary: '好奇', intensity: 0.5 },
      conflict: { primary: '警告', secondary: '保护', intensity: 0.7 },
      pause: { primary: '惊讶', secondary: '脆弱', intensity: 0.6 },
      reconcile: { primary: '温柔', secondary: '感激', intensity: 0.8 }
    };
    
    const emotion = baseEmotions[stageId];
    
    // 如果有多理画像，增加深度
    if (psyche) {
      if (stageId === 'alert') {
        emotion.subtext = psyche.fear?.primary || '评估威胁';
      }
      if (stageId === 'reconcile') {
        emotion.subtext = psyche.desire?.surface || '终于理解';
      }
    }
    
    return emotion;
  }

  // 获取人类肢体语言
  getHumanBodyLanguage(stageId) {
    const languages = {
      alert: '缓慢移动，双手自然下垂，眼睛观察四周',
      probe: '停下脚步，身体微侧，不直视异兽但也不逃避',
      conflict: '后退半步，双手抬起（防御姿态），表情困惑',
      pause: '身体放松，双手垂下，眼神从恐惧变为温柔',
      reconcile: '向前一步，右手伸出（手掌向上），微笑'
    };
    return languages[stageId] || '自然站立';
  }

  // 获取异兽肢体语言
  getBeastBodyLanguage(stageId) {
    const languages = {
      alert: '毛发竖立，身体压低，眼神警惕，低吼',
      probe: '缓慢靠近，头倾斜15°，耳朵转动，呼吸放缓',
      conflict: '身体膨胀，巨口张开，光线变暗（磁场共鸣警告）',
      pause: '突然静止，眼神从竖瞳变圆瞳（信任信号），身体放松',
      reconcile: '低头，身体缩小（从膨胀恢复），让出道路'
    };
    return languages[stageId] || '静止';
  }

  // 获取人类意图
  getHumanIntention(stageId) {
    const intentions = {
      alert: '探索环境，寻找安全路径',
      probe: '评估异兽是否危险，决定下一步',
      conflict: '保护自己，同时试图理解异兽的行为',
      pause: '放下戒备，尝试建立连接',
      reconcile: '表达善意，与异兽建立信任'
    };
    return intentions[stageId] || '观察';
  }

  // 获取异兽意图
  getBeastIntention(stageId, psyche) {
    const baseIntentions = {
      alert: '评估人类威胁等级，准备防御',
      probe: '判断人类气味中的情绪，决定是否警告',
      conflict: '警告人类不要靠近危险区域，同时保护自己',
      pause: '重新评估——这个人类不一样',
      reconcile: '接受人类的善意，展示守护的东西'
    };
    
    const intention = {
      primary: baseIntentions[stageId] || '观察'
    };
    
    // 如果有心理画像，增加深度
    if (psyche && stageId === 'reconcile') {
      intention.deep = psyche.desire?.deep || '建立真正的连接';
    }
    
    return intention;
  }

  // 获取互动类型
  getInteractionType(stageId) {
    const types = {
      alert: '单方面观察（异兽观察人类）',
      probe: '双向评估（双方互相判断）',
      conflict: '对抗（误解导致的紧张）',
      pause: '认知断裂（双方理解发生变化）',
      reconcile: '合作（共同目标出现）'
    };
    return types[stageId] || '中性';
  }

  // 获取权力动态（谁主导）
  getPowerDynamic(stageId) {
    const dynamics = {
      alert: '异兽主导（人类在异兽领地）',
      probe: '平衡（双方互相试探）',
      conflict: '异兽主导（展示力量警告）',
      pause: '转变中（人类开始理解）',
      reconcile: '共享（权力让渡，共同主导）'
    };
    return dynamics[stageId] || '中性';
  }

  // 获取空间关系
  getSpatialRelationship(stageId) {
    const relations = {
      alert: '远距离（50米以上）',
      probe: '中距离（20-50米）',
      conflict: '近距离（10-20米）',
      pause: '近距离（5-10米）',
      reconcile: '极近距离（触碰距离）'
    };
    return relations[stageId] || '不确定';
  }

  // 获取镜头焦点
  getVisualFocus(stageId) {
    const focuses = {
      alert: '环境全景 + 异兽身影',
      probe: '异兽面部特写（警觉→困惑）',
      conflict: '异兽力量展示 + 人类反应',
      pause: '双方眼神交流（竖瞳→圆瞳）',
      reconcile: '触碰瞬间 + 环境变化'
    };
    return focuses[stageId] || '中性';
  }

  // 获取观众感知
  getAudiencePerception(stageId) {
    const perceptions = {
      alert: '异兽是威胁，小G在危险中',
      probe: '异兽在逼近，小G处境危险',
      conflict: '异兽要攻击了！小G快逃！',
      pause: '等等……异兽没有攻击？它在等什么？',
      reconcile: '原来异兽不是敌人！它在守护！'
    };
    return perceptions[stageId] || '中性';
  }

  // 获取误导信息（让观众误解）
  getMisdirection(stageId) {
    const misdirections = {
      alert: '环境暗示危险（荒芜、寂静）',
      probe: '异兽动作像攻击（靠近、嗅闻）',
      conflict: '异兽展示力量（怒吼、膨胀）',
      pause: '突然静止制造悬念',
      reconcile: null // 不需要误导，要揭示真相
    };
    return misdirections[stageId];
  }

  // 获取回报信息（让观众理解）
  getPayoff(stageId) {
    const payoffs = {
      alert: null, // 还没有回报
      probe: null,
      conflict: null,
      pause: '异兽眼神变化——从竖瞳变圆瞳（信任信号）',
      reconcile: '花海绽放——异兽守护的真相'
    };
    return payoffs[stageId];
  }

  // 生成互动地图（可视化）
  generateInteractionMap(dynamics) {
    return dynamics.map((stage, index) => ({
      stage: stage.id,
      time: `${stage.timeRange.start}-${stage.timeRange.end}s`,
      human: stage.human.action,
      beast: stage.beast.action,
      distance: this.getSpatialRelationship(stage.id),
      power: this.getPowerDynamic(stage.id),
      audience: stage.audience.perceives
    }));
  }

  // 生成情绪轨迹
  generateEmotionalTrajectory(dynamics) {
    const humanEmotions = dynamics.map(d => ({
      stage: d.id,
      emotion: d.human.emotionalState.primary,
      intensity: d.human.emotionalState.intensity
    }));
    
    const beastEmotions = dynamics.map(d => ({
      stage: d.id,
      emotion: d.beast.emotionalState.primary,
      intensity: d.beast.emotionalState.intensity
    }));
    
    return { human: humanEmotions, beast: beastEmotions };
  }

  // 生成拍摄指导
  generateShootingGuide(dynamics) {
    return dynamics.map(stage => ({
      stage: stage.id,
      shotList: [
        {
          type: ' establishing',
          focus: stage.interaction.visualFocus,
          duration: 4
        },
        {
          type: 'interaction',
          focus: `${stage.human.action} + ${stage.beast.action}`,
          duration: 5
        },
        {
          type: 'reaction',
          focus: `人类表情 + 异兽眼神`,
          duration: 3
        }
      ],
      keyMoment: stage.audience.payoff || stage.audience.misdirection,
      lightingNote: this.getLightingNote(stage.id)
    }));
  }

  // 获取灯光指导
  getLightingNote(stageId) {
    const notes = {
      alert: '冷色调，高对比，阴影重',
      probe: '中性色调，柔和过渡',
      conflict: '暗色调，闪烁红光（警告）',
      pause: '暖色调突然出现（希望之光）',
      reconcile: '暖金色调，柔和光辉'
    };
    return notes[stageId] || '中性';
  }
}

module.exports = { EncounterDynamics };

// 测试
if (require.main === module) {
  const dynamics = new EncounterDynamics({ stageDuration: 12 });
  
  const beatSheet = {
    beats: [
      { id: 'B1', emotionTarget: { emotion: 'curious', intensity: 0.3 } },
      { id: 'B2', emotionTarget: { emotion: 'tension', intensity: 0.5 } },
      { id: 'B3', emotionTarget: { emotion: 'confusion', intensity: 0.7 } },
      { id: 'B4', emotionTarget: { emotion: 'awe', intensity: 0.9 } },
      { id: 'B5', emotionTarget: { emotion: 'relief', intensity: 0.8 } }
    ]
  };
  
  const psycheResult = {
    psyche: {
      fear: { primary: '被误解' },
      desire: { surface: '被理解', deep: '建立连接' }
    },
    monologues: {
      B1: '又一天...',
      B2: '人类...',
      B3: '种子？',
      B4: '力量在流失...',
      B5: '终于...'
    }
  };
  
  const dialogueResult = {
    beastLines: {
      B2: { text: '又有人类...', tone: '低沉' },
      B3: { text: '种子？', tone: '困惑' }
    },
    humanLines: {
      B3: { text: '你在做什么？', tone: '困惑' }
    }
  };
  
  const result = dynamics.generateDynamics(beatSheet, psycheResult, dialogueResult);
  console.log('=== EncounterDynamics 测试 ===');
  console.log('阶段数:', result.stages.length);
  console.log('互动地图:', result.interactionMap);
  console.log('情绪轨迹:');
  console.log('  人类:', result.emotionalTrajectory.human);
  console.log('  异兽:', result.emotionalTrajectory.beast);
  
  console.log('\n详细阶段:');
  result.stages.forEach(stage => {
    console.log(`\n${stage.id} (${stage.name}):`);
    console.log(`  人类: ${stage.human.action} (${stage.human.emotionalState.primary})`);
    console.log(`  异兽: ${stage.beast.action} (${stage.beast.emotionalState.primary})`);
    console.log(`  观众感知: ${stage.audience.perceives}`);
    console.log(`  空间: ${stage.interaction.spatialRelationship}`);
  });
}
