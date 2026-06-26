/**
 * LLMGateway - LLM网关护盾（通用化版本）
 * 
 * 核心职责：
 * 1. 熔断器：连续失败自动切换兜底模型
 * 2. 响应缓存：相同输入零延迟返回
 * 3. 多模型负载均衡：主模型/备用模型/规则兜底
 * 4. 超时控制：防止LLM挂起导致系统阻塞
 * 
 * 设计原则：
 * - 所有LLM调用必须经过此网关
 * - 失败时自动降级，不抛异常到上层
 * - 缓存命中时零延迟返回
 * - 兜底规则不返回具体业务内容，只返回最小必要结构
 */

const fs = require('fs');
const crypto = require('crypto');

class LLMGateway {
  constructor(options = {}) {
    // 模型配置（由外部传入，不硬编码具体模型）
    this.models = {
      primary: options.primaryModel || 'default',
      backup: options.backupModel || 'backup',
      fallback: options.fallbackModel || 'fallback'
    };

    // 熔断器配置
    this.circuitBreaker = {
      failureThreshold: options.failureThreshold || 5,
      recoveryTimeout: options.recoveryTimeout || 30000,
      halfOpenMaxCalls: options.halfOpenMaxCalls || 3,
      state: 'CLOSED',
      failureCount: 0,
      lastFailureTime: null,
      successCount: 0
    };

    // 缓存配置
    this.cache = new Map();
    this.cacheEnabled = options.cacheEnabled !== false;
    this.cacheTTL = options.cacheTTL || 3600000;
    this.cacheMaxSize = options.cacheMaxSize || 1000;

    // 超时配置
    this.timeout = options.timeout || 300000;

    // 统计
    this.stats = {
      totalCalls: 0,
      cacheHits: 0,
      failures: 0,
      fallbackCalls: 0,
      avgLatency: 0
    };

    // 兜底规则生成器（由外部注入，不内置具体业务逻辑）
    this.fallbackGenerator = options.fallbackGenerator || null;

    // 清理过期缓存的定时器
    this._startCacheCleanup();
  }

  /**
   * 主入口：调用LLM
   * @param {string} prompt - 输入prompt
   * @param {Object} options - 调用选项
   * @returns {Promise<Object>} { success, data, source, latency }
   */
  async call(prompt, options = {}) {
    const startTime = Date.now();
    this.stats.totalCalls++;

    try {
      // 1. 检查缓存
      if (this.cacheEnabled) {
        const cached = this._getFromCache(prompt);
        if (cached) {
          this.stats.cacheHits++;
          return {
            success: true,
            data: cached.data,
            source: 'cache',
            latency: Date.now() - startTime
          };
        }
      }

      // 2. 检查熔断器状态
      if (this.circuitBreaker.state === 'OPEN') {
        if (Date.now() - this.circuitBreaker.lastFailureTime > this.circuitBreaker.recoveryTimeout) {
          console.log('[LLMGateway] 熔断器进入半开状态，尝试恢复');
          this.circuitBreaker.state = 'HALF_OPEN';
          this.circuitBreaker.successCount = 0;
        } else {
          console.log('[LLMGateway] 熔断器开启，直接走兜底');
          return this._fallback(prompt, options, startTime);
        }
      }

      // 3. 主模型调用
      let result;
      try {
        result = await this._callWithTimeout(
          () => this._callPrimaryModel(prompt, options),
          options.timeout || this.timeout
        );

        this._onSuccess();

        if (this.cacheEnabled) {
          this._setCache(prompt, result);
        }

        const latency = Date.now() - startTime;
        this._updateLatency(latency);

        return {
          success: true,
          data: result,
          source: this.models.primary,
          latency
        };

      } catch (primaryError) {
        console.warn(`[LLMGateway] 主模型失败: ${primaryError.message}`);
        this._onFailure();

        // 4. 备用模型调用
        try {
          result = await this._callWithTimeout(
            () => this._callBackupModel(prompt, options),
            options.timeout || this.timeout
          );

          console.log('[LLMGateway] 备用模型调用成功');

          if (this.cacheEnabled) {
            this._setCache(prompt, result);
          }

          const latency = Date.now() - startTime;
          this._updateLatency(latency);

          return {
            success: true,
            data: result,
            source: this.models.backup,
            latency
          };

        } catch (backupError) {
          console.warn(`[LLMGateway] 备用模型也失败: ${backupError.message}`);
          this._onFailure();

          // 5. 兜底规则
          return this._fallback(prompt, options, startTime);
        }
      }

    } catch (error) {
      this.stats.failures++;
      return {
        success: false,
        error: error.message,
        source: 'error',
        latency: Date.now() - startTime
      };
    }
  }

