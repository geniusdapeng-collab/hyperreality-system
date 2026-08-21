// twist-validator.js — StoryCraft Engine v1.0
// 反转验证器：验证反转质量，确保每集都有"卧槽时刻"

class TwistValidator {
  constructor(options = {}) {
    this.minScore = options.minScore || 70; // 最低通过分数
    this.maxRetries = options.maxRetries || 2; // 最大重试次数
    
    // 评分权重（v2.0：6维度，总和=1.0）
    this.weights = {
      reinterpretation: 0.25,      // 是否让前3个Beat被重新理解（原为0.30）
      newEmotionDimension: 0.25,   // 是否引出新的情感维度（原为0.30）
      visualExpressible: 0.15,       // 是否可以用画面表达（原为0.20）
      beastFeatureBinding: 0.15,     // 是否与异兽核心特征绑定（原为0.20）
      needRevealTiming: 0.10,       // v2.0新增：Need最后10秒揭示
      silenceBudget: 0.10           // v2.0新增：静默预算检查
    };
  }

  // 核心方法：验证反转质量
  validateTwist(beats, beastProfile, options = {}) {
    // 提取关键节拍
    const beat3 = beats.find(b => b.id === 'B3'); // 裂缝
    const beat4 = beats.find(b => b.id === 'B4'); // 翻转
    
    if (!beat3 || !beat4) {
      return {
        passed: false,
        score: 0,
        details: { error: '缺少B3（裂缝）或B4（翻转）节拍' },
        recommendation: '确保BeatSheet包含完整的5节拍结构'
      };
    }

    // 计算4个维度的分数（v2.0增加2个维度）
    const reinterpretationScore = this.scoreReinterpretation(beats, beat3, beat4);
    const newEmotionScore = this.scoreNewEmotionDimension(beats, beat4);
    const visualScore = this.scoreVisualExpressibility(beat4);
    const bindingScore = this.scoreBeastFeatureBinding(beat4, beastProfile);
    
    // v2.0新增：Need最后10秒揭示验证
    const needRevealScore = this.scoreNeedRevealTiming(beats, beastProfile);
    
    // v2.0新增：静默预算检查
    const silenceBudgetScore = this.scoreSilenceBudget(beats);

    // 计算总分（v2.0：6维度加权）
    const totalScore = 
      reinterpretationScore * this.weights.reinterpretation +
      newEmotionScore * this.weights.newEmotionDimension +
      visualScore * this.weights.visualExpressible +
      bindingScore * this.weights.beastFeatureBinding +
      needRevealScore * 0.10 +      // v2.0新增：10%权重
      silenceBudgetScore * 0.10;     // v2.0新增：10%权重

    const roundedScore = Math.round(totalScore);

    // 判断是否通过
    const passed = roundedScore >= this.minScore;

    return {
      passed,
      score: roundedScore,
      minScore: this.minScore,
      details: {
        reinterpretation: { score: reinterpretationScore, weight: this.weights.reinterpretation, weighted: Math.round(reinterpretationScore * this.weights.reinterpretation) },
        newEmotionDimension: { score: newEmotionScore, weight: this.weights.newEmotionDimension, weighted: Math.round(newEmotionScore * this.weights.newEmotionDimension) },
        visualExpressible: { score: visualScore, weight: this.weights.visualExpressible, weighted: Math.round(visualScore * this.weights.visualExpressible) },
        beastFeatureBinding: { score: bindingScore, weight: this.weights.beastFeatureBinding, weighted: Math.round(bindingScore * this.weights.beastFeatureBinding) },
        // v2.0新增
        needRevealTiming: { score: needRevealScore, weight: 0.10, weighted: Math.round(needRevealScore * 0.10) },
        silenceBudget: { score: silenceBudgetScore, weight: 0.10, weighted: Math.round(silenceBudgetScore * 0.10) }
      },
      recommendation: passed ? null : this.generateRecommendationV2(roundedScore, reinterpretationScore, newEmotionScore, visualScore, bindingScore, needRevealScore, silenceBudgetScore),
      retryCount: options.retryCount || 0
    };
  }

