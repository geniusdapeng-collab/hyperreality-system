/**
 * Breath Engine Agent v9.2.0-Peng
 * 呼吸引擎 — 为角色注入呼吸节奏
 */

const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MOTION_LIBRARY = JSON.parse(fss.readFileSync(path.join(DATA_DIR, 'motion-library.json'), 'utf8'));

class BreathEngineAgent {
  constructor() {
    this.library = MOTION_LIBRARY.breathPatterns;
  }

  /**
   * 为单个镜头生成呼吸增强
   */
  enhance(shot, context = {}) {
    const pattern = this._resolvePattern(shot, context);
    const duration = shot.duration || 5;
    const cameraDistance = shot.cameraDistance || 'medium';
    
    const breathLib = this.library[pattern] || this.library['calm'];
    
    // 构建呼吸微动作描述
    const microDescriptions = this._buildMicroDescriptions(breathLib, cameraDistance);
    
    // 构建呼吸时间轴
    const breathTimeline = this._buildBreathTimeline(duration, pattern);
    
    // 生成增强提示词
    const seedancePrompt = this._buildSeedancePrompt(shot, microDescriptions, breathLib);
    
    return {
      shotId: shot.shotId,
      agent: 'BreathEngine',
      pattern: pattern,
      rate: breathLib.rate || '12-16次/分钟',
      visualCue: breathLib.visualCue || '',
      cameraDistance: cameraDistance,
      microDescriptions: microDescriptions,
      breathTimeline: breathTimeline,
      seedancePrompt: seedancePrompt,
      seedanceCompatible: true
    };
  }

  _resolvePattern(shot, context) {
    if (shot.breathPattern) return shot.breathPattern;
    if (context.breathPattern) return context.breathPattern;
    
    const emotion = (shot.emotion || context.emotion || '').toLowerCase().trim();
    const patternMap = {
      '愤怒': 'angry', '生气': 'angry', '怒': 'angry', 'anger': 'angry',
      '恐惧': 'fearful', '害怕': 'fearful', '惊恐': 'fearful', 'fear': 'fearful',
      '悲伤': 'sad', '难过': 'sad', '伤心': 'sad', 'sadness': 'sad', 'sad': 'sad',
      '喜悦': 'calm', '开心': 'calm', '高兴': 'calm', 'joy': 'calm',
      '厌恶': 'fearful', 'disgust': 'fearful',
      '轻蔑': 'calm', '蔑视': 'calm', 'contempt': 'calm',
      '惊讶': 'fearful', 'surprise': 'fearful',
      '紧张': 'anticipation', 'nervous': 'anticipation',
      '疲惫': 'exertion', 'exertion': 'exertion',
      '冷静': 'calm', '平静': 'calm', 'calm': 'calm',
      '期待': 'anticipation', 'anticipation': 'anticipation'
    };
    
    return patternMap[emotion] || 'calm';
  }

  _buildMicroDescriptions(breathLib, cameraDistance) {
    const descriptions = [];
    const isCloseUp = cameraDistance.includes('特写') || cameraDistance.includes('close');
    
    if (isCloseUp) {
      descriptions.push(`呼吸节奏:${breathLib.rate || ''}`);
      descriptions.push(`胸部起伏:${breathLib.chestMovement || ''}`);
      descriptions.push(`视觉表现:${breathLib.visualCue || ''}`);
    } else {
      descriptions.push(`呼吸表现:${breathLib.visualCue || ''}`);
    }
    
    return descriptions;
  }

  _buildBreathTimeline(duration, pattern) {
    const timeline = [];
    const breathDuration = pattern === 'angry' ? 1.0 : (pattern === 'fearful' ? 0.8 : 3.0);
    const steps = Math.floor(duration / breathDuration);
    
    for (let i = 0; i < Math.min(steps, 8); i++) {
      const t = i * breathDuration;
      timeline.push({
        time: parseFloat(t.toFixed(1)),
        phase: i % 2 === 0 ? 'inhale' : 'exhale',
        action: i % 2 === 0 ? '吸气, 胸部隆起' : '呼气, 胸部回落'
      });
    }
    
    return timeline;
  }

  _buildSeedancePrompt(shot, microDescriptions, breathLib) {
    const originalPrompt = shot.originalPrompt || shot.description || '';
    const cue = breathLib.visualCue || '';
    
    return {
      original: originalPrompt,
      enhanced: cue,
      fullPrompt: cue ? `${originalPrompt}, ${cue}` : originalPrompt
    };
  }
}

module.exports = { BreathEngineAgent };