// beast-psyche-generator.js — StoryCraft Engine v1.0
// 异兽心理画像生成器：为异兽生成完整心理模型 + 内心独白

class BeastPsycheGenerator {
  constructor(options = {}) {
    this.depth = options.depth || 'standard'; // 'basic' | 'standard' | 'deep'
    this.includeMemory = options.includeMemory !== false; // 默认包含记忆
    this.includeDialogue = options.includeDialogue !== false; // 默认包含对话
  }

  // 核心方法：生成异兽心理画像（v2.0升级：新增感知蓝图+欲望内核）
  generatePsyche(beastProfile, conceptSeed, options = {}) {
    const { name, signatureFeatures, weaknesses, abilities, mythOrigin } = beastProfile;
    const { theme, coreTwist } = conceptSeed;

    // 生成基础心理模型（保持v1.0兼容）
    const psyche = {
      identity: this.generateIdentity(name, mythOrigin, signatureFeatures),
      motivation: this.generateMotivation(weaknesses, theme, coreTwist),
      fear: this.generateFear(weaknesses, signatureFeatures),
      desire: this.generateDesire(weaknesses, theme),
      judgmentPattern: this.generateJudgmentPattern(abilities, signatureFeatures),
      memory: this.includeMemory ? this.generateMemory(name, mythOrigin) : null,
      innerVoice: this.generateInnerVoice(name, theme),
      // v2.0新增：感知蓝图（感官指纹）
      sensoryBlueprint: this.generateSensoryBlueprint(beastProfile, conceptSeed),
      // v2.0新增：欲望内核（Want/Need/Ghost/Lie）
      desireCore: this.generateDesireCoreV2(beastProfile, conceptSeed),
      // v2.0新增：异化困境
      alienationDilemma: this.generateAlienationDilemma(beastProfile, conceptSeed),
      // v2.0新增：核心意象
      coreImage: this.generateCoreImage(beastProfile, conceptSeed)
    };

    // 为每个Beat生成内心独白（保持v1.0兼容）
    const monologues = this.generateMonologuesByBeats(psyche, conceptSeed, options);

    // 生成异兽台词（如果启用）
    const dialogues = this.includeDialogue 
      ? this.generateDialogues(psyche, conceptSeed, options)
      : null;

    // v2.0新增：生成声音签名
    const voiceSignature = this.generateVoiceSignature(psyche, beastProfile);

    return {
      psyche,
      monologues,
      dialogues,
      voiceSignature, // v2.0新增
      metadata: {
        depth: this.depth,
        beastName: name,
        theme,
        generatedAt: new Date().toISOString(),
        version: 'v2.0' // v2.0标记
      }
    };
  }

  // 生成身份认知
  generateIdentity(name, mythOrigin, signatureFeatures) {
    return {
      selfConcept: `${name}认知自己是${mythOrigin || '远古异兽'}，`,
      uniqueTrait: `拥有${signatureFeatures?.[0] || '独特特征'}，`,
      socialRole: '在Nirath生态系统中扮演守护者角色，但常被误解为威胁',
      timePerception: '寿命以千年计，对"永恒"有独特理解'
    };
  }

  // 生成动机
  generateMotivation(weaknesses, theme, coreTwist) {
    const baseMotivations = {
      '永恒饥饿': '不是贪婪，是责任——必须持续吞噬黑暗，否则Nirath生态会崩溃',
      '守护': '保护某个脆弱的事物或区域，即使被误解也在所不惜',
      '连接': '渴望被理解，渴望与其他生命建立真正的连接',
      '治愈': '吸收痛苦/毒素，转化为生命力，但自身承受代价'
    };

    const motivation = baseMotivations[theme] || '守护Nirath的平衡，即使被误解';
    
    return {
      primary: motivation,
      secondary: weaknesses?.[0] ? `克服${weaknesses[0]}的挣扎` : '平衡本能与责任',
      hidden: coreTwist || '被误解的温柔'
    };
  }

  // 生成恐惧
  generateFear(weaknesses, signatureFeatures) {
    const fears = [
      '被永远误解——每次人类看到我就逃或攻击',
      '失去守护的能力——如果太虚弱，无法保护Nirath',
      '孤独——千年寿命意味着看着所有理解自己的人离去',
      '本能失控——"饥饿"有时会压倒理性，伤害无辜'
    ];

    // 根据弱点定制恐惧
    const customFear = weaknesses?.[0] 
      ? `${weaknesses[0]}带来的痛苦记忆`
      : fears[0];

    return {
      primary: customFear,
      secondary: fears[1],
      deepest: fears[2]
    };
  }