  // 维度1：重理解性（0-100）
  // 是否让前3个Beat的内容被重新理解？
  scoreReinterpretation(beats, beat3, beat4) {
    let score = 0;
    
    // 检查B3是否有"反常"动作
    const hasAnomaly = this.checkForAnomaly(beat3);
    if (hasAnomaly) score += 40;
    
    // 检查B4是否颠覆了前3个Beat的理解
    const hasReversal = this.checkForReversal(beats, beat4);
    if (hasReversal) score += 40;
    
    // 检查B1-B2的内容在B4后是否有新的理解
    const hasRecontextualization = this.checkRecontextualization(beats);
    if (hasRecontextualization) score += 20;
    
    return Math.min(100, score);
  }

  // 维度2：新情感维度（0-100）
  // 是否引出新的情感维度（从恐惧到感动）？
  scoreNewEmotionDimension(beats, beat4) {
    const emotions = beats.map(b => b.emotionTarget?.emotion);
    
    // 检查是否有负面到正面的转变
    const negativeEmotions = ['fear', 'tension', 'confusion', 'anger'];
    const positiveEmotions = ['awe', 'relief', 'warmth', 'trust'];
    
    const hasNegative = emotions.some(e => negativeEmotions.includes(e));
    const hasPositive = emotions.some(e => positiveEmotions.includes(e));
    
    let score = 0;
    if (hasNegative) score += 30;
    if (hasPositive) score += 30;
    
    // 检查B4是否引入了B1-B3没有的情感
    const b4Emotion = beat4.emotionTarget?.emotion;
    const earlierEmotions = emotions.slice(0, 3);
    if (!earlierEmotions.includes(b4Emotion)) {
      score += 40; // B4引入了全新情感
    }
    
    return Math.min(100, score);
  }

  // 维度3：视觉可表达性（0-100）
  // 是否可以用画面而非台词表达？
  scoreVisualExpressibility(beat4) {
    let score = 0;
    
    const visualPrompt = beat4.visualPromptTemplate || '';
    
    // 检查visualPrompt是否包含具体动作
    const hasAction = /(动作|行为|展示|变化|反应|表情|眼神|触碰|共享|并肩|低|张|竖|转|变|化)/.test(visualPrompt);
    if (hasAction) score += 40;
    
    // 检查是否有环境变化（视觉化反转）
    const hasEnvironmentChange = /(环境|场景|光|暗|花开|变化|重生|转变|剧变|花海|绽放)/.test(visualPrompt);
    if (hasEnvironmentChange) score += 30;
    
    // 检查是否可以用"静音播放"理解
    const hasVisualNarrative = /(画面|镜头|特写|全景|俯拍|仰拍|对比|反差|视觉|真相|震撼)/.test(visualPrompt);
    if (hasVisualNarrative) score += 30;
    
    return Math.min(100, score);
  }

  // 维度4：异兽特征绑定（0-100）
  // 反转是否与异兽的核心特征绑定？
  scoreBeastFeatureBinding(beat4, beastProfile) {
    const signatureFeatures = beastProfile.signatureFeatures || [];
    const visualPrompt = beat4.visualPromptTemplate || '';
    const narration = beat4.narrationTemplate || '';
    const combined = visualPrompt + narration;
    
    let score = 0;
    
    // 检查是否提到了至少1个核心特征
    const featureMatches = signatureFeatures.filter(f => combined.includes(f.substring(0, 6))); // 匹配前6个字即可
    if (featureMatches.length >= 1) score += 40;
    if (featureMatches.length >= 2) score += 20;
    
    // 检查反转是否直接利用了核心特征
    const featureDirectlyUsed = signatureFeatures.some(f => {
      const featureName = f.substring(0, 6);
      // 特征在反转中被"重新解释"
      return combined.includes(featureName) && /(原来|其实是|不是|而是|守护|保护|创造|过滤|吐出|转化|重构)/.test(combined);
    });
    if (featureDirectlyUsed) score += 40;
    
    return Math.min(100, score);
  }

  // 辅助方法：检查是否有"反常"动作
  checkForAnomaly(beat) {
    const content = (beat.narrationTemplate || '') + (beat.visualPromptTemplate || '');
    const anomalyPatterns = [
      '反常', '奇怪', '不对', '不是攻击', '不是毁灭', '不是吃', '不是伤害',
      '守护', '保护', '创造', '播种', '修复', '治愈', '温柔', '小心翼翼',
      '不是', '而是', '原来', '其实'
    ];
    return anomalyPatterns.some(p => content.includes(p));
  }

