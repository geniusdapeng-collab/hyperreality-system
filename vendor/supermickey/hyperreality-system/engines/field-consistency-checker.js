/**
 * FieldConsistencyChecker - 跨字段一致性校验模块
 * 负责: 校验25维字段之间的逻辑一致性
 * 核心规则: mood-lighting-camera_movement-color_palette 四维映射
 *           timeline-camera_movement-action 三维同步
 *           scene-lighting-bright_constraint 时序一致
 * v2.1.7: 新增模块，解决字段各自为政问题
 */

class FieldConsistencyChecker {
  constructor(options = {}) {
    this.strict = options.strict !== false; // 默认严格模式
    this.logLevel = options.logLevel || 'warn'; // warn|error|silent
  }

  /**
   * 主入口：校验单个镜头的25维字段一致性
   */
  check(shot) {
    const fields = shot.fields || shot;
    const issues = [];

    // ==================== 情绪相关四维映射 (1-3) ====================
    issues.push(...this._checkMoodLighting(fields)); // 1. 情绪-灯光
    issues.push(...this._checkMoodCamera(fields)); // 2. 情绪-运镜
    issues.push(...this._checkMoodColor(fields)); // 3. 情绪-色彩

    // ==================== 时间轴三维同步 (4-5) ====================
    issues.push(...this._checkTimelineCamera(fields)); // 4. 时间轴-运镜同步
    issues.push(...this._checkTimelineAction(fields)); // 5. 时间轴-动作同步

    // ==================== 场景-灯光-明亮约束 (6) ====================
    issues.push(...this._checkSceneLightingBright(fields));// 6. 场景-灯光-明亮

    // ==================== 动作-运镜-构图-景深 (7-9) ====================
    issues.push(...this._checkActionCamera(fields)); // 7. 动作-运镜同步
    issues.push(...this._checkCompositionCamera(fields)); // 8. 构图-运镜景别
    issues.push(...this._checkDepthOfFieldComposition(fields)); // 9. 景深-景别

    // ==================== 节奏-运镜 (10) ====================
    issues.push(...this._checkPacingCamera(fields)); // 10. 节奏-运镜速度

    // ==================== v2.1.7新增10组校验 (11-20) ====================
    // 11. 场景-灯光一致性
    issues.push(...this._checkSceneLighting(fields));
    // 12. 动作-道具一致性
    issues.push(...this._checkActionProps(fields));
    // 13. 角色-服装一致性
    issues.push(...this._checkCharacterCostume(fields));
    // 14. 台词-音频一致性
    issues.push(...this._checkDialogueAudio(fields));
    // 15. 色彩-灯光一致性
    issues.push(...this._checkColorLighting(fields));
    // 16. 转场-节奏一致性
    issues.push(...this._checkTransitionPacing(fields));
    // 17. 导演意图-场景一致性
    issues.push(...this._checkDirectorScene(fields));
    // 18. 约束-负面约束一致性
    issues.push(...this._checkConstraintNegative(fields));
    // 19. 构图-色彩一致性
    issues.push(...this._checkCompositionColor(fields));
    // 20. 时间轴-音频同步
    issues.push(...this._checkTimelineAudio(fields));

    const result = {
      shotId: shot.shotId,
      valid: issues.filter(i => i.severity === 'error').length === 0,
      issues: issues,
      warningCount: issues.filter(i => i.severity === 'warning').length,
      errorCount: issues.filter(i => i.severity === 'error').length
    };

    if (issues.length > 0 && this.logLevel !== 'silent') {
      const level = result.errorCount > 0 ? 'error' : 'warn';
      console[level](`[FieldConsistencyChecker] ${shot.shotId}: ${issues.length} issues (${result.errorCount} errors, ${result.warningCount} warnings)`);
      if (this.logLevel === 'warn' || this.logLevel === 'error') {
        issues.forEach(i => {
          const method = i.severity === 'error' ? 'error' : i.severity === 'warn' ? 'warn' : 'log';
          console[method](`  ${i.severity}: ${i.fieldA} ↔ ${i.fieldB}: ${i.message}`);
        });
      }
    }

    return result;
  }

  /**
   * 自动修复：根据校验结果自动修复字段
   */
  autoFix(shot) {
    const checkResult = this.check(shot);
    if (checkResult.valid && checkResult.warningCount === 0) return shot;

    const fields = { ...(shot.fields || shot) };
    let fixed = false;

    for (const issue of checkResult.issues) {
      if (issue.fixable) {
        const fix = issue.fix(fields);
        if (fix) {
          Object.assign(fields, fix);
          fixed = true;
          console.log(`[FieldConsistencyChecker] ${shot.shotId} 自动修复: ${issue.message}`);
        }
      }
    }

    return fixed ? { ...shot, fields } : shot;
  }

  // ==================== 校验规则 ====================

