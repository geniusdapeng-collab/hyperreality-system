/**
 * Phase 3.5: 字段质量检查与修复（自适应预算）
 * 
 * 职责：
 * - 根据剩余预算自适应选择检查模式
 * - <15s: 跳过
 * - 15s-60s: 纯规则检查
 * - 60s-300s: 规则+LLM 1轮
 * - ≥300s: 规则+LLM 2轮
 */

const { PhaseExecutor } = require('./phase-executor');

class Phase35FieldQuality extends PhaseExecutor {
  constructor(options) {
    super({ name: 'Phase3.5-FieldQuality', ...options });
    this.llmModel = options.llmModel || 'kimi-k2p6';
    this.globalDeadline = options.globalDeadline || null;
  }

  async execute(state) {
    const { shots, result, adaptedBlueprint } = state;
    const startTime = Date.now();
    const remainingBudget = this.budgetRemaining();

    // 预算分级决策
    if (remainingBudget < 15000) {
      this.log('FIELD-QUALITY', `⚠️ 预算不足(剩${remainingBudget}ms),跳过字段质量检查`);
      return { success: true, shots, result, timing: 0 };
    }

    try {
      let mode, maxRounds, checkerTimeout, repairerTimeout;
      
      if (remainingBudget < 60000) {
        // 15s-60s: 纯规则检查
        mode = '纯规则';
        maxRounds = 0;
        checkerTimeout = 30000;
        repairerTimeout = 0;
      } else if (remainingBudget < 300000) {
        // 60s-300s: LLM检查1轮
        mode = '规则+LLM 1轮';
        maxRounds = 1;
        checkerTimeout = 60000;
        repairerTimeout = 120000;
      } else {
        // ≥300s: LLM检查2轮
        mode = '规则+LLM 2轮';
        maxRounds = 2;
        checkerTimeout = 120000;
        repairerTimeout = 180000;
      }

      this.log('FIELD-QUALITY', `开始(${mode}检查模式)...`);
      
      const { FieldQualityPipeline } = require('../../field-quality');
      const pipeline = new FieldQualityPipeline({
        llmModel: this.llmModel,
        maxRounds,
        checkerTimeout,
        repairerTimeout,
      });
      
      pipeline.setPRDFromBlueprint(adaptedBlueprint);
      if (this.globalDeadline) {
        pipeline.setDeadline?.(this.globalDeadline);
      }
      
      const { finalShots, summary } = await pipeline.runAll(shots);
      
      // 【P1-8 修复】Phase3.5 成功后保存 checkpoint
      await this.saveCheckpoint('phase3.5', finalShots, { opening: result.opening, llmStats: result.llmStats });
      
      const timing = Date.now() - startTime;
      this.log('FIELD-QUALITY', `完成 (${timing}ms) | 通过:${summary.passed}/${summary.totalShots} | 修复:${summary.totalRepairs} (${mode})`);

      return { success: true, shots: finalShots, result, timing };
    } catch (e) {
      this.log('FIELD-QUALITY-FAIL', `❌ ${e.message},继续执行`);
      return { success: false, shots, result, timing: Date.now() - startTime, error: e.message };
    }
  }
}

module.exports = { Phase35FieldQuality };
