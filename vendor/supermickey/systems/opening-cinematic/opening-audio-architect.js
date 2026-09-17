/**
 * 片头音效架构引擎 v1.0 — opening-cinematic
 *
 * 泛化自山海经体系的声音设计经验（人声签名/震撼音效视觉暗示/节拍同步）。
 * 把片头音效从"bgm + sound_effects 两个字段"升级为五层架构 + 秒级同步表：
 *
 * L1 signature 品牌/角色声音签名（0-1s，第一帧就抓耳朵）
 * L2 bed 氛围铺底（情绪基调，全程）
 * L3 rhythm 节奏驱动（鼓点/脉冲，与视觉节拍对齐）
 * L4 sfx 动作音效（与画面事件一一对应）
 * L5 resolve 收束与过渡（静默拍/尾音，交棒给正片）
 *
 * 输出：分层音效方案 + 与画面节拍逐秒对齐的 sync_map
 *
 * @module opening-cinematic/opening-audio-architect
 * @version 1.0.0
 */

// ============================================================
// 情绪 → 音色配置
// ============================================================
const MOOD_SONICS = {
  epic: {
    bed: '低频弦乐群 drone + 远雷声般的空间混响',
    rhythm: '定音鼓与大鼓的心跳式脉冲，60-72BPM',
    instruments: ['定音鼓', '低音弦乐', '铜管', '合唱'],
    signatureHint: '金属轰鸣或铜管齐鸣，庄严宣告感'
  },
  mysterious: {
    bed: '气声合成器 pad + 高频泛音铃音，若有若无',
    rhythm: '不规则的滴答/水滴声，制造不确定感',
    instruments: ['钢片琴', '水琴', '气声pad', '低音单簧管'],
    signatureHint: '一声远处传来的未知回响（鲸鸣/风铃/低语）'
  },
  tense: {
    bed: '不和谐弦乐震音 + 低频脉冲',
    rhythm: '逐渐加速的电子脉冲，心率感',
    instruments: ['弦乐震音', '电子脉冲', '低音鼓'],
    signatureHint: '一记骤停式的静默前噪音（所有声音瞬间抽空）'
  },
  tender: {
    bed: '温暖钢琴分解和弦 + 弦乐弱音器铺底',
    rhythm: '无鼓点，以钢琴节奏型自然流动',
    instruments: ['钢琴', '弦乐四重奏', '木吉他', '八音盒'],
    signatureHint: '一声生活化的真实声音（笑声/开门声/鸟叫）'
  },
  warm: {
    bed: '木吉他与弦乐的温暖织体，日光感',
    rhythm: '轻刷镲与贝斯的悠闲律动',
    instruments: ['木吉他', '贝斯', '弦乐', '口琴'],
    signatureHint: '自然环境声（清晨鸟鸣/壁炉柴火/风铃）'
  },
  exciting: {
    bed: '电子低音 + 摇滚鼓组的高能量铺底',
    rhythm: '120+BPM 鼓组驱动，切分节奏',
    instruments: ['电吉他', '鼓组', '合成贝斯', '铜管stabs'],
    signatureHint: '引擎轰鸣/人群欢呼/一记鼓组齐砸'
  },
  solemn: {
    bed: '管风琴或大提琴独奏的庄严长音',
    rhythm: '极慢的仪式性鼓点或完全无鼓',
    instruments: ['管风琴', '大提琴', '合唱', '编钟'],
    signatureHint: '一记编钟/大锣的庄严鸣响，余韵悠长'
  },
  calm: {
    bed: '极简钢琴单音 + 环境白噪音（风/水/林）',
    rhythm: '无鼓点，呼吸式自然节奏',
    instruments: ['钢琴', '环境声', '长笛'],
    signatureHint: '一声纯净的单乐器音符（风铃/水滴/琴键）'
  },
  cool: {
    bed: '极简电子 pad + 低频 sub-bass',
    rhythm: '精准电子节拍，机械感',
    instruments: ['合成器', 'sub-bass', '电子鼓机'],
    signatureHint: '一记数字确认音/UI音效的未来感设计音'
  },
  awe: {
    bed: '合唱与弦乐的渐强铺底，空间混响极大',
    rhythm: '渐强式推进，无固定节拍',
    instruments: ['合唱', '弦乐', '铜管', '竖琴'],
    signatureHint: '竖琴刮奏+合唱渐起，如光破开'
  }
};

// ============================================================
// 声音签名设计
// ============================================================

