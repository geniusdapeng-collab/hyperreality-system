/**
 * FieldRepairAgent - 内容修复环节（v2.1.14-fix）
 * 负责: 接收检查报告 + 原始PRD，对镜头提示词进行修复
 * 位置: FieldCheckAgent之后，FieldGuard之前
 *
 * 【v2.1.14-fix 四故障修复】
 * 故障A（JSON崩溃）: 引入 json-salvage 鲁棒提取；提取失败记录原始响应落盘审计，
 * 且按批次独立降级——单批失败不再拖垮整轮修复
 * 故障B（180s超时）: LLM 修复按字段分批（每批≤5个），超时按批量自适应
 * （1-3字段120s / 4-5字段180s），单批上下文大幅缩小
 * 故障C（规则层太弱）: RuleRepairer 新增 12 类确定性"要素补齐" +
 * PRD 风格锚点对齐 + 角色名跨字段一致性锚定，严重级格式问题无需 LLM 即可修
 * 故障D（_recheckRemaining 白名单失真）: 改为规则修复后【重跑 RuleChecker 实检】，
 * 只把真实剩余问题+未被规则触及的语义问题推给 LLM，噪音归零
 *
 * 附带修复（诊断包未列出，审计中发现）：
 * 5. LLMRepairer 错误路径返回 {repairedShot} 与调用方解构 {repaired} 不匹配，
 * 会导致 repaired=undefined 流入 PromptSync 崩溃 → 统一返回 {repaired, actions}
 * 6. 修复温度 temperature:1 → 0.3（结构化输出任务，高温是"等等，重新看"的温床）
 * 7. 修复 prompt 注入字段级格式硬约束（与 RuleChecker 判定规则一一对应），
 * 解决"检查器比修复器严"导致的永不通过死循环
 *
 * 架构:
 *   RuleRepairer (规则自动修复层) - 确定性问题秒修
 *   LLMRepairer (LLM智能修复层) - PRD注入，分批修复
 *   _recheckRemaining() - 规则修复后实检剩余问题，只传给LLM
 */
const fs = require('fs');
const path = require('path');
const { BaseAgent } = require('../production-engine/agents/base-agent');
const { deepClone } = require('../../utils/safe-clone');
const { SPEC_MAP, Priority, Severity, IssueType, MAX_TOTAL_CHARS, FIELD_REQUIREMENTS } = require('./field-check-agent');
const { extractJson } = require('./json-salvage');

// 原始响应审计目录（LLM 返回无法解析时落盘，供人工复盘）
const RAW_LOG_DIR = path.join(__dirname, '..', '..', 'output', 'field-quality');

function _saveRawResponse(tag, raw) {
  try {
    if (!fs.existsSync(RAW_LOG_DIR)) fs.mkdirSync(RAW_LOG_DIR, { recursive: true });
    const file = path.join(RAW_LOG_DIR, `llm-raw-${tag}-${Date.now()}.log`);
    fs.writeFileSync(file, String(raw ?? '(null)'), 'utf8');
    return file;
  } catch (_) {
    return null;
  }
}

// ============================================================
// 数据模型 - RepairAction, RepairLog, PRD
// ============================================================

class RepairAction {
  constructor({ fieldEn, method, before, after, reason }) {
    this.fieldEn = fieldEn;
    this.method = method; // 'rule' | 'llm'
    this.before = before;
    this.after = after;
    this.reason = reason;
  }
}

class RepairLog {
  constructor(shotId) {
    this.shotId = shotId;
    this.actions = [];
    this.prdReferenced = false;
  }

  add(action) { this.actions.push(action); }
}

class PRD {
  constructor({
    projectName = '',
    videoType = '',
    styleDirection = '',
    moodTone = '',
    characters = [],
    scenes = [],
    dialogues = [],
    specialConstraints = [],
    targetPlatform = '',
    rawText = '',
  }) {
    this.projectName = projectName;
    this.videoType = videoType;
    this.styleDirection = styleDirection;
    this.moodTone = moodTone;
    this.characters = characters;
    this.scenes = scenes;
    this.dialogues = dialogues;
    this.specialConstraints = specialConstraints;
    this.targetPlatform = targetPlatform;
    this.rawText = rawText;
  }

  toConstraintText() {
    const lines = [];
    if (this.projectName) lines.push(`项目名称：${this.projectName}`);
    if (this.videoType) lines.push(`视频类型：${this.videoType}`);
    if (this.styleDirection) lines.push(`风格方向：${this.styleDirection}`);
    if (this.moodTone) lines.push(`情绪基调：${this.moodTone}`);
    if (this.targetPlatform) lines.push(`目标平台：${this.targetPlatform}`);
    if (this.characters.length) {
      const charDesc = this.characters.map(c => `${c.name || ''}(${c.identity || ''})`).join('； ');
      lines.push(`角色设定：${charDesc}`);
    }
    if (this.scenes.length) {
      const sceneDesc = this.scenes.map(s => typeof s === 'string' ? s : s.description || '').join('； ');
      lines.push(`场景要求：${sceneDesc}`);
    }
    if (this.dialogues.length) {
      lines.push(`台词内容：${this.dialogues.join(' / ')}`);
    }
    if (this.specialConstraints.length) {
      lines.push(`特殊约束：${this.specialConstraints.join('； ')}`);
    }
    return lines.join('\n');
  }

