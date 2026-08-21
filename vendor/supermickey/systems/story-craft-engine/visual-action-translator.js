// visual-action-translator.js — StoryCraft Engine v1.1
// 视觉动作翻译器：将抽象概念叙述转化为直观视觉动作
// 核心原则：观众3秒内看懂发生了什么，不需要"听说"

class VisualActionTranslator {
  constructor(options = {}) {
    this.strictMode = options.strictMode !== false; // 默认严格模式
    this.minVisualElements = options.minVisualElements || 3; // 每节拍至少3个视觉元素
    this.verbRichness = options.verbRichness || 'high'; // high/medium/low
  }

  // 核心规则库：抽象概念 → 视觉动作映射
  static get CONCEPT_TO_ACTION_MAP() {
    return {
      // === 抽象环境监测 → 视觉化动作 ===
      '毒素上升': {
        abstract: '土壤毒素含量上升了3%',
        visual: '饕餮张嘴吸入黑色烟雾，周围枯萎的植物开始恢复翠绿',
        verbs: ['吸入', '恢复', '净化'],
        reaction: '植物从枯黄→翠绿的颜色变化（3秒内可见）'
      },
      '污染净化': {
        abstract: '最近100年，Nirath的毒素在增加',
        visual: '饕餮的鼻孔喷出淡金色光粒子，脚下黑色土壤转为暗金色',
        verbs: ['喷出', '转化', '净化'],
        reaction: '土壤颜色从黑→暗金，孢子从暗红→亮蓝的渐变'
      },
      '饥饿': {
        abstract: '还要再吃多少？/永不满足的饥饿',
        visual: '饕餮巨口张开，黑色毒素如河流般被吸入，嘴角溢出金色光尘',
        verbs: ['张开', '吸入', '溢出'],
        reaction: '吸入的是黑色，溢出的是金色——转化过程的视觉隐喻'
      },

      // === 时间/历史 → 视觉痕迹 ===
      '300年孤独': {
        abstract: '300年了。第一个不逃的。',
        visual: '饕餮脚下散落着数百个破碎的金属头盔/工具，小G是唯一站着的',
        verbs: ['散落', '站立', '靠近'],
        reaction: '满地残骸vs小G站立 = 历史与现在的视觉对比'
      },
      '长期守护': {
        abstract: '它已经孤独守护了300年',
        visual: '饕餮身体周围有300圈年轮状的生长纹，每圈代表一年的守护',
        verbs: ['环绕', '生长', '守护'],
        reaction: '身体纹理讲故事，不需要台词'
      },

      // === 心理状态 → 表情/肢体语言 ===
      '心跳快但不逃': {
        abstract: '心跳很快，但没有跑',
        visual: '小G胸口微微起伏，手在颤抖但坚持向前伸出，一步没退',
        verbs: ['起伏', '颤抖', '伸出', '坚持'],
        reaction: '恐惧的生理反应 + 勇气的肢体选择 = 矛盾张力'
      },
      '警觉评估': {
        abstract: '第一反应不是攻击——是评估',
        visual: '饕餮头倾斜15°，一只腋下的眼睛缓慢眨动，鼻子微微嗅闻',
        verbs: ['倾斜', '眨动', '嗅闻'],
        reaction: '倾斜=好奇，不是攻击姿态；嗅闻=收集信息'
      },
      '被误解': {
        abstract: '被永远误解——每次人类看到我就逃或攻击',
        visual: '饕餮腋下双眼闪过一丝暗红→琥珀色的颜色变化（悲伤→期待）',
        verbs: ['闪烁', '变化', '期待'],
        reaction: '瞳孔颜色变化 = 情绪可视化，不需要台词解释'
      },

      // === 反转揭示 → 震撼视觉 ===
      '真相揭露': {
        abstract: '腋下双眼=唯一能看见"黑暗"的眼睛=大气过滤器',
        visual: '特写腋下双眼瞳孔收缩、锁定远处的黑色污染源，然后喷射淡蓝色净化光束',
        verbs: ['收缩', '锁定', '喷射'],
        reaction: '瞳孔动作 + 光束喷射 = 功能可视化，观众瞬间看懂'
      },
      '不是怪物': {
        abstract: '我...不是怪物。',
        visual: '饕餮低头，用鼻子轻轻触碰一朵枯萎的花，花瓣在它呼吸间重新绽放',
        verbs: ['低头', '触碰', '绽放'],
        reaction: '温柔动作 vs 可怕外表 = 反差产生理解'
      },

      // === 和解 → 触觉/环境变化 ===
      '理解': {
        abstract: '理解比征服更有力量',
        visual: '小G轻轻触碰饕餮的鼻子，饕餮闭上眼睛（信任），周围花海从地面蔓延绽放',
        verbs: ['触碰', '闭眼', '绽放'],
        reaction: '触碰=信任建立，闭眼=放下戒备，花海=环境回应情感'
      },
      '礼物': {
        abstract: '不是武器。是礼物。',
        visual: '小G手掌摊开，一颗种子发出柔和的绿光；饕餮鼻子凑近，眼睛从暗红变琥珀色',
        verbs: ['摊开', '发光', '凑近', '变化'],
        reaction: '种子的光 + 眼睛变色 = 接受信号，不需要台词'
      },

      // === 环境反馈 → 视觉符号 ===
      '力量流失': {
        abstract: '力量在流失。但我不能让这些植物死。',
        visual: '饕餮身体周围的金色光环逐渐暗淡，但它用前蹄死死按住一株幼苗',
        verbs: ['暗淡', '按住', '守护'],
        reaction: '光环暗淡=力量流失，按住幼苗=坚持守护'
      },
      '花海绽放': {
        abstract: '（花海绽放）',
        visual: '一朵接一朵，从两人脚边开始，荧光花朵向远处蔓延，直到整个荒原被点亮',
        verbs: ['绽放', '蔓延', '点亮'],
        reaction: '从点→面的蔓延过程，观众看到"改变"在发生'
      }
    };
  }

