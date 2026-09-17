/**
 * FieldCheckAgent - 字段内容检查环节（v2.1.14-fix）
 * 负责: 对25字段进行规则+LLM混合检查，输出结构化问题清单
 * 位置: PromptFusionAgent之后，FieldGuard之前
 *
 * 【v2.1.14-fix 改动】
 * - LLMChecker 引入 json-salvage 鲁棒 JSON 提取（故障A同源修复）
 * - 结构化任务温度降至 0.5
 * - 新增 FIELD_REQUIREMENTS 导出（供修复层注入 prompt）
 *
 * 架构:
 *   RuleChecker (规则引擎层) - 确定性检查，零延迟
 *     · _checkCompleteness() 完整性: P0/P1必填字段是否缺失
 *     · _checkFormat() 格式: 各字段要素是否齐全
 *     · _checkStructure() 结构: 分段数、层次数等
 *     · _checkLength() 字符数: 单字段+总量超限
 *   LLMChecker (LLM语义层) - 跨字段语义一致性
 *     · check() 6类跨字段语义问题
 */
const fs = require('fs');
const path = require('path');
const { BaseAgent } = require('../production-engine/agents/base-agent');
const { asString, asStringLower, safeSlice, safeIncludes } = require('../field-standardizer');
// 【v2.1.14-fix】LLM 响应鲁棒 JSON 提取（与修复层共用）
const { extractJson } = require('./json-salvage');

// LLM 语义检查异常时原始响应落盘目录
const RAW_LOG_DIR = path.join(__dirname, '..', '..', 'output', 'field-quality');
function _saveRawResponse(tag, raw) {
  try {
    if (!fs.existsSync(RAW_LOG_DIR)) fs.mkdirSync(RAW_LOG_DIR, { recursive: true });
    const file = path.join(RAW_LOG_DIR, `llm-raw-${tag}-${Date.now()}.log`);
    fs.writeFileSync(file, String(raw ?? '(null)'), 'utf8');
    return file;
  } catch (_) { return null; }
}

// ============================================================
// 数据模型 - Issue, CheckReport
// ============================================================

const Priority = {
  P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3'
};

const Severity = {
  FATAL: 'fatal',   // P0字段缺失/严重不合规，必须修复
  MAJOR: 'major',   // P1字段不合规，强烈建议修复
  MINOR: 'minor',   // P2/P3字段不合规，建议修复
  INFO: 'info'      // 潜在风险，可选修复
};

const IssueType = {
  MISSING: 'missing',
  FORMAT_ERROR: 'format_error',
  INCOMPLETE: 'incomplete',
  OVER_LENGTH: 'over_length',
  INCONSISTENT: 'inconsistent',
  UNPROFESSIONAL: 'unprofessional',
  CONFLICT: 'conflict'
};

// 【v2.1.4-fix13-审计修复】字段名统一为 snake_case，与 field-standardizer 对齐
const FIELD_SPECS = [
  // P0 致命级（12个，必填）
  { nameCn: '导演指令', nameEn: 'director_instruction', priority: Priority.P0, charMin: 80, charMax: 120, required: true },
  { nameCn: '约束', nameEn: 'constraint', priority: Priority.P0, charMin: 15, charMax: 40, required: true },
  { nameCn: '基础', nameEn: 'baseline', priority: Priority.P0, charMin: 30, charMax: 60, required: true },
  { nameCn: '场景', nameEn: 'scene', priority: Priority.P0, charMin: 120, charMax: 180, required: true },
  { nameCn: '灯光', nameEn: 'lighting', priority: Priority.P0, charMin: 150, charMax: 225, required: true },
  { nameCn: '运镜', nameEn: 'camera_movement', priority: Priority.P0, charMin: 100, charMax: 150, required: true },
  { nameCn: '角色', nameEn: 'character', priority: Priority.P0, charMin: 50, charMax: 120, required: true },
  { nameCn: '动作', nameEn: 'action', priority: Priority.P0, charMin: 120, charMax: 180, required: true },
  { nameCn: '台词', nameEn: 'dialogue', priority: Priority.P0, charMin: 0, charMax: 9999, required: true },
  { nameCn: '负面约束', nameEn: 'negative', priority: Priority.P0, charMin: 40, charMax: 150, required: true },
  { nameCn: '定妆照', nameEn: 'portraits', priority: Priority.P0, charMin: 0, charMax: 9999, required: true },
  { nameCn: '角色一致性', nameEn: 'consistency', priority: Priority.P0, charMin: 30, charMax: 80, required: true },
  // P1 核心级（7个，必填）
  { nameCn: '构图', nameEn: 'composition', priority: Priority.P1, charMin: 100, charMax: 150, required: true },
  { nameCn: '色彩', nameEn: 'color_palette', priority: Priority.P1, charMin: 80, charMax: 120, required: true },
  { nameCn: '景深', nameEn: 'depth_of_field', priority: Priority.P1, charMin: 80, charMax: 120, required: true },
  { nameCn: '时间轴', nameEn: 'timeline', priority: Priority.P1, charMin: 200, charMax: 300, required: true },
  { nameCn: '情绪', nameEn: 'mood', priority: Priority.P1, charMin: 10, charMax: 50, required: true },
  { nameCn: '明亮约束', nameEn: 'bright_constraint', priority: Priority.P1, charMin: 15, charMax: 45, required: true },
  { nameCn: '角色约束', nameEn: 'character_constraint', priority: Priority.P1, charMin: 20, charMax: 60, required: true },
  // P2 增强级（4个，可选）
  { nameCn: '服装', nameEn: 'costume', priority: Priority.P2, charMin: 40, charMax: 100, required: false },
  { nameCn: '道具', nameEn: 'props', priority: Priority.P2, charMin: 25, charMax: 80, required: false },
  { nameCn: '节奏', nameEn: 'pacing', priority: Priority.P2, charMin: 40, charMax: 100, required: false },
  { nameCn: '音频', nameEn: 'audio', priority: Priority.P2, charMin: 100, charMax: 150, required: false },
  // P3 可选级（2个，可选）
  { nameCn: '化妆', nameEn: 'makeup', priority: Priority.P3, charMin: 25, charMax: 60, required: false },
  { nameCn: '转场', nameEn: 'transition', priority: Priority.P3, charMin: 20, charMax: 50, required: false },
];

