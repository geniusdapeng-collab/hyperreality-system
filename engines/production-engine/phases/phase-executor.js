/**
 * Phase 执行器基类
 * 生产引擎内部使用
 * 
 * 设计原则：
 * - 每个 Phase 独立文件，职责单一
 * - 通过依赖注入获取必要服务（不直接依赖 ProductionEngine）
 * - 返回 { success, shots, result, timing, error } 标准结构
 */

class PhaseExecutor {
  constructor(options = {}) {
    this.name = options.name || 'unnamed-phase';
    this.agents = options.agents || {};
    this.logFn = options.logFn || console.log;
    this.saveCheckpoint = options.saveCheckpoint || (async () => {});
    this.canAfford = options.canAfford || (() => true);
    this.budgetRemaining = options.budgetRemaining || (() => Infinity);
    this.checkMemory = options.checkMemory || (() => {});
    this.cloneShots = options.cloneShots || ((s) => JSON.parse(JSON.stringify(s)));
    this.mergeShots = options.mergeShots || ((a, b, fields) => a);
  }

  log(stage, message) {
    this.logFn(stage, `[${this.name}] ${message}`);
  }

  /**
   * 执行 Phase（子类必须实现）
   * @param {object} state - 当前状态 { shots, result, adaptedBlueprint }
   * @returns {Promise<object>} { success, shots, result, timing, error }
   */
  async execute(state) {
    throw new Error(`Phase ${this.name} 必须实现 execute() 方法`);
  }

  /**
   * 检查预算
   * @param {number} needMs - 所需毫秒
   * @param {string} phaseLabel - Phase 标识
   * @returns {boolean} 是否可继续
   */
  checkBudget(needMs, phaseLabel) {
    if (!this.canAfford(needMs)) {
      this.log('BUDGET', `⚠️ 预算不足(剩${this.budgetRemaining()}ms)，${phaseLabel} 跳过`);
      return false;
    }
    return true;
  }
}

module.exports = { PhaseExecutor };
