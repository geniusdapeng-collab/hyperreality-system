/**
 * DurationConstraintManager — 镜头时长全局约束管理器
 */
class DurationConstraintManager {
  constructor(options = {}) {
    // 【v2.2.5-审计修复】下限与全链路"单镜 3-12 秒、系统上限 15 秒"规范对齐。
    // 旧默认 min=5 会把合规的 3-4 秒镜头强制钳到 5 秒，与
    // agent-preflight / storyboard-validator / shot-duration-allocator 的口径冲突。
    this.maxSingleShot = options.maxSingleShot || 15;
    this.minSingleShot = options.minSingleShot || 3;
    this.maxTotalDuration = options.maxTotalDuration || 300;
    this.minTotalDuration = options.minTotalDuration || 15;
    this.enabled = options.enabled !== false;
    this.logPrefix = options.logPrefix || '[DurationManager]';

    this.rhythmProfiles = {
      fast: { shotRange: [3, 8], transitionRatio: 0.15, climaxRatio: 1.2 },
      standard: { shotRange: [3, 12], transitionRatio: 0.10, climaxRatio: 1.0 },
      slow: { shotRange: [8, 15], transitionRatio: 0.05, climaxRatio: 1.3 }
    };
  }

  constrain(scenes, options = {}) {
    if (!this.enabled || !scenes || scenes.length === 0) {
      return { scenes, adjustments: [], valid: true };
    }

    // 【P1-PERF-04 修复】校验targetDuration必须为数字
    let targetDuration = options.targetDuration;
    if (targetDuration !== undefined && targetDuration !== null) {
      if (typeof targetDuration !== 'number' || isNaN(targetDuration) || targetDuration < 0) {
        throw new TypeError(
          `[DurationManager] targetDuration必须是正数，收到: ${typeof targetDuration} = ${targetDuration}`
        );
      }
    } else {
      targetDuration = this._sumDurations(scenes);
    }

    const rhythmType = options.rhythmType || 'standard';
    const forceAdjust = options.forceAdjust !== false;

    console.log(`${this.logPrefix} 开始时长约束: 目标 ${targetDuration}s, ${scenes.length} 场景, 节奏: ${rhythmType}`);

    const profile = this.rhythmProfiles[rhythmType] || this.rhythmProfiles.standard;
    const adjustments = [];
    let valid = true;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      // 【P1-PERF-04 修复】校验scene.duration类型
      let originalDuration = scene.timing?.duration ?? scene.duration;
      if (originalDuration !== undefined && originalDuration !== null) {
        if (typeof originalDuration !== 'number' || isNaN(originalDuration)) {
          throw new TypeError(
            `[DurationManager] scene[${i}].duration必须是数字，收到: ${typeof originalDuration} = ${originalDuration}`
          );
        }
      }
      originalDuration = originalDuration || 0;
      
      const isClimax = scene.scene_type === 'emotional_climax' || scene.scene_function === 'climax';
      const maxDuration = isClimax
        ? Math.min(this.maxSingleShot, profile.shotRange[1] * profile.climaxRatio)
        : this.maxSingleShot;

      if (originalDuration > maxDuration) {
        adjustments.push({ sceneId: scene.scene_id || i, type: 'clamp_max', original: originalDuration, adjusted: maxDuration, reason: `超出单镜头上限 ${maxDuration}s` });
        if (forceAdjust) {
          if (scene.timing) scene.timing.duration = maxDuration;
          scene.duration = maxDuration;
        }
        valid = false;
      }

      if (originalDuration < this.minSingleShot && originalDuration > 0) {
        adjustments.push({ sceneId: scene.scene_id || i, type: 'clamp_min', original: originalDuration, adjusted: this.minSingleShot, reason: `低于单镜头下限 ${this.minSingleShot}s` });
        if (forceAdjust) {
          if (scene.timing) scene.timing.duration = this.minSingleShot;
          scene.duration = this.minSingleShot;
        }
      }
    }

