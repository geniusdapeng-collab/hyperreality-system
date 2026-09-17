// concept-forge.js — StoryCraft Engine v1.0
// 概念锻造炉：从异兽档案提取"缺陷"，反向推导高概念故事种子

class ConceptForge {
  constructor(options = {}) {
    this.seedCount = options.seedCount || 3; // 生成3个种子
    this.minTwistStrength = options.minTwistStrength || 0.7; // 最小反转强度
  }

  // 核心方法：生成高概念故事种子
  generateSeeds(beastProfile, options = {}) {
    const { name, signatureFeatures, weaknesses, abilities, mythOrigin, nirathHabitat } = beastProfile;
    
    // 提取"可反转"的特征
    const reversibleFeatures = this.extractReversibleFeatures(signatureFeatures, weaknesses, abilities);
    
    // 生成3个高概念种子
    const seeds = [];
    
    for (let i = 0; i < this.seedCount; i++) {
      const seed = this.forgeSeed(reversibleFeatures, beastProfile, i);
      seeds.push(seed);
    }
    
    // 排序：反转强度高的排前面
    seeds.sort((a, b) => b.twistStrength - a.twistStrength);
    
    return {
      seeds,
      selected: seeds[0], // 默认选最强的一个
      metadata: {
        beastName: name,
        featureCount: reversibleFeatures.length,
        generatedAt: new Date().toISOString()
      }
    };
  }

  // 提取可反转的特征
  extractReversibleFeatures(signatureFeatures, weaknesses, abilities) {
    const reversible = [];
    
    // 从signatureFeatures提取
    (signatureFeatures || []).forEach(feature => {
      const reversal = this.inferReversal(feature);
      if (reversal) {
        reversible.push({
          source: 'signatureFeature',
          feature,
          appearsAs: reversal.appearsAs,
          actuallyIs: reversal.actuallyIs,
          twistStrength: reversal.strength
        });
      }
    });
    
    // 从weaknesses提取
    (weaknesses || []).forEach(weakness => {
      const reversal = this.inferReversalFromWeakness(weakness);
      if (reversal) {
        reversible.push({
          source: 'weakness',
          feature: weakness,
          appearsAs: reversal.appearsAs,
          actuallyIs: reversal.actuallyIs,
          twistStrength: reversal.strength
        });
      }
    });
    
    // 从abilities提取
    (abilities || []).forEach(ability => {
      const reversal = this.inferReversalFromAbility(ability);
      if (reversal) {
        reversible.push({
          source: 'ability',
          feature: ability,
          appearsAs: reversal.appearsAs,
          actuallyIs: reversal.actuallyIs,
          twistStrength: reversal.strength
        });
      }
    });
    
    return reversible;
  }

  // 推断反转（从特征）
  inferReversal(feature) {
    // 特征 → 表象 → 真相 的映射表
    const reversalMap = {
      // 饕餮特征
      '巨口永远张开': { appearsAs: '贪婪吞噬', actuallyIs: '过滤黑暗，吐出光明', strength: 0.9 },
      '腋下双眼': { appearsAs: '神秘莫测', actuallyIs: '唯一能看见"黑暗"的眼睛', strength: 0.8 },
      '永不满足的饥饿': { appearsAs: '贪婪暴食', actuallyIs: '永恒的守护——必须不断吞噬毒素', strength: 0.95 },
      '羊身人面': { appearsAs: '怪诞 hybrid', actuallyIs: '生命的结合——兽的力量+人的理解', strength: 0.7 },
      
      // 九尾狐特征
      '九尾': { appearsAs: '魅惑妖异', actuallyIs: '记忆的储存——每条尾巴储存100年的记忆', strength: 0.85 },
      '迷惑人心': { appearsAs: '邪恶控制', actuallyIs: '修复破碎的记忆，帮助失忆者找回过去', strength: 0.9 },
      
      // 烛龙特征
      '睁眼昼闭眼夜': { appearsAs: '掌控昼夜', actuallyIs: '调节双恒星轨道，防止碰撞', strength: 0.9 },
      '不食不寝不息': { appearsAs: '怪物 endurance', actuallyIs: '永不停歇的守护——它在维持Nirath自转', strength: 0.85 },
      
      // 通用模式
      '巨大': { appearsAs: '威胁', actuallyIs: '保护者体型', strength: 0.6 },
      '火焰': { appearsAs: '毁灭', actuallyIs: '净化/重生', strength: 0.7 },
      '冰冻': { appearsAs: '死亡', actuallyIs: '保存/休眠', strength: 0.7 }
    };
    
    // 查找匹配
    for (const [key, value] of Object.entries(reversalMap)) {
      if (feature.includes(key) || key.includes(feature)) {
        return value;
      }
    }
    
    // 默认反转：如果找不到具体映射，用通用模式
    return { appearsAs: '威胁/恐怖', actuallyIs: '被误解的守护', strength: 0.5 };
  }