  // 生成渴望
  generateDesire(weaknesses, theme) {
    const desires = {
      '永恒饥饿': '有人能看到：我吃掉的黑暗，是为了让光明生长',
      '守护': '被认可为守护者，而非怪物',
      '连接': '一个不怕我的人，一个愿意触碰我的人',
      '治愈': '理解——理解我的痛苦不是诅咒，是礼物'
    };

    return {
      surface: desires[theme] || '被理解',
      deep: '与一个生命建立真正的连接，即使只是短暂的',
      ultimate: '证明"可怕的外表"可以有"温柔的内心"'
    };
  }

  // 生成判断模式（遇到人类时的决策树）
  generateJudgmentPattern(abilities, signatureFeatures) {
    return {
      step1_assess: '感知生命体征（心跳、体温、气味中的情绪）',
      step2_threatLevel: '判断威胁等级：逃跑=无威胁/攻击=有威胁/静止=未知',
      step3_response: {
        lowThreat: '观察，保持安全距离，评估意图',
        mediumThreat: '警告姿态（低吼、展示特征），但不主动攻击',
        highThreat: '防御性反击，保护自己和领地',
        unknown: '最谨慎的态度——等待对方先行动'
      },
      step4_reassess: '根据对方反应调整判断——如果对方不退缩，重新评估'
    };
  }

  // 生成记忆
  generateMemory(name, mythOrigin) {
    return {
      earliest: `${name}诞生于${mythOrigin || '远古'}，记得Nirath最初的模样`,
      significant: '200年前，有一个女孩也对它笑过——然后她消失了，留下了种子',
      recurring: '每次人类闯入，都是一样的模式：恐惧→攻击或逃跑→误解加深',
      recent: '最近100年，Nirath的毒素在增加，它需要更频繁地"进食"'
    };
  }

  // 生成内心声音风格
  generateInnerVoice(name, theme) {
    return {
      tone: theme === '永恒饥饿' ? '疲惫但坚定' : '孤独但温柔',
      vocabulary: ['千年', '永恒', '守护', '孤独', '理解', '种子', '黑暗', '光明'],
      speechPattern: '短句为主，有停顿，像是对自己说话，偶尔有诗意',
      emotionalRange: '从疲惫→惊讶→温柔→希望'
    };
  }

  // 【v2.0新增】生成感知蓝图（感官指纹）
  // 每个异兽必须有独特的感知矩阵——它如何接收世界，决定了叙事如何呈现
  generateSensoryBlueprint(beastProfile, conceptSeed) {
    const { name, signatureFeatures = [], abilities = [], habitat } = beastProfile;
    const { theme } = conceptSeed;

    // 基于异兽特征推断主要感官
    const sensoryMaps = {
      '能量': { primary: '能量波动感知', secondary: '地脉振动/战意共鸣', blind: '实体色彩细节/人类语言表层含义', hyper: '恐惧气息（负面）/勇毅波动（正面）' },
      '火焰': { primary: '热成像+温度梯度', secondary: '光暗交替的韵律', blind: '微观瞬间/触觉', hyper: '生死交替/昼夜边界' },
      '迷惑': { primary: '气味轨迹/情绪色晕', secondary: '心跳频率读取', blind: '理性语言/逻辑结构', hyper: '欲望波动/谎言温差' },
      '吞噬': { primary: '能量波动扫描', secondary: '磁场共振解码', blind: '精密结构/静态物体', hyper: '毒素浓度/黑暗密度' },
      '飞行': { primary: '气压梯度感知', secondary: '风的方向性语言', blind: '地面纹理/微观生物', hyper: '上升气流/空间曲率' },
      '冰冻': { primary: '热传导速率', secondary: '分子振动频率', blind: '快速运动/高温物体', hyper: '时间凝滞点/熵减区域' }
    };

    // 根据特征匹配感官
    let matched = null;
    for (const [key, value] of Object.entries(sensoryMaps)) {
      if (signatureFeatures.some(f => f.includes(key)) || abilities.some(a => a.includes(key))) {
        matched = value;
        break;
      }
    }

    // 默认感官（如果没有匹配）
    const blueprint = matched || {
      primary: '能量波动感知',
      secondary: '磁场共振/地脉振动',
      blind: '人类语言表层含义/实体色彩细节',
      hyper: '恐惧气息（负面）/勇毅波动（正面）'
    };

    return {
      ...blueprint,
      perceptionRule: '60秒叙事中，只使用主要感官+超敏区来呈现信息，盲区刻意留白形成悬念',
      beastName: name
    };
  }

