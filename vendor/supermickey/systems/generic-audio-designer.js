/**
 * Generic Audio Designer v1.0 — 科普视频专用音效设计Agent
 * 为每个镜头根据具体场景环境生成Diegetic环境音效描述
 * 作为独立字段【音频】注入Seedance Prompt
 * 
 * 设计原则：
 * 1. 纯环境音（Diegetic）——只来自画面内的声音，无音乐/旁白
 * 2. 根据场景环境自适应——根据镜头描述智能匹配
 * 3. 科普视频特征——结合医疗、健康、教育场景
 * 4. 预算控制——约80-100字符，不占用核心视觉描述空间
 */

// ===== 科普视频音效映射库 =====
const EDU_SOUND_MAP = {
  // 片头类
  opening: {
    '警徽': ['警徽金属质感敲击声', '庄重背景音乐渐强', '金属共鸣声'],
    '标题': ['标题滑入时的低频嗡鸣', '金色粒子汇聚细微声响', '背景音乐达到峰值'],
    '通用片头': ['庄重开场音乐', '环境音渐弱', '仪式感音效']
  },
  // 医疗环境类
  medical: {
    '候诊区': ['医院候诊区环境音', '脚步声', '低频交谈声'],
    '诊疗室': ['医疗设备运转声', '键盘敲击声', '纸张翻动声'],
    '实验室': ['仪器运转声', '玻璃器皿碰撞声', '离心机低频嗡鸣'],
    '通用医疗': ['专业医疗环境音', '设备提示音', '空调低鸣']
  },
  // 症状讲解类
  symptom: {
    '肌肉': ['肌肉收缩细微声', '心跳监测仪滴答声', '身体活动声'],
    '尿液': ['液体流动声', '实验室玻璃器皿碰撞声', '水流过滤声'],
    '疼痛': ['紧张氛围低频音', '呼吸声加重', '心跳加速声'],
    '通用症状': ['人体生理音', '环境安静氛围', '专注聆听感']
  },
  // 检查指标类
  lab: {
    '血液检查': ['采血设备声', '试管放置声', '仪器分析声'],
    '尿液检查': ['液体倾倒声', '试纸反应声', '检测设备运转声'],
    '仪器': ['生化分析仪运转声', '打印机出纸声', '电子提示音'],
    '通用检查': ['实验室专业环境音', '设备运转声', '技术人员操作声']
  },
  // 结尾类
  ending: {
    '总结': ['温暖渐弱的环境音', '收尾钟声', '背景音乐渐弱'],
    '呼吁': ['庄重感增强', '环境音清空', '焦点音效'],
    '通用结尾': ['温馨收尾音乐', '环境音淡出', '余韵音效']
  }
};

// ===== 场景关键词识别 =====
const SCENE_KEYWORDS = {
  opening: ['片头', '开场', '标题', '警徽', 'intro', 'opening'],
  medical: ['医院', '医疗', '诊疗', '诊室', '病房', '候诊'],
  symptom: ['症状', '肌肉', '尿液', '疼痛', '不适', '表现'],
  lab: ['检查', '化验', '实验室', '指标', '仪器', '检测'],
  ending: ['结尾', '结束', '总结', '收束', 'ending', 'close']
};

class GenericAudioDesigner {
  constructor() {
    this.maxChars = 100; // 音频字段预算
    this.diegeticRule = '纯环境音（Diegetic），无音乐/旁白/人声';
  }

  /**
   * 分析场景描述，识别环境类型
   * @param {string} sceneDescription - 场景描述文本
   * @param {string} shotType - 镜头类型
   * @returns {Object} - 识别到的环境类型及其置信度
   */
  analyzeScene(sceneDescription, shotType = '') {
    if (!sceneDescription) return { primary: 'generic', confidence: 0 };
    
    const desc = sceneDescription.toLowerCase();
    const type = (shotType || '').toLowerCase();
    
    const scores = {};
    for (const [category, keywords] of Object.entries(SCENE_KEYWORDS)) {
      scores[category] = 0;
      for (const kw of keywords) {
        if (desc.includes(kw.toLowerCase()) || type.includes(kw.toLowerCase())) {
          scores[category] += 1;
        }
      }
    }
    
    // 找出最高分
    let maxScore = 0;
    let primary = 'generic';
    for (const [category, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        primary = category;
      }
    }
    
    return { primary, confidence: maxScore };
  }