    const currentTotal = this._sumDurations(scenes);

    if (currentTotal > this.maxTotalDuration) {
      adjustments.push({ type: 'total_overflow', original: currentTotal, target: this.maxTotalDuration, reason: `总时长超出上限 ${this.maxTotalDuration}s` });
      valid = false;
      if (forceAdjust) {
        const ratio = this.maxTotalDuration / currentTotal;
        for (const scene of scenes) {
          const newDuration = Math.floor((scene.timing?.duration || scene.duration || 0) * ratio);
          const clamped = Math.max(this.minSingleShot, Math.min(this.maxSingleShot, newDuration));
          if (scene.timing) scene.timing.duration = clamped;
          scene.duration = clamped;
        }
      }
    }

    if (Math.abs(currentTotal - targetDuration) > 5 && forceAdjust) {
      this._redistributeDurations(scenes, targetDuration, profile);
      adjustments.push({ type: 'redistribute', original: currentTotal, target: targetDuration, reason: '总时长与目标不匹配，重新分配' });
    }

    this._ensureSequentialTiming(scenes);

    console.log(`${this.logPrefix} 时长约束完成: ${adjustments.length} 处调整, valid=${valid}`);
    return { scenes, adjustments, valid };
  }

  _redistributeDurations(scenes, targetDuration, profile) {
    const numScenes = scenes.length;
    if (numScenes === 0) return;

    const weights = scenes.map(s => {
      const typeWeights = { opening: 0.8, establishing: 1.0, conflict: 1.2, emotional_climax: 1.5, resolution: 0.9, explanation: 1.1, demonstration: 1.0, warning: 0.7, ending: 0.6 };
      return typeWeights[s.scene_type] || 1.0;
    });

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const baseDuration = targetDuration / totalWeight;

    let accumulated = 0;
    for (let i = 0; i < numScenes; i++) {
      const idealDuration = baseDuration * weights[i];
      const clamped = Math.max(profile.shotRange[0], Math.min(profile.shotRange[1], Math.round(idealDuration)));
      if (scenes[i].timing) scenes[i].timing.duration = clamped;
      scenes[i].duration = clamped;
      accumulated += clamped;
    }

    if (accumulated !== targetDuration && numScenes > 0) {
      const diff = targetDuration - accumulated;
      const lastScene = scenes[numScenes - 1];
      const currentDuration = lastScene.timing?.duration || lastScene.duration || 0;
      const newDuration = Math.max(profile.shotRange[0], currentDuration + diff);
      if (lastScene.timing) lastScene.timing.duration = newDuration;
      lastScene.duration = newDuration;
    }

    this._ensureSequentialTiming(scenes);
  }

  _ensureSequentialTiming(scenes) {
    let currentTime = 0;
    for (const scene of scenes) {
      const duration = scene.timing?.duration || scene.duration || 0;
      if (!scene.timing) scene.timing = {};
      scene.timing.start = currentTime;
      scene.timing.duration = duration;
      scene.timing.end = currentTime + duration;
      currentTime += duration;
    }
  }

  _sumDurations(scenes) {
    return scenes.reduce((sum, s) => sum + (s.timing?.duration || s.duration || 0), 0);
  }

  generateReport(scenes, targetDuration) {
    const actual = this._sumDurations(scenes);
    const perScene = scenes.map(s => ({ sceneId: s.scene_id, type: s.scene_type, duration: s.timing?.duration || s.duration || 0 }));
    return {
      targetDuration,
      actualDuration: actual,
      diff: actual - targetDuration,
      sceneCount: scenes.length,
      perScene,
      avgDuration: scenes.length > 0 ? Math.round(actual / scenes.length * 10) / 10 : 0,
      maxScene: perScene.reduce((a, b) => a.duration > b.duration ? a : b, perScene[0]),
      minScene: perScene.reduce((a, b) => a.duration < b.duration ? a : b, perScene[0])
    };
  }
}

module.exports = { DurationConstraintManager };