  /**
   * 1. 情绪-灯光一致性
   * 紧张→硬光/高对比, 温馨→柔光/低对比, 史诗→侧光/轮廓光
   */
  _checkMoodLighting(fields) {
    const issues = [];
    const mood = this._extractMood(fields.mood);
    const lighting = String(fields.lighting || '').toLowerCase();

    if (!mood || !lighting) return issues;

    const rules = {
      tense: {
        required: ['hard', 'harsh', 'high contrast', 'sharp', 'dramatic', 'chiaroscuro'],
        forbidden: ['soft', 'gentle', 'diffuse', 'warm', 'cozy', 'ambient'],
        message: '紧张情绪需要硬光/高对比，当前灯光偏柔和'
      },
      sad: {
        required: ['soft', 'diffuse', 'low key', 'shadow', 'dim', 'cool'],
        forbidden: ['bright', 'hard', 'harsh', 'high contrast', 'warm', 'sunny'],
        message: '悲伤情绪需要柔光/低对比/冷色，当前灯光偏明亮'
      },
      epic: {
        required: ['rim', 'backlight', 'silhouette', 'golden', 'dramatic', 'side'],
        forbidden: ['flat', 'even', 'front', 'soft', 'ambient'],
        message: '史诗情绪需要轮廓光/侧光/戏剧性，当前灯光偏平'
      },
      warm: {
        required: ['warm', 'soft', 'golden', 'diffuse', 'gentle'],
        forbidden: ['cold', 'harsh', 'hard', 'blue', 'clinical'],
        message: '温馨情绪需要暖色/柔光，当前灯光偏冷/硬'
      },
      calm: {
        required: ['soft', 'even', 'diffuse', 'ambient', 'natural'],
        forbidden: ['harsh', 'dramatic', 'high contrast', 'strobe', 'flicker'],
        message: '平静情绪需要均匀/柔光，当前灯光偏戏剧性'
      }
    };

    const rule = rules[mood];
    if (!rule) return issues;

    const hasRequired = rule.required.some(r => lighting.includes(r));
    const hasForbidden = rule.forbidden.some(f => lighting.includes(f));

    if (!hasRequired || hasForbidden) {
      issues.push({
        severity: 'warning',
        fieldA: 'mood',
        fieldB: 'lighting',
        message: `${rule.message} (mood: ${mood})`,
        fixable: true,
        fix: (f) => {
          // 【v2.2-refine】中文短语智能注入, 替代原英文标签前缀拼接:
          // 原方案向字段头部拼英文枚举, 导致英文泄漏进最终prompt、与中文正文重复、多镜同一句
          const fixes = {
            tense: { phrase: '硬光高对比', markers: ['硬光', '高对比'] },
            sad: { phrase: '柔光低照度冷调', markers: ['柔光', '低照度'] },
            epic: { phrase: '侧光轮廓光戏剧性布光', markers: ['轮廓光', '侧光'] },
            warm: { phrase: '暖色柔光', markers: ['暖', '柔光'] },
            calm: { phrase: '均匀柔光自然光', markers: ['均匀', '柔光'] }
          };
          const item = fixes[mood];
          if (!item) return null;
          const current = String(f.lighting || '');
          if (item.markers.some(marker => current.includes(marker))) return null;
          return { lighting: `${item.phrase}，${current}` };
        }
      });
    }

    return issues;
  }

  /**
   * 2. 情绪-运镜一致性
   * 紧张→handheld/fast, 平静→static/slow, 史诗→wide/slow_push
   */
  _checkMoodCamera(fields) {
    const issues = [];
    const mood = this._extractMood(fields.mood);
    const camera = String(fields.camera_movement || '').toLowerCase();

    if (!mood || !camera) return issues;

    const rules = {
      tense: {
        required: ['handheld', 'fast', 'shaky', 'quick', 'whip', 'snap'],
        forbidden: ['slow', 'static', 'stable', 'smooth', 'gentle', 'gradual'],
        message: '紧张情绪需要手持/快速运镜'
      },
      sad: {
        required: ['slow', 'static', 'smooth', 'drift', 'float'],
        forbidden: ['fast', 'quick', 'handheld', 'shaky', 'whip'],
        message: '悲伤情绪需要缓慢/稳定运镜'
      },
      epic: {
        required: ['wide', 'crane', 'drone', 'slow', 'sweep', 'grand'],
        forbidden: ['close', 'handheld', 'shaky', 'intimate'],
        message: '史诗情绪需要大景别/缓慢运镜'
      },
      warm: {
        required: ['slow', 'smooth', 'gentle', 'soft', 'drift'],
        forbidden: ['fast', 'hard', 'shaky', 'abrupt', 'snap'],
        message: '温馨情绪需要柔和/缓慢运镜'
      }
    };

    const rule = rules[mood];
    if (!rule) return issues;

    const hasRequired = rule.required.some(r => camera.includes(r));
    const hasForbidden = rule.forbidden.some(f => camera.includes(f));

    if (!hasRequired || hasForbidden) {
      issues.push({
        severity: 'warning',
        fieldA: 'mood',
        fieldB: 'camera_movement',
        message: `${rule.message} (mood: ${mood})`,
        // 【v2.2-refine】运镜方式是导演层创作决策, 禁止自动拼接反向运镜:
        // 原方案在 static 正文前拼 handheld 前缀, 直接制造 static+handheld 自相矛盾(S2/S6/S7 病例)
        fixable: false
      });
    }

    return issues;
  }

