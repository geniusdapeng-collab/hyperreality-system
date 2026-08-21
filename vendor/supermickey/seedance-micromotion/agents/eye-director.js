/**
 * Eye Director Agent v9.2.0-Peng
 * 眼神导演 — 精确设计角色的眼神
 * 基于眼神交流心理学理论
 */

const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MOTION_LIBRARY = JSON.parse(fss.readFileSync(path.join(DATA_DIR, 'motion-library.json'), 'utf8'));

class EyeDirectorAgent {
  constructor() {
    this.library = MOTION_LIBRARY.eyeMicroMovements;
    this.directionPsychology = MOTION_LIBRARY.eyeDirectionPsychology;
  }

  /**
   * 为单个镜头生成眼神增强
   */
  enhance(shot, context = {}) {
    const eyeType = this._resolveEyeType(shot, context);
    const direction = this._resolveDirection(shot, context);
    const cameraDistance = shot.cameraDistance || 'medium';
    
    const eyeLib = this.library[eyeType] || this.library['theLock'];
    
    // 构建眼神描述
    const microDescriptions = this._buildMicroDescriptions(eyeLib, direction, cameraDistance);
    
    // 生成增强提示词
    const seedancePrompt = this._buildSeedancePrompt(shot, microDescriptions, eyeLib);
    
    return {
      shotId: shot.shotId,
      agent: 'EyeDirector',
      eyeType: eyeType,
      direction: direction,
      directionPsychology: this.directionPsychology[direction] || '',
      cameraDistance: cameraDistance,
      microDescriptions: microDescriptions,
      seedanceCue: eyeLib.seedanceCue || '',
      seedancePrompt: seedancePrompt,
      seedanceCompatible: true
    };
  }

  _resolveEyeType(shot, context) {
    if (shot.eyeType) return shot.eyeType;
    if (context.eyeType) return context.eyeType;
    
    const emotion = (shot.emotion || context.emotion || '').toLowerCase();
    const typeMap = {
      'anger': 'theLock',
      'fear': 'theDart',
      'sadness': 'theWet',
      'sad': 'theWet',
      'joy': 'theBlink',
      'disgust': 'theBreak',
      'contempt': 'theBreak',
      'surprise': 'theGlaze',
      'nervous': 'theScan',
      'thinking': 'theGlaze',
      'determined': 'theLock'
    };
    
    return typeMap[emotion] || 'theLock';
  }

  _resolveDirection(shot, context) {
    if (shot.eyeDirection) return shot.eyeDirection;
    if (context.eyeDirection) return context.eyeDirection;
    
    const emotion = (shot.emotion || context.emotion || '').toLowerCase();
    const dirMap = {
      'anger': 'straight',
      'fear': 'up-right',
      'sadness': 'down-left',
      'sad': 'down-left',
      'joy': 'straight',
      'disgust': 'down-right',
      'contempt': 'straight',
      'surprise': 'up-right',
      'thinking': 'up-left',
      'determined': 'straight'
    };
    
    return dirMap[emotion] || 'straight';
  }

  _buildMicroDescriptions(eyeLib, direction, cameraDistance) {
    const descriptions = [];
    const isCloseUp = cameraDistance.includes('特写') || cameraDistance.includes('close');
    
    if (isCloseUp) {
      descriptions.push(`眼神类型:${eyeLib.name}`);
      descriptions.push(`眼神状态:${eyeLib.seedanceCue || ''}`);
      descriptions.push(`视线方向:${this.directionPsychology[direction] || direction}`);
      if (eyeLib.duration) descriptions.push(`持续时间:${eyeLib.duration}`);
    } else {
      descriptions.push(`眼神类型:${eyeLib.name}`);
      descriptions.push(`视线方向:${direction}`);
    }
    
    return descriptions;
  }

  _buildSeedancePrompt(shot, microDescriptions, eyeLib) {
    const originalPrompt = shot.originalPrompt || shot.description || '';
    
    // 眼神增强片段
    const eyeText = eyeLib.seedanceCue || '';
    
    return {
      original: originalPrompt,
      enhanced: eyeText,
      fullPrompt: eyeText ? `${originalPrompt}, ${eyeText}` : originalPrompt
    };
  }
}

module.exports = { EyeDirectorAgent };