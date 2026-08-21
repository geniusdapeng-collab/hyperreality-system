/**
 * BehaviorAnchorSystem — 角色行为锚定系统
 */
class BehaviorAnchorSystem {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.logPrefix = options.logPrefix || '[BehaviorAnchor]';

    this.sceneBehaviorMap = {
      opening: { posture: '站立', movement: '缓慢走动', gesture: '张开双臂或自然下垂' },
      establishing: { posture: '站立或坐姿', movement: '微动', gesture: '自然' },
      conflict: { posture: '站立', movement: '紧张移动', gesture: '指向或握拳' },
      emotional_climax: { posture: '站立或跪下', movement: '剧烈动作', gesture: '抱头或伸展' },
      resolution: { posture: '坐姿或放松站立', movement: '缓慢', gesture: '微笑或点头' },
      explanation: { posture: '站立', movement: '手势辅助', gesture: '比划或指示' },
      demonstration: { posture: '站立', movement: '逐步演示', gesture: '精确操作' },
      ending: { posture: '站立面对镜头', movement: '静止或缓退', gesture: '挥手或致意' }
    };

    this.persistenceRules = [
      { from: '站立', to: ['坐姿', '行走', '倚靠'], allowed: true },
      { from: '坐姿', to: ['站立'], allowed: true, transition: '起身' },
      { from: '行走', to: ['站立', '奔跑'], allowed: true },
      { from: '奔跑', to: ['站立', '行走'], allowed: true, transition: '减速停下' }
    ];
  }

  anchor(shots, scenes = []) {
    if (!this.enabled || !shots || shots.length === 0) return shots;

    console.log(`${this.logPrefix} 行为锚定: ${shots.length} 镜头`);
    let lastBehavior = null;

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const sceneType = shot.sceneType || scenes[i]?.scene_type || 'establishing';
      const recommended = this.sceneBehaviorMap[sceneType];
      if (!recommended) continue;

      if (lastBehavior && recommended.posture !== lastBehavior.posture) {
        const isNatural = this._checkTransition(lastBehavior.posture, recommended.posture);
        if (!isNatural) {
          console.warn(`${this.logPrefix} 镜头 ${shot.shotId}: 行为转换不自然 ${lastBehavior.posture} → ${recommended.posture}`);
          recommended.posture = lastBehavior.posture;
          recommended.movement = `从${lastBehavior.posture}过渡到${recommended.posture}`;
        }
      }

      const behaviorDesc = this._formatBehaviorDescription(recommended);
      shot.prompt = this._injectBehavior(shot.prompt, behaviorDesc);
      shot.promptCharCount = shot.prompt.length;
      lastBehavior = recommended;
    }

    return shots;
  }

  _checkTransition(from, to) {
    const rule = this.persistenceRules.find(r => r.from === from);
    if (!rule) return true;
    return rule.to.includes(to);
  }

  _formatBehaviorDescription(behavior) {
    return `${behavior.posture}姿态，${behavior.movement}，${behavior.gesture}`;
  }

  _injectBehavior(prompt, behaviorDesc) {
    if (!prompt || prompt.includes('姿态')) return prompt;

    const roleMarker = prompt.match(/【角色】[^\n]*/);
    if (roleMarker) {
      const insertIdx = prompt.indexOf(roleMarker[0]) + roleMarker[0].length;
      return prompt.slice(0, insertIdx) + `，${behaviorDesc}` + prompt.slice(insertIdx);
    }

    return `【行为锚定】${behaviorDesc}\n${prompt}`;
  }
}

module.exports = { BehaviorAnchorSystem };
