/**
 * StabilityShield - 三层稳定性护盾集成器（通用化版本）
 * 
 * 将三个护盾整合为统一的稳定性保障层：
 * - Shield 1: BaselineRegistry（确定性基线）
 * - Shield 2: LLMGateway（熔断/缓存/兜底）
 * - Shield 3: HealthMonitor（监控/自愈/补偿）
 * 
 * 设计原则：
 * - 系统不预置任何Prompt模板或业务逻辑
 * - Prompt构建器由外部注入
 * - 补偿事务由外部注册
 * - 只提供稳定性保障机制，不介入具体业务
 */

const { BaselineRegistry } = require('./baseline-registry/baseline-registry');
const { LLMGateway } = require('./llm-gateway/llm-gateway');
const { HealthMonitor } = require('./health-monitor/health-monitor');

class StabilityShield {
  constructor(config = {}) {
    this.config = config;
    
    // 初始化三个护盾
    this.baselineRegistry = new BaselineRegistry({
      registryDir: config.baselineRegistryDir || './shields/baseline-registry/templates'
    });
    
    this.llmGateway = new LLMGateway({
      primaryModel: config.primaryModel || 'default',
      backupModel: config.backupModel || 'backup',
      cacheEnabled: config.cacheEnabled !== false,
      cacheTTL: config.cacheTTL || 3600000,
      timeout: config.llmTimeout || 300000,
      fallbackGenerator: config.fallbackGenerator || null  // 外部注入兜底生成器
    });
    
    this.healthMonitor = new HealthMonitor({
      checkInterval: config.healthCheckInterval || 30000,
      latencyThreshold: config.latencyThreshold || 120000,
      successRateThreshold: config.successRateThreshold || 0.8,
      alertHandler: config.alertHandler || null  // 外部注入告警处理器
    });

    // 生产引擎引用（外部注入）
    this.productionEngine = null;
    
    // Prompt构建器（由外部注入，不硬编码）
    this.promptBuilder = config.promptBuilder || null;
    
    console.log('[StabilityShield] 🛡️ 三层稳定性护盾已初始化（通用化版本）');
  }

  /**
   * 初始化护盾（注册Agent等）
   */
  async initialize(productionEngine) {
    this.productionEngine = productionEngine;
    
    if (this.productionEngine) {
      this.healthMonitor.registerAgent('ProductionEngine', this.productionEngine);
    }

    console.log('[StabilityShield] ✅ 护盾已激活');
  }

  /**
   * 主入口：带稳定性保障的生产
   * @param {Object} requirement - 用户需求
   * @param {Object} options - 选项
   */
  async produce(requirement, options = {}) {
    const startTime = Date.now();
    
    try {
      // ========== Shield 1: 基线模板 ==========
      const baselineMatch = this.baselineRegistry.findBestMatch(requirement);
      const { type, template, isHotStart } = baselineMatch;

      console.log(`[StabilityShield] ${isHotStart ? '🔥 热启动' : '❄️ 冷启动'}`);

      let productionInput;

      if (isHotStart && template) {
        productionInput = await this._hotStartProduction(requirement, template, options);
      } else {
        productionInput = await this._coldStartProduction(requirement, options);
      }

      // ========== Shield 2: LLM Gateway ==========
      // LLM调用已在底层通过Gateway
      
      // ========== Shield 3: Health Monitor ==========
      // 补偿事务已由外部注册

      // 执行生产
      const result = await this._executeProduction(productionInput);

      this.healthMonitor.recordCall('ProductionEngine', true, Date.now() - startTime);

      return {
        success: true,
        data: result,
        mode: isHotStart ? 'hot-start' : 'cold-start',
        baselineUsed: template?.id || null,
        latency: Date.now() - startTime
      };

    } catch (error) {
      this.healthMonitor.recordCall('ProductionEngine', false, Date.now() - startTime);
      
      await this.healthMonitor.compensate('ProductionEngine');

      return {
        success: false,
        error: error.message,
        latency: Date.now() - startTime
      };
    }
  }

  /**
   * 热启动：基线 + LLM增量
   */
  async _hotStartProduction(requirement, template, options) {
    console.log('[StabilityShield] 🔥 热启动：加载基线模板 + LLM增量生成');

    // 提取增量字段（由外部定义哪些字段需要增量生成）
    const deltaFields = options.deltaFields || Object.keys(template.deltaFields || {});
    const deltaRequirement = {};
    for (const key of deltaFields) {
      if (requirement[key] !== undefined) {
        deltaRequirement[key] = requirement[key];
      }
    }

    // 通过LLM Gateway生成增量
    let llmResult;
    if (this.promptBuilder && typeof this.promptBuilder.buildDelta === 'function') {
      const deltaPrompt = this.promptBuilder.buildDelta(deltaRequirement, template);
      llmResult = await this.llmGateway.call(deltaPrompt, { timeout: 120000 });
    } else {
      // 没有外部Prompt构建器，直接传递增量字段
      llmResult = { success: true, data: deltaRequirement };
    }

    if (!llmResult.success) {
      console.warn('[StabilityShield] ⚠️ LLM增量生成失败，使用基线兜底');
      return this.baselineRegistry.merge(template, {});
    }

    // 合并基线 + LLM增量
    const merged = this.baselineRegistry.merge(template, llmResult.data);
    
    return merged;
  }

  /**
   * 冷启动：全LLM生成
   */
  async _coldStartProduction(requirement, options) {
    console.log('[StabilityShield] ❄️ 冷启动：全LLM生成');

    let llmResult;
    if (this.promptBuilder && typeof this.promptBuilder.buildFull === 'function') {
      const fullPrompt = this.promptBuilder.buildFull(requirement);
      llmResult = await this.llmGateway.call(fullPrompt, { timeout: 300000 });
    } else {
      // 没有外部Prompt构建器，直接传递需求
      llmResult = { success: true, data: requirement };
    }

    if (!llmResult.success) {
      throw new Error(`冷启动失败: ${llmResult.error}`);
    }

    return llmResult.data;
  }

  /**
   * 执行实际生产（调用ProductionEngine）
   */
  async _executeProduction(input) {
    if (!this.productionEngine) {
      throw new Error('ProductionEngine未注入');
    }

    return await this.productionEngine.produce(input);
  }

  /**
   * 注册基线模板（外部审核通过后调用）
   * @param {string} type - 类型标识（由外部定义）
   * @param {string} version - 版本号
   * @param {Object} baseline - 基线数据
   * @param {Object} metadata - 元数据（由外部提供）
   */
  async registerBaseline(type, version, baseline, metadata) {
    return this.baselineRegistry.register(type, version, baseline, metadata);
  }

  /**
   * 注册补偿事务（由外部调用）
   * @param {string} stageId - Stage标识
   * @param {Function} compensateFn - 补偿函数
   */
  registerCompensation(stageId, compensateFn) {
    this.healthMonitor.registerCompensation(stageId, compensateFn);
  }

  /**
   * 获取护盾状态
   */
  getStatus() {
    return {
      baseline: {
        templates: this.baselineRegistry.list().length,
        cacheSize: this.baselineRegistry.cache.size
      },
      llmGateway: this.llmGateway.getStats(),
      health: this.healthMonitor.getStats()
    };
  }
}

module.exports = { StabilityShield };
