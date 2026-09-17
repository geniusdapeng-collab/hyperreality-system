/**
 * 空间增强 Agent v1.0 (Stage 11.5)
 * Space Enhancer Agent
 * 
 * 定位：在 Stage 11 (PromptForge) 之后，Stage 12 之前执行
 * 作用：专门优化【空间】字段内容，使其更饱满、个性化、与镜头主题强相关
 * 
 * 输入：Stage 11 生成的完整提示词数组 + PRD + 用户原始需求
 * 输出：每个镜头重写后的【空间】字段（五维空间描述）
 */

const SPACE_ENHANCER_VERSION = 'v1.0';

// ═══════════════════════════════════════════════════════════
// 空间描述模板库
// ═══════════════════════════════════════════════════════════

const SPACE_TEMPLATES = {
  // 医疗科普场景
  medical: {
    base: '专业医疗环境',
    elements: [
      '现代化诊疗空间，墙面悬挂人体肌肉解剖全息投影图，可见肾脏结构三维模型悬浮展示',
      '真实医疗诊室，背景可见血液分析仪、离心机等检验设备运转指示灯微亮',
      '健康科普宣教室，墙面布置运动医学知识展板，可见肾脏保健科普海报',
      '临床检验科室，背景陈列尿液分析样本架与肌酸激酶检测试剂盒',
      '医疗咨询室，墙面电子屏显示肌肉组织切片显微图像与肾脏过滤流程动画'
    ]
  },
  // 教育讲解场景
  educational: {
    base: '专业教育空间',
    elements: [
      '现代化多媒体教室，背景大屏显示人体肌肉纤维束实时动态图像',
      '健康科普直播间，环形柔光灯组与专业提词设备隐约可见',
      '医学培训室，墙面张贴肌肉解剖图谱与肾脏功能流程示意图',
      '警民健康服务站，背景可见警医联合健康宣传栏与急救知识展架',
      '社区健康讲堂，墙面布置居民健康管理信息图表与运动处方展示板'
    ]
  }
};

// ═══════════════════════════════════════════════════════════
// 核心：空间增强引擎
// ═══════════════════════════════════════════════════════════

/**
 * 增强单个镜头的空间描述
 * @param {Object} promptObj - Stage 11 生成的镜头对象
 * @param {Object} context - 上下文信息（PRD、用户需求等）
 * @returns {Object} - 增强后的镜头对象
 */
function enhanceSpace(promptObj, context = {}) {
  const { shotId, scene, prompt, duration, action, dialogue } = promptObj;
  
  // 1. 分析当前空间描述
  const currentSpace = extractCurrentSpace(prompt);
  
  // 2. 根据镜头主题选择空间模板
  const sceneType = detectSceneType(scene, dialogue, action);
  const template = SPACE_TEMPLATES[sceneType] || SPACE_TEMPLATES.medical;
  
  // 3. 选择差异化元素（避免重复）
  const elementIndex = getShotIndex(shotId) % template.elements.length;
  const specificElement = template.elements[elementIndex];
  
  // 4. 构建五维空间描述
  const fiveDimensions = buildFiveDimensions({
    base: template.base,
    element: specificElement,
    scene,
    action,
    duration
  });
  
  // 5. 替换原 prompt 中的【空间】字段
  const newPrompt = replaceSpaceField(prompt, fiveDimensions);
  
  // 6. 调整字段顺序：【空间】前置到【场景】之后
  const reorderedPrompt = reorderFields(newPrompt);
  
  return {
    ...promptObj,
    prompt: reorderedPrompt,
    _spaceEnhanced: true,
    _spaceEnhancerVersion: SPACE_ENHANCER_VERSION,
    _originalSpace: currentSpace,
    _enhancedSpace: fiveDimensions
  };
}

/**
 * 提取当前 prompt 中的【空间】字段内容
 */
function extractCurrentSpace(prompt) {
  const match = prompt.match(/【空间】([^【【]*?)(?=【|$)/);
  return match ? match[1].trim() : '';
}

/**
 * 检测场景类型
 */
function detectSceneType(scene, dialogue, action) {
  const combined = `${scene || ''} ${dialogue || ''} ${action || ''}`.toLowerCase();
  
  if (combined.includes('医疗') || combined.includes('医院') || combined.includes('诊室') ||
      combined.includes('检查') || combined.includes('症状') || combined.includes('肾脏') ||
      combined.includes('肌肉') || combined.includes('实验室')) {
    return 'medical';
  }
  
  if (combined.includes('教育') || combined.includes('科普') || combined.includes('讲解') ||
      combined.includes('教室') || combined.includes('培训') || combined.includes('讲堂')) {
    return 'educational';
  }
  
  return 'medical'; // 默认医疗
}

/**
 * 从 shotId 提取索引（用于差异化选择）
 */
