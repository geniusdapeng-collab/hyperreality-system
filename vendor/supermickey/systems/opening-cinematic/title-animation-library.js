/**
 * 通用标题动效库 v1.0 — opening-cinematic
 *
 * 泛化自山海经 title-animation-library（原库锁死 Nirath/异兽世界观）。
 * 本库面向任意题材：每个动效模式包含：
 * - 适用题材/情绪/视觉风格（用于规则初筛打分）
 * - 归一化节拍表（0-1 时间轴，渲染时按片头实际时长换算秒）
 * - 画面描述模板（{slots} 由 LLM 或规则按主题填充）
 * - 音效提示 + 震撼指数
 *
 * 使用方式：
 * const { selectPatterns, getPattern, renderPatternBeats } = require('./title-animation-library');
 * const candidates = selectPatterns({ genre, mood, visualStyle }, 3);
 *
 * @module opening-cinematic/title-animation-library
 * @version 1.0.0
 */

// ============================================================
// 动效模式库
// beats 时间轴为归一化 0-1：t0=片头开始，t1=片头结束
// ============================================================

const TITLE_ANIMATION_PATTERNS = {

  // ---------- 1. 粒子汇聚型 ----------
  particle_convergence: {
    id: 'particle_convergence',
    name: '粒子汇聚成型',
    category: '物质构成',
    applicableGenres: ['史诗', '奇幻', '科幻', '纪录片', '品牌', '通用'],
    applicableMoods: ['epic', 'mysterious', 'cosmic', 'awe', 'solemn'],
    applicableStyles: ['cinematic', 'fantasy', 'sci-fi', 'REAL'],
    epicLevel: 8,
    beats: [
      { t: [0.00, 0.20], phase: 'hook', visual: '环境中无数微小发光粒子（尘埃/孢子/星尘/光点）从画面边缘缓慢飘来，镜头缓推', audio: '低频铺底渐入，粒子音效如细沙流动' },
      { t: [0.20, 0.55], phase: 'reveal', visual: '粒子流加速汇聚，在空中编织出主标题字母/文字的轮廓，结构逐渐清晰', audio: '节奏上升，汇聚瞬间一记金属共鸣' },
      { t: [0.55, 0.80], phase: 'reveal', visual: '副标题以较小粒子流在主标题下方凝结，主标题实体化并稳定', audio: '和声铺开，亮度随字体实体化提升' },
      { t: [0.80, 1.00], phase: 'freeze', visual: '标题稳定悬浮，残余粒子环绕缓慢流动，镜头定格', audio: '一记深低音收束，留出过渡静默拍' }
    ],
    titleSlot: '粒子凝聚成"{mainTitle}"，字体边缘有粒子持续溢出的微动态',
    audioHint: '低频 drone + 粒子颗粒音 + 金属共鸣点缀',
    promptTemplate: 'countless tiny luminous particles drift in from the edges, converging and weaving into glowing letterforms, particle trails, volumetric light, {environment}'
  },

  // ---------- 2. 光束投影型 ----------
  light_projection: {
    id: 'light_projection',
    name: '光束投影显形',
    category: '光影构成',
    applicableGenres: ['史诗', '科幻', '悬疑', '纪录片', '品牌', '通用'],
    applicableMoods: ['epic', 'mysterious', 'tense', 'awe'],
    applicableStyles: ['cinematic', 'sci-fi', 'REAL'],
    epicLevel: 9,
    beats: [
      { t: [0.00, 0.18], phase: 'hook', visual: '黑暗/云层/烟雾中一道主光束破开，镜头仰拍光路', audio: '一记深沉的轰鸣，光束破开瞬间空气震颤' },
      { t: [0.18, 0.55], phase: 'reveal', visual: '光束在载体（地面/水面/墙面/空间）上投射出主标题的光影轮廓，光中尘埃可见', audio: '弦乐长音上升，光影成型时加入合唱音色' },
      { t: [0.55, 0.80], phase: 'reveal', visual: '第二束辅助光加入，副标题以较小光影在主标题下方显现', audio: '节奏稳定，加入节拍器式低频脉冲' },
      { t: [0.80, 1.00], phase: 'freeze', visual: '光影标题达到最亮后微微收光定格，余晖不散', audio: '高音渐弱收尾，一拍静默' }
    ],
    titleSlot: '光束投射出"{mainTitle}"的光影轮廓，光中尘埃粒子在字母间流动',
    audioHint: '深沉轰鸣 + 弦乐长音 + 低频脉冲',
    promptTemplate: 'a beam of light breaks through darkness, projecting glowing letterforms onto {carrier}, dust particles visible in volumetric light rays, dramatic chiaroscuro'
  },

  // ---------- 3. 材质凝结型 ----------
  material_crystallize: {
    id: 'material_crystallize',
    name: '材质凝结成型',
    category: '物质构成',
    applicableGenres: ['奇幻', '史诗', '自然', '纪录片', '通用'],
    applicableMoods: ['mysterious', 'awe', 'tender', 'solemn'],
    applicableStyles: ['cinematic', 'fantasy', 'REAL'],
    epicLevel: 8,
    beats: [
      { t: [0.00, 0.22], phase: 'hook', visual: '环境物质（水雾/晶体/熔岩/金属液/冰晶）处于无序运动状态，镜头微距特写质感', audio: '材质环境音（流水/结晶碎裂/金属嗡鸣）' },
      { t: [0.22, 0.60], phase: 'reveal', visual: '物质在光影作用下逐字凝结成主标题，折射/反射产生真实光学效果', audio: '凝结过程的清脆音效与音乐主拍对齐' },
      { t: [0.60, 0.82], phase: 'reveal', visual: '副标题以更小的同材质形态在主标题下方成形', audio: '织体加厚，材质音效渐弱' },
      { t: [0.82, 1.00], phase: 'freeze', visual: '材质标题完整呈现，表面有永恒的微观动态（涟漪/流光），镜头定格', audio: '音乐收束，材质环境音延续一拍后淡出' }
    ],
    titleSlot: '{material}凝结成"{mainTitle}"，表面有真实的光学折射与微观动态',
    audioHint: '材质环境音 + 清脆凝结音 + 织体上升',
    promptTemplate: '{material} slowly crystallizes into letterforms with realistic refraction and subsurface scattering, macro detail, {environment}'
  },

  // ---------- 4. 环境生长型 ----------
  environment_growth: {
    id: 'environment_growth',
    name: '环境生长浮现',
    category: '自然构成',
    applicableGenres: ['自然', '人文', '纪录片', '温情', '通用'],
    applicableMoods: ['tender', 'warm', 'mysterious', 'calm'],
    applicableStyles: ['REAL', 'cinematic', 'documentary'],
    epicLevel: 6,
    beats: [
      { t: [0.00, 0.25], phase: 'hook', visual: '空镜环境（墙面/岩石/纸张/土地/雾气）平静呈现，镜头缓慢横移', audio: '环境白噪音，单一乐器孤独进入' },
      { t: [0.25, 0.60], phase: 'reveal', visual: '环境表面自然生长出主标题纹理（藤蔓蔓延/刻痕风化成字/墨迹洇开/雾气凝字）', audio: '生长过程的细微声与乐器旋律同步' },
      { t: [0.60, 0.82], phase: 'reveal', visual: '副标题以相同生长逻辑在下方小字呈现', audio: '加入第二乐器，情绪展开' },
      { t: [0.82, 1.00], phase: 'freeze', visual: '生长停止，标题与环境融为一体定格，一片叶子/尘埃飘过收尾', audio: '旋律悬停，一记轻打击乐收束' }
    ],
    titleSlot: '环境表面自然生长出"{mainTitle}"的纹理，与载体材质融为一体',
    audioHint: '环境白噪音 + 独奏乐器 + 轻打击乐',
    promptTemplate: 'textures naturally grow on the {carrier} surface forming letterforms, organic integration with the environment, subtle motion, {environment}'
  },

  // ---------- 5. 角色互动型 ----------
  character_interaction: {
    id: 'character_interaction',
    name: '角色带出标题',
    category: '角色驱动',
    applicableGenres: ['奇幻', '冒险', '亲子', '动画', '史诗', '通用'],
    applicableMoods: ['epic', 'playful', 'warm', 'awe'],
    applicableStyles: ['cinematic', 'fantasy', 'animation'],
    epicLevel: 9,
    beats: [
      { t: [0.00, 0.20], phase: 'hook', visual: '{character}从画面一侧快速进入（奔/飞/跃），带出物理痕迹（气流/火焰/光尾/水花）', audio: '动作音效+一记低音冲击，音乐骤起' },
      { t: [0.20, 0.55], phase: 'reveal', visual: '角色运动轨迹留下的痕迹在空中凝结成主标题文字', audio: '轨迹音效（呼啸/燃烧/水流）与旋律主拍对齐' },
      { t: [0.55, 0.80], phase: 'reveal', visual: '角色停在画面另一侧回望/驻足，副标题在主标题下方以余韵粒子成形', audio: '音乐铺开，角色环境声（呼吸/脚步）清晰' },
      { t: [0.80, 1.00], phase: 'freeze', visual: '标题稳定，角色与标题同框构图定格，眼神/姿态指向正片方向', audio: '音乐收束，角色一声短促发声作为听觉签名' }
    ],
    titleSlot: '{character}的运动轨迹凝结成"{mainTitle}"，角色与标题同框',
    audioHint: '动作音效 + 低音冲击 + 角色声音签名',
    promptTemplate: '{character} dashes across the frame leaving a trail of {trail} that crystallizes into glowing letterforms, dynamic action, {environment}'
  },

  // ---------- 6. 能量爆发型 ----------
  energy_burst: {
    id: 'energy_burst',
    name: '能量爆发定格',
    category: '冲击构成',
    applicableGenres: ['动作', '科幻', '游戏', '体育', '品牌', '通用'],
    applicableMoods: ['tense', 'exciting', 'epic'],
    applicableStyles: ['cinematic', 'sci-fi', 'sports'],
    epicLevel: 10,
    beats: [
      { t: [0.00, 0.15], phase: 'hook', visual: '画面中心一个微小能量点（火花/奇点/电弧）急速蓄能，周围空气扭曲', audio: '蓄能上升音（riser），心率式低频脉冲' },
      { t: [0.15, 0.35], phase: 'reveal', visual: '能量爆发，冲击波裹挟碎片/光屑向外扩散，慢动作', audio: '爆发瞬间全部乐器砸下+重低音 drop' },
      { t: [0.35, 0.75], phase: 'reveal', visual: '冲击波余烬在画面中心凝聚成主标题，碎片逐字拼合，副标题随后亮起', audio: '余波嗡鸣，节奏型鼓点进入' },
      { t: [0.75, 1.00], phase: 'freeze', visual: '标题在能量余晖中定格，边缘有电弧/火星明灭', audio: '鼓点急停，一记金属尾音' }
    ],
    titleSlot: '能量爆发的余烬凝聚成"{mainTitle}"，边缘电弧明灭',
    audioHint: 'riser 蓄能 + 重低音 drop + 金属尾音',
    promptTemplate: 'an energy burst explodes in slow motion, shockwave debris converges into glowing letterforms, electric arcs flickering at the edges, high-speed photography feel'
  },

  // ---------- 7. 水墨晕染型 ----------
  ink_wash: {
    id: 'ink_wash',
    name: '水墨晕染成字',
    category: '东方美学',
    applicableGenres: ['人文', '历史', '文化', '艺术', '纪录片', '通用'],
    applicableMoods: ['solemn', 'calm', 'poetic', 'tender'],
    applicableStyles: ['ink', 'documentary', 'cinematic', 'REAL'],
    epicLevel: 7,
    beats: [
      { t: [0.00, 0.22], phase: 'hook', visual: '宣纸/水面/虚空背景，一滴墨落下，涟漪扩散', audio: '一声古琴/箫单音，墨滴涟漪声' },
      { t: [0.22, 0.60], phase: 'reveal', visual: '墨色随笔触走势晕染成主标题书法字，飞白与浓淡变化真实可见', audio: '民乐旋律展开，笔触沙沙声' },
      { t: [0.60, 0.82], phase: 'reveal', visual: '副标题以小楷/印章形式落在主标题侧下方，一枚朱红印章盖下', audio: '印章落下一记沉木声' },
      { t: [0.82, 1.00], phase: 'freeze', visual: '墨迹静止，一缕墨香般的薄雾飘过，画面留白定格', audio: '余音绕梁，渐弱至静默' }
    ],
    titleSlot: '墨色晕染成书法"{mainTitle}"，飞白浓淡真实，配朱红印章',
    audioHint: '古琴/箫 + 民乐旋律 + 印章沉木声',
    promptTemplate: 'a drop of ink falls and blooms into calligraphy letterforms with realistic dry-brush textures, rice paper background, red seal stamp, negative space composition'
  },

  // ---------- 8. 机械组装型 ----------
  mechanical_assemble: {
    id: 'mechanical_assemble',
    name: '机械组装成型',
    category: '工业构成',
    applicableGenres: ['科技', '工业', '汽车', '数码', '品牌', '通用'],
    applicableMoods: ['precise', 'exciting', 'cool'],
    applicableStyles: ['sci-fi', 'tech', 'cinematic', 'REAL'],
    epicLevel: 7,
    beats: [
      { t: [0.00, 0.20], phase: 'hook', visual: '黑暗中无数精密零件（齿轮/板材/光带）悬浮待命，镜头环绕', audio: '精密机械待机嗡鸣，电子脉冲节拍' },
      { t: [0.20, 0.60], phase: 'reveal', visual: '零件逐字飞入并精密咬合组装成主标题，接缝处亮起能量光带', audio: '每次咬合一记清脆机械咔哒声，与节拍对齐' },
      { t: [0.60, 0.82], phase: 'reveal', visual: '副标题以更小的模块化方式滑入锁定', audio: '电子音阶上行' },
      { t: [0.82, 1.00], phase: 'freeze', visual: '整体锁定完成，表面光带流动一遍后定格', audio: '一记确认音效（ding/锁定声），节拍急停' }
    ],
    titleSlot: '精密零件组装成"{mainTitle}"，接缝能量光带流动',
    audioHint: '机械咔哒声 + 电子脉冲 + 确认音',
    promptTemplate: 'precision mechanical parts fly in and assemble into letterforms, seams glowing with energy light strips, macro engineering detail, dark studio environment'
  },

  // ---------- 9. 数字故障型 ----------
  glitch_digital: {
    id: 'glitch_digital',
    name: '数字故障显影',
    category: '数字美学',
    applicableGenres: ['科幻', '悬疑', '科技', '游戏', '通用'],
    applicableMoods: ['tense', 'mysterious', 'cool'],
    applicableStyles: ['sci-fi', 'tech', 'cyberpunk'],
    epicLevel: 7,
    beats: [
      { t: [0.00, 0.20], phase: 'hook', visual: '屏幕噪点/信号干扰，画面不稳定闪烁', audio: '电流杂音，信号搜索声' },
      { t: [0.20, 0.60], phase: 'reveal', visual: '主标题在 glitch 故障抖动中逐字显影（RGB分离/扫描线/像素错位后归位）', audio: '故障音效与每个字的归位同步，低音渐强' },
      { t: [0.60, 0.82], phase: 'reveal', visual: '副标题以打字机/解码方式逐字出现', audio: '打字/解码滴答声' },
      { t: [0.82, 1.00], phase: 'freeze', visual: '信号稳定，标题清晰定格，一次最终微闪', audio: '信号锁定音，静默一拍' }
    ],
    titleSlot: '"{mainTitle}"在数字故障中显影，RGB分离后归位',
    audioHint: '电流杂音 + 故障音 + 信号锁定音',
    promptTemplate: 'letterforms emerge through digital glitch effects, RGB channel separation, scanlines, pixels snapping into place, dark tech atmosphere'
  },

  // ---------- 10. 运镜揭示型 ----------
  camera_reveal: {
    id: 'camera_reveal',
    name: '运镜揭示标题',
    category: '镜头语言',
    applicableGenres: ['纪录片', '品牌', '产品', '通用'],
    applicableMoods: ['calm', 'awe', 'precise'],
    applicableStyles: ['REAL', 'cinematic', 'commercial', 'documentary'],
    epicLevel: 6,
    beats: [
      { t: [0.00, 0.30], phase: 'hook', visual: '镜头贴近一个看不清全貌的局部（材质/文字笔画局部）缓慢移动', audio: '极简钢琴/氛围音，空间感混响' },
      { t: [0.30, 0.65], phase: 'reveal', visual: '镜头持续后拉/环绕，局部逐渐显露为主标题全貌', audio: '旋律随景别扩大而展开' },
      { t: [0.65, 0.85], phase: 'reveal', visual: '副标题随镜头到位淡入', audio: '织体完整' },
      { t: [0.85, 1.00], phase: 'freeze', visual: '镜头停止运动，标题在最佳构图点定格', audio: '一记柔和收束音' }
    ],
    titleSlot: '镜头后拉揭示"{mainTitle}"全貌，构图定格',
    audioHint: '极简钢琴 + 氛围铺底 + 柔和收束',
    promptTemplate: 'camera slowly pulls back from an extreme close-up detail to reveal the full letterforms, precise composition, shallow depth of field, {environment}'
  }
};

