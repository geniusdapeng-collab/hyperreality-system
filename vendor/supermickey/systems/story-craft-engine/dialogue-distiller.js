// dialogue-distiller.js — StoryCraft Engine v1.0
// 台词精炼炉：为异兽和小G生成精简、有画面感的台词

class DialogueDistiller {
  constructor(options = {}) {
    this.maxLineLength = options.maxLineLength || 15; // 每句不超过15字
    this.maxLinesPerBeat = options.maxLinesPerBeat || 2; // 每节拍最多2句台词
    this.languageMode = options.languageMode || 'chinese'; // 'chinese' | 'nirath' | 'mixed'
    this.includeSubtext = options.includeSubtext !== false; // 是否包含潜台词说明
  }

  // 核心方法：精炼台词（v2.0升级：钻石台词筛选器+声音签名）
  distillDialogues(psycheResult, beatSheet, options = {}) {
    const { monologues, dialogues, psyche } = psycheResult;
    const beats = beatSheet.beats;
    
    // v2.0：获取声音签名和欲望内核
    const voiceSignature = psyche?.voiceSignature || {};
    const desireCore = psyche?.desireCore || {};
    
    const distilled = {
      beastLines: {},      // 异兽台词
      humanLines: {},      // 小G台词
      nirathLines: {},     // Nirath语（如果启用）
      mouthActions: {},    // 嘴部动作同步
      subtexts: {},        // 潜台词
      timing: {},          // 台词时机
      // v2.0新增：钻石台词元数据
      diamondLines: {},    // 钻石台词标记
      voiceSignature: {}   // 声音签名注入
    };

    // v2.0：钻石台词配额控制（总限额≤3句）
    let diamondQuotaRemaining = voiceSignature.diamondQuota || 2;
    let totalBeastLines = 0;

    // 为每个Beat生成精炼台词
    beats.forEach((beat, index) => {
      const beatId = beat.id;
      const monologue = monologues?.[beatId];
      const dialogue = dialogues?.[beatId];
      
      // v2.0：根据三幕引擎判断台词配额
      const threeAct = beat._threeAct;
      const actNumber = threeAct?.actNumber || Math.floor(index / 2) + 1;
      
      // 生成异兽台词（受钻石配额限制）
      const beastLine = this.distillBeastLineV2(monologue, dialogue, beat, psyche, {
        actNumber,
        diamondQuotaRemaining,
        totalBeastLines,
        desireCore,
        voiceSignature
      });
      
      if (beastLine) {
        distilled.beastLines[beatId] = beastLine;
        totalBeastLines++;
        
        // v2.0：标记钻石台词
        if (beastLine.isDiamond) {
          distilled.diamondLines[beatId] = {
            text: beastLine.text,
            layers: beastLine.diamondLayers,
            actNumber
          };
          diamondQuotaRemaining--;
        }
      }
      
      // 生成小G台词（选择性）
      const humanLine = this.distillHumanLine(beat, psyche);
      if (humanLine) {
        distilled.humanLines[beatId] = humanLine;
      }
      
      // 生成Nirath语（如果启用）
      if (this.languageMode === 'nirath' || this.languageMode === 'mixed') {
        const nirathLine = this.generateNirathLine(beat, psyche);
        if (nirathLine) {
          distilled.nirathLines[beatId] = nirathLine;
        }
      }
      
      // 生成嘴部动作
      distilled.mouthActions[beatId] = this.generateMouthAction(beat, beastLine, humanLine);
      
      // 生成潜台词（v2.0增强：基于欲望内核的多层含义）
      if (this.includeSubtext) {
        distilled.subtexts[beatId] = this.generateSubtextV2(beat, psyche, desireCore, beastLine);
      }
      
      // 生成台词时机
      distilled.timing[beatId] = this.generateTiming(beat, index);
      
      // v2.0：注入声音签名
      distilled.voiceSignature[beatId] = {
        style: voiceSignature.style || '低语',
        silencePreference: voiceSignature.silencePreference || '在感知到勇毅波动时选择沉默',
        intensity: this.getMouthIntensity(beatId)
      };
    });

    return {
      ...distilled,
      metadata: {
        languageMode: this.languageMode,
        maxLineLength: this.maxLineLength,
        totalBeastLines: Object.keys(distilled.beastLines).length,
        totalHumanLines: Object.keys(distilled.humanLines).length,
        diamondQuotaUsed: (voiceSignature.diamondQuota || 2) - diamondQuotaRemaining,
        diamondQuotaTotal: voiceSignature.diamondQuota || 2,
        generatedAt: new Date().toISOString(),
        version: 'v2.0'
      }
    };
  }

