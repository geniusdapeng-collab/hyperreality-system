/**
 * 全局负面提示词注入器 v2.0 — 三级约束体系
 * 
 * 升级内容（v6.2-patch59）：
 * - 引入L1/L2/L3三级负面约束体系
 * - L1: 全局硬约束（所有镜头，不可覆盖）
 * - L2: 类型约束（按情绪阶段分类）
 * - L3: 镜头专属约束（由调用方注入特定风险）
 * 
 * @module global-negative-prompts
 * @version 2.0
 */

class GlobalNegativePromptInjector {
  constructor() {
    // ========== L1: 全局硬约束（所有镜头，不可覆盖）==========
    this.l1Constraints = {
      // L1.1: 角色一致性（最高优先级，任何情况下不可裁剪）
      characterConsistency: {
        priority: 'L1',
        description: '角色数量与外观一致性',
        constraints: [
          // 眼睛颜色 — 队长全局铁律：禁止任何非自然眼色
          '禁止眼睛出现红色、蓝色、黄色、绿色、紫色、橙色、荧光色、发光色等非自然颜色',
          '禁止红眼、蓝瞳、金瞳、绿眼、紫眼、荧光眼、发光眼、火光眼、霓虹眼',
          '眼睛必须是人眼自然黑色瞳孔，仅允许对面景物倒影在眼中',
          // 角色数量
          '禁止画面中出现重复角色',
          '禁止画面中出现多个相同角色',
          '画面中每个角色只能出现一次',
          // 角色一致性
          '禁止角色外观在不同镜头中不一致',
          '禁止角色服装、发型、眼睛在镜头间发生变化'
        ]
      },

      // L1.2: 材质与风格禁忌
      materialAndStyle: {
        priority: 'L1',
        description: '材质与视觉风格禁忌',
        constraints: [
          // 水晶 — 全局禁用（队长明确禁止）
          '禁止出现水晶、水晶矿脉、水晶柱、水晶簇',
          '禁止出现透明晶体、六棱柱晶体、石英晶体',
          // 金属光泽 — 全局禁用（队长明确禁止）
          '禁止出现强烈金属光泽、镜面金属反光、金属质感',
          '禁止出现金属盔甲、金属铠甲、金属鳞片（除非是生物自然特征）',
          // 卡通/动漫
          '禁止卡通风格、动漫风格、二次元风格、Q版、萌系',
          '禁止3D渲染感、CG动画感、游戏UI元素',
          // 地球模板
          '禁止地球标准蓝天、地球标准绿草、地球标准白云',
          '禁止标准地球自然景观（除非剧情需要）',
          // v6.2-patch45-fix: 禁止光秃秃/荒芜/火星地貌
          '禁止光秃秃地貌、荒芜无生机、寸草不生、不毛之地',
          '禁止戈壁滩、黄土高原、火星表面、月球表面、荒漠景观',
          '禁止死寂环境、无生物区域、无植物覆盖、纯岩石裸露',
          // v6.5.35: 人物质感负面提示（基于外部专家方案）
          '禁止塑料皮肤、过度磨皮、陶瓷肌、娃娃脸',
          '禁止不自然的姿势、漂浮的身体、机械动作',
          '禁止空洞的表情、死鱼眼、无神状态',
          '禁止干净无菌的背景、平光、无阴影',
          '禁止过度曝光、颜色过淡、 washed out colors',
          '禁止多余的手指、变形的手、模糊的脸'
        ]
      },

      // L1.3: 光照与氛围底线
      lightingAndAtmosphere: {
        priority: 'L1',
        description: '光照与氛围底线',
        constraints: [
          '禁止纯黑死黑、暗黑压抑、哥特阴郁、灰暗沉闷、乌漆嘛黑',
          '禁止夜晚场景、夜间环境、黑暗背景、深夜氛围、暗夜风格',
          '禁止无来源发光、无介质光线、悬浮光球',
          '禁止过度粒子特效、魔法光芒、能量波动',
          '禁止发光文字、霓虹文字、荧光文字'
        ]
      },

      // L1.4: 画面文字
      textAndUI: {
        priority: 'L1',
        description: '画面文字禁忌',
        constraints: [
          '禁止小字清晰可辨、印刷工整、字迹清晰',
          '禁止详细文字说明、大量文字、文字密集',
          '禁止画面中出现具体可读的文字内容（标题除外）',
          // v6.6.8-patch4-fix: 科普视频全局文字禁令
          '禁止任何文字、字母、数字、符号出现在画面任何位置',
          '禁止屏幕、海报、纸张、标牌、书籍、文件上出现文字',
          '禁止信息图表中出现可读文字，仅允许纯图形图示',
          '禁止标签、铭牌、标语、指示牌上的文字内容'
        ]
      }
    };

    // ========== L2: 类型约束（按情绪阶段分类）==========
    this.l2Constraints = {
      // L2.1: establishing阶段约束（建立/开场）
      establishing: {
        priority: 'L2',
        description: 'establishing阶段专用约束',
        constraints: [
          '禁止画面主体过小不可辨认',
          '禁止开场就切入特写（需要先有环境建立）',
          '禁止缺乏环境上下文的孤立主体'
        ]
      },

      // L2.2: rising阶段约束（上升/紧张）
      rising: {
        priority: 'L2',
        description: 'rising阶段专用约束',
        constraints: [
          '禁止角色表情过于轻松愉悦（与紧张氛围矛盾）',
          '禁止明亮欢快的配色（与rising情绪冲突）',
          '禁止微笑、大笑、嬉戏等放松动作'
        ]
      },

      // L2.3: building阶段约束（积累/蓄势）
      building: {
        priority: 'L2',
        description: 'building阶段专用约束',
        constraints: [
          '禁止过早揭示核心反转（保留悬念）',
          '禁止情绪释放过早（需要持续蓄力）',
          '禁止画面过于平静无张力'
        ]
      },

      // L2.4: climax阶段约束（高潮）
      climax: {
        priority: 'L2',
        description: 'climax阶段专用约束',
        constraints: [
          '禁止情绪强度不足（高潮必须情绪饱满）',
          '禁止运镜过于保守平淡',
          '禁止核心视觉焦点模糊或被遮挡'
        ]
      },

      // L2.5: resolve阶段约束（解决/释然）
      resolve: {
        priority: 'L2',
        description: 'resolve阶段专用约束',
        constraints: [
          '禁止情绪突兀转变（需要自然过渡）',
          '禁止重新引入新的紧张元素（已解决）',
          '禁止画面过于复杂分散注意力（需要聚焦温情时刻）'
        ]
      }
    };

    // ========== L3: 镜头专属约束（由调用方注入）==========
    // L3约束是动态的，由调用方根据具体镜头风险传入
    this.l3Constraints = {};

    // 快速查找映射（用于检查Prompt是否已包含某类约束）
    this.keywordMap = {
      '眼睛颜色': ['红眼', '蓝眼', '黄眼', '绿眼', '紫眼', '橙眼', '荧光眼', '发光眼'],
      '水晶': ['水晶', '晶体', '石英'],
      '金属光泽': ['金属光泽', '金属反光', '镜面金属'],
      '卡通': ['卡通', '动漫', '二次元', 'Q版'],
      '暗黑': ['暗黑', '哥特', '阴郁', '死黑', '乌漆嘛黑', '夜晚', '夜间', '黑暗背景', '深夜']
    };
  }