// ============================================================
// 题材/情绪 → 模式加权索引（规则初筛用，LLM 可覆盖）
// ============================================================

const GENRE_AFFINITY = {
  '史诗': { energy_burst: 3, light_projection: 3, particle_convergence: 2, character_interaction: 2 },
  '奇幻': { particle_convergence: 3, material_crystallize: 3, character_interaction: 2, environment_growth: 1 },
  '科幻': { glitch_digital: 3, mechanical_assemble: 3, light_projection: 2, energy_burst: 2 },
  '动作': { energy_burst: 3, character_interaction: 2, mechanical_assemble: 1 },
  '悬疑': { glitch_digital: 3, light_projection: 2, camera_reveal: 2, ink_wash: 1 },
  '纪录片': { camera_reveal: 3, environment_growth: 2, light_projection: 2, particle_convergence: 1 },
  '自然': { environment_growth: 3, material_crystallize: 2, particle_convergence: 2, camera_reveal: 1 },
  '人文': { ink_wash: 3, environment_growth: 2, camera_reveal: 2 },
  '历史': { ink_wash: 3, environment_growth: 2, camera_reveal: 1 },
  '文化': { ink_wash: 3, environment_growth: 2, camera_reveal: 1 },
  '温情': { environment_growth: 3, material_crystallize: 1, camera_reveal: 2, character_interaction: 1 },
  '亲子': { character_interaction: 3, environment_growth: 2, particle_convergence: 1 },
  '动画': { character_interaction: 3, particle_convergence: 2, material_crystallize: 1 },
  '科技': { mechanical_assemble: 3, glitch_digital: 2, light_projection: 1 },
  '品牌': { light_projection: 2, particle_convergence: 2, mechanical_assemble: 2, camera_reveal: 2, energy_burst: 1 },
  '科普': { camera_reveal: 2, light_projection: 2, mechanical_assemble: 1, particle_convergence: 1 },
  '通用': { particle_convergence: 2, light_projection: 2, camera_reveal: 1, material_crystallize: 1 }
};

