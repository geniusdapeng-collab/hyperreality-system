// systems/shot-priority.js
// Shot Priority / 镜头优先级系统
// v4.1规范编码

const ShotPriority = {
  P1: { 
    name: '叙事核心镜', 
    nameEn: 'Story Critical', 
    strategy: '最高测试与重试预算',
    description: '承载核心叙事信息，不可或缺',
    budget: 'high',
    retryCount: 3
  },
  P2: { 
    name: '情绪关键镜', 
    nameEn: 'Emotion Critical', 
    strategy: '中高预算',
    description: '承载关键情绪转折，影响观众感受',
    budget: 'medium-high',
    retryCount: 2
  },
  P3: { 
    name: '视觉标志镜', 
    nameEn: 'Visual Signature', 
    strategy: '允许更高分辨率',
    description: '系列标志性视觉，需要高保真',
    budget: 'high',
    retryCount: 3
  },
  P4: { 
    name: '功能连接镜', 
    nameEn: 'Utility Shot', 
    strategy: '控制成本，追求稳定',
    description: '连接叙事，保证流畅',
    budget: 'medium',
    retryCount: 1
  },
  P5: { 
    name: '可替代镜', 
    nameEn: 'Replaceable', 
    strategy: '低预算，必要时删改',
    description: '可删减或替代，不影响核心叙事',
    budget: 'low',
    retryCount: 1
  }
};

// 从镜头类型映射到优先级
function getPriorityFromType(type) {
  const mapping = {
    'opening': 'P1',
    'hero': 'P3',
    'building': 'P2',
    'close': 'P2',
    'establishing': 'P4',
    'insert': 'P5',
    'transition': 'P4',
    'climax': 'P1',
    'resolution': 'P2'
  };
  
  return mapping[type] || 'P4';
}

// 获取优先级配置
function getPriorityConfig(priority) {
  return ShotPriority[priority] || ShotPriority['P4'];
}

module.exports = { ShotPriority, getPriorityFromType, getPriorityConfig };