  // 从弱点推断反转
  inferReversalFromWeakness(weakness) {
    const weaknessMap = {
      '骄傲': { appearsAs: '傲慢', actuallyIs: '不敢承认需要帮助', strength: 0.7 },
      '孤独': { appearsAs: '孤僻', actuallyIs: '曾经太多次被伤害', strength: 0.8 },
      '贪婪': { appearsAs: '自私', actuallyIs: '害怕再次失去', strength: 0.7 },
      '愤怒': { appearsAs: '暴躁', actuallyIs: '对不公的抗议', strength: 0.75 }
    };
    
    for (const [key, value] of Object.entries(weaknessMap)) {
      if (weakness.includes(key)) return value;
    }
    
    return { appearsAs: '缺陷', actuallyIs: '未被理解的痛苦', strength: 0.5 };
  }

  // 从能力推断反转
  inferReversalFromAbility(ability) {
    const abilityMap = {
      '吞噬': { appearsAs: '毁灭', actuallyIs: '转化——吸收黑暗，释放光明', strength: 0.9 },
      '迷惑': { appearsAs: '控制', actuallyIs: '修复——重组破碎的记忆', strength: 0.85 },
      '火焰': { appearsAs: '燃烧', actuallyIs: '净化——焚烧毒素，留下纯净', strength: 0.8 },
      '冰冻': { appearsAs: '冻结', actuallyIs: '保存——暂停时间，保护脆弱', strength: 0.8 },
      '飞行': { appearsAs: '逃离', actuallyIs: '守望——从高处守护领地', strength: 0.7 }
    };
    
    for (const [key, value] of Object.entries(abilityMap)) {
      if (ability.includes(key)) return value;
    }
    
    return { appearsAs: '能力', actuallyIs: '被误解的天赋', strength: 0.5 };
  }

  // 锻造单个种子（v2.0升级：增加核心意象+预埋线索）
  forgeSeed(reversibleFeatures, beastProfile, index) {
    const { name, habitat, mythOrigin } = beastProfile;
    
    // 选择特征（每个种子用不同的特征组合）
    const selectedFeatures = this.selectFeaturesForSeed(reversibleFeatures, index);
    
    // 生成主题
    const theme = this.generateTheme(selectedFeatures, beastProfile);
    
    // 生成核心反转
    const coreTwist = this.generateCoreTwist(selectedFeatures);
    
    // 生成情感锚点
    const emotionalAnchor = this.generateEmotionalAnchor(selectedFeatures, beastProfile);
    
    // 计算反转强度
    const twistStrength = this.calculateTwistStrength(selectedFeatures);
    
    // v2.0新增：生成核心意象
    const coreImage = this.generateCoreImageForSeed(theme, beastProfile);
    
    // v2.0新增：生成预埋线索
    const seedClues = this.generateSeedClues(theme, beastProfile, coreImage);
    
    return {
      id: `seed-${index + 1}`,
      theme,
      coreTwist,
      emotionalAnchor,
      twistStrength,
      features: selectedFeatures,
      tagline: this.generateTagline(theme, coreTwist, name),
      visualHook: this.generateVisualHook(selectedFeatures, beastProfile),
      oneSentencePitch: this.generateOneSentencePitch(theme, coreTwist, name, emotionalAnchor),
      // v2.0新增：核心意象和预埋线索
      coreImage,
      seedClues,
      bloomMoment: coreImage.bloomMoment
    };
  }