  /**
   * 3. 情绪-色彩一致性
   * 紧张→冷色/高对比, 悲伤→低饱和/冷色, 史诗→金色/高饱和
   */
  _checkMoodColor(fields) {
    const issues = [];
    const mood = this._extractMood(fields.mood);
    const color = String(fields.color_palette || '').toLowerCase();

    if (!mood || !color) return issues;

    const rules = {
      tense: {
        required: ['cool', 'cold', 'blue', 'high contrast', 'saturated'],
        forbidden: ['warm', 'pastel', 'soft', 'gentle', 'low contrast'],
        message: '紧张情绪需要冷色/高对比/高饱和'
      },
      sad: {
        required: ['cool', 'desaturated', 'muted', 'blue', 'grey'],
        forbidden: ['warm', 'saturated', 'bright', 'vibrant', 'golden'],
        message: '悲伤情绪需要冷色/低饱和/灰暗'
      },
      epic: {
        required: ['golden', 'warm', 'saturated', 'rich', 'vibrant'],
        forbidden: ['pastel', 'muted', 'desaturated', 'cool', 'grey'],
        message: '史诗情绪需要金色/暖色/高饱和'
      },
      warm: {
        required: ['warm', 'golden', 'soft', 'orange', 'amber'],
        forbidden: ['cool', 'cold', 'blue', 'grey', 'clinical'],
        message: '温馨情绪需要暖色/金色/柔和'
      }
    };

    const rule = rules[mood];
    if (!rule) return issues;

    const hasRequired = rule.required.some(r => color.includes(r));
    const hasForbidden = rule.forbidden.some(f => color.includes(f));

    if (!hasRequired || hasForbidden) {
      issues.push({
        severity: 'warning',
        fieldA: 'mood',
        fieldB: 'color_palette',
        message: `${rule.message} (mood: ${mood})`,
        fixable: true,
        fix: (f) => {
          // 【v2.2-refine】中文短语智能注入(同 lighting 逻辑)
          const fixes = {
            tense: { phrase: '冷调低饱和高对比', markers: ['冷', '低饱和'] },
            sad: { phrase: '冷灰低饱和', markers: ['冷', '灰'] },
            epic: { phrase: '金暖高饱和', markers: ['金', '暖'] },
            warm: { phrase: '暖金柔和', markers: ['暖', '金'] }
          };
          const item = fixes[mood];
          if (!item) return null;
          const current = String(f.color_palette || '');
          if (item.markers.some(marker => current.includes(marker))) return null;
          return { color_palette: `${item.phrase}，${current}` };
        }
      });
    }

    return issues;
  }

  /**
   * 4. 时间轴-运镜同步
   * timeline的每个节拍必须有对应的camera_movement
   */
  /**
   * 4. 时间轴-运镜同步 ⭐ v2.1.7增强版
   * timeline的每个节拍必须与camera_movement同步
   * 支持纯文本和结构化对象两种格式
   */
  _checkTimelineCamera(fields) {
    const issues = [];
    const timeline = fields.timeline || '';
    const camera = String(fields.camera_movement || '');

    if (!timeline || !camera) return issues;

    // 解析时间轴（支持纯文本和结构化对象）
    const beats = this._parseTimeline(timeline);
    if (beats.length === 0) return issues;

    // 检查每个节拍与camera_movement的同步
    for (const beat of beats) {
      const label = (beat.label || '').toLowerCase();
      const desc = (beat.description || '').toLowerCase();
      const combined = label + ' ' + desc;

      // 高潮/爆发节拍必须有快速运镜
      const highEnergyMarkers = ['高潮', '爆发', '碰撞', '冲击', '加速', '激烈', '释放', '顶点'];
      if (highEnergyMarkers.some(m => combined.includes(m))) {
        const fastMarkers = ['fast', 'push', 'handheld', 'quick', 'whip', 'snap', 'shaky', '急速', '推轨'];
        const hasFast = fastMarkers.some(m => camera.toLowerCase().includes(m));
        if (!hasFast) {
          issues.push({
            severity: 'error',
            fieldA: 'timeline',
            fieldB: 'camera_movement',
            message: `时间轴节拍"${beat.label || beat.time}"含高潮/爆发，但camera_movement无快速运镜`,
            fixable: false // 【fix】追加"T00:5快速推轨+手持晃动"会违反"运镜只写一种方式"精炼约束，改为仅报告
          });
        }
      }

      // 建立/平静节拍必须有稳定运镜
      const lowEnergyMarkers = ['建立', '平静', '收尾', '定格', '展示', '引入', '开场'];
      if (lowEnergyMarkers.some(m => combined.includes(m))) {
        const slowMarkers = ['slow', 'static', 'stable', 'smooth', 'gradual', 'gentle', '稳定', '缓慢'];
        const hasSlow = slowMarkers.some(m => camera.toLowerCase().includes(m));
        if (!hasSlow) {
          issues.push({
            severity: 'warning',
            fieldA: 'timeline',
            fieldB: 'camera_movement',
            message: `时间轴节拍"${beat.label || beat.time}"含建立/平静，但camera_movement无稳定运镜`,
            fixable: false // 【fix】追加"T00:缓慢稳定构图"同样违反精炼约束
          });
        }
      }

      // 检查cameraHint（结构化时间轴特有）
      if (beat.cameraHint) {
        const hint = beat.cameraHint.toLowerCase();
        // cameraHint中的运镜必须在camera_movement中体现
        const cameraKeywords = ['推轨', '拉远', '横移', '升降', '摇镜', '手持', '固定'];
        for (const kw of cameraKeywords) {
          if (hint.includes(kw) && !camera.toLowerCase().includes(kw)) {
            issues.push({
              severity: 'warning',
              fieldA: 'timeline.cameraHint',
              fieldB: 'camera_movement',
              message: `时间轴cameraHint要求"${kw}"，但camera_movement未包含`,
              fixable: true,
              fix: (f) => ({
                camera_movement: `${f.camera_movement}; ${kw}`
              })
            });
          }
        }
      }
    }

    return issues;
  }

