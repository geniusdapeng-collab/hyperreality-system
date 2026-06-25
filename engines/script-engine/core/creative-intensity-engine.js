// engines/script-engine/core/creative-intensity-engine.js
// Creative Intensity Engine - 创意指数引擎 (Hyperreality System 适配版)
// 为超现实系统四层架构重新设计的创意指数系统
// 版本: v1.0.0 | 日期: 2026-06-18
// 设计原则: 只影响"怎么拍"，不影响"拍什么"

/**
 * 创意指数解析器
 * 保留 v6.x 核心解析能力，适配超现实系统输入格式
 */
class CreativeIntensityParser {
  constructor(options = {}) {
    this.defaultValue = options.defaultValue || 0.2;
    this.maxValue = options.maxValue || 1.0;
    this.minValue = options.minValue || 0.0;
  }

  /**
   * 主解析入口
   * 支持: 数字直接输入、字符串语义、对象字段、默认回退
   */
  parse(input) {
    // 1. 数字直接输入
    if (typeof input === 'number') {
      return this._clamp(input);
    }

    // 2. 字符串语义解析
    if (typeof input === 'string') {
      const numericMatch = input.match(/(0\.\d+|1\.0?)/);
      if (numericMatch) {
        return this._clamp(parseFloat(numericMatch[1]));
      }
      const semanticValue = this._parseSemantic(input);
      if (semanticValue !== null) {
        return this._clamp(semanticValue);
      }
    }

    // 3. 对象字段解析 (超现实系统 RequirementList 格式)
    if (typeof input === 'object' && input !== null) {
      // 直接字段
      if (typeof input.creativeIntensity === 'number') {
        return this._clamp(input.creativeIntensity);
      }
      if (typeof input.creativeIntensity === 'string') {
        return this.parse(input.creativeIntensity);
      }
      // 同义词兼容
      for (const key of ['creative', 'intensity', 'creativity', '创意', '创意指数']) {
        if (typeof input[key] === 'number') return this._clamp(input[key]);
        if (typeof input[key] === 'string') return this.parse(input[key]);
      }
    }

    // 4. 默认回退
    return this.defaultValue;
  }

  /**
   * 语义映射表 - 与 v6.x 保持一致
   */
  _parseSemantic(text) {
    const semanticMap = {
      // 保守方向 (0.2-0.3)
      '保守': 0.2, '标准': 0.3, '稳': 0.25, '传统': 0.2,
      '正常': 0.2, '默认': 0.2, '基础': 0.25,
      '不要太多创意': 0.3, '稳一点': 0.25, '普通': 0.2,
      '常规': 0.2, '一般': 0.2, '简单': 0.25,

      // 轻度方向 (0.3-0.4)
      '轻度': 0.35, '稍微': 0.35, '一点': 0.35,
      '有点': 0.35, '稍微有': 0.35, '微': 0.3,

      // 中度方向 (0.5-0.6)
      '有点创意': 0.5, '有新意': 0.5, '出彩': 0.6,
      '加点创意': 0.55, '丰富': 0.5, '不错': 0.55,
      '中等': 0.5, '适中': 0.5, '刚好': 0.5,
      '比较好': 0.55, '挺好': 0.55, '可以': 0.5,

      // 深度方向 (0.7-0.8)
      '非常有创意': 0.7, '很出彩': 0.75, '突破': 0.8,
      '大胆': 0.75, '惊艳': 0.8, '极致': 0.85,
      '深度': 0.75, '高级': 0.75, '专业': 0.7,
      '强': 0.75, '厉害': 0.8, '牛逼': 0.8,
      '电影级': 0.75, '好莱坞': 0.8, '大片': 0.8,

      // 极致方向 (0.9-1.0)
      '天花板': 0.95, '拉到满': 0.95, '拉满': 0.95,
      '顶级': 0.9, '炸裂': 0.95, '逆天': 0.95,
      '满分': 0.95, '封顶': 0.95,
      '最高': 0.95, '无上限': 0.95, '超神': 0.95,
      '维伦纽瓦': 0.9, '诺兰': 0.9, '王家卫': 0.9,
      '天花板般': 0.95, '天花板级的': 0.95
    };

    const lowerText = text.toLowerCase();
    let matchedValue = null;

    // 精确匹配
    if (semanticMap[text]) {
      return semanticMap[text];
    }

    // 模糊匹配：取最高匹配值
    for (const [keyword, value] of Object.entries(semanticMap)) {
      if (lowerText.includes(keyword.toLowerCase())) {
        if (matchedValue === null || value > matchedValue) {
          matchedValue = value;
        }
      }
    }

    return matchedValue;
  }

