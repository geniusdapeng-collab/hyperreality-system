/**
 * Light Tier / 光线档位系统（软性优化版）
 * v4.2规范编码 — 电影化光线描述
 * 
 * 优化内容：getLightTierPrompt()输出电影化描述，融入颗粒感、物理模拟、情绪张力
 * 调用子系统：light-tier系统自身优化
 * 优化日期：2026-07-15
 * 约束：数据结构不变、接口契约不变、文件结构不变
 */

const LightTier = {
  A: {
    name: '明亮探索',
    nameEn: 'Bright Exploration',
    colorTemp: '5600K',
    contrastRatio: '2:1',
    description: '明亮探索 - 均匀照明，低反差，适合展示环境细节',
    // 【优化新增】电影化描述：用于融入prompt的画面质感表达
    cinematicDescription: 'soft diffused daylight filtering through atmosphere, gentle shadows with gradual falloff, natural skin tones under even illumination, subtle volumetric haze catching light particles',
    usage: '探索、发现、儿童向友好镜头',
    examples: ['S00星渊初临', 'S01荧光平原']
  },
  B: {
    name: '神秘低照',
    nameEn: 'Mystery Low-Key',
    colorTemp: '3200-4000K',
    contrastRatio: '4:1',
    description: '神秘低照 - 局部照明，中等反差，营造悬疑氛围',
    // 【优化新增】电影化描述
    cinematicDescription: 'single source key light creating dramatic shadow pools, undefined darkness in peripheral vision, selective illumination drawing eye to mystery, cool blue undertones in shadow areas',
    usage: '未知、悬疑、逼近前夜',
    examples: ['S02深渊初遇']
  },
  C: {
    name: '对抗高反差',
    nameEn: 'Contrast Drama',
    colorTemp: '混合色温',
    contrastRatio: '8:1+',
    description: '对抗高反差 - 强烈明暗对比，高反差，突出冲突',
    // 【优化新增】电影化描述
    cinematicDescription: 'hard directional light carving sharp shadow edges, deep blacks swallowing detail, bright highlights clipping to pure white, chiaroscuro effect with stark tonal separation, sweat and skin texture catching harsh light',
    usage: '冲突、觉醒、威压',
    examples: ['S03古战对决']
  },
  D: {
    name: '神圣显现',
    nameEn: 'Divine Manifestation',
    colorTemp: '非现实色温(金/青)',
    contrastRatio: '16:1+',
    description: '神圣显现 - 极端照明，史诗感，超现实色温',
    // 【优化新增】电影化描述
    cinematicDescription: 'golden god-rays piercing through atmospheric density, ethereal rim light separating subject from darkness, impossible color temperature mixing warm amber with cold cyan, lens flare adding organic imperfection, divine luminescence radiating from subject',
    usage: '显灵、启示、史诗瞬间',
    examples: ['S04星陨终章']
  }
};

// 光线档位验证（原有逻辑完全保持不变）
function validateLightTier(tier) {
  return LightTier[tier] || null;
}

/**
 * 生成光线Prompt片段（优化版：电影化描述）
 * 优化点：在保留技术参数的基础上，增加电影感光线描述，融入颗粒感和物理模拟
 */
function getLightTierPrompt(tier) {
  const t = LightTier[tier];
  if (!t) return '';

  // 【优化】返回电影化光线描述，包含技术参数+电影感表达+画面真实感修饰
  const parts = [];

  // 基础技术参数（保留原有信息）
  parts.push(`${t.nameEn} lighting`);
  parts.push(`${t.colorTemp}`);
  parts.push(`${t.contrastRatio} contrast ratio`);

  // 【优化新增】电影化光线描述（从cinematicDescription获取）
  if (t.cinematicDescription) {
    parts.push(t.cinematicDescription);
  }

  // 【优化新增】画面真实感修饰词（颗粒感+物理模拟+情绪张力）
  const realismModifiers = [
    'natural light falloff',
    'physical light simulation',
    'subtle film grain',
    'atmospheric haze'
  ];

  // 根据档位选择不同的真实感修饰
  if (tier === 'A') {
    parts.push('soft diffusion, clean shadows, photorealistic skin rendering');
  } else if (tier === 'B') {
    parts.push('practical light sources, motivated lighting, shadow mystery');
  } else if (tier === 'C') {
    parts.push('hard shadows, sweat texture, clenched muscle highlights, tension in light');
  } else if (tier === 'D') {
    parts.push('volumetric god rays, lens flare, ethereal glow, transcendent luminosity');
  }

  // 统一添加物理模拟修饰
  parts.push(...realismModifiers.slice(0, 2));

  return parts.join(', ');
}

/**
 * 【优化新增】获取纯电影化描述（不含技术参数，用于融入prompt的特定位置）
 * 优化点：提供独立的电影感光线描述，可用于scene或atmosphere字段
 */
function getCinematicLightDescription(tier) {
  const t = LightTier[tier];
  if (!t || !t.cinematicDescription) return '';

  // 返回纯电影化描述+情绪张力表达
  const emotionalTension = {
    'A': 'quiet curiosity, gentle wonder, safe exploration',
    'B': 'growing unease, lurking uncertainty, whispered secrets',
    'C': 'raw confrontation, visceral tension, primal struggle',
    'D': 'transcendent awe, cosmic revelation, breathless wonder'
  };

  const tension = emotionalTension[tier] || '';
  return `${t.cinematicDescription}, ${tension}`;
}

/**
 * 【优化新增】获取光线情绪张力描述
 * 优化点：为每个档位提供情绪张力表达，用于融入prompt的情绪层
 */
function getLightEmotionalTension(tier) {
  const tension = {
    'A': 'gentle warmth inviting exploration, soft comfort encouraging curiosity',
    'B': 'cold uncertainty raising hairs, shadowed corners hiding unknowns',
    'C': 'harsh reality cutting through illusion, stark truth revealed in hard light',
    'D': 'otherworldly presence overwhelming senses, divine beauty arresting breath'
  };
  return tension[tier] || '';
}

// 根据场景类型推荐光线档位（原有逻辑完全保持不变）
function recommendLightTier(sceneType, mood) {
  const mapping = {
    'opening': 'A',
    'exploration': 'A',
    'discovery': 'A',
    'suspense': 'B',
    'mystery': 'B',
    'confrontation': 'C',
    'combat': 'C',
    'climax': 'D',
    'revelation': 'D',
    'resolution': 'A'
  };

  return mapping[sceneType] || mapping[mood] || 'A';
}

module.exports = {
  LightTier,
  validateLightTier,
  getLightTierPrompt,
  getCinematicLightDescription, // 【优化新增】导出电影化描述函数
  getLightEmotionalTension, // 【优化新增】导出情绪张力函数
  recommendLightTier
};
