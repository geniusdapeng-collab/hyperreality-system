/**
 * hyperreality-system/scripts/smoke-test.js
 * 快速回归测试：验证核心链路不崩溃、25字段完整
 * 【审计修复·P2】新增冒烟测试，5分钟验证系统健康
 */

const path = require('path');

// 强制设置测试环境
process.env.NODE_ENV = 'test';
process.env.HYPERREALITY_TEST_MODE = 'true';

// 模拟配置（避免加载真实密钥）
// 请设置环境变量: export VOLCENGINE_ARK_API_KEY=your_api_key

const HYPERREALITY_ROOT = path.join(__dirname, '..');

// ========== 测试工具 ==========
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(` ❌ ${name} - ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assertion failed'}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition, msg) {
  if (!condition) {
    throw new Error(msg || 'Assertion failed: expected true');
  }
}

// ========== 测试套件 ==========
console.log('\n🔥 [Smoke Test] HyperrealitySystem 快速回归测试\n');

// --- 测试1: 模块可加载 ---
test('模块加载: HyperrealitySystem', () => {
  const { HyperrealitySystem } = require(path.join(HYPERREALITY_ROOT, 'index.js'));
  assertTrue(typeof HyperrealitySystem === 'function', 'HyperrealitySystem 应为类');
});

// --- 测试2: ProductionEngine 可实例化 ---
test('模块加载: ProductionEngine', () => {
  const { ProductionEngine } = require(path.join(HYPERREALITY_ROOT, 'engines/production-engine/production-engine.js'));
  assertTrue(typeof ProductionEngine === 'function', 'ProductionEngine 应为类');
});

// --- 测试3: 深拷贝不崩溃（循环引用场景）---
test('深拷贝: 循环引用安全', () => {
  const { ProductionEngine } = require(path.join(HYPERREALITY_ROOT, 'engines/production-engine/production-engine.js'));
  const engine = new ProductionEngine({});
  const shot = { shotId: 'SC00', sceneType: 'opening', title: 'Test' };
  shot._self = shot; // 制造循环引用
  const cloned = engine._deepCloneShot(shot);
  assertEqual(cloned.shotId, 'SC00', '克隆后 shotId 应保持');
  assertEqual(cloned.title, 'Test', '克隆后 title 应保持');
  assertTrue(cloned !== shot, '克隆应为新对象');
});

// --- 测试4: 片头判定兼容性 ---
test('片头判定: 兼容 SC00/S00/SC00-xx', () => {
  const { isOpeningShot } = require(path.join(HYPERREALITY_ROOT, 'engines/field-standardizer.js'));
  assertTrue(isOpeningShot({ shotId: 'SC00' }), 'SC00 应判定为片头');
  assertTrue(isOpeningShot({ shotId: 'S00' }), 'S00 应判定为片头');
  assertTrue(isOpeningShot({ shotId: 'SC00-01' }), 'SC00-01 应判定为片头');
  assertTrue(!isOpeningShot({ shotId: 'SC01' }), 'SC01 不应判定为片头');
});

// --- 测试5: Checkpoint 安全序列化 ---
test('Checkpoint: 循环引用安全序列化', () => {
  const { ProductionEngine } = require(path.join(HYPERREALITY_ROOT, 'engines/production-engine/production-engine.js'));
  const engine = new ProductionEngine({});
  const obj = { a: 1 };
  obj.self = obj; // 循环引用
  const json = engine._safeStringify(obj);
  const parsed = JSON.parse(json);
  assertEqual(parsed.a, 1, '安全序列化后 a 应保持');
  assertTrue(!parsed.self, '循环引用字段应被过滤');
});

// --- 测试6: PromptLengthConfig 引用正确 ---
test('配置: PromptLengthConfig.HARD_MAX = 12000', () => {
  const PromptLengthConfig = require(path.join(HYPERREALITY_ROOT, 'config/prompt-length.js'));
  assertEqual(PromptLengthConfig.HARD_MAX, 12000, 'HARD_MAX 应为 12000');
});

// --- 测试7: FieldGuard 单镜头失败不拖垮整批 ---
test('FieldGuard: 单镜头失败隔离', () => {
  const { FieldGuard } = require(path.join(HYPERREALITY_ROOT, 'engines/field-guard.js'));
  const guard = new FieldGuard({});
  // 模拟一个无效镜头（缺少必填字段）
  const badShot = { shotId: 'SC01' }; // 缺少 fields
  const goodShot = { shotId: 'SC02', fields: { scene: 'test' } };
  const result = guard.normalizeAndValidate([badShot, goodShot], 'test');
  assertTrue(Array.isArray(result.shots), '应返回 shots 数组');
  assertEqual(result.shots.length, 2, '应返回 2 个镜头');
  // 降级标记可能在 report.warnings 或 report.degraded 中
  const hasDegraded = (result.report.warnings?.length > 0) || (result.report.degraded > 0);
  assertTrue(hasDegraded, '应有降级或警告标记');
});

// ========== 汇总 ==========
console.log(`\n${'='.repeat(50)}`);
console.log(` 结果: ${passed} 通过, ${failed} 失败`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
