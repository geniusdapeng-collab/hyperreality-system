/**
 * ProductionProfile - 生产画像唯一真源
 *
 * 取代 theme-config 的"类型枚举驱动决策"模式：
 * - genre（题材）= 开放文本，只用于描述/prompt/技能召回，不做硬决策
 * - profile（画像）= 结构化特征向量，驱动下游全部生产决策
 *
 * 铁律：profile 每个字段都有保守默认值，任何缺失都能安全落地。
 */

const PROFILE_SCHEMA = {
  narrative_mode: { enum: ['dramatic', 'educational', 'documentary', 'lifelog', 'commercial'], default: 'dramatic' },
  dialogue_density: { enum: ['none', 'low', 'medium', 'high'], default: 'medium' },
  factual_accuracy: { enum: ['strict', 'normal', 'free'], default: 'normal' },
  safety_level: { enum: ['kids', 'strict', 'moderate', 'free'], default: 'moderate' },
  visual_register: { enum: ['realistic', 'stylized', 'abstract'], default: 'realistic' },
  pacing: { enum: ['slow', 'medium', 'fast'], default: 'medium' },
  duration_target: { type: 'number', min: 5, max: 600, default: 60 },
  aspect_ratio: { enum: ['16:9', '9:16', '1:1', '4:3'], default: '16:9' },
  audience: { type: 'string', default: '大众观众' },
  special_constraints: { type: 'array', default: [] }
};

/**
 * 规范化 profile：任何输入（LLM 输出/用户输入/preset/空）都产出完整合法 profile
 * 这是全系统唯一的 profile 收口，所有字段缺失/非法时都落保守默认
 */
function normalizeProfile(raw = {}) {
  const profile = {};
  for (const [key, rule] of Object.entries(PROFILE_SCHEMA)) {
    const v = raw[key];
    if (rule.enum) {
      profile[key] = rule.enum.includes(v) ? v : rule.default;
    } else if (rule.type === 'number') {
      const n = Number(v);
      profile[key] = (Number.isFinite(n) && n >= rule.min && n <= rule.max) ? n : rule.default;
    } else if (rule.type === 'array') {
      profile[key] = Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : rule.default;
    } else {
      profile[key] = (typeof v === 'string' && v.trim()) ? v.trim() : rule.default;
    }
  }
  return profile;
}

/**
 * 台词策略推导（替代 phase-3 的类型白名单判断）
 */
function dialogueStrategy(profile) {
  const p = normalizeProfile(profile);
  if (p.dialogue_density === 'high') return 'extend'; // 台词重 → 保台词（延长镜头）
  if (p.dialogue_density === 'medium') return 'smart';
  return 'shorten'; // 台词轻 → 保节奏（缩短台词）
}

/**
 * 内容安全配置推导（替代 theme-config.contentSafety）
 */
function safetyConfig(profile) {
  const p = normalizeProfile(profile);
  const base = { factCheck: false, disclaimer: null, forbiddenWords: [], boundaryCheck: 'basic' };
  if (p.safety_level === 'kids') {
    return { ...base, forbiddenWords: ['暴力', '血腥', '恐怖', '死亡', '仇恨'], boundaryCheck: 'strict' };
  }
  if (p.safety_level === 'strict') {
    return { ...base, forbiddenWords: ['暴力', '色情', '虐待'], boundaryCheck: 'strict' };
  }
  return base;
}

/**
 * 事实核查配置推导（替代 EDU/DOC 专属 validators）
 */
function factualConfig(profile) {
  const p = normalizeProfile(profile);
  if (p.factual_accuracy === 'strict') {
    return { factCheck: true, disclaimer: '内容仅供参考，请核实关键信息', validators: ['factCheck', 'disclaimer'] };
  }
  return { factCheck: false, disclaimer: null, validators: [] };
}

/**
 * 写实校验强度推导（替代"全类型一刀切"的禁用词校验）
 */
function realismCheckLevel(profile) {
  const p = normalizeProfile(profile);
  return { realistic: 'full', stylized: 'core', abstract: 'skip' }[p.visual_register];
}

/**
 * 从 profile 推导一个"最接近的预设类型"（仅用于展示/调试/旧链路兼容，不做决策）
 */
function closestPreset(profile) {
  const p = normalizeProfile(profile);
  if (p.safety_level === 'kids') return 'KIDS';
  if (p.narrative_mode === 'educational') return 'EDU';
  if (p.narrative_mode === 'documentary') return 'DOC';
  if (p.narrative_mode === 'lifelog') return 'FAMILY';
  if (p.narrative_mode === 'commercial') return 'MARKETING';
  if (p.visual_register === 'abstract') return 'ART';
  return 'CINE';
}

/**
 * 写实校验词表（按 visual_register 分级）
 * full: 写实 — 最严格，所有科幻/抽象词汇禁用
 * core: 风格化 — 仅禁用真正的科幻/抽象概念，允许风格化元素（霓虹、抽象几何等）
 * skip: 抽象 — 不做检查
 */
const REALISM_FORBIDDEN = {
  full: {
    scene: ['全息', '虚拟', '投影', '抽象', '光影场域', '数据空间', '元宇宙', '时间操控', '霓虹', '微观世界', '宏观', '抽象几何', '流动光影', '交织光影', '色彩对冲'],
    action: ['全息', '虚拟', '投影', '空间扭曲', '时间残影', '霓虹', '数据流', '光即角色', '抽象构图', '梦境流动性', '手绘动画', '湿版摄影', '黑色电影']
  },
  core: {
    // 风格化允许：霓虹、抽象几何、流动光影、手绘动画、湿版摄影、黑色电影
    // 仅禁用真正打破物理/现实边界的核心科幻概念
    scene: ['元宇宙', '时间操控', '数据空间', '光影场域'],
    action: ['空间扭曲', '时间残影', '光即角色', '梦境流动性']
  },
  skip: {
    scene: [],
    action: []
  }
};

/**
 * 获取分级后的写实禁用词表
 * @param {string|object} profileOrLevel - profile 对象或 level 字符串 ('full'/'core'/'skip')
 * @returns {{scene: string[], action: string[]}}
 */
function getRealismForbidden(profileOrLevel) {
  const level = typeof profileOrLevel === 'string' ? profileOrLevel : realismCheckLevel(profileOrLevel);
  return REALISM_FORBIDDEN[level] || REALISM_FORBIDDEN.full;
}

module.exports = {
  PROFILE_SCHEMA,
  normalizeProfile,
  dialogueStrategy,
  safetyConfig,
  factualConfig,
  realismCheckLevel,
  getRealismForbidden,
  closestPreset
};