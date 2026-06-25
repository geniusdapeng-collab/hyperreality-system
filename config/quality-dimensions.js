'use strict';

/**
 * 质量维度定义模块
 * 超现实系统适配版 v1.0
 *
 * 6维度质量评分体系：
 * 1. Prompt质量 - 文本精确性、完整性、表现力
 * 2. 故事质量 - 叙事结构、角色发展、情感共鸣
 * 3. 连续性质量 - 跨镜头一致性、角色连贯
 * 4. 导演质量 - 运镜设计、画面构图、节奏控制
 * 5. 渲染就绪度 - 输出是否可直接用于渲染
 * 6. 系统完整性 - 元数据、日志、可追溯性
 */

const QualityDimensions = {
  dimensions: {
    promptQuality: {
      name: 'Prompt质量',
      weight: 0.2,
      passScore: 70,
      warnScore: 55,
      description: 'Prompt文本的精确性、完整性与视觉表现力',
    },
    storyQuality: {
      name: '故事质量',
      weight: 0.2,
      passScore: 70,
      warnScore: 55,
      description: '叙事结构完整性、角色发展与情感共鸣力',
    },
    continuityQuality: {
      name: '连续性质量',
      weight: 0.15,
      passScore: 70,
      warnScore: 55,
      description: '跨镜头角色一致性、场景连贯性与时间线连续性',
    },
    directorQuality: {
      name: '导演质量',
      weight: 0.2,
      passScore: 75,
      warnScore: 60,
      description: '运镜设计专业性、画面构图与节奏控制',
    },
    renderReadiness: {
      name: '渲染就绪度',
      weight: 0.15,
      passScore: 80,
      warnScore: 60,
      description: '输出格式、参数完整度与可直接渲染的程度',
    },
    systemIntegrity: {
      name: '系统完整性',
      weight: 0.1,
      passScore: 90,
      warnScore: 70,
      description: '元数据完整性、日志规范性与全流程可追溯性',
    },
  },

  total: {
    passScore: 75,
    warnScore: 60,
  },

  hardBlockRules: {
    requireSystemIntegrity: true,
    requireRenderReadiness: true,
    requirePromptText: true,
    requireShots: true,
    requireTotalPass: true,
  },

  getDimension(dimKey) {
    if (!dimKey || typeof dimKey !== 'string') return null;
    return this.dimensions[dimKey] || null;
  },

  calculateTotal(scores = {}) {
    let total = 0;
    const weighted = {};
    const details = [];

    for (const [key, config] of Object.entries(this.dimensions)) {
      const score = typeof scores[key] === 'number' ? scores[key] : 0;
      const weightedScore = score * config.weight;
      total += weightedScore;
      weighted[key] = parseFloat(weightedScore.toFixed(2));

      const status = score >= config.passScore ? 'pass' : score >= config.warnScore ? 'warn' : 'fail';
      details.push({ key, name: config.name, score, weight: config.weight, weighted: weighted[key], passScore: config.passScore, warnScore: config.warnScore, status });
    }

    total = parseFloat(total.toFixed(2));
    const overallStatus = total >= this.total.passScore ? 'pass' : total >= this.total.warnScore ? 'warn' : 'fail';

    return { total, weighted, details, overallStatus, passed: overallStatus === 'pass' };
  },

  checkHardBlock(checkData = {}) {
    const { scores = {}, hasPromptText = false, hasShots = false } = checkData;
    const reasons = [];

    if (this.hardBlockRules.requireSystemIntegrity) {
      const siScore = scores.systemIntegrity || 0;
      if (siScore < this.dimensions.systemIntegrity.passScore) {
        reasons.push(`系统完整性 ${siScore} 分，低于及格线 ${this.dimensions.systemIntegrity.passScore}`);
      }
    }

    if (this.hardBlockRules.requireRenderReadiness) {
      const rrScore = scores.renderReadiness || 0;
      if (rrScore < this.dimensions.renderReadiness.passScore) {
        reasons.push(`渲染就绪度 ${rrScore} 分，低于及格线 ${this.dimensions.renderReadiness.passScore}`);
      }
    }

    if (this.hardBlockRules.requirePromptText && !hasPromptText) {
      reasons.push('缺少 Prompt 文本');
    }

    if (this.hardBlockRules.requireShots && !hasShots) {
      reasons.push('缺少镜头定义');
    }

    if (this.hardBlockRules.requireTotalPass) {
      const result = this.calculateTotal(scores);
      if (result.total < this.total.passScore) {
        reasons.push(`总分 ${result.total} 分，低于及格线 ${this.total.passScore}`);
      }
    }

    const blocked = reasons.length > 0;
    if (blocked) {
      console.warn(`[QualityDimensions] 硬拦截触发: ${reasons.join('; ')}`);
    }
    return { blocked, reasons };
  },

  validateWeights() {
    const sum = Object.values(this.dimensions).reduce((acc, d) => acc + d.weight, 0);
    return { valid: Math.abs(sum - 1.0) < 0.001, sum: parseFloat(sum.toFixed(4)) };
  },

  getSummary(scores = {}) {
    const result = this.calculateTotal(scores);
    const hardBlock = this.checkHardBlock({ scores, hasPromptText: true, hasShots: true });
    return {
      overallScore: result.total,
      status: result.overallStatus,
      passed: result.passed && !hardBlock.blocked,
      hardBlocked: hardBlock.blocked,
      hardBlockReasons: hardBlock.reasons,
      dimensions: result.details,
      totalThreshold: this.total,
    };
  },

  printSummary() {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║ 超现实系统质量维度配置摘要 ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    for (const [key, config] of Object.entries(this.dimensions)) {
      console.log(`║ ${config.name.padEnd(10)} 权重:${String(config.weight).padEnd(5)} 及格:${String(config.passScore).padEnd(4)} 警告:${String(config.warnScore).padEnd(4)} ║`);
    }
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ 总分及格线: ${String(this.total.passScore).padEnd(6)} 总分警告线: ${String(this.total.warnScore).padEnd(6)} ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  },
};

module.exports = QualityDimensions;

if (require.main === module) {
  const assert = require('assert');
  console.log('\n[self-test] config/quality-dimensions.js');
  let passed = 0, failed = 0;
  function test(name, fn) {
    try { fn(); console.log(` ✅ ${name}`); passed++; }
    catch (err) { console.error(` ❌ ${name} - ${err.message}`); failed++; }
  }
  test('6个维度', () => assert.strictEqual(Object.keys(QualityDimensions.dimensions).length, 6));
  test('权重和=1', () => assert.strictEqual(QualityDimensions.validateWeights().valid, true));
  test('calculateTotal', () => {
    const r = QualityDimensions.calculateTotal({ promptQuality: 80, storyQuality: 80, continuityQuality: 80, directorQuality: 80, renderReadiness: 82, systemIntegrity: 95 });
    assert.strictEqual(r.overallStatus, 'pass');
  });
  test('hardBlock', () => {
    const r = QualityDimensions.checkHardBlock({ scores: { systemIntegrity: 50, renderReadiness: 85 }, hasPromptText: true, hasShots: true });
    assert.strictEqual(r.blocked, true);
  });
  console.log(`\n 结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed > 0 ? 1 : 0);
}
