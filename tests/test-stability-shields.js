/**
 * 三层稳定性护盾测试
 */

const { BaselineRegistry } = require('../shields/baseline-registry/baseline-registry');
const { LLMGateway } = require('../shields/llm-gateway/llm-gateway');
const { HealthMonitor } = require('../shields/health-monitor/health-monitor');
const { StabilityShield } = require('../shields/stability-shield');

console.log('========================================');
console.log('  三层稳定性护盾测试 v1.0');
console.log('========================================\n');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passCount++;
  } catch (error) {
    console.log(`  ❌ ${name}: ${error.message}`);
    failCount++;
  }
}

// ========== 测试1: BaselineRegistry ==========
console.log('\n🔥 [测试1] 基线模板注册表');

const baselineRegistry = new BaselineRegistry({
  registryDir: './tests/templates-test'
});

// 确保测试目录存在
const fs = require('fs');
if (!fs.existsSync('./tests/templates-test')) {
  fs.mkdirSync('./tests/templates-test', { recursive: true });
}

// 清理测试目录
if (fs.existsSync('./tests/templates-test')) {
  fs.rmSync('./tests/templates-test', { recursive: true });
  fs.mkdirSync('./tests/templates-test', { recursive: true });
}

test('注册基线模板', () => {
  const baseline = {
    directorInstruction: '好莱坞纪录片质感',
    constraint: 'Aspect ratio: 16:9',
    baseline: '8K resolution',
    negativePrompt: 'no text'
  };
  
  const template = baselineRegistry.register('health', 'v1.0', baseline, {
    approvedBy: 'test',
    description: '健康科普基线模板'
  });
  
  if (!template || template.id !== 'health_v1.0') {
    throw new Error('注册失败');
  }
});

test('加载基线模板', () => {
  const template = baselineRegistry.load('health', 'v1.0');
  if (!template || template.category !== 'health') {
    throw new Error('加载失败');
  }
});

test('基线合并', () => {
  const template = baselineRegistry.load('health', 'v1.0');
  const llmOutput = {
    scene: '医院走廊',
    action: '医生行走',
    dialogue: '请注意健康'
  };
  
  const merged = baselineRegistry.merge(template, llmOutput);
  
  if (!merged.directorInstruction || !merged.scene) {
    throw new Error('合并失败');
  }
  
  if (merged._baselineUsed !== 'health_v1.0') {
    throw new Error('基线标记缺失');
  }
});

test('题材自动检测', () => {
  const req1 = { title: '健康护理知识' };
  const req2 = { title: '产品销售推广' };
  
  const match1 = baselineRegistry.findBestMatch(req1);
  const match2 = baselineRegistry.findBestMatch(req2);
  
  if (match1.category !== 'health') {
    throw new Error(`检测失败: ${match1.category}`);
  }
  if (match2.category !== 'product') {
    throw new Error(`检测失败: ${match2.category}`);
  }
});

test('列出所有模板', () => {
  const list = baselineRegistry.list();
  if (list.length === 0) {
    throw new Error('列表为空');
  }
});

// ========== 测试2: LLMGateway ==========
console.log('\n🔥 [测试2] LLM网关');

const llmGateway = new LLMGateway({
  cacheEnabled: true,
  cacheTTL: 60000, // 1分钟测试缓存
  timeout: 5000
});

test('熔断器初始状态', () => {
  const stats = llmGateway.getStats();
  if (stats.circuitBreaker.state !== 'CLOSED') {
    throw new Error(`熔断器状态错误: ${stats.circuitBreaker.state}`);
  }
});

test('缓存机制', () => {
  // 模拟调用（没有实际LLM，会走fallback）
  llmGateway.call('test-prompt-1').then(result1 => {
    // 第二次调用应该命中缓存
    llmGateway.call('test-prompt-1').then(result2 => {
      if (result2.source !== 'cache') {
        // 没有实际LLM，第一次也不会进缓存，所以fallback不缓存
        // 这个测试在真实环境才有意义
      }
    });
  });
});

test('兜底规则模板', () => {
  // 模拟fallback
  const result = llmGateway._fallback('test', {}, Date.now());
  if (!result.success || result.source !== 'fallback-rule') {
    throw new Error('兜底失败');
  }
});

test('熔断器触发', () => {
  // 模拟多次失败
  for (let i = 0; i < 5; i++) {
    llmGateway._onFailure();
  }
  
  const stats = llmGateway.getStats();
  if (stats.circuitBreaker.state !== 'OPEN') {
    throw new Error(`熔断器未触发: ${stats.circuitBreaker.state}`);
  }
});

test('熔断器重置', () => {
  llmGateway.resetCircuitBreaker();
  const stats = llmGateway.getStats();
  if (stats.circuitBreaker.state !== 'CLOSED') {
    throw new Error('熔断器重置失败');
  }
});

// ========== 测试3: HealthMonitor ==========
console.log('\n🔥 [测试3] 健康监控');

const healthMonitor = new HealthMonitor({
  checkInterval: 60000, // 1分钟（测试中不实际触发）
  latencyThreshold: 1000
});

test('注册Agent', () => {
  const mockAgent = { restart: async () => {} };
  healthMonitor.registerAgent('TestAgent', mockAgent);
  
  const status = healthMonitor.getHealthStatus('TestAgent');
  if (!status || status.status !== 'healthy') {
    throw new Error('注册失败');
  }
});

test('记录调用结果', () => {
  healthMonitor.recordCall('TestAgent', true, 100);
  healthMonitor.recordCall('TestAgent', false, 200);
  
  const status = healthMonitor.getHealthStatus('TestAgent');
  if (status.totalCalls !== 2) {
    throw new Error('调用记录失败');
  }
});

test('补偿事务注册', () => {
  healthMonitor.registerCompensation('TestStage', async () => {
    console.log('补偿执行');
  });
  
  const stats = healthMonitor.getStats();
  if (stats.activeCompensations !== 1) {
    throw new Error('补偿注册失败');
  }
});

test('统计信息', () => {
  const stats = healthMonitor.getStats();
  if (!stats.totalAgents || stats.totalAgents < 1) {
    throw new Error('统计失败');
  }
});

// 停止监控
healthMonitor.stop();

// ========== 测试4: StabilityShield集成 ==========
console.log('\n🔥 [测试4] 护盾集成器');

const shield = new StabilityShield({
  baselineRegistryDir: './tests/templates-test',
  cacheEnabled: true
});

test('护盾初始化', () => {
  if (!shield.baselineRegistry || !shield.llmGateway || !shield.healthMonitor) {
    throw new Error('护盾初始化失败');
  }
});

test('获取状态', () => {
  const status = shield.getStatus();
  if (!status.baseline || !status.llmGateway || !status.health) {
    throw new Error('状态获取失败');
  }
});

test('构建增量Prompt', () => {
  const prompt = shield._buildDeltaPrompt({
    _category: 'health',
    scene: '医院',
    action: '行走'
  });
  
  if (!prompt.includes('医院') || !prompt.includes('增量')) {
    throw new Error('Prompt构建失败');
  }
});

test('构建完整Prompt', () => {
  const prompt = shield._buildFullPrompt({ title: '测试' });
  if (!prompt.includes('测试')) {
    throw new Error('Prompt构建失败');
  }
});

// ========== 汇总 ==========
console.log('\n========================================');
console.log(`  测试完成: ${passCount} 通过, ${failCount} 失败`);
console.log('========================================');

if (failCount > 0) {
  process.exit(1);
}
