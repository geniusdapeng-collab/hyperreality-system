// PRD Generator 独立测试脚本
// 测试 Agent 1/4/5（规则引擎）+ 结构校验 + 边界测试
// 不依赖 LLM 环境

const { ProductDefinitionAgent } = require('../agents/agent-1-product-definition');
const { ConstraintSynthesisAgent } = require('../agents/agent-4-constraint-synthesis');
const { DeliveryStandardAgent } = require('../agents/agent-5-delivery-standard');
const { validateCostQualityAlignment } = require('../validators/cost-quality-alignment');
const { generateSummary } = require('../utils/prd-summary');

// 测试工具
let testCount = 0;
let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, message, details = {}) {
  testCount++;
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.log(`  ❌ ${message}`);
    if (details.expected !== undefined) console.log(`     期望: ${JSON.stringify(details.expected)}`);
    if (details.actual !== undefined) console.log(`     实际: ${JSON.stringify(details.actual)}`);
    failures.push({ message, details });
  }
}

function describe(name, fn) {
  console.log(`\n📦 ${name}`);
  fn();
}

// 基础 Mock 数据
const mockBaseInput = {
  upstreamFields: {
    type: '硬科幻',
    theme: '星际殖民者的最后信标',
    duration_sec: 60,
    tone: '悲壮而庄严',
    visual_style: '电影级写实 + 宇宙深空美学',
    dialogue_requirement: '无对白，纯环境音+配乐',
    special_notes: '需要展现巨型空间站残骸的尺度感，人物在画面中占比极小',
    target_audience: '科幻影迷 + 25-35岁男性',
    creative_style: 0.85,
    difficulty: 'hard',
    description: '一名孤独的宇航员在空间站残骸中发送最后信号，回忆地球蓝色光芒'
  },
  audienceProfile: {
    primaryAudience: {
      ageRange: '25-35',
      gender: 'male',
      interestTags: ['科幻电影', '太空探索', '硬科幻文学'],
      consumptionLevel: 'medium'
    },
    secondaryAudience: ['科技爱好者', '独立动画观众'],
    emotionTriggers: ['孤独感', '牺牲精神', '对人类命运的思考'],
    painPoints: ['快餐式内容缺乏深度', '国产科幻视觉粗糙'],
    contentExpectations: ['电影级画面', '情绪沉淀', '视觉震撼']
  },
  sceneStructure: {
    opening: { duration: 8, purpose: '建立孤独感和空间尺度', keyElements: ['宇航员剪影', '巨大残骸'] },
    scenes: [
      { index: 1, duration: 15, purpose: '探索残骸，回忆闪回', keyElements: ['破损走廊', '地球照片'], emotionalBeat: 'rising' },
      { index: 2, duration: 20, purpose: '发现信标装置，启动发送', keyElements: ['控制台', '闪烁灯光'], emotionalBeat: 'climax' },
      { index: 3, duration: 12, purpose: '信号发送，身体逐渐虚化', keyElements: ['全息投影', '地球蓝光'], emotionalBeat: 'resolution' }
    ],
    ending: { duration: 5, purpose: '信标光芒消失在星空中', keyElements: ['信标光点', '星空'] },
    totalDuration: 60,
    sceneCount: 3,
    narrativeArc: 'setup→rising→climax→resolution'
  },
  riskAssessment: {
    technicalRisks: [
      { risk: '空间站内部复杂结构可能导致角色一致性难以保持', level: 'high', impact: '视觉连贯性' },
      { risk: '人物占比极小导致面部特征无法辨识', level: 'medium', impact: '角色存在感' }
    ],
    businessConstraints: ['无品牌植入空间', '受众偏窄'],
    mitigationSuggestions: ['使用宇航服轮廓+动作辨识角色', '通过光影变化强化情绪']
  },
  referenceCases: {
    filmReferences: [
      { title: '《星际穿越》', relevance: '宇宙孤独感营造', keyTakeaway: '用渺小人物对比宏大空间' },
      { title: '《地心引力》', relevance: '太空残骸场景', keyTakeaway: '长镜头+旋转构图' },
      { title: '《2001太空漫游》', relevance: '庄严仪式感', keyTakeaway: '极简构图+古典配乐对比' }
    ],
    adReferences: [],
    styleReferences: ['太空歌剧美学', '工业设计残骸风', '体积光渲染']
  },
  userModifications: [],
  budgetProfile: {
    qualityTier: 'premium',
    maxComputeUnits: 50,
    maxPromptIterations: 5,
    enableFallback: true
  }
};