const SPEC_MAP = {};
for (const spec of FIELD_SPECS) {
  SPEC_MAP[spec.nameEn] = spec;
}

// 【v2.1.4-fix13】camelCase ↔ snake_case 双向映射，解决命名不一致
// 【P1-9 修复】FIELD_SPECS.nameEn 全是 snake_case，原正则 /([A-Z])/g 匹配大写字母但 snake_case 无大写
// 导致 snake === nameEn（恒等），两个 map 都是 snake→snake，camelCase 字段永远找不到
const CAMEL_TO_SNAKE = {};
const SNAKE_TO_CAMEL = {};
for (const spec of FIELD_SPECS) {
  const snake = spec.nameEn; // nameEn 本身就是 snake_case
  const camel = snake.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()); // snake → camel
  SNAKE_TO_CAMEL[snake] = camel;
  CAMEL_TO_SNAKE[camel] = snake;
}

/**
 * 【v2.1.4-fix13】将 shot 展平为统一格式
 * 处理三种数据来源：
 * 1. shot.fields.xxx（PromptFusion 嵌套结构，snake_case）
 * 2. shot.xxx（顶层 snake_case）
 * 3. shot.xxx（顶层 camelCase，FIELD_SPECS 格式）
 * 统一输出为 camelCase 顶层字段，同时保留 snake_case 兼容
 */
function flattenShot(shot) {
  if (!shot || typeof shot !== 'object') return {};
  const flat = { ...shot };

  // 展开 shot.fields 对象
  if (shot.fields && typeof shot.fields === 'object') {
    for (const [key, value] of Object.entries(shot.fields)) {
      // 【审计修复·P0】只有目标字段真正不存在（undefined）时才赋值
      // 空字符串 ''、null、0 等是合法的故意设置，不应被覆盖
      const camelKey = SNAKE_TO_CAMEL[key] || key;
      if (flat[camelKey] === undefined) {
        flat[camelKey] = value;
      }
      // 也保留 snake_case 版本（向后兼容）
      if (flat[key] === undefined) {
        flat[key] = value;
      }
    }
  }

  // 顶层 snake_case → camelCase 映射
  for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL)) {
    if (snake in flat && !(camel in flat)) {
      flat[camel] = flat[snake];
    } else if (camel in flat && !(snake in flat)) {
      flat[snake] = flat[camel];
    }
  }

  return flat;
}

// 【v2.2.7-fix】与 prompt-length.js 的 SAFE_MAX(11900) 口径对齐。
// 旧值 12000 注释谎称"与 prompt-length.js 保持一致"，但真源 HARD_MAX 是 3000、
// SAFE_MAX 是 11900，均不等于 12000。此处校验的是组装前字段数据总量，对应 SAFE_MAX 档。
const PromptLengthConfig = require('../../config/prompt-length.js');
const MAX_TOTAL_CHARS = PromptLengthConfig.SAFE_MAX;

/**
 * 【v2.1.14-fix】字段格式硬约束（供 LLM 修复层注入 prompt）
 * 与 RuleChecker 的判定规则一一对应——修复器"知道"检查器的标准，
 * 解决"检查器比修复器严"导致的修复后复检永不通过死循环
 */