  // v2.0新增：为核心种子生成核心意象
  // 每个异兽故事只能有一个核心意象，它在最后10秒出现，承担所有叙事功能
  generateCoreImageForSeed(theme, beastProfile) {
    const { name } = beastProfile;
    
    // 主题→核心意象映射
    const imageMap = {
      '永恒饥饿': {
        image: '火种被另一只手托住',
        description: `${name}消散时，某个东西被接住了——不是结束，是传承的开始`,
        seedClues: [
          '战魂的"光"在逐渐暗淡',
          '温度的隐喻反复出现',
          '消散与凝聚的对比'
        ],
        bloomMoment: '战魂消散瞬间，一个孩子手中的微光——无声，只有地脉震动的频率改变'
      },
      '守护': {
        image: '破碎的盾被补好',
        description: `${name}的伤痕不是弱点，是守护的证明`,
        seedClues: [
          '盾上的裂纹被反复修复',
          '守护的姿势不变',
          '伤痕积累的记录'
        ],
        bloomMoment: '盾裂开的瞬间，不是崩溃，而是光从裂缝中透出来'
      },
      '连接': {
        image: '两个频率的共振',
        description: `${name}终于找到一个能听懂它频率的存在`,
        seedClues: [
          '孤独的频率',
          '等待的回声',
          '不同调性的试探'
        ],
        bloomMoment: '两个不同调性的音叉找到了共同的泛音——无声的共鸣'
      },
      '治愈': {
        image: '毒液变成甘露',
        description: `${name}的痛苦不是诅咒，是转化的礼物`,
        seedClues: [
          '吸收时的痛苦',
          '转化时的光芒',
          '付出后的虚弱'
        ],
        bloomMoment: '最后一滴毒液落下，接触地面时开出一朵花'
      }
    };

    const image = imageMap[theme] || imageMap['永恒饥饿'];

    return {
      ...image,
      function: '一个意象 = 角色弧光的完成 + 主题的点题 + 情感的余韵',
      rule: '必须在前50秒预埋线索（种子），在最后10秒静默绽放（开花）',
      checkList: [
        '□ 预埋线索出现在第一幕（0-12秒）',
        '□ 预埋线索出现在第二幕（12-40秒）',
        '□ 预埋线索出现在第三幕前半（40-52秒）',
        '□ 最终绽放在最后8-10秒静默完成'
      ]
    };
  }

  // v2.0新增：生成预埋线索清单
  // 核心意象必须在前50秒预埋线索，最后10秒绽放
  generateSeedClues(theme, beastProfile, coreImage) {
    const { name, signatureFeatures = [] } = beastProfile;
    const { seedClues = [] } = coreImage;
    
    // 基于异兽特征生成额外的预埋线索
    const featureClues = signatureFeatures.map((feature, index) => {
      const clueMap = {
        '巨口': '巨口张开时，内部不是黑暗，而是微弱的光',
        '腋下双眼': '腋下双眼的暗红色竖瞳中，倒映着不属于这个世界的光谱',
        '永不满足': '饥饿的波纹在空气中扩散，但目标不是食物，是毒素',
        '九尾': '九条尾巴的摆动频率，像心跳一样规律——那是记忆的节拍',
        '迷惑': '迷惑的色晕中，有一个固定的颜色——那是它真实的情绪'
      };
      
      for (const [key, value] of Object.entries(clueMap)) {
        if (feature.includes(key)) return value;
      }
      return `${feature}中隐藏着不为人知的温柔`;
    });

    return {
      coreImageClues: seedClues,
      featureClues,
      placement: {
        act1: seedClues.slice(0, 1),      // 第一幕：1个线索
        act2: [...seedClues.slice(1), ...featureClues.slice(0, 2)], // 第二幕：2-3个线索
        act3a: featureClues.slice(2, 3)    // 第三幕前半：1个线索
      },
      validation: '预埋线索检查：每个线索必须在对应幕的Prompt中明确出现'
    };
  }

  // 为每个种子选择特征组合
  selectFeaturesForSeed(reversibleFeatures, index) {
    if (reversibleFeatures.length === 0) return [];
    
    // 种子1：用最强的特征
    if (index === 0) {
      return reversibleFeatures.slice(0, 2); // 前2个最强
    }
    
    // 种子2：用不同的特征组合
    if (index === 1) {
      return reversibleFeatures.slice(1, 3); // 第2-3个
    }
    
    // 种子3：用弱点驱动的反转
    if (index === 2) {
      const weaknessFeatures = reversibleFeatures.filter(f => f.source === 'weakness');
      return weaknessFeatures.length > 0 ? weaknessFeatures.slice(0, 2) : reversibleFeatures.slice(0, 2);
    }
    
    return reversibleFeatures.slice(0, 2);
  }

  // 生成主题
  generateTheme(features, beastProfile) {
    const { name } = beastProfile;
    
    if (features.length === 0) return `${name}的守护`;
    
    const primaryFeature = features[0];
    const themes = {
      '吞噬': '永恒 hunger → 永恒的牺牲',
      '迷惑': '破碎的记忆 → 修复的温柔',
      '火焰': '毁灭的表象 → 净化的本质',
      '冰冻': '死亡的冻结 → 生命的保存',
      '巨大': '威胁的体型 → 保护的承诺'
    };
    
    for (const [key, theme] of Object.entries(themes)) {
      if (primaryFeature.feature.includes(key)) return theme;
    }
    
    return `${name}的${primaryFeature.actuallyIs}`;
  }