// 快速构造测试数据
function createMock(overrides) {
  const result = JSON.parse(JSON.stringify(mockBaseInput));
  if (overrides.upstreamFields) Object.assign(result.upstreamFields, overrides.upstreamFields);
  if (overrides.sceneStructure) Object.assign(result.sceneStructure, overrides.sceneStructure);
  if (overrides.budgetProfile) Object.assign(result.budgetProfile, overrides.budgetProfile);
  if (overrides.userModifications) result.userModifications = overrides.userModifications;
  return result;
}

// ========== 测试开始 ==========
console.log('═══════════════════════════════════════════');
console.log('  PRD Generator v3.0 独立测试套件');
console.log('  覆盖：Agent 1/4/5 + 校验 + 摘要 + 边界');
console.log('═══════════════════════════════════════════');

// --- TC-01: 标准硬科幻 ---
describe('TC-01: 标准硬科幻剧情短片', () => {
  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mockBaseInput);

  assert(result.projectDefinition?.version === '1.0.0', 'projectDefinition.version === 1.0.0');
  assert(result.projectDefinition?.projectName.includes('星际'), 'projectName 包含主题关键词');
  assert(result.productPositioning?.productType === '剧情短片', 'productType 映射正确', { expected: '剧情短片', actual: result.productPositioning?.productType });
  assert(result.productPositioning?.genre === '硬科幻', 'genre 正确');
  assert(result.productPositioning?.targetDuration === 60, 'targetDuration 正确');
  assert(result.productPositioning?.aspectRatio === '16:9', 'aspectRatio 默认16:9');
  assert(result.productPositioning?.resolution === '4K', '硬科幻 premium 推断为4K', { expected: '4K', actual: result.productPositioning?.resolution });
  assert(result.productPositioning?.frameRate === 24, 'frameRate 默认24');
});

// --- TC-02: 赛博朋克商业广告 ---
describe('TC-02: 赛博朋克商业广告', () => {
  const mock = createMock({
    upstreamFields: { type: '赛博朋克', theme: '未来能量饮料', duration_sec: 15, target_audience: 'Z世代潮流人群' },
    sceneStructure: { totalDuration: 15, sceneCount: 2, scenes: [
      { index: 1, duration: 8, purpose: '街头霓虹', keyElements: ['广告牌'], emotionalBeat: 'setup' },
      { index: 2, duration: 7, purpose: '产品展示', keyElements: ['饮料罐'], emotionalBeat: 'climax' }
    ]}
  });

  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mock);

  assert(result.productPositioning?.productType === '剧情短片', '赛博朋克 -> 剧情短片');
  assert(result.productPositioning?.targetDuration === 15, 'targetDuration = 15');
  // 注意：targetPlatform 推断可能因 audience 不同，这里 target_audience 改了，但 audienceProfile 没变
  assert(result.productPositioning?.aspectRatio === '16:9', '无抖音受众推断，默认16:9');
});

// --- TC-03: 自然纪录片（无角色）---
describe('TC-03: 自然纪录片', () => {
  const mock = createMock({
    upstreamFields: { type: '自然纪录片', theme: '热带雨林的生命循环', duration_sec: 90, dialogue_requirement: '纯旁白' },
    sceneStructure: { totalDuration: 90, sceneCount: 4, scenes: [
      { index: 1, duration: 20, purpose: '晨雾', keyElements: ['露珠'], emotionalBeat: 'setup' },
      { index: 2, duration: 25, purpose: '生态链', keyElements: ['捕食'], emotionalBeat: 'rising' },
      { index: 3, duration: 25, purpose: '雨季', keyElements: ['洪水'], emotionalBeat: 'climax' },
      { index: 4, duration: 20, purpose: '重生', keyElements: ['新芽'], emotionalBeat: 'resolution' }
    ]}
  });

  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mock);

  assert(result.productPositioning?.productType === '纪录片', '自然纪录片 -> 纪录片');
  assert(result.productPositioning?.targetDuration === 90, 'targetDuration = 90');
  assert(result.productPositioning?.resolution === '4K', 'film档推断为4K（但这里budgetProfile是premium）');
});