const FIELD_REQUIREMENTS = {
  director_instruction: '必须包含①风格定位（如：电影写实/超写实/纪录片质感）②写实要求（写实/真实/超写实）③情绪基调（基调/氛围/情绪类词）',
  constraint: '必须包含①画幅比例（16:9）②分辨率（1920x1080）③输出格式（MP4）④帧率（24fps）',
  lighting: '必须包含①主光描述（主光/主光源）②色温参数（如5600K）③光质定义（柔光/硬光/漫射）',
  camera_movement: '必须包含①运动方式（推/拉/摇/移/跟/升降/环绕）②速度参数（如0.5m/s）③时间分布（须含秒数标记，如开场0-2秒/中段/收尾）',
  negative: "必须包含 'no text' 和 'no watermark' 两项基础排除词",
  composition: '必须包含①景别等级（远景/全景/中景/近景/特写）②主体位置（左侧/右侧/居中/对称）',
  bright_constraint: '必须包含①亮度要求（明亮/光线充足）②可见性（清晰/可见）③面部明亮（面部无阴影/面部明亮）',
  character_constraint: '必须包含①单角色限制（仅出现/只出现指定角色）②禁止分身声明（禁止分身/克隆/重复出现）',
  timeline: '至少 3 个时间分段，每段以 T00:XX 标记（如 T00:00-开场、T00:02-发展、T00:05-收尾）',
  pacing: '必须采用五段式：整体+开头+中段+高潮+结尾',
  costume: '分层描述，至少覆盖外套/内搭/下装/鞋履中的 3 类',
  dialogue: '仅以 ，。！？… 五种标点；句末必须用 。！？… 之一收尾；禁止分号冒号引号括号',
  transition: '必须指定明确转场类型（切镜/淡入/淡出/叠化/划像），禁止模糊表述',
  mood: '情绪词需与导演指令的情绪基调一致',
  scene: '场景描述须与 PRD 的场景要求一致，包含空间/光线/材质/氛围要素',
  character: '须使用 PRD 中定义的角色名，外观描述与定妆照锚定一致',
  action: '动作描述须与角色和场景一致，含视线方向与微表情',
  consistency: '须包含 PRD 角色名，锚定不可变更的外观要素（发型/服装/面部特征）',
};

class Issue {
  constructor({ fieldEn, fieldCn, severity, issueType, description, suggestion, currentValue = '' }) {
    this.fieldEn = fieldEn;
    this.fieldCn = fieldCn;
    this.severity = severity;
    this.issueType = issueType;
    this.description = description;
    this.suggestion = suggestion;
    this.currentValue = currentValue;
  }
}

class CheckReport {
  constructor(shotId) {
    this.shotId = shotId;
    this.issues = [];
    this.passed = false;
  }

  add(issue) { this.issues.push(issue); }

  get fatalCount() { return this.issues.filter(i => i.severity === Severity.FATAL).length; }
  get majorCount() { return this.issues.filter(i => i.severity === Severity.MAJOR).length; }
  get minorCount() { return this.issues.filter(i => i.severity === Severity.MINOR).length; }

  summary() {
    return `检查结果：${this.passed ? '✅ 通过' : '❌ 未通过'} | 致命 ${this.fatalCount} · 严重 ${this.majorCount} · 轻微 ${this.minorCount} · 共 ${this.issues.length} 项问题`;
  }
}

// ============================================================
// RuleChecker - 规则引擎层（确定性检查）
// ============================================================

class RuleChecker {
  constructor() {
    this.shotSizePatterns = [
      /extreme long shot/i, /establishing shot/i, /long shot/i, /full shot/i,
      /medium shot/i, /close-?up/i, /extreme close-?up/i, /wide shot/i,
      /远景/i, /全景/i, /中景/i, /近景/i, /特写/i,
    ];
    this.positionPatterns = [
      /third/i, /center/i, /symmetr/i, /左侧/i, /右侧/i, /居中/i, /对称/i,
      /positioned at/i, /aligned to/i,
    ];
    this.transitionPatterns = [
      /hard cut/i, /fade in/i, /fade out/i, /dissolve/i, /wipe/i, /zoom/i,
      /切镜/i, /淡入/i, /淡出/i, /叠化/i, /划像/i,
    ];
  }

  check(shot) {
    const issues = [];
    issues.push(...this._checkCompleteness(shot));
    issues.push(...this._checkFormat(shot));
    issues.push(...this._checkStructure(shot));
    issues.push(...this._checkLength(shot));
    return issues;
  }

  // ---- 4.1 完整性检查 ----
  _checkCompleteness(shot) {
    const issues = [];
    for (const spec of FIELD_SPECS) {
      if (!spec.required) continue;
      const value = shot[spec.nameEn];
      // 【P1-12 修复】增加空数组/空对象检测，避免 portraits:[]/dialogue:[] 通过完整性检查
      const isEmpty = !value
        || (typeof value === 'string' && !value.trim())
        || (Array.isArray(value) && value.length === 0)
        || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
      if (isEmpty) {
        const sev = spec.priority === Priority.P0 ? Severity.FATAL : Severity.MAJOR;
        issues.push(new Issue({
          fieldEn: spec.nameEn, fieldCn: spec.nameCn,
          severity: sev, issueType: IssueType.MISSING,
          description: `${spec.priority} 字段【${spec.nameCn}】缺失`,
          suggestion: `请补充【${spec.nameCn}】字段内容，参考规范文档第 ${this._chapterForField(spec.nameEn)} 章`
        }));
      }
    }
    return issues;
  }