const MOOD_AFFINITY = {
  'epic': { energy_burst: 2, light_projection: 2, character_interaction: 1 },
  'mysterious': { light_projection: 2, particle_convergence: 2, glitch_digital: 1, material_crystallize: 1 },
  'tense': { glitch_digital: 2, energy_burst: 2, light_projection: 1 },
  'tender': { environment_growth: 2, material_crystallize: 1, camera_reveal: 1 },
  'warm': { environment_growth: 2, character_interaction: 1, camera_reveal: 1 },
  'solemn': { ink_wash: 2, light_projection: 1, camera_reveal: 1 },
  'calm': { camera_reveal: 2, environment_growth: 1, ink_wash: 1 },
  'exciting': { energy_burst: 2, mechanical_assemble: 1, character_interaction: 1 },
  'cool': { mechanical_assemble: 2, glitch_digital: 2 },
  'awe': { light_projection: 2, particle_convergence: 2, material_crystallize: 1 },
  'poetic': { ink_wash: 2, environment_growth: 1 },
  'playful': { character_interaction: 2, particle_convergence: 1 }
};

/**
 * 按题材+情绪+视觉风格初筛动效模式
 * @param {Object} ctx - { genre, mood, visualStyle }
 * @param {number} topN - 返回候选数
 * @returns {Array} [{ id, name, score, epicLevel, category }]
 */