  // 抽象检测器：检测文本中的抽象概念
  detectAbstractConcepts(text) {
    const map = VisualActionTranslator.CONCEPT_TO_ACTION_MAP;
    const found = [];
    
    for (const [key, value] of Object.entries(map)) {
      // 检查抽象描述是否出现在文本中
      if (text.includes(value.abstract) || this.fuzzyMatch(text, value.abstract)) {
        found.push({ key, ...value });
      }
    }
    
    // 额外检测：纯数字/百分比通常是抽象的
    const hasNumbers = /\d+%?|\d+年|\d+天/.test(text);
    if (hasNumbers && found.length === 0) {
      found.push({
        key: 'unknown_numeric',
        abstract: text,
        visual: '【需替换】将数字转化为视觉变化过程',
        verbs: ['变化', '转化'],
        isWarning: true
      });
    }
    
    return found;
  }

  // 模糊匹配
  fuzzyMatch(text, pattern) {
    const textWords = text.split(/[，。！？\s]+/);
    const patternWords = pattern.split(/[，。！？\s]+/);
    
    let matchCount = 0;
    for (const pw of patternWords) {
      if (pw.length < 2) continue;
      for (const tw of textWords) {
        if (tw.includes(pw) || pw.includes(tw)) {
          matchCount++;
          break;
        }
      }
    }
    
    return matchCount >= Math.max(2, patternWords.length * 0.5);
  }

  // 翻译单条叙述：抽象 → 视觉动作
  translateNarration(abstractText, context = {}) {
    const { beatPhase, beastName, habitat } = context;
    const detected = this.detectAbstractConcepts(abstractText);
    
    if (detected.length === 0) {
      // 没有检测到抽象概念，但检查是否有"纯叙述"特征
      if (this.isPureNarration(abstractText)) {
        return {
          original: abstractText,
          translated: this.forceVisualize(abstractText, context),
          changes: [{ type: 'forced', reason: '纯叙述无动作' }],
          confidence: 0.6
        };
      }
      return {
        original: abstractText,
        translated: abstractText,
        changes: [],
        confidence: 1.0
      };
    }
    
    // 构建视觉化版本
    let visualText = abstractText;
    const changes = [];
    
    for (const concept of detected) {
      if (concept.isWarning) {
        changes.push({
          type: 'warning',
          original: concept.abstract,
          reason: '含数字/百分比，需人工设计视觉替代'
        });
        continue;
      }
      
      // 替换为视觉描述
      visualText = visualText.replace(
        new RegExp(this.escapeRegExp(concept.abstract), 'g'),
        concept.visual
      );
      
      changes.push({
        type: 'translated',
        original: concept.abstract,
        replacedWith: concept.visual,
        verbs: concept.verbs,
        reaction: concept.reaction
      });
    }
    
    return {
      original: abstractText,
      translated: visualText,
      changes,
      confidence: detected.length > 0 ? 0.9 : 0.7
    };
  }

