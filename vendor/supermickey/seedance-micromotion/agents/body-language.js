/**
 * Body Language Agent v9.2.0-Peng
 * 身体语言官 — 为角色的身体注入微动作
 * 基于Damasio躯体标记理论
 */

const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MOTION_LIBRARY = JSON.parse(fss.readFileSync(path.join(DATA_DIR, 'motion-library.json'), 'utf8'));

class BodyLanguageAgent {
  constructor() {
    this.library = MOTION_LIBRARY.bodyMicroLanguage;
    this.characterBaselines = {};
  }

  /**
   * 为单个镜头生成身体微动作增强
   */
  enhance(shot, context = {}) {
    const stance = this._resolveStance(shot, context);
    const characterId = shot.character || shot.characterId || 'default';
    const cameraDistance = shot.cameraDistance || 'medium';
    
    const bodyLib = this.library[stance] || this.library['defensive'];
    
    // 构建身体微动作描述
    const microDescriptions = this._buildMicroDescriptions(bodyLib, cameraDistance);
    
    // 生成增强提示词
    const seedancePrompt = this._buildSeedancePrompt(shot, microDescriptions, stance);
    
    return {
      shotId: shot.shotId,
      agent: 'BodyLanguage',
      stance: stance,
      cameraDistance: cameraDistance,
      microDescriptions: microDescriptions,
      movements: bodyLib.movements || {},
      seedancePrompt: seedancePrompt,
      seedanceCompatible: true
    };
  }

  _resolveStance(shot, context) {
    // 优先级: shot.stance > context.stance > 从emotion推断 > 默认defensive
    if (shot.stance) return shot.stance;
    if (context.stance) return context.stance;
    
    const emotion = (shot.emotion || context.emotion || '').toLowerCase().trim();
    const map = {
      '愤怒': 'dominant', '生气': 'dominant', '怒': 'dominant', 'anger': 'dominant',
      '恐惧': 'defensive', '害怕': 'defensive', '惊恐': 'defensive', 'fear': 'defensive',
      '悲伤': 'vulnerable', '难过': 'vulnerable', '伤心': 'vulnerable', 'sadness': 'vulnerable', 'sad': 'vulnerable',
      '喜悦': 'dominant', '开心': 'dominant', '高兴': 'dominant', 'joy': 'dominant',
      '厌恶': 'defensive', 'disgust': 'defensive',
      '轻蔑': 'dominant', '蔑视': 'dominant', 'contempt': 'dominant',
      '惊讶': 'defensive', 'surprise': 'defensive',
      '紧张': 'deceptive', 'nervous': 'deceptive',
      '喜欢': 'attraction', '爱': 'attraction', 'attraction': 'attraction',
      '压抑': 'suppressedEmotion', 'suppressed': 'suppressedEmotion'
    };
    
    return map[emotion] || 'defensive';
  }

  _buildMicroDescriptions(bodyLib, cameraDistance) {
    const movements = bodyLib.movements || {};
    const descriptions = [];
    const isCloseUp = cameraDistance.includes('特写') || cameraDistance.includes('close');
    
    if (isCloseUp) {
      // 特写时重点描述上半身
      if (movements.shoulders) descriptions.push(`肩部:${movements.shoulders}`);
      if (movements.hands) descriptions.push(`手部:${movements.hands}`);
      if (movements.head) descriptions.push(`头部:${movements.head}`);
      if (movements.jaw) descriptions.push(`下颌:${movements.jaw}`);
    } else {
      // 中远景时描述全身
      if (movements.shoulders) descriptions.push(`肩部:${movements.shoulders}`);
      if (movements.torso) descriptions.push(`躯干:${movements.torso}`);
      if (movements.hands) descriptions.push(`手部:${movements.hands}`);
      if (movements.feet) descriptions.push(`脚部:${movements.feet}`);
      if (movements.head) descriptions.push(`头部:${movements.head}`);
      if (movements.posture) descriptions.push(`姿态:${movements.posture}`);
    }
    
    return descriptions;
  }

  _buildSeedancePrompt(shot, microDescriptions, stance) {
    const originalPrompt = shot.originalPrompt || shot.description || '';
    
    // 提取动作描述部分
    const actionPart = this._extractActionPart(originalPrompt);
    
    let enhancedAction = actionPart;
    if (microDescriptions.length > 0) {
      const microTexts = microDescriptions.map(d => {
        const text = d.replace(/^[^:]+:/, '').trim();
        return `**${text}**`;
      }).join(', ');
      
      enhancedAction = actionPart + (actionPart.endsWith(',') ? ' ' : ', ') + microTexts;
    }
    
    return {
      original: originalPrompt,
      enhanced: enhancedAction,
      fullPrompt: this._assembleFullPrompt(originalPrompt, enhancedAction)
    };
  }

  _extractActionPart(prompt) {
    if (!prompt) return '';
    // 简单策略：取后半部分作为动作
    const parts = prompt.split(',');
    return parts.slice(1).join(',').trim() || prompt;
  }

  _assembleFullPrompt(original, enhancedAction) {
    if (!original) return enhancedAction;
    return original; // 简化版：原始提示词不变，身体增强作为附加
  }
}

module.exports = { BodyLanguageAgent };