  /**
   * v6.2-patch59: 生成三级负面提示词
   * @param {Object} options
   * @param {string} options.level - 'L1' | 'L1+L2' | 'L1+L2+L3' | 'all'
   * @param {string} options.emotionPhase - 情绪阶段（用于L2约束）
   * @param {string[]} options.l3Custom - L3自定义约束数组
   * @param {number} options.maxLength - 最大长度限制（默认400字符）
   * @param {boolean} options.includeCharacterCount - 是否包含角色数量约束
   * @returns {string} 负面提示词字符串
   */
  generate(options = {}) {
    const { 
      level = 'all', 
      emotionPhase = '', 
      l3Custom = [], 
      maxLength = 400, 
      includeCharacterCount = true 
    } = options;

    let constraints = [];

    // ========== L1: 全局硬约束（必须包含）==========
    if (level === 'all' || level.includes('L1')) {
      Object.values(this.l1Constraints).forEach(category => {
        constraints.push(...category.constraints);
      });
    }

    // ========== L2: 类型约束（按情绪阶段）==========
    if ((level === 'all' || level.includes('L2')) && emotionPhase) {
      const l2Category = this.l2Constraints[emotionPhase];
      if (l2Category) {
        constraints.push(...l2Category.constraints);
      }
    }

    // ========== L3: 镜头专属约束（调用方传入）==========
    if ((level === 'all' || level.includes('L3')) && l3Custom.length > 0) {
      constraints.push(...l3Custom);
    }

    // 如果不包含角色数量约束，过滤掉相关条目
    if (!includeCharacterCount) {
      constraints = constraints.filter(c => 
        !c.includes('重复角色') && 
        !c.includes('多个相同角色') && 
        !c.includes('每个角色只能出现一次')
      );
    }

    // 生成负面提示词
    let negativePrompt = '【负面约束】' + constraints.join('；');

    // 字数裁剪策略（从低到高优先级裁剪）
    // 先裁剪L3，再L2，保留L1
    if (negativePrompt.length > maxLength && l3Custom.length > 0) {
      // 移除L3，保留L1+L2
      constraints = [];
      if (level === 'all' || level.includes('L1')) {
        Object.values(this.l1Constraints).forEach(category => {
          constraints.push(...category.constraints);
        });
      }
      if ((level === 'all' || level.includes('L2')) && emotionPhase) {
        const l2Cat = this.l2Constraints[emotionPhase];
        if (l2Cat) constraints.push(...l2Cat.constraints);
      }
      negativePrompt = '【负面约束】' + constraints.join('；');
    }

    if (negativePrompt.length > maxLength) {
      // 移除L2，只保留L1
      constraints = [];
      if (level === 'all' || level.includes('L1')) {
        Object.values(this.l1Constraints).forEach(category => {
          constraints.push(...category.constraints);
        });
      }
      negativePrompt = '【负面约束】' + constraints.join('；');
    }

    if (negativePrompt.length > maxLength) {
      // 只保留L1中的核心约束（角色一致性前3条）
      const coreConstraints = this.l1Constraints.characterConsistency.constraints.slice(0, 3);
      negativePrompt = '【负面约束】' + coreConstraints.join('；');
    }

    return negativePrompt;
  }

