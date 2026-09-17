// systems/continuity-manager.js
// Continuity Mode / 连续性模式
// v4.1规范编码

const ContinuityMode = {
  strict: {
    name: '严格连续',
    nameEn: 'Strict Continuity',
    description: '使用前镜尾帧或高度接近状态作为下镜起点',
    usage: '连续动作、连续表演、动作衔接',
    tech: 'first_frame / last_frame 绑定',
    requirements: ['前镜尾帧截图', '角色姿态匹配', '光线状态延续']
  },
  soft: {
    name: '软性连续',
    nameEn: 'Soft Continuity',
    description: '延续角色状态/光线/空间逻辑，不强制同构图',
    usage: '多数常规叙事镜（默认）',
    tech: '角色锚点 + Light Tier 延续',
    requirements: ['角色状态一致', '光线档位一致', '空间逻辑合理'],
    default: true
  },
  none: {
    name: '无连续',
    nameEn: 'No Continuity',
    description: '仅保持叙事连贯，不要求帧级连续',
    usage: '时空切换、建立镜、跳切、转场',
    tech: '无特殊技术绑定',
    requirements: ['叙事逻辑连贯']
  }
};

// 连续性优先级（从重要到次要）
const ContinuityPriority = [
  '叙事连续',
  '角色连续',
  '空间连续',
  '光线连续',
  '构图连续'
];

// 验证连续性要求
function validateContinuity(prevShot, nextShot, mode = 'soft') {
  const checks = {
    narrative: true, // 叙事连续默认通过
    character: false,
    space: false,
    light: false,
    composition: false
  };
  
  // 角色连续性检查
  if (prevShot.characters && nextShot.characters) {
    checks.character = prevShot.characters.some(c => nextShot.characters.includes(c));
  }
  
  // 空间连续性检查
  if (prevShot.location && nextShot.location) {
    checks.space = prevShot.location === nextShot.location || 
                   prevShot.location.includes(nextShot.location) ||
                   nextShot.location.includes(prevShot.location);
  }
  
  // 光线连续性检查
  if (prevShot.lightTier && nextShot.lightTier) {
    checks.light = prevShot.lightTier === nextShot.lightTier;
  }
  
  // 构图连续性检查（仅在strict模式下检查）
  if (mode === 'strict' && prevShot.efa && nextShot.ofa) {
    checks.composition = prevShot.efa === nextShot.ofa;
  }
  
  return checks;
}

module.exports = { ContinuityMode, ContinuityPriority, validateContinuity };