  // 辅助方法：检查是否有颠覆
  checkForReversal(beats, beat4) {
    const b4Content = (beat4.narrationTemplate || '') + (beat4.visualPromptTemplate || '');
    const reversalPatterns = [
      '原来', '其实是', '不是', '而是', '真相', '误解', '守护', '牺牲',
      '不是毁灭', '不是攻击', '不是敌人', '是朋友', '是园丁', '是守护者'
    ];
    return reversalPatterns.some(p => b4Content.includes(p));
  }

  // 辅助方法：检查是否有重新语境化
  checkRecontextualization(beats) {
    // 检查B1-B2的内容在B4-B5后是否有新的理解
    const beat1 = beats.find(b => b.id === 'B1');
    const beat2 = beats.find(b => b.id === 'B2');
    const beat5 = beats.find(b => b.id === 'B5');
    
    if (!beat1 || !beat5) return false;
    
    // B5是否呼应了B1，但赋予了新的含义
    const b5Content = (beat5.narrationTemplate || '') + (beat5.visualPromptTemplate || '');
    const b1Content = (beat1.narrationTemplate || '') + (beat1.visualPromptTemplate || '');
    
    // 简单检查：B5提到了B1的元素，但有不同的情感色彩
    const hasCallback = b5Content.includes(beat1.beastMonologue ? '300年' : '日常');
    const hasNewEmotion = /\b(理解|看见|温暖|释然|终于)\b/.test(b5Content);
    
    return hasCallback && hasNewEmotion;
  }

  // 【v2.0新增】维度5：Need最后10秒揭示验证
  // 60秒中，Need必须在最后10秒才被揭示。前50秒观众以为异兽在追求Want
  scoreNeedRevealTiming(beats, beastProfile) {
    let score = 0;
    
    // 获取B1-B3的台词（前50秒）
    const earlyBeats = beats.filter(b => ['B1', 'B2', 'B3'].includes(b.id));
    const lateBeats = beats.filter(b => ['B4', 'B5'].includes(b.id));
    
    // 检查前50秒是否只表达Want（表层欲望）
    const earlyWantExpressed = earlyBeats.some(b => {
      const content = (b.narrationTemplate || '') + (b.visualPromptTemplate || '');
      return /(守护|驱逐|保护|攻击|威胁|饥饿|吞噬)/.test(content);
    });
    if (earlyWantExpressed) score += 30;
    
    // 检查最后10秒（B5）是否表达Need（深层需要）
    const beat5 = beats.find(b => b.id === 'B5');
    if (beat5) {
      const b5Content = (beat5.narrationTemplate || '') + (beat5.visualPromptTemplate || '');
      const needExpressed = /(被看见|不再孤独|理解|连接|温暖|记住|传承|礼物)/.test(b5Content);
      if (needExpressed) score += 40;
      
      // 检查是否有核心意象绽放
      const hasImageBloom = /(火种|托住|接住|光|绽放|消散|传承)/.test(b5Content);
      if (hasImageBloom) score += 30;
    }
    
    return Math.min(100, score);
  }

  // 【v2.0新增】维度6：静默预算检查
  // 最后8-12秒必须静默，不说话，只用感官意象完成叙事
  scoreSilenceBudget(beats) {
    let score = 0;
    
    // 检查B5（最后12秒）的台词数量
    const beat5 = beats.find(b => b.id === 'B5');
    if (!beat5) return 0;
    
    // 检查B5是否有台词字段（ beastLines/humanLines ）
    const hasBeastLine = beat5.beastMonologue && beat5.beastMonologue.length > 0;
    const hasHumanLine = beat5.humanPerspective && beat5.humanPerspective.length > 0;
    
    // 理想状态：B5只有0-1句台词，最后8秒纯静默
    if (!hasBeastLine && !hasHumanLine) {
      score += 50; // 完全静默
    } else if (!hasBeastLine || !hasHumanLine) {
      score += 30; // 半静默
    }
    
    // 检查visualPrompt是否包含静默意象
    const visualPrompt = beat5.visualPromptTemplate || '';
    const silenceImages = /(空镜|静默|无声|呼吸|微光|余韵|消散|黑场|留白|停止|静止)/.test(visualPrompt);
    if (silenceImages) score += 30;
    
    // 检查是否有"环境代替说话"的设计
    const envSpeaks = /(环境|峡谷|地脉|风|光|震动|频率|呼吸)/.test(visualPrompt);
    if (envSpeaks) score += 20;
    
    return Math.min(100, score);
  }

