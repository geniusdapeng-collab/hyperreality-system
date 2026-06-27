/**
 * LLM Agent 基类（v2.0.1 并行优化版）
 * - 模型按 Agent 透传（修复原 loadLLMEngine 写死 kimi-k2p6 的 bug）
 * - 全局截止时间（deadline）感知：单次超时 = min(自身超时, 剩余预算)
 * - 预算不足时提前降级，防止单个 Agent 拖垮全局链路
 */
const path = require('path');

// 从环境变量读取模型配置，消除硬编码
const DEFAULT_MODEL = process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6';
const DEFAULT_FAST_MODEL = process.env.STORMAXE_LLM_FAST_MODEL || DEFAULT_MODEL;

function loadLLMEngine(model, maxTokens) {
  try {
    const SYSTEMS_PATH = path.join(__dirname, '../../../../systems');
    const LLMClass = require(path.join(SYSTEMS_PATH, 'llm-reasoning-engine.js'))?.LLMEngine;
    if (!LLMClass) {
      console.warn('[BaseAgent] LLMEngine类加载失败');
      return null;
    }
    return new LLMClass({ model: model || DEFAULT_MODEL, maxTokens: maxTokens || 16000 });
  } catch (e) {
    console.warn(`[BaseAgent] LLM引擎加载失败: ${e.message}`);
    return null;
  }
}

class BaseAgent {
  constructor(options = {}) {
    this.name = options.name || 'BaseAgent';
    this.llmTimeout = options.llmTimeout || 300000; // 单次调用上限 5 分钟（足以覆盖最慢的 VisualLanguage 258s）
    this.llmMaxRetries = options.llmMaxRetries ?? 2; // 重试收敛到 2 次（原 3 次是隐藏时间炸弹）
    this.llmModel = options.llmModel || DEFAULT_MODEL; // 修复：用环境变量
    this.llmMaxTokens = options.llmMaxTokens || 16000;
    this.enabled = options.enabled !== false;

    this._llmEngine = null;
    this._llmEngineLoaded = false;
    this._globalDeadline = null; // 全局截止时间戳（由 ProductionEngine 下发）
  }

  /** 由 ProductionEngine 下发全局截止时间 */
  setDeadline(deadlineMs) { this._globalDeadline = deadlineMs || null; }

  /** 当前剩余预算（ms），至少保留 10s */
  _remainingMs() {
    if (!this._globalDeadline) return this.llmTimeout;
    return Math.max(10000, this._globalDeadline - Date.now());
  }

  _getLLMEngine() {
    if (!this._llmEngineLoaded) {
      this._llmEngine = loadLLMEngine(this.llmModel, this.llmMaxTokens);
      this._llmEngineLoaded = true;
      if (this._llmEngine) {
        console.log(`[${this.name}] LLM引擎加载成功 | model=${this.llmModel}`);
      } else {
        console.warn(`[${this.name}] LLM引擎不可用，将使用降级模式`);
      }
    }
    return this._llmEngine;
  }