  // 判断是否是"纯叙述"（无动作、无变化、无反应）
  isPureNarration(text) {
    const purePatterns = [
      /^(又一天|日复一日)/,
      /^(人类|男孩|孩子)/, // 纯身份陈述
      /(含量|指标|数据)/, // 数据陈述
      /^(谢谢|理解)/, // 纯情感词
    ];
    
    return purePatterns.some(p => p.test(text));
  }

  // 强制视觉化：给纯叙述加上动作
  forceVisualize(text, context) {
    const { beatPhase, beastName } = context;
    
    // 根据beatPhase给默认视觉动作
    const defaults = {
      hook: `${beastName || '异兽'}缓缓转头，目光扫过荒芜的土地，一片枯叶在它注视下化为金色尘埃飘落`,
      deepen: `小G的倒影出现在一滩液态汞般的水面，${beastName || '异兽'}的瞳孔微微收缩（注意到入侵者）`,
      crack: `${beastName || '异兽'}做出了一个反常动作——它低下头，不是攻击，而是...嗅闻？`,
      twist: `特写：${beastName || '异兽'}的"可怕特征"开始发光/变化/展现出从未见过的温柔`,
      resonance: `${beastName || '异兽'}和小G同时看向同一个方向，环境中的某个元素（花/光/水）开始回应他们的存在`
    };
    
    return defaults[beatPhase] || `${beastName || '异兽'}身体微微前倾，做出一个让观众意外但不恐惧的动作`;
  }

  // 翻译整条内心独白
  translateMonologue(monologueText, beastProfile) {
    const sentences = monologueText.split(/[。！？\n]+/).filter(s => s.trim());
    const translated = [];
    
    for (const sentence of sentences) {
      const result = this.translateNarration(sentence, {
        beatPhase: 'monologue',
        beastName: beastProfile?.name
      });
      translated.push(result);
    }
    
    const combinedText = translated.map(t => t.translated).join('。');
    const allChanges = translated.flatMap(t => t.changes);
    
    return {
      original: monologueText,
      translated: combinedText,
      sentences: translated,
      totalChanges: allChanges.length,
      confidence: translated.reduce((sum, t) => sum + t.confidence, 0) / translated.length
    };
  }

  // 翻译整个Beat的narration和visualPrompt
  translateBeat(beat, beastProfile) {
    const context = {
      beatPhase: beat.id?.toLowerCase()?.replace('b', '') || 'unknown',
      beastName: beastProfile?.name,
      habitat: beastProfile?.habitat
    };
    
    // 翻译narrationTemplate
    const narrationResult = beat.narrationTemplate 
      ? this.translateNarration(beat.narrationTemplate, context)
      : null;
    
    // 翻译visualPromptTemplate
    const visualResult = beat.visualPromptTemplate
      ? this.translateNarration(beat.visualPromptTemplate, context)
      : null;
    
    // 翻译beastMonologue
    const monologueResult = beat.beastMonologue
      ? this.translateMonologue(beat.beastMonologue, beastProfile)
      : null;
    
    return {
      beatId: beat.id,
      narration: narrationResult,
      visualPrompt: visualResult,
      monologue: monologueResult,
      isFullyVisual: this.checkFullyVisual(narrationResult, visualResult),
      suggestions: this.generateSuggestions(narrationResult, visualResult, monologueResult)
    };
  }

  // 检查是否完全视觉化
  checkFullyVisual(narrationResult, visualResult) {
    if (!narrationResult || !visualResult) return false;
    
    const narrationChanges = narrationResult.changes?.length || 0;
    const visualChanges = visualResult.changes?.length || 0;
    
    // 如果narration有翻译改动，且visualPrompt也有改动 = 基本完成
    return narrationChanges > 0 || visualChanges > 0;
  }

  // 生成改进建议
  generateSuggestions(narrationResult, visualResult, monologueResult) {
    const suggestions = [];
    
    if (narrationResult?.changes?.length === 0) {
      suggestions.push('narration仍含抽象描述，建议增加具体动作动词');
    }
    
    if (visualResult?.changes?.length === 0) {
      suggestions.push('visualPrompt缺少视觉变化过程，建议增加3秒内的可见变化');
    }
    
    if (monologueResult?.totalChanges === 0) {
      suggestions.push('内心独白未视觉化，建议转化为表情/肢体动作描述');
    }
    
    return suggestions;
  }