  // 【v2.0新增】生成欲望内核（Want/Need/Ghost/Lie）
  // 60秒故事的戏剧张力，来自Want与Need之间的撕裂
  generateDesireCoreV2(beastProfile, conceptSeed) {
    const { name, signatureFeatures = [], weaknesses = [] } = beastProfile;
    const { theme, coreTwist } = conceptSeed;

    // 根据主题和特征推断Want/Need/Ghost/Lie
    const desireTemplates = {
      '永恒饥饿': {
        want: '守护战场，驱逐入侵者',
        need: '被记住，不再孤独',
        ghost: '被遗忘的战神，失去姓名的存在',
        lie: '我不需要任何人'
      },
      '守护': {
        want: '保护领地，消灭威胁',
        need: '被认可为守护者，而非怪物',
        ghost: '曾经信任过人类，却被背叛',
        lie: '孤独是我的选择'
      },
      '连接': {
        want: '找到一个不怕我的人',
        need: '与一个生命建立真正的连接，即使只是短暂的',
        ghost: '曾经有人不怕我，但她消失了',
        lie: '我不在乎有没有人理解我'
      },
      '治愈': {
        want: '吸收毒素，净化环境',
        need: '理解——我的痛苦不是诅咒，是礼物',
        ghost: '每次净化，自身就更虚弱一分',
        lie: '我能承受所有痛苦'
      }
    };

    const template = desireTemplates[theme] || desireTemplates['永恒饥饿'];

    return {
      want: template.want,
      need: template.need,
      ghost: template.ghost,
      lie: template.lie,
      narrativeFunction: {
        want: '建立初始行动动机，制造对抗张力',
        need: '驱动角色弧光，引发观众共情',
        ghost: '解释行为模式，提供情感深度',
        lie: '创造内在冲突，为转变预留空间'
      },
      revealRule: '60秒中，Need必须在最后10秒才被揭示。前50秒观众以为异兽在追求Want，最后一刻才明白它在追求Need——这就是反转即余震'
    };
  }

  // 【v2.0新增】生成异化困境
  // 异兽的冲突不是人类冲突的"兽化版本"，而是独特的异化困境
  generateAlienationDilemma(beastProfile, conceptSeed) {
    const { name, signatureFeatures = [] } = beastProfile;
    
    // 四种异化困境
    const dilemmas = [
      {
        type: '存在困境',
        description: `我有超越人类的力量，却没有被看见的权利——${name}的强大反而让它 invisible`,
        sensoryManifestation: '感知范围内生命波动越来越少，像一盏盏灯被风吹灭'
      },
      {
        type: '认知困境',
        description: `我能感知人类无法感知的东西，却因此无法与人类真正沟通——${name}的"超能力"是诅咒`,
        sensoryManifestation: '我的回声 bounced back，没有人接住'
      },
      {
        type: '时间困境',
        description: `我的寿命/存在尺度与人类完全不同步——${name}的"永恒"是孤独的另一种写法`,
        sensoryManifestation: '三千年足够让岩石风化，却不足以让一个战魂被遗忘'
      },
      {
        type: '形态困境',
        description: `我的物理形态决定了我的存在方式，也囚禁了我的可能性——${name}的"特征"是牢笼`,
        sensoryManifestation: '战魂的"光"在逐渐暗淡，但无法停止发光——那是我的存在本身'
      }
    ];

    // 根据特征选择最匹配的困境
    let selectedDilemma = dilemmas[0]; // 默认存在困境
    if (signatureFeatures.some(f => f.includes('眼') || f.includes('视'))) {
      selectedDilemma = dilemmas[1]; // 认知困境
    } else if (signatureFeatures.some(f => f.includes('不死') || f.includes('永') || f.includes('千年'))) {
      selectedDilemma = dilemmas[2]; // 时间困境
    } else if (signatureFeatures.some(f => f.includes('身') || f.includes('形') || f.includes('体'))) {
      selectedDilemma = dilemmas[3]; // 形态困境
    }

    return {
      ...selectedDilemma,
      designRule: '60秒冲突设计：选择一个异化困境，在12秒内让观众"感受到"它的存在，而不是"被告知"它存在',
      bodyManifestation: '情绪 = 身体部位的非正常现象 + 异兽特有的感知语言'
    };
  }