  // 生成核心反转
  generateCoreTwist(features) {
    if (features.length === 0) return '被误解的守护';
    
    const primary = features[0];
    return `${primary.appearsAs} → ${primary.actuallyIs}`;
  }

  // 生成情感锚点
  generateEmotionalAnchor(features, beastProfile) {
    const anchors = [
      '理解比征服更有力量',
      '被看见，是最深的渴望',
      '温柔，可以来自最可怕的外表',
      '孤独千年，只为一次理解',
      '牺牲，是守护的另一种形式'
    ];
    
    // 根据特征选择最匹配的情感锚点
    const feature = features[0]?.feature || '';
    if (feature.includes('饥饿') || feature.includes('吞噬')) {
      return anchors[4]; // 牺牲
    }
    if (feature.includes('迷惑') || feature.includes('记忆')) {
      return anchors[1]; // 被看见
    }
    if (feature.includes('巨大') || feature.includes('力量')) {
      return anchors[2]; // 温柔
    }
    
    return anchors[0]; // 理解
  }

  // 计算反转强度
  calculateTwistStrength(features) {
    if (features.length === 0) return 0.5;
    
    const avgStrength = features.reduce((sum, f) => sum + f.twistStrength, 0) / features.length;
    const bonus = features.length > 1 ? 0.1 : 0; // 多个特征组合加分
    
    return Math.min(1.0, avgStrength + bonus);
  }

  // 生成宣传语（Tagline）
  generateTagline(theme, coreTwist, name) {
    const taglines = [
      `你以为的${theme.split('→')[0]?.trim()}，其实是${theme.split('→')[1]?.trim()}`,
      `${name}：${coreTwist}`,
      `最可怕的外表，最温柔的内心`,
      `千年孤独，只为一次理解`
    ];
    
    return taglines[0];
  }

  // 生成视觉钩子（第一帧就要抓眼）
  generateVisualHook(features, beastProfile) {
    const { name, signatureFeatures, habitat } = beastProfile;
    const primaryFeature = features[0];
    
    return `${name}的${signatureFeatures?.[0] || '独特特征'}，在${habitat}中，做着一件"反常"的事`;
  }

  // 生成一句话Pitch
  generateOneSentencePitch(theme, coreTwist, name, emotionalAnchor) {
    return `当8岁男孩小G遇到${name}，他发现${coreTwist}——${emotionalAnchor}。`;
  }

  // 选择最佳种子（供人工/系统选择）
  selectBestSeed(seeds, criteria = {}) {
    const { preferEmotional = true, preferVisual = true, minStrength = 0.7 } = seeds;
    
    // 过滤掉反转强度不够的
    const validSeeds = seeds.filter(s => s.twistStrength >= minStrength);
    
    if (validSeeds.length === 0) return seeds[0]; // 如果没有满足的，返回最强的
    
    // 评分排序
    const scored = validSeeds.map(seed => {
      let score = seed.twistStrength;
      if (preferEmotional && seed.emotionalAnchor) score += 0.1;
      if (preferVisual && seed.visualHook) score += 0.1;
      return { seed, score };
    });
    
    scored.sort((a, b) => b.score - a.score);
    return scored[0].seed;
  }
}

module.exports = { ConceptForge };

// 测试
if (require.main === module) {
  const forge = new ConceptForge({ seedCount: 3 });
  
  const beastProfile = {
    name: '饕餮',
    signatureFeatures: ['巨口永远张开（占面部2/3）', '腋下双眼（暗红色竖瞳）', '永不满足的饥饿'],
    weaknesses: ['骄傲', '对仁的渴望', '被误解的孤独'],
    abilities: ['吞噬万物', '过滤毒素', '转化能量'],
    mythOrigin: '羊身人面的远古凶兽',
    habitat: '钩吾山荒原'
  };
  
  const result = forge.generateSeeds(beastProfile);
  console.log('=== ConceptForge 测试 ===');
  console.log('生成种子数:', result.seeds.length);
  console.log('最佳种子:', result.selected.id);
  console.log('反转强度:', result.selected.twistStrength);
  console.log('\n所有种子:');
  result.seeds.forEach((seed, i) => {
    console.log(`\n种子${i+1}:`);
    console.log(`  主题: ${seed.theme}`);
    console.log(`  反转: ${seed.coreTwist}`);
    console.log(`  情感: ${seed.emotionalAnchor}`);
    console.log(`  强度: ${seed.twistStrength}`);
    console.log(`  Pitch: ${seed.oneSentencePitch}`);
  });
}
