/**
 * Cinematography Core - 摄影核心工具库
 * 提供镜头语言、构图法则、色彩理论等摄影辅助工具
 * 独立于技能路由文件，提供可扩展的摄影工具集
 */

/**
 * 镜头类型分类
 */
const SHOT_TYPES = {
  // 景别
  ESTABLISHING: 'establishing',     // 定场镜头（大远景/全景）
  WIDE: 'wide',                     // 广角（大景别）
  MEDIUM: 'medium',                 // 中景
  CLOSEUP: 'closeup',               // 特写
  EXTREME_CLOSEUP: 'extreme_closeup', // 极端特写
  
  // 角度
  EYE_LEVEL: 'eye_level',           // 平视
  HIGH_ANGLE: 'high_angle',         // 俯视/高角度
  LOW_ANGLE: 'low_angle',           // 仰视/低角度
  DUTCH: 'dutch',                   // 倾斜/荷兰角
  OVERHEAD: 'overhead',             // 正上方
  
  // 运动
  STATIC: 'static',                 // 固定
  PAN: 'pan',                       // 平移
  TILT: 'tilt',                     // 俯仰
  DOLLY: 'dolly',                   // 推拉
  TRACKING: 'tracking',             // 跟踪
  CRANE: 'crane',                   // 升降
  HANDHELD: 'handheld',             // 手持
  STEADICAM: 'steadicam',           // 稳定器
  DRONE: 'drone'                    // 航拍
};

/**
 * 构图法则模板
 */
const COMPOSITION_RULES = {
  rule_of_thirds: {
    name: '三分法构图',
    description: '将画面分为九宫格，主体放在交叉点上',
    guideline: 'subject positioned at one of the 4 intersection points, creating visual balance'
  },
  golden_ratio: {
    name: '黄金比例构图',
    description: '按照1.618:1的比例划分画面',
    guideline: 'composition follows golden ratio 1.618:1, creating natural harmony and aesthetic balance'
  },
  leading_lines: {
    name: '引导线构图',
    description: '利用线条引导观众视线到主体',
    guideline: 'strong leading lines (roads, rails, architecture edges) directing viewer attention to the subject'
  },
  frame_in_frame: {
    name: '框架内框架',
    description: '利用自然或人工框架突出主体',
    guideline: 'natural or architectural framing (doorways, windows, arches) creating depth and focus'
  },
  symmetry: {
    name: '对称构图',
    description: '画面左右或上下对称',
    guideline: 'perfect bilateral symmetry, creating formal elegance and visual order'
  },
  asymmetry: {
    name: '非对称构图',
    description: '利用不对称创造动态张力',
    guideline: 'deliberate asymmetry with weighted elements, creating dynamic tension and visual interest'
  },
  depth_of_field: {
    name: '景深构图',
    description: '通过景深控制突出主体',
    guideline: 'shallow depth of field isolating subject from background, creating dimensional depth'
  }
};

/**
 * 色彩理论指导
 */
const COLOR_THEORIES = {
  complementary: {
    name: '互补色',
    pairs: [['red', 'cyan'], ['blue', 'yellow'], ['green', 'magenta']],
    effect: '强烈的视觉对比，适合冲突场景'
  },
  analogous: {
    name: '类比色',
    description: '相邻色系的搭配',
    effect: '和谐统一，适合情感过渡场景'
  },
  triadic: {
    name: '三角色',
    description: '色环上等距的三色',
    effect: '平衡丰富，适合复杂场景'
  },
  monochromatic: {
    name: '单色系',
    description: '同一色相的不同明度和饱和度',
    effect: '统一克制，适合情绪专注场景'
  }
};

/**
 * 光线类型指导
 */
const LIGHTING_STYLES = {
  key_light: {
    name: '主光',
    description: '照亮主体的主要光源',
    position: '通常位于主体前方45度角'
  },
  fill_light: {
    name: '补光',
    description: '柔化主光产生的阴影',
    intensity: '通常为主光强度的1/2到1/4'
  },
  backlight: {
    name: '逆光',
    description: '从主体后方照射，勾勒轮廓',
    effect: '分离主体与背景，增加层次感'
  },
  rim_light: {
    name: '轮廓光',
    description: '强逆光，创造明显的轮廓光晕',
    effect: '戏剧性，适合英雄时刻或神秘场景'
  },
  practical_light: {
    name: '实景光',
    description: '场景中的自然光源（灯、窗户）',
    effect: '真实自然，增强场景可信度'
  },
  ambient_light: {
    name: '环境光',
    description: '场景中的整体环境照明',
    effect: '提供基础亮度，避免死黑'
  }
};

/**
 * 根据镜头类型推荐构图法则
 * @param {string} shotType - 镜头类型
 * @returns {array} 推荐的构图法则列表
 */
