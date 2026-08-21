/**
 * Ambient Sound Designer v1.0 — Nirath环境音效设计Agent
 * 为每个镜头根据具体场景环境生成Diegetic环境音效描述
 * 作为独立字段【环境音效】注入Seedance Prompt
 * 
 * 设计原则：
 * 1. 纯环境音（Diegetic）——只来自画面内的声音，无音乐/旁白
 * 2. 根据场景环境自适应——不是固定音效列表，而是根据镜头描述智能匹配
 * 3. Nirath生态特征——结合星球特有的生态元素（磁丝树、荧光孢子、液态金属等）
 * 4. 预算控制——约60-80字符，不占用核心视觉描述空间
 */

// ===== Nirath生态音效映射库 =====
const NIRATH_SOUND_MAP = {
  // 植被类
  vegetation: {
    '磁丝树': ['磁丝树金属般轻响', '磁力纤维震颤嗡鸣', '磁丝树叶片碰撞声'],
    '荧光孢子': ['荧光孢子细微爆裂', '孢子飘浮轻柔嗡鸣', '孢子发光细微滋滋声'],
    '发光藤蔓': ['藤蔓柔和嗡鸣', '生物荧光脉动声', '藤蔓生长细微摩擦'],
    '水晶植物': ['晶体共振清脆音', '光能转化细微嗡鸣', '水晶叶片碰撞'],
    '巨型叶片': ['大叶扇动风声', '叶片呼吸般起伏声', '光合作用能量流动'],
    '通用植被': ['树叶沙沙声', '草叶摩擦声', '植物生长细微声响']
  },
  // 水体类
  water: {
    '液态金属河': ['液态汞波动声', '金属水流切割声', '磁性河流共鸣'],
    '弱水': ['弱水特殊共鸣', '旋涡低频嗡鸣', '水面能量波动'],
    '瀑布': ['水流切割轰鸣', '水雾撞击声', '瀑布底部共鸣'],
    '溪流': ['溪流潺潺', '水石碰撞清脆声', '水流绕过根系'],
    '湖泊': ['湖面微波轻拍', '水下气泡上升', '湖水低频回响'],
    '通用水体': ['流水声', '水波轻拍', '湿润环境共鸣']
  },
  // 动物类
  fauna: {
    '鸟类': ['Nirath鸟类高频鸣叫', '双翼划破空气声', '群鸟迁徙振翅'],
    '昆虫': ['昆虫翅膀高频振动', '群体嗡鸣', '生物发光伴随细微声响'],
    '兽类': ['远处兽类低沉呼吸', '巨兽脚步震动', '生物活动摩擦声'],
    '孢子生物': ['孢子生物漂浮嗡鸣', '微生物群体共振', '发光生物细微噼啪'],
    '通用动物': ['环境生物活动声', '远处动物鸣叫', '生态背景音']
  },
  // 地貌类
  terrain: {
    '龙骨山脉': ['风穿过骨腔呼啸', '龙骨山脉共鸣', '岩石摩擦低鸣'],
    '磁石平原': ['磁石低频嗡鸣', '磁场共振震颤', '磁力线轻微嘶嘶'],
    '青铜废墟': ['青铜碰撞回响', '远古机械运转', '金属氧化细微声响'],
    '浮空岛屿': ['浮空石稳定嗡鸣', '重力场细微震颤', '岛屿边缘风声'],
    '火山地貌': ['岩浆气泡爆裂', '地热蒸汽喷发', '火山内部低频轰鸣'],
    '通用地貌': ['风声', '环境共鸣', '地质细微活动']
  },
  // 气象类
  weather: {
    '双恒星风': ['太阳风粒子嘶嘶声', '恒星辐射细微嗡鸣', '光压波动'],
    '极光': ['极光能量嘶嘶', '磁层共振', '带电粒子碰撞细微噼啪'],
    '磁暴': ['磁暴冲击波', '磁场剧烈震颤', '能量释放轰鸣'],
    '孢子风暴': ['孢子群撞击声', '风暴中生物嗡鸣', '风力携带动植物声响'],
    '通用气象': ['微风声', '空气流动', '大气细微振动']
  }
};

