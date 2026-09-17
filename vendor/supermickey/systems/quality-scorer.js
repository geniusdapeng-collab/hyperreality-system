// systems/quality-scorer.js
// Five-Dimension Quality Scorer / 五维质量评分器
// v4.1规范编码

const QualityDimension = {
  readability: {
    name: '可读性',
    nameEn: 'Readability',
    weight: 0.25,
    description: '主体、动作、空间是否一眼可辨',
    criteria: '3秒内识别主体和动作',
    checkList: [
      '主体是否清晰可辨',
      '主动作是否明确',
      '空间关系是否易懂',
      '是否有视觉干扰'
    ]
  },
  controllability: {
    name: '可控性',
    nameEn: 'Controllability',
    weight: 0.20,
    description: '是否易于生成稳定结果',
    criteria: '参考历史成功率与风险点',
    checkList: [
      'Prompt是否清晰无歧义',
      '是否包含过多抽象描述',
      '是否有已知的失败风险',
      'Fallback是否可预期'
    ]
  },
  editability: {
    name: '可剪性',
    nameEn: 'Editability',
    weight: 0.20,
    description: '是否方便接前后镜头',
    criteria: '落幅锚点清晰，转场意图明确',
    checkList: [
      '落幅锚点(EFA)是否清晰',
      '起幅锚点(OFA)是否明确',
      '转场意图是否可执行',
      '节奏是否符合场次要求'
    ]
  },
  emotionHit: {
    name: '情绪命中率',
    nameEn: 'Emotion Hit Rate',
    weight: 0.20,
    description: '是否准确传达预期情绪',
    criteria: '与Scene Card情绪目标对比',
    checkList: [
      '情绪目标是否明确',
      '视觉元素是否支持情绪',
      '光影是否匹配情绪',
      '是否有情绪冲突'
    ]
  },
  memorability: {
    name: '记忆点',
    nameEn: 'Memorability',
    weight: 0.15,
    description: '是否有鲜明视觉钩子',
    criteria: '是否有"一眼难忘"元素',
    checkList: [
      '是否有独特视觉元素',
      '是否有系列标志性画面',
      '是否区别于普通镜头',
      '是否有情感共鸣点'
    ]
  }
};

// 评分等级
const ScoreGrade = {
  excellent: { min: 90, max: 100, label: '优秀', action: '直接通过，可作为系列标杆' },
  good: { min: 75, max: 89, label: '良好', action: '通过，记录优化建议' },
  pass: { min: 60, max: 74, label: '合格', action: '需修改后复审' },
  fail: { min: 40, max: 59, label: '不合格', action: '需重写Shot Card和Prompt' },
  block: { min: 0, max: 39, label: '阻断', action: '退回重新设计，不得渲染' }
};

// 计算五维评分
function calculateFiveDimensionScore(dimensions) {
  // dimensions = { readability: 85, controllability: 70, editability: 90, emotionHit: 80, memorability: 75 }
  const scores = {};
  let totalWeight = 0;
  let weightedSum = 0;
  
  for (const [key, value] of Object.entries(dimensions)) {
    const dim = QualityDimension[key];
    if (dim) {
      scores[key] = {
        score: value,
        weight: dim.weight,
        weighted: value * dim.weight
      };
      totalWeight += dim.weight;
      weightedSum += value * dim.weight;
    }
  }
  
  const totalScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  const grade = getGrade(totalScore);
  
  return {
    totalScore,
    grade,
    dimensions: scores,
    passed: totalScore >= 60,
    canRender: totalScore >= 75
  };
}

// 获取等级
function getGrade(score) {
  for (const [key, value] of Object.entries(ScoreGrade)) {
    if (score >= value.min && score <= value.max) {
      return { key, ...value };
    }
  }
  return ScoreGrade.block;
}

// 生成评分报告
function generateScoreReport(shotId, dimensions) {
  const result = calculateFiveDimensionScore(dimensions);
  
  return {
    shotId,
    timestamp: new Date().toISOString(),
    ...result,
    summary: `${shotId}: 总分${result.totalScore}(${result.grade.label}) - ${result.grade.action}`
  };
}

// 阻断条件检查（硬阻断）
const BlockConditions = [
  { id: 'no-subject', check: (shot) => !shot.subject, description: '主视觉中心不明确' },
  { id: 'multiple-actions', check: (shot) => shot.actions && shot.actions.length > 1, description: '多个动作竞争' },
  { id: 'camera-action-conflict', check: (shot) => shot.cameraConflict, description: '运镜与动作冲突' },
  { id: 'missing-anchors', check: (shot) => !shot.ofa || !shot.efa, description: '起幅/落幅缺失' },
  { id: 'multi-character-confusion', check: (shot) => shot.characters && shot.characters.length > 3 && !shot.primaryCharacter, description: '多角色同权重混乱' },
  { id: 'binding-incomplete', check: (shot) => shot.characters && shot.characters.some(c => !c.portrait), description: '角色绑定不完整' },
  { id: 'edit-unfriendly', check: (shot) => shot.editDifficulty === 'high', description: '明显不利于剪辑衔接' },
  { id: 'direction-invalid', check: (shot) => shot.screenDirection && shot.nextScreenDirection && shot.screenDirection === shot.nextScreenDirection, description: '屏幕方向或视线接续逻辑不成立' },
  { id: 'system-violation', check: (shot) => shot.violations && shot.violations.length > 0, description: '违反系统约束或内容安全规范' }
];

// 检查阻断条件
function checkBlockConditions(shot) {
  const blocks = [];
  
  for (const condition of BlockConditions) {
    if (condition.check(shot)) {
      blocks.push({
        id: condition.id,
        description: condition.description
      });
    }
  }
  
  return {
    blocked: blocks.length > 0,
    blocks,
    canProceed: blocks.length === 0
  };
}

module.exports = {
  QualityDimension,
  ScoreGrade,
  calculateFiveDimensionScore,
  generateScoreReport,
  checkBlockConditions
};