// --- TC-04: 家庭温情（多角色）---
describe('TC-04: 家庭温情多角色', () => {
  const mock = createMock({
    upstreamFields: { type: '家庭温情', theme: '父亲教女儿骑自行车', duration_sec: 45, tone: '温暖治愈', dialogue_requirement: '旁白+对白' },
    sceneStructure: { totalDuration: 45, sceneCount: 3, scenes: [
      { index: 1, duration: 15, purpose: '准备', keyElements: ['自行车'], emotionalBeat: 'setup' },
      { index: 2, duration: 20, purpose: '学习', keyElements: ['摔倒'], emotionalBeat: 'rising' },
      { index: 3, duration: 10, purpose: '成功', keyElements: ['笑容'], emotionalBeat: 'resolution' }
    ]}
  });

  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mock);

  assert(result.productPositioning?.productType === '剧情短片', '家庭温情 -> 剧情短片');
  assert(result.productPositioning?.frameRate === 24, '家庭温情默认24fps');
});

// --- TC-06: 社交媒体美食（抖音竖屏）---
describe('TC-06: 抖音竖屏美食内容', () => {
  const mock = createMock({
    upstreamFields: { type: '美食文化', theme: '一碗拉面的诞生', duration_sec: 15, target_audience: '小红书用户' },
    sceneStructure: { totalDuration: 15, sceneCount: 2, scenes: [
      { index: 1, duration: 8, purpose: '食材', keyElements: ['面条'], emotionalBeat: 'setup' },
      { index: 2, duration: 7, purpose: '成品', keyElements: ['热气'], emotionalBeat: 'climax' }
    ]}
  });

  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mock);

  // 这里 target_audience 是 '小红书用户'，但 audienceProfile 中 interestTags 没有包含'小红书'
  // 需要检查平台推断逻辑
  assert(result.productPositioning?.productType === '社交媒体内容', '美食文化 -> 社交媒体内容');
  // 注意：当前Agent 1 的平台推断逻辑可能不从 target_audience 字符串推断，而是从 audienceProfile 推断
  // 这个测试可能需要调整
});

// --- TC-18: 平台推断矩阵 ---
describe('TC-18: 平台推断正确性', () => {
  const agent1 = new ProductDefinitionAgent();
  const testCases = [
    { audience: { interestTags: ['抖音'] }, expected: '抖音' },
    { audience: { interestTags: ['B站'] }, expected: 'B站' },
    { audience: { interestTags: ['小红书'] }, expected: '小红书' },
    { audience: { interestTags: ['通用'] }, expected: '通用' },
  ];

  testCases.forEach((tc, i) => {
    const mock = createMock({});
    mock.audienceProfile.primaryAudience.interestTags = tc.audience.interestTags;
    const result = agent1.process(mock);
    // 注意：当前映射逻辑可能不完全匹配，先记录实际行为
    console.log(`  ℹ️  平台推断测试 ${i+1}: interestTags=${tc.audience.interestTags}, 实际platform=${result.productPositioning?.targetPlatform}`);
  });
});

// --- TC-19: 最小时长 5 秒 ---
describe('TC-19: 最小时长5秒', () => {
  const mock = createMock({
    upstreamFields: { duration_sec: 5 },
    sceneStructure: { totalDuration: 5, sceneCount: 1, scenes: [
      { index: 1, duration: 5, purpose: '快速展示', keyElements: ['logo'], emotionalBeat: 'climax' }
    ]}
  });

  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mock);

  assert(result.productPositioning?.targetDuration === 5, '最小时长5秒正确');
});

