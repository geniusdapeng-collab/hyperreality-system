/**
 * 通用字体排印设计引擎 v1.0 — opening-cinematic
 *
 * 泛化自 astralis-title-typography-engine（原引擎锁死 Nirath 磁流体世界观）。
 * 以四个正交维度描述片头标题字体：
 * structure（字形结构）× material（材质具现）× lighting（光照交互）× motion（动态质感）
 *
 * 输出：
 * - spec: 结构化字体规范（后期/设计可用）
 * - promptText: 可直接进渲染 prompt 的中英双语描述
 * - forbidden: 该风格的禁忌项（进负面提示词）
 *
 * @module opening-cinematic/typography-designer
 * @version 1.0.0
 */

// ============================================================
// 维度一：字形结构
// ============================================================
const STRUCTURES = {
  elegant_serif: {
    name: '优雅衬线',
    cn: '衬线字体，笔画纤细有呼吸感，衬线末端有精致的收笔',
    en: 'elegant serif typeface, thin strokes with breathing room, refined tapered serifs',
    traits: ['字间距略宽', '衬线收笔精致', '整体气质：高级、叙事、电影感'],
    forbidden: ['卡通', '圆润', '涂鸦', '像素']
  },
  geometric_sans: {
    name: '几何无衬线',
    cn: '几何无衬线字体，笔画粗细均匀，结构精准，现代感强',
    en: 'geometric sans-serif, uniform stroke weight, precise construction, modern',
    traits: ['笔画均匀', '结构精准', '整体气质：科技、理性、清晰'],
    forbidden: ['手写', '书法', '有机曲线']
  },
  bold_display: {
    name: '粗重展示体',
    cn: '粗重展示字体，笔画饱满，视觉冲击力强，字怀紧凑',
    en: 'bold display typeface, full heavy strokes, tight counters, high impact',
    traits: ['笔画饱满', '字怀紧凑', '整体气质：力量、冲击、直接'],
    forbidden: ['纤细', '轻盈', '优雅']
  },
  calligraphy: {
    name: '书法手写字',
    cn: '书法字体，毛笔笔触，飞白与浓淡变化真实，有书写温度',
    en: 'calligraphy brush lettering, realistic dry-brush textures and ink gradation',
    traits: ['笔触真实', '飞白可见', '整体气质：人文、温度、东方'],
    forbidden: ['机械', '几何', '霓虹', '像素']
  },
  rounded_hand: {
    name: '圆润手写体',
    cn: '圆润手写体，笔画圆头圆脑，亲切活泼，略带不规则的稚拙感',
    en: 'rounded handwritten style, soft round terminals, friendly and playful',
    traits: ['圆润亲切', '略带稚拙', '整体气质：温暖、亲子、生活'],
    forbidden: ['冷峻', '锐利', '重金属']
  },
  stencil_tech: {
    name: '工业漏印体',
    cn: '工业漏印/机甲字体，笔画有切口和模块化分段，硬核工业感',
    en: 'stencil/mecha typeface, cut segments and modular strokes, industrial',
    traits: ['笔画切口', '模块分段', '整体气质：硬核、工业、军事'],
    forbidden: ['优雅', '手写', '水墨']
  }
};