  /**
   * 解析时间轴（支持纯文本和结构化对象）
   */
  _parseTimeline(timeline) {
    // 如果是结构化对象
    if (typeof timeline === 'object' && timeline.beats) {
      return timeline.beats.map(b => ({
        time: b.time || 0,
        label: b.label || '',
        description: b.description || '',
        cameraHint: b.cameraHint || ''
      }));
    }

    // 如果是纯文本，尝试解析T00:XX格式
    const text = String(timeline);
    const beats = [];
    const regex = /T00:(\d+)\s*-\s*([^；]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const time = parseInt(match[1], 10);
      const desc = match[2].trim();
      // 提取label（第一个逗号前的内容）
      const labelEnd = desc.indexOf('，');
      const label = labelEnd > 0 ? desc.substring(0, labelEnd) : desc;
      const description = labelEnd > 0 ? desc.substring(labelEnd + 1) : '';
      beats.push({ time, label, description, cameraHint: '' });
    }

    return beats;
  }

  /**
   * 5. 时间轴-动作同步 ⭐ v2.1.7增强版
   * timeline的每个节拍必须有对应的action变化
   */
  _checkTimelineAction(fields) {
    const issues = [];
    const timeline = fields.timeline || '';
    const action = String(fields.action || '');

    if (!timeline || !action) return issues;

    // 解析时间轴
    const beats = this._parseTimeline(timeline);
    if (beats.length === 0) return issues;

    // 提取action中的动作词
    const actionWords = ['抬手', '挥手', '奔跑', '跳跃', '转身', '攻击', '防御', '站立', '坐下', '行走', '推', '拉', '举'];
    const actionHasWords = actionWords.filter(w => action.includes(w));

    // 检查每个节拍是否有对应动作
    for (const beat of beats) {
      const combined = (beat.label || '') + ' ' + (beat.description || '');
      const beatActions = actionWords.filter(w => combined.includes(w));
      
      if (beatActions.length > 0 && !beatActions.some(a => action.includes(a))) {
        issues.push({
          severity: 'warning',
          fieldA: 'timeline',
          fieldB: 'action',
          message: `时间轴节拍"${beat.label || beat.time}"描述动作"${beatActions[0]}"，但action字段未包含`,
          fixable: false // 【fix】禁止向 action 追加 "T00:9推" 式残片，留给定向补齐轮由 LLM 完整改写
        });
      }
    }

    return issues;
  }

  /**
   * 6. 场景-灯光-明亮约束时序一致
   * 夜晚场景不能bright_constraint="bright lighting"
   */
  _checkSceneLightingBright(fields) {
    const issues = [];
    const scene = String(fields.scene || '').toLowerCase();
    const lighting = String(fields.lighting || '').toLowerCase();
    const bright = String(fields.bright_constraint || '').toLowerCase();

    // 检查场景时间
    const nightMarkers = ['夜晚', 'night', 'dark', 'moon', 'stars', 'midnight', 'evening'];
    const dayMarkers = ['白天', 'day', 'sun', 'morning', 'afternoon', 'noon'];
    const isNight = nightMarkers.some(m => scene.includes(m));
    const isDay = dayMarkers.some(m => scene.includes(m));

    if (isNight && bright.includes('bright') && !bright.includes('not bright')) {
      issues.push({
        severity: 'error',
        fieldA: 'scene',
        fieldB: 'bright_constraint',
        message: '夜晚场景但bright_constraint要求明亮，矛盾',
        fixable: true,
        fix: (f) => ({
          bright_constraint: 'atmospheric low-key lighting, moonlight illumination, dark moody ambiance, clear visibility through contrast not brightness'
        })
      });
    }

    if (isDay && lighting.includes('dark') && !lighting.includes('not dark')) {
      issues.push({
        severity: 'warning',
        fieldA: 'scene',
        fieldB: 'lighting',
        message: '白天场景但lighting描述为暗光，可能矛盾',
        fixable: false
      });
    }

    return issues;
  }