  // 精炼异兽台词
  // 【v2.0新增】精炼异兽台词（钻石台词版本）
  distillBeastLineV2(monologue, dialogue, beat, psyche, options = {}) {
    if (!monologue && !dialogue) return null;
    
    const { actNumber, diamondQuotaRemaining, totalBeastLines, desireCore, voiceSignature } = options;
    
    // v2.0：第一幕和第三幕原则上0台词，第二幕最多2句
    const maxLinesByAct = { 1: 0, 2: 2, 3: 1 };
    const maxLines = maxLinesByAct[actNumber] || 1;
    
    // 如果已经超过配额，返回null（静默）
    if (totalBeastLines >= 3 || diamondQuotaRemaining <= 0) {
      return null;
    }

    // 提取最有画面感的句子
    const source = dialogue?.line || monologue || '';
    const lines = source.split(/[。！？\n]/).filter(l => l.trim().length > 0);
    
    if (lines.length === 0) return null;

    // 选择最有"动作感"或"情感峰值"的句子
    const selectedLine = this.selectMostVisualLine(lines, beat);
    
    // v2.0：精炼到10字以内（更严格）
    const maxLength = actNumber === 2 ? 10 : 8;
    const distilled = this.refineToMaxLength(selectedLine, maxLength);
    
    // v2.0：钻石台词三层含义检测
    const diamondLayers = this.analyzeDiamondLayers(distilled, desireCore, beat);
    const isDiamond = diamondLayers.length >= 2;
    
    return {
      text: distilled,
      original: selectedLine,
      tone: dialogue?.tone || this.inferTone(beat),
      speaker: 'beast',
      beatId: beat.id,
      isDiamond,
      diamondLayers,
      actNumber,
      voiceStyle: voiceSignature?.style || '低语',
      silenceContext: voiceSignature?.silencePreference || ''
    };
  }

  // 【v2.0新增】分析钻石台词的三层含义
  analyzeDiamondLayers(line, desireCore, beat) {
    const layers = [];
    const lowerLine = line.toLowerCase();
    
    if (desireCore?.want && lowerLine.includes(desireCore.want.substring(0, 4))) {
      layers.push({ layer: 'surface', meaning: 'Want：' + desireCore.want });
    }
    
    if (desireCore?.need && (lowerLine.includes('不该') || lowerLine.includes('不要') || lowerLine.includes('别') || lowerLine.includes('走'))) {
      layers.push({ layer: 'hidden', meaning: 'Need：害怕被看见/害怕面对孤独' });
    }
    
    if (line.length <= 8 && (line.includes('。') || line.includes('……'))) {
      layers.push({ layer: 'emotional', meaning: '历史重量：很久以来的第一句话' });
    }
    
    if (layers.length === 1) {
      layers.push({ layer: 'emotional', meaning: '情感张力：简短中的沉默' });
    }
    
    return layers;
  }

  // 精炼异兽台词（v1.0兼容版本）
  distillBeastLine(monologue, dialogue, beat, psyche) {
    return this.distillBeastLineV2(monologue, dialogue, beat, psyche, {});
  }

  // 精炼小G台词
  distillHumanLine(beat, psyche) {
    // 小G台词较少，只在关键节拍出现
    const keyBeats = ['B3', 'B4', 'B5']; // 裂缝、翻转、余韵
    if (!keyBeats.includes(beat.id)) return null;

    const templates = {
      B3: {
        text: '你在...做什么？',
        tone: '困惑，轻声',
        subtext: '发现异兽不是威胁，而是做一件温柔的事'
      },
      B4: {
        text: '原来...你是这样的。',
        tone: '震撼，温柔',
        subtext: '终于理解了异兽的本质'
      },
      B5: {
        text: '谢谢你。',
        tone: '真诚，释然',
        subtext: '最简单的感谢，最重的分量'
      }
    };

    const template = templates[beat.id];
    if (!template) return null;

    return {
      text: template.text,
      original: template.text,
      tone: template.tone,
      speaker: 'human',
      beatId: beat.id,
      subtext: template.subtext
    };
  }