  /**
   * 批量调用（并行）
   */
  async callBatch(prompts, options = {}) {
    const concurrency = options.concurrency || 3;
    const results = [];

    for (let i = 0; i < prompts.length; i += concurrency) {
      const batch = prompts.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(p => this.call(p, options))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * 主模型调用（实际LLM调用）
   */
  async _callPrimaryModel(prompt, options) {
    const model = options.model || this.models.primary;
    
    if (global.llmAdapter) {
      return await global.llmAdapter.generate(prompt, { model, ...options });
    }

    throw new Error('LLM adapter not configured');
  }

  /**
   * 备用模型调用
   */
  async _callBackupModel(prompt, options) {
    const model = this.models.backup;
    
    if (global.llmAdapter) {
      return await global.llmAdapter.generate(prompt, { model, ...options });
    }

    throw new Error('LLM adapter not configured');
  }

  /**
   * 兜底规则
   */
  _fallback(prompt, options, startTime) {
    this.stats.fallbackCalls++;
    console.log('[LLMGateway] 🛡️ 触发兜底');

    // 如果外部注入了兜底生成器，使用它
    if (this.fallbackGenerator && typeof this.fallbackGenerator === 'function') {
      const fallbackResult = this.fallbackGenerator(prompt, options);
      return {
        success: true,
        data: fallbackResult,
        source: 'fallback-custom',
        latency: Date.now() - startTime,
        isFallback: true
      };
    }

    // 默认兜底：返回空对象，不返回任何具体业务内容
    return {
      success: true,
      data: {},
      source: 'fallback-empty',
      latency: Date.now() - startTime,
      isFallback: true
    };
  }

  /**
   * 带超时的调用
   */
  _callWithTimeout(fn, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`LLM调用超时(${timeoutMs}ms)`));
      }, timeoutMs);

      Promise.resolve(fn())
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * 熔断器：成功处理
   */
  _onSuccess() {
    if (this.circuitBreaker.state === 'HALF_OPEN') {
      this.circuitBreaker.successCount++;
      if (this.circuitBreaker.successCount >= this.circuitBreaker.halfOpenMaxCalls) {
        console.log('[LLMGateway] 熔断器关闭，服务恢复');
        this.circuitBreaker.state = 'CLOSED';
        this.circuitBreaker.failureCount = 0;
      }
    } else {
      this.circuitBreaker.failureCount = 0;
    }
  }

  /**
   * 熔断器：失败处理
   */
  _onFailure() {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();

    if (this.circuitBreaker.failureCount >= this.circuitBreaker.failureThreshold) {
      console.warn(`[LLMGateway] ⚠️ 熔断器开启！连续失败${this.circuitBreaker.failureCount}次`);
      this.circuitBreaker.state = 'OPEN';
    }
  }

  /**
   * 缓存：获取
   */
  _getFromCache(prompt) {
    const key = this._hashPrompt(prompt);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  /**
   * 缓存：设置
   */
  _setCache(prompt, data) {
    if (this.cache.size >= this.cacheMaxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    const key = this._hashPrompt(prompt);
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * 缓存：清理过期条目
   */
  _startCacheCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache.entries()) {
        if (now - entry.timestamp > this.cacheTTL) {
          this.cache.delete(key);
        }
      }
    }, 60000);
  }

  /**
   * Prompt哈希（用于缓存键）
   */
  _hashPrompt(prompt) {
    return crypto.createHash('md5').update(String(prompt)).digest('hex');
  }

  /**
   * 更新平均延迟
   */
  _updateLatency(latency) {
    const alpha = 0.1;
    this.stats.avgLatency = this.stats.avgLatency * (1 - alpha) + latency * alpha;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      circuitBreaker: {
        state: this.circuitBreaker.state,
        failureCount: this.circuitBreaker.failureCount
      },
      cacheSize: this.cache.size
    };
  }

  /**
   * 重置熔断器（手动恢复）
   */
  resetCircuitBreaker() {
    this.circuitBreaker.state = 'CLOSED';
    this.circuitBreaker.failureCount = 0;
    console.log('[LLMGateway] 熔断器已手动重置');
  }
}

module.exports = { LLMGateway };