  // 生成改进建议（v2.0版本）
  generateRecommendationV2(totalScore, reinterpretation, newEmotion, visual, binding, needReveal, silenceBudget) {
    const suggestions = [];
    
    if (reinterpretation < 60) {
      suggestions.push('前3个Beat的内容需要被"重新理解"——确保B4颠覆了之前的理解');
    }
    if (newEmotion < 60) {
      suggestions.push('B4需要引入全新的情感维度（从恐惧到感动）');
    }
    if (visual < 60) {
      suggestions.push('反转需要更强的视觉呈现——观众应该"看到"而非"听到"反转');
    }
    if (binding < 60) {
      suggestions.push('反转必须与异兽的核心特征绑定——不要是通用反转');
    }
    if (needReveal < 60) {
      suggestions.push('Need必须在最后10秒才被揭示——前50秒只表达Want，B5才暴露Need');
    }
    if (silenceBudget < 60) {
      suggestions.push('最后8-12秒必须静默——不说话，只用感官意象完成叙事');
    }
    
    return suggestions.join('\n');
  }

  generateRecommendation(totalScore, reinterpretation, newEmotion, visual, binding) {
    return this.generateRecommendationV2(totalScore, reinterpretation, newEmotion, visual, binding, 100, 100);
  }

  // 自动修复建议
  suggestFixes(beats, beastProfile) {
    const validation = this.validateTwist(beats, beastProfile);
    if (validation.passed) return null;
    
    const fixes = [];
    const details = validation.details;
    
    if (details.reinterpretation.score < 60) {
      fixes.push({
        beat: 'B3',
        action: '增加"反常"动作——展示异兽做一件与它"恐怖形象"矛盾的事',
        example: '饕餮的巨口插入地面，但吐出的不是唾液，而是发光的种子'
      });
    }
    
    if (details.newEmotionDimension.score < 60) {
      fixes.push({
        beat: 'B4',
        action: '引入全新情感——从B1-B3的"紧张/恐惧"转为"感动/敬畏"',
        example: 'B4情绪目标改为"awe"（敬畏），强度0.9'
      });
    }
    
    if (details.visualExpressible.score < 60) {
      fixes.push({
        beat: 'B4',
        action: '增加视觉动作——用画面而非台词表达反转',
        example: '环境从荒芜变为花海，饕餮站在花丛中低头'
      });
    }
    
    if (details.beastFeatureBinding.score < 60) {
      fixes.push({
        beat: 'B4',
        action: '绑定核心特征——反转必须利用异兽的signatureFeature',
        example: '巨口不是吞噬，而是"过滤黑暗，吐出光明"'
      });
    }
    
    return fixes;
  }
}

module.exports = { TwistValidator };

// 测试
if (require.main === module) {
  const validator = new TwistValidator({ minScore: 70 });
  
  const beats = [
    { id: 'B1', emotionTarget: { emotion: 'curious' }, narrationTemplate: '饕餮的日常', visualPromptTemplate: '钩吾山荒原，饕餮在过滤孢子' },
    { id: 'B2', emotionTarget: { emotion: 'tension' }, narrationTemplate: '小G闯入', visualPromptTemplate: '小G出现，饕餮警觉' },
    { id: 'B3', emotionTarget: { emotion: 'confusion' }, narrationTemplate: '饕餮不是攻击，而是在播种', visualPromptTemplate: '饕餮巨口插入地面，吐出发光种子' },
    { id: 'B4', emotionTarget: { emotion: 'awe' }, narrationTemplate: '原来饕餮是园丁，吞噬黑暗吐出光明', visualPromptTemplate: '饕餮站在花海中，环境剧变' },
    { id: 'B5', emotionTarget: { emotion: 'relief' }, narrationTemplate: '理解比征服更有力量', visualPromptTemplate: '小G和饕餮同框，花海绽放' }
  ];
  
  const beastProfile = {
    signatureFeatures: ['巨口占面部2/3', '腋下双眼', '永不满足的饥饿']
  };
  
  const result = validator.validateTwist(beats, beastProfile);
  console.log('=== TwistValidator 测试 ===');
  console.log('通过:', result.passed);
  console.log('分数:', result.score, '/ 100');
  console.log('维度:', result.details);
  if (!result.passed) {
    console.log('建议:', result.recommendation);
    console.log('修复方案:', validator.suggestFixes(beats, beastProfile));
  }
}