  /**
   * 【v2.1.4-fix13】通用超时包装器 — 核心修复
   * 任何 Promise 都可以用这个包装，确保不会无限等待
   */
  /**
   * 【审计修复·核心】通用超时包装器
   * 关键修复：超时后底层 promise 仍在跑，其迟到的 rejection 会变成 unhandledRejection
   * 导致 Node 进程崩溃。这里给原 promise 挂一个 no-op catch 标记其已被处理，
   * 同时不影响 race 的正常 reject 传播。
   */
  _callWithTimeout(promise, timeoutMs, label = 'LLM调用') {
    // 防御 NaN/Infinity/非数字（setTimeout(NaN/Infinity) 会被当 0 立即触发，反而无害；
    // 但若被篡改成巨大值则需兜底）
    const ms = (typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs < 24 * 3600 * 1000)
      ? timeoutMs : 300000;
    let timer;
    let settled = false;
    const p = Promise.resolve(promise);
    // 立即挂 catch：标记 rejection 已被处理，防止超时后悬空 rejection 崩溃进程
    p.catch(() => {});
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn(`[${label}] ⏱️ 外层超时触发(${ms}ms)，强制降级`);
        reject(new Error(`${label}超时(${ms}ms)`));
      }, ms);
    });
    return Promise.race([p, timeoutPromise])
      .then(v => { settled = true; clearTimeout(timer); return v; },
            e => { settled = true; clearTimeout(timer); throw e; });
  }

  /**
   * 核心LLM调用方法（带重试+降级+截止时间感知+外层超时+Schema校验）
   * 【审计修复】支持第4参数 options: { maxRetries, maxTokens } 覆盖单次调用配置
   */
  async _callLLM(prompt, schema, fallbackFn, options = {}) {
    if (!this.enabled) {
      console.log(`[${this.name}] Agent已禁用，使用降级`);
      return this._executeFallback(fallbackFn, 'Agent disabled');
    }

    const llm = this._getLLMEngine();
    if (!llm) {
      console.warn(`[${this.name}] LLM引擎不可用，使用降级`);
      return this._executeFallback(fallbackFn, 'LLM engine not available');
    }

    // 单次调用可覆盖 maxTokens（补齐等轻量场景用小预算）
    const callMaxTokens = options.maxTokens || this.llmMaxTokens;
    const callMaxRetries = options.maxRetries ?? this.llmMaxRetries;
    // 支持 options.timeoutMs 覆盖单次超时（补齐等轻量场景用小预算）
    const baseTimeout = options.timeoutMs || this.llmTimeout;
    const perCallTimeout = Math.min(baseTimeout, this._remainingMs());
    console.log(`[${this.name}] _callLLM 进入 | perCallTimeout=${perCallTimeout}ms maxTokens=${callMaxTokens} retries=${callMaxRetries} remaining=${this._remainingMs()}ms`);

    if (perCallTimeout < 20000) {
      console.warn(`[${this.name}] 剩余预算不足(${perCallTimeout}ms)，提前降级以保住全局链路`);
      return this._executeFallback(fallbackFn, 'insufficient time budget');
    }

    const callStart = Date.now();
    try {
      const fullPrompt = `${this._getSystemPrompt()}\n\n${prompt}`;
      console.log(`[${this.name}] reasonStructured 调用前 | promptLen=${fullPrompt.length}`);
      const result = await this._callWithTimeout(
        llm.reasonStructured(fullPrompt, schema, {
          maxTokens: callMaxTokens,
          timeoutMs: perCallTimeout,
          maxRetries: callMaxRetries,
          deadlineMs: this._globalDeadline
        }),
        perCallTimeout,
        `[${this.name}] reasonStructured`
      );
      const callElapsed = Date.now() - callStart;
      console.log(`[${this.name}] reasonStructured 返回 | 耗时=${callElapsed}ms success=${result?.success}`);

      if (!result || !result.success) {
        throw new Error(`LLM引擎返回失败: ${result?.error || '无返回'}`);
      }

      // 【v2.1.4-fix13】校验返回数据是否满足 schema
      const validation = this._validateSchema(result.data, schema);
      if (!validation.valid) {
        console.warn(`[${this.name}] Schema校验失败: ${validation.reason}，尝试降级`);
        return this._executeFallback(fallbackFn, `Schema validation failed: ${validation.reason}`);
      }
      console.log(`[${this.name}] LLM调用成功 ✓`);
      return { result: result.data, degraded: false, degradeReason: null };
    } catch (err) {
      console.warn(`[${this.name}] LLM调用失败: ${err.message} | 耗时≈${Date.now() - callStart}ms`);
      return this._executeFallback(fallbackFn, `LLM failed: ${err.message}`);
    }
  }

  _executeFallback(fallbackFn, reason) {
    try {
      const fallbackResult = fallbackFn ? fallbackFn() : null;
      // 【v2.1.4-fix13】如果降级结果也为 null，明确标记
      if (fallbackResult === null) {
        console.warn(`[${this.name}] 降级结果为null: ${reason}`);
      }
      return { result: fallbackResult, degraded: true, degradeReason: reason, attempts: this.llmMaxRetries };
    } catch (fallbackErr) {
      console.error(`[${this.name}] 降级也失败了: ${fallbackErr.message}`);
      return { result: null, degraded: true, degradeReason: `LLM failed and fallback failed: ${fallbackErr.message}`, attempts: this.llmMaxRetries };
    }
  }

  /**
   * 【v2.1.4-fix13】Schema 校验 — 增加空字符串/空数组检查
   */
  _validateSchema(data, schema) {
    if (!schema || !schema.required) return { valid: true };
    if (!data || typeof data !== 'object') {
      return { valid: false, reason: '返回数据为空或非对象' };
    }
    for (const field of schema.required) {
      const value = data[field];
      if (value === undefined || value === null) {
        return { valid: false, reason: `缺少必需字段: ${field}` };
      }
      if (typeof value === 'string' && !value.trim()) {
        return { valid: false, reason: `必需字段为空字符串: ${field}` };
      }
      // 【P1-6 修复】类型校验：数组字段
      if (schema.requiredArrays?.includes(field) && !Array.isArray(value)) {
        return { valid: false, reason: `${field} 应为数组` };
      }
      if (schema.rejectEmptyArray && Array.isArray(value) && value.length === 0) {
        return { valid: false, reason: `必需字段为空数组: ${field}` };
      }
    }
    return { valid: true };
  }

  _getSystemPrompt() {
    return '你是一位专业的AI视频导演。只输出严格格式的JSON，不要markdown代码块，不要解释，不要思考过程。使用最紧凑的JSON格式。';
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async process(shots, blueprint) { throw new Error('子类必须实现 process 方法'); }
}

module.exports = { BaseAgent };
