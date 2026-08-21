/**
 * 景别转换语法矩阵 v1.0 — camera-coherence
 *
 * 泛化自 systems/continuity-engine.js（原版锁死 nirath 模式且仅被旧编剧链路使用）。
 * 题材中立：适用于任意视频类型的镜头间景别关系判定。
 *
 * 语法规则（好莱坞经典剪辑语法的工程化）：
 * - 相邻镜头景别差 ≤1 级：硬切合法
 * - 差 2 级：需谨慎，建议叠化/渐变/匹配剪辑，或有明确动机
 * - 差 ≥3 级（跳景别）：默认非法，除非声明了白名单动机
 *
 * 冲击切换白名单（跳景别合法化动机）：
 * 跳景别不是错误，是工具 —— 关键在"有动机"。
 *
 * @module camera-coherence/shot-scale-matrix
 * @version 1.0.0
 */

// 七级景别体系（从远到近），索引即等级
const SHOT_SCALES = ['ELS', 'LS', 'FS', 'MS', 'MCU', 'CU', 'ECU'];

const SCALE_NAMES = {
  ELS: '大远景', LS: '远景', FS: '全景', MS: '中景',
  MCU: '近景', CU: '特写', ECU: '大特写'
};

// 同义词汇映射（系统内多种表述 → 标准七级）
const SCALE_ALIASES = {
  // 英文枚举（visual-language-agent）
  'extreme_wide': 'ELS', 'extreme wide': 'ELS', 'establishing': 'LS',
  'wide': 'LS', 'full': 'FS',
  'medium': 'MS', 'medium shot': 'MS',
  'medium_close': 'MCU', 'medium close-up': 'MCU',
  'close_up': 'CU', 'close-up': 'CU', 'close': 'CU',
  'extreme_close': 'ECU', 'extreme_close_up': 'ECU', 'extreme close-up': 'ECU',
  // 中文表述（25字段 composition）
  '大远景': 'ELS', '超远景': 'ELS',
  '远景': 'LS',
  '全景': 'FS', '全身': 'FS',
  '中景': 'MS',
  '近景': 'MCU', '中近景': 'MCU',
  '特写': 'CU',
  '大特写': 'ECU', '极特写': 'ECU', '微距': 'ECU'
};

// 冲击切换白名单动机（跳景别合法化理由）
const SHOCK_MOTIVATIONS = {
  shock: { name: '震惊揭示', desc: '角色/观众认知被瞬间颠覆（如发现真相、爆炸、惊醒）', example: 'CU 角色表情 → ELS 揭示环境真相' },
  reveal: { name: '信息揭示', desc: '故意先藏后露，大跳景制造"原来如此"时刻', example: 'ECU 手部动作 → LS 揭示在拆弹' },
  time_jump: { name: '时空跳跃', desc: '时间/地点切换，跳景别标记时空断层', example: 'CU 童年 → ELS 成年后的城市' },
  comedy_cut: { name: '喜剧反差', desc: '一本正经后突然拉开露出荒诞全貌', example: 'CU 严肃表情 → ELS 他其实在幼儿园' },
  match_cut: { name: '匹配剪辑', desc: '形状/动作/颜色匹配的跳切（2001太空漫游式）', example: 'CU 骨头 → ELS 飞船' },
  dream_memory: { name: '梦境/回忆', desc: '心理时空的跳切，不受物理连续性约束', example: 'MS 现实 → ECU 记忆中的眼睛' },
  rhythmic: { name: '节奏重音', desc: 'MV/运动/动作场景的重拍切换（鼓点/击打对齐）', example: 'LS 助跑 → CU 起跳瞬间' },
  axis_reset: { name: '轴心重建', desc: '新场景/新空间的第一个镜头（establishing）', example: '上一场景 CU → 新场景 ELS' }
};

/**
 * 归一化景别表述 → 标准七级
 * @param {string} raw - 任意景别文本（英文枚举/中文/混排长句）
 * @returns {string|null} ELS/LS/FS/MS/MCU/CU/ECU 或 null
 */
function normalizeScale(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  // 直接命中标准级
  const upper = s.toUpperCase();
  if (SHOT_SCALES.includes(upper)) return upper;
  // 别名精确命中
  const lower = s.toLowerCase();
  if (SCALE_ALIASES[lower]) return SCALE_ALIASES[lower];
  if (SCALE_ALIASES[s]) return SCALE_ALIASES[s];
  // 长句包含匹配（如 "中景构图，主体位于黄金分割点"）
  // 注意顺序：先长词后短词，避免"大特写"被"特写"截胡
  const orderedKeys = Object.keys(SCALE_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of orderedKeys) {
    if (lower.includes(key.toLowerCase())) return SCALE_ALIASES[key];
  }
  return null;
}

/** 景别等级（0-6），未知返回 null */
function scaleLevel(raw) {
  const scale = normalizeScale(raw);
  return scale ? SHOT_SCALES.indexOf(scale) : null;
}