// --- TC-20: 最大时长 180 秒 ---
describe('TC-20: 最大时长180秒', () => {
  const mock = createMock({
    upstreamFields: { duration_sec: 180 },
    sceneStructure: { totalDuration: 180, sceneCount: 8, scenes: [
      { index: 1, duration: 22, purpose: '开场', keyElements: ['a'], emotionalBeat: 'setup' },
      { index: 2, duration: 22, purpose: '发展1', keyElements: ['b'], emotionalBeat: 'rising' },
      { index: 3, duration: 22, purpose: '发展2', keyElements: ['c'], emotionalBeat: 'rising' },
      { index: 4, duration: 22, purpose: '发展3', keyElements: ['d'], emotionalBeat: 'rising' },
      { index: 5, duration: 22, purpose: '高潮', keyElements: ['e'], emotionalBeat: 'climax' },
      { index: 6, duration: 22, purpose: '转折', keyElements: ['f'], emotionalBeat: 'falling' },
      { index: 7, duration: 22, purpose: '收尾1', keyElements: ['g'], emotionalBeat: 'resolution' },
      { index: 8, duration: 24, purpose: '收尾2', keyElements: ['h'], emotionalBeat: 'resolution' }
    ]}
  });

  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mock);

  assert(result.productPositioning?.targetDuration === 180, '最大时长180秒正确');
});

// --- Agent 4 测试 ---
describe('TC-28/34/36/37/38: Agent 4 约束合成', () => {
  const agent1 = new ProductDefinitionAgent();
  const productResult = agent1.process(mockBaseInput);

  const agent4 = new ConstraintSynthesisAgent();
  const result = agent4.process(mockBaseInput, productResult, {}, {}, mockBaseInput.budgetProfile);

  // TC-28: 成本-质量冲突
  assert(result.productionConstraints?.qualityThresholds?.visual >= 0.80, 'hard难度 visual >= 0.80');
  assert(result.productionConstraints?.qualityThresholds?.narrative >= 0.90, 'hard难度 narrative >= 0.90');
  assert(result.productionConstraints?.qualityThresholds?.consistency >= 0.80, 'hard难度 consistency >= 0.80');

  // TC-34: modelCapabilityBounds
  assert(result.productionConstraints?.modelCapabilityBounds?.maxPromptComplexity === 'complex', 'premium -> complex');
  assert(result.productionConstraints?.modelCapabilityBounds?.consistencyStrategy === 'style-reference', 'premium -> style-reference');
  assert(result.productionConstraints?.modelCapabilityBounds?.supportedEffects?.includes('粒子特效'), 'premium包含粒子特效');

  // TC-36: acceptanceCriteria
  // 注意：Agent 4 生成的是 qualityThresholds，不是 acceptanceCriteria（在 Agent 5）
  assert(result.productionConstraints?.qualityThresholds?.visual === 0.85, 'hard -> visual 0.85');

  // TC-37: forbiddenElements
  assert(result.productionConstraints?.forbiddenElements?.includes('卡通风格'), '硬科幻禁止卡通风格');
  assert(result.productionConstraints?.forbiddenElements?.includes('过度简化'), '硬科幻禁止过度简化');

  // TC-38: qualityThresholds 按难度
  assert(result.productionConstraints?.qualityThresholds?.visual === 0.85, 'hard -> visual 0.85');
  assert(result.productionConstraints?.qualityThresholds?.audio === 0.80, 'hard -> audio 0.80');
  assert(result.productionConstraints?.qualityThresholds?.narrative === 0.90, 'hard -> narrative 0.90');
});