  /**
   * 7. 动作-运镜同步
   * 快速动作需要fast camera，缓慢动作需要slow camera
   */
  _checkActionCamera(fields) {
    const issues = [];
    const action = String(fields.action || '').toLowerCase();
    const camera = String(fields.camera_movement || '').toLowerCase();

    if (!action || !camera) return issues;

    const fastActions = ['奔跑', '冲刺', '跳跃', '攻击', '挥舞', '快速', '猛冲', '冲锋', '突进'];
    const slowActions = ['站立', '静坐', '沉思', '凝视', '缓慢', '静止', '定格', '沉思'];

    const isFastAction = fastActions.some(a => action.includes(a));
    const isSlowAction = slowActions.some(a => action.includes(a));

    if (isFastAction) {
      const fastCamera = ['fast', 'handheld', 'quick', 'track', 'follow'];
      const hasFastCamera = fastCamera.some(c => camera.includes(c));
      if (!hasFastCamera) {
        issues.push({
          severity: 'warning',
          fieldA: 'action',
          fieldB: 'camera_movement',
          message: '动作快速但运镜没有快速/跟踪/手持',
          fixable: true,
          fix: (f) => ({
            camera_movement: `fast handheld tracking following the action; ${f.camera_movement}`
          })
        });
      }
    }

    if (isSlowAction) {
      const slowCamera = ['slow', 'static', 'stable', 'smooth'];
      const hasSlowCamera = slowCamera.some(c => camera.includes(c));
      if (!hasSlowCamera) {
        issues.push({
          severity: 'warning',
          fieldA: 'action',
          fieldB: 'camera_movement',
          message: '动作缓慢但运镜没有稳定/缓慢',
          fixable: true,
          fix: (f) => {
          const hasMove = /拉远|推近|横移|跟拍|摇|升降|移动|拉镜|推镜/.test(String(f.camera_movement || ''));
          if (hasMove) return {}; // 已有明确运动设计，不追加矛盾描述
          return { camera_movement: `稳定缓慢运镜，匀速无顿挫；${f.camera_movement}` };
        }
        });
      }
    }

    return issues;
  }

  /**
   * 8. 构图-运镜景别一致
   * composition的shot_size必须与camera_movement的景别一致
   */
  _checkCompositionCamera(fields) {
    const issues = [];
    const composition = String(fields.composition || '').toLowerCase();
    const camera = String(fields.camera_movement || '').toLowerCase();

    if (!composition || !camera) return issues;

    const shotSizes = {
      wide: ['全景', 'wide', 'long shot', 'establishing', '全景'],
      medium: ['中景', 'medium', 'medium shot', 'waist', '膝上'],
      close: ['特写', 'close', 'close-up', 'close up', '面部', '眼睛'],
      extreme: ['极特写', 'extreme', 'extreme close-up', 'macro', '细节']
    };

    // 提取composition的景别
    let compSize = null;
    for (const [size, markers] of Object.entries(shotSizes)) {
      if (markers.some(m => composition.includes(m))) {
        compSize = size;
        break;
      }
    }

    // 提取camera_movement的景别
    let camSize = null;
    for (const [size, markers] of Object.entries(shotSizes)) {
      if (markers.some(m => camera.includes(m))) {
        camSize = size;
        break;
      }
    }

    // 如果两者都有景别描述且不一致
    if (compSize && camSize && compSize !== camSize) {
      issues.push({
        severity: 'error',
        fieldA: 'composition',
        fieldB: 'camera_movement',
        message: `构图景别(${compSize})与运镜景别(${camSize})不一致`,
        fixable: true,
        fix: (f) => {
          // 以composition为准修正camera_movement
          const sizeMap = {
            wide: '远景建立镜头',
            medium: '中景取景',
            close: '近景聚焦',
            extreme: '大特写微距'
          };
          return { camera_movement: `${sizeMap[compSize]}；${f.camera_movement}` };
        }
      });
    }

    return issues;
  }

  /**
   * 9. 景深-景别一致
   * 特写→浅景深, 全景→深景深
   */
  _checkDepthOfFieldComposition(fields) {
    const issues = [];
    const dof = String(fields.depth_of_field || '').toLowerCase();
    const composition = String(fields.composition || '').toLowerCase();

    if (!dof || !composition) return issues;

    // 提取composition的景别
    const isClose = ['特写', 'close', 'close-up', '面部', '眼睛'].some(m => composition.includes(m));
    const isWide = ['全景', 'wide', 'establishing', 'long shot'].some(m => composition.includes(m));

    // 特写应该有浅景深
    if (isClose) {
      const shallow = ['shallow', 'f/2', 'f/1', 'blur', 'bokeh', 'f/2.8'];
      const hasShallow = shallow.some(s => dof.includes(s));
      if (!hasShallow) {
        issues.push({
          severity: 'warning',
          fieldA: 'composition',
          fieldB: 'depth_of_field',
          message: '特写镜头但景深没有浅景深(f/2.8以下)，背景虚化不足',
          fixable: true,
          fix: (f) => ({
            depth_of_field: `shallow depth of field f/2.8, strong background bokeh, sharp focus on subject; ${f.depth_of_field}`
          })
        });
      }
    }

    // 全景应该有深景深
    if (isWide) {
      const deep = ['deep', 'f/8', 'f/11', 'f/16', 'sharp throughout'];
      const hasDeep = deep.some(d => dof.includes(d));
      if (!hasDeep) {
        issues.push({
          severity: 'warning',
          fieldA: 'composition',
          fieldB: 'depth_of_field',
          message: '全景镜头但景深没有深景深(f/8以上)，前景背景清晰度不足',
          // 【v2.2-refine】不再向景深字段拼 f/8 英文前缀(与正文 f/2.0-f/5.6 直接矛盾), 仅告警
          fixable: false
        });
      }
    }

    return issues;
  }