  // ---- 4.2 格式与内容专业性检查 ----
  _checkFormat(shot) {
    const issues = [];

    // 导演指令：须含风格定位+写实要求+情绪基调
    const di = shot.director_instruction || '';
    if (di) {
      const diLower = (di && typeof di === "string") ? di.toLowerCase() : "";
      const hasStyle = /质感|风格|纪录片|电影|广告|cinematic|documentary|realistic|photorealistic|hollywood/.test(diLower);
      const hasRealism = /写实|真实|超写实|epic|真实感|无特效|realistic|no effect|no sci/.test(diLower);
      const hasMood = /基调|氛围|情绪|冷静|紧张|温馨|tone|mood|atmosphere|professional|intense|warm/.test(diLower);
      const missing = [];
      if (!hasStyle) missing.push('风格定位');
      if (!hasRealism) missing.push('写实要求');
      if (!hasMood) missing.push('情绪基调');
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'director_instruction', fieldCn: '导演指令',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: `导演指令缺少要素：${missing.join('、')}`,
          suggestion: `导演指令建议覆盖风格定位+写实要求+情绪基调，当前缺少：${missing.join('、')}`,
          currentValue: (typeof di === "string" ? di.slice(0, 60) : String(di).slice(0, 60))
        }));
      }
    }

    // 约束：须含画幅+分辨率+格式+帧率
    const cs = shot.constraint || '';
    if (cs) {
      const csLower = (cs && typeof cs === "string") ? cs.toLowerCase() : "";
      const missing = [];
      if (!/aspect ratio|画幅|16:9|9:16/.test(csLower)) missing.push('画幅比例');
      if (!/resolution|分辨率|1920|1080|4k|8k/.test(csLower)) missing.push('分辨率');
      if (!/format|格式|mp4|mov/.test(csLower)) missing.push('输出格式');
      if (!/frame rate|帧率|fps|24fps|30fps/.test(csLower)) missing.push('帧率');
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'constraint', fieldCn: '约束',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: `约束字段缺少技术参数：${missing.join('、')}`,
          suggestion: `约束建议包含画幅+分辨率+格式+帧率`,
          currentValue: (typeof cs === "string" ? cs.slice(0, 60) : String(cs).slice(0, 60))
        }));
      }
    }

    // 灯光：须含主光+色温+光质
    const lt = shot.lighting || '';
    if (lt) {
      const ltLower = (lt && typeof lt === "string") ? lt.toLowerCase() : "";
      const missing = [];
      if (!/key light|主光|主光源/.test(ltLower)) missing.push('主光描述');
      if (!/\d{3,4}k|色温|color temperature|warm|cool|daylight|tungsten/.test(ltLower)) missing.push('色温参数');
      if (!/soft|hard|diffus|柔光|硬光|漫射/.test(ltLower)) missing.push('光质定义');
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'lighting', fieldCn: '灯光',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: `灯光字段缺少要素：${missing.join('、')}`,
          suggestion: `灯光建议含主光+色温+光质三要素`,
          currentValue: (typeof lt === "string" ? lt.slice(0, 60) : String(lt).slice(0, 60))
        }));
      }
    }

    // 运镜：须含运动方式+速度+时间分布
    const cm = shot.camera_movement || '';
    if (cm) {
      const cmLower = (cm && typeof cm === "string") ? cm.toLowerCase() : "";
      const hasMove = /push|pull|pan|track|follow|crane|orbit|推|拉|摇|移|跟|升|降|环绕/.test(cmLower);
      const hasSpeed = /\d+\.?\d*\s*m\/s|\d+\.?\d*\s*°\/s|slow|fast|medium|慢速|快速/.test(cmLower);
      const hasTime = /duration|秒|second|\d+s|starting|ending/.test(cmLower);
      const missing = [];
      if (!hasMove) missing.push('运动方式');
      if (!hasSpeed) missing.push('速度参数');
      if (!hasTime) missing.push('时间分布');
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'camera_movement', fieldCn: '运镜',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: `运镜字段缺少要素：${missing.join('、')}`,
          suggestion: `运镜建议含运动方式+速度+时间分布`,
          currentValue: (typeof cm === "string" ? cm.slice(0, 60) : String(cm).slice(0, 60))
        }));
      }
    }

    // 负面约束：须含 no text + no watermark
    const ng = shot.negative || '';
    if (ng) {
      const ngLower = (ng && typeof ng === "string") ? ng.toLowerCase() : "";
      if (!ngLower.includes('no text') || !ngLower.includes('no watermark')) {
        issues.push(new Issue({
          fieldEn: 'negative', fieldCn: '负面约束',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: "负面约束缺少基础排除项：'no text' 和 'no watermark'",
          suggestion: "负面约束建议包含 'no text, no watermark' 两项基础排除",
          currentValue: (typeof ng === "string" ? ng.slice(0, 60) : String(ng).slice(0, 60))
        }));
      }
    }

    // 构图：须含景别+主体位置
    const comp = shot.composition || '';
    if (comp) {
      const compLower = (comp && typeof comp === "string") ? comp.toLowerCase() : "";
      const hasSize = this.shotSizePatterns.some(p => p.test(compLower));
      const hasPos = this.positionPatterns.some(p => p.test(compLower));
      const missing = [];
      if (!hasSize) missing.push('景别等级');
      if (!hasPos) missing.push('主体位置');
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'composition', fieldCn: '构图',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: `构图字段缺少要素：${missing.join('、')}`,
          suggestion: `构图须含景别（远景/全景/中景/近景/特写）+ 主体位置（三分法/中心/对称）。示例：'medium shot, subject positioned at the left third intersection'`,
          currentValue: (typeof comp === "string" ? comp.slice(0, 60) : String(comp).slice(0, 60))
        }));
      }
    }

    // 明亮约束：须含亮度+可见性+面部明亮
    const bc = shot.bright_constraint || '';
    if (bc) {
      const bcLower = (bc && typeof bc === "string") ? bc.toLowerCase() : "";
      const missing = [];
      if (!/bright|well-lit|明亮|光线充足/.test(bcLower)) missing.push('亮度要求');
      if (!/visibility|visible|clear|可见|清晰/.test(bcLower)) missing.push('可见性');
      if (!/face|面部|facial|no dark shadow/.test(bcLower)) missing.push('面部明亮');
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'bright_constraint', fieldCn: '明亮约束',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: `明亮约束缺少要素：${missing.join('、')}`,
          suggestion: `明亮约束须含亮度+可见性+面部明亮。标准格式：'bright lighting, well-lit scene, clear visibility, no dark shadows on face, adequate illumination, face clearly lit'`,
          currentValue: (typeof bc === "string" ? bc.slice(0, 60) : String(bc).slice(0, 60))
        }));
      }
    }

    // 角色约束：须含单角色限制+禁止分身
    const cc = shot.character_constraint || '';
    if (cc) {
      const ccLower = asStringLower(cc);
      const hasSingle = /只出现|仅出现|single character|only.*one/.test(ccLower);
      const hasNoClone = /分身|克隆|duplicate|clone|repeat/.test(ccLower);
      const missing = [];
      if (!hasSingle) missing.push('单角色限制');
      if (!hasNoClone) missing.push('禁止分身声明');
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'character_constraint', fieldCn: '角色约束',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: `角色约束缺少要素：${missing.join('、')}`,
          suggestion: `角色约束须含单角色限制+禁止分身。标准格式：'只出现[角色名]一人，禁止其他人物入镜，禁止同一角色重复出现，禁止角色分身或克隆'`,
          currentValue: safeSlice(cc, 0, 60)
        }));
      }
    }

    // 定妆照路径格式
    const pt = shot.portraits || '';
    if (pt && !/\/characters\/[\w_]+\/portrait_v\d+\.(png|jpg)/.test(pt)) {
      issues.push(new Issue({
        fieldEn: 'portraits', fieldCn: '定妆照',
        severity: Severity.MAJOR, issueType: IssueType.FORMAT_ERROR,
        description: `定妆照路径格式不规范：${safeSlice(pt, 0, 40)}`,
        suggestion: '路径格式建议：/characters/{角色英文名}/portrait_v{版本号}.{png|jpg}',
        currentValue: safeSlice(pt, 0, 40)
      }));
    }

    // 台词：句末标点+标点规范
    // 【P1-6 修复】dialogue 可能被 field-standardizer 转为数组，需归一化为字符串
    const dl = Array.isArray(shot.dialogue)
      ? shot.dialogue.map(d => typeof d === 'string' ? d : (d && d.text ? d.text : '')).join('')
      : (shot.dialogue || '');
    if (dl) {
      if (!/[。！？…]$/.test(dl)) {
        issues.push(new Issue({
          fieldEn: 'dialogue', fieldCn: '台词',
          severity: Severity.MAJOR, issueType: IssueType.FORMAT_ERROR,
          description: '台词缺少句末标点（建议以 。！？… 结尾）',
          suggestion: `建议在台词末尾添加 '。'：'${dl}。'`,
          currentValue: (typeof dl === "string" ? dl.slice(0, 60) : String(dl).slice(0, 60))
        }));
      }
      const forbidden = dl.match(/[；;：:""''"'\[\]【】]/g);
      if (forbidden) {
        issues.push(new Issue({
          fieldEn: 'dialogue', fieldCn: '台词',
          severity: Severity.MAJOR, issueType: IssueType.FORMAT_ERROR,
          description: `台词含禁止标点：${[...new Set(forbidden)].join('')}（仅允许 ，。！？…）`,
          suggestion: '移除分号、冒号、引号等复杂标点，仅保留 ，。！？… 五种，以免干扰口型同步引擎的断句解析',
          currentValue: (typeof dl === "string" ? dl.slice(0, 60) : String(dl).slice(0, 60))
        }));
      }
    }

    // 转场：须含明确类型
    const tr = shot.transition || '';
    if (tr) {
      if (!this.transitionPatterns.some(p => p.test(tr))) {
        issues.push(new Issue({
          fieldEn: 'transition', fieldCn: '转场',
          severity: Severity.MINOR, issueType: IssueType.INCOMPLETE,
          description: '转场字段未指定明确转场类型',
          suggestion: '须指定具体转场类型（hard cut/fade in/fade out/dissolve/wipe），避免使用 smooth transition 等模糊表述',
          currentValue: tr.slice(0, 40)
        }));
      }
    }

    return issues;
  }

  // ---- 4.3 结构检查 ----
  _checkStructure(shot) {
    const issues = [];

    // 时间轴：≥3段
    const tl = shot.timeline || '';
    if (tl) {
      const segments = tl.match(/T\d{2}:\d{2}/g) || [];
      if (segments.length < 3) {
        issues.push(new Issue({
          fieldEn: 'timeline', fieldCn: '时间轴',
          severity: Severity.MAJOR, issueType: IssueType.INCOMPLETE,
          description: `时间轴分段数不足：当前 ${segments.length} 段，要求 ≥ 3 段`,
          suggestion: '时间轴须至少分为起始、发展、收尾 3 段，每段格式：T00:XX - [画面内容] + [动作描述]',
          currentValue: (typeof tl === "string" ? tl.slice(0, 60) : String(tl).slice(0, 60))
        }));
      }
    }

    // 节奏：五段式
    const pa = shot.pacing || '';
    if (pa) {
      const paLower = (pa && typeof pa === "string") ? pa.toLowerCase() : "";
      const requiredSegs = ['整体', '开头', '中段', '高潮', '结尾'];
      const missing = requiredSegs.filter(s => !paLower.includes(s) && !paLower.includes(s.toLowerCase()));
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'pacing', fieldCn: '节奏',
          severity: Severity.MINOR, issueType: IssueType.INCOMPLETE,
          description: `节奏字段缺少段落：${missing.join('、')}`,
          suggestion: '节奏须采用五段式：整体+开头+中段+高潮+结尾',
          currentValue: (typeof pa === "string" ? pa.slice(0, 60) : String(pa).slice(0, 60))
        }));
      }
    }

    // 服装：至少含外套/内搭/下装/鞋履中3项
    const cos = shot.costume || '';
    if (cos) {
      const cosLower = (cos && typeof cos === "string") ? cos.toLowerCase() : "";
      const categories = {
        '外套/上装': ['coat', 'jacket', 'suit', 'shirt', 'overcoat', '外套', '西装', '上衣'],
        '内搭': ['shirt', 'blouse', '内搭', '衬衫'],
        '下装': ['trousers', 'pants', 'skirt', '裤', '裙'],
        '鞋履': ['shoes', 'footwear', '鞋'],
      };
      let found = 0;
      for (const keywords of Object.values(categories)) {
        if (keywords.some(k => cosLower.includes(k))) found++;
      }
      if (found < 3) {
        issues.push(new Issue({
          fieldEn: 'costume', fieldCn: '服装',
          severity: Severity.MINOR, issueType: IssueType.INCOMPLETE,
          description: `服装字段层次不足：当前覆盖 ${found}/4 项（外套/内搭/下装/鞋履）`,
          suggestion: "服装须采用分层描述，至少覆盖外套/内搭/下装/鞋履中的 3 项，示例：'charcoal gray wool overcoat, white dress shirt, navy trousers, black leather shoes'",
          currentValue: (typeof cos === "string" ? cos.slice(0, 60) : String(cos).slice(0, 60))
        }));
      }
    }

    return issues;
  }

  // ---- 4.4 字符数检查 ----
  _checkLength(shot) {
    const issues = [];

    // 单字段字符数
    for (const spec of FIELD_SPECS) {
      if (spec.charMax >= 9999) continue;
      const value = shot[spec.nameEn] || '';
      if (!value) continue;
      const length = value.length;
      // 【fix】低于下限报"不足"，高于上限报"超长"，两者之间不再告警
      if (length < spec.charMin) {
        const sev = [Priority.P0, Priority.P1].includes(spec.priority) ? Severity.MAJOR : Severity.MINOR;
        issues.push(new Issue({
          fieldEn: spec.nameEn, fieldCn: spec.nameCn,
          severity: sev, issueType: IssueType.OVER_LENGTH,
          description: `字段不足：${length} 字符，低于最低要求 ${spec.charMin}`,
          suggestion: `请扩展【${spec.nameCn}】字段至 ${spec.charMin} 字符以上，补充细节描述`,
          currentValue: `${safeSlice(value, 0, 40)}...(${length}字符)`
        }));
      } else if (length > spec.charMax) {
        const sev = [Priority.P0, Priority.P1].includes(spec.priority) ? Severity.MAJOR : Severity.MINOR;
        issues.push(new Issue({
          fieldEn: spec.nameEn, fieldCn: spec.nameCn,
          severity: sev, issueType: IssueType.OVER_LENGTH,
          description: `字段超长：${length} 字符，超出预算上限 ${spec.charMax}`,
          suggestion: `请压缩【${spec.nameCn}】字段至 ${spec.charMax} 字符以内，保留核心信息，去除修饰性描述`,
          currentValue: `${safeSlice(value, 0, 40)}...(${length}字符)`
        }));
      }
    }

    // 总字符数
    const total = Object.values(shot).filter(v => typeof v === 'string').reduce((sum, v) => sum + v.length, 0);
    if (total > MAX_TOTAL_CHARS) {
      issues.push(new Issue({
        fieldEn: '_total', fieldCn: '总长度',
        severity: Severity.MAJOR, issueType: IssueType.OVER_LENGTH,
        description: `提示词总字符数超限：${total} 字符，上限 ${MAX_TOTAL_CHARS}`,
        suggestion: `请执行六步截断策略：①去冗余 ②裁P3 ③裁P2 ④压P1局部 ⑤压P0局部 ⑥超限报警，目标降至 ${MAX_TOTAL_CHARS} 以内`
      }));
    }

    return issues;
  }

  _chapterForField(nameEn) {
    const map = {
      director_instruction: '3', constraint: '3', baseline: '4',
      scene: '4', lighting: '4', composition: '5', color_palette: '5',
      depth_of_field: '5', camera_movement: '5', character: '6',
      costume: '6', makeup: '6', action: '6', props: '7',
      portraits: '7', consistency: '7', dialogue: '8', timeline: '8',
      mood: '8', pacing: '8', transition: '9', audio: '9',
      negative: '9', bright_constraint: '10', character_constraint: '10',
    };
    return map[nameEn] || '2';
  }
}