// ===== 场景关键词识别 =====
const SCENE_KEYWORDS = {
  vegetation: ['树', '林', '草', '叶', '孢子', '藤蔓', '植物', '花', '森林', '丛林', '植被', '荧光'],
  water: ['水', '河', '湖', '海', '溪', '瀑布', '流', '湿', '液体', '弱水', '液态金属'],
  fauna: ['鸟', '兽', '虫', '动物', '生物', '饕餮', '九尾', '旋龟', '飞', '翅膀', '鸣叫'],
  terrain: ['山', '石', '岩', '矿', '废墟', '龙骨', '平原', '浮空', '岛', '火山', '青铜'],
  weather: ['风', '光', '极光', '磁暴', '太阳', '恒星', '孢子风暴', '天气', '气象']
};

class AmbientSoundDesigner {
  constructor() {
    this.maxChars = 80; // 环境音效字段预算
    this.diegeticRule = '纯环境音（Diegetic），无音乐/旁白/人声';
  }

  /**
   * 分析场景描述，识别环境类型
   * @param {string} sceneDescription - 场景描述文本
   * @returns {Object} - 识别到的环境类型及其置信度
   */
  analyzeScene(sceneDescription) {
    if (!sceneDescription) return { primary: 'general', confidence: 0 };
    
    const scores = {};
    for (const [type, keywords] of Object.entries(SCENE_KEYWORDS)) {
      scores[type] = 0;
      for (const kw of keywords) {
        if (sceneDescription.includes(kw)) {
          scores[type] += 1;
        }
      }
    }
    
    // 找出最高分
    let maxScore = 0;
    let primary = 'general';
    for (const [type, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        primary = type;
      }
    }
    
    // 如果所有分数都是0，返回通用
    if (maxScore === 0) {
      return { primary: 'general', confidence: 0, secondary: null };
    }
    
    // 找出第二高分（辅助类型）
    let secondMax = 0;
    let secondary = null;
    for (const [type, score] of Object.entries(scores)) {
      if (type !== primary && score > secondMax) {
        secondMax = score;
        secondary = score > 0 ? type : null;
      }
    }
    
    return { primary, confidence: maxScore, secondary, secondaryConfidence: secondMax };
  }

  /**
   * 根据识别到的环境类型生成音效描述
   * @param {Object} sceneAnalysis - analyzeScene的返回结果
   * @param {string} sceneDescription - 原始场景描述（用于更精确匹配）
   * @param {number} maxChars - 最大字符数
   * @returns {string} - 环境音效描述
   */
  generateSoundDescription(sceneAnalysis, sceneDescription = '', maxChars = 80) {
    const { primary, secondary } = sceneAnalysis;
    const sounds = [];
    
    // 从主类型中选取2-3个音效
    const primarySounds = this._selectSoundsFromType(primary, sceneDescription, 2);
    sounds.push(...primarySounds);
    
    // 如果有辅助类型，选取1个音效
    if (secondary) {
      const secondarySounds = this._selectSoundsFromType(secondary, sceneDescription, 1);
      sounds.push(...secondarySounds);
    }
    
    // 去重并合并
    const uniqueSounds = [...new Set(sounds)];
    
    // 构建描述字符串
    let description = uniqueSounds.join('、');
    
    // 如果超出预算，智能压缩
    if (description.length > maxChars - 8) { // 预留8字符给标记
      // 保留最重要的2个
      description = uniqueSounds.slice(0, 2).join('、');
    }
    
    if (description.length > maxChars - 8) {
      description = uniqueSounds[0] || '环境氛围音';
    }
    
    return description;
  }

  /**
   * 从指定类型中选择音效
   * @private
   */
  _selectSoundsFromType(type, sceneDescription, count) {
    const typeMap = NIRATH_SOUND_MAP[type] || NIRATH_SOUND_MAP['terrain'];
    
    // 尝试精确匹配子类型
    let matchedSubType = null;
    for (const [subType, sounds] of Object.entries(typeMap)) {
      if (sceneDescription.includes(subType)) {
        matchedSubType = subType;
        break;
      }
    }
    
    // 如果找到精确匹配，使用该子类型
    if (matchedSubType && typeMap[matchedSubType]) {
      const sounds = typeMap[matchedSubType];
      return this._shuffleArray(sounds).slice(0, count);
    }
    
    // 否则，从该类型的所有音效中随机选取
    const allSounds = Object.values(typeMap).flat();
    return this._shuffleArray(allSounds).slice(0, count);
  }