  /**
   * 10. 节奏-运镜速度一致
   * pacing说fast则camera必须有fast
   */
  _checkPacingCamera(fields) {
    const issues = [];
    const pacing = String(fields.pacing || '').toLowerCase();
    const camera = String(fields.camera_movement || '').toLowerCase();

    if (!pacing || !camera) return issues;

    const fastPacing = ['fast', 'quick', 'rapid', 'tense', 'urgent', 'accelerating'];
    const slowPacing = ['slow', 'gentle', 'gradual', 'calm', 'peaceful', 'relaxed'];

    const isFastPacing = fastPacing.some(p => pacing.includes(p));
    const isSlowPacing = slowPacing.some(p => pacing.includes(p));

    if (isFastPacing) {
      const fastCamera = ['fast', 'quick', 'handheld', 'whip'];
      const hasFast = fastCamera.some(c => camera.includes(c));
      if (!hasFast) {
        issues.push({
          severity: 'warning',
          fieldA: 'pacing',
          fieldB: 'camera_movement',
          message: 'pacing描述为快速/紧张，但camera_movement没有快速运镜',
          fixable: true,
          fix: (f) => ({
            camera_movement: `fast dynamic camera movement matching the quick pacing; ${f.camera_movement}`
          })
        });
      }
    }

    if (isSlowPacing) {
      const slowCamera = ['slow', 'static', 'smooth', 'gentle'];
      const hasSlow = slowCamera.some(c => camera.includes(c));
      if (!hasSlow) {
        issues.push({
          severity: 'warning',
          fieldA: 'pacing',
          fieldB: 'camera_movement',
          message: 'pacing描述为缓慢/平静，但camera_movement没有缓慢运镜',
          fixable: true,
          fix: (f) => ({
            camera_movement: `slow smooth camera movement, gentle and relaxed; ${f.camera_movement}`
          })
        });
      }
    }

    return issues;
  }

  // ==================== 【P1-PROMPT-04 修复】新增10组校验规则 ====================

  /**
   * 11. 场景-灯光一致性
   * 室内场景应有室内光源关键词，室外场景应有自然光关键词
   */
  _checkSceneLighting(fields) {
    const issues = [];
    const scene = String(fields.scene || '').toLowerCase();
    const lighting = String(fields.lighting || '').toLowerCase();
    if (!scene || !lighting) return issues;

    const indoorKeywords = ['室内', '房间', '办公室', '走廊', '医院', '教室', 'inside', 'room', 'office', 'indoor'];
    const outdoorKeywords = ['室外', '户外', '街道', '天空', '自然', 'outside', 'outdoor', 'street', 'nature'];
    const isIndoor = indoorKeywords.some(k => scene.includes(k));
    const isOutdoor = outdoorKeywords.some(k => scene.includes(k));

    if (isIndoor && !['室内灯', '顶灯', '台灯', 'fluorescent', 'led', 'tungsten', 'incandescent'].some(k => lighting.includes(k))) {
      issues.push({ severity: 'warning', fieldA: 'scene', fieldB: 'lighting', message: '室内场景但灯光没有室内光源描述', fixable: true, fix: (f) => ({ lighting: `indoor lighting, ${f.lighting}` }) });
    }
    if (isOutdoor && !['自然光', '日光', '阳光', 'sunlight', 'daylight', 'natural light'].some(k => lighting.includes(k))) {
      issues.push({ severity: 'warning', fieldA: 'scene', fieldB: 'lighting', message: '室外场景但灯光没有自然光描述', fixable: true, fix: (f) => ({ lighting: `natural sunlight, ${f.lighting}` }) });
    }
    return issues;
  }

  /**
   * 12. 动作-道具一致性
   * 动作描述应引用道具字段中的道具
   */
  _checkActionProps(fields) {
    const issues = [];
    const action = String(fields.action || '').toLowerCase();
    const props = String(fields.props || '').toLowerCase();
    if (!action || !props) return issues;

    // 提取道具关键词
    const propItems = props.split(/[,，;；]/).map(p => p.trim()).filter(p => p.length > 1);
    const unreferencedProps = propItems.filter(p => !action.includes(p.toLowerCase()));

    if (unreferencedProps.length > 0 && unreferencedProps.length === propItems.length) {
      issues.push({ severity: 'warning', fieldA: 'action', fieldB: 'props', message: `动作没有引用任何道具(${unreferencedProps.slice(0, 3).join(', ')})`, fixable: false });
    }
    return issues;
  }