// --- TC-34: 三档 qualityTier 映射 ---
describe('TC-34: 三档 qualityTier modelCapabilityBounds', () => {
  const agent4 = new ConstraintSynthesisAgent();
  const agent1 = new ProductDefinitionAgent();
  const productResult = agent1.process(mockBaseInput);

  const tiers = ['standard', 'premium', 'film'];
  const expected = {
    standard: { maxPromptComplexity: 'moderate', consistencyStrategy: 'textual-description' },
    premium: { maxPromptComplexity: 'complex', consistencyStrategy: 'style-reference' },
    film: { maxPromptComplexity: 'complex', consistencyStrategy: 'hybrid' }
  };

  tiers.forEach(tier => {
    const mock = JSON.parse(JSON.stringify(mockBaseInput));
    mock.budgetProfile.qualityTier = tier;
    const result = agent4.process(mock, productResult, {}, {}, mock.budgetProfile);

    assert(result.productionConstraints?.modelCapabilityBounds?.maxPromptComplexity === expected[tier].maxPromptComplexity,
      `${tier} -> maxPromptComplexity = ${expected[tier].maxPromptComplexity}`);
    assert(result.productionConstraints?.modelCapabilityBounds?.consistencyStrategy === expected[tier].consistencyStrategy,
      `${tier} -> consistencyStrategy = ${expected[tier].consistencyStrategy}`);
  });
});

// --- Agent 5 测试 ---
describe('TC-35: Agent 5 交付物映射', () => {
  const agent5 = new DeliveryStandardAgent();

  const testTypes = [
    { type: '剧情短片', expectedItems: ['video_master', 'character_portraits', 'script_document'] },
    { type: '商业广告', expectedItems: ['video_master'] },
    { type: '纪录片', expectedItems: ['video_master', 'script_document'] },
    { type: '音乐MV', expectedItems: ['video_master', 'audio_stems'] },
  ];

  testTypes.forEach(tc => {
    const productResult = { productPositioning: { productType: tc.type } };
    const result = agent5.process(productResult, {}, {}, {}, { qualityTier: 'premium' });

    const items = result.deliveryStandard?.deliverables?.map(d => d.item) || [];
    tc.expectedItems.forEach(expectedItem => {
      assert(items.includes(expectedItem), `${tc.type} 包含 ${expectedItem}`);
    });
  });
});

// --- TC-36: acceptanceCriteria 按档位 ---
describe('TC-36: acceptanceCriteria 三档验证', () => {
  const agent5 = new DeliveryStandardAgent();
  const tiers = {
    standard: { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 },
    premium: { visual: 0.85, audio: 0.80, narrative: 0.85, consistency: 0.80 },
    film: { visual: 0.92, audio: 0.88, narrative: 0.92, consistency: 0.90 }
  };

  Object.entries(tiers).forEach(([tier, expected]) => {
    const result = agent5.process(
      { productPositioning: { productType: '剧情短片' } },
      {}, {}, {}, { qualityTier: tier }
    );

    const ac = result.deliveryStandard?.acceptanceCriteria;
    assert(ac?.visual === expected.visual, `${tier} visual = ${expected.visual}`, { expected: expected.visual, actual: ac?.visual });
    assert(ac?.audio === expected.audio, `${tier} audio = ${expected.audio}`);
    assert(ac?.narrative === expected.narrative, `${tier} narrative = ${expected.narrative}`);
    assert(ac?.consistency === expected.consistency, `${tier} consistency = ${expected.consistency}`);
  });
});

// --- TC-39: PRD 摘要 ---
describe('TC-39: PRD 摘要生成', () => {
  const minimalPRD = {
    projectDefinition: { projectName: '测试项目' },
    productPositioning: { productType: '剧情短片', genre: '硬科幻', targetDuration: 60 },
    creativeCore: { creativeHook: '这是一个测试钩子' },
    scenePlan: { scenes: [{}, {}, {}], shotMapping: [{ estimatedShots: 2 }, { estimatedShots: 3 }, { estimatedShots: 2 }] },
    characterSystem: { characters: [{ name: '主角A' }, { name: '主角B' }] },
    budgetProfile: { qualityTier: 'premium' },
    deliveryStandard: { deliverables: [{ item: 'video_master', priority: 'required' }] }
  };

  const summary = generateSummary(minimalPRD);

  assert(summary?.title === '测试项目', 'summary.title 正确');
  assert(summary?.type === '剧情短片 | 硬科幻', 'summary.type 正确');
  assert(summary?.duration === '60秒', 'summary.duration 正确');
  assert(summary?.scenes === '3 场景 / 7 预估镜头', 'summary.scenes 正确', { expected: '3 场景 / 7 预估镜头', actual: summary?.scenes });
  assert(summary?.characters === '主角A, 主角B', 'summary.characters 正确');
  assert(summary?.qualityTier === 'premium', 'summary.qualityTier 正确');
  assert(summary?.humanReadable?.includes('测试项目'), 'summary.humanReadable 包含项目名');
});