  // 从 blueprint/metadata 自动构建 PRD
  // 【脱节3 修复】使用正确的字段映射，兼容双轨 metadata 结构
  static fromBlueprint(blueprint) {
    const meta = blueprint._metadata || blueprint.config?._metadata || {};
    const characters = blueprint.characters || [];
    const scenes = blueprint.scenes || [];

    // 从多层级结构中解析视频类型
    const videoType = meta.videoType || blueprint.videoType || blueprint.type || 'general';

    // 从风格字段解析风格方向（支持单轨/双轨）
    let styleDirection = meta.styleDirection || '';
    if (!styleDirection && blueprint.style) {
      const style = typeof blueprint.style === 'string' ? blueprint.style : (blueprint.style.primary || '');
      styleDirection = style;
    }

    // 从情绪字段解析（支持双轨：mood/emotionProfile）
    let moodTone = meta.moodTone || '';
    if (!moodTone) {
      if (blueprint.emotionProfile?.primary) {
        moodTone = `${blueprint.emotionProfile.primary}${blueprint.emotionProfile.secondary ? '+' + blueprint.emotionProfile.secondary : ''}`;
      } else if (blueprint.mood) {
        moodTone = blueprint.mood;
      } else if (blueprint.tone) {
        moodTone = blueprint.tone;
      }
    }

    // 解析角色（兼容多种格式）
    const parsedCharacters = characters.map(c => ({
      name: c.name || '',
      nameEn: c.nameEn || c.name_en || '',
      identity: c.identity || c.role || c.description || '',
      appearance: c.appearance || c.costume || c.description || '',
    }));

    // 解析场景（兼容字符串和对象格式）
    const parsedScenes = scenes.map(s => {
      if (typeof s === 'string') return s;
      return s.description || s.purpose || s.scene || JSON.stringify(s);
    }).filter(Boolean);

    // 解析特殊约束（多源合并）
    const specialConstraints = [];
    if (Array.isArray(meta.specialConstraints)) {
      specialConstraints.push(...meta.specialConstraints);
    }
    if (Array.isArray(blueprint.contentConstraints)) {
      specialConstraints.push(...blueprint.contentConstraints);
    }
    if (Array.isArray(blueprint.forbiddenElements)) {
      specialConstraints.push(...blueprint.forbiddenElements.map(f => `禁止: ${f}`));
    }

    // 解析台词
    const dialogues = (blueprint.dialogues || []).map(d => typeof d === 'string' ? d : d.text || '').filter(Boolean);

    return new PRD({
      projectName: blueprint.title || meta.projectName || '',
      videoType,
      styleDirection,
      moodTone,
      characters: parsedCharacters,
      scenes: parsedScenes,
      dialogues,
      specialConstraints: specialConstraints.slice(0, 10),
      targetPlatform: meta.targetPlatform || blueprint.platform || blueprint.targetPlatform || '',
      rawText: blueprint.rawText || ''
    });
  }
}

// ============================================================
// RuleRepairer - 规则自动修复层
// ============================================================