  // 生成Nirath语台词
  generateNirathLine(beat, psyche) {
    // Nirath语：基于磁场共鸣的概念语言
    // 实际发音由TTS/音效处理，这里生成"概念翻译"
    
    const nirathConcepts = {
      B1: { concept: '日常/孤独', frequency: '低频稳定', color: '淡蓝' },
      B2: { concept: '警觉/评估', frequency: '中频波动', color: '黄色' },
      B3: { concept: '困惑/试探', frequency: '变频混合', color: '紫蓝' },
      B4: { concept: '真相/震撼', frequency: '高频爆发', color: '金白' },
      B5: { concept: '和解/希望', frequency: '谐波共鸣', color: '柔金' }
    };

    const concept = nirathConcepts[beat.id];
    if (!concept) return null;

    return {
      concept: concept.concept,
      frequency: concept.frequency,
      color: concept.color,
      visualPattern: `发光${concept.color}色磁丝文字，${concept.frequency}脉动`,
      humanTranslation: this.getNirathTranslation(beat.id, psyche)
    };
  }

  // 获取Nirath语的人类语翻译
  getNirathTranslation(beatId, psyche) {
    const translations = {
      B1: '（低沉共鸣）"又一天。土壤的毒素...在增加。"',
      B2: '（频率升高）"人类。心跳很快...但没有逃。"',
      B3: '（变频混合）"种子？不是武器...是礼物？"',
      B4: '（高频爆发）"力量在流失...但不能让它们死。"',
      B5: '（谐波共鸣）"起源之种...所以，给你我唯一能给的东西。"'
    };
    return translations[beatId] || '';
  }

  // 生成嘴部动作（与台词同步）
  generateMouthAction(beat, beastLine, humanLine) {
    const actions = {
      B1: '嘴部闭合，呼吸缓慢，偶尔低吟',
      B2: '嘴部微张，发出低沉共鸣声，牙齿轻叩',
      B3: '嘴部张开又闭合，发出变频声音，头倾斜15°',
      B4: '嘴部大张，发出高频爆发声，然后突然静止',
      B5: '嘴部柔和张开，发出谐波共鸣，眼神温柔'
    };

    return {
      action: actions[beat.id] || '嘴部自然状态',
      syncWith: beastLine ? 'beast' : (humanLine ? 'human' : 'none'),
      intensity: this.getMouthIntensity(beat.id)
    };
  }

  // 获取嘴部动作强度
  getMouthIntensity(beatId) {
    const intensities = { B1: 0.2, B2: 0.5, B3: 0.6, B4: 0.9, B5: 0.4 };
    return intensities[beatId] || 0.5;
  }

  // 生成潜台词（v2.0增强：基于欲望内核的多层含义）
  generateSubtextV2(beat, psyche, desireCore, beastLine) {
    const subtexts = {
      B1: { surface: '又一天，土壤毒素增加', hidden: '孤独是日常，不是选择' },
      B2: { surface: '人类来了，评估威胁', hidden: '300年了，第一次有人不逃' },
      B3: { surface: '种子？不是武器？', hidden: 'Want与Need开始撕裂——这是礼物，不是威胁' },
      B4: { surface: '力量在流失', hidden: 'Lie被戳破："我不需要任何人"是假的' },
      B5: { surface: '给你我唯一能给的东西', hidden: 'Need被满足：终于被看见了' }
    };

    const baseSubtext = subtexts[beat.id] || { surface: '', hidden: '' };
    
    if (beastLine?.isDiamond && beastLine.diamondLayers) {
      return {
        ...baseSubtext,
        diamondLayers: beastLine.diamondLayers,
        voiceStyle: beastLine.voiceStyle,
        actNumber: beastLine.actNumber
      };
    }
    
    return baseSubtext;
  }

  // 生成潜台词（v1.0兼容版本）
  generateSubtext(beat, psyche) {
    const subtexts = {
      B1: '异兽的日常是孤独的守护，不是恐怖的存在',
      B2: '异兽的警觉是评估，不是攻击——它在判断这个人类是否危险',
      B3: '异兽的"反常"动作是它真实的温柔本性',
      B4: '异兽的"力量流失"是牺牲的代价——守护需要付出',
      B5: '异兽的回馈是最珍贵的礼物——被理解后的感恩'
    };

    return subtexts[beat.id] || '';
  }

  // 生成台词时机
  generateTiming(beat, index) {
    const beatDuration = 12; // 每节拍12秒
    const lineCount = this.maxLinesPerBeat;
    
    // 台词分布在节拍的前1/3和后2/3
    return {
      beatStart: index * beatDuration,
      beatEnd: (index + 1) * beatDuration,
      line1At: index * beatDuration + 2, // 开始后2秒
      line2At: index * beatDuration + 8, // 开始后8秒
      maxDuration: 3 // 每句台词最多3秒
    };
  }