  /**
   * 打乱数组（Fisher-Yates）
   * @private
   */
  _shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * 主入口：为镜头设计环境音效
   * @param {Object} shot - 镜头对象
   * @param {Object} options - 配置选项
   * @returns {string} - 【环境音效】字段内容（不含标记）
   */
  design(shot, options = {}) {
    const maxChars = options.maxChars || this.maxChars;
    
    // 提取场景描述（从visualPrompt或环境相关字段）
    const sceneDescription = this._extractSceneDescription(shot);
    
    // 分析场景
    const analysis = this.analyzeScene(sceneDescription);
    
    // 生成音效描述
    const soundDescription = this.generateSoundDescription(analysis, sceneDescription, maxChars);
    
    return soundDescription;
  }

  /**
   * 从shot中提取场景描述
   * @private
   */
  _extractSceneDescription(shot) {
    // 优先从visualPrompt中提取环境相关描述
    if (shot.visualPrompt) {
      return shot.visualPrompt;
    }
    
    // 其次从环境布景字段
    if (shot.environmentDesign) {
      return shot.environmentDesign;
    }
    
    // 从prompt中提取（如果已生成）
    if (shot.prompt) {
      // 尝试提取环境描述部分（在【环境质感】或背景描述中）
      return shot.prompt;
    }
    
    // 从叙事描述中提取
    if (shot.narration) {
      return shot.narration;
    }
    
    return '';
  }
}

// ===== 便捷函数 =====

/**
 * 为镜头生成【环境音效】字段（带标记）
 * @param {Object} shot - 镜头对象
 * @param {Object} options - 配置
 * @returns {string} - 完整字段，如 "【环境音效】磁丝树金属般轻响、远处流水潺潺"
 */
function generateAmbientSoundField(shot, options = {}) {
  const designer = new AmbientSoundDesigner();
  const description = designer.design(shot, options);
  
  if (!description) return '';
  
  return `【环境音效】${description}`;
}

/**
 * 批量为镜头列表生成环境音效
 * @param {Array} shots - 镜头数组
 * @returns {Object} - 映射 { shotId: soundField }
 */
function batchGenerateAmbientSounds(shots) {
  const designer = new AmbientSoundDesigner();
  const result = {};
  
  for (const shot of shots) {
    result[shot.id] = designer.design(shot);
  }
  
  return result;
}

module.exports = {
  AmbientSoundDesigner,
  generateAmbientSoundField,
  batchGenerateAmbientSounds,
  NIRATH_SOUND_MAP,
  SCENE_KEYWORDS
};

// ===== 测试 =====
if (require.main === module) {
  console.log('🎵 Ambient Sound Designer v1.0 — Nirath环境音效设计测试\n');
  
  const designer = new AmbientSoundDesigner();
  
  // 测试1: 磁丝树森林场景
  const shot1 = {
    id: 'S01',
    visualPrompt: '钩吾山山麓，磁丝树森林，荧光孢子飘散，液态金属溪流穿过林间'
  };
  console.log('=== 场景1: 磁丝树森林 ===');
  console.log('  分析:', designer.analyzeScene(shot1.visualPrompt));
  console.log('  音效:', generateAmbientSoundField(shot1));
  
  // 测试2: 弱水河岸场景
  const shot2 = {
    id: 'S02', 
    visualPrompt: '弱水河岸，龙骨山脉背景，旋龟在水中游动，远处有鸟类飞过'
  };
  console.log('\n=== 场景2: 弱水河岸 ===');
  console.log('  分析:', designer.analyzeScene(shot2.visualPrompt));
  console.log('  音效:', generateAmbientSoundField(shot2));
  
  // 测试3: 青铜废墟场景
  const shot3 = {
    id: 'S03',
    visualPrompt: '不周山青铜废墟，磁石平原，双恒星光照，饕餮在废墟中徘徊'
  };
  console.log('\n=== 场景3: 青铜废墟 ===');
  console.log('  分析:', designer.analyzeScene(shot3.visualPrompt));
  console.log('  音效:', generateAmbientSoundField(shot3));
  
  // 测试4: 通用场景
  const shot4 = {
    id: 'S04',
    visualPrompt: '小G站在开阔地带，看着远处的风景'
  };
  console.log('\n=== 场景4: 通用场景 ===');
  console.log('  分析:', designer.analyzeScene(shot4.visualPrompt));
  console.log('  音效:', generateAmbientSoundField(shot4));
  
  console.log('\n✅ Ambient Sound Designer v1.0 测试完成');
}