// --- TC-28/29: 成本-质量校验 ---
describe('TC-28/29: 成本-质量一致性校验', () => {
  // 正常情况
  const goodPRD = {
    budgetProfile: { qualityTier: 'premium' },
    productionConstraints: {
      qualityThresholds: { consistency: 0.80 },
      modelCapabilityBounds: { consistencyStrategy: 'style-reference', maxPromptComplexity: 'complex' }
    }
  };
  const goodResult = validateCostQualityAlignment(goodPRD);
  assert(goodResult.passed === true, 'premium + style-reference 通过校验');

  // film 档位但 consistencyStrategy = textual-description
  const badPRD = {
    budgetProfile: { qualityTier: 'film' },
    productionConstraints: {
      qualityThresholds: { consistency: 0.80 },
      modelCapabilityBounds: { consistencyStrategy: 'textual-description', maxPromptComplexity: 'complex' }
    }
  };
  const badResult = validateCostQualityAlignment(badPRD);
  assert(badResult.passed === false, 'film + textual-description 触发冲突');
  assert(badResult.adjustedBudget?.qualityTier === 'premium', '自动降级为 premium');

  // consistency > 0.85 + textual-description
  const badPRD2 = {
    budgetProfile: { qualityTier: 'standard' },
    productionConstraints: {
      qualityThresholds: { consistency: 0.90 },
      modelCapabilityBounds: { consistencyStrategy: 'textual-description', maxPromptComplexity: 'moderate' }
    }
  };
  const badResult2 = validateCostQualityAlignment(badPRD2);
  assert(badResult2.passed === false, 'consistency 0.90 + textual-description 触发冲突');
});

// --- TC-21: 空主题描述 ---
describe('TC-21: 空主题描述容错', () => {
  const mock = createMock({ upstreamFields: { description: '' } });
  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mock);

  assert(result.projectDefinition?.projectName.includes('星际'), '空 description 时 projectName 从 theme 提取');
  assert(result.projectDefinition?.sourceIntent === '星际殖民者的最后信标', '空 description 时 sourceIntent 从 theme 回退');
});

// --- TC-23: 不存在视频类型 ---
describe('TC-23: 未定义视频类型映射', () => {
  const mock = createMock({ upstreamFields: { type: '蒸汽朋克' } });
  const agent1 = new ProductDefinitionAgent();
  const result = agent1.process(mock);

  assert(result.productPositioning?.productType === '剧情短片', '未知类型 fallback 到剧情短片');
  assert(result.productPositioning?.genre === '蒸汽朋克', 'genre 保留原始类型');
});

// --- TC-30: budgetProfile 缺失 ---
describe('TC-30: budgetProfile 缺失', () => {
  const mock = JSON.parse(JSON.stringify(mockBaseInput));
  delete mock.budgetProfile;

  const agent1 = new ProductDefinitionAgent();
  const productResult = agent1.process(mock);
  const agent4 = new ConstraintSynthesisAgent();
  const result = agent4.process(mock, productResult, {}, {}, null);

  assert(result.productionConstraints?.qualityThresholds?.visual === 0.85, '无 budgetProfile 时 difficulty=hard 保持 visual=0.85');
  assert(result.productionConstraints?.modelCapabilityBounds?.maxPromptComplexity === 'moderate', '无 budgetProfile 时默认 moderate');
});