  // 批量翻译整个StoryCraft结果
  translateStoryCraft(storyCraftResult, beastProfile) {
    const beats = storyCraftResult.beats || [];
    const translated = [];
    
    for (const beat of beats) {
      translated.push(this.translateBeat(beat, beastProfile));
    }
    
    const stats = {
      totalBeats: beats.length,
      fullyVisualBeats: translated.filter(t => t.isFullyVisual).length,
      totalChanges: translated.reduce((sum, t) => {
        return sum + 
          (t.narration?.changes?.length || 0) + 
          (t.visualPrompt?.changes?.length || 0) + 
          (t.monologue?.totalChanges || 0);
      }, 0),
      averageConfidence: translated.reduce((sum, t) => {
        const confidences = [];
        if (t.narration) confidences.push(t.narration.confidence);
        if (t.monologue) confidences.push(t.monologue.confidence);
        return sum + (confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0);
      }, 0) / translated.length
    };
    
    return {
      beats: translated,
      stats,
      summary: this.generateSummary(stats),
      rules: VisualActionTranslator.getRulesSummary()
    };
  }

  // 生成摘要
  generateSummary(stats) {
    const ratio = stats.fullyVisualBeats / stats.totalBeats;
    
    if (ratio >= 0.8) {
      return `✅ 高度视觉化 (${stats.fullyVisualBeats}/${stats.totalBeats} 节拍)，观众可直接理解`;
    } else if (ratio >= 0.5) {
      return `⚠️ 部分视觉化 (${stats.fullyVisualBeats}/${stats.totalBeats} 节拍)，建议继续优化剩余节拍`;
    } else {
      return `❌ 视觉化不足 (${stats.fullyVisualBeats}/${stats.totalBeats} 节拍)，需大幅调整`;
    }
  }

  // 获取规则摘要（用于文档/报告）
  static getRulesSummary() {
    return {
      title: '直观动作替代概念叙事规则 v1.1',
      principles: [
        '观众3秒内看懂发生了什么，不需要"听说"',
        '每个镜头必须有"动作 + 反应 + 变化"',
        '用动词替代形容词，用过程替代状态',
        '环境变化是情感的视觉翻译器',
        '数字/百分比必须转化为可见的颜色/形态/运动变化'
      ],
      forbidden: [
        '纯数字陈述（"上升了3%"）',
        '纯时间陈述（"300年了"）',
        '纯情感词（"谢谢...看见"）',
        '纯身份标签（"人类""男孩"）',
        '抽象评估（"第一反应是评估"）'
      ],
      required: [
        '至少3个具体动作动词',
        '至少1个可见的环境/物体变化',
        '至少1个角色表情/肢体反应',
        '变化过程在3秒内可感知'
      ],
      examples: [
        { bad: '土壤毒素上升3%', good: '饕餮张嘴吸入黑色烟雾，周围植物从枯萎变翠绿' },
        { bad: '300年了，第一个不逃的', good: '满地破碎头盔中，小G是唯一站着的' },
        { bad: '我...不是怪物', good: '饕餮低头触碰枯萎的花，花瓣在它呼吸间重新绽放' },
        { bad: '谢谢...看见', good: '小G触碰饕餮鼻子，饕餮闭眼，花海从地面蔓延绽放' }
      ]
    };
  }

  escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = { VisualActionTranslator };

// 测试
if (require.main === module) {
  const translator = new VisualActionTranslator();
  
  // 测试单条翻译
  const tests = [
    '又一天。土壤的毒素含量上升了3%。还要再吃多少？',
    '人类。心跳很快，但没有跑。300年了。第一个不逃的。',
    '他在给我...种子？不是武器。是礼物。',
    '力量在流失。但我不能让这些植物死。再撑一下。',
    '这颗种子...是起源。他给了我最珍贵的东西。'
  ];
  
  console.log('=== VisualActionTranslator 测试 ===\n');
  for (const test of tests) {
    const result = translator.translateNarration(test, { beatPhase: 'hook', beastName: '饕餮' });
    console.log('原文:', result.original);
    console.log('翻译:', result.translated);
    console.log('改动:', result.changes.length, '处');
    if (result.changes.length > 0) {
      result.changes.forEach((c, i) => {
        console.log(`  ${i+1}. ${c.type}: "${c.original}" → "${c.replacedWith || c.reason}"`);
      });
    }
    console.log('');
  }
}
