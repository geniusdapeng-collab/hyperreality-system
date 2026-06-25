'use strict';

/**
 * Prompt 长度统一配置模块
 * 超现实系统适配版 v1.0
 *
 * 系统使用 3000 字符作为 Prompt 硬上限（超现实系统扩容），理想区间为 2470-3000。
 */

const PromptLengthConfig = {
  TARGET_MIN: 2470,
  TARGET_MAX: 12000,
  HARD_MAX: 12000,
  SAFE_MAX: 11900,
  SYSTEM_RESERVE: 200,
  FORMAT_RESERVE: 100,
  SAFETY_MARGIN: 30,

  getCreativeTarget(systemTemplateLen) {
    if (typeof systemTemplateLen !== 'number' || systemTemplateLen < 0) {
      systemTemplateLen = 0;
    }
    const availableMax = this.HARD_MAX - systemTemplateLen - this.SAFETY_MARGIN;
    const availableMin = Math.max(0, this.TARGET_MIN - systemTemplateLen - this.SAFETY_MARGIN);
    return { min: Math.max(0, availableMin), max: Math.max(0, availableMax) };
  },

  validate(length) {
    if (typeof length !== 'number' || isNaN(length)) return false;
    return length >= this.TARGET_MIN && length <= this.TARGET_MAX;
  },

  getStatus(length) {
    if (typeof length !== 'number' || isNaN(length)) return 'overflow';
    if (length > this.TARGET_MAX) return 'overflow';
    if (length < this.TARGET_MIN) return 'underflow';
    return 'ideal';
  },

  truncate(text, maxLen = this.HARD_MAX) {
    if (typeof text !== 'string') return { text: '', truncated: false, originalLen: 0 };
    const originalLen = text.length;
    if (originalLen <= maxLen) return { text, truncated: false, originalLen };
    return { text: text.substring(0, maxLen), truncated: true, originalLen };
  },

  getReport(length) {
    const status = this.getStatus(length);
    return {
      length, status, targetMin: this.TARGET_MIN, targetMax: this.TARGET_MAX, hardMax: this.HARD_MAX,
      isValid: this.validate(length), utilizationRate: Math.round((length / this.HARD_MAX) * 100),
      suggestion: status === 'overflow' ? `需减少 ${length - this.HARD_MAX} 字符` : status === 'underflow' ? `可增加 ${this.TARGET_MIN - length} 至 ${this.TARGET_MAX - length} 字符` : '长度理想',
    };
  },

  printSummary() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║ 超现实系统 Prompt 长度配置摘要 ║');
    console.log('╠════════════════════════════════════════════════════════╣');
    console.log(`║ 理想区间: [${String(this.TARGET_MIN).padStart(4)}, ${String(this.TARGET_MAX).padStart(4)}] 字符 ║`);
    console.log(`║ 硬上限: ${String(this.HARD_MAX).padEnd(36)} ║`);
    console.log(`║ 系统预留: ${(this.SYSTEM_RESERVE + ' 字符').padEnd(36)} ║`);
    console.log(`║ 安全余量: ${(this.SAFETY_MARGIN + ' 字符').padEnd(36)} ║`);
    console.log('╚════════════════════════════════════════════════════════╝\n');
  },
};

module.exports = PromptLengthConfig;

if (require.main === module) {
  const assert = require('assert');
  console.log('\n[self-test] config/prompt-length.js');
  let passed = 0, failed = 0;
  function test(name, fn) {
    try { fn(); console.log(` ✅ ${name}`); passed++; }
    catch (err) { console.error(` ❌ ${name} - ${err.message}`); failed++; }
  }
  test('TARGET_MIN = 2470', () => assert.strictEqual(PromptLengthConfig.TARGET_MIN, 2470));
  test('TARGET_MAX = 3000', () => assert.strictEqual(PromptLengthConfig.TARGET_MAX, 3000));
  test('validate(2985) = true', () => assert.strictEqual(PromptLengthConfig.validate(2985), true));
  test('validate(3001) = false', () => assert.strictEqual(PromptLengthConfig.validate(3001), false));
  test('getStatus(3001) = overflow', () => assert.strictEqual(PromptLengthConfig.getStatus(3001), 'overflow'));
  test('truncate 3000 char string', () => {
    const r = PromptLengthConfig.truncate('A'.repeat(3100));
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.text.length, 3000);
  });
  console.log(`\n 结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed > 0 ? 1 : 0);
}