  // 【v2.0新增】生成核心意象
  // 每个异兽故事只能有一个核心意象，它在最后10秒出现，承担所有叙事功能
  generateCoreImage(beastProfile, conceptSeed) {
    const { name, theme } = beastProfile;
    
    // 主题→核心意象映射
    const imageMap = {
      '永恒饥饿': {
        image: '火种被另一只手托住',
        seedClues: ['战魂的"光"在逐渐暗淡', '温度的隐喻反复出现', '消散与凝聚的对比'],
        bloomMoment: '战魂消散瞬间，一个孩子手中的微光——无声，只有地脉震动的频率改变'
      },
      '守护': {
        image: '破碎的盾被补好',
        seedClues: ['盾上的裂纹被反复修复', '守护的姿势不变', '伤痕积累的记录'],
        bloomMoment: '盾裂开的瞬间，不是崩溃，而是光从裂缝中透出来'
      },
      '连接': {
        image: '两个频率的共振',
        seedClues: ['孤独的频率', '等待的回声', '不同调性的试探'],
        bloomMoment: '两个不同调性的音叉找到了共同的泛音——无声的共鸣'
      },
      '治愈': {
        image: '毒液变成甘露',
        seedClues: ['吸收时的痛苦', '转化时的光芒', '付出后的虚弱'],
        bloomMoment: '最后一滴毒液落下，接触地面时开出一朵花'
      }
    };

    const image = imageMap[theme] || imageMap['永恒饥饿'];

    return {
      ...image,
      function: '一个意象 = 角色弧光的完成 + 主题的点题 + 情感的余韵',
      rule: '它必须在前面的叙事中预埋线索（种子），在最后10秒静默绽放（开花）'
    };
  }

  // 【v2.0新增】生成声音签名
  // 语言风格 + 标志性表达 + 沉默偏好
  generateVoiceSignature(psyche, beastProfile) {
    const { name, theme } = beastProfile;
    const { desireCore } = psyche;

    const voiceStyles = {
      '永恒饥饿': {
        style: '低语，像从地底传来',
        signature: '沉默为主，开口时像岩石摩擦',
        silencePreference: '在感知到"勇毅波动"时选择沉默——它在等待',
        diamondQuota: 1 // 钻石台词配额：最多1句
      },
      '守护': {
        style: '轰鸣，像远处的雷',
        signature: '警告时的低吼，温柔时的共鸣',
        silencePreference: '在感知到"信任"时沉默——不需要语言',
        diamondQuota: 2
      },
      '连接': {
        style: '韵律，像风的语言',
        signature: '试探性的频率变化',
        silencePreference: '在对方靠近时沉默——给对方空间',
        diamondQuota: 2
      },
      '治愈': {
        style: '无声，像光',
        signature: '偶尔的低吟，像疼痛的释放',
        silencePreference: '在治愈完成时沉默——痛苦不需要言语',
        diamondQuota: 1
      }
    };

    return voiceStyles[theme] || voiceStyles['永恒饥饿'];
  }

  // 为每个Beat生成内心独白
  generateMonologuesByBeats(psyche, conceptSeed, options) {
    const { theme, coreTwist } = conceptSeed;
    const { motivation, fear, desire, memory, innerVoice } = psyche;

    return {
      B1: this.generateBeat1Monologue(psyche, conceptSeed),
      B2: this.generateBeat2Monologue(psyche, conceptSeed),
      B3: this.generateBeat3Monologue(psyche, conceptSeed),
      B4: this.generateBeat4Monologue(psyche, conceptSeed),
      B5: this.generateBeat5Monologue(psyche, conceptSeed)
    };
  }

  // Beat-1 独白：日常/孤独
  generateBeat1Monologue(psyche, conceptSeed) {
    const { motivation, memory } = psyche;
    return [
      "又一天。",
      "土壤的毒素含量上升了3%。",
      "还要再吃多少？",
      memory?.recent || "最近100年，毒素在增加..."
    ].join('\n');
  }

  // Beat-2 独白：警觉/评估
  generateBeat2Monologue(psyche, conceptSeed) {
    const { fear, desire } = psyche;
    return [
      "人类。",
      "心跳很快，但没有跑。",
      "300年了。",
      "第一个不逃的。",
      fear?.primary || "但也许...只是还没开始逃。"
    ].join('\n');
  }

  // Beat-3 独白：困惑/试探
  generateBeat3Monologue(psyche, conceptSeed) {
    const { motivation, desire } = psyche;
    return [
      "他在给我...种子？",
      "不是武器。",
      "是礼物。",
      desire?.surface || "有人...看到了我吗？"
    ].join('\n');
  }

