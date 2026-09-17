'use strict';

/**
 * 主题类型配置模块 —— 【v2.1.11 已降级为预设模板库】
 * 
 * 警告：此文件不再驱动生产决策。所有生产决策已迁移至 production-profile.js。
 * 本文件保留目的：
 * 1. 向后兼容（旧代码仍可使用 getType/getContentSafety 等方法）
 * 2. 提供预设类型的默认配置（时长范围、风格等）作为参考模板
 * 3. 开发调试时查看类型定义
 * 
 * 生产链路应优先使用：
 * - 时长 → productionProfile.duration_target
 * - 事实核查 → productionProfile.factual_accuracy (factualConfig 推导)
 * - 写实校验 → productionProfile.visual_register (getRealismForbidden 推导)
 * - 内容安全 → productionProfile.safety_level (safetyConfig 推导)
 * - 台词策略 → productionProfile.dialogue_density (dialogueStrategy 推导)
 */

const ThemeConfig = {
  version: '2.2.0',
  lastUpdated: '2026-06-30',

  // ===== 核心7大类型 =====
  types: {
    // 1. 科普教育
    'EDU': {
      id: 'EDU',
      name: '教育科普',
      nameEn: 'Educational',
      category: 'core',
      defaultStyle: 'REAL',
      defaultDuration: 90,
      durationRange: [60, 120],
      maxScenes: 7,
      maxCharacters: 3,
      maxShots: 7,
      // 校验规则
      validators: ['factCheck', 'disclaimer', 'noPseudoscience', 'sourceRequired'],
      // 内容安全
      contentSafety: {
        level: 'strict',
        factCheck: true,
        disclaimer: '仅供参考，不构成专业建议',
        forbiddenWords: ['水变油', '永动机', '伪科学', '治愈一切']
      },
      // 资源配额
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 0,
        maxShotDuration: 15,
        maxTotalDuration: 180
      },
      // Prompt约束
      promptConstraints: {
        tone: '专业、可信、亲和',
        styleGuide: '写实纪录片风格，避免夸张',
        forbidden: ['夸张', '虚构事实', '伪科学', '绝对化用语']
      },
      // 降级配置
      degradation: {
        maxEffects: 0,
        maxResolution: '2K',
        styleFallback: 'REAL'
      }
    },

    // 2. 纪录片
    'DOC': {
      id: 'DOC',
      name: '纪录片',
      nameEn: 'Documentary',
      category: 'core',
      defaultStyle: 'REAL',
      defaultDuration: 150,
      durationRange: [60, 300],
      maxScenes: 10,
      maxCharacters: 5,
      maxShots: 10,
      validators: ['factCheck', 'disclaimer', 'timelineValid', 'geoValid'],
      contentSafety: {
        level: 'strict',
        factCheck: true,
        disclaimer: '基于现有资料整理',
        forbiddenWords: ['虚构', '编造', '捏造']
      },
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 2,
        maxShotDuration: 15,
        maxTotalDuration: 300
      },
      promptConstraints: {
        tone: '客观、真实、深度',
        styleGuide: '纪实摄影风格，自然光为主',
        forbidden: ['虚构情节', '编造事实', '夸张演绎']
      },
      degradation: {
        maxEffects: 1,
        maxResolution: '2K',
        styleFallback: 'REAL'
      }
    },

    // 3. 家庭聚会
    'FAMILY': {
      id: 'FAMILY',
      name: '家庭聚会',
      nameEn: 'Family Gathering',
      category: 'core',
      defaultStyle: 'WARM',
      defaultDuration: 60,
      durationRange: [30, 90],
      maxScenes: 5,
      maxCharacters: 20,
      maxShots: 5,
      validators: ['photoLimit', 'relationDepth', 'faceCount', 'privacyCheck'],
      contentSafety: {
        level: 'moderate',
        factCheck: false,
        disclaimer: null,
        forbiddenWords: ['暴力', '色情', '虐待']
      },
      resourceQuota: {
        maxResolution: '2K',
        maxEffects: 1,
        maxShotDuration: 15,
        maxTotalDuration: 90
      },
      promptConstraints: {
        tone: '温馨、亲切、自然',
        styleGuide: '温暖柔和，抓拍感',
        forbidden: ['僵硬摆拍', '过度修饰', '冷漠']
      },
      degradation: {
        maxEffects: 0,
        maxResolution: '1080P',
        styleFallback: 'WARM'
      }
    },

    // 4. 商业营销
    'MARKETING': {
      id: 'MARKETING',
      name: '商业营销',
      nameEn: 'Commercial Marketing',
      category: 'core',
      defaultStyle: 'POL',
      defaultDuration: 30,
      durationRange: [15, 60],
      maxScenes: 5,
      maxCharacters: 3,
      maxShots: 5,
      validators: ['brandSafety', 'promoLimit', 'disclaimer', 'noCompetitor', 'adCompliance'],
      contentSafety: {
        level: 'strict',
        factCheck: false,
        disclaimer: '广告',
        forbiddenWords: ['治愈率100%', '绝对有效', '第一', '最好'],
        adRequired: true
      },
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 3,
        maxShotDuration: 15,
        maxTotalDuration: 60
      },
      promptConstraints: {
        tone: '精致、吸引、说服',
        styleGuide: '商业广告质感，高饱和度',
        forbidden: ['竞品名称', '虚假宣传', '夸大功效']
      },
      degradation: {
        maxEffects: 1,
        maxResolution: '2K',
        styleFallback: 'POL'
      }
    },

    // 5. 电影级叙事
    'CINE': {
      id: 'CINE',
      name: '电影级叙事',
      nameEn: 'Cinematic Narrative',
      category: 'core',
      defaultStyle: 'CINE',
      defaultDuration: 150,
      durationRange: [60, 300],
      maxScenes: 15,
      maxCharacters: 10,
      maxShots: 15,
      validators: ['sceneCount', 'emotionNormalize', 'structureValid', 'continuity'],
      contentSafety: {
        level: 'moderate',
        factCheck: false,
        disclaimer: null,
        forbiddenWords: ['色情', '暴力', '歧视']
      },
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 5,
        maxShotDuration: 15,
        maxTotalDuration: 300
      },
      promptConstraints: {
        tone: '戏剧化、沉浸、张力',
        styleGuide: '电影级质感，戏剧性光影',
        forbidden: ['平铺直叙', '单调', '缺乏节奏']
      },
      degradation: {
        maxEffects: 3,
        maxResolution: '2K',
        styleFallback: 'CINE'
      }
    },

    // 6. 艺术级表达
    'ART': {
      id: 'ART',
      name: '艺术级表达',
      nameEn: 'Artistic Expression',
      category: 'core',
      defaultStyle: 'ART',
      defaultDuration: 60,
      durationRange: [30, 120],
      maxScenes: 8,
      maxCharacters: 2,
      maxShots: 8,
      validators: ['styleDesc', 'styleIntensity', 'visualDesc', 'abstractValid'],
      contentSafety: {
        level: 'lenient',
        factCheck: false,
        disclaimer: null,
        forbiddenWords: ['色情', '暴力'],  // 艺术表达更宽松
        artisticTolerance: true
      },
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 8,
        maxShotDuration: 15,
        maxTotalDuration: 120
      },
      promptConstraints: {
        tone: '抽象、诗意、实验',
        styleGuide: '艺术实验风格，非常规构图',
        forbidden: ['俗套', '平庸', '商业化']
      },
      degradation: {
        maxEffects: 4,
        maxResolution: '2K',
        styleFallback: 'ART'
      }
    },

    // 7. 极致特效
    'VFX': {
      id: 'VFX',
      name: '极致特效',
      nameEn: 'Ultimate VFX',
      category: 'core',
      defaultStyle: 'FUT',
      defaultDuration: 30,
      durationRange: [15, 60],
      maxScenes: 5,
      maxCharacters: 3,
      maxShots: 5,
      validators: ['effectWhitelist', 'effectCombo', 'resolutionLimit', 'resourceBudget'],
      contentSafety: {
        level: 'moderate',
        factCheck: false,
        disclaimer: null,
        forbiddenWords: ['癫痫', '光敏']
      },
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 20,
        maxShotDuration: 15,
        maxTotalDuration: 60
      },
      promptConstraints: {
        tone: '震撼、科幻、超现实',
        styleGuide: '科幻未来风格，特效丰富',
        forbidden: ['简陋', '低质量特效', '穿帮']
      },
      degradation: {
        maxEffects: 10,
        maxResolution: '2K',
        styleFallback: 'FUT'
      }
    },

    // ===== 扩展类型 =====
    // 8. 旅行vlog
    'TRAVEL': {
      id: 'TRAVEL',
      name: '旅行vlog',
      nameEn: 'Travel Vlog',
      category: 'extended',
      defaultStyle: 'NAT',
      defaultDuration: 90,
      durationRange: [60, 180],
      maxScenes: 8,
      maxCharacters: 5,
      maxShots: 8,
      validators: ['geoValid', 'photoLimit'],
      contentSafety: {
        level: 'moderate',
        factCheck: false,
        disclaimer: null,
        forbiddenWords: []
      },
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 2,
        maxShotDuration: 15,
        maxTotalDuration: 180
      },
      promptConstraints: {
        tone: '自由、探索、治愈',
        styleGuide: '自然光，手持感',
        forbidden: ['僵硬', '过度商业化']
      },
      degradation: {
        maxEffects: 1,
        maxResolution: '2K',
        styleFallback: 'NAT'
      }
    },

    // 9. 美食
    'FOOD': {
      id: 'FOOD',
      name: '美食',
      nameEn: 'Food',
      category: 'extended',
      defaultStyle: 'WARM',
      defaultDuration: 60,
      durationRange: [30, 120],
      maxScenes: 5,
      maxCharacters: 2,
      maxShots: 5,
      validators: ['foodSafety', 'hygieneCheck'],
      contentSafety: {
        level: 'moderate',
        factCheck: false,
        disclaimer: null,
        forbiddenWords: ['腐烂', '变质']
      },
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 2,
        maxShotDuration: 15,
        maxTotalDuration: 120
      },
      promptConstraints: {
        tone: '诱人、温暖、精致',
        styleGuide: '美食摄影，暖色调',
        forbidden: ['不卫生', '恶心', '廉价']
      },
      degradation: {
        maxEffects: 1,
        maxResolution: '2K',
        styleFallback: 'WARM'
      }
    },

    // 10. 健身/运动
    'FITNESS': {
      id: 'FITNESS',
      name: '健身运动',
      nameEn: 'Fitness',
      category: 'extended',
      defaultStyle: 'VIV',
      defaultDuration: 60,
      durationRange: [30, 120],
      maxScenes: 6,
      maxCharacters: 3,
      maxShots: 6,
      validators: ['safetyWarning', 'actionValid'],
      contentSafety: {
        level: 'moderate',
        factCheck: false,
        disclaimer: '运动有风险，请量力而行',
        forbiddenWords: ['药物', '类固醇']
      },
      resourceQuota: {
        maxResolution: '4K',
        maxEffects: 3,
        maxShotDuration: 15,
        maxTotalDuration: 120
      },
      promptConstraints: {
        tone: '活力、健康、动力',
        styleGuide: '动感，高能量',
        forbidden: ['危险动作', '过度训练']
      },
      degradation: {
        maxEffects: 2,
        maxResolution: '2K',
        styleFallback: 'VIV'
      }
    },

    // 11. 儿童/亲子
    'KIDS': {
      id: 'KIDS',
      name: '儿童亲子',
      nameEn: 'Kids & Parenting',
      category: 'extended',
      defaultStyle: 'FAIRY',
      defaultDuration: 60,
      durationRange: [30, 120],
      maxScenes: 5,
      maxCharacters: 4,
      maxShots: 5,
      validators: ['childSafety', 'ageAppropriate', 'privacyCheck'],
      contentSafety: {
        level: 'strict',
        factCheck: false,
        disclaimer: null,
        forbiddenWords: ['暴力', '恐怖', '色情', '危险'],
        childProtection: true
      },
      resourceQuota: {
        maxResolution: '2K',
        maxEffects: 2,
        maxShotDuration: 10,  // 儿童注意力短
        maxTotalDuration: 120
      },
      promptConstraints: {
        tone: '童趣、温暖、安全',
        styleGuide: '明亮柔和，色彩丰富',
        forbidden: ['恐怖', '暴力', '成人内容']
      },
      degradation: {
        maxEffects: 1,
        maxResolution: '1080P',
        styleFallback: 'FAIRY'
      }
    }
  },

  // ===== 风格编码 =====
  styles: {
    primary: {
      'REAL': { name: '写实纪实', description: '自然光、真实场景、手持感', context: { EDU: '真实可信的纪实风格', default: '写实纪实的真实质感' }},
      'CINE': { name: '电影质感', description: '戏剧性光影、宽画幅、景深', context: { DRAMA: '电影级叙事质感', EDU: '电影级纪录片质感', default: '电影级的戏剧质感' }},
      'POL': { name: '精致商业', description: '高饱和、精致布光、产品特写', context: { ADV: '精致商业广告质感', default: '精致商业的高品质呈现' }},
      'MINI': { name: '极简现代', description: 'clean背景、大留白、几何构图', context: { default: '极简现代的设计美学' }},
      'RET': { name: '复古怀旧', description: '暖色调、胶片颗粒、年代感', context: { default: '复古怀旧的温暖质感' }},
      'FUT': { name: '科幻未来', description: '冷色调、霓虹光、科技感UI', context: { default: '科幻未来的科技美学' }},
      'ART': { name: '艺术实验', description: '非常规构图、抽象视觉、强烈色彩', context: { default: '艺术实验的独特美学' }},
      'WARM': { name: '温暖治愈', description: '柔和光线、暖色调、慢节奏', context: { EDU: '温暖治愈的亲和风格', default: '温暖治愈的情感氛围' }},
      'STREET': { name: '街头潮流', description: '快速剪辑、涂鸦元素、动感运镜', context: { default: '街头潮流的动感风格' }},
      'FAIRY': { name: '梦幻童话', description: '柔光、仙气、超现实元素', context: { default: '梦幻童话的超现实美感' }},
      'NAT': { name: '自然清新', description: '户外、自然光、绿意/蓝天', context: { default: '自然清新的户外风格' }},
      'VIV': { name: '活力动感', description: '高饱和、快节奏、动感音乐', context: { default: '活力动感的运动风格' }}
    },
    secondary: {
      'LUX': { name: '奢华感', effect: '金色/暗调、高级质感、慢镜头' },
      'VIV': { name: '活力感', effect: '高饱和、快节奏、动感音乐' },
      'EMO': { name: '情绪感', effect: '低饱和、慢节奏、叙事性强' },
      'NAT': { name: '自然感', effect: '户外、自然光、绿意/蓝天' },
      'GRI': { name: '粗粝感', effect: '高对比、暗部细节、纪实感' },
      'SWE': { name: '甜美感', effect: '粉色/马卡龙、柔光、可爱元素' },
      'DAR': { name: '暗黑感', effect: '低key布光、阴影、神秘氛围' },
      'NOS': { name: '怀旧感', effect: '胶片色、颗粒、老电视效果' }
    }
  },

  // ===== 主题类型映射（兼容旧系统） =====
  legacyMapping: {
    'EDU': 'EDU',
    'DOC': 'DOC',
    'ADV': 'MARKETING',
    'DRAMA': 'CINE',
    'VLOG': 'TRAVEL',
    'SOC': 'MARKETING',
    'COR': 'MARKETING',
    'EVT': 'DOC',
    'MV': 'ART'
  },

  // ===== 降级矩阵 =====
  degradationMatrix: {
    default: {
      maxEffects: 2,
      maxResolution: '2K',
      styleFallback: 'REAL'
    }
  },

  // ===== 工具方法 =====
  
  /**
   * 获取主题类型配置
   */
  getType(typeId) {
    if (!typeId) return null;
    // 尝试直接匹配
    let config = this.types[typeId.toUpperCase()];
    // 尝试legacy映射
    if (!config && this.legacyMapping[typeId.toUpperCase()]) {
      config = this.types[this.legacyMapping[typeId.toUpperCase()]];
    }
    return config || null;
  },

  /**
   * 获取风格配置
   */
  getStyle(styleCode, videoType = 'default') {
    const style = this.styles.primary[styleCode];
    if (!style) return null;
    const ctx = style.context[videoType] || style.context.default;
    return {
      ...style,
      expanded: `${style.name}风格,${ctx},${style.description}`
    };
  },

  /**
   * 获取所有核心类型
   */
  getCoreTypes() {
    return Object.values(this.types).filter(t => t.category === 'core');
  },

  /**
   * 获取所有扩展类型
   */
  getExtendedTypes() {
    return Object.values(this.types).filter(t => t.category === 'extended');
  },

  /**
   * 获取所有类型ID
   */
  getAllTypeIds() {
    return Object.keys(this.types);
  },

  /**
   * 验证主题类型是否有效
   */
  isValidType(typeId) {
    return !!this.getType(typeId);
  },

  /**
   * 获取类型默认时长
   */
  getDefaultDuration(typeId) {
    const config = this.getType(typeId);
    return config ? config.defaultDuration : 90;
  },

  /**
   * 获取类型时长范围
   */
  getDurationRange(typeId) {
    const config = this.getType(typeId);
    return config ? config.durationRange : [15, 180];
  },

  /**
   * 获取资源配额
   */
  getResourceQuota(typeId) {
    const config = this.getType(typeId);
    return config ? config.resourceQuota : this.types.EDU.resourceQuota;
  },

  /**
   * 获取内容安全配置
   * 【已降级】生产链路请使用 production-profile.js 的 safetyConfig() / factualConfig()
   */
  getContentSafety(typeId) {
    const config = this.getType(typeId);
    return config ? config.contentSafety : { level: 'moderate' };
  },

  /**
   * 获取降级配置
   */
  getDegradationConfig(typeId) {
    const config = this.getType(typeId);
    return config ? config.degradation : this.degradationMatrix.default;
  },

  /**
   * 获取校验器列表
   */
  getValidators(typeId) {
    const config = this.getType(typeId);
    return config ? config.validators : [];
  },

  /**
   * 获取类型名称（中文）
   */
  getTypeName(typeId) {
    const config = this.getType(typeId);
    return config ? config.name : typeId;
  },

  /**
   * 检查资源配额是否超限
   */
  checkResourceQuota(typeId, requested) {
    const quota = this.getResourceQuota(typeId);
    const issues = [];

    if (requested.resolution && this._compareResolution(requested.resolution, quota.maxResolution) > 0) {
      issues.push(`分辨率 ${requested.resolution} 超过限制 ${quota.maxResolution}`);
    }
    if (requested.effects && requested.effects > quota.maxEffects) {
      issues.push(`特效数量 ${requested.effects} 超过限制 ${quota.maxEffects}`);
    }
    if (requested.duration && requested.duration > quota.maxTotalDuration) {
      issues.push(`总时长 ${requested.duration} 超过限制 ${quota.maxTotalDuration}`);
    }
    if (requested.shots && requested.shots > quota.maxShotDuration) {
      issues.push(`镜头数 ${requested.shots} 超过限制`);
    }

    return {
      valid: issues.length === 0,
      issues
    };
  },

  /**
   * 分辨率比较（辅助函数）
   */
  _compareResolution(a, b) {
    const order = { '1080P': 1, '2K': 2, '4K': 3, '8K': 4, '16K': 5 };
    return (order[a] || 0) - (order[b] || 0);
  },

  /**
   * 打印配置摘要
   */
  printSummary() {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║ 主题类型配置摘要 v2.2.0                                       ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    
    const coreTypes = this.getCoreTypes();
    const extTypes = this.getExtendedTypes();
    
    console.log(`║ 核心类型 (${coreTypes.length}个):                                        ║`);
    coreTypes.forEach(t => {
      console.log(`║   ${t.id.padEnd(10)} ${t.name.padEnd(12)} 默认${String(t.defaultDuration).padEnd(4)}s  风格:${t.defaultStyle.padEnd(6)} ║`);
    });
    
    console.log(`║ 扩展类型 (${extTypes.length}个):                                        ║`);
    extTypes.forEach(t => {
      console.log(`║   ${t.id.padEnd(10)} ${t.name.padEnd(12)} 默认${String(t.defaultDuration).padEnd(4)}s  风格:${t.defaultStyle.padEnd(6)} ║`);
    });
    
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  }
};

module.exports = ThemeConfig;

// 自检
if (require.main === module) {
  ThemeConfig.printSummary();
  
  // 验证核心方法
  console.log('[自检] 获取EDU配置:', ThemeConfig.getType('EDU')?.name);
  console.log('[自检] 验证EDU:', ThemeConfig.isValidType('EDU'));
  console.log('[自检] 获取默认时长:', ThemeConfig.getDefaultDuration('EDU'));
  console.log('[自检] 资源配额检查:', ThemeConfig.checkResourceQuota('EDU', { resolution: '8K', effects: 5 }));
  console.log('[自检] Legacy映射 ADV→:', ThemeConfig.getType('ADV')?.id);
}