  _clamp(value) {
    return Math.max(this.minValue, Math.min(this.maxValue, value));
  }
}

/**
 * 超现实系统能力矩阵
 * 按 Layer 组织，适配四层架构
 */
const CAPABILITY_MATRIX = {
  // Layer 1: 剧本引擎 - 影响叙事结构和角色深度
  script: {
    layer: 'Layer 1',
    threshold: 0.4,
    weight: 0.12,
    name: '叙事结构',
    aspects: ['scene_complexity', 'character_depth', 'conflict_design', 'pacing_structure']
  },

  // Layer 2: 制作引擎 - 影响镜头和视觉表现
  camera: {
    layer: 'Layer 2',
    threshold: 0.35,
    weight: 0.18,
    name: '镜头语言',
    aspects: ['movement', 'angle', 'lens_choice', 'depth_of_field']
  },
  lighting: {
    layer: 'Layer 2',
    threshold: 0.30,
    weight: 0.12,
    name: '灯光设计',
    aspects: ['key_light', 'fill_light', 'practical_light', 'color_temperature']
  },
  composition: {
    layer: 'Layer 2',
    threshold: 0.35,
    weight: 0.10,
    name: '构图风格',
    aspects: ['framing', 'negative_space', 'leading_lines', 'symmetry']
  },
  production: {
    layer: 'Layer 2',
    threshold: 0.40,
    weight: 0.08,
    name: '美术布景',
    aspects: ['set_design', 'props', 'color_coding', 'texture']
  },
  performance: {
    layer: 'Layer 2',
    threshold: 0.40,
    weight: 0.08,
    name: '表演指导',
    aspects: ['expression', 'gesture', 'movement', 'eye_contact']
  },

  // Layer 3: 渲染引擎 - 影响质感和特效
  color: {
    layer: 'Layer 3',
    threshold: 0.30,
    weight: 0.10,
    name: '色彩分级',
    aspects: ['lut', 'saturation', 'contrast', 'temperature']
  },
  texture: {
    layer: 'Layer 3',
    threshold: 0.55,
    weight: 0.05,
    name: '质感处理',
    aspects: ['film_grain', 'sharpness', 'bloom', 'diffusion']
  },
  vfx: {
    layer: 'Layer 3',
    threshold: 0.50,
    weight: 0.05,
    name: '特效程度',
    aspects: ['particles', 'light_effects', 'transitions', 'environmental']
  },
  atmosphere: {
    layer: 'Layer 3',
    threshold: 0.35,
    weight: 0.06,
    name: '氛围营造',
    aspects: ['fog', 'haze', 'volumetric', 'weather']
  },

  // Layer 4: 后期引擎 - 影响剪辑和声音
  editing: {
    layer: 'Layer 4',
    threshold: 0.45,
    weight: 0.08,
    name: '剪辑节奏',
    aspects: ['cutting_pace', 'match_cut', 'j_cut_l_cut', 'time_manipulation']
  },
  sound: {
    layer: 'Layer 4',
    threshold: 0.35,
    weight: 0.08,
    name: '声音设计',
    aspects: ['bgm', 'sound_effects', 'spatial_audio', 'silence_design']
  }
};

/**
 * 等级系统 - L0-L5
 */
const INTENSITY_LEVELS = {
  L0: { max: 0.15, name: '保守', description: '最小干预，保持自然' },
  L1: { max: 0.30, name: '标准', description: '适度增强，专业呈现' },
  L2: { max: 0.50, name: '平衡', description: '电影级质感，艺术平衡' },
  L3: { max: 0.70, name: '增强', description: '大胆创新，视觉冲击' },
  L4: { max: 0.85, name: '突破', description: '极致表达，大师级手法' },
  L5: { max: 1.00, name: '极致', description: '无上限创意，突破边界' }
};

/**
 * 指令模板库 - 按 Layer 和等级组织
 * 适配超现实系统的 shot 对象结构
 */