// ============================================================
// 维度二：材质具现
// ============================================================
const MATERIALS = {
  polished_metal: {
    name: '抛光金属',
    cn: '抛光金属表面，拉丝纹理，反射环境光，边缘有高光描边',
    en: 'polished metal surface, brushed texture, environment reflections, rim highlights',
    interaction: '反射周围光源，移动时有真实的环境反射变化'
  },
  glass_crystal: {
    name: '玻璃水晶',
    cn: '半透明玻璃/水晶材质，内部折射，边缘有菲涅尔亮光',
    en: 'translucent glass/crystal, internal refraction, fresnel edge glow',
    interaction: '光线穿透产生折射光斑，角度变化时色彩微移'
  },
  ember_flame: {
    name: '余烬火焰',
    cn: '炽热余烬材质，核心高亮，边缘火星明灭，有热浪扭曲',
    en: 'glowing ember material, hot bright core, flickering sparks at edges, heat distortion',
    interaction: '火星缓慢飘散，亮度随情绪节奏呼吸'
  },
  ink_paper: {
    name: '墨色宣纸',
    cn: '墨色渗入宣纸纤维，边缘有洇开痕迹，浓淡干湿真实',
    en: 'ink absorbed into rice paper fibers, bleeding edges, realistic wet-dry gradation',
    interaction: '墨色有永恒的微观沉淀感'
  },
  neon_tube: {
    name: '霓虹灯管',
    cn: '霓虹灯管发光，玻璃管壁有厚度，光晕在墙面有彩色溢光',
    en: 'neon tube glow, glass tube thickness, colored light spill on surroundings',
    interaction: '轻微电流闪烁，光晕随电流脉动'
  },
  stone_carve: {
    name: '石质雕刻',
    cn: '石材雕刻质感，凿痕与风化纹理，凹槽内有阴影与苔藓/尘埃',
    en: 'carved stone texture, chisel marks and weathering, shadowed grooves with dust',
    interaction: '侧光照射时凿痕产生强烈立体感'
  },
  hologram: {
    name: '全息投影',
    cn: '半透明全息投影，扫描线纹理，边缘有RGB色差和轻微抖动',
    en: 'semi-transparent hologram, scanline texture, RGB fringe and subtle jitter',
    interaction: '投影有轻微闪烁与信号波动'
  },
  paper_cut: {
    name: '纸张剪影',
    cn: '纸张剪切/立体纸雕质感，边缘干净，层叠有柔和投影',
    en: 'paper-cut / layered papercraft, clean edges, soft layered shadows',
    interaction: '层与层之间有柔和的接触阴影'
  }
};

// ============================================================
// 维度三：光照交互
// ============================================================
const LIGHTINGS = {
  rim_gold: { name: '金色轮廓光', cn: '边缘有暖金色轮廓光勾勒', en: 'warm golden rim light outlining the letterforms' },
  backlit: { name: '逆光剪影', cn: '背光逆光，字体呈剪影，边缘透光', en: 'backlit silhouette, light bleeding through the edges' },
  inner_glow: { name: '内发光', cn: '字体内部发光，亮度均匀柔和', en: 'soft inner glow emanating from within the letters' },
  projection: { name: '投影光', cn: '字体如被投影机投射，光中可见尘埃', en: 'projected light, dust particles visible in the beam' },
  dual_tone: { name: '双色温', cn: '主光暖色+辅光冷色，立体感强', en: 'dual-tone lighting, warm key with cool fill, strong dimensionality' },
  ambient_soft: { name: '柔光环境', cn: '柔和环境光，低对比，无硬阴影', en: 'soft ambient light, low contrast, no hard shadows' },
  dramatic_spot: { name: '戏剧聚光', cn: '戏剧性聚光灯，背景压暗，高对比', en: 'dramatic spotlight, darkened background, high contrast' }
};

// ============================================================
// 维度四：动态质感
// ============================================================
const MOTIONS = {
  stable: { name: '稳定定格', cn: '成型后完全稳定，庄重感', en: 'fully stable once formed, dignified stillness' },
  breathing: { name: '呼吸明灭', cn: '亮度以4秒周期缓慢呼吸明灭', en: 'brightness breathes slowly in a 4-second cycle' },
  particle_shed: { name: '粒子溢出', cn: '边缘持续溢出微小粒子，缓慢飘散', en: 'tiny particles continuously shed from the edges and drift away' },
  micro_flow: { name: '微观流动', cn: '表面有永恒的微观流光/涟漪', en: 'eternal micro-flow of light across the surface' },
  flicker: { name: '轻微闪烁', cn: '轻微电流/火焰式闪烁', en: 'subtle electric/flame flicker' }
};

