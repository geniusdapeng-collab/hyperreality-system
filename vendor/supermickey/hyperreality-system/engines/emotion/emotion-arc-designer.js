/**
 * Emotion Arc Designer — 情绪弧线设计器 (SuperMickey)
 *
 * 融入点: Layer 1 (剧本生成时)
 * 在 ScriptEngine 中集成，根据情绪档案设计情绪弧线
 *
 * 核心能力：
 * 1. 根据情绪档案设计情绪弧线（build/release/wave/collapse）
 * 2. 为每个场景分配情绪目标（强度 + 标签）
 * 3. 与叙事节奏引擎联动（三幕式 → 情绪弧线）
 * 4. 输出情绪弧线：{ curveType, stages, targets }
 */

class EmotionArcDesigner {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;

    // 情绪弧线模板
    this.emotionCurves = {
      build: {
        description: '渐进式情绪累积',
        stages: [
          { pos: 0, intensity: 0.2, label: 'establish', emotion: 'calm' },
          { pos: 0.2, intensity: 0.3, label: 'develop', emotion: 'curiosity' },
          { pos: 0.4, intensity: 0.5, label: 'escalate', emotion: 'tension' },
          { pos: 0.6, intensity: 0.7, label: 'intensify', emotion: 'anticipation' },
          { pos: 0.8, intensity: 0.9, label: 'climax', emotion: 'peak' },
          { pos: 1.0, intensity: 1.0, label: 'release', emotion: 'catharsis' }
        ]
      },
      release: {
        description: '从高峰释放式回落',
        stages: [
          { pos: 0, intensity: 1.0, label: 'impact', emotion: 'shock' },
          { pos: 0.2, intensity: 0.8, label: 'aftermath', emotion: 'confusion' },
          { pos: 0.4, intensity: 0.6, label: 'process', emotion: 'reflection' },
          { pos: 0.6, intensity: 0.4, label: 'settle', emotion: 'acceptance' },
          { pos: 0.8, intensity: 0.2, label: 'calm', emotion: 'peace' },
          { pos: 1.0, intensity: 0.1, label: 'resolution', emotion: 'closure' }
        ]
      },
      wave: {
        description: '波浪式情绪起伏',
        stages: [
          { pos: 0, intensity: 0.3, label: 'calm', emotion: 'serenity' },
          { pos: 0.25, intensity: 0.6, label: 'rise', emotion: 'excitement' },
          { pos: 0.5, intensity: 0.3, label: 'fall', emotion: 'contemplation' },
          { pos: 0.75, intensity: 0.8, label: 'rise2', emotion: 'intensity' },
          { pos: 0.9, intensity: 1.0, label: 'peak', emotion: 'catharsis' },
          { pos: 1.0, intensity: 0.4, label: 'resolve', emotion: 'peace' }
        ]
      },
      collapse: {
        description: '情绪崩塌式下落',
        stages: [
          { pos: 0, intensity: 0.8, label: 'peak', emotion: 'euphoria' },
          { pos: 0.15, intensity: 0.7, label: 'crack', emotion: 'doubt' },
          { pos: 0.3, intensity: 0.5, label: 'collapse', emotion: 'despair' },
          { pos: 0.5, intensity: 0.3, label: 'fall', emotion: 'emptiness' },
          { pos: 0.75, intensity: 0.2, label: 'bottom', emotion: 'void' },
          { pos: 1.0, intensity: 0.1, label: 'frozen', emotion: 'numb' }
        ]
      }
    };