/**
 * 设计品牌/角色声音签名
 * @param {Object} ctx - { mood, character, theme, hasVoice }
 */
function designSignature(ctx = {}) {
  const sonics = MOOD_SONICS[ctx.mood] || MOOD_SONICS.epic;
  const parts = [];

  // 第一帧声音钩子
  parts.push({
    layer: 'L1-signature',
    tStart: 0,
    tEnd: 1.0,
    content: `声音签名：${sonics.signatureHint}`,
    purpose: '第一帧抓住注意力，建立本片/本系列听觉识别度'
  });

  // 角色声音签名（可选）
  if (ctx.hasVoice && ctx.character) {
    parts.push({
      layer: 'L1-voice',
      tStart: 0.5,
      tEnd: 2.0,
      content: `角色声音签名：${ctx.character} 的标志性发声（一句话/一声鸣叫/一段笑声），与画面同步`,
      purpose: '角色未完全现身前，先用声音建立存在感'
    });
  }

  return parts;
}

/**
 * 生成完整五层音效方案 + 与画面节拍同步表
 * @param {Object} ctx - { mood, durationSec, beats, character, hasVoice }
 * beats: 画面节拍数组 [{ tStart, tEnd, phase, visual }]
 * @returns {Object} { layers, syncMap, mixingNotes }
 */
function designAudio(ctx = {}) {
  const mood = ctx.mood || 'epic';
  const sonics = MOOD_SONICS[mood] || MOOD_SONICS.epic;
  const dur = Math.max(3, Math.min(15, ctx.durationSec || 8));
  const beats = Array.isArray(ctx.beats) ? ctx.beats : [];

  // ---- 五层结构 ----
  const layers = [
    ...designSignature(ctx),
    {
      layer: 'L2-bed',
      tStart: 0,
      tEnd: dur,
      content: `氛围铺底：${sonics.bed}`,
      purpose: '建立情绪基调，贯穿全程'
    },
    {
      layer: 'L3-rhythm',
      tStart: +(dur * 0.2).toFixed(1),
      tEnd: +(dur * 0.85).toFixed(1),
      content: `节奏驱动：${sonics.rhythm}`,
      purpose: '与视觉节拍对齐，推动能量曲线'
    },
    {
      layer: 'L4-sfx',
      tStart: 0,
      tEnd: dur,
      content: '动作音效：与每个画面事件一一对应（见同步表）',
      purpose: '让画面事件"听得见"，增强真实感与冲击力'
    },
    {
      layer: 'L5-resolve',
      tStart: +(dur * 0.85).toFixed(1),
      tEnd: dur,
      content: '收束与过渡：音乐在最后一拍收束或骤停，留 0.3-0.5 秒静默拍，随后正片声音淡入',
      purpose: '给正片让位，制造"交接棒"的呼吸感'
    }
  ];

  // ---- 秒级同步表：把画面节拍翻译成音效事件 ----
  const syncMap = beats.map(b => {
    const phaseSfx = {
      hook: `悬念音效起（${sonics.signatureHint}），铺底渐入`,
      reveal: `动作音效与画面对齐（材质/运动/文字成形声），节奏层推进`,
      freeze: `一记收束音（金属尾音/鼓点急停/余韵），留静默拍`
    };
    return {
      tStart: b.tStart,
      tEnd: b.tEnd,
      phase: b.phase,
      visualEvent: (b.visual || '').slice(0, 60),
      audioEvent: phaseSfx[b.phase] || phaseSfx.reveal
    };
  });

  // ---- 混音提示 ----
  const mixingNotes = [
    `主奏乐器建议：${sonics.instruments.join('、')}`,
    '音效视觉暗示原则：画面中看不到声源时，用画面震颤/共鸣波纹/尘埃跳动做视觉呼应',
    '响度曲线：hook(70%) → reveal(100%) → freeze(60%) → 静默拍(0%)',
    '品牌一致性：signature 层应在系列各集中保持同一动机/音色'
  ];

  return { layers, syncMap, mixingNotes, mood };
}

/** 供 LLM prompt 注入的音效库摘要 */
function buildAudioSummary() {
  return Object.entries(MOOD_SONICS)
    .map(([mood, s]) => `${mood}: 铺底=${s.bed}｜节奏=${s.rhythm}｜签名=${s.signatureHint}`)
    .join('\n');
}

module.exports = {
  MOOD_SONICS,
  designSignature,
  designAudio,
  buildAudioSummary
};