  /**
   * 为单个镜头生成音效描述
   * @param {Object} shot - 镜头数据
   * @returns {string} - 音效描述字符串
   */
  generateForShot(shot) {
    const sceneDesc = shot.scene || shot.sceneDescription || '';
    const shotType = shot.type || '';
    
    // 分析场景类型
    const analysis = this.analyzeScene(sceneDesc, shotType);
    const category = analysis.primary;
    
    // 根据场景类型选择音效
    const soundPool = EDU_SOUND_MAP[category] || EDU_SOUND_MAP.medical;
    
    // 根据场景描述选择最匹配的子类型
    let subType = '通用' + category;
    for (const [key, sounds] of Object.entries(soundPool)) {
      if (sceneDesc.includes(key) || sceneDesc.includes(key.toLowerCase())) {
        subType = key;
        break;
      }
    }
    
    // 获取音效列表
    const sounds = soundPool[subType] || soundPool[Object.keys(soundPool)[0]];
    
    // 组合2-3个音效元素
    const selected = sounds.slice(0, Math.min(3, sounds.length));
    
    // 构建音效描述
    const intensity = this._calculateIntensity(shot);
    const spatial = this._calculateSpatial(shot);
    
    return `L1:${selected.join('，')},${intensity} | L2:${spatial} | L3:氛围音,-22LUFS`;
  }

  /**
   * 计算音效强度
   */
  _calculateIntensity(shot) {
    const emotion = (shot.emotionPhase || '').toLowerCase();
    const type = (shot.type || '').toLowerCase();
    
    if (emotion.includes('climax') || emotion.includes('tension') || type.includes('climax')) {
      return '强,突出';
    }
    if (emotion.includes('resolve') || emotion.includes('calm') || type.includes('ending')) {
      return '弱,渐弱';
    }
    return '中等,自然';
  }

  /**
   * 计算空间感
   */
  _calculateSpatial(shot) {
    const sceneDesc = (shot.scene || '').toLowerCase();
    
    if (sceneDesc.includes('室内') || sceneDesc.includes('房间')) {
      return '室内空间感,混响适中';
    }
    if (sceneDesc.includes('室外') || sceneDesc.includes('户外')) {
      return '开阔空间感,自然扩散';
    }
    if (sceneDesc.includes('实验室') || sceneDesc.includes('检查')) {
      return '专业空间感,干净清晰';
    }
    return '标准空间感,自然扩散';
  }

  /**
   * 批量生成音效
   * @param {Array} shots - 镜头数组
   * @returns {Array} - 带音效描述的镜头数组
   */
  generateForShots(shots) {
    return shots.map(shot => ({
      ...shot,
      audioDescription: this.generateForShot(shot)
    }));
  }
}

// ========== 便捷方法 ==========
function generateAudioForShot(shot) {
  const designer = new GenericAudioDesigner();
  return designer.generateForShot(shot);
}

function generateAudioForShots(shots) {
  const designer = new GenericAudioDesigner();
  return designer.generateForShots(shots);
}

// ========== 导出 ==========
module.exports = {
  GenericAudioDesigner,
  generateAudioForShot,
  generateAudioForShots
};

// CLI测试入口
if (require.main === module) {
  console.log('🎵 科普视频音效设计Agent测试模式');
  
  const designer = new GenericAudioDesigner();
  
  // 测试不同场景
  const testShots = [
    { id: 'S00', scene: '片头-开场', type: 'opening', emotionPhase: 'curiosity' },
    { id: 'S01', scene: '开场介绍', type: 'intro', emotionPhase: 'curiosity' },
    { id: 'S02', scene: '核心症状讲解', type: 'explanation', emotionPhase: 'tension' },
    { id: 'S04', scene: '实验室检查', type: 'explanation', emotionPhase: 'tension' },
    { id: 'S06', scene: '结尾', type: 'ending', emotionPhase: 'resolve' }
  ];
  
  for (const shot of testShots) {
    const audio = designer.generateForShot(shot);
    console.log(`\n${shot.id} (${shot.scene}):`);
    console.log(`  🎵 ${audio}`);
  }
}