  /**
   * 13. 角色-服装一致性
   * 角色描述中的服装应与服装字段一致
   */
  _checkCharacterCostume(fields) {
    const issues = [];
    const character = String(fields.character || '').toLowerCase();
    const costume = String(fields.costume || '').toLowerCase();
    if (!character || !costume) return issues;

    // 检查角色描述是否包含服装字段的关键词
    const costumeKeywords = costume.split(/[,，;；]/).map(c => c.trim()).filter(c => c.length > 1);
    const hasCostumeRef = costumeKeywords.some(k => character.includes(k.toLowerCase()));

    if (!hasCostumeRef) {
      issues.push({
        severity: 'warning', fieldA: 'character', fieldB: 'costume',
        message: '角色描述没有引用服装字段的内容', fixable: true,
        fix: (f) => {
          const costumeHead = String(f.costume || '').replace(/^(.*?穿)/, '').slice(0, 8);
          if (costumeHead && String(f.character).includes(costumeHead)) return {}; // 已含，不重复
          return { character: `${f.character}（着装与服装字段一致）` };
        }
      });
    }
    return issues;
  }

  /**
   * 14. 台词-音频一致性
   * 有台词时音频应包含人声描述
   */
  _checkDialogueAudio(fields) {
    const issues = [];
    const dialogue = String(fields.dialogue || '').trim();
    const audio = String(fields.audio || '').toLowerCase();
    if (!dialogue || !audio) return issues;

    const hasVoice = ['人声', 'voice', 'dialogue', 'speech', 'spoken', '对话'].some(k => audio.includes(k));
    if (!hasVoice) {
      // 【v2.2-refine】英文前缀 → 中文短语, 且已含人声要素则不注入
      issues.push({
        severity: 'warning', fieldA: 'dialogue', fieldB: 'audio',
        message: '有台词但音频没有包含人声/对话描述',
        fixable: true,
        fix: (f) => {
          const current = String(f.audio || '');
          if (/人声|对话|台词|voice/i.test(current)) return null;
          return { audio: `人声对话清晰可辨，${current}` };
        }
      });
    }
    return issues;
  }

  /**
   * 15. 色彩-灯光一致性
   * 色温描述应匹配
   */
  _checkColorLighting(fields) {
    const issues = [];
    const color = String(fields.color_palette || '').toLowerCase();
    const lighting = String(fields.lighting || '').toLowerCase();
    if (!color || !lighting) return issues;

    const warmColors = ['暖', 'warm', 'golden', 'orange', 'amber', 'yellow'];
    const coolColors = ['冷', 'cool', 'blue', 'cyan', 'cold', 'teal'];
    const warmLight = ['5600k', '暖', 'warm', 'tungsten', 'golden hour', 'sunset'];
    const coolLight = ['冷', 'cool', 'blue', 'daylight', 'overcast', 'fluorescent'];

    const isWarmColor = warmColors.some(k => color.includes(k));
    const isCoolColor = coolColors.some(k => color.includes(k));
    const isWarmLight = warmLight.some(k => lighting.includes(k));
    const isCoolLight = coolLight.some(k => lighting.includes(k));

    if (isWarmColor && isCoolLight) {
      issues.push({ severity: 'warning', fieldA: 'color_palette', fieldB: 'lighting', message: '色彩偏暖但灯光描述偏冷，色温不一致', fixable: false });
    }
    if (isCoolColor && isWarmLight) {
      issues.push({ severity: 'warning', fieldA: 'color_palette', fieldB: 'lighting', message: '色彩偏冷但灯光描述偏暖，色温不一致', fixable: false });
    }
    return issues;
  }

  /**
   * 16. 转场-节奏一致性
   * 快节奏应配快速转场，慢节奏应配柔和转场
   */
  _checkTransitionPacing(fields) {
    const issues = [];
    const transition = String(fields.transition || '').toLowerCase();
    const pacing = String(fields.pacing || '').toLowerCase();
    if (!transition || !pacing) return issues;

    const fastPacing = ['fast', 'quick', 'rapid', 'tense'];
    const slowPacing = ['slow', 'gentle', 'calm', 'relaxed'];
    const isFast = fastPacing.some(p => pacing.includes(p));
    const isSlow = slowPacing.some(p => pacing.includes(p));

    const slowTransitions = ['淡入淡出', 'fade', 'dissolve', '渐变'];
    const fastTransitions = ['硬切', 'cut', '闪切', 'whip'];
    const hasSlowTrans = slowTransitions.some(t => transition.includes(t));
    const hasFastTrans = fastTransitions.some(t => transition.includes(t));

    if (isFast && hasSlowTrans) {
      issues.push({ severity: 'warning', fieldA: 'transition', fieldB: 'pacing', message: '节奏快速但转场为柔和类型', fixable: true, fix: (f) => ({ transition: 'hard cut, quick transition' }) });
    }
    if (isSlow && hasFastTrans) {
      issues.push({ severity: 'warning', fieldA: 'transition', fieldB: 'pacing', message: '节奏缓慢但转场为快速类型', fixable: true, fix: (f) => ({ transition: 'slow dissolve, gentle fade' }) });
    }
    return issues;
  }