function selectPatterns(ctx = {}, topN = 3) {
  const genre = ctx.genre || '通用';
  const mood = ctx.mood || 'epic';
  const scores = {};

  const addScores = (affinity, weight) => {
    for (const [id, s] of Object.entries(affinity || {})) {
      scores[id] = (scores[id] || 0) + s * weight;
    }
  };
  addScores(GENRE_AFFINITY[genre] || GENRE_AFFINITY['通用'], 2);
  addScores(MOOD_AFFINITY[mood], 1);

  // 视觉风格微调
  const style = String(ctx.visualStyle || '').toLowerCase();
  if (style.includes('ink') || style.includes('水墨')) scores.ink_wash = (scores.ink_wash || 0) + 3;
  if (style.includes('cyber') || style.includes('赛博')) scores.glitch_digital = (scores.glitch_digital || 0) + 3;
  if (style.includes('tech') || style.includes('科技')) scores.mechanical_assemble = (scores.mechanical_assemble || 0) + 2;

  return Object.entries(scores)
    .map(([id, score]) => {
      const p = TITLE_ANIMATION_PATTERNS[id];
      return p ? { id, name: p.name, category: p.category, score, epicLevel: p.epicLevel } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.epicLevel - a.epicLevel)
    .slice(0, topN);
}

function getPattern(id) {
  return TITLE_ANIMATION_PATTERNS[id] || null;
}

/**
 * 把动效模式的归一化节拍表换算成实际秒级节拍
 * @param {string} patternId
 * @param {number} durationSec - 片头总时长（秒）
 * @returns {Array} [{ tStart, tEnd, phase, visual, audio }]
 */
function renderPatternBeats(patternId, durationSec) {
  const p = TITLE_ANIMATION_PATTERNS[patternId];
  if (!p) return [];
  const dur = Math.max(3, Math.min(15, durationSec || 8));
  return p.beats.map(b => ({
    tStart: +(b.t[0] * dur).toFixed(1),
    tEnd: +(b.t[1] * dur).toFixed(1),
    phase: b.phase,
    visual: b.visual,
    audio: b.audio
  }));
}

/** 供 LLM prompt 注入的库摘要（控制长度） */
function buildLibrarySummary(ids = null) {
  const list = ids || Object.keys(TITLE_ANIMATION_PATTERNS);
  return list.map(id => {
    const p = TITLE_ANIMATION_PATTERNS[id];
    if (!p) return '';
    const beatLines = p.beats.map(b =>
      ` [${Math.round(b.t[0] * 100)}%-${Math.round(b.t[1] * 100)}%] ${b.phase}: ${b.visual} ‖ 音效: ${b.audio}`
    ).join('\n');
    return `【${p.id}】${p.name}（${p.category}，震撼指数${p.epicLevel}/10）\n${beatLines}\n 标题槽位: ${p.titleSlot}`;
  }).filter(Boolean).join('\n\n');
}

module.exports = {
  TITLE_ANIMATION_PATTERNS,
  GENRE_AFFINITY,
  MOOD_AFFINITY,
  selectPatterns,
  getPattern,
  renderPatternBeats,
  buildLibrarySummary
};