// ============================================================
// 题材/情绪 → 推荐组合（规则初筛）
// ============================================================
const GENRE_PRESETS = {
  '史诗': { structure: 'elegant_serif', material: 'polished_metal', lighting: 'rim_gold', motion: 'micro_flow' },
  '奇幻': { structure: 'elegant_serif', material: 'glass_crystal', lighting: 'inner_glow', motion: 'particle_shed' },
  '科幻': { structure: 'geometric_sans', material: 'hologram', lighting: 'dual_tone', motion: 'flicker' },
  '动作': { structure: 'bold_display', material: 'ember_flame', lighting: 'dramatic_spot', motion: 'flicker' },
  '悬疑': { structure: 'geometric_sans', material: 'polished_metal', lighting: 'backlit', motion: 'stable' },
  '纪录片': { structure: 'geometric_sans', material: 'stone_carve', lighting: 'ambient_soft', motion: 'stable' },
  '自然': { structure: 'elegant_serif', material: 'stone_carve', lighting: 'ambient_soft', motion: 'stable' },
  '人文': { structure: 'calligraphy', material: 'ink_paper', lighting: 'ambient_soft', motion: 'micro_flow' },
  '历史': { structure: 'calligraphy', material: 'stone_carve', lighting: 'dual_tone', motion: 'stable' },
  '温情': { structure: 'rounded_hand', material: 'paper_cut', lighting: 'ambient_soft', motion: 'breathing' },
  '亲子': { structure: 'rounded_hand', material: 'paper_cut', lighting: 'ambient_soft', motion: 'breathing' },
  '动画': { structure: 'rounded_hand', material: 'paper_cut', lighting: 'inner_glow', motion: 'breathing' },
  '科技': { structure: 'geometric_sans', material: 'hologram', lighting: 'dual_tone', motion: 'micro_flow' },
  '品牌': { structure: 'geometric_sans', material: 'polished_metal', lighting: 'rim_gold', motion: 'micro_flow' },
  '科普': { structure: 'geometric_sans', material: 'glass_crystal', lighting: 'ambient_soft', motion: 'stable' },
  '通用': { structure: 'geometric_sans', material: 'polished_metal', lighting: 'dual_tone', motion: 'stable' }
};

/**
 * 生成字体设计规范
 * @param {Object} ctx - { genre, mood, override: {structure, material, lighting, motion} }
 * @returns {Object} { spec, promptText, promptTextEn, forbidden }
 */
function designTypography(ctx = {}) {
  const preset = GENRE_PRESETS[ctx.genre] || GENRE_PRESETS['通用'];
  const o = ctx.override || {};
  const structure = STRUCTURES[o.structure || preset.structure];
  const material = MATERIALS[o.material || preset.material];
  const lighting = LIGHTINGS[o.lighting || preset.lighting];
  const motion = MOTIONS[o.motion || preset.motion];

  const spec = {
    structure: o.structure || preset.structure,
    material: o.material || preset.material,
    lighting: o.lighting || preset.lighting,
    motion: o.motion || preset.motion,
    names: {
      structure: structure.name, material: material.name,
      lighting: lighting.name, motion: motion.name
    }
  };

  const promptText = [
    `字体：${structure.cn}`,
    `材质：${material.cn}`,
    `光照：${lighting.cn}`,
    `动态：${motion.cn}`,
    `细节：${material.interaction}`
  ].join('；');

  const promptTextEn = [
    structure.en, material.en, lighting.en, motion.en
  ].join(', ');

  return {
    spec,
    promptText,
    promptTextEn,
    forbidden: structure.forbidden || []
  };
}

/** 供 LLM prompt 注入的库摘要 */
function buildTypographySummary() {
  const line = (obj) => Object.entries(obj).map(([id, v]) => `${id}(${v.name})`).join(' / ');
  return [
    `字形结构: ${line(STRUCTURES)}`,
    `材质具现: ${line(MATERIALS)}`,
    `光照交互: ${line(LIGHTINGS)}`,
    `动态质感: ${line(MOTIONS)}`
  ].join('\n');
}

module.exports = {
  STRUCTURES, MATERIALS, LIGHTINGS, MOTIONS,
  GENRE_PRESETS,
  designTypography,
  buildTypographySummary
};
