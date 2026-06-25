/**
 * FieldCheckAgent - 字段内容检查环节
 * 负责: 对25字段进行规则+LLM混合检查，输出结构化问题清单
 * 位置: PromptFusionAgent之后，FieldGuard之前
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
const { BaseAgent } = require('../production-engine/agents/base-agent');
const { asString, asStringLower, safeSlice, safeIncludes } = require('../field-standardizer');

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
  { nameCn: '导演指令', nameEn: 'director_instruction', priority: Priority.P0, charMin: 50, charMax: 80, required: true },
  { nameCn: '约束', nameEn: 'constraint', priority: Priority.P0, charMin: 100, charMax: 150, required: true },
  { nameCn: '基础', nameEn: 'baseline', priority: Priority.P0, charMin: 80, charMax: 100, required: true },
  { nameCn: '场景', nameEn: 'scene', priority: Priority.P0, charMin: 150, charMax: 200, required: true },
  { nameCn: '灯光', nameEn: 'lighting', priority: Priority.P0, charMin: 100, charMax: 150, required: true },
  { nameCn: '运镜', nameEn: 'camera_movement', priority: Priority.P0, charMin: 80, charMax: 120, required: true },
  { nameCn: '角色', nameEn: 'character', priority: Priority.P0, charMin: 50, charMax: 80, required: true },
  { nameCn: '动作', nameEn: 'action', priority: Priority.P0, charMin: 100, charMax: 150, required: true },
  { nameCn: '台词', nameEn: 'dialogue', priority: Priority.P0, charMin: 0, charMax: 9999, required: true },
  { nameCn: '负面约束', nameEn: 'negative', priority: Priority.P0, charMin: 200, charMax: 300, required: true },
  { nameCn: '定妆照', nameEn: 'portraits', priority: Priority.P0, charMin: 0, charMax: 9999, required: true },
  { nameCn: '角色一致性', nameEn: 'consistency', priority: Priority.P0, charMin: 50, charMax: 80, required: true },
  // P1 核心级（7个，必填）
  { nameCn: '构图', nameEn: 'composition', priority: Priority.P1, charMin: 80, charMax: 120, required: true },
  { nameCn: '色彩', nameEn: 'color_palette', priority: Priority.P1, charMin: 80, charMax: 120, required: true },
  { nameCn: '景深', nameEn: 'depth_of_field', priority: Priority.P1, charMin: 60, charMax: 100, required: true },
  { nameCn: '时间轴', nameEn: 'timeline', priority: Priority.P1, charMin: 150, charMax: 200, required: true },
  { nameCn: '情绪', nameEn: 'mood', priority: Priority.P1, charMin: 30, charMax: 50, required: true },
  { nameCn: '明亮约束', nameEn: 'bright_constraint', priority: Priority.P1, charMin: 50, charMax: 80, required: true },
  { nameCn: '角色约束', nameEn: 'character_constraint', priority: Priority.P1, charMin: 50, charMax: 80, required: true },
  // P2 增强级（4个，可选）
  { nameCn: '服装', nameEn: 'costume', priority: Priority.P2, charMin: 60, charMax: 100, required: false },
  { nameCn: '道具', nameEn: 'props', priority: Priority.P2, charMin: 40, charMax: 80, required: false },
  { nameCn: '节奏', nameEn: 'pacing', priority: Priority.P2, charMin: 60, charMax: 100, required: false },
  { nameCn: '音频', nameEn: 'audio', priority: Priority.P2, charMin: 60, charMax: 100, required: false },
  // P3 可选级（2个，可选）
  { nameCn: '化妆', nameEn: 'makeup', priority: Priority.P3, charMin: 40, charMax: 60, required: false },
  { nameCn: '转场', nameEn: 'transition', priority: Priority.P3, charMin: 30, charMax: 50, required: false },
];

const SPEC_MAP = {};
for (const spec of FIELD_SPECS) {
  SPEC_MAP[spec.nameEn] = spec;
}

// 【v2.1.4-fix13】camelCase ↔ snake_case 双向映射，解决命名不一致
const CAMEL_TO_SNAKE = {};
const SNAKE_TO_CAMEL = {};
for (const spec of FIELD_SPECS) {
  const snake = spec.nameEn.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
  CAMEL_TO_SNAKE[spec.nameEn] = snake;
  SNAKE_TO_CAMEL[snake] = spec.nameEn;
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
      // snake_case → camelCase
      const camelKey = SNAKE_TO_CAMEL[key] || key;
      if (!(camelKey in flat) || !flat[camelKey]) {
        flat[camelKey] = value;
      }
      // 也保留 snake_case 版本（向后兼容）
      if (!(key in flat) || !flat[key]) {
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

const MAX_TOTAL_CHARS = 12000; // 【审计修复】与 prompt-length.js 保持一致

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
      const isEmpty = !value || (typeof value === 'string' && !value.trim());
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
      const hasRealism = /写实|无特效|无科幻|realistic|no effect|no sci/.test(diLower);
      const hasMood = /基调|氛围|情绪|冷静|紧张|温馨|tone|mood|atmosphere|professional|intense|warm/.test(diLower);
      const missing = [];
      if (!hasStyle) missing.push('风格定位');
      if (!hasRealism) missing.push('写实要求');
      if (!hasMood) missing.push('情绪基调');
      if (missing.length) {
        issues.push(new Issue({
          fieldEn: 'director_instruction', fieldCn: '导演指令',
          severity: Severity.FATAL, issueType: IssueType.INCOMPLETE,
          description: `导演指令缺少要素：${missing.join('、')}`,
          suggestion: `导演指令须覆盖风格定位+写实要求+情绪基调，当前缺少：${missing.join('、')}。示例：'纪录片真实感，手持摄影风格，自然光效，无特效，冷静专业基调'`,
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
          severity: Severity.FATAL, issueType: IssueType.INCOMPLETE,
          description: `约束字段缺少技术参数：${missing.join('、')}`,
          suggestion: `约束须包含画幅+分辨率+格式+帧率，示例：'Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps'`,
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
          severity: Severity.FATAL, issueType: IssueType.INCOMPLETE,
          description: `灯光字段缺少要素：${missing.join('、')}`,
          suggestion: `灯光须含主光+色温+光质三要素。示例：'key light: soft diffused window light at 5600K, fill light: LED panel at 4000K, low contrast 2:1'`,
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
          severity: Severity.FATAL, issueType: IssueType.INCOMPLETE,
          description: `运镜字段缺少要素：${missing.join('、')}`,
          suggestion: `运镜须含运动方式+速度+时间分布。示例：'slow push in toward the protagonist's face, 0.5m/s constant speed, duration 3 seconds'`,
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
          severity: Severity.FATAL, issueType: IssueType.INCOMPLETE,
          description: "负面约束缺少基础排除项：'no text' 和 'no watermark'",
          suggestion: "负面约束必须包含 'no text, no watermark' 两项基础排除，建议同时包含 no blurry, no extra limbs 等通用负面词",
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
        severity: Severity.FATAL, issueType: IssueType.FORMAT_ERROR,
        description: `定妆照路径格式不规范：${safeSlice(pt, 0, 40)}`,
        suggestion: '路径格式应为：/characters/{角色英文名}/portrait_v{版本号}.{png|jpg}，示例：/characters/chen_zhuo/portrait_v1.png',
        currentValue: safeSlice(pt, 0, 40)
      }));
    }

    // 台词：句末标点+标点规范
    const dl = shot.dialogue || '';
    if (dl) {
      if (!/[。！？…]$/.test(dl)) {
        issues.push(new Issue({
          fieldEn: 'dialogue', fieldCn: '台词',
          severity: Severity.FATAL, issueType: IssueType.FORMAT_ERROR,
          description: '台词缺少句末标点（须以 。！？… 结尾）',
          suggestion: `句末标点是口型闭合的信号标记，不可省略。建议在台词末尾添加 '。'：'${dl}。'`,
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
      if (length > spec.charMax) {
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

const LLM_CHECKER_SYSTEM_PROMPT = `你是一个 AI 视频生成提示词的质量审核专家，精通 HyperrealitySystem 字段规范 v3.0。

你的任务是对镜头提示词进行【语义一致性检查】，重点关注规则引擎无法覆盖的跨字段语义问题：

1. 导演指令与情绪/色彩字段是否风格一致
   - 如导演指令为"紧张刺激"，情绪不应为"relaxed"，色彩不应为暖色调高饱和
2. 台词与动作是否语义自洽
   - 如台词为疑问句，动作中应有看向对话对象的视线描述
3. 场景描述与灯光描述是否冲突
   - 如场景为"夜间户外"，灯光不应为"明亮日光"
4. 负面约束与正面描述是否矛盾
   - 如正面要求"复古胶片质感"，负面约束不应含"no grain"
5. 角色描述与角色一致性是否匹配
   - 角色字段定义的外观应与一致性字段锚定词一致
6. 时间轴与运镜/动作的时间分布是否对齐

返回JSON格式：
{
  "issues": [
    {
      "field_en": "字段英文名",
      "field_cn": "字段中文名",
      "severity": "fatal|major|minor",
      "issue_type": "inconsistent|conflict",
      "description": "问题描述",
      "suggestion": "具体修改建议"
    }
  ]
}

注意：只报告确实存在的语义问题，不要报告规则引擎已覆盖的格式/缺失问题。如果语义检查全部通过，返回 {"issues": []}。`;

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
      const response = await Promise.race([
        this.llm.chat(LLM_CHECKER_SYSTEM_PROMPT, userPrompt, 0.2),
        timeoutPromise
      ]).finally(() => clearTimeout(timer));

      const data = JSON.parse(response);
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
    const reports = [];
    for (const shot of shots) {
      const report = await this.check(shot, shot.shotId || shot.shot_id || 'unknown');
      reports.push(report);
    }
    return reports;
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
  Priority,
  Severity,
  IssueType,
  MAX_TOTAL_CHARS,
  // 【v2.1.4-fix13】导出展平工具，供 field-repair-agent.js 等下游使用
  flattenShot,
  CAMEL_TO_SNAKE,
  SNAKE_TO_CAMEL,
};