  /**
   * v6.2-patch59: 生成L3镜头专属约束模板
   * @param {string} shotType - 镜头类型（如'special_anatomy', 'dialogue', 'action'）
   * @param {Object} specifics - 具体参数
   * @returns {string[]} L3约束字符串数组
   */
  generateL3Template(shotType, specifics = {}) {
    const templates = {
      // 特殊解剖结构镜头（如腋下之眼）
      special_anatomy: (spec) => [
        `禁止${spec.featureName || '特殊结构'}位置偏离${spec.location || '指定区域'}`,
        `禁止${spec.featureName || '特殊结构'}数量不等于${spec.expectedCount || '预期数量'}`,
        `禁止${spec.featureName || '特殊结构'}颜色偏离${spec.expectedColor || '预期颜色'}`,
        ...(spec.additionalConstraints || [])
      ],

      // 对话镜头
      dialogue: (spec) => [
        '禁止角色嘴部不动（必须有口型动作）',
        '禁止说话角色与画面中嘴部动作角色不一致',
        ...(spec.additionalConstraints || [])
      ],

      // 动作镜头
      action: (spec) => [
        '禁止动作幅度过小不可辨认',
        '禁止角色动作与描述不一致',
        ...(spec.additionalConstraints || [])
      ],

      // 默认模板
      default: (spec) => spec.additionalConstraints || []
    };

    const templateFn = templates[shotType] || templates.default;
    return templateFn(specifics);
  }

