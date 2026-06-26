// 设置环境变量（在脚本内部）
process.env.HYPERREALITY_USE_PHASES = 'true';

// 测试新Phase架构（不调用LLM，纯验证）
const { ProductionEngine } = require('../engines/production-engine/production-engine');
const { safeStringify } = require('../engines/production-engine/utils/safe-stringify');
const { CheckpointManager } = require('../engines/production-engine/utils/checkpoint-manager');
const { LLMOutputNormalizer } = require('../engines/production-engine/utils/llm-output-normalizer');

console.log('========================================');
console.log('  Phase架构验证测试 v1.0');
console.log('========================================\n');

let results = { passed: 0, failed: 0 };

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    results.passed++;
  } else {
    console.log(`  ❌ ${message}`);
    results.failed++;
  }
}

async function runTest() {
  // 测试1: 默认启用新架构
  console.log('🔥 [测试1] 默认启用新架构');
  const peDefault = new ProductionEngine({ llmModel: 'kimi-k2p6' });
  assert(!!peDefault.phase1, 'Phase1默认已加载');
  assert(!!peDefault.phase2, 'Phase2默认已加载');
  assert(!!peDefault.phase3, 'Phase3默认已加载');
  assert(!!peDefault.phase35, 'Phase3.5默认已加载');
  console.log('');

  // 测试2: 向后兼容验证（produce方法存在）
  console.log('🔥 [测试2] 向后兼容验证');
  assert(typeof peDefault.produce === 'function', 'produce方法存在');
  console.log('');

  // 测试3: 新架构功能验证
  console.log('🔥 [测试3] 新架构功能验证');
  const peNew = new ProductionEngine({ llmModel: 'kimi-k2p6' });
  assert(!!peNew.phase1, 'Phase1应已加载');
  assert(!!peNew.phase2, 'Phase2应已加载');
  assert(!!peNew.phase3, 'Phase3应已加载');
  assert(!!peNew.phase35, 'Phase3.5应已加载');
  
  // 验证Phase接口
  assert(typeof peNew.phase1.execute === 'function', 'Phase1.execute应为函数');
  assert(typeof peNew.phase2.execute === 'function', 'Phase2.execute应为函数');
  assert(typeof peNew.phase3.execute === 'function', 'Phase3.execute应为函数');
  assert(typeof peNew.phase35.execute === 'function', 'Phase3.5.execute应为函数');
  
  // 验证Phase继承
  assert(peNew.phase1.name === 'Phase1-SceneDesign', 'Phase1名称正确');
  assert(peNew.phase2.name === 'Phase2-VisualAudio', 'Phase2名称正确');
  assert(peNew.phase3.name === 'Phase3-PromptFusion', 'Phase3名称正确');
  assert(peNew.phase35.name === 'Phase3.5-FieldQuality', 'Phase3.5名称正确');
  console.log('');

  // 测试3: 验证工具函数已提取
  console.log('🔥 [测试3] 工具函数提取验证');
  const { safeStringify } = require('../engines/production-engine/utils/safe-stringify');
  const { CheckpointManager } = require('../engines/production-engine/utils/checkpoint-manager');
  const { LLMOutputNormalizer } = require('../engines/production-engine/utils/llm-output-normalizer');
  
  assert(typeof safeStringify === 'function', 'safeStringify已提取');
  assert(typeof CheckpointManager === 'function', 'CheckpointManager已提取');
  assert(typeof LLMOutputNormalizer === 'function', 'LLMOutputNormalizer已提取');
  
  // 测试safeStringify功能（safeStringify有2空格缩进）
  const testObj = { a: 1, b: { c: 'test' } };
  const result1 = safeStringify(testObj);
  assert(result1.includes('"a": 1'), 'safeStringify包含a字段（带缩进格式）');
  assert(result1.includes('"c": "test"'), 'safeStringify包含嵌套c字段（带缩进格式）');
  assert(safeStringify(null) === 'null', 'safeStringify处理null正常');
  // undefined在JSON.stringify中返回undefined，safeStringify也一样
  const undefinedResult = safeStringify(undefined);
  assert(undefinedResult === undefined, 
    `safeStringify处理undefined返回undefined，符合预期`);
  console.log('');

  // 测试4: 模拟Phase执行（不调用LLM，仅验证流程）
  console.log('🔥 [测试4] Phase执行流程模拟');
  try {
    // 模拟Phase1.execute的预算不足场景
    const mockState = { shots: [], result: { llmStats: {} }, adaptedBlueprint: {} };
    
    // 通过mock canAfford返回false来测试预算不足路径
    const peMock = new ProductionEngine({ llmModel: 'kimi-k2p6' });
    if (peMock.phase1) {
      // 修改预算检查为总是失败，测试降级路径
      const originalCanAfford = peMock.phase1.canAfford;
      peMock.phase1.canAfford = () => false;
      
      const result = await peMock.phase1.execute(mockState);
      assert(result.success === false, '预算不足时Phase1返回success=false');
      assert(result.error === '预算不足', '错误信息正确');
      
      // 恢复
      peMock.phase1.canAfford = originalCanAfford;
    }
  } catch (e) {
    assert(false, `Phase模拟执行失败: ${e.message}`);
  }
  console.log('');

  // 测试5: 验证向后兼容（produce方法存在且为函数）
  console.log('🔥 [测试5] 向后兼容验证');
  assert(typeof peDefault.produce === 'function', '默认架构produce方法存在');
  assert(typeof peNew.produce === 'function', '新架构produce方法存在');
  console.log('');

  // 结果汇总
  console.log('========================================');
  console.log(`  测试完成: ${results.passed} 通过, ${results.failed} 失败`);
  console.log('========================================');
  
  if (results.failed > 0) {
    process.exit(1);
  }
}

runTest().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