function recommendComposition(shotType) {
  const recommendations = {
    [SHOT_TYPES.ESTABLISHING]: ['rule_of_thirds', 'golden_ratio', 'leading_lines'],
    [SHOT_TYPES.WIDE]: ['rule_of_thirds', 'leading_lines', 'symmetry'],
    [SHOT_TYPES.MEDIUM]: ['rule_of_thirds', 'depth_of_field', 'frame_in_frame'],
    [SHOT_TYPES.CLOSEUP]: ['depth_of_field', 'asymmetry', 'rule_of_thirds'],
    [SHOT_TYPES.EXTREME_CLOSEUP]: ['symmetry', 'depth_of_field'],
    [SHOT_TYPES.HIGH_ANGLE]: ['leading_lines', 'symmetry'],
    [SHOT_TYPES.LOW_ANGLE]: ['asymmetry', 'leading_lines'],
    [SHOT_TYPES.DUTCH]: ['asymmetry'] // 荷兰角本身就是破坏平衡的
  };

  const keys = recommendations[shotType] || ['rule_of_thirds'];
  return keys.map(k => COMPOSITION_RULES[k]).filter(Boolean);
}

/**
 * 根据情绪推荐色彩方案
 * @param {string} emotion - 情绪关键词
 * @returns {object} 色彩方案
 */
function recommendColorScheme(emotion) {
  const schemes = {
    'lonely': { palette: ['blue', 'grey', 'desaturated'], temperature: 'cool', saturation: 'low' },
    'tense': { palette: ['red', 'orange', 'high_contrast'], temperature: 'warm', saturation: 'high' },
    'romantic': { palette: ['pink', 'soft_gold', 'warm_white'], temperature: 'warm', saturation: 'medium' },
    'mysterious': { palette: ['deep_blue', 'purple', 'dark_green'], temperature: 'cool', saturation: 'low' },
    'epic': { palette: ['golden', 'deep_orange', 'crimson'], temperature: 'warm', saturation: 'high' },
    'tender': { palette: ['soft_pink', 'cream', 'pastel'], temperature: 'warm', saturation: 'low' },
    'suspenseful': { palette: ['dark_green', 'grey', 'subdued_red'], temperature: 'cool', saturation: 'medium' },
    'emotional': { palette: ['warm_amber', 'soft_gold', 'earth_tone'], temperature: 'warm', saturation: 'medium' }
  };

  return schemes[emotion.toLowerCase()] || { palette: ['neutral'], temperature: 'neutral', saturation: 'medium' };
}

/**
 * 根据场景类型推荐光线方案
 * @param {string} sceneType - 场景类型
 * @returns {array} 光线方案
 */
function recommendLighting(sceneType) {
  const lightingMap = {
    'interior': ['key_light', 'fill_light', 'practical_light', 'ambient_light'],
    'exterior_day': ['key_light', 'fill_light', 'ambient_light'],
    'exterior_night': ['key_light', 'backlight', 'practical_light'],
    'studio': ['key_light', 'fill_light', 'backlight', 'rim_light'],
    'dramatic': ['key_light', 'rim_light', 'backlight'],
    'natural': ['practical_light', 'ambient_light', 'fill_light']
  };

  const keys = lightingMap[sceneType] || ['key_light', 'fill_light'];
  return keys.map(k => LIGHTING_STYLES[k]).filter(Boolean);
}

/**
 * 生成镜头语言描述
 * @param {object} params - { shotType, angle, movement, composition }
 * @returns {string} 镜头语言描述
 */
function generateCinematographyDescription(params = {}) {
  const parts = [];

  if (params.shotType) {
    const typeMap = {
      'establishing': '大远景定场镜头',
      'wide': '广角镜头',
      'medium': '中景镜头',
      'closeup': '特写镜头',
      'extreme_closeup': '极端特写'
    };
    parts.push(typeMap[params.shotType] || params.shotType);
  }

  if (params.angle) {
    const angleMap = {
      'eye_level': '平视角度',
      'high_angle': '俯视角度',
      'low_angle': '仰视角度',
      'dutch': '倾斜角度（荷兰角）',
      'overhead': '正上方俯视'
    };
    parts.push(angleMap[params.angle] || params.angle);
  }

  if (params.movement) {
    const movementMap = {
      'static': '固定机位',
      'pan': '水平平移',
      'tilt': '垂直俯仰',
      'dolly': '推拉运动',
      'tracking': '跟踪运动',
      'handheld': '手持摄影',
      'steadicam': '稳定器运动',
      'drone': '航拍运动'
    };
    parts.push(movementMap[params.movement] || params.movement);
  }

  if (params.composition) {
    const comp = COMPOSITION_RULES[params.composition];
    if (comp) {
      parts.push(`采用${comp.name}：${comp.description}`);
    }
  }

  return parts.join('，');
}

module.exports = {
  SHOT_TYPES,
  COMPOSITION_RULES,
  COLOR_THEORIES,
  LIGHTING_STYLES,
  recommendComposition,
  recommendColorScheme,
  recommendLighting,
  generateCinematographyDescription
};