const INSTRUCTION_TEMPLATES = {
  // Layer 1: 叙事结构
  script: {
    L0: '线性叙事，单线结构，标准三幕式',
    L1: '清晰叙事，明确起承转合，标准场景结构',
    L2: '多线叙事，伏笔与呼应，情绪曲线设计',
    L3: '非线性叙事，倒叙插叙，开放式结构',
    L4: '元叙事，自我反射，叙事即主题',
    L5: '解构叙事，意识流，叙事即哲学'
  },

  // Layer 2: 镜头语言
  camera: {
    L0: '固定机位，标准景别，无特殊运动',
    L1: '推轨拉移，简单环绕，稳定器跟随',
    L2: '斯坦尼康长镜头，轨道滑动，浅景深跟焦',
    L3: '低角度仰拍，旋转镜头，主观POV',
    L4: '无人机航拍，微距探入，时间操控',
    L5: '维伦纽瓦式史诗构图，诺兰式时间切片，IMAX画幅'
  },
  lighting: {
    L0: '自然光，均匀照明，无特殊光影',
    L1: '三点布光，柔光模拟，自然光增强',
    L2: '戏剧性光影，伦勃朗光，剪影，环境填充',
    L3: '霓虹色温，体积光，光绘，投影纹理',
    L4: '黑色电影布光，环境光叙事，光即角色',
    L5: '每个场景定制化灯光叙事，光即情绪，光即哲学'
  },
  composition: {
    L0: '三分法，中心对称，标准景别',
    L1: '引导线，前景遮挡，标准深度层次',
    L2: '框架构图，多层景深，前景中景背景',
    L3: '极端对称，负空间，几何分割，打破三分法',
    L4: '宏大比例，抽象构图，空间作为叙事',
    L5: '构图即叙事，空间即情绪，画框即世界'
  },
  production: {
    L0: '简洁背景，功能化道具，最少装饰',
    L1: '场景层次，前景遮挡，背景故事化道具',
    L2: '定制化场景，色彩编码空间，沉浸式环境',
    L3: '概念化场景，超现实比例，象征性道具',
    L4: '定制化场景建筑，环境叙事，空间即情绪',
    L5: '场景即叙事，空间即角色，环境即哲学'
  },
  performance: {
    L0: '自然表情，标准肢体语言，专业稳重',
    L1: '适度表情，标准手势，眼神交流',
    L2: '情感层次，微表情，眼神变化，手势设计',
    L3: '情绪化表演，即兴感，打破第四面墙',
    L4: '方法派表演，情绪爆发，角色化肢体语言',
    L5: '表演即角色，微表情即情绪，身体即叙事'
  },

  // Layer 3: 渲染质感
  color: {
    L0: '自然色温，标准饱和度，白平衡',
    L1: '轻微调色，自然色温，标准饱和度',
    L2: '电影LUT，冷暖对比，单色调色',
    L3: '赛博朋克色，青橙对比，去饱和+单色强调',
    L4: '琥珀色世界，霓虹色，冷蓝调，单色世界',
    L5: '色彩即叙事，色调即情绪，色温即时间'
  },
  texture: {
    L0: '数字清晰，无特殊质感',
    L1: '轻微胶片颗粒，标准锐度',
    L2: '胶片颗粒，柯达2383质感，轻微柔光',
    L3: '16mm胶片感，变形宽银幕，光学瑕疵',
    L4: '湿版摄影质感，手绘动画质感，AI瑕疵美学',
    L5: '质感即叙事，媒介即情绪，材质即时间'
  },
  vfx: {
    L0: '无特效',
    L1: '粒子光斑，简单过渡，环境粒子',
    L2: '光效粒子，镜头光晕，环境互动粒子',
    L3: '复杂粒子系统，流体模拟，光绘轨迹',
    L4: '全息投影，空间扭曲，时间残影',
    L5: '特效即叙事，粒子即情绪，视觉即哲学'
  },
  atmosphere: {
    L0: '轻微雾效，基础环境感',
    L1: '环境雾，轻微体积感',
    L2: '体积雾，光雾交互，季节感',
    L3: '超现实氛围，梦境感，时间错位感',
    L4: '诗意氛围，梦境流动性，时间即空气',
    L5: '氛围即叙事，环境即情绪，空气即角色'
  },

  // Layer 4: 后期
  editing: {
    L0: '标准镜头时长，匀速切换',
    L1: '标准时长，匀速切换，基础转场',
    L2: '情绪匹配时长，紧张快切，情感延长',
    L3: '变速剪辑，J型L型剪辑，节奏对比',
    L4: '音乐同步剪辑，帧率切换，时间膨胀',
    L5: '节奏即叙事，剪辑即情绪，时间即角色'
  },
  sound: {
    L0: '清晰对白，环境音填充，标准配乐',
    L1: '清晰对白，环境音，标准BGM',
    L2: 'ASMR细节，3D空间音频，情绪配乐',
    L3: '声音景观设计，动态音乐，情绪音效',
    L4: '史诗配乐，声音叙事驱动，专属音景',
    L5: '声音即叙事，静默即力量，音频即角色'
  }
};