// ============================================================
// LLMChecker - LLM语义检查层（跨字段一致性）
// ============================================================

const LLM_CHECKER_SYSTEM_PROMPT = `你是 AI 视频生成提示词的质量审核专家，精通 HyperrealitySystem 字段规范 v3.0，同时是一位有品味的剧本医生。

你的任务是对镜头提示词进行【语义一致性检查】与【平庸度检查】，重点关注规则引擎无法覆盖的问题：

一、语义一致性（原有 6 项，保留）：
1. 导演指令与情绪/色彩字段是否风格一致
2. 台词与动作是否语义自洽（疑问句应有看向对话对象的视线）
3. 场景描述与灯光描述是否冲突（夜间户外不应为明亮日光）
4. 负面约束与正面描述是否矛盾（正面要胶片质感，负面不应含 no grain）
5. 角色描述与角色一致性字段是否匹配（外观锚点用词逐字对齐）
6. 时间轴与运镜/动作的时间分布是否对齐

二、平庸度检查（新增，只报 major 以下）：
7. 无效形容词：'唯美/震撼/流畅/自然/宏大'等无法翻译成镜头语言的词
8. 演不出来的描述：'表情沉重''心情复杂'等没有物理动作支撑的情绪词
9. 灯光无K值/无真实光源名/无光比；场景四件套（墙/地/光/道具）缺件
10. timeline 按秒均分而非按情绪转折切分；action 不是物理动作链

issue_type 用 inconsistent|conflict|mediocre。只报告确实存在的问题，全过则返回 {"issues": []}。
输出 JSON 格式：{"issues": [{"field_en","field_cn","severity":"fatal|major|minor","issue_type","description","suggestion"}]}
suggestion 必须给出可直接替换的改写示范，禁止'建议优化'类空话。`;