function getShotIndex(shotId) {
  const match = shotId.match(/(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

/**
 * 构建五维空间描述
 */
function buildFiveDimensions({ base, element, scene, action, duration }) {
  const space = `${base}，${element}`;
  
  // 根据 action 推断纵深信息
  let depth = '中景到近景过渡';
  if (action && action.includes('手势')) {
    depth = '前景有讲解手势空间，中景人物主体清晰，背景医疗环境虚化';
  } else if (action && action.includes('指向')) {
    depth = '前景有指向动作延伸空间，中景人物与虚拟屏幕交互，背景科普墙深远';
  }
  
  // 方位：默认正面微仰
  const direction = '正面微仰视角，人物占据画面视觉中心偏左三分之一处，视线引导自然';
  
  // 氛围：根据场景推断
  let atmosphere = '专业、权威、可信赖';
  if (scene && scene.includes('开场')) {
    atmosphere = '庄重、亲和、引人关注';
  } else if (scene && scene.includes('结尾')) {
    atmosphere = '温暖、安心、充满希望';
  } else if (scene && scene.includes('症状')) {
    atmosphere = '严肃、关切、警示';
  }
  
  // 时间：默认室内照明
  const time = `明亮均匀的室内照明，色温5000K-5500K，模拟自然光环境，${duration || 10}秒镜头内光线稳定无闪烁`;
  
  return {
    space,
    depth,
    direction,
    atmosphere,
    time
  };
}

/**
 * 替换 prompt 中的【空间】字段
 */
function replaceSpaceField(prompt, fiveDimensions) {
  const spaceBlock = `【空间】${fiveDimensions.space}`;
  
  if (prompt.includes('【空间】')) {
    // 替换现有【空间】字段
    return prompt.replace(/【空间】[^【【]*?(?=【|$)/, spaceBlock);
  } else {
    // 如果没有【空间】字段，在【场景】之后插入
    if (prompt.includes('【场景】')) {
      return prompt.replace(/(【场景】[^【【]*?)(【|$)/, `$1${spaceBlock}$2`);
    }
    // 如果连【场景】都没有，直接追加
    return prompt + spaceBlock;
  }
}

/**
 * 调整字段顺序：【空间】前置到【场景】之后
 */
function reorderFields(prompt) {
  // 提取所有字段
  const fields = {};
  const fieldPattern = /【([^】]+)】([^【]*?)(?=【|$)/g;
  let match;
  
  while ((match = fieldPattern.exec(prompt)) !== null) {
    fields[match[1]] = match[2].trim();
  }
  
  // 定义字段顺序
  const fieldOrder = [
    '视觉', '角色', '场景', '空间', '纵深', '方位', '氛围', '时间',
    '动作', '台词', '叙事', '全局时间定位', '镜头时间轴',
    '运镜', '情绪', '音频', '风格', '风格锁', '负面约束',
    '明亮约束', '角色约束', '绑定定妆照'
  ];
  
  // 按顺序重建 prompt
  const parts = [];
  for (const fieldName of fieldOrder) {
    if (fields[fieldName]) {
      parts.push(`【${fieldName}】${fields[fieldName]}`);
    }
  }
  
  // 添加未在顺序列表中的字段
  for (const [name, value] of Object.entries(fields)) {
    if (!fieldOrder.includes(name)) {
      parts.push(`【${name}】${value}`);
    }
  }
  
  return parts.join(' | ');
}

// ═══════════════════════════════════════════════════════════
// 批量增强接口
// ═══════════════════════════════════════════════════════════

/**
 * 批量增强所有镜头的空间描述
 * @param {Array} prompts - Stage 11 生成的提示词数组
 * @param {Object} context - 上下文信息
 * @returns {Array} - 增强后的提示词数组
 */
function enhanceAllSpaces(prompts, context = {}) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    return prompts;
  }
  
  const enhanced = [];
  const usedElements = new Set(); // 跟踪已使用的元素，避免重复
  
  for (const promptObj of prompts) {
    // 为每个镜头选择未使用过的元素
    const sceneType = detectSceneType(promptObj.scene, promptObj.dialogue, promptObj.action);
    const template = SPACE_TEMPLATES[sceneType] || SPACE_TEMPLATES.medical;
    
    // 找到第一个未使用的元素
    let elementIndex = 0;
    for (let i = 0; i < template.elements.length; i++) {
      if (!usedElements.has(template.elements[i])) {
        elementIndex = i;
        usedElements.add(template.elements[i]);
        break;
      }
    }
    
    // 如果所有元素都用过了，重置
    if (usedElements.size >= template.elements.length * 2) {
      usedElements.clear();
    }
    
    const enhancedObj = enhanceSpace(promptObj, {
      ...context,
      forcedElementIndex: elementIndex
    });
    
    enhanced.push(enhancedObj);
  }
  
  return enhanced;
}

// ═══════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════

module.exports = {
  enhanceSpace,
  enhanceAllSpaces,
  extractCurrentSpace,
  buildFiveDimensions,
  SPACE_ENHANCER_VERSION
};
