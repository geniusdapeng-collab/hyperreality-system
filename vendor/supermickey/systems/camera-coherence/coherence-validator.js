/**
 * 运镜协调性校验器 v1.0 — camera-coherence
 *
 * 在 PromptFusion 之后、渲染之前，对全片镜头做规则级运镜/转场校验。
 * 纯规则、零 LLM 调用、毫秒级，不产生新的降级风险。
 *
 * 校验项（对应好莱坞经典剪辑语法）：
 * R1 景别转换合法性（跳景别矩阵 + 动机白名单）
 * R2 同景别三连单调检测
 * R3 运镜方向突变检测（推→拉/左摇→右摇 的方向硬反转）
 * R4 转场方式与景别差匹配（≤1级却声明叠化=浪费；≥3级却声明硬切=非法）
 * R5 屏幕方向一致性（同场景连续镜头的运动方向突变）
 * R6 时间轴与镜头时长一致性（timeline 段覆盖应≈镜头时长）
 * R7 运镜-动作冲突（快速运镜+精细动作，如 whip pan + 微表情）
 *
 * 输出：逐镜头 issues + 全片节奏曲线 + 可执行的修复建议（rewrite_hint）
 * 设计原则：只标记 + 建议，不擅自改写 prompt（自动修复由上层决定）
 *
 * @module camera-coherence/coherence-validator
 * @version 1.0.0
 */

const {
  SHOT_SCALES, SCALE_NAMES, SHOCK_MOTIVATIONS,
  normalizeScale, scaleLevel, judgeTransition, analyzeScaleRhythm
} = require('./shot-scale-matrix');

// 运镜方向向量（用于 R3 突变检测）
const MOVEMENT_VECTORS = {
  push_in: [0, 1], dolly_in: [0, 1], '推': [0, 1], '推近': [0, 1], '推进': [0, 1],
  pull_out: [0, -1], dolly_out: [0, -1], '拉': [0, -1], '后拉': [0, -1], '拉远': [0, -1],
  pan_left: [-1, 0], '左摇': [-1, 0],
  pan_right: [1, 0], '右摇': [1, 0],
  truck_left: [-1, 0], '左移': [-1, 0],
  truck_right: [1, 0], '右移': [1, 0],
  tilt_up: [0, 2], '上摇': [0, 2],
  tilt_down: [0, -2], '下摇': [0, -2],
  crane_up: [0, 2], '升': [0, 2],
  crane_down: [0, -2], '降': [0, -2],
  orbit_cw: [3, 0], '环绕': [3, 0], '顺时针环绕': [3, 0],
  orbit_ccw: [-3, 0], '逆时针环绕': [-3, 0],
  static: [0, 0], '固定': [0, 0], '固定机位': [0, 0],
  handheld: [1, 1], '手持': [1, 1], '稳定器': [1, 1],
  tracking: [2, 0], '跟拍': [2, 0], '跟': [2, 0], '跟随': [2, 0]
};

// 快速运镜（R7 冲突检测）
const FAST_MOVEMENTS = ['whip', 'fast', 'rapid', 'crash', '快速摇', '甩', '急推', '快速推'];
// 精细动作（R7 冲突检测）
const FINE_ACTIONS = ['whisper', 'subtle', 'delicate', 'micro', '低语', '微表情', '细微', '精细', '轻抚', '眨眼'];

class CoherenceValidator {
  constructor(options = {}) {
    this.strictness = options.strictness || 'normal'; // relaxed | normal | strict
  }

  /**
   * 从镜头数据中提取机器可读的运镜计划
   * 兼容多来源：VL agent 结构化 camera / 25字段 composition+camera_movement 文本 / shot_type
   */
  extractCameraPlan(shot) {
    const f = shot.fields || shot;
    // 景别：优先结构化 camera.shot_size，其次 composition 文本，再次 sceneType
    const scaleRaw =
      shot.camera?.shot_size ||
      f.camera?.shot_size ||
      f.composition || f.shot_size || f.compositionString ||
      shot.shot_type || '';
    // 运镜：cameraString / camera_movement / camera.movement
    const movementRaw =
      f.camera_movement || shot.cameraString || shot.camera_string ||
      shot.camera?.movement || f.camera?.movement || '';
    // 转场
    const transitionRaw = f.transition || shot.transition || shot.transition_intent || '';
    // 动机（若 LLM 按新规范标注了 transition_motivation，或从 transition 字符串解析 'motivation: id'）
    let motivation = f.transition_motivation || shot.transition_motivation || null;
    if (!motivation && typeof transitionRaw === 'string') {
      const m = transitionRaw.match(/motivation[:\s]+(\w+)/i);
      if (m) motivation = m[1];
    }
    // 屏幕方向
    const screenDirection = shot.screen_direction || f.screen_direction || null;

    return {
      shotId: shot.shotId || shot.shot_id || 'unknown',
      sceneId: shot.scene_id || shot.sceneId || null,
      sceneType: shot.sceneType || shot.type || null,
      scale: normalizeScale(scaleRaw),
      scaleRaw: String(scaleRaw).slice(0, 60),
      movement: this._normalizeMovement(movementRaw),
      movementRaw: String(movementRaw).slice(0, 80),
      transition: String(transitionRaw).slice(0, 80),
      motivation: SHOCK_MOTIVATIONS[motivation] ? motivation : null,
      screenDirection,
      duration: shot.duration || shot.timing?.duration || null,
      timeline: f.timeline || shot.timeline || null,
      action: String(f.action || shot.action || '')
    };
  }

