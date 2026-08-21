/**
 * LLMGatewayAdapter - LLM 网关适配器
 * 将现有 Agent 的直接 LLM 调用路由到 LLMGateway，启用熔断/缓存/兜底
 */
const { LLMGateway } = require('./llm-gateway');

class LLMGatewayAdapter {
  constructor(options = {}) {
    this.gateway = new LLMGateway({
      primaryModel: options.primaryModel || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6',
      backupModel: options.backupModel || 'kimi-k2p6',
      failureThreshold: 3,
      recoveryTimeout: 30000,
      cacheEnabled: true,
      cacheTTL: 300000,
      timeout: options.timeout || 300000,
      ...options
    });
    this.enabled = options.enabled !== false;
    this.stats = { calls: 0, cacheHits: 0, fallbacks: 0, failures: 0 };
  }

  async call(directCallFn, prompt, options = {}) {
    if (!this.enabled) return directCallFn(prompt, options);

    this.stats.calls++;
    const startTime = Date.now();

    const result = await this.gateway.call(prompt, {
      timeout: options.timeout,
      model: options.model
    });

    if (result.source === 'cache') this.stats.cacheHits++;
    if (result.isFallback) this.stats.fallbacks++;

    if (!result.success) {
      this.stats.failures++;
      console.warn(`[LLMGatewayAdapter] 网关失败，降级到直接调用: ${result.error}`);
      return directCallFn(prompt, options);
    }

    return result.data;
  }

  async callBatch(callFns, options = {}) {
    const concurrency = options.concurrency || 2;
    const results = [];
    for (let i = 0; i < callFns.length; i += concurrency) {
      const batch = callFns.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((fn) => this.call(fn.fn, fn.prompt, fn.options).catch((err) => ({ error: err.message, success: false })))
      );
      results.push(...batchResults);
    }
    return results;
  }

  getStats() {
    return { ...this.stats, gatewayStats: this.gateway.getStats() };
  }

  reset() {
    this.stats = { calls: 0, cacheHits: 0, fallbacks: 0, failures: 0 };
    this.gateway.resetCircuitBreaker();
  }
}

module.exports = { LLMGatewayAdapter };
