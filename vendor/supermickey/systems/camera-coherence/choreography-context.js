/**
 * 邻镜上下文构建器 v1.0 — camera-coherence
 *
 * 解决当前主链路的核心盲区：
 * PromptFusion 逐镜头独立调用（_buildBatchPrompt([shot])），
 * VisualLanguage 按 3 镜一批，批间互不可见 ——
 * LLM 设计运镜/转场时完全看不到相邻镜头的选择，协调性无从谈起。
 *
 * 本模块提供零侵入的"邻镜摘要"注入：
 * 1. VL 阶段：注入全片镜头清单 + 景别节奏指导原则（让 LLM 全局规划）
 * 2. PromptFusion 阶段：为每个镜头注入 前一镜/后一镜 的景别+运镜+转场摘要
 * 3. 转场动机词表：让 LLM 在需要冲击切换时主动标注动机
 *
 * @module camera-coherence/choreography-context
 * @version 1.0.0
 */

const { SHOCK_MOTIVATIONS, SCALE_NAMES } = require('./shot-scale-matrix');

/**
 * 构建 VL Agent 的全局编排指导段（注入 _getSystemPrompt 或 _buildPrompt）
 * @param {Array} shots - 全片镜头（带 shotId/duration/scene/mood/sceneType）
 * @returns {string} prompt 段
 */
function buildGlobalChoreographyGuide(shots = []) {
  const shotList = shots.map((s, i) => {
    const id = s.shotId || s.shot_id || `S${i + 1}`;
    return `  ${i + 1}. ${id}（${s.duration || '?'}s | ${s.sceneType || s.type || '常规'} | 情绪:${s.mood || s.emotion_target || '?'}）${(s.scene || '').slice(0, 40)}`;
  }).join('\n');

  const motivations = Object.entries(SHOCK_MOTIVATIONS)
    .map(([id, m]) => `  - ${id}(${m.name}): ${m.desc}`).join('\n');

  return `【全片运镜编排指导（你必须遵守的剪辑语法）】

全片共 ${shots.length} 个镜头：
${shotList}

一、景别节奏规则：
1. 相邻镜头景别差 ≤1 级 → 硬切合法；差 2 级 → 建议叠化/匹配剪辑；差 ≥3 级 → 必须声明动机
2. 避免同景别三连：连续 3 个相同景别会让观众感到单调
3. 全片景别序列应形成宏观曲线：开场有建立镜（远景/大远景），高潮段提高近景/特写密度，结尾可拉回全景收束
4. 七级景别：ELS大远景 → LS远景 → FS全景 → MS中景 → MCU近景 → CU特写 → ECU大特写

二、运镜动机规则（每个运镜必须有动机）：
- 角色移动 → 跟拍/横移 | 信息揭示 → 缓推 | 情绪外化/紧张 → 手持
- 客观陈述/讲解 → 固定机位 | 环境展示 → 缓慢横移/升降 | 冲击瞬间 → 急推后急停

三、运镜衔接规则：
1. 相邻镜头避免方向硬反转（推→拉、左摇→右摇）；如必须反转，第二镜起幅先稳定 0.5 秒
2. 运动镜与固定镜交替形成呼吸感，避免全片皆动或全片皆静
3. 同场景连续镜头保持屏幕方向一致（不越轴）

四、冲击切换白名单（跳景别合法化动机，使用时必须在 transition 中标注动机 id）：
${motivations}

五、转场字段输出规范：
转场 = 方式(hard_cut/smooth_dissolve/match_cut/rack_focus/whip_pan/object_occlusion/light_flash) + 持续时长 + 方向
如为跳景别（差≥3级），追加 "motivation: <白名单id>"`;
}

/**
 * 为单个镜头构建邻镜摘要（注入 PromptFusion 的单镜 prompt）
 * @param {Array} plans - 全片镜头的运镜计划摘要 [{shotId, scale, movement, transition}]
 * @param {number} index - 当前镜头索引
 * @returns {string} 邻镜上下文段（首尾镜头只有单侧）
 */
function buildNeighborContext(plans, index) {
  const curr = plans[index];
  const prev = index > 0 ? plans[index - 1] : null;
  const next = index < plans.length - 1 ? plans[index + 1] : null;

  const fmt = (p, label) => {
    if (!p) return null;
    const scale = p.scale ? (SCALE_NAMES[p.scale] || p.scale) : (p.scaleRaw || '未定景别');
    return `  ${label} ${p.shotId}: 景别=${scale} | 运镜=${p.movementRaw || p.movement || '未定'} | 转场=${p.transition || '未定'}`;
  };

  const lines = ['【邻镜协调上下文（你的设计必须与之衔接）】'];
  const prevLine = fmt(prev, '上一镜');
  const nextLine = fmt(next, '下一镜');
  if (prevLine) lines.push(prevLine); else lines.push('  （本镜为全片第一个镜头，开场镜建议远景/大远景建立空间）');
  if (nextLine) lines.push(nextLine); else lines.push('  （本镜为全片最后一个镜头，收尾镜可考虑拉回全景定格）');
  lines.push('协调要求：');
  lines.push('1. 你的 composition（景别）与上一镜差 ≤1 级为佳；差 2 级请在 transition 写明软化方式；差 ≥3 级必须在 transition 标注 motivation');
  lines.push('2. 你的 camera_movement 避免与上一镜方向硬反转；timeline 的末段（落幅）状态应考虑下一镜的起幅衔接');
  return lines.join('\n');
}

/**
 * 从 shots 数组提取轻量 plans（不依赖 validator，供 prompt 注入用）
 */
function extractLightPlans(shots = []) {
  return shots.map(s => {
    const f = s.fields || s;
    return {
      shotId: s.shotId || s.shot_id || 'unknown',
      scale: null,
      scaleRaw: s.camera?.shot_size || f.composition || s.shot_type || '',
      movement: s.camera?.movement || '',
      movementRaw: f.camera_movement || s.cameraString || s.camera_string || s.camera?.movement || '',
      transition: f.transition || s.transition || s.transition_intent || ''
    };
  });
}

module.exports = {
  buildGlobalChoreographyGuide,
  buildNeighborContext,
  extractLightPlans
};