  _normalizeMovement(raw) {
    if (!raw) return 'unknown';
    const s = String(raw).toLowerCase();
    // 优先匹配长词
    const keys = Object.keys(MOVEMENT_VECTORS).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (s.includes(k.toLowerCase())) return k;
    }
    return 'unknown';
  }

  /**
   * 校验全片镜头序列
   * @param {Array} shots - 镜头数组（PromptFusion 后）
   * @returns {Object} { passed, issueCount, issues, rhythm, shotPlans }
   */
  validate(shots) {
    const plans = shots.map(s => this.extractCameraPlan(s));
    const issues = [];

    // ---------- 镜头对级校验 ----------
    for (let i = 1; i < plans.length; i++) {
      const prev = plans[i - 1];
      const curr = plans[i];
      const pair = [prev.shotId, curr.shotId];
      const sceneChange = prev.sceneId && curr.sceneId && prev.sceneId !== curr.sceneId;

      // R1 景别转换合法性
      const verdict = judgeTransition(prev.scale || prev.scaleRaw, curr.scale || curr.scaleRaw, {
        motivation: curr.motivation,
        sceneChange
      });
      if (verdict.verdict === 'illegal') {
        issues.push(this._issue('R1_scale_jump', 'critical', pair,
          verdict.advice,
          `为 ${curr.shotId} 的 transition 字段补充动机标注（${Object.keys(SHOCK_MOTIVATIONS).join('/')}），或在两镜之间插入 ${this._suggestMiddleScale(verdict.fromScale, verdict.toScale)} 过渡镜`));
      } else if (verdict.verdict === 'caution') {
        issues.push(this._issue('R1_scale_caution', 'warning', pair, verdict.advice,
          `将 ${curr.shotId} 的 transition 从硬切改为 ${verdict.transitionSuggestion}`));
      }

      // R3 运镜方向突变
      if (!sceneChange && prev.movement !== 'unknown' && curr.movement !== 'unknown') {
        const v1 = MOVEMENT_VECTORS[prev.movement];
        const v2 = MOVEMENT_VECTORS[curr.movement];
        if (v1 && v2 && this._isOpposite(v1, v2)) {
          issues.push(this._issue('R3_direction_reversal', 'warning', pair,
            `运镜方向硬反转：${prev.movement} → ${curr.movement}，观众会有"被拽回"的感觉`,
            '保留反转但放缓第二镜起速（起幅先稳定0.5s），或改为同向/垂直方向运镜'));
        }
      }

      // R4 转场方式与景别差匹配
      if (curr.transition && verdict.diff !== null) {
        const t = curr.transition.toLowerCase();
        const declaresHardCut = /硬切|hard_cut|直接切/.test(t);
        const declaresSoft = /叠化|淡入|淡出|渐变|dissolve|fade/.test(t);
        if (verdict.diff >= 3 && declaresHardCut && !curr.motivation) {
          issues.push(this._issue('R4_transition_mismatch', 'critical', pair,
            `景别差${verdict.diff}级却声明硬切，且无动机标注`,
            '补动机标注，或改叠化/匹配剪辑/闪白'));
        }
        if (verdict.diff <= 1 && declaresSoft && this.strictness === 'strict') {
          issues.push(this._issue('R4_transition_overkill', 'info', pair,
            '景别渐变却使用叠化，节奏会显拖沓（action/快节奏内容建议硬切）',
            '快节奏内容改硬切'));
        }
      }

      // R5 屏幕方向一致（同场景）
      if (!sceneChange && prev.screenDirection && curr.screenDirection &&
        prev.screenDirection !== curr.screenDirection) {
        const opposite = /left.*right|right.*left|左.*右|右.*左/;
        if (opposite.test(prev.screenDirection + '|' + curr.screenDirection)) {
          issues.push(this._issue('R5_screen_direction', 'warning', pair,
            `屏幕方向突变：${prev.screenDirection} → ${curr.screenDirection}，同场景内可能越轴`,
            '统一运动方向，或插入中性方向镜头（正面/背面）做过渡'));
        }
      }
    }

    // ---------- 单镜级校验 ----------
    for (const p of plans) {
      // R6 时间轴与时长一致性
      if (p.timeline && p.duration) {
        const tlCheck = this._checkTimelineVsDuration(p.timeline, p.duration);
        if (tlCheck) {
          issues.push(this._issue('R6_timeline_duration', 'warning', [p.shotId], tlCheck.message, tlCheck.hint));
        }
      }

      // R7 运镜-动作冲突
      const isFast = FAST_MOVEMENTS.some(k => p.movementRaw.toLowerCase().includes(k));
      const isFine = FINE_ACTIONS.some(k => p.action.toLowerCase().includes(k));
      if (isFast && isFine) {
        issues.push(this._issue('R7_movement_action_conflict', 'warning', [p.shotId],
          '快速运镜与精细动作冲突（观众看不清细节）',
          '运镜降速，或将精细动作移到固定/慢速段'));
      }
    }

    // ---------- 全片节奏 ----------
    const rhythm = analyzeScaleRhythm(plans.map(p => p.scale || p.scaleRaw));
    for (const ri of rhythm.issues) {
      const pair = ri.between ? [plans[ri.between[0]].shotId, plans[ri.between[1]].shotId]
        : ri.range ? ri.range.map(idx => plans[idx].shotId) : [];
      issues.push(this._issue(
        ri.type === 'monotony' ? 'R2_scale_monotony' : 'R1_scale_jump_review',
        ri.type === 'monotony' ? 'warning' : 'info',
        pair, ri.message,
        ri.type === 'monotony' ? '插入不同景别镜头（特写细节/远景环境）打破单调' : '确认动机或加过渡'));
    }

    const critical = issues.filter(i => i.severity === 'critical').length;
    return {
      passed: critical === 0,
      issueCount: { critical, warning: issues.filter(i => i.severity === 'warning').length, info: issues.filter(i => i.severity === 'info').length },
      issues,
      rhythm: { curve: rhythm.curve },
      shotPlans: plans.map(p => ({ shotId: p.shotId, scale: p.scale, movement: p.movement, transition: p.transition, motivation: p.motivation }))
    };
  }

  _issue(rule, severity, shots, message, hint) {
    return { rule, severity, shots, message, rewrite_hint: hint };
  }

  _isOpposite(v1, v2) {
    // 向量点积为负且都不为零向量 → 方向反转
    const dot = v1[0] * v2[0] + v1[1] * v2[1];
    const m1 = Math.abs(v1[0]) + Math.abs(v1[1]);
    const m2 = Math.abs(v2[0]) + Math.abs(v2[1]);
    return m1 > 0 && m2 > 0 && dot < 0;
  }

  _suggestMiddleScale(fromScale, toScale) {
    if (!fromScale || !toScale) return '中景';
    const from = SHOT_SCALES.indexOf(fromScale);
    const to = SHOT_SCALES.indexOf(toScale);
    if (from < 0 || to < 0) return '中景';
    const mid = Math.round((from + to) / 2);
    return SCALE_NAMES[SHOT_SCALES[mid]];
  }

  _checkTimelineVsDuration(timeline, duration) {
    // timeline 为文本 "T00:00 - ...;T00:03 - ..." 或结构化对象
    let maxT = 0;
    if (typeof timeline === 'string') {
      const matches = [...timeline.matchAll(/T(\d{1,2}):(\d{2})/g)];
      for (const m of matches) {
        maxT = Math.max(maxT, parseInt(m[1]) * 60 + parseInt(m[2]));
      }
      if (maxT === 0) return null; // 无时间标记，不判
    } else if (timeline && Array.isArray(timeline.beats)) {
      maxT = Math.max(0, ...timeline.beats.map(b => Number(b.time) || 0));
    } else {
      return null;
    }
    const ratio = maxT / duration;
    if (ratio > 1.3) {
      return { message: `时间轴覆盖 ${maxT}s 超过镜头时长 ${duration}s（${(ratio * 100).toFixed(0)}%）`, hint: '压缩时间轴到镜头时长内，或申请延长镜头' };
    }
    if (ratio < 0.5 && duration >= 8) {
      return { message: `时间轴只覆盖 ${maxT}s / 镜头 ${duration}s，后半段无调度`, hint: '补全后半段时间轴节拍' };
    }
    return null;
  }
}

module.exports = { CoherenceValidator };
