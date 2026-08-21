/**
 * Face Sculptor Agent v9.2.0-Peng
 * 面部雕塑师 — 为每个角色的面部注入微表情细节
 * 基于 Paul Ekman 面部动作编码系统(FACS)
 */

const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MOTION_LIBRARY = JSON.parse(fss.readFileSync(path.join(DATA_DIR, 'motion-library.json'), 'utf8'));

class FaceSculptorAgent {
  constructor() {
    this.library = MOTION_LIBRARY.facialMicroExpressions;
    this.intensityMap = { 'low': 1, 'medium': 3, 'high': 5 };
  }

  /**
   * 为单个镜头生成面部微表情增强
   * @param {Object} shot - 镜头信息
   * @param {Object} context - 上下文（角色状态、PersonaVault数据）
   * @returns {Object} 面部增强结果
   */
  enhance(shot, context = {}) {
    const emotion = this._resolveEmotion(shot, context);
    const intensity = this._resolveIntensity(shot, context);
    const cameraDistance = shot.cameraDistance || 'medium';
    
    const faceLib = this.library[emotion] || this.library['anger'];
    const intensityLabel = String(intensity);
    const levelDescription = faceLib.intensityLevels[intensityLabel] || faceLib.intensityLevels['3'];
    
    // 构建微表情种子提示词片段
    const microDescriptions = this._buildMicroDescriptions(faceLib, intensity, cameraDistance);
    
    // 构建时间轴微动作
    const microActions = this._buildMicroActionTimeline(shot.duration || 5, faceLib, intensity);
    
    // 生成增强后的提示词片段
    const seedancePrompt = this._buildSeedancePrompt(shot, microDescriptions, emotion, intensity);
    
    return {
      shotId: shot.shotId,
      agent: 'FaceSculptor',
      emotion: emotion,
      intensity: intensity,
      intensityDescription: levelDescription,
      cameraDistance: cameraDistance,
      microDescriptions: microDescriptions,
      microActions: microActions,
      seedancePrompt: seedancePrompt,
      seedanceCompatible: true
    };
  }

  /**
   * 将情绪阶段(emotionPhase)映射到具体微表情库情绪
   * 基于镜头类型和叙事弧线分配微表情
   * @param {string} emotionPhase - 情绪阶段 (establishing/rising/building/climax/resolve/opening)
   * @param {string} shotType - 镜头类型
   * @returns {string} 微表情库情绪关键词
   */
  _mapEmotionPhase(emotionPhase, shotType) {
    // v6.2-patch96: 场景化情绪映射（告别一套微表情打天下）
    const phaseMap = {
      'establishing': 'surprise',      // 建立镜头：敬畏、好奇、惊叹
      'opening': 'surprise',           // 开场： awe/ wonder
      'rising': 'surprise',            // 发展：紧张感递增，好奇
      'building': 'fear',              // 揭示真相：紧张、不安
      'climax': 'anger',              // 高潮：紧张、激烈（仅适度）
      'resolve': 'joy',               // 觉悟：温暖、治愈、释然
      'conflict': 'anger',             // 冲突：激烈（仅适度）
      'reveal': 'surprise',            // 揭示：敬畏、惊叹
      'setup': 'surprise',             // 建立：好奇
      'resolution': 'joy'               // 收尾：温暖
    };
    
    // 镜头类型覆盖（特殊镜头类型可覆盖默认映射）
    const shotTypeOverride = {
      'opening': 'surprise',
      'resolution': 'joy',
      'climax': 'anger'
    };
    
    const baseEmotion = phaseMap[emotionPhase] || 'surprise';
    return shotTypeOverride[shotType] || baseEmotion;
  }

  _resolveEmotion(shot, context) {
    // v6.2-patch96: 优先使用 emotionPhase 进行场景化映射
    // 注意：上游可能传入 emotion 字段（值为 emotionPhase），需同时检查
    const emotionPhase = shot.emotionPhase || shot.emotion || context.emotionPhase || context.emotion;
    if (emotionPhase && typeof emotionPhase === 'string') {
      // 如果 emotionPhase 是情绪阶段（如 establishing），映射到具体微表情库情绪
      const mapped = this._mapEmotionPhase(emotionPhase, shot.shotType || shot.type || '');
      return mapped;
    }
    
    // 降级：使用旧版情绪解析
    const raw = shot.emotion || context.characterState?.currentEmotion || context.emotion || 'surprise';
    const map = {
      '愤怒': 'anger', '生气': 'anger', '怒': 'anger',
      '悲伤': 'sadness', '难过': 'sadness', '伤心': 'sadness', '哀': 'sadness', 'sad': 'sadness',
      '喜悦': 'joy', '开心': 'joy', '高兴': 'joy', '快乐': 'joy',
      '恐惧': 'fear', '害怕': 'fear', '惊恐': 'fear', '惧': 'fear',
      '厌恶': 'disgust', '恶心': 'disgust', '厌': 'disgust',
      '轻蔑': 'contempt', '蔑视': 'contempt', '傲慢': 'contempt',
      '惊讶': 'surprise', '惊': 'surprise',
      '坚定': 'dominant', '自信': 'dominant',
      '压抑': 'suppressedEmotion'
    };
    const key = raw.toLowerCase().trim();
    return map[key] || key || 'surprise';
  }

  _resolveIntensity(shot, context) {
    // 注意：0 是合法值（会被 Math.max(1,0) 降级为1），不能用 if(shot.emotionIntensity) 判断
    if (shot.emotionIntensity !== undefined && shot.emotionIntensity !== null) {
      return Math.min(5, Math.max(1, parseInt(shot.emotionIntensity)));
    }
    if (context.characterState?.emotionIntensity !== undefined) {
      return Math.min(5, Math.max(1, parseInt(context.characterState.emotionIntensity)));
    }
    return 3;
  }