    // 情绪映射（英文 → 中文描述词）
    this.emotionDescriptors = {
      calm: '平静的', curiosity: '好奇的', tension: '紧张的', anticipation: '期待的',
      peak: '极致的', catharsis: '宣泄的', shock: '震惊的', confusion: '困惑的',
      reflection: '沉思的', acceptance: '释然的', peace: '宁静的', closure: '圆满的',
      serenity: '安详的', excitement: '兴奋的', contemplation: '沉思的', intensity: '强烈的',
      euphoria: '狂喜的', doubt: '怀疑的', despair: '绝望的', emptiness: '空虚的',
      void: '虚无的', numb: '麻木的', joy: '喜悦的', sadness: '悲伤的',
      anger: '愤怒的', fear: '恐惧的', surprise: '惊讶的', nostalgia: '怀旧的',
      melancholy: '忧郁的', hope: '充满希望的', relief: '解脱的', awe: '震撼的'
    };
  }

  /**
   * 主入口：设计情绪弧线
   * @param {Object} emotionProfile - 情绪档案（EmotionIntentParser 输出）
   * @param {Object} config - { duration, sceneCount, narrativeMode }
   * @returns {Object} 情绪弧线 { curveType, stages, targets, description }
   */
  design(emotionProfile, config = {}) {
    if (!this.enabled || !emotionProfile) {
      return this._createDefaultArc(config);
    }

    const { primary, secondary, intensity } = emotionProfile;
    const sceneCount = config.sceneCount || 5;

    // 1. 选择情绪曲线类型
    const curveType = this._selectCurveType(primary, secondary, intensity);
    const curve = this.emotionCurves[curveType] || this.emotionCurves.build;

    // 2. 为每个场景分配情绪目标
    const targets = [];
    for (let i = 0; i < sceneCount; i++) {
      const position = sceneCount > 1 ? i / (sceneCount - 1) : 0;
      const target = this._getEmotionTarget(curve, position, primary, secondary);
      targets.push({
        sceneIndex: i,
        position,
        ...target
      });
    }

    return {
      curveType,
      description: curve.description,
      stages: curve.stages,
      targets,
      primaryEmotion: primary,
      secondaryEmotion: secondary,
      baseIntensity: intensity
    };
  }

  /**
   * 获取指定位置的情绪目标
   * @param {number} sceneIndex - 场景索引
   * @param {number} totalScenes - 总场景数
   * @returns {Object} { intensity, label, emotion, descriptor }
   */
  getTargetForScene(arc, sceneIndex, totalScenes) {
    if (!arc || !arc.targets) return null;
    return arc.targets[sceneIndex] || null;
  }

  // ========== 私有方法 ==========

  _selectCurveType(primary, secondary, intensity) {
    // 根据主要情绪选择曲线类型
    const curveMap = {
      joy: 'wave',
      sadness: 'collapse',
      anger: 'build',
      fear: 'build',
      surprise: 'wave',
      nostalgia: 'wave',
      tension: 'build',
      relief: 'release',
      awe: 'build',
      melancholy: 'collapse',
      hope: 'build',
      despair: 'collapse'
    };

    return curveMap[primary] || 'build';
  }

  _getEmotionTarget(curve, position, primary, secondary) {
    // 找到最近的阶段
    let closestStage = curve.stages[0];
    let minDist = Math.abs(curve.stages[0].pos - position);

    for (const stage of curve.stages) {
      const dist = Math.abs(stage.pos - position);
      if (dist < minDist) {
        minDist = dist;
        closestStage = stage;
      }
    }

    // 根据主要情绪调整情绪标签
    let emotion = closestStage.emotion;
    if (primary === 'joy' || primary === 'hope') {
      emotion = this._mapToPositive(emotion);
    } else if (primary === 'sadness' || primary === 'despair') {
      emotion = this._mapToNegative(emotion);
    } else if (primary === 'anger') {
      emotion = this._mapToIntense(emotion);
    } else if (primary === 'nostalgia') {
      emotion = this._mapToNostalgic(emotion);
    }

    return {
      intensity: closestStage.intensity,
      label: closestStage.label,
      emotion,
      descriptor: this.emotionDescriptors[emotion] || this.emotionDescriptors[primary] || '情绪的'
    };
  }

  _mapToPositive(emotion) {
    const map = {
      calm: 'serenity', curiosity: 'excitement', tension: 'anticipation',
      anticipation: 'excitement', peak: 'euphoria', catharsis: 'joy',
      shock: 'surprise', confusion: 'wonder', reflection: 'contentment',
      acceptance: 'peace', peace: 'bliss', closure: 'fulfillment'
    };
    return map[emotion] || 'joy';
  }

  _mapToNegative(emotion) {
    const map = {
      calm: 'melancholy', curiosity: 'longing', tension: 'despair',
      anticipation: 'dread', peak: 'anguish', catharsis: 'grief',
      shock: 'despair', confusion: 'loss', reflection: 'regret',
      acceptance: 'resignation', peace: 'emptiness', closure: 'finality'
    };
    return map[emotion] || 'sadness';
  }

  _mapToIntense(emotion) {
    const map = {
      calm: 'suppressed', curiosity: 'fixation', tension: 'rage',
      anticipation: 'obsession', peak: 'fury', catharsis: 'explosion',
      shock: 'outrage', confusion: 'frustration', reflection: 'brooding',
      acceptance: 'defiance', peace: 'calm_before_storm', closure: 'resolution'
    };
    return map[emotion] || 'anger';
  }

  _mapToNostalgic(emotion) {
    const map = {
      calm: 'wistful', curiosity: 'yearning', tension: 'bittersweet',
      anticipation: 'hopeful', peak: 'poignant', catharsis: 'release',
      shock: 'revelation', confusion: 'fading', reflection: 'reminiscence',
      acceptance: 'serenity', peace: 'timeless', closure: 'resolved'
    };
    return map[emotion] || 'nostalgia';
  }

  _createDefaultArc(config) {
    const sceneCount = config.sceneCount || 5;
    const targets = [];
    for (let i = 0; i < sceneCount; i++) {
      const position = sceneCount > 1 ? i / (sceneCount - 1) : 0;
      targets.push({
        sceneIndex: i,
        position,
        intensity: 0.5,
        label: 'neutral',
        emotion: 'neutral',
        descriptor: '中性的'
      });
    }
    return {
      curveType: 'build',
      description: '默认渐进式情绪弧线',
      stages: this.emotionCurves.build.stages,
      targets,
      primaryEmotion: 'neutral',
      secondaryEmotion: null,
      baseIntensity: 0.5
    };
  }
}

module.exports = { EmotionArcDesigner };