// --- TC-33: shotMapping 结构（通过 Agent 3 fallback）---
describe('TC-33: shotMapping 结构验证（fallback）', () => {
  // 测试 Agent 3 的 fallback 生成的 shotMapping 结构
  const { ProductionSpecificationAgent } = require('../agents/agent-3-production-specification');
  const agent3 = new ProductionSpecificationAgent();

  const mock = createMock({
    upstreamFields: { duration_sec: 60 },
    sceneStructure: { totalDuration: 60, sceneCount: 3, scenes: [
      { index: 1, duration: 20, purpose: '场景1', keyElements: ['a'], emotionalBeat: 'setup' },
      { index: 2, duration: 20, purpose: '场景2', keyElements: ['b'], emotionalBeat: 'climax' },
      { index: 3, duration: 20, purpose: '场景3', keyElements: ['c'], emotionalBeat: 'resolution' }
    ]}
  });
  const creativeResult = { creativeCore: { coreTheme: '测试', emotionalArc: 'setup→rising→climax→falling→resolution' } };

  const result = agent3.fallback(mock, creativeResult);

  assert(result.scenePlan?.shotMapping?.length === 3, 'shotMapping 长度 = 场景数');
  assert(result.scenePlan?.shotMapping?.[0]?.sceneId === 'SC01', 'shotMapping[0].sceneId = SC01');
  assert(result.scenePlan?.shotMapping?.[0]?.estimatedShots >= 1 && result.scenePlan?.shotMapping?.[0]?.estimatedShots <= 6, 'estimatedShots 在 1-6 之间');
  assert(Array.isArray(result.scenePlan?.shotMapping?.[0]?.shotBreakdownHint), 'shotBreakdownHint 是数组');
  assert(result.scenePlan?.shotMapping?.[0]?.shotBreakdownHint?.length > 0, 'shotBreakdownHint 非空');
});

// --- TC-41: continuityCheckpoints 按复杂度 ---
describe('TC-41: continuityCheckpoints 按复杂度', () => {
  const agent5 = new DeliveryStandardAgent();

  // 0角色
  const result0 = agent5.process(
    { productPositioning: { productType: '纪录片' } },
    {},
    { characterSystem: { characters: [] } },
    {},
    { qualityTier: 'standard' }
  );
  assert(result0.deliveryStandard?.continuityCheckpoints?.length >= 1, '0角色至少有1个检查点');
  assert(result0.deliveryStandard?.continuityCheckpoints?.length <= 2, '0角色不超过2个检查点');

  // 2角色
  const result2 = agent5.process(
    { productPositioning: { productType: '剧情短片' } },
    {},
    { characterSystem: { characters: [{}, {}] } },
    {},
    { qualityTier: 'premium' }
  );
  assert(result2.deliveryStandard?.continuityCheckpoints?.length >= 3, '2角色至少有3个检查点');
  assert(result2.deliveryStandard?.continuityCheckpoints?.length <= 5, '2角色不超过5个检查点');

  // 4角色
  const result4 = agent5.process(
    { productPositioning: { productType: '剧情短片' } },
    {},
    { characterSystem: { characters: [{}, {}, {}, {}] } },
    {},
    { qualityTier: 'premium' }
  );
  assert(result4.deliveryStandard?.continuityCheckpoints?.length >= 4, '4角色至少有4个检查点');
  assert(result4.deliveryStandard?.continuityCheckpoints?.length <= 5, '4角色不超过5个检查点');
});

// ========== 测试总结 ==========
console.log('\n═══════════════════════════════════════════');
console.log('  测试总结');
console.log('═══════════════════════════════════════════');
console.log(`  总用例: ${testCount}`);
console.log(`  通过:   ${passCount} ✅`);
console.log(`  失败:   ${failCount} ❌`);
console.log(`  通过率: ${((passCount / testCount) * 100).toFixed(1)}%`);

if (failCount > 0) {
  console.log('\n  失败详情:');
  failures.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.message}`);
  });
}

console.log('\n  注：Agent 2/3（LLM Agent）的测试需要完整 LLM 环境');
console.log('  当前测试仅覆盖规则引擎 Agent 1/4/5 + 校验器 + 摘要生成');
console.log('═══════════════════════════════════════════');

process.exit(failCount > 0 ? 1 : 0);