  /**
   * 检查Prompt是否已包含某类负面约束
   * @param {string} prompt - 待检查的Prompt
   * @param {string} category - 约束类别（如'眼睛颜色'、'水晶'）
   * @returns {boolean}
   */
  hasConstraint(prompt, category) {
    const keywords = this.keywordMap[category];
    if (!keywords) return false;
    return keywords.some(kw => prompt.includes(kw));
  }

  /**
   * 智能注入：检查Prompt是否缺少某类约束，如果缺少则注入
   * @param {string} prompt - 原始Prompt
   * @param {Object} options - 同generate()
   * @returns {string} - 注入后的Prompt
   */
  injectIfMissing(prompt, options = {}) {
    // 如果Prompt已经包含足够的负面约束，不再注入
    const hasEyeConstraint = this.hasConstraint(prompt, '眼睛颜色');

    if (hasEyeConstraint) {
      // 已有眼睛颜色约束，注入轻量级版本
      const lightVersion = this.generate({ ...options, level: 'L1' });
      return prompt + '\n' + lightVersion;
    } else {
      // 缺少核心约束，注入完整版本
      const fullVersion = this.generate(options);
      return prompt + '\n' + fullVersion;
    }
  }


  /**
   * v6.5.33-methodology: 生成紧凑负面提示词（6层方法论体系）
   * 基于《AI视频生成提示词工程方法论》8.1负面提示词分层体系
   * @param {Object} options
   * @param {string} options.sceneType - 场景类型(nature_epic/character_narrative/product/urban/scifi/documentary/abstract)
   * @param {boolean} options.hasCharacter - 是否包含人物
   * @param {boolean} options.isRealistic - 是否写实风格
   * @param {number} options.maxLength - 最大长度（默认180字符）
   * @returns {string} 紧凑负面提示词
   */
  generateCompact(options = {}) {
    const { 
      sceneType = 'nature_epic', 
      hasCharacter = true, 
      isRealistic = true,
      maxLength = 180 
    } = options;

    // 6层负面提示词体系（方法论8.1）
    const layers = {
      // L1: 基础质量层（通用必加）
      baseQuality: [
        'no blurry', 'no low resolution', 'no pixelated', 'no compression artifacts',
        'no noise', 'no flickering', 'no jitter', 'no stutter', 'no choppy motion'
      ],
      // L2: 风格排除层（写实类必加）
      styleExclusion: isRealistic ? [
        'no cartoon', 'no anime', 'no illustration', 'no 3D render look', 'no CGI appearance',
        'no plastic look', 'no artificial', 'no synthetic', 'no digital art', 'no painting'
      ] : [],
      // L3: 结构排除层
      structureExclusion: [
        'no distorted perspective', 'no impossible geometry', 'no floating objects',
        'no inconsistent scale', 'no duplicate elements', 'no watermark', 'no text', 'no logo'
      ],
      // L4: 光影排除层
      lightingExclusion: [
        'no flat lighting', 'no overexposed', 'no crushed blacks', 'no double shadows',
        'no wrong light direction', 'no neon colors'
      ],
      // L5: 人物专项（含人物时必加）
      characterExclusion: hasCharacter ? [
        'no distorted face', 'no deformed face', 'no asymmetrical eyes', 'no extra fingers',
        'no missing fingers', 'no fused fingers', 'no deformed hands', 'no plastic skin',
        'no waxy skin', 'no unnatural pose', 'no impossible anatomy'
      ] : [],
      // L6: 物理排除层（写实自然场景）
      physicsExclusion: (sceneType === 'nature_epic' || sceneType === 'documentary') ? [
        'no fake water', 'no static water', 'no cardboard rocks', 'no plastic foliage',
        'no fake clouds', 'no painted background', 'no missing shadows'
      ] : []
    };

    // 根据场景类型调整权重
    const sceneWeights = {
      nature_epic: { baseQuality: 1, styleExclusion: 1, structureExclusion: 1, lightingExclusion: 1, characterExclusion: 0.5, physicsExclusion: 1 },
      character_narrative: { baseQuality: 1, styleExclusion: 1, structureExclusion: 0.8, lightingExclusion: 1, characterExclusion: 1, physicsExclusion: 0.3 },
      product: { baseQuality: 1, styleExclusion: 1, structureExclusion: 0.8, lightingExclusion: 0.8, characterExclusion: 0, physicsExclusion: 0.3 },
      urban: { baseQuality: 1, styleExclusion: 1, structureExclusion: 1, lightingExclusion: 0.8, characterExclusion: 0.5, physicsExclusion: 0.5 },
      scifi: { baseQuality: 1, styleExclusion: 0.8, structureExclusion: 1, lightingExclusion: 0.8, characterExclusion: 0.5, physicsExclusion: 0.5 },
      documentary: { baseQuality: 1, styleExclusion: 1, structureExclusion: 0.8, lightingExclusion: 0.8, characterExclusion: 1, physicsExclusion: 1 },
      abstract: { baseQuality: 1, styleExclusion: 0.5, structureExclusion: 0.5, lightingExclusion: 0.5, characterExclusion: 0, physicsExclusion: 0.3 }
    };

    const weights = sceneWeights[sceneType] || sceneWeights.nature_epic;

    // 按权重组装
    let compact = [];
    Object.keys(layers).forEach(layer => {
      if (weights[layer] > 0 && layers[layer].length > 0) {
        // 根据权重决定取多少条
        const count = Math.max(2, Math.ceil(layers[layer].length * weights[layer]));
        compact.push(...layers[layer].slice(0, count));
      }
    });

    // 去重
    compact = [...new Set(compact)];

    let result = compact.join(', ');

    // 长度控制：如果超出，从后往前裁剪低优先级层
    if (result.length > maxLength) {
      // 保留核心层（L1+L3）
      const core = [...layers.baseQuality, ...layers.structureExclusion];
      result = core.join(', ');
    }

    if (result.length > maxLength) {
      // 极端情况：只保留最核心的
      result = 'no blurry, no cartoon, no deformed hands, no extra fingers, no watermark, no text';
    }

    return `【负面约束】${result}`;
  }

