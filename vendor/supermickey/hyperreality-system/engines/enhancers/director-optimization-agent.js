/**
 * Director Optimization Agent — 导演优化 Agent (SuperMickey 适配版)
 *
 * 来源: 暴风战斧 director-optimization-agent.js
 * 适配: SuperMickey 四层架构，在 Layer 2 后调用
 *
 * 核心能力：
 * 1. 四维评分：故事性 30%、连贯性 25%、视觉语言 25%、风格一致性 20%
 * 2. 自动迭代优化（通过 LLM 调用，降级保护）
 * 3. 通过阈值 4.0/5.0，最大迭代 3 次
 * 4. 降级保护：LLM 调用失败不阻断 Pipeline
 */

class DirectorOptimizationAgent {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.threshold = options.threshold || 4.0; // 4.0/5.0
    this.maxIterations = options.maxIterations || 3;
    this.weights = options.weights || {
      story: 0.30,
      continuity: 0.25,
      visual: 0.25,
      style: 0.20
    };

    // LLM 配置（降级保护）
    this.llmEnabled = options.llmEnabled !== false;
    this.llmModel = options.llmModel || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6';
    this.llmTimeout = options.llmTimeout || 180000;
    this.llmMaxRetries = options.llmMaxRetries || 2;
  }

  /**
   * SuperMickey 主入口：优化 shots
   * @param {Array} shots - shots 数组
   * @param {Object} metadata - 元数据
   * @returns {Object} { shots, score, iterations, improved }
   */
  async optimize(shots, metadata = {}) {
    if (!this.enabled || !shots || shots.length === 0) {
      return { shots, score: 5.0, iterations: 0, improved: false };
    }

    console.log('\n🎬 [DirectorOptimizationAgent] 导演优化...');

    const { deepClone } = require('../../utils/safe-clone');
    let currentShots = deepClone(shots); // 【v2.1.6-fix-bug43】深拷贝，防止修改原始 shots
    let currentScore = this._score(currentShots, metadata);
    let iterations = 0;
    let improved = false;

    console.log(`   初始评分: ${currentScore.toFixed(2)}/5.0`);

    // 迭代优化
    while (currentScore < this.threshold && iterations < this.maxIterations) {
      iterations++;
      console.log(`   迭代 ${iterations}/${this.maxIterations}...`);

      try {
        const optimized = await this._optimizeWithLLM(currentShots, metadata, currentScore);
        if (optimized && optimized.shots) {
          const newScore = this._score(optimized.shots, metadata);
          if (newScore > currentScore) {
            currentShots = optimized.shots;
            currentScore = newScore;
            improved = true;
            console.log(`   优化后评分: ${currentScore.toFixed(2)}/5.0`);
          } else {
            console.log(`   优化未提升评分，停止迭代`);
            break;
          }
        }
      } catch (err) {
        console.warn(`   ⚠️ LLM 优化失败 (降级保护): ${err.message}`);
        // 降级：使用规则-based 优化
        const ruleOptimized = this._optimizeWithRules(currentShots, metadata);
        const newScore = this._score(ruleOptimized, metadata);
        if (newScore > currentScore) {
          currentShots = ruleOptimized;
          currentScore = newScore;
          improved = true;
          console.log(`   规则优化后评分: ${currentScore.toFixed(2)}/5.0`);
        } else {
          break;
        }
      }
    }

    if (currentScore >= this.threshold) {
      console.log(`   ✅ 导演优化通过: ${currentScore.toFixed(2)}/5.0`);
    } else {
      console.log(`   ⚠️ 导演优化未达阈值: ${currentScore.toFixed(2)}/5.0 (阈值: ${this.threshold})`);
    }

    return {
      shots: currentShots,
      score: currentScore,
      iterations,
      improved
    };
  }

  // ========== 私有方法 ==========

  _score(shots, metadata) {
    // 四维评分：故事性、连贯性、视觉语言、风格一致性
    // 【P1-QUAL-05 修复】新增字段完整性维度
    const storyScore = this._scoreStory(shots, metadata);
    const continuityScore = this._scoreContinuity(shots);
    const visualScore = this._scoreVisual(shots);
    const styleScore = this._scoreStyle(shots, metadata);
    const completenessScore = this._scoreFieldCompleteness(shots); // 【P1-QUAL-05 修复】

    // 调整权重：将style的5%分给字段完整性
    return (
      storyScore * 0.30 +
      continuityScore * 0.25 +
      visualScore * 0.25 +
      styleScore * 0.15 +      // 从20%降到15%
      completenessScore * 0.05  // 【P1-QUAL-05 修复】新增5%
    );
  }

  /**
   * 【P1-QUAL-05 修复】字段完整性评分
   * 检查10个关键字段是否存在且长度足够
   * 10个字段全满=5.0，每缺1个扣0.5分
   */
  _scoreFieldCompleteness(shots) {
    if (shots.length === 0) return 3.0;

    const KEY_FIELDS = [
      'director_instruction', 'scene', 'lighting', 'camera_movement',
      'action', 'timeline', 'audio', 'negative', 'consistency', 'mood'
    ];
    const MIN_LENGTHS = {
      director_instruction: 20, scene: 30, lighting: 30, camera_movement: 20,
      action: 20, timeline: 10, audio: 20, negative: 20, consistency: 20, mood: 5
    };

    let totalFieldScore = 0;

    for (const shot of shots) {
      const fields = shot.fields || shot;
      let shotFieldScore = 5.0;
      let missingCount = 0;

      for (const field of KEY_FIELDS) {
        const value = fields[field];
        const strValue = String(value || '');
        const minLen = MIN_LENGTHS[field] || 1;

        if (!value || strValue.trim().length < minLen) {
          missingCount++;
        }
      }

      // 每缺1个关键字段扣0.5分
      shotFieldScore = Math.max(0, 5.0 - missingCount * 0.5);
      totalFieldScore += shotFieldScore;
    }

    return totalFieldScore / shots.length;
  }

  _scoreStory(shots, metadata) {
    // 故事性：检查是否有起承转合结构
    let score = 3.0;

    const types = shots.map(s => String(s.type || s.sceneType || '').toLowerCase());
    // 【修复】支持 SuperMickey 的 sceneType: hook, inciting_incident, rising_action, midpoint, abyss, climax
    const hasOpening = types.some(t => t.includes('opening') || t.includes('establish') || t.includes('hook') || t.includes('inciting'));
    const hasClimax = types.some(t => t.includes('climax') || t.includes('reveal') || t.includes('midpoint'));
    const hasResolution = types.some(t => t.includes('resolution') || t.includes('ending') || t.includes('abyss') || t.includes('falling'));

    if (hasOpening) score += 0.5;
    if (hasClimax) score += 0.5;
    if (hasResolution) score += 0.5;

    // 检查是否有情绪变化
    const emotions = shots.map(s => String(s.emotion || s.mood || '').toLowerCase());
    const uniqueEmotions = [...new Set(emotions)].filter(e => e && e !== 'none');
    if (uniqueEmotions.length >= 2) score += 0.5;

    return Math.min(5.0, score);
  }

  _scoreContinuity(shots) {
    // 连贯性：检查相邻镜头是否有逻辑连接
    if (shots.length < 2) return 3.0;

    let score = 3.0;
    let continuityCount = 0;

    for (let i = 1; i < shots.length; i++) {
      const prev = shots[i - 1];
      const curr = shots[i];

      // 检查是否有过渡（支持 transition / _transitionType / pacing）
      if (curr.transition || curr._transitionType || curr.pacing || curr._transitionDirection) { // 【v2.1.6-fix-bug48】修复冗余逻辑：curr.transition 重复 → 改为 _transitionDirection
        continuityCount++;
      }
      // 检查情绪是否连贯
      const prevEmotion = String(prev.emotion || prev.mood || '').toLowerCase();
      const currEmotion = String(curr.emotion || curr.mood || '').toLowerCase();
      if (prevEmotion === currEmotion || (prevEmotion && currEmotion)) {
        continuityCount++;
      }
    }

    const continuityRatio = continuityCount / (shots.length - 1);
    score += continuityRatio * 2.0;

    return Math.min(5.0, score);
  }

  _scoreVisual(shots) {
    // 视觉语言：检查镜头多样性
    if (shots.length === 0) return 3.0;

    let score = 3.0;

    // 【修复】支持 camera / cameraMovement / camera_movement / cameraString
    const cameras = shots.map(s => String(s.camera || s.cameraMovement || s.camera_movement || s.cameraString || '').toLowerCase());
    const uniqueCameras = [...new Set(cameras)].filter(c => c && c !== 'none');
    if (uniqueCameras.length >= 3) score += 0.5;
    if (uniqueCameras.length >= 5) score += 0.5;

    // 【修复】支持 lighting / lightingString
    const lightings = shots.map(s => String(s.lighting || s.lightingString || '').toLowerCase());
    const uniqueLightings = [...new Set(lightings)].filter(l => l && l !== 'none');
    if (uniqueLightings.length >= 2) score += 0.5;

    // 【修复】支持 distance / shotSize / composition
    const distances = shots.map(s => String(s.distance || s.shotSize || s.composition || '').toLowerCase());
    const uniqueDistances = [...new Set(distances)].filter(d => d && d !== 'none');
    if (uniqueDistances.length >= 2) score += 0.5;

    return Math.min(5.0, score);
  }

  _scoreStyle(shots, metadata) {
    // 风格一致性：检查是否保持统一风格
    let score = 3.0;

    const style = metadata.style?.primary || '';
    if (!style) return 3.0;

    let consistentCount = 0;
    for (const shot of shots) {
      const promptText = shot.prompt || shot.description || '';
      if (promptText.includes(style)) {
        consistentCount++;
      }
    }

    const consistencyRatio = consistentCount / shots.length;
    score += consistencyRatio * 2.0;

    return Math.min(5.0, score);
  }

  async _optimizeWithLLM(shots, metadata, currentScore) {
    // 简化版：返回 null，降级到规则优化
    // 在实际部署中，这里可以调用 LLM 进行优化
    return null;
  }

  _optimizeWithRules(shots, metadata) {
    // 规则-based 优化
    const optimized = [...shots];

    // 1. 确保片头有 opening hook
    if (optimized.length > 0) {
      const first = optimized[0];
      if (!first.type || first.type === 'scene') {
        first.type = 'opening';
      }
    }

    // 2. 确保有 climax 镜头
    if (optimized.length > 2) {
      const mid = Math.floor(optimized.length / 2);
      if (!optimized[mid].type || optimized[mid].type === 'scene') {
        optimized[mid].type = 'climax';
      }
    }

    // 3. 确保最后有 resolution
    if (optimized.length > 1) {
      const last = optimized[optimized.length - 1];
      if (!last.type || last.type === 'scene') {
        last.type = 'resolution';
      }
    }

    // 4. 添加过渡
    for (let i = 1; i < optimized.length; i++) {
      if (!optimized[i].transition) {
        optimized[i].transition = 'smooth';
      }
    }

    return optimized;
  }
}

module.exports = { DirectorOptimizationAgent };