/**
 * 判定相邻镜头景别转换的合法性
 * @param {string} fromScaleRaw - 当前镜头景别
 * @param {string} toScaleRaw - 下一镜头景别
 * @param {Object} options - { motivation: 白名单动机id（可选）, sceneChange: 是否换场景 }
 * @returns {Object} { diff, verdict: 'legal'|'caution'|'shock_legal'|'illegal'|'unknown', advice, transitionSuggestion }
 */
function judgeTransition(fromScaleRaw, toScaleRaw, options = {}) {
  const from = scaleLevel(fromScaleRaw);
  const to = scaleLevel(toScaleRaw);

  if (from === null || to === null) {
    return {
      fromScale: SHOT_SCALES[from] || null, toScale: SHOT_SCALES[to] || null,
      diff: null, verdict: 'unknown',
      advice: '景别无法解析，建议为镜头补充机器可读的 shot_size 枚举字段'
    };
  }

  const diff = Math.abs(to - from);
  const result = {
    fromScale: SHOT_SCALES[from],
    toScale: SHOT_SCALES[to],
    fromName: SCALE_NAMES[SHOT_SCALES[from]],
    toName: SCALE_NAMES[SHOT_SCALES[to]],
    diff
  };

  // 换场镜（新场景 establishing）天然合法
  if (options.sceneChange) {
    return { ...result, verdict: 'legal', reason: 'scene_change', advice: '跨场景切换，景别跳变合法（新空间重建）' };
  }

  if (diff <= 1) {
    return { ...result, verdict: 'legal', advice: '景别渐变，硬切合法', transitionSuggestion: 'hard_cut' };
  }

  if (diff === 2) {
    if (options.motivation && SHOCK_MOTIVATIONS[options.motivation]) {
      return { ...result, verdict: 'shock_legal', motivation: SHOCK_MOTIVATIONS[options.motivation].name, advice: `2级跳景，动机「${SHOCK_MOTIVATIONS[options.motivation].name}」成立` };
    }
    return { ...result, verdict: 'caution', advice: '景别差2级，建议叠化/移焦/匹配剪辑软化，或补充动机', transitionSuggestion: 'smooth_dissolve | match_cut | rack_focus' };
  }

  // diff >= 3 跳景别
  if (options.motivation && SHOCK_MOTIVATIONS[options.motivation]) {
    return { ...result, verdict: 'shock_legal', motivation: SHOCK_MOTIVATIONS[options.motivation].name, advice: `${diff}级跳景，动机「${SHOCK_MOTIVATIONS[options.motivation].name}」成立，冲击切换合法` };
  }
  return {
    ...result,
    verdict: 'illegal',
    advice: `景别跳变${diff}级（${SCALE_NAMES[SHOT_SCALES[from]]}→${SCALE_NAMES[SHOT_SCALES[to]]}）且无动机声明，观众会感到突兀。建议：①插入中间景别过渡镜；②或将 transition 改为强动机转场并标注动机`,
    transitionSuggestion: 'insert_intermediate_shot | declare_motivation'
  };
}

/** 全片景别序列节奏分析 */
function analyzeScaleRhythm(scaleSequence) {
  const levels = scaleSequence.map(scaleLevel);
  const issues = [];

  // 1. 同景别三连检测（单调）
  let runStart = 0;
  for (let i = 1; i <= levels.length; i++) {
    if (i === levels.length || levels[i] !== levels[runStart] || levels[i] === null) {
      const runLen = i - runStart;
      if (runLen >= 3 && levels[runStart] !== null) {
        issues.push({
          type: 'monotony',
          range: [runStart, i - 1],
          message: `连续${runLen}个${SCALE_NAMES[SHOT_SCALES[levels[runStart]]]}镜头，视觉节奏单调，建议插入不同景别`
        });
      }
      runStart = i;
    }
  }

  // 2. ≥3 级跳变检测（动机需在镜头数据上另行标注，此处仅报告）
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] !== null && levels[i - 1] !== null) {
      const diff = Math.abs(levels[i] - levels[i - 1]);
      if (diff >= 3) {
        issues.push({
          type: 'abrupt_jump',
          between: [i - 1, i],
          diff,
          message: `${SCALE_NAMES[SHOT_SCALES[levels[i - 1]]]}→${SCALE_NAMES[SHOT_SCALES[levels[i]]]} 跳变${diff}级，需确认是否有动机`
        });
      }
    }
  }

  const curve = levels.map(l => l === null ? '?' : SHOT_SCALES[l]).join(' → ');
  return { curve, levels, issues };
}

module.exports = {
  SHOT_SCALES,
  SCALE_NAMES,
  SCALE_ALIASES,
  SHOCK_MOTIVATIONS,
  normalizeScale,
  scaleLevel,
  judgeTransition,
  analyzeScaleRhythm
};
