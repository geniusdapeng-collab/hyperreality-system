/**
 * StabilityShield - 三层稳定性护盾集成器
 * 
 * 将三个护盾整合为统一的稳定性保障层：
 * - Shield 1: BaselineRegistry（确定性基线）
 * - Shield 2: LLMGateway（熔断/缓存/兜底）
 * - Shield 3: HealthMonitor（监控/自愈/补偿）
 * 
 * 使用方式：
 * const shield = new StabilityShield(config);
 * await shield.initialize();
 * 
 * // 生产时
 * const result = await shield.produce(requirement);
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
      primaryModel: config.primaryModel || 'kimi-k2p6',
      backupModel: config.backupModel || 'kimi-k2p5',
      cacheEnabled: config.cacheEnabled !== false,
      cacheTTL: config.cacheTTL || 3600000,
      timeout: config.llmTimeout || 300000
    });
    
    this.healthMonitor = new HealthMonitor({
      checkInterval: config.healthCheckInterval || 30000,
      latencyThreshold: config.latencyThreshold || 120000,
      successRateThreshold: config.successRateThreshold || 0.8
    });

    // 生产引擎引用（外部注入）
    this.productionEngine = null;
    
    console.log('[StabilityShield] 🛡️ 三层稳定性护盾已初始化');
  }

  /**
   * 初始化护盾（注册Agent等）
   */
  async initialize(productionEngine) {
    this.productionEngine = productionEngine;
    
    // 注册生产引擎到健康监控
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
      const { category, template, isHotStart } = baselineMatch;

      console.log(`[StabilityShield] ${isHotStart ? '🔥 热启动' : '❄️ 冷启动'}: ${category}`);

      let productionInput;

      if (isHotStart && template) {
        // 热启动：基线 + LLM增量
        productionInput = await this._hotStartProduction(requirement, template);
      } else {
        // 冷启动：全LLM生成
        productionInput = await this._coldStartProduction(requirement, category);
      }

      // ========== Shield 2: LLM Gateway ==========
      // 所有LLM调用都经过Gateway（已在各Agent内部集成）
      
      // ========== Shield 3: Health Monitor ==========
      // 注册补偿事务
      this._registerCompensations();

      // 执行生产
      const result = await this._executeProduction(productionInput);

      // 记录成功
      this.healthMonitor.recordCall('ProductionEngine', true, Date.now() - startTime);

      return {
        success: true,
        data: result,
        mode: isHotStart ? 'hot-start' : 'cold-start',
        baselineUsed: template?.id || null,
        latency: Date.now() - startTime
      };

    } catch (error) {
      // 记录失败
      this.healthMonitor.recordCall('ProductionEngine', false, Date.now() - startTime);
      
      // 触发补偿
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
  async _hotStartProduction(requirement, template) {
    console.log('[StabilityShield] 🔥 热启动：加载基线模板 + LLM增量生成');

    // 1. 提取创意字段（需要LLM生成的部分）
    const deltaRequirement = {
      scene: requirement.scene,
      action: requirement.action,
      dialogue: requirement.dialogue,
      camera: requirement.camera,
      mood: requirement.mood,
      lighting: requirement.lighting,
      _category: template.category
    };

    // 2. 通过LLM Gateway生成增量（只生成20%字段）
    const llmResult = await this.llmGateway.call(
      this._buildDeltaPrompt(deltaRequirement),
      { timeout: 120000 }
    );

    if (!llmResult.success) {
      console.warn('[StabilityShield] ⚠️ LLM增量生成失败，使用基线兜底');
      // 失败时只返回基线（无增量）
      return this.baselineRegistry.merge(template, {});
    }

    // 3. 合并基线 + LLM增量
    const merged = this.baselineRegistry.merge(template, llmResult.data);
    
    return merged;
  }

  /**
   * 冷启动：全LLM生成
   */
  async _coldStartProduction(requirement, category) {
    console.log('[StabilityShield] ❄️ 冷启动：全LLM生成');

    // 全量LLM生成（走Gateway）
    const llmResult = await this.llmGateway.call(
      this._buildFullPrompt(requirement),
      { timeout: 300000 }
    );

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

    // 这里调用实际的生产引擎
    return await this.productionEngine.produce(input);
  }

  /**
   * 注册基线模板（审核通过后调用）
   */
  async registerBaseline(category, version, projectOutput, approval) {
    const extracted = this.baselineRegistry.extractFromProject(projectOutput);
    if (!extracted) {
      throw new Error('无法从项目输出中提取基线');
    }

    return this.baselineRegistry.register(category, version, extracted.lockedFields, approval);
  }

  /**
   * 构建增量Prompt（只生成变化的部分）
   */
  _buildDeltaPrompt(requirement) {
    return `
请根据以下需求生成视频镜头的创意字段（只返回变化的字段）：

题材类型: ${requirement._category || 'general'}
场景描述: ${requirement.scene || '待生成'}
动作描述: ${requirement.action || '待生成'}
台词内容: ${requirement.dialogue || '待生成'}
运镜方式: ${requirement.camera || '待生成'}
情绪基调: ${requirement.mood || '待生成'}
灯光设置: ${requirement.lighting || '待生成'}

请只返回以下JSON格式的增量字段：
{
  "scene": "...",
  "action": "...",
  "dialogue": "...",
  "camera": "...",
  "mood": "...",
  "lighting": "..."
}
`;
  }

  /**
   * 构建完整Prompt（冷启动）
   */
  _buildFullPrompt(requirement) {
    return `
请根据以下需求生成完整的视频镜头方案：

${JSON.stringify(requirement, null, 2)}

请返回完整的镜头方案，包含所有必要字段。
`;
  }

  /**
   * 注册补偿事务
   */
  _registerCompensations() {
    // 注册各Stage的补偿方法
    this.healthMonitor.registerCompensation('SceneDesign', async () => {
      console.log('[Compensate] 清理SceneDesign产物');
      // 清理临时文件
    });

    this.healthMonitor.registerCompensation('PromptFusion', async () => {
      console.log('[Compensate] 清理PromptFusion产物');
      // 清理生成的prompt文件
    });

    this.healthMonitor.registerCompensation('Rendering', async () => {
      console.log('[Compensate] 清理Rendering产物');
      // 清理渲染输出
    });
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