  // 选择最有画面感的句子
  selectMostVisualLine(lines, beat) {
    // 评分：动作词 > 情感词 > 抽象词
    const actionWords = ['走', '跑', '跳', '飞', '伸', '触', '看', '听', '说', '做', '给', '拿', '站', '坐', '躺'];
    const emotionWords = ['笑', '哭', '怒', '怕', '爱', '恨', '喜', '悲', '惊', '疑'];
    
    let bestLine = lines[0];
    let bestScore = 0;
    
    lines.forEach(line => {
      let score = 0;
      actionWords.forEach(w => { if (line.includes(w)) score += 2; });
      emotionWords.forEach(w => { if (line.includes(w)) score += 1; });
      if (line.length <= this.maxLineLength) score += 1; // 短句加分
      
      if (score > bestScore) {
        bestScore = score;
        bestLine = line;
      }
    });
    
    return bestLine;
  }

  // 精炼到指定长度
  refineToMaxLength(line, maxLength) {
    if (line.length <= maxLength) return line;
    
    // 尝试截断到最近的标点
    const truncated = line.substring(0, maxLength);
    const lastPunctuation = Math.max(
      truncated.lastIndexOf('，'),
      truncated.lastIndexOf('。'),
      truncated.lastIndexOf('！'),
      truncated.lastIndexOf('？')
    );
    
    if (lastPunctuation > maxLength * 0.5) {
      return truncated.substring(0, lastPunctuation + 1);
    }
    
    return truncated + '...';
  }

  // 推断语气
  inferTone(beat) {
    const tones = {
      B1: '低沉，疲惫',
      B2: '警觉，评估',
      B3: '困惑，试探',
      B4: '震撼，坚定',
      B5: '温柔，感激'
    };
    return tones[beat.id] || '中性';
  }

  // 批量处理：为整个故事板生成台词
  batchDistill(storyboard, psycheResult, options = {}) {
    const results = {};
    
    storyboard.shots.forEach(shot => {
      const beatId = shot.beatId;
      if (!beatId) return;
      
      const beat = storyboard.beats?.find(b => b.id === beatId);
      if (!beat) return;
      
      const distilled = this.distillDialogues(psycheResult, { beats: [beat] }, options);
      results[shot.id] = distilled;
    });
    
    return results;
  }
}

module.exports = { DialogueDistiller };

// 测试
if (require.main === module) {
  const distiller = new DialogueDistiller({ 
    languageMode: 'mixed', 
    maxLineLength: 15 
  });
  
  const psycheResult = {
    monologues: {
      B1: '又一天。土壤的毒素含量上升了3%。还要再吃多少？',
      B2: '人类。心跳很快，但没有跑。300年了。第一个不逃的。',
      B3: '他在给我...种子？不是武器。是礼物。',
      B4: '力量在流失。但我不能让这些植物死。再撑一下。',
      B5: '这颗种子...是起源。所以...我要给你我唯一能给的东西。'
    },
    dialogues: {
      B2: { line: '又有人类。逃吧，像以前一样。', tone: '低沉' },
      B3: { line: '他的心跳很快...但没有跑。300年了。', tone: '困惑' },
      B4: { line: '力量在流失...再撑一下。', tone: '疲惫' },
      B5: { line: '这颗种子...所以...给你我唯一能给的东西。', tone: '温柔' }
    },
    psyche: {
      motivation: { primary: '守护Nirath' },
      fear: { primary: '被误解' }
    }
  };
  
  const beatSheet = {
    beats: [
      { id: 'B1', name: '钩子', emotionTarget: { emotion: 'curious' } },
      { id: 'B2', name: '深入', emotionTarget: { emotion: 'tension' } },
      { id: 'B3', name: '裂缝', emotionTarget: { emotion: 'confusion' } },
      { id: 'B4', name: '翻转', emotionTarget: { emotion: 'awe' } },
      { id: 'B5', name: '余韵', emotionTarget: { emotion: 'relief' } }
    ]
  };
  
  const result = distiller.distillDialogues(psycheResult, beatSheet);
  console.log('=== DialogueDistiller 测试 ===');
  console.log('异兽台词:');
  Object.entries(result.beastLines).forEach(([beat, line]) => {
    console.log(`  ${beat}: "${line.text}" (${line.tone})`);
  });
  console.log('\n小G台词:');
  Object.entries(result.humanLines).forEach(([beat, line]) => {
    console.log(`  ${beat}: "${line.text}" (${line.tone})`);
  });
  console.log('\nNirath语:');
  Object.entries(result.nirathLines).forEach(([beat, line]) => {
    console.log(`  ${beat}: ${line.visualPattern} → ${line.humanTranslation}`);
  });
  console.log('\n嘴部动作:');
  Object.entries(result.mouthActions).forEach(([beat, action]) => {
    console.log(`  ${beat}: ${action.action}`);
  });
}