/**
 * 叙事模式桥接器
 * 根据 narrative_mode 调整创意指数的影响权重
 */
const NARRATIVE_MODE_BRIDGE = {
  dialogue: {
    name: '角色独白',
    boost: {
      performance: 0.15,  // 强化表演
      camera: 0.10,       // 强化镜头语言
      sound: 0.05         // 强化声音清晰度
    },
    reduce: {
      vfx: 0.10,          // 降低特效（避免分散注意力）
      atmosphere: 0.05    // 适度降低氛围
    }
  },
  voiceover: {
    name: '旁白',
    boost: {
      atmosphere: 0.15,   // 强化氛围
      color: 0.10,        // 强化色彩
      composition: 0.05   // 强化构图
    },
    reduce: {
      performance: 0.10,  // 降低表演要求（无角色出镜）
      camera: 0.05        // 适度降低运镜复杂度
    }
  },
  mixed: {
    name: '混合',
    boost: {},
    reduce: {}
  }
};

/**
 * 世界设定桥接器
 * 根据 world_setting 调整风格走向
 */
const WORLD_SETTING_BRIDGE = {
  default: {
    styleBias: {},
    description: '默认世界，无特殊风格偏移'
  },
  Nirath: {
    styleBias: {
      color: 0.10,        // 提升色彩权重
      atmosphere: 0.15,   // 提升氛围权重
      vfx: 0.10           // 提升特效权重
    },
    description: 'Nirath星球：科幻+奇幻，强化视觉奇观'
  },
  hyperreal: {
    styleBias: {
      texture: 0.10,      // 提升质感权重
      lighting: 0.10      // 提升灯光权重
    },
    description: '超写实：极致真实感，强化物理质感'
  }
};

/**
 * 创意指数引擎主类
 */
class CreativeIntensityEngine {
  constructor(options = {}) {
    this.parser = new CreativeIntensityParser(options);
    this.matrix = CAPABILITY_MATRIX;
    this.templates = INSTRUCTION_TEMPLATES;
    this.levels = INTENSITY_LEVELS;
  }

  // ========== 解析入口 ==========

  parse(input) {
    return this.parser.parse(input);
  }

  // ========== 等级计算 ==========

  getLevel(intensity) {
    if (intensity <= this.levels.L0.max) return { key: 'L0', ...this.levels.L0 };
    if (intensity <= this.levels.L1.max) return { key: 'L1', ...this.levels.L1 };
    if (intensity <= this.levels.L2.max) return { key: 'L2', ...this.levels.L2 };
    if (intensity <= this.levels.L3.max) return { key: 'L3', ...this.levels.L3 };
    if (intensity <= this.levels.L4.max) return { key: 'L4', ...this.levels.L4 };
    return { key: 'L5', ...this.levels.L5 };
  }

  // ========== 能力激活 ==========