class LLMChecker {
  constructor(llmClient, timeoutMs = 120000) {
    this.llm = llmClient;
    this.timeoutMs = timeoutMs; // 【v2.1.4-fix13】增加超时配置
  }

  async check(shot) {
    if (!this.llm) return [];
    const shotJson = JSON.stringify(shot, null, 2);
    const userPrompt = `请对以下镜头提示词进行语义一致性检查：\n\n${shotJson}`;

    // 【v2.1.4-fix13】Promise.race 超时保护
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`LLMChecker超时(${this.timeoutMs}ms)`)),
        this.timeoutMs
      );
    });

    try {
      const checkPromise = this.llm.reason(userPrompt, {
        systemPrompt: LLM_CHECKER_SYSTEM_PROMPT,
        temperature: 0.5 // 【v2.1.14-fix】结构化任务降温，减少自然语言发挥
      });
      checkPromise.catch(() => {}); // 【v2.1.6-fix】防止悬空 rejection
      const response = await Promise.race([
        checkPromise,
        timeoutPromise
      ]).finally(() => clearTimeout(timer));

      // 【修复 P0-3】reason() 返回信封格式 {success, content, error}，必须提取 content
      let rawContent;
      if (response && typeof response === 'object') {
        if (response.success === true && typeof response.content === 'string') {
          rawContent = response.content;
        } else if (response.success === false) {
          console.warn(`[LLMChecker] LLM返回失败: ${response.error || '未知错误'}`);
          return [];
        }
      }
      // 【v2.1.14-fix 故障A同源】鲁棒 JSON 提取：
      // 原实现对 LLM 返回的自然语言直接 JSON.parse 崩溃，静默降级为空导致语义检查失效
      let data;
      if (typeof rawContent === 'string') {
        const salvage = extractJson(rawContent);
        if (!salvage.ok) {
          const rawFile = _saveRawResponse('check', rawContent);
          console.warn(`[LLMChecker] JSON提取失败，本轮语义检查降级为空${rawFile ? `（原始响应已留存: ${rawFile}）` : ''}`);
          return [];
        }
        if (salvage.method !== 'direct') {
          console.log(`[LLMChecker] JSON经抢救提取成功（方式: ${salvage.method}）`);
        }
        data = salvage.data || { issues: [] };
      } else {
        data = rawContent || { issues: [] };
      }
      return (data.issues || []).map(item => new Issue({
        fieldEn: item.field_en || '',
        fieldCn: item.field_cn || '',
        severity: Severity[item.severity?.toUpperCase()] || Severity.MINOR,
        issueType: IssueType[item.issue_type?.toUpperCase()] || IssueType.INCONSISTENT,
        description: item.description || '',
        suggestion: item.suggestion || '',
      }));
    } catch (e) {
      // 【v2.1.4-fix13】区分超时和其他异常
      if (e.message?.includes('超时')) {
        console.warn(`[LLMChecker] 语义检查超时(${this.timeoutMs}ms)，降级为空`);
      } else {
        console.warn(`[LLMChecker] 语义检查异常: ${e.message}`);
      }
      return []; // 降级为空，不阻塞流程
    }
  }
}