  /**
   * 17. 导演意图-场景一致性
   * 导演风格应与场景类型匹配
   */
  _checkDirectorScene(fields) {
    const issues = [];
    const director = String(fields.director_instruction || '').toLowerCase();
    const scene = String(fields.scene || '').toLowerCase();
    if (!director || !scene) return issues;

    const realisticScenes = ['医院', '办公室', '教室', '街道', '医院', 'clinic', 'office', 'street'];
    const stylizedDirectors = ['动画', 'anime', 'cartoon', 'illustration', 'painting', '3d render'];
    const isRealisticScene = realisticScenes.some(s => scene.includes(s));
    const isStylizedDirector = stylizedDirectors.some(d => director.includes(d));

    if (isRealisticScene && isStylizedDirector) {
      issues.push({ severity: 'error', fieldA: 'director_instruction', fieldB: 'scene', message: '写实场景但导演意图包含非写实风格', fixable: true, fix: (f) => ({ director_instruction: 'photorealistic, cinematic, highly detailed, 8K resolution' }) });
    }
    return issues;
  }

  /**
   * 18. 约束-负面约束一致性
   * constraint和negative不应矛盾
   */
  _checkConstraintNegative(fields) {
    const issues = [];
    const constraint = String(fields.constraint || '').toLowerCase();
    const negative = String(fields.negative || '').toLowerCase();
    if (!constraint || !negative) return issues;

    // 检查是否同时要求某特性又禁止它
    const contradictions = [
      { pos: 'text', neg: 'no text' },
      { pos: 'subtitle', neg: 'no subtitle' },
      { pos: 'watermark', neg: 'no watermark' }
    ];

    for (const c of contradictions) {
      if (constraint.includes(c.pos) && negative.includes(c.neg)) {
        issues.push({ severity: 'error', fieldA: 'constraint', fieldB: 'negative', message: `constraint和negative矛盾:同时涉及${c.pos}`, fixable: false });
      }
    }
    return issues;
  }

  /**
   * 19. 构图-色彩一致性
   * 构图的留白/紧凑应与色彩饱和度匹配
   */
  _checkCompositionColor(fields) {
    const issues = [];
    const composition = String(fields.composition || '').toLowerCase();
    const color = String(fields.color_palette || '').toLowerCase();
    if (!composition || !color) return issues;

    const isMinimal = ['留白', 'minimal', 'negative space', 'sparse', 'empty'].some(k => composition.includes(k));
    const isHighSaturation = ['高饱和', 'vivid', 'saturated', 'bright', 'bold'].some(k => color.includes(k));

    if (isMinimal && isHighSaturation) {
      issues.push({ severity: 'warning', fieldA: 'composition', fieldB: 'color_palette', message: '极简构图但色彩高饱和，风格冲突', fixable: false });
    }
    return issues;
  }

  /**
   * 20. 时间轴-音频同步
   * 时间轴中的音频提示应与audio字段一致
   */
  _checkTimelineAudio(fields) {
    const issues = [];
    const timeline = String(fields.timeline || '').toLowerCase();
    const audio = String(fields.audio || '').toLowerCase();
    if (!timeline || !audio) return issues;

    // 检查时间轴是否提到音频变化而audio字段没有对应描述
    const timelineAudioRefs = ['音效', '音乐', '配乐', 'sound', 'music', 'audio'];
    const hasTimelineAudio = timelineAudioRefs.some(r => timeline.includes(r));
    const hasAudioDetail = audio.length > 50; // audio字段有详细描述

    if (hasTimelineAudio && !hasAudioDetail) {
      issues.push({ severity: 'warning', fieldA: 'timeline', fieldB: 'audio', message: '时间轴提到音频但audio字段描述过短', fixable: false });
    }
    return issues;
  }

  // ==================== 辅助方法 ====================

  /**
   * 从mood字符串提取核心情绪
   */
  _extractMood(moodStr) {
    if (!moodStr) return null;
    const str = String(moodStr).toLowerCase();
    
    const moodMap = {
      tense: ['tense', '紧张', '紧迫', '悬疑', 'anxious', 'nervous', 'suspense'],
      sad: ['sad', '悲伤', '忧郁', 'melancholy', 'sorrow', 'grief', 'depressed'],
      epic: ['epic', '史诗', '宏大', '壮丽', 'grand', 'majestic', 'heroic'],
      warm: ['warm', '温馨', '温暖', 'cozy', 'gentle', 'tender', 'affectionate'],
      calm: ['calm', '平静', '宁静', 'peaceful', 'serene', 'tranquil', 'quiet']
    };

    for (const [mood, markers] of Object.entries(moodMap)) {
      if (markers.some(m => str.includes(m))) return mood;
    }
    return null;
  }
}

module.exports = { FieldConsistencyChecker };