  /**
   * 获取激活的能力列表
   * @param {number} intensity - 创意指数
   * @param {string} narrativeMode - 叙事模式 (dialogue/voiceover/mixed)
   * @param {string} worldSetting - 世界设定 (default/Nirath/hyperreal)
   * @returns {Array} 激活的能力列表
   */
  getActiveCapabilities(intensity, narrativeMode = 'dialogue', worldSetting = 'default') {
    const modeBridge = NARRATIVE_MODE_BRIDGE[narrativeMode] || NARRATIVE_MODE_BRIDGE.mixed;
    const worldBridge = WORLD_SETTING_BRIDGE[worldSetting] || WORLD_SETTING_BRIDGE.default;

    return Object.entries(this.matrix)
      .map(([id, config]) => {
        // 计算调整后的阈值
        let adjustedThreshold = config.threshold;

        // 应用叙事模式偏移
        if (modeBridge.boost[id]) {
          adjustedThreshold -= modeBridge.boost[id]; // 降低阈值 = 更容易激活
        }
        if (modeBridge.reduce[id]) {
          adjustedThreshold += modeBridge.reduce[id]; // 提高阈值 = 更难激活
        }

        // 应用世界设定偏移
        if (worldBridge.styleBias[id]) {
          adjustedThreshold -= worldBridge.styleBias[id];
        }

        // 确保阈值在合法范围
        adjustedThreshold = Math.max(0.1, Math.min(0.9, adjustedThreshold));

        return {
          id,
          ...config,
          adjustedThreshold,
          active: intensity >= adjustedThreshold,
          gap: adjustedThreshold - intensity // 距离激活还差多少
        };
      })
      .filter(c => c.active);
  }

  // ========== 指令生成 ==========

  /**
   * 为单个能力生成指令
   */
  generateCapabilityInstruction(capabilityId, intensity) {
    const templates = this.templates[capabilityId];
    if (!templates) return null;

    const level = this.getLevel(intensity);
    const instruction = templates[level.key];

    if (!instruction) return null;

    return {
      tag: `[${capabilityId.toUpperCase()}:${level.key}]`,
      instruction,
      level: level.key,
      levelName: level.name,
      intensity,
      weight: this.matrix[capabilityId]?.weight || 0.1
    };
  }

  /**
   * 为指定 Layer 生成所有指令
   */
  generateLayerInstructions(layerName, intensity, narrativeMode = 'dialogue', worldSetting = 'default') {
    const activeCapabilities = this.getActiveCapabilities(intensity, narrativeMode, worldSetting);
    const layerCapabilities = activeCapabilities.filter(c => c.layer === layerName);

    if (layerCapabilities.length === 0) return null;

    const instructions = layerCapabilities.map(c =>
      this.generateCapabilityInstruction(c.id, intensity)
    ).filter(Boolean);

    return {
      layer: layerName,
      intensity,
      level: this.getLevel(intensity),
      count: instructions.length,
      capabilities: layerCapabilities.map(c => c.name),
      instructions: instructions.map(i => `[${i.tag}] ${i.instruction}`).join('\n'),
      details: instructions
    };
  }

  // ========== 配置注入 ==========

  /**
   * 生成超现实系统引擎配置覆盖
   * 将创意指数转化为各引擎的配置参数
   */
  generateEngineConfigs(intensity, narrativeMode = 'dialogue', worldSetting = 'default') {
    const level = this.getLevel(intensity);
    const configs = {
      scriptEngine: {},
      productionEngine: {},
      renderingEngine: {},
      postProductionEngine: {}
    };

    // Layer 1: 剧本引擎配置
    const layer1Instructions = this.generateLayerInstructions('Layer 1', intensity, narrativeMode, worldSetting);
    if (layer1Instructions) {
      configs.scriptEngine = {
        sceneComplexity: intensity > 0.5 ? 'complex' : 'standard',
        characterDepth: intensity > 0.4 ? 'deep' : 'standard',
        conflictDesign: intensity > 0.6 ? 'multi_layer' : 'single',
        pacingStructure: intensity > 0.5 ? 'dynamic' : 'linear',
        creativeInstructions: layer1Instructions.instructions
      };
    }

    // Layer 2: 制作引擎配置
    const layer2Instructions = this.generateLayerInstructions('Layer 2', intensity, narrativeMode, worldSetting);
    if (layer2Instructions) {
      configs.productionEngine = {
        cameraStyle: intensity > 0.35 ? 'cinematic' : 'standard',
        lightingStyle: intensity > 0.3 ? 'dramatic' : 'natural',
        compositionStyle: intensity > 0.35 ? 'artistic' : 'standard',
        productionStyle: intensity > 0.4 ? 'customized' : 'minimal',
        performanceStyle: intensity > 0.4 ? 'emotional' : 'natural',
        creativeInstructions: layer2Instructions.instructions
      };
    }

    // Layer 3: 渲染引擎配置
    const layer3Instructions = this.generateLayerInstructions('Layer 3', intensity, narrativeMode, worldSetting);
    if (layer3Instructions) {
      configs.renderingEngine = {
        colorGrading: intensity > 0.3 ? 'cinematic' : 'natural',
        textureQuality: intensity > 0.55 ? 'filmic' : 'digital',
        vfxLevel: intensity > 0.5 ? 'enhanced' : 'none',
        atmosphereLevel: intensity > 0.35 ? 'rich' : 'minimal',
        creativeInstructions: layer3Instructions.instructions
      };
    }

    // Layer 4: 后期引擎配置
    const layer4Instructions = this.generateLayerInstructions('Layer 4', intensity, narrativeMode, worldSetting);
    if (layer4Instructions) {
      configs.postProductionEngine = {
        editingStyle: intensity > 0.45 ? 'artistic' : 'standard',
        soundDesign: intensity > 0.35 ? 'immersive' : 'standard',
        creativeInstructions: layer4Instructions.instructions
      };
    }

    return {
      intensity,
      level,
      narrativeMode,
      worldSetting,
      ...configs,
      _metadata: {
        activeCapabilities: this.getActiveCapabilities(intensity, narrativeMode, worldSetting).length,
        totalCapabilities: Object.keys(this.matrix).length,
        contentFirewall: true
      }
    };
  }

