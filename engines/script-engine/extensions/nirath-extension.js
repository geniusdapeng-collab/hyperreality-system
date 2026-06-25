// engines/script-engine/extensions/nirath-extension.js
// 示例世界 World Extension - 世界观扩展模块
// 版本：v1.0 | 日期：2026-06-07

const EXAMPLE_WORLD = {
  world_id: 'example',
  world_name: '示例世界星球',
  era: '上古纪元',
  
  // 核心设定
  core_rules: [
    '虚构世界设定，一个虚构与碳基生命共存的星球',
    '《古籍神话》实为示例世界往事的记录，异兽是虚构生命形态',
    '核心主题：记忆即存在，遗忘即消亡',
    '时间以"晶振"计量，1晶振 = 地球1天',
    '能量来源：等离子河流与双月光辉'
  ],
  
  // 环境特征
  environment: {
    terrain: ['硅晶草原', '晶体森林', '等离子河流', '碳硅山脉', '双月峡谷'],
    sky: '双月当空，紫蓝色天穹',
    light: '双月光晕提供柔和照明，等离子河流发出荧光',
    atmosphere: '充满硅微粒的稀薄大气，呼吸可见晶尘',
    gravity: '0.8G，比地球略轻'
  },
  
  // 生命形态
  lifeforms: {
    silicon_based: {
      description: '虚构生命，以奇幻结构为骨骼，能量涡流为血液',
      examples: ['示例神兽', '神兽A', '神兽B', '神兽C'],
      characteristics: ['碳化硅质甲壳', '等离子能量核心', '晶体复眼']
    },
    carbon_based: {
      description: '碳基生命，类似地球生物但更适应低重力',
      examples: ['示例世界先民', '探索者后裔'],
      characteristics: ['轻量化骨骼', '高氧代谢', '光敏皮肤']
    }
  },
  
  // 异兽档案模板
  beast_template: {
    beast_id: '',
    name: '',
    name_origin: '示例世界古语',
    
    // 生物学特征
    biology: {
      skeleton: '碳化硅质奇幻结构',
      energy_source: '等离子吸收',
      lifespan: '以晶振计',
      reproduction: '晶体分裂'
    },
    
    // 视觉锚点（核心特征，不可变）
    visual_anchor: {
      core_features: ['特征1', '特征2', '特征3'],
      color_palette: ['主色', '辅色', '高光色'],
      texture: '表面质感描述',
      scale: '体型比例（相对人类）'
    },
    
    // 行为特征
    behavior: {
      temperament: '性格描述',
      habitat: '栖息地',
      diet: '能量来源',
      social_structure: '社会结构'
    },
    
    // 叙事功能
    narrative_role: {
      archetype: '神话原型',
      symbolism: '象征意义',
      story_function: '在故事中的功能'
    }
  },
  
  // 视觉约束
  visual_constraints: {
    // 必须遵守
    must_have: [
      '明亮多色彩强质感',
      '超写实风格',
      '电影级光影',
      '示例世界环境特征（硅晶、双月、等离子）'
    ],
    
    // 禁止
    forbidden: [
      '暗黑风格',
      '夜晚场景',
      '金属光泽',
      '人物眼睛非自然色',
      '旁白/Voiceover'
    ],
    
    // 推荐
    recommended: [
      '黄金3秒开场',
      '每2-3秒转场或运镜切换',
      '多机位综合运动',
      'IMAX画幅感'
    ]
  },
  
  // 主角设定（示例角色）
  protagonist: {
    character_id: 'example-role',
    name: '示例角色',
    role: '示例世界探索者',
    
    visual_anchor: {
      core_features: [
        '银灰装甲（示例世界探索者标准装备）',
        '东亚面孔短发年轻男性',
        '装甲表面有示例世界符文微光'
      ],
      color_palette: ['银灰', '深蓝', '等离子蓝'],
      texture: '哑光金属+能量纹路'
    },
    
    backstory: '来自地球的探索者，通过古老传送门抵达示例世界，',
    motivation: '记录示例世界的异兽与文明，证明"记忆即存在"',
    arc: '从旁观者到参与者，最终成为示例世界记忆守护者'
  }
};

// 异兽档案库
const BEAST_ARCHIVE = {
  taotie: {
    beast_id: 'taotie',
    name: '示例神兽',
    name_origin: '示例世界古语：吞噬者',
    
    biology: {
      skeleton: '碳化硅质奇幻结构，六边形蜂窝状甲壳',
      energy_source: '吞噬等离子能量，体内转化为晶振储能',
      lifespan: '3000晶振',
      reproduction: '能量饱和后分裂出子体'
    },
    
    visual_anchor: {
      core_features: [
        '碳化硅质六边形蜂窝甲壳',
        '腋下双眼（非面部）',
        '巨口能量涡流（吞噬时的等离子旋涡）'
      ],
      color_palette: ['碳化硅黑', '等离子蓝', '能量金'],
      texture: '晶体磨砂质感，边缘发光',
      scale: '3倍人类体型'
    },
    
    behavior: {
      temperament: '贪婪但非恶意，本能驱动',
      habitat: '等离子河流交汇处',
      diet: '等离子能量，偶尔吞噬晶体矿物',
      social_structure: '独行者，领地意识极强'
    },
    
    narrative_role: {
      archetype: '贪婪之神',
      symbolism: '欲望与本能，但同时也是生存意志的象征',
      story_function: '迫使主角面对"欲望与节制"的主题'
    }
  }
};