class RuleRepairer {
  repair(shot, report, prd = null) {
    const repaired = deepClone(shot);
    const actions = [];

    for (const issue of report.issues) {
      const fieldEn = issue.fieldEn;
      if (fieldEn === '_total') continue; // 总长度由LLM统一处理
      const current = repaired[fieldEn] || '';

      // 【审计修复·P0】新增：MISSING 类型问题的智能默认值填充
      if (issue.issueType === IssueType.MISSING && (!current || this._isEffectivelyEmpty(current))) {
        const defaultValue = this._generateDefault(fieldEn, prd, repaired);
        if (defaultValue && String(defaultValue).trim()) {
          repaired[fieldEn] = defaultValue;
          actions.push(new RepairAction({
            fieldEn, method: 'rule', before: current || '(空)',
            after: defaultValue,
            reason: `规则修复：${fieldEn} 字段缺失，根据上下文填充默认值`
          }));
          continue; // 已修复，跳过后续对该字段的处理
        }
      }

      // 修复1：负面约束缺失基础词
      if (fieldEn === 'negative' && current && issue.issueType === IssueType.INCOMPLETE && /no text/.test(issue.description)) {
        let fixed = current;
        if (!fixed.toLowerCase().includes('no text')) {
          fixed = 'no text, no watermark, ' + fixed;
        }
        if (fixed !== current) {
          repaired[fieldEn] = fixed;
          actions.push(new RepairAction({
            fieldEn, method: 'rule', before: current, after: fixed,
            reason: "规则修复：自动补充 'no text, no watermark' 基础负面词"
          }));
        }
      }

      // 修复2：定妆照路径格式
      if (fieldEn === 'portraits' && current && issue.issueType === IssueType.FORMAT_ERROR) {
        // 【P1-7 修复】portraits 可能是数组，先归一化为字符串
        const portraitsStr = Array.isArray(current)
          ? current.map(p => typeof p === 'string' ? p : (p && p.path ? p.path : JSON.stringify(p))).join(', ')
          : String(current);
        let normalized = portraitsStr.replace(/^['"]|['"]$/g, '').trim();
        if (prd && prd.characters.length) {
          const charName = prd.characters[0].nameEn || 'character';
          normalized = `/characters/${charName}/portrait_v1.png`;
        }
        if (normalized !== current) {
          repaired[fieldEn] = normalized;
          actions.push(new RepairAction({
            fieldEn, method: 'rule', before: current, after: normalized,
            reason: '规则修复：定妆照路径规范化为标准格式'
          }));
        }
      }

      // 修复3：台词句末标点
      if (fieldEn === 'dialogue' && current && issue.issueType === IssueType.FORMAT_ERROR && /句末标点/.test(issue.description)) {
        if (current && !/[。！？…]$/.test(current)) {
          const fixed = current + '。';
          repaired[fieldEn] = fixed;
          actions.push(new RepairAction({
            fieldEn, method: 'rule', before: current, after: fixed,
            reason: "规则修复：自动补充句末标点 '。'（口型闭合信号标记）"
          }));
        }
      }

      // 修复4：台词禁止标点移除
      if (fieldEn === 'dialogue' && current && issue.issueType === IssueType.FORMAT_ERROR && /禁止标点/.test(issue.description)) {
        const fixed = current.replace(/[；;：:""''"'\[\]【】]/g, ',');
        if (fixed !== current) {
          repaired[fieldEn] = fixed;
          actions.push(new RepairAction({
            fieldEn, method: 'rule', before: current, after: fixed,
            reason: '规则修复：移除禁止标点，替换为逗号'
          }));
        }
      }

      // 修复5：P2/P3字段超长规则截断
      if (fieldEn in SPEC_MAP && issue.issueType === IssueType.OVER_LENGTH && [Priority.P2, Priority.P3].includes(SPEC_MAP[fieldEn].priority)) {
        const spec = SPEC_MAP[fieldEn];
        if (current.length > spec.charMax) {
          let truncated = current.slice(0, spec.charMax);
          const lastComma = Math.max(truncated.lastIndexOf(','), truncated.lastIndexOf('，'), truncated.lastIndexOf(' '));
          if (lastComma > spec.charMax * 0.7) {
            truncated = truncated.slice(0, lastComma);
          }
          if (truncated !== current) {
            repaired[fieldEn] = truncated;
            actions.push(new RepairAction({
              fieldEn, method: 'rule', before: current, after: truncated,
              reason: `规则修复：${spec.priority} 字段超长，截断至 ${truncated.length} 字符`
            }));
          }
        }
      }

      // 【v2.1.14-fix 故障C】修复6：INCOMPLETE 要素确定性补齐
      // 覆盖 director_instruction/constraint/lighting/camera_movement/composition/
      // bright_constraint/character_constraint/timeline/pacing/costume/transition
      if (issue.issueType === IssueType.INCOMPLETE && typeof current === 'string' && current.trim()) {
        const completed = this._completeElements(fieldEn, current, issue, prd, repaired);
        if (completed && completed !== current) {
          repaired[fieldEn] = completed;
          actions.push(new RepairAction({
            fieldEn, method: 'rule', before: current, after: completed,
            reason: `规则修复：${fieldEn} 要素补齐（${issue.description.slice(0, 30)}）`
          }));
        }
      }
    }

    // 【v2.1.14-fix 故障C】修复7：PRD 风格锚点对齐 + 角色名一致性锚定
    // 对 scene/director_instruction/character/action/consistency 等语义字段，
    // 若与 PRD 完全无关键词重叠（如排练室内容混入南极冰川主题），注入 PRD 锚点短语
    if (prd) {
      const alignActions = this._alignWithPrd(repaired, prd);
      actions.push(...alignActions);
    }

    // 【P1-10 修复】RuleRepairer 写值同步 snake/camel/fields 三处
    for (const action of actions) {
      const fieldEn = action.fieldEn;
      const fixed = repaired[fieldEn];
      if (fixed === undefined) continue;
      const camel = fieldEn.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (camel !== fieldEn) repaired[camel] = fixed;
      if (repaired.fields && typeof repaired.fields === 'object') {
        repaired.fields[fieldEn] = fixed;
      }
    }

    return { repaired, actions };
  }

  /**
   * 【审计修复·P0】判断值是否实际为空（支持字符串/数组/对象）
   */
  _isEffectivelyEmpty(value) {
    if (!value) return true;
    if (typeof value === 'string') return !value.trim();
    if (Array.isArray(value)) return value.length === 0 || value.every(v => !v || (typeof v === 'string' && !v.trim()));
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  }

  /**
   * 【v2.1.14-fix 故障C】INCOMPLETE 要素确定性补齐
   * 按 RuleChecker 的判定规则逐字段补齐缺失要素，补齐后受 charMax 约束
   * @returns {string|null} 补齐后的值；无法规则补齐返回 null（留给 LLM）
   */
  _completeElements(fieldEn, current, issue, prd, repaired = null) {
    const spec = SPEC_MAP[fieldEn];
    const cap = (text) => {
      if (!spec || spec.charMax >= 9999) return text;
      return text.length > spec.charMax ? this._smartTruncate(text, spec.charMax) : text;
    };
    const lower = current.toLowerCase();
    const miss = issue.description; // 检查器产出的描述含"缺少要素：X、Y"

    switch (fieldEn) {
      case 'director_instruction': {
        const parts = [];
        if (miss.includes('风格定位')) parts.push(`风格：${prd?.styleDirection || '电影写实'}`);
        if (miss.includes('写实要求')) parts.push('超写实真实质感');
        if (miss.includes('情绪基调')) parts.push(`情绪基调：${prd?.moodTone || '自然沉稳'}`);
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'constraint': {
        const parts = [];
        if (miss.includes('画幅比例')) parts.push('16:9画幅');
        if (miss.includes('分辨率')) parts.push('1920x1080分辨率');
        if (miss.includes('输出格式')) parts.push('MP4格式');
        if (miss.includes('帧率')) parts.push('24fps帧率');
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'lighting': {
        const parts = [];
        if (miss.includes('主光描述')) parts.push('主光：顶部柔光');
        if (miss.includes('色温参数')) parts.push('色温5600K');
        if (miss.includes('光质定义')) parts.push('光质柔和漫射');
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'camera_movement': {
        const parts = [];
        if (miss.includes('运动方式')) parts.push('固定机位缓慢微推');
        if (miss.includes('速度参数')) parts.push('速度0.5m/s');
        if (miss.includes('时间分布')) parts.push('时间分布：开场0-2秒建立，中段推进，收尾定格');
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'composition': {
        const parts = [];
        if (miss.includes('景别等级')) parts.push('中景景别');
        if (miss.includes('主体位置')) parts.push('主体位于画面左侧三分之一处');
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'bright_constraint': {
        const parts = [];
        if (miss.includes('亮度要求')) parts.push('整体明亮光线充足');
        if (miss.includes('可见性')) parts.push('画面清晰可见');
        if (miss.includes('面部明亮')) parts.push('面部无阴影明亮清晰');
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'character_constraint': {
        const parts = [];
        if (miss.includes('单角色限制')) parts.push('仅出现指定角色');
        if (miss.includes('禁止分身声明')) parts.push('禁止分身克隆重复出现');
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'timeline': {
        // 分段不足 → 补足到 3 段
        const segs = current.match(/T\d{2}:\d{2}/g) || [];
        if (segs.length < 3) {
          const pad = ['T00:03-发展段，主体动作推进', 'T00:05-收尾段，情绪定格沉淀'];
          const need = pad.slice(0, 3 - segs.length);
          return cap(`${current}；${need.join('；')}`);
        }
        return null;
      }
      case 'pacing': {
        const parts = [];
        if (miss.includes('整体')) parts.push('整体：节奏统一');
        if (miss.includes('开头')) parts.push('开头：平稳引入');
        if (miss.includes('中段')) parts.push('中段：自然推进');
        if (miss.includes('高潮')) parts.push('高潮：轻微加速');
        if (miss.includes('结尾')) parts.push('结尾：从容收尾');
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'costume': {
        // 【v2.2-refine】空镜不补服装模板(原逻辑给空镜/工装镜头拼"外套:合身外套"四件套)
        const charText = String((repaired && (repaired.character || repaired.角色)) || '');
        if (/无角色|无人物|无指定角色|空镜/.test(charText)) {
          return '无角色出场，本字段不适用';
        }
        const parts = [];
        if (miss.includes('外套') || miss.includes('上装')) parts.push('外套：合身外套');
        if (miss.includes('内搭')) parts.push('内搭：简约内衬');
        if (miss.includes('下装')) parts.push('下装：合体长裤');
        if (miss.includes('鞋履')) parts.push('鞋履：整洁鞋靴');
        return parts.length ? cap(`${current}，${parts.join('，')}`) : null;
      }
      case 'transition': {
        return cap(`${current}，切镜过渡（硬切）`);
      }
      default:
        return null;
    }
  }

  /**
   * 【v2.1.14-fix 故障C】PRD 风格锚点对齐 + 角色名一致性
   * 场景/导演指令/角色/动作/一致性字段若与 PRD 零关键词重叠，注入锚点短语；
   * PRD 角色名未出现在角色/一致性字段时，追加角色锚定
   */
  _alignWithPrd(repaired, prd) {
    const actions = [];
    const anchorPhrase = this._prdAnchorPhrase(prd);
    const anchorKeywords = this._prdAnchorKeywords(prd);
    const charNames = (prd.characters || []).map(c => c.name).filter(Boolean);

    // 风格锚定字段：与 PRD 零重叠 → 前置锚点短语
    if (anchorPhrase && anchorKeywords.length) {
      for (const fieldEn of ['scene', 'director_instruction']) {
        const current = repaired[fieldEn];
        if (typeof current !== 'string' || !current.trim()) continue;
        const hasOverlap = anchorKeywords.some(k => current.includes(k));
        if (!hasOverlap) {
          const spec = SPEC_MAP[fieldEn];
          let fixed = `${anchorPhrase}，${current}`;
          if (spec && spec.charMax < 9999 && fixed.length > spec.charMax) {
            fixed = this._smartTruncate(fixed, spec.charMax);
          }
          if (fixed !== current) {
            repaired[fieldEn] = fixed;
            actions.push(new RepairAction({
              fieldEn, method: 'rule', before: current, after: fixed,
              reason: '规则修复：字段与PRD零关键词重叠，注入PRD风格锚点'
            }));
          }
        }
      }
    }

    // 角色名一致性锚定
    // 【v2.2-refine】空镜跳过角色锚定(原逻辑给S1/S7空镜拼上"角色锚定:李明、小周")
    const isEmptyShot = /无角色|无人物|无指定角色|空镜|空车厢/.test(String(repaired.character || ''));
    if (!isEmptyShot && charNames.length) {
      for (const fieldEn of ['character', 'consistency']) {
        const current = repaired[fieldEn];
        if (typeof current !== 'string' || !current.trim()) continue;
        const missing = charNames.filter(n => !current.includes(n));
        if (missing.length) {
          const spec = SPEC_MAP[fieldEn];
          let fixed = `${current}，角色锚定：${missing.join('、')}`;
          if (spec && spec.charMax < 9999 && fixed.length > spec.charMax) {
            fixed = this._smartTruncate(fixed, spec.charMax);
          }
          if (fixed !== current) {
            repaired[fieldEn] = fixed;
            actions.push(new RepairAction({
              fieldEn, method: 'rule', before: current, after: fixed,
              reason: `规则修复：追加PRD角色名锚定（${missing.join('、')}）`
            }));
          }
        }
      }
    }

    return actions;
  }

  /**
   * PRD 锚点短语：风格方向 + 首个场景（≤40字符）
   */
  _prdAnchorPhrase(prd) {
    const parts = [];
    if (prd.styleDirection) parts.push(prd.styleDirection);
    if (prd.scenes?.length) parts.push(String(prd.scenes[0]).slice(0, 30));
    return parts.join('，').slice(0, 40);
  }

  /**
   * PRD 锚点关键词集：从风格/场景/角色名中提取 2-6 字词元
   */
  _prdAnchorKeywords(prd) {
    const text = [prd.styleDirection || '', ...(prd.scenes || []).map(String), ...(prd.characters || []).map(c => c.name || '')].join('，');
    const tokens = text.split(/[,，、;；。\s\/（）()]+/).filter(t => t.length >= 2 && t.length <= 8);
    return [...new Set(tokens)].slice(0, 20);
  }

  /**
   * 智能截断（供规则层使用，与 LLMRepairer 同款逻辑）
   */
  _smartTruncate(text, maxLen) {
    if (text.length <= maxLen) return text;
    let truncated = text.slice(0, maxLen);
    for (const sep of [', ', '，', '; ', '；', ' ']) {
      const idx = truncated.lastIndexOf(sep);
      if (idx > maxLen * 0.6) {
        return truncated.slice(0, idx);
      }
    }
    return truncated;
  }

  /**
   * 【审计修复·P0】根据字段名和上下文生成智能默认值
   */
  _generateDefault(fieldEn, prd, shot) {
    const defaults = {
      director_instruction: prd?.styleDirection
        ? `${prd.styleDirection}，超写实8K电影级质感，情绪基调${prd?.moodTone || '自然沉稳'}`
        : '好莱坞电影级超写实8K质感，画面细腻真实，情绪基调自然沉稳',
      constraint: 'Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, Color space Rec.709',
      baseline: '8K超高清，电影级调色，真实物理光照，皮肤纹理细节完整，毛发渲染自然',
      scene: prd?.scenes?.length
        ? String(prd.scenes[0]).substring(0, 150)
        : '写实风格室内场景，自然光线充足，材质细节丰富，空间层次分明',
      lighting: '主光源：自然光5600K柔和漫射，补光：反光板柔化阴影，光质：柔和均匀无刺眼高光',
      camera_movement: '开场固定机位2秒建立构图，中段缓慢推轨接近主体速度0.5m/s，收尾稳定定格1秒',
      character: prd?.characters?.length
        ? `${prd.characters[0].name || '主角'}，${prd.characters[0].appearance || '写实形象，自然神态，服装得体'}`
        : '主角，写实形象，自然神态，服装得体，站姿放松自然',
      action: '自然站立，双手自然摆放，眼神平视前方，呼吸平稳，身体微微放松',
      dialogue: [{ speaker: '', text: '（无对白）' }],
      negative: 'no text anywhere in frame, no watermark, no logo, no subtitle, no caption, no blur, no distortion, no extra limbs, no deformed, no cartoon style, no anime, no illustration',
      portraits: prd?.characters?.length
        ? [`/characters/${prd.characters[0].nameEn || prd.characters[0].name || 'default'}/portrait_v1.png`]
        : ['/characters/default/portrait_v1.png'],
      consistency: prd?.characters?.length
        ? `保持${prd.characters[0].name || '角色'}形象跨镜头一致：发型、服装、面部特征、体型完全统一`
        : '保持角色形象跨镜头一致：发型、服装、面部特征、体型完全统一',
      composition: 'medium shot, subject positioned at left third intersection, balanced background, clear focal point',
      color_palette: 'natural color palette, warm skin tones, neutral background, balanced saturation, cinematic color grading',
      depth_of_field: 'moderate depth of field f/4, subject in sharp focus, soft background blur, cinematic separation',
      timeline: 'T00:00-开场构图，建立场景氛围；T00:02-主体动作，叙事推进；T00:05-收尾定格，情绪沉淀',
      mood: 'calm, professional, natural atmosphere',
      bright_constraint: '明亮光线充足，清晰可见，面部明亮无阴影 bright, clear, face lit',
      character_constraint: '只出现指定角色一人，禁止其他人物入镜，禁止同一角色重复出现，禁止角色分身或克隆',
      costume: '日常便装，整洁得体，符合角色身份设定',
      props: '符合场景逻辑的日常物品，与角色动作协调',
      pacing: '整体：舒缓自然；开头：平稳引入；中段：自然推进；高潮：轻微加速；结尾：从容收尾',
      audio: 'ambient environmental sound, subtle background atmosphere, natural room tone, no music',
      makeup: 'natural makeup, no heavy cosmetics, realistic skin texture visible',
      transition: 'hard cut, clean transition',
    };
    return defaults[fieldEn] || '';
  }
}

// ============================================================
// LLMRepairer - LLM智能修复层（PRD注入，分批修复）
// ============================================================

const LLM_REPAIRER_SYSTEM_PROMPT = `你是 AI 视频生成提示词的【内容修复专家】，精通 HyperrealitySystem 字段规范 v3.0。

你的任务是根据检查报告中的问题，对提示词字段进行修复。修复时必须遵守以下原则：

【修复原则】
1. 业务需求优先：修复内容必须符合【用户需求文档PRD】中的业务约束，不得偏离项目定位
2. 规范合规：修复后的字段必须符合字段规范（四要素/五要素/三段式等格式要求）
3. 最小改动：仅修改有问题的部分，不改动已合规的内容
4. 风格一致：修复后的字段须与其它字段保持风格一致
5. 强制中文输出：所有字段必须使用中文，禁止英文单词（专有名词如人名地名除外）
6. 修复即升格：修一个字段时，顺手把它从'合规'抬到'出色'——灯光补全K值与光比、动作补成物理动作链、场景补齐四件套+情绪细节。但不得改动该字段已确认的核心信息（台词原文/角色锚点/时长）。
7. 跨字段咬合：修复 lighting 时确认与 scene 的时间（夜/晨）一致；修复 action 时确认与 dialogue 的 trigger 一致；修复 timeline 时总时长与镜头时长严格相等。
8. 无效词替换表（修复时必须执行）：唯美→具体光色描述；震撼→具体体量对撞构图；自然流畅→具体运镜方式与速度；氛围感→具体环境音或材质细节。

【输出格式——硬性要求】
直接输出 JSON 对象本身，第一个字符就是 {，禁止输出任何自然语言开场白、思考过程或 markdown 围栏。
key 为需要修复的字段英文名，value 为修复后的完整字段内容：
{
  "repaired_fields": {
    "director_instruction": "修复后的完整内容",
    "lighting": "修复后的完整内容"
  }
}

只返回需要修复的字段，不要返回未出问题的字段。`;

class LLMRepairer {
  constructor(llmClient, timeoutMs = 180000, options = {}) {
    this.llm = llmClient;
    this.baseTimeoutMs = timeoutMs; // 【v2.1.14】作为自适应基准
    this.temperature = options.temperature ?? 0.3; // 【v2.1.14-fix】结构化任务低温
    this.maxFieldsPerBatch = options.maxFieldsPerBatch || 5; // 【v2.1.14-fix 故障B】分批阈值
  }

  /**
   * 【v2.1.14-fix 故障B】按批字段数自适应超时
   * 1-3 字段: 120s；4-5 字段: 180s（原固定值）；更大批量不会发生（已分批）
   */
  _timeoutForBatch(fieldCount) {
    if (this.baseTimeoutMs && this.baseTimeoutMs !== 180000) return this.baseTimeoutMs; // 显式配置优先
    return fieldCount <= 3 ? 120000 : 180000;
  }

  async repair(shot, report, prd) {
    // 筛选需要LLM修复的问题（排除规则已修复的）
    const llmIssues = report.issues.filter(i =>
      [Severity.FATAL, Severity.MAJOR].includes(i.severity) && i.fieldEn !== '_total'
    );

    if (!llmIssues.length || !this.llm) {
      return { repaired: shot, actions: [] };
    }

    // 【v2.1.14-fix 故障B】按字段分批（每批 ≤ maxFieldsPerBatch 个字段）
    const fieldsToRepair = [...new Set(llmIssues.map(i => i.fieldEn))];
    const batches = [];
    for (let i = 0; i < fieldsToRepair.length; i += this.maxFieldsPerBatch) {
      batches.push(fieldsToRepair.slice(i, i + this.maxFieldsPerBatch));
    }
    if (batches.length > 1) {
      console.log(`[LLMRepairer] ${fieldsToRepair.length} 个字段拆分为 ${batches.length} 批修复（每批≤${this.maxFieldsPerBatch}个）`);
    }

    let repairedShot = deepClone(shot);
    const actions = [];

    // 逐批修复：单批失败（超时/解析失败）不影响其他批次——不再整轮作废
    for (let bi = 0; bi < batches.length; bi++) {
      const batchFields = batches[bi];
      const batchIssues = llmIssues.filter(i => batchFields.includes(i.fieldEn));
      const batchTimeout = this._timeoutForBatch(batchFields.length);

      const result = await this._repairBatch(repairedShot, batchIssues, batchFields, prd, batchTimeout, bi + 1, batches.length);
      if (result.repaired) {
        repairedShot = result.repaired;
        actions.push(...result.actions);
      }
    }

    return { repaired: repairedShot, actions };
  }

  /**
   * 单批修复：构建 prompt → 调用 LLM → 鲁棒解析 → 应用结果
   * 任何失败都只影响本批，返回 null 表示本批未修复
   */
  async _repairBatch(shot, batchIssues, batchFields, prd, timeoutMs, batchNum, batchTotal) {
    const batchTag = batchTotal > 1 ? `（第${batchNum}/${batchTotal}批）` : '';

    // 构建问题清单
    const issuesText = batchIssues.map(i => {
      const currentVal = i.currentValue || shot[i.fieldEn] || '（缺失）';
      return `- 字段【${i.fieldCn}】(${i.fieldEn})：${i.description}\n  修改建议：${i.suggestion}\n  当前值：${String(currentVal).slice(0, 80)}`;
    }).join('\n');

    // PRD约束文本（核心：防止修复偏离业务需求）
    const prdConstraint = prd ? prd.toConstraintText() : '';

    // 当前字段快照
    const currentFields = {};
    for (const f of batchFields) {
      currentFields[f] = shot[f] || '';
    }
    const currentFieldsJson = JSON.stringify(currentFields, null, 2);

    // 字符预算
    const budgetHints = [];
    for (const f of batchFields) {
      const spec = SPEC_MAP[f];
      if (spec && spec.charMax < 9999) {
        budgetHints.push(` - ${f}：≤ ${spec.charMax} 字符`);
      }
    }
    const budgetText = budgetHints.length ? budgetHints.join('\n') : ' （无特殊限制）';

    // 【v2.1.14-fix】字段级格式硬约束（与 RuleChecker 判定规则一一对应）
    // 解决"检查器比修复器严"导致的修复后复检永不通过
    const formatHints = [];
    for (const f of batchFields) {
      if (FIELD_REQUIREMENTS[f]) {
        formatHints.push(` - ${f}：${FIELD_REQUIREMENTS[f]}`);
      }
    }
    const formatText = formatHints.length
      ? formatHints.join('\n')
      : ' （无特殊格式要求）';

    const userPrompt = `请根据以下信息修复提示词字段：\n\n【用户需求文档 PRD 约束】（修复时必须遵守，不得偏离）\n${prdConstraint}\n\n【需要修复的字段当前内容】\n${currentFieldsJson}\n\n【字符数预算限制】（修复后每个字段不得超过上限）\n${budgetText}\n\n【字段格式硬约束】（修复后必须逐项满足，机器将按此复检）\n${formatText}\n\n【检查发现的问题】\n${issuesText}\n\n请修复上述问题，确保修复后的字段：\n1. 符合 PRD 中的视频类型、风格方向、情绪基调等业务约束\n2. 逐项满足【字段格式硬约束】的全部要素\n3. 与其它字段保持风格一致\n4. 严格控制字符数在预算上限以内\n\n直接输出JSON，第一个字符就是 {。`;

    // 超时保护
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`LLMRepairer超时(${timeoutMs}ms)`)),
        timeoutMs
      );
    });

    try {
      const repairPromise = this.llm.reason(userPrompt, {
        systemPrompt: LLM_REPAIRER_SYSTEM_PROMPT,
        temperature: this.temperature
      });
      repairPromise.catch(() => {}); // 防止悬空 rejection
      const response = await Promise.race([
        repairPromise,
        timeoutPromise
      ]).finally(() => clearTimeout(timer));

      // reason() 返回信封格式 {success, content, error}，必须提取 content
      let rawContent;
      if (response && typeof response === 'object') {
        if (response.success === true && typeof response.content === 'string') {
          rawContent = response.content;
        } else if (response.success === false) {
          console.warn(`[LLMRepairer] LLM返回失败${batchTag}: ${response.error || '未知错误'}，本批跳过`);
          return { repaired: null, actions: [] };
        }
      }

      // 【v2.1.14-fix 故障A】鲁棒 JSON 提取（四级降级，绝不抛出）
      const salvage = extractJson(rawContent);
      if (!salvage.ok) {
        const rawFile = _saveRawResponse('repair', rawContent);
        console.warn(`[LLMRepairer] JSON提取失败${batchTag}，本批跳过${rawFile ? `（原始响应已留存: ${rawFile}）` : ''}`);
        return { repaired: null, actions: [] };
      }
      if (salvage.method !== 'direct') {
        console.log(`[LLMRepairer] JSON经抢救提取成功（方式: ${salvage.method}）`);
      }

      const data = salvage.data || {};
      const repairedFields = data.repaired_fields || {};

      const repairedShot = deepClone(shot);
      const actions = [];

      // 构建字段名映射表，支持 snake_case ↔ camelCase
      const { SNAKE_TO_CAMEL, CAMEL_TO_SNAKE } = require('./field-check-agent');

      for (const [fieldEn, newValue] of Object.entries(repairedFields)) {
        if (!newValue || !String(newValue).trim()) continue;

        // 将 LLM 返回的 key 统一映射到 shot 中已有的字段名
        let targetField = fieldEn;
        // 如果 shot 中有 camelCase 版本，优先用 camelCase
        if (SNAKE_TO_CAMEL[fieldEn] && SNAKE_TO_CAMEL[fieldEn] in repairedShot) {
          targetField = SNAKE_TO_CAMEL[fieldEn];
        }
        // 如果 shot 中有 snake_case 版本
        else if (CAMEL_TO_SNAKE[fieldEn] && CAMEL_TO_SNAKE[fieldEn] in repairedShot) {
          targetField = CAMEL_TO_SNAKE[fieldEn];
        }
        // 同时检查 fields 嵌套对象
        else if (repairedShot.fields) {
          if (SNAKE_TO_CAMEL[fieldEn] && SNAKE_TO_CAMEL[fieldEn] in repairedShot.fields) {
            targetField = `fields.${SNAKE_TO_CAMEL[fieldEn]}`;
          } else if (fieldEn in repairedShot.fields) {
            targetField = `fields.${fieldEn}`;
          }
        }

        const oldValue = targetField.includes('.')
          ? targetField.split('.').reduce((obj, k) => obj?.[k], repairedShot) || ''
          : repairedShot[targetField] || '';

        // 字符数后处理
        const spec = SPEC_MAP[fieldEn] || SPEC_MAP[SNAKE_TO_CAMEL[fieldEn]];
        let finalValue = newValue;
        if (spec && spec.charMax < 9999 && String(finalValue).length > spec.charMax) {
          finalValue = this._smartTruncate(String(finalValue), spec.charMax);
        }

        if (finalValue !== oldValue) {
          // 赋值（支持嵌套 fields 对象）
          if (targetField.includes('.')) {
            const [parent, child] = targetField.split('.');
            repairedShot[parent][child] = finalValue;
          } else {
            repairedShot[targetField] = finalValue;
          }
          // 同时在 snake_case 和 camelCase 两个位置都赋值，确保下游都能取到
          if (SNAKE_TO_CAMEL[fieldEn]) {
            repairedShot[SNAKE_TO_CAMEL[fieldEn]] = finalValue;
          }
          if (CAMEL_TO_SNAKE[fieldEn]) {
            repairedShot[CAMEL_TO_SNAKE[fieldEn]] = finalValue;
          }

          actions.push(new RepairAction({
            fieldEn, method: 'llm', before: oldValue, after: finalValue,
            reason: `LLM 修复：参考 PRD 约束修复检查问题${batchTag}`
          }));
        }
      }

      return { repaired: repairedShot, actions };
    } catch (e) {
      // 【v2.1.14-fix】单批失败不再拖垮整轮：记录并跳过本批
      if (e.message?.includes('超时')) {
        console.warn(`[LLMRepairer] 本批修复超时(${timeoutMs}ms)${batchTag}，跳过本批，其余批次继续`);
      } else {
        console.warn(`[LLMRepairer] 本批修复异常${batchTag}: ${e.message}，跳过本批`);
      }
      return { repaired: null, actions: [] };
    }
  }

  _smartTruncate(text, maxLen) {
    if (text.length <= maxLen) return text;
    let truncated = text.slice(0, maxLen);
    for (const sep of [', ', '，', '; ', '；', ' ']) {
      const idx = truncated.lastIndexOf(sep);
      if (idx > maxLen * 0.6) {
        return truncated.slice(0, idx);
      }
    }
    return truncated;
  }
}

// ============================================================
// FieldRepairAgent - 修复环节编排器
// ============================================================

class FieldRepairAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'FieldRepairAgent', llmTimeout: options.llmTimeout || 180000, ...options });
    this.ruleRepairer = new RuleRepairer();
    // 【v2.1.14-fix】透传温度与分批配置
    this.llmRepairer = new LLMRepairer(this._getLLMEngine(), options.llmTimeout || 180000, {
      temperature: options.llmTemperature ?? 0.3,
      maxFieldsPerBatch: options.maxFieldsPerBatch || 5,
    });
    this.prd = options.prd || null;
  }

  setPRD(prd) { this.prd = prd; }

  async repair(shot, report, shotId = 'shot_001') {
    console.log(`[FieldRepairAgent] 开始修复 ${shotId}...`);
    const log = new RepairLog(shotId);
    log.prdReferenced = !!this.prd;
    let repaired = deepClone(shot);

    // 第一层：规则自动修复
    const { repaired: ruleRepaired, actions: ruleActions } = this.ruleRepairer.repair(repaired, report, this.prd);
    repaired = ruleRepaired;
    log.actions.push(...ruleActions);
    console.log(`[FieldRepairAgent] RuleRepairer 完成：${ruleActions.length} 项修复`);

    // 第二层：LLM智能修复（注入PRD约束）
    if (this.llmRepairer.llm && this.prd) {
      // 【v2.1.14-fix 故障D】规则修复后实检剩余问题，只把真实未解决的推给LLM
      const remainingReport = this._recheckRemaining(repaired, report, ruleActions);
      console.log(`[FieldRepairAgent] 实检剩余问题：${remainingReport.issues.length} 项推给 LLM（原报告 ${report.issues.length} 项）`);
      if (remainingReport.issues.length) {
        const { repaired: llmRepaired, actions: llmActions } = await this.llmRepairer.repair(repaired, remainingReport, this.prd);
        // 【v2.1.14-fix】LLMRepairer 任何路径都返回 {repaired, actions}，llmRepaired 永不为 undefined
        repaired = llmRepaired;
        log.actions.push(...llmActions);
        console.log(`[FieldRepairAgent] LLMRepairer 完成：${llmActions.length} 项修复`);
      }
    }

    console.log(`[FieldRepairAgent] 修复完成：共 ${log.actions.length} 项修复动作`);

    // 【v2.1.6-fix】Prompt 长度同步：修复后重新计算 promptCharCount
    const { PromptSync } = require('../../utils/prompt-sync');
    const promptSync = new PromptSync();
    promptSync.sync(repaired, 'FieldRepairAgent');

    return { repaired, log };
  }

  /**
   * 【v2.1.14-fix 故障D】精确识别规则修复后的剩余问题
   * 旧实现：4 条 fieldEn|issueType 白名单猜测，已修复但未列入白名单的问题
   * 照样推给 LLM（含全部规则默认值填充的 MISSING 问题），LLM 收到
   * 大量"已修但仍报"的噪音，产生困惑性输出
   * 新实现：
   * 1. 对规则修复后的 shot 重跑 RuleChecker 实检 → 真实的规则层剩余问题
   * 2. 原报告中的 LLM 语义问题（inconsistent/conflict），若涉及字段未被
   *    规则修复触碰 → 保留推给 LLM
   * 3. 按 字段+描述 去重
   */
  _recheckRemaining(shot, originalReport, ruleActions = []) {
    const { CheckReport, RuleChecker } = require('./field-check-agent');
    const remaining = new CheckReport(originalReport.shotId);

    // ① 实检：对修复后的 shot 重新跑规则检查（确定性、零成本、绝对准确）
    const checker = new RuleChecker();
    const freshRuleIssues = checker.check(shot);
    remaining.issues.push(...freshRuleIssues);

    // ② 保留未被规则触碰的 LLM 语义问题
    const ruleTouchedFields = new Set(ruleActions.map(a => a.fieldEn));
    const ruleIssueKeys = new Set(freshRuleIssues.map(i => `${i.fieldEn}|${i.description}`));
    for (const issue of originalReport.issues) {
      const isSemantic = [IssueType.INCONSISTENT, IssueType.CONFLICT].includes(issue.issueType);
      if (!isSemantic) continue; // 规则类问题以实检为准
      if (ruleTouchedFields.has(issue.fieldEn)) continue; // 规则已改过该字段，交给下一轮检查判定
      const key = `${issue.fieldEn}|${issue.description}`;
      if (ruleIssueKeys.has(key)) continue; // 实检已覆盖
      remaining.issues.push(issue);
    }

    // ③ 去重
    const seen = new Set();
    remaining.issues = remaining.issues.filter(i => {
      const key = `${i.fieldEn}|${i.issueType}|${i.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return remaining;
  }

  // 批量修复多个镜头
  async repairAll(shots, reports) {
    const results = [];
    const logs = [];
    for (let i = 0; i < shots.length; i++) {
      const { repaired, log } = await this.repair(shots[i], reports[i], shots[i].shotId || shots[i].shot_id || `shot_${i}`);
      results.push(repaired);
      logs.push(log);
    }
    return { repaired: results, logs };
  }
}

module.exports = {
  FieldRepairAgent,
  RuleRepairer,
  LLMRepairer,
  RepairAction,
  RepairLog,
  PRD,
};