  // ========== 内容防火墙 ==========

  isContentModule(moduleId) {
    const contentModules = ['script_content', 'dialogue', 'facts', 'medical', 'data', 'narrative_logic'];
    return contentModules.includes(moduleId);
  }

  generateFirewallLog() {
    return `
[CONTENT_FIREWALL] 🔒 内容层完全隔离，创意指数不干预：
  - 剧本内容 (Script Content) → 已锁定
  - 台词对白 (Dialogue) → 已锁定
  - 事实数据 (Facts & Data) → 已锁定
  - 叙事逻辑 (Narrative Logic) → 已锁定
[CONTENT_FIREWALL] ✅ 表现层接受创意指数调控：
  - Layer 2: 镜头语言、灯光、构图、布景、表演
  - Layer 3: 色彩、质感、特效、氛围
  - Layer 4: 剪辑、声音设计
`;
  }

  // ========== 完整报告 ==========

  generateReport(intensity, narrativeMode = 'dialogue', worldSetting = 'default') {
    const activeCapabilities = this.getActiveCapabilities(intensity, narrativeMode, worldSetting);
    const level = this.getLevel(intensity);

    // 按 Layer 分组
    const byLayer = {};
    for (const cap of activeCapabilities) {
      if (!byLayer[cap.layer]) byLayer[cap.layer] = [];
      byLayer[cap.layer].push(cap);
    }

    return {
      intensity,
      level: level.key,
      levelName: level.name,
      levelDescription: level.description,
      narrativeMode,
      worldSetting,
      summary: `创意指数 ${intensity} (${level.name})：已激活 ${activeCapabilities.length}/${Object.keys(this.matrix).length} 个能力`,
      byLayer,
      capabilities: activeCapabilities.map(c => ({
        id: c.id,
        name: c.name,
        weight: c.weight,
        instruction: this.generateCapabilityInstruction(c.id, intensity)
      })),
      inactiveCapabilities: Object.entries(this.matrix)
        .filter(([id]) => !activeCapabilities.find(c => c.id === id))
        .map(([id, config]) => ({
          id,
          name: config.name,
          threshold: config.threshold,
          reason: `需创意指数 ≥ ${config.threshold} 激活`
        })),
      engineConfigs: this.generateEngineConfigs(intensity, narrativeMode, worldSetting),
      firewall: this.generateFirewallLog()
    };
  }
}

/**
 * 创意指数推荐器
 * 基于历史数据反馈闭环
 */