// ============================================================
// FieldCheckAgent - 检查环节编排器
// ============================================================

class FieldCheckAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'FieldCheckAgent', llmTimeout: options.llmTimeout || 120000, ...options });
    this.ruleChecker = new RuleChecker();
    // 【v2.1.4-fix13】把超时配置传给 LLMChecker
    this.llmChecker = new LLMChecker(this._getLLMEngine(), options.llmTimeout || 120000);
  }

  async check(shot, shotId = 'shot_001') {
    console.log(`[FieldCheckAgent] 开始检查 ${shotId}...`);
    const report = new CheckReport(shotId);

    // 【v2.1.4-fix13】先展平 shot，统一字段命名和结构
    const flatShot = flattenShot(shot);

    // 第一层：规则检查（用展平后的 shot）
    const ruleIssues = this.ruleChecker.check(flatShot);
    report.issues.push(...ruleIssues);
    console.log(`[FieldCheckAgent] RuleChecker 完成：${ruleIssues.length} 项问题`);
    // 【v2.2.1-fix】打印具体规则名和描述，便于发现误报
    for (const issue of ruleIssues.slice(0, 20)) {
      console.log(`   📏 [${issue.severity || '?'}] ${issue.field_cn || issue.field_en || ''}: ${issue.description || issue.message || ''}`);
    }

    // 第二层：LLM语义检查（用展平后的 shot）
    if (this.llmChecker.llm) {
      const llmIssues = await this.llmChecker.check(flatShot);
      report.issues.push(...llmIssues);
      console.log(`[FieldCheckAgent] LLMChecker 完成：${llmIssues.length} 项问题`);
    }

    // 判定是否通过：无fatal且无major
    report.passed = (report.fatalCount === 0 && report.majorCount === 0);

    console.log(`[FieldCheckAgent] ${report.summary()}`);
    return report;
  }

  // 批量检查多个镜头
  async checkAll(shots) {
    const { SafePromise } = require('../../utils/safe-promise');
    return SafePromise.mapBatch(
      shots,
      (shot, index) => this.check(shot, shot.shotId || shot.shot_id || `shot_${index}`),
      5
    );
  }
}

module.exports = {
  FieldCheckAgent,
  RuleChecker,
  LLMChecker,
  Issue,
  CheckReport,
  FIELD_SPECS,
  SPEC_MAP,
  FIELD_REQUIREMENTS,
  Priority,
  Severity,
  IssueType,
  MAX_TOTAL_CHARS,
  // 【v2.1.4-fix13】导出展平工具，供 field-repair-agent.js 等下游使用
  flattenShot,
  CAMEL_TO_SNAKE,
  SNAKE_TO_CAMEL,
};