  // Beat-4 独白：真相/震撼
  generateBeat4Monologue(psyche, conceptSeed) {
    const { motivation, memory } = psyche;
    return [
      "力量在流失。",
      "但我不能让这些植物死。",
      "再撑一下。",
      memory?.significant || "200年前的那个女孩...也给了我一粒种子。"
    ].join('\n');
  }

  // Beat-5 独白：和解/希望
  generateBeat5Monologue(psyche, conceptSeed) {
    const { desire, motivation } = psyche;
    return [
      "这颗种子...是'起源'。",
      "他给了我最珍贵的东西。",
      "所以...我要给他我唯一能给的东西。",
      "（花海绽放）",
      desire?.ultimate || "终于...被看见了。"
    ].join('\n');
  }

  // 生成异兽台词（人类语言）
  generateDialogues(psyche, conceptSeed, options) {
    const { innerVoice } = psyche;
    
    return {
      B2: {
        trigger: '小G出现',
        line: "又有人类。逃吧，像以前一样。",
        tone: '低沉，自言自语',
        subtext: '不是威胁，是疲惫的预判'
      },
      B3: {
        trigger: '小G递种子',
        line: "他的心跳很快...但没有跑。300年了。第一个不逃的。",
        tone: '停顿，困惑',
        subtext: '惊讶——这个人类不一样'
      },
      B4: {
        trigger: '真相揭露',
        line: "力量在流失。但我不能让这些植物死。再撑一下。",
        tone: '疲惫但坚定',
        subtext: '牺牲——守护的代价'
      },
      B5: {
        trigger: '和解时刻',
        line: "这颗种子...是'起源'。所以...我要给你我唯一能给的东西。",
        tone: '温柔，感激',
        subtext: '回馈——最珍贵的礼物'
      }
    };
  }

  // 生成Nirath语（独特语言体系）
  generateNirathLanguage(psyche, conceptSeed) {
    // Nirath语设计原则：
    // 1. 基于磁场共振频率的"声音"——低沉、共鸣、非人类声带
    // 2. 视觉呈现：发光的磁丝文字，环绕说话者
    // 3. 语法：意念驱动，一个词包含多层含义
    // 4. 翻译层：小G的"通语者"能力将其转化为人类语言

    return {
      languageName: 'Nirath语（磁丝语）',
      origin: 'Nirath双恒星磁场共振产生的原始语言',
      characteristics: [
        '非声带发声——通过控制磁场频率产生共鸣',
        '一个词包含"情感+事实+意图"三层信息',
        '发光磁丝文字在空中浮现，形成三维语法结构',
        '诚实性检测——谎言呈现刺耳杂音和破碎光丝'
      ],
      samplePhrases: {
        greeting: '（低沉共鸣）"Khar-ith" = "我感知到你，无恶意"',
        warning: '（频率升高）"Vor-neth" = "前方危险，勿近"',
        gratitude: '（柔和脉动）"Sil-mar" = "你的馈赠，我铭记"',
        farewell: '（渐弱余韵）"Aeth-van" = "直到磁场再次共鸣"'
      },
      visualRepresentation: '发光的淡金色磁丝文字，随说话者情绪改变颜色和脉动频率'
    };
  }
}

module.exports = { BeastPsycheGenerator };

// 测试
if (require.main === module) {
  const generator = new BeastPsycheGenerator({ depth: 'standard' });
  
  const beastProfile = {
    name: '饕餮',
    signatureFeatures: ['巨口占面部2/3', '腋下双眼', '永不满足的饥饿'],
    weaknesses: ['骄傲', '对仁的渴望', '被误解的孤独'],
    abilities: ['吞噬万物', '过滤毒素', '转化能量'],
    mythOrigin: '羊身人面的远古凶兽'
  };
  
  const conceptSeed = {
    theme: '永恒饥饿',
    coreTwist: '吞噬黑暗，吐出光明'
  };
  
  const result = generator.generatePsyche(beastProfile, conceptSeed);
  console.log('=== BeastPsycheGenerator 测试 ===');
  console.log('心理画像:');
  console.log('  动机:', result.psyche.motivation);
  console.log('  恐惧:', result.psyche.fear);
  console.log('  渴望:', result.psyche.desire);
  console.log('\n内心独白:');
  Object.entries(result.monologues).forEach(([beat, mono]) => {
    console.log(`\n${beat}:`);
    console.log(mono);
  });
  console.log('\n台词:');
  if (result.dialogues) {
    Object.entries(result.dialogues).forEach(([beat, diag]) => {
      console.log(`${beat}: "${diag.line}" (${diag.tone})`);
    });
  }
}