class CreativeIntensityRecommender {
  constructor(options = {}) {
    this.dataPath = options.dataPath || './data/creative-intensity-feedback.json';
    this.minSamples = options.minSamples || 3;
    this.confidenceThreshold = options.confidenceThreshold || 0.6;
    this.defaultRecommendations = {
      'EDU': { intensity: 0.4, reason: '教育科普需要专业可信感，过高创意指数可能降低权威感' },
      'DRAMA': { intensity: 0.7, reason: '剧情短片需要较强影视表现力来吸引观众' },
      'ADV': { intensity: 0.8, reason: '商业广告需要突出产品，高创意指数增强视觉冲击力' },
      'DOC': { intensity: 0.5, reason: '纪录片需要真实感与适度艺术性的平衡' },
      'VLOG': { intensity: 0.4, reason: 'Vlog记录需要自然真实感' },
      'SOC': { intensity: 0.8, reason: '社媒短视频需要强视觉冲击力获取停留' },
      'COR': { intensity: 0.6, reason: '企业宣传需要专业感与吸引力的平衡' }
    };
    this.data = this._loadData();
  }

  _loadData() {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.dataPath)) {
        return JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
      }
    } catch (e) {
      console.warn(`[Recommender] 数据加载失败: ${e.message}`);
    }
    return { schema: 'creative-intensity-feedback-v1', entries: [], aggregated: {} };
  }

  _saveData() {
    try {
      const fs = require('fs');
      const dir = require('path').dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn(`[Recommender] 数据保存失败: ${e.message}`);
    }
  }

  /**
   * 记录一次生产结果
   */
  record(entry) {
    const record = {
      id: `entry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      videoType: entry.videoType || 'unknown',
      intensity: entry.intensity || 0.2,
      completionRate: entry.completionRate || 0,
      engagementRate: entry.engagementRate || 0,
      timestamp: entry.timestamp || new Date().toISOString()
    };

    this.data.entries.push(record);
    this._updateAggregation(record);
    this._saveData();

    console.log(`[Recommender] 记录已保存 | ${record.videoType} | intensity=${record.intensity} | 完播率=${record.completionRate}%`);
    return record;
  }

  _updateAggregation(record) {
    const type = record.videoType;
    if (!this.data.aggregated[type]) {
      this.data.aggregated[type] = {
        samples: 0,
        intensity_distribution: {},
        recommended: this.defaultRecommendations[type]?.intensity || 0.5,
        confidence: 0
      };
    }

    const agg = this.data.aggregated[type];
    agg.samples++;

    const intensityKey = Math.round(record.intensity * 10) / 10;
    if (!agg.intensity_distribution[intensityKey]) {
      agg.intensity_distribution[intensityKey] = { count: 0, avg_completion: 0, total_completion: 0 };
    }

    const dist = agg.intensity_distribution[intensityKey];
    dist.count++;
    dist.total_completion += record.completionRate;
    dist.avg_completion = Math.round(dist.total_completion / dist.count * 10) / 10;

    // 重新计算推荐值
    this._recalculateRecommendation(type);
  }

  _recalculateRecommendation(videoType) {
    const agg = this.data.aggregated[videoType];
    if (!agg || agg.samples < this.minSamples) return;

    let bestIntensity = 0.2;
    let bestCompletion = 0;

    for (const [intensity, data] of Object.entries(agg.intensity_distribution)) {
      if (data.count >= 1 && data.avg_completion > bestCompletion) {
        bestCompletion = data.avg_completion;
        bestIntensity = parseFloat(intensity);
      }
    }

    agg.recommended = bestIntensity;
    agg.confidence = Math.min(1, agg.samples / 10); // 样本越多置信度越高
  }

  /**
   * 获取推荐值
   */
  recommend(videoType) {
    const agg = this.data.aggregated[videoType];
    if (agg && agg.samples >= this.minSamples) {
      return {
        intensity: agg.recommended,
        confidence: agg.confidence,
        samples: agg.samples,
        source: 'historical_data',
        reason: `基于 ${agg.samples} 条历史数据，完播率最优区间`
      };
    }

    // 回退到默认值
    const defaults = this.defaultRecommendations[videoType];
    if (defaults) {
      return {
        intensity: defaults.intensity,
        confidence: 0.3,
        samples: 0,
        source: 'default',
        reason: defaults.reason
      };
    }

    return {
      intensity: 0.5,
      confidence: 0.1,
      samples: 0,
      source: 'fallback',
      reason: '无历史数据，使用通用默认值'
    };
  }
}

module.exports = {
  CreativeIntensityEngine,
  CreativeIntensityParser,
  CreativeIntensityRecommender,
  CAPABILITY_MATRIX,
  INTENSITY_LEVELS,
  NARRATIVE_MODE_BRIDGE,
  WORLD_SETTING_BRIDGE
};
