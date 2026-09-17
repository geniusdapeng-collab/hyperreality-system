// systems/production-bible.js
// Production Bible / 生产圣经 - 系列一致性约束层
// v4.1规范编码

const ProductionBible = {
  version: 'v4.1',
  updated: '2026-06-04',
  
  // 角色圣经
  character: {
    xiaoG: {
      name: 'xiaoG',
      age: '8yo',
      face: 'round face',
      hair: 'black hair',
      eyes: 'brown eyes',
      outfit: 'khaki pants, green jacket',
      height: 'child proportion',
      anchorFeatures: ['round face', 'black hair', 'brown eyes', 'khaki pants', 'green jacket'],
      variationAllowed: ['expression', 'posture', 'lighting effect', 'dirt level', 'environment attachment'],
      variationForbidden: ['age change', 'outfit color drift', 'hairstyle change', 'height change'],
      // Nirath星球特征
      nirathTraits: ['adapted to low gravity', 'fluent in alien ecology', 'wears bioluminescent-safe clothing']
    },
    taotie: {
      name: 'taotie',
      type: 'mythical beast',
      anchorFeatures: ['massive jaw', 'no eyes', 'ears as eyes', 'glyph-covered body', 'ancient texture'],
      variationAllowed: ['posture', 'activation state', 'glow intensity', 'scale pattern'],
      variationForbidden: ['modern features', 'cute/cartoon distortion', 'size change inconsistent with lore']
    }
  },
  
  // 环境圣经
  environment: {
    'Lumina-velum': {
      name: 'Lumina-velum',
      spatialKeywords: ['高耸', '环形', '悬浮孢子', '菌丝网络'],
      landmarks: ['主祭坛', '断柱', '石桥', '孢子塔'],
      palette: { primary: '青灰+土褐', accent: '赤金', forbidden: ['现代设施', '金属科技感', '塑料质感'] },
      ground: '湿石/泥土/碎裂石板/发光菌毯',
      atmosphere: '雾/尘/微粒/孢子/低重力漂浮物',
      lightSources: '自然天光/裂缝内发光/双恒星Aurelius+Silvana',
      nirathTraits: ['bioluminescent flora', 'floating spores', 'magnetic field pulsation', 'crystal formations']
    },
    'Planum-campus': {
      name: 'Planum-campus',
      spatialKeywords: ['广阔', '平坦', '深渊', '结晶平原'],
      landmarks: ['abyssal fissure', 'crystal spires', 'ruined archways'],
      palette: { primary: '银白+深紫', accent: '荧光蓝', forbidden: ['戈壁滩', '黄土高原', '火星式光秃'] },
      ground: 'glass-like crystalline terrain/cracked mineral crust',
      atmosphere: 'floating ice particles/low gravity dust/suspended debris',
      lightSources: 'twin suns dual shadows/bioluminescent glow from below',
      nirathTraits: ['transparent crystal ground', 'gravity-defying formations', 'ethereal cyan glow']
    },
    'Stellar-Remains': {
      name: 'Stellar Remains',
      spatialKeywords: ['floating debris', 'celestial wreckage', 'levitating ruins'],
      landmarks: ['colossal starship wreckage', 'floating archways', 'starfall valley'],
      palette: { primary: 'amber gold+deep space black', accent: 'warm healing light', forbidden: ['dark horror', 'gothic gloom'] },
      ground: 'floating celestial debris/levitating rock fragments',
      atmosphere: 'slow-motion particles/glowing spores drifting weightlessly',
      lightSources: '双星日落/体积神光/生物发光植被',
      nirathTraits: ['low gravity suspension', 'organic metal ruins', 'warm golden hour']
    }
  },
  
  // 色彩圣经
  colorScript: {
    // 每集色彩推进逻辑
    episodeTemplate: {
      S00_S01: { palette: '青灰+土褐', function: '现实探索', mood: 'curiosity' },
      S02_S03: { palette: '低饱和冷暗+局部赤金', function: '异常逼近', mood: 'suspense' },
      S04: { palette: '赤金爆发+深黑对比', function: '高潮显现', mood: 'climax' },
      S05: { palette: '余烬金+夜色蓝灰', function: '余韵回收', mood: 'resolution' }
    }
  },
  
  // Nirath星球生态特征（全局约束）
  nirathPlanet: {
    twinSuns: {
      Aurelius: { colorTemp: '5800K', color: 'warm gold', description: '主恒星，暖金色' },
      Silvana: { colorTemp: '6500K', color: 'silver white', description: '辅恒星，银白色' }
    },
    ecosystem: ['bioluminescent flora', 'floating spores', 'magnetic field pulsation', 'crystal formations', 'low gravity effects'],
    forbidden: ['戈壁滩', '黄土高原', '火星式光秃', '寸草不生', '现代设施', '金属科技感', '塑料质感'],
    required: ['vibrant alien life', 'dual shadows', 'floating particles', 'organic textures']
  },
  
  // 视觉母题
  motifs: ['裂缝', '菌丝', '风压', '石纹', '脉冲', '双影', '漂浮'],
  
  // 禁用元素（零容忍）
  forbidden: [
    '红眼/火焰瞳孔',
    '真实品牌/IP',
    '过度机械/科幻',
    '不适龄暴力',
    'anime/cartoon style',
    'ink wash painting style',
    'traditional Chinese symbols',
    'modern facilities',
    'plastic/CG texture',
    'bare/barren/desolate',
    'dark horror/gothic gloom'
  ]
};

// 角色锚点生成器
function generateCharacterAnchor(characterName, options = {}) {
  const char = ProductionBible.character[characterName];
  if (!char) return '';
  
  const base = char.anchorFeatures.join(', ');
  const nirath = char.nirathTraits ? char.nirathTraits.join(', ') : '';
  
  return `${characterName}, ${base}${nirath ? `, ${nirath}` : ''}`;
}

// 环境锚点生成器
function generateEnvironmentAnchor(envName, options = {}) {
  const env = ProductionBible.environment[envName];
  if (!env) return '';
  
  const base = `${env.name}, ${env.spatialKeywords.join(', ')}`;
  const ground = env.ground;
  const atmosphere = env.atmosphere;
  const nirath = env.nirathTraits ? env.nirathTraits.join(', ') : '';
  
  return `${base}, ${ground}, ${atmosphere}${nirath ? `, ${nirath}` : ''}`;
}

// Nirath星球特征注入
function generateNirathTraits() {
  const planet = ProductionBible.nirathPlanet;
  const suns = `twin suns Aurelius ${planet.twinSuns.Aurelius.colorTemp} ${planet.twinSuns.Aurelius.color} and Silvana ${planet.twinSuns.Silvana.colorTemp} ${planet.twinSuns.Silvana.color}`;
  const ecosystem = planet.ecosystem.join(', ');
  const required = planet.required.join(', ');
  
  return `${suns}, ${ecosystem}, ${required}`;
}

module.exports = { 
  ProductionBible, 
  generateCharacterAnchor, 
  generateEnvironmentAnchor,
  generateNirathTraits
};