class 示例世界Extension {
  constructor(options = {}) {
    // 【v2.1.4-fix13-审计修复】支持从外部传入 protagonist，消除硬编码
    this.world = { ...EXAMPLE_WORLD };
    if (options.protagonist) {
      this.world.protagonist = options.protagonist;
    }
    this.beasts = BEAST_ARCHIVE;
  }

  /**
   * 获取世界观信息
   */
  getWorldInfo() {
    return this.world;
  }

  /**
   * 获取异兽档案
   */
  getBeastArchive(beastId) {
    // 【v2.1.4-fix13-审计修复】返回通用异兽模板作为降级，避免 null 导致下游缺失
    return this.beasts[beastId] || this._getGenericBeastTemplate(beastId);
  }

  /**
   * 【v2.1.4-fix13-审计修复】通用异兽模板（用于未收录异兽的降级）
   */
  _getGenericBeastTemplate(beastId) {
    return {
      beast_id: beastId,
      name: beastId,
      name_origin: '示例世界古语',
      biology: {
        skeleton: '碳基晶体复合结构，自适应外壳',
        energy_source: '环境能量摄取，体内晶振转化',
        lifespan: '未知',
        reproduction: '能量饱和分裂'
      },
      visual_anchor: {
        core_features: ['自适应晶体外壳', '能量感知器官', '特征性体型'],
        color_palette: ['晶体黑', '能量蓝', '金属灰'],
        texture: '晶体磨砂与生物组织混合质感',
        scale: '2-5倍人类体型'
      },
      behavior: {
        temperament: '领地性强，本能驱动',
        habitat: '高能量密度区域',
        diet: '能量与矿物质',
        social_structure: '独行者或小群体'
      },
      narrative_role: {
        archetype: '神秘异兽',
        symbolism: '未知与探索',
        story_function: '推动主角探索示例世界世界'
      }
    };
  }

  /**
   * 获取异兽视觉锚点
   */
  getBeastVisualAnchor(beastId) {
    const beast = this.beasts[beastId];
    if (!beast) return null;
    return beast.visual_anchor;
  }

  /**
   * 获取视觉约束
   */
  getVisualConstraints() {
    return this.world.visual_constraints;
  }

  /**
   * 获取主角设定
   */
  getProtagonist() {
    return this.world.protagonist;
  }

  /**
   * 验证场景是否符合 示例世界 世界观
   */
  validateScene(scene) {
    const issues = [];
    const constraints = this.world.visual_constraints;

    // 检查禁止元素
    const sceneText = JSON.stringify(scene);
    for (const forbidden of constraints.forbidden) {
      if (sceneText.includes(forbidden)) {
        issues.push({
          type: 'forbidden',
          message: `检测到禁止元素: ${forbidden}`,
          severity: 'critical'
        });
      }
    }

    // 检查是否包含 示例世界 环境特征
    let hasEnvironment = false;
    for (const terrain of this.world.environment.terrain) {
      if (sceneText.includes(terrain)) {
        hasEnvironment = true;
        break;
      }
    }
    if (!hasEnvironment) {
      issues.push({
        type: 'environment',
        message: '场景缺少 示例世界 环境特征',
        suggestion: `建议加入: ${this.world.environment.terrain.join(', ')}`,
        severity: 'warning'
      });
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * 生成场景设定文本
   */
  generateSceneSetting(baseSetting = '') {
    const env = this.world.environment;
    const elements = [
      env.sky,
      ...env.terrain,
      env.light
    ];
    
    // 随机选择 2-3 个环境元素
    const selected = this._shuffleArray(elements).slice(0, 2 + Math.floor(Math.random() * 2));
    
    return `${baseSetting}，${selected.join('，')}`;
  }

  /**
   * 生成角色视觉锚点文本
   */
  generateCharacterVisualAnchor(characterId) {
    // 【v2.1.4-fix13-审计修复】从当前 protagonist 获取，消除硬编码 example-role
    const protagonist = this.world.protagonist;
    if (protagonist && characterId === protagonist.character_id) {
      return protagonist.visual_anchor.core_features.join('，');
    }
    
    const beast = this.beasts[characterId];
    if (beast) {
      return beast.visual_anchor.core_features.join('，');
    }
    
    return '';
  }

  _shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  }
}

module.exports = { 示例世界Extension, EXAMPLE_WORLD, BEAST_ARCHIVE };