  /**
   * v6.2-patch59: 向后兼容——保留旧版API
   * @param {Object} options - 旧版选项
   * @returns {string}
   */
  generateLegacy(options = {}) {
    const { priority = 'all', maxLength = 300, includeCharacterCount = true } = options;
    
    // 将旧版priority映射到新版level
    let level = 'all';
    if (priority === 'P0') level = 'L1';
    else if (priority === 'P0+P1') level = 'L1';
    else if (priority === 'P0+P1+P2') level = 'L1+L2';
    
    return this.generate({ level, maxLength, includeCharacterCount });
  }

  /**
   * v6.6.10-fix: 生成片头镜头专用负面提示词
   * @param {Object} options
   * @param {number} options.maxLength - 最大长度
   * @returns {string} 负面提示词
   */
  generateForOpeningShot(options = {}) {
    const { maxLength = 250 } = options;
    // 片头镜头使用L1全局约束 + 更严格的画面文字约束
    return this.generate({ level: 'L1', maxLength, includeCharacterCount: true });
  }

  /**
   * v6.6.10-fix: 生成内容镜头专用负面提示词
   * @param {Object} options
   * @param {number} options.maxLength - 最大长度
   * @returns {string} 负面提示词
   */
  generateForContentShot(options = {}) {
    const { maxLength = 300 } = options;
    // 内容镜头使用完整L1约束
    return this.generate({ level: 'L1', maxLength, includeCharacterCount: true });
  }
}

module.exports = { GlobalNegativePromptInjector, globalNegativePromptInjector: new GlobalNegativePromptInjector() };