  _buildMicroDescriptions(faceLib, intensity, cameraDistance) {
    const micro = faceLib.micro || {};
    const descriptions = [];
    
    // 根据景别选择重点
    const isCloseUp = cameraDistance.includes('特写') || cameraDistance.includes('close');
    
    if (isCloseUp) {
      // 特写时重点描述面部细节
      if (micro.eyebrow) descriptions.push(`眉部:${micro.eyebrow}`);
      if (micro.forehead) descriptions.push(`额头:${micro.forehead}`);
      if (micro.eyes) descriptions.push(`眼部:${micro.eyes}`);
      if (micro.nose) descriptions.push(`鼻部:${micro.nose}`);
      if (micro.mouth) descriptions.push(`嘴部:${micro.mouth}`);
      if (micro.jaw) descriptions.push(`下颌:${micro.jaw}`);
      if (micro.skin) descriptions.push(`皮肤:${micro.skin}`);
      if (micro.tears) descriptions.push(`眼泪:${micro.tears}`);
      if (micro.cheeks) descriptions.push(`脸颊:${micro.cheeks}`);
    } else {
      // 中远景时简化面部描述
      if (micro.eyes) descriptions.push(`眼部:${micro.eyes}`);
      if (micro.mouth) descriptions.push(`嘴部:${micro.mouth}`);
    }
    
    return descriptions;
  }

  _buildMicroActionTimeline(duration, faceLib, intensity) {
    const actions = [];
    const micro = faceLib.micro || {};
    const step = duration / 5; // 分5个时间点
    
    const entries = Object.entries(micro).filter(([k]) => k !== 'authenticityCheck' && k !== 'duration');
    
    entries.forEach(([part, desc], i) => {
      if (i < 8) { // 最多8个微动作
        actions.push({
          time: parseFloat((i * step).toFixed(1)),
          bodyPart: part,
          action: desc.substring(0, 60) // 截断过长描述
        });
      }
    });
    
    return actions;
  }

  _buildSeedancePrompt(shot, microDescriptions, emotion, intensity) {
    const characterName = shot.character || shot.characterName || '角色';
    const originalPrompt = shot.originalPrompt || shot.description || '';
    
    // 提取原始提示词中的角色描述部分
    const characterPart = this._extractCharacterPart(originalPrompt);
    
    // 将微表情注入到角色描述中
    let enhancedCharacter = characterPart;
    
    if (microDescriptions.length > 0) {
      const microTexts = microDescriptions.map(d => {
        const text = d.replace(/^[^:]+:/, '').trim();
        return `**${text}**`;
      }).join(', ');
      
      // 在角色描述末尾注入微表情
      enhancedCharacter = characterPart + (characterPart.endsWith(',') ? ' ' : ', ') + microTexts;
    }
    
    // 情绪增强
    const emotionEnhancement = this._getEmotionEnhancement(emotion, intensity);
    
    return {
      original: originalPrompt,
      enhanced: enhancedCharacter,
      emotionEnhanced: emotionEnhancement,
      fullPrompt: this._assembleFullPrompt(originalPrompt, enhancedCharacter, emotionEnhancement)
    };
  }

  _extractCharacterPart(prompt) {
    // 简单提取：取逗号前的角色名部分
    if (!prompt) return '';
    const parts = prompt.split(',');
    return parts[0] || '';
  }

  _getEmotionEnhancement(emotion, intensity) {
    const enhancements = {
      'anger': { 1: '眉心微蹙', 3: '眉头紧锁,咬肌微鼓', 5: '眉心竖纹清晰可见,下颌颤抖,面部泛红' },
      'sadness': { 1: '眼眶湿润', 3: '泪珠在眼角聚集', 5: '泪痕划过面颊,下巴颤抖' },
      'joy': { 1: '嘴角上扬', 3: '苹果肌隆起,鱼尾纹可见', 5: '灿烂笑容,面部光泽' },
      'fear': { 1: '瞳孔微扩', 3: '瞳孔放大,面部苍白', 5: '瞳孔极大,眼白全露' },
      'disgust': { 1: '鼻根微皱', 3: '皱鼻撇嘴,半眯眼', 5: '明显厌恶表情' },
      'contempt': { 1: '单侧嘴角微扬', 3: '明显不对称笑容', 5: '高傲轻蔑' },
      'surprise': { 1: '眉毛微挑', 3: '双眉上扬,眼睛圆睁', 5: '极度惊讶,眉毛弓形上扬' }
    };
    
    const emoMap = enhancements[emotion] || enhancements['anger'];
    return emoMap[intensity] || emoMap[3];
  }

  _assembleFullPrompt(original, enhancedCharacter, emotionEnhanced) {
    if (!original) return enhancedCharacter;
    
    // 替换原始角色描述为增强版
    let full = original;
    const charPart = this._extractCharacterPart(original);
    if (charPart && enhancedCharacter) {
      full = full.replace(charPart, enhancedCharacter);
    }
    
    // 在情绪词附近注入增强
    const emotionWords = ['愤怒', '悲伤', '喜悦', '恐惧', '厌恶', '轻蔑', '惊讶', '开心', '生气', '害怕'];
    for (const word of emotionWords) {
      if (full.includes(word)) {
        full = full.replace(word, `${word}**${emotionEnhanced}**`);
        break;
      }
    }
    
    return full;
  }
}

module.exports = { FaceSculptorAgent };