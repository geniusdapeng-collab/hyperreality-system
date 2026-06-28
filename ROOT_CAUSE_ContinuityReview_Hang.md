# ContinuityReviewAgent 挂起问题深度分析

> **文档编号**: HAVS-ROOT-CAUSE-2026-06-28
> **提交**: 小G (HAVS 系统维护者)
> **用途**: 外部专家深度分析
> **系统版本**: v2.1.6-fix21

---

## 1. 问题描述

### 1.1 现象

在超现实工业 AI 视频制作系统（HAVS）的预生产链路中，`ContinuityReviewAgent`（连续性审查 Agent）**反复出现挂起（hang）**问题，导致：
- 整个 Phase 2 执行超时
- 主进程被外部 SIGTERM 终止
- 预生产流程被迫中断，无法产出完整镜头

### 1.2 复现条件

- 系统运行到 `Phase 2`（VisualLanguage → AudioDesign → **ContinuityReview**）
- ContinuityReviewAgent 调用 LLM（Kimi K2.6）进行结构化推理（`reasonStructured`）
- 超时设置：`perCallTimeout=180000ms`（3分钟），`totalDeadline=1050000ms`（17.5分钟）

### 1.3 日志记录（关键时间线）

```
[ContinuityReviewAgent] 开始审查 6 个镜头...
[ContinuityReviewAgent._processCore] 进入核心处理 | shots=6 | blueprint=true
[ContinuityReviewAgent._processCore] Prompt构建完成 | length=1152
[ContinuityReviewAgent._processCore] 开始调用LLM...
[ContinuityReviewAgent] _callLLM 进入 | perCallTimeout=180000ms maxTokens=8000 retries=2 remaining=620967ms
[ContinuityReviewAgent] reasonStructured 调用前 | promptLen=1640
[LLMEngine._fetchWithTimeout] 发起请求 | url=https://agent-gw.kimi.com/coding/v1/chat/completions | timeout=180000ms
[LLMEngine._fetchWithTimeout] fetch 开始...
[LLMEngine] JSON模式content为空或极短（1193字符），尝试从reasoning提取...

Process exited with signal SIGTERM
```

**关键观察**:
- 日志停在 `"[LLMEngine] JSON模式content为空或极短..."`，之后无任何输出
- 进程不是自然退出，而是被 **SIGTERM** 强制终止
- 该问题**反复出现**，已在 v2.1.6-fix21 尝试修复但未根治

---

## 2. 相关代码（完整导出，未截断）

### 2.1 ContinuityReviewAgent（问题发生地）

```javascript
/**
 * ContinuityReviewAgent - 连续性审查Agent
 * 负责: 全局审查6维度连续性（新增环节）
 */
const { BaseAgent } = require('./base-agent');
const { CrossEpisodeValidator } = require('./cross-episode-validator');

class ContinuityReviewAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'ContinuityReviewAgent', ...options });
    // 【v2.1.4-fix13-审计修复】把 BaseAgent 的 LLM 引擎传给 CrossEpisodeValidator
    this.crossEpisodeValidator = new CrossEpisodeValidator({
      llmEngine: this._getLLMEngine(),
      model: options.llmModel || 'kimi-k2p6',
      timeout: options.llmTimeout || 120000,
      ...options.crossEpisode
    });
  }

  _getSystemPrompt() {
    return `你是一位资深的电影剪辑师和剧本医生。审查整个视频的镜头连续性，从6个维度发现问题并给出优化建议。

输出JSON格式:
{
  "review": {
    "overallScore": 85,
    "issues": [
      {
        "dimension": "角色一致性",
        "severity": "warning",
        "description": "问题描述",
        "affectedShots": ["SC01", "SC02"],
        "suggestion": "优化建议"
      }
    ],
    "summary": "审查总结"
  }
}

审查维度:
1. 角色一致性: 角色形象、服装、位置是否连续
2. 情绪曲线: 情绪转折是否自然，有无突兀跳变
3. 视觉节奏: 景别切换是否有节奏感，有无单调重复
4. 灯光一致: 同一场景灯光是否保持一致
5. 叙事连贯: 镜头间叙事逻辑是否连贯
6. 时长分配: 重点场景时长是否足够，过渡场景是否过长`;
  }

  setDeadline(deadlineMs) {
    super.setDeadline(deadlineMs);
    if (this.crossEpisodeValidator && typeof this.crossEpisodeValidator.setDeadline === 'function') {
      this.crossEpisodeValidator.setDeadline(deadlineMs);
    }
  }

  // 【P0-1 修复】总体超时包装，确保即使 _callLLM 内部异常挂起，process 也能在固定时间返回
  _totalTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}总体超时(${ms}ms)`)), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  async process(shots, blueprint, options = {}) {
    console.log(`[ContinuityReviewAgent] 开始审查 ${shots.length} 个镜头...`);
    const TOTAL_MS = Math.min(240000, this._remainingMs()); // 总体最多4分钟
    try {
      return await this._totalTimeout(this._processCore(shots, blueprint, options), TOTAL_MS, 'ContinuityReview');
    } catch (err) {
      console.warn(`[ContinuityReviewAgent] 总体兜底触发: ${err.message}，返回规则降级`);
      return { review: this._fallback(shots).review, degraded: true, degradeReason: err.message, boundaryReport: null };
    }
  }

  async _processCore(shots, blueprint, options = {}) {
    console.log(`[ContinuityReviewAgent._processCore] 进入核心处理 | shots=${shots.length} | blueprint=${!!blueprint}`);

    const prompt = this._buildPrompt(shots, blueprint);
    console.log(`[ContinuityReviewAgent._processCore] Prompt构建完成 | length=${prompt.length}`);

    const schema = {
      required: ['review']
    };

    console.log(`[ContinuityReviewAgent._processCore] 开始调用LLM...`);
    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(shots);
    });
    console.log(`[ContinuityReviewAgent._processCore] LLM返回 | degraded=${llmResult.degraded} | degradeReason=${llmResult.degradeReason || 'none'}`);

    if (llmResult.degraded) {
      // 【P1-3 修复】降级对齐非降级结构，避免双层嵌套
      return { review: llmResult.result?.review || llmResult.result || {}, degraded: true, degradeReason: llmResult.degradeReason };
    }

    console.log(`[ContinuityReviewAgent] 连续性审查完成 ✓`);

    // 【v2.1.4】跨集边界校验（仅多集任务）
    let boundaryReport = null;
    const totalEpisodes = options.totalEpisodes || blueprint?.config?._metadata?.series?.totalEpisodes || 1;
    const episodeIndex = options.episodeIndex || blueprint?.config?._metadata?.series?.currentEpisode || 1;

    if (totalEpisodes > 1) {
      console.log(`[ContinuityReviewAgent] 开始跨集边界校验（第${episodeIndex}集/共${totalEpisodes}集）...`);
      
      try {
        const scriptText = CrossEpisodeValidator.extractScriptText(shots);
        const contract = options.episodeContract || this._buildContractFromBlueprint(blueprint);
        
        boundaryReport = await this.crossEpisodeValidator.validate({
          script: scriptText,
          contract,
          episodeIndex,
          totalEpisodes,
          overrideReason: options.boundaryOverrideReason || null
        });

        console.log(`[ContinuityReviewAgent] 跨集边界校验完成: ${boundaryReport.summary}`);
      } catch (err) {
        console.warn(`[ContinuityReviewAgent] 跨集边界校验失败: ${err.message}，跳过`);
      }
    }

    return { 
      review: llmResult.result.review, 
      degraded: false, 
      degradeReason: null,
      boundaryReport // 【v2.1.4】附加边界报告
    };
  }

  _buildPrompt(shots, blueprint) {
    const shotsInfo = shots.map(s => {
      return `镜头 ${s.shotId}: 时长${s.duration || '?'}s, 场景"${(s.scene || '').substring(0, 50)}", 情绪"${s.mood || ''}", 动作"${(s.action || '').substring(0, 50)}"`;
    }).join('\n');

    return `## 镜头列表
${shotsInfo}

## 任务
从6个维度审查镜头连续性:
1. 角色一致性
2. 情绪曲线
3. 视觉节奏
4. 灯光一致
5. 叙事连贯
6. 时长分配

对每个发现的问题:
- severity: critical/warning/info
- description: 问题描述
- affectedShots: 受影响的镜头ID列表
- suggestion: 具体优化建议

最后给出 overallScore (0-100) 和 summary。

直接输出JSON。`;
  }

  _fallback(shots) {
    console.log(`[ContinuityReviewAgent] 使用降级规则...`);
    const issues = [];

    // 【v2.1.4-fix13-审计修复】降级时至少做基础规则检查，不直接给固定分
    // 1. 检测景别重复（连续3个相同 sceneType）
    let prevType = '';
    let repeatCount = 0;
    for (const shot of shots) {
      const st = shot.sceneType || '';
      if (st === prevType) {
        repeatCount++;
        if (repeatCount >= 2) {
          issues.push({
            dimension: '视觉节奏',
            severity: 'warning',
            description: `连续 ${repeatCount + 1} 个 ${st} 镜头，节奏单调`,
            affectedShots: [shot.shotId],
            suggestion: '建议插入不同景别镜头打破单调'
          });
        }
      } else {
        repeatCount = 0;
      }
      prevType = st;
    }

    // 2. 检测时长分配异常
    const durations = shots.map(s => s.duration || 0);
    const total = durations.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const avg = total / shots.length;
      for (let i = 0; i < shots.length; i++) {
        if (durations[i] > avg * 3) {
          issues.push({
            dimension: '时长分配',
            severity: 'warning',
            description: `镜头 ${shots[i].shotId} 时长 ${durations[i]}s 远超平均 ${avg.toFixed(1)}s`,
            affectedShots: [shots[i].shotId],
            suggestion: '考虑拆分或缩短该镜头'
          });
        }
      }
    }

    const score = Math.max(60, 90 - issues.length * 5);
    return {
      review: {
        overallScore: score,
        issues,
        summary: `连续性审查（降级模式）：规则检查发现 ${issues.length} 项问题`
      }
    };
  }

  /**
   * 【v2.1.4】从blueprint构造边界契约
   * blueprint结构: { config: { _metadata: {...} }, scenes: [...] }
   */
  _buildContractFromBlueprint(blueprint) {
    const meta = blueprint?.config?._metadata || {};
    const series = meta.series || {};
    const plan = meta.seriesContentPlan || {};
    
    // 优先从seriesContentPlan提取
    if (plan.episodes && plan.episodes.length > 0) {
      const episodeIndex = meta.series?.currentEpisode || meta.episode || 1;
      const ep = plan.episodes[episodeIndex - 1];
      if (ep) {
        return {
          mustCover: ep.mustCover || ep.coreTopics || [],
          canMention: ep.canMention || [],
          mustNotCover: ep.mustNotCover || [],
          previousSummary: null
        };
      }
    }
    
    return {
      mustCover: series.mustCover || series.episodeThemes || [],
      canMention: series.canMention || [],
      mustNotCover: series.mustNotCover || [],
      previousSummary: series.previousSummary || null
    };
  }
}

module.exports = { ContinuityReviewAgent };
```

### 2.2 BaseAgent（基类，含 _callLLM 和 _callWithTimeout）

```javascript
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
      .then(v => { settled = true; clearTimeout(timer); console.log(`[${label}] ✅ 正常完成，耗时≈${ms - (timer._idleTimeout || 0)}ms`); return v; },
            e => { settled = true; clearTimeout(timer); console.warn(`[${label}] ❌ 异常/超时退出: ${e.message}`); throw e; });
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
```

### 2.3 LLMEngine（_fetchWithTimeout 和 reasonStructured）

```javascript
// llm-reasoning-engine.js v6.5.28-parallel
// 在 v6.5.27 基础上增加：截止时间(deadline)感知 + 可控重试，适配并行链路
const fs = require('fs');
const path = require('path');
const { normalizeLLMOutput } = require('./llm-output-normalizer');

class LLMEngine {
  constructor(options = {}) {
    this.model = options.model || 'kimi-k2p6';
    this.maxTokens = options.maxTokens || 8192; // 【v2.1.4-fix10-P25-fix3】提到8192，防25字段×详细描述被截断
    this.timeoutMs = options.timeoutMs || 600000;
    this.temperature = 1;
    this.topP = 0.95;
    this.maxRetries = options.maxRetries || 3;
    this.contextWindow = options.contextWindow || 8192;
    this.conversationHistory = [];
    this.stats = { totalCalls: 0, totalTokens: 0, totalDuration: 0, errors: 0 };
    this.mode = options.mode || 'production';
    this.baseUrl = options.baseUrl || 'https://agent-gw.kimi.com/coding/v1/chat/completions';
    this.apiKey = options.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || process.env.KIMI_PLUGIN_API_KEY;

    // 【P0-13 修复】apiKey 缺失时标记为不可用，避免 401 无意义重试
    this._noApiKey = !this.apiKey;
    if (this._noApiKey) {
      console.error('[LLMEngine] ❌ 未检测到 API Key，请确认环境变量 KIMI_API_KEY / MOONSHOT_API_KEY / KIMI_PLUGIN_API_KEY');
    }
  }

  _buildHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'User-Agent': 'Kimi Claw Plugin',
      'X-Msh-Device-Name': 'openclaw-kimi-embedding'
    };
  }

  async _fetchWithTimeout(url, options, timeoutMs) {
    console.log(`[LLMEngine._fetchWithTimeout] 发起请求 | url=${url} | timeout=${timeoutMs}ms`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      console.log(`[LLMEngine._fetchWithTimeout] fetch 开始...`);
      const res = await fetch(url, { ...options, signal: controller.signal });
      console.log(`[LLMEngine._fetchWithTimeout] fetch 返回 | status=${res.status} | ok=${res.ok}`);
      // 【问题4 精确修复】res.text() 加独立超时，防止响应体流半开挂死
      // AbortController.abort() 在某些运行时无法中断已 inflight 的 res.text()
      const textTimeoutMs = Math.max(10000, timeoutMs);
      let textTimer;
      console.log(`[LLMEngine._fetchWithTimeout] 开始读取响应体 | textTimeout=${textTimeoutMs}ms`);
      const text = await Promise.race([
        res.text(),
        new Promise((_, reject) => {
          textTimer = setTimeout(() => {
            try { controller.abort(); } catch (_) {}
            reject(new Error(`res.text() 读取响应体超时(${textTimeoutMs}ms)`));
          }, textTimeoutMs);
        })
      ]).finally(() => clearTimeout(textTimer));
      console.log(`[LLMEngine._fetchWithTimeout] 响应体读取完成 | length=${text.length}`);

      return {
        ...res,
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        url: res.url,
        text: () => Promise.resolve(text)
      };
    } finally {
      clearTimeout(timer);
    }
  }

  _dumpDebugFile(prefix, content) {
    try {
      const dir = path.resolve(process.cwd(), 'debug_llm');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}_${prefix}.txt`);
      fs.writeFileSync(file, content || '', 'utf8');
      return file;
    } catch (e) {
      return null;
    }
  }

  _extractJsonObject(text) {
    if (!text || typeof text !== 'string') return null;

    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch?.[1]) {
      const candidate = codeBlockMatch[1].trim();
      try { JSON.parse(candidate); return candidate; } catch (_) {}
    }

    const whole = text.trim();
    try { JSON.parse(whole); return whole; } catch (_) {}

    const startCandidates = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{' || text[i] === '[') startCandidates.push(i);
    }

    // 【v2.1.6-fix】优先返回最长的有效JSON（而非第一个），避免匹配到reasoning中的小片段
    let bestCandidate = null;
    let bestLength = 0;

    for (const start of startCandidates) {
      const open = text[start];
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) { escaped = false; }
          else if (ch === '\\') { escaped = true; }
          else if (ch === '"') { inString = false; }
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === open) depth++;
        if (ch === close) depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1).trim();
          try {
            const parsed = JSON.parse(candidate);
            // 优先选择更长的JSON，且包含关键字段的优先
            const hasKeyFields = parsed.meta && parsed.structure;
            const score = candidate.length + (hasKeyFields ? 100000 : 0);
            if (score > bestLength) {
              bestLength = score;
              bestCandidate = candidate;
            }
          } catch (_) {}
          break;
        }
      }
    }

    if (bestCandidate) return bestCandidate;

    // 【v2.1.4-fix10-P25-fix3】截断修复：尝试补全不闭合的JSON
    const lastBrace = text.lastIndexOf('}');
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
      let candidate = text.slice(firstBrace, lastBrace >= firstBrace ? lastBrace + 1 : undefined);
      // 【P1-26 修复】用栈记录开括号，逆序补全（支持 {} 和 []）
      const stack = [];
      let inString = false, escaped = false;
      for (const ch of candidate) {
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') stack.pop();
      }
      let suffix = '';
      while (stack.length) {
        const open = stack.pop();
        suffix += (open === '{') ? '}' : ']';
      }
      candidate += suffix;
      // 截掉最后一个不完整的键值对
      candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*"[^"]*$/, '');
      candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*$/, '');
      try { JSON.parse(candidate); return candidate; } catch (_) {}
    }

    return null;
  }

  _extractFromReasoning(reasoning) {
    if (!reasoning || typeof reasoning !== 'string') return null;
    const lines = reasoning.split('\n');
    // 【P1-27 修复】收紧 indicators，去掉过于宽泛的 { }，保留结构化字段名
    const indicators = [
      '"meta"', '"structure"', '"scenes"', '"characters"', '"dialogue"',
      '"character_system"', '"world_setting"', '"voice_system"',
      '"shots"', '"review"', '"prompt"', '"title"',
      '镜头', '全景', '中景', '特写', '推轨', '场景', '角色', '台词',
      '独白', '对白', '旁白', '片头', '片尾', '画面'
    ];
    let best = null, bestLen = 0, current = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) {
        if (current.length > bestLen) {
          const hasInd = indicators.some(ind => current.includes(ind));
          if (hasInd) { bestLen = current.length; best = current.trim(); }
        }
        current = '';
      } else {
        current = line + '\n' + current;
      }
    }
    if (current.length > bestLen) {
      const hasInd = indicators.some(ind => current.includes(ind));
      if (hasInd) { bestLen = current.length; best = current.trim(); }
    }
    return best;
  }

  async reason(prompt, options = {}) {
    // 【P0-13 修复】apiKey 缺失时快速失败，避免 401 无意义重试
    if (this._noApiKey) {
      return { success: false, error: 'API Key 未配置', retryable: false };
    }

    const startedAt = Date.now();
    this.stats.totalCalls++;

    const forceJson = options.forceJson === true || options.responseFormat?.type === 'json_object';

    const body = {
      model: options.model || this.model,
      messages: [
        { role: 'system', content: options.systemPrompt || (forceJson ? '你是一个严格输出 JSON 的助手。除合法 JSON 外不要输出任何额外文字。' : '你是一个可靠的助手。') },
        { role: 'user', content: prompt }
      ],
      temperature: options.temperature ?? 1,
      top_p: options.topP ?? 0.95,
      max_tokens: options.maxTokens ?? this.maxTokens
    };

    if (forceJson) body.response_format = { type: 'json_object' };
    else if (options.responseFormat) body.response_format = options.responseFormat;

    try {
      const response = await this._fetchWithTimeout(
        this.baseUrl,
        { method: 'POST', headers: this._buildHeaders(), body: JSON.stringify(body) },
        options.timeoutMs || this.timeoutMs
      );

      const text = await response.text();
      if (!response.ok) {
        this.stats.errors++;
        const file = this._dumpDebugFile('http_error', text);
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}${file ? ` | dump=${file}` : ''}`);
      }

      let result;
      try { result = JSON.parse(text); }
      catch (e) {
        this.stats.errors++;
        const file = this._dumpDebugFile('invalid_response_json', text);
        throw new Error(`API响应不是合法JSON: ${e.message}${file ? ` | dump=${file}` : ''}`);
      }

      const message = result.choices?.[0]?.message || {};
      const content = typeof message.content === 'string' ? message.content : '';
      const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
      const usage = result.usage || {};
      const tokenCount = usage.total_tokens || 0;

      this.stats.totalTokens += tokenCount;
      this.stats.totalDuration += Date.now() - startedAt;

      console.log(`[LLMEngine] API完成 | Tokens: ${tokenCount} | content=${content.length} | reasoning=${reasoningContent.length}`);

      const normalized = normalizeLLMOutput({ content, reasoning_content: reasoningContent });
      let finalContent = normalized.text || '';

      // 【v2.1.6-fix2】JSON模式下若content为空或极短（<5000字符，大概率是不完整JSON），尝试从reasoning提取
      if (forceJson && (!content || !content.trim() || content.length < 5000)) {
        if (reasoningContent && reasoningContent.trim()) {
          console.warn('[LLMEngine] JSON模式content为空或极短（' + content.length + '字符），尝试从reasoning提取...');
          const extracted = this._extractJsonObject(reasoningContent);
          if (extracted) {
            console.log('[LLMEngine] 从reasoning成功提取JSON，长度：' + extracted.length);
            return { success: true, content: extracted, reasoning_content: reasoningContent, source: 'reasoning-extract-json', tokenCount, raw: result };
          }
        }
        const reasonFile = this._dumpDebugFile('empty_content_reasoning', reasoningContent);
        throw new Error(`LLM返回content为空或极短（${content.length}字符），JSON模式下无法从reasoning提取有效JSON${reasonFile ? ` | reasoning_dump=${reasonFile}` : ''}`);
      } else if (!forceJson) {
        if (!normalized.ok || !finalContent || !finalContent.trim()) {
          const reasonFile = this._dumpDebugFile('empty_content_reasoning', reasoningContent);
          throw new Error(`LLM返回content为空，且当前请求未获得有效正文${reasonFile ? ` | reasoning_dump=${reasonFile}` : ''}`);
        }
      }

      return { success: true, content: finalContent, reasoning_content: reasoningContent, source: forceJson ? 'content-only-json-mode' : normalized.source, tokenCount, raw: result };
    } catch (error) {
      this.stats.errors++;
      // 【P0-12 修复】区分错误类型：超时/鉴权错误不可重试
      const isTimeout = error.name === 'AbortError' || /超时|timeout|res\.text\(\)/i.test(error.message);
      const isAuth = /401|403|auth|鉴权|unauthorized|API Key/i.test(error.message);
      return {
        success: false,
        error: error.message || String(error),
        retryable: !isTimeout && !isAuth
      };
    }
  }

  async generate(prompt, options = {}) { return this.reason(prompt, options); }

  /**
   * 结构化推理（v6.5.28：支持 maxRetries / deadlineMs 覆盖 + 截止时间门控重试）
   */
  async reasonStructured(prompt, schema, options = {}) {
    const structuredPrompt = [
      prompt,
      '',
      '【硬性输出要求】',
      '1. 只输出合法 JSON',
      '2. 不要输出 markdown 代码块',
      '3. 不要输出解释、前言、结尾',
      '4. 所有字段必须存在',
      '5. 输出必须能被 JSON.parse 直接解析',
      '',
      '【目标JSON结构示例】',
      JSON.stringify(schema, null, 2)
    ].join('\n');

    const maxRetries = options.maxRetries ?? this.maxRetries;
    const deadlineMs = options.deadlineMs || null;
    // 【问题4 修复】单次 reasonStructured 总耗时上限 = options.timeoutMs（外层 perCallTimeout）
    const totalTimeout = options.timeoutMs || this.timeoutMs;
    const callStart = Date.now();
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // === 截止时间门控：超时则停止重试 ===
      if (deadlineMs && Date.now() >= deadlineMs) {
        console.warn(`[LLMEngine] 截止时间已到，停止重试 (attempt ${attempt}/${maxRetries})`);
        break;
      }

      // 【问题4 修复】总耗时门控：不能超过外层 perCallTimeout
      const elapsed = Date.now() - callStart;
      if (elapsed >= totalTimeout) {
        console.warn(`[LLMEngine] reasonStructured 总耗时(${elapsed}ms)已达上限(${totalTimeout}ms)，停止重试`);
        break;
      }

      // 单次超时 = min(调用方 timeoutMs, 距截止时间, 剩余总预算)
      let attemptTimeout = options.timeoutMs || this.timeoutMs;
      if (deadlineMs) {
        attemptTimeout = Math.min(attemptTimeout, Math.max(10000, deadlineMs - Date.now()));
      }
      attemptTimeout = Math.min(attemptTimeout, Math.max(10000, totalTimeout - elapsed));
      if (attemptTimeout < 10000) {
        console.warn(`[LLMEngine] 单次重试剩余预算不足(${attemptTimeout}ms)，停止`);
        break;
      }

      const result = await this.reason(structuredPrompt, {
        ...options,
        forceJson: true,
        responseFormat: { type: 'json_object' },
        temperature: options.temperature ?? 1,
        maxTokens: options.maxTokens ?? this.maxTokens,
        timeoutMs: attemptTimeout
      });

      if (!result.success) {
        lastError = result.error;
        console.warn(`[LLMEngine] reasonStructured attempt ${attempt}/${maxRetries} 失败: ${lastError}`);
        // 【P0-12 修复】超时/鉴权错误不可重试
        if (result.retryable === false) {
          console.warn(`[LLMEngine] 错误不可重试(${lastError})，停止重试`);
          break;
        }
        continue;
      }

      try {
        if (!result.content || !result.content.trim()) {
          const dump = this._dumpDebugFile('json_extract_fail_content', result.content || '');
          throw new Error(`content为空，无法解析JSON${dump ? ` | dump=${dump}` : ''}`);
        }
        const extracted = this._extractJsonObject(result.content);
        if (!extracted) {
          const dump = this._dumpDebugFile('json_extract_fail_content', result.content);
          throw new Error(`无法从content提取合法JSON${dump ? ` | dump=${dump}` : ''}`);
        }
        const parsed = JSON.parse(extracted);
        return { success: true, data: parsed, rawContent: result.content, reasoning_content: result.reasoning_content };
      } catch (parseError) {
        lastError = `JSON parse error: ${parseError.message}`;
        console.warn(`[LLMEngine] reasonStructured attempt ${attempt}/${maxRetries} 解析失败: ${lastError}`);
      }
    }

    return { success: false, error: lastError || '未知错误' };
  }
}

module.exports = { LLMEngine };
```

### 2.4 Phase 2 执行器（调用方）

```javascript
/**
 * Phase 2: VisualLanguage → AudioDesign → ContinuityReview 串行执行
 * 
 * 职责：
 * - 串行执行三个Agent（避免并发超限SIGKILL）
 * - 逐步合并结果到 shots
 * - 生成跨集边界校验报告
 * - 保存 checkpoint
 */

const { PhaseExecutor } = require('./phase-executor');

class Phase2VisualAudio extends PhaseExecutor {
  constructor(options) {
    super({ name: 'Phase2-VisualAudio', ...options });
  }

  async execute(state) {
    const { shots, result, adaptedBlueprint } = state;
    const startTime = Date.now();

    // 预算检查
    if (!this.checkBudget(80000, 'Phase 2')) {
      return { success: false, shots, result, timing: 0, error: '预算不足' };
    }

    this.log('PHASE-2', 'VisualLanguage → AudioDesign → ContinuityReview 串行启动...');

    try {
      // 串行执行三个Agent（避免并发超限）
      const vlResult = await this.agents.visualLanguage.process(
        this.cloneShots(shots), 
        adaptedBlueprint
      );
      this.log('VISUAL-LANGUAGE-AGENT', '完成');
      let newShots = this.mergeShots(shots, vlResult.shots, [
        'camera', 'cameraString', 'cameraMovement',
        'lighting', 'lightingString',
        'timeline',
        // 兼容旧命名，防止某条路径仍用 snake_case
        'visual_elements', 'color_temperature', 'camera_movement'
      ]);

      const adResult = await this.agents.audioDesign.process(
        this.cloneShots(newShots), 
        adaptedBlueprint
      );
      this.log('AUDIO-DESIGN-AGENT', '完成');
      newShots = this.mergeShots(newShots, adResult.shots, [
        'audio', 'music', 'sound_effects', 'backgroundSound', 'backgroundSoundString'
      ]);

      const crResult = await this.agents.continuityReview.process(
        this.cloneShots(newShots),
        adaptedBlueprint,
        {
          totalEpisodes: this._extractTotalEpisodes(adaptedBlueprint),
          episodeIndex: this._extractEpisodeIndex(adaptedBlueprint),
          episodeContract: this._buildEpisodeContract(adaptedBlueprint)
        }
      );
      this.log('CONTINUITY-REVIEW-AGENT', '完成');

      // 保存连续性检查结果
      result.stages.continuity = { agent: 'continuityReview', ...crResult };
      if (crResult.boundaryReport) {
        result.stages.boundaryReport = crResult.boundaryReport;
        this.log('BOUNDARY-GUARD', `跨集边界校验: ${crResult.boundaryReport.summary}`);
      }

      // 更新统计
      result.llmStats.visualLanguage = vlResult.timing;
      result.llmStats.audioDesign = adResult.timing;
      result.llmStats.continuityReview = crResult.timing;

      const timing = Date.now() - startTime;
      this.log('PHASE-2', `完成 (${timing}ms)`);

      // 保存 checkpoint
      await this.saveCheckpoint('phase2', newShots, {
        opening: result.opening,
        llmStats: result.llmStats
      });
      this.checkMemory('phase2');

      return { success: true, shots: newShots, result, timing };
    } catch (e) {
      this.log('PHASE-2-FAIL', `❌ ${e.message}, Phase2 失败但继续`);
      // Phase 2 失败不致命，用已有数据继续
      return { success: false, shots, result, timing: Date.now() - startTime, error: e.message };
    }
  }

  _extractTotalEpisodes(adaptedBlueprint) {
    return adaptedBlueprint.config?._metadata?.series?.totalEpisodes 
      || adaptedBlueprint.config?._metadata?.totalEpisodes 
      || 1;
  }

  _extractEpisodeIndex(adaptedBlueprint) {
    return adaptedBlueprint.config?._metadata?.series?.currentEpisode 
      || adaptedBlueprint.config?._metadata?.episode 
      || 1;
  }

  _buildEpisodeContract(adaptedBlueprint) {
    // 从blueprint构建跨集连续性契约
    const contract = {
      characters: adaptedBlueprint.characters || [],
      worldSetting: adaptedBlueprint.worldSetting || {},
      keyEvents: adaptedBlueprint.keyEvents || []
    };
    return contract;
  }
}

module.exports = { Phase2VisualAudio };
```

---

## 3. 可能出问题的地方（小G分析）

### 3.1 疑点 A：`_callWithTimeout` 的 `Promise.race` 竞争条件

**问题描述**:
```javascript
_callWithTimeout(promise, timeoutMs, label) {
    const p = Promise.resolve(promise);
    p.catch(() => {}); // 标记 rejection 已被处理
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label}超时(${ms}ms)`));
      }, ms);
    });
    return Promise.race([p, timeoutPromise])
      .then(v => { settled = true; clearTimeout(timer); return v; },
            e => { settled = true; clearTimeout(timer); throw e; });
}
```

**问题分析**:
- `p.catch(() => {})` 虽然防止了 `unhandledRejection`，但改变了 Promise 链的状态
- `Promise.race` 在 `p` 已经 resolved（因 catch 提前消费）时，可能**不会正确传播超时错误**
- 如果 `p` 先 reject（内部错误），`timeoutPromise` 可能仍在计时，但 race 已返回
- **更关键的是**：如果 `p` 是一个**永远不会 resolve 的 Promise**（如底层网络挂起），`Promise.race` 理论上应该由 `timeoutPromise` 胜出，但...

**怀疑点**:
- 如果 `llm.reasonStructured()` 内部发生了某种**阻塞**（如无限重试、循环等待），`AbortController` 的 `abort()` 信号可能无法正确中断它
- `timeoutPromise` 虽然 reject，但 `Promise.race` 返回的 rejection 可能无法被外层 `_callLLM` 的 `try-catch` 捕获（因为 `_callWithTimeout` 的 `.then().catch()` 链可能断裂）

### 3.2 疑点 B：`reason()` 中的 `res.text()` 读取在超时后仍在继续

**问题描述**:
```javascript
async _fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      // ...
      const text = await Promise.race([
        res.text(),
        new Promise((_, reject) => {
          textTimer = setTimeout(() => {
            try { controller.abort(); } catch (_) {}
            reject(new Error(`res.text() 读取响应体超时...`));
          }, textTimeoutMs);
        })
      ]).finally(() => clearTimeout(textTimer));
      // ...
    } finally {
      clearTimeout(timer);
    }
}
```

**问题分析**:
- `AbortController.abort()` 在 Node.js 的 `fetch` 实现中，**不能中断已经开始的 `res.text()` 读取**
- 即使 `controller.abort()` 被调用，底层的 TCP 连接和流读取可能仍在继续
- `res.text()` 在极端情况下（网络极度缓慢）可能**忽略 abort 信号，无限挂起**
- `Promise.race` 的 `textTimer` 超时虽然会 reject，但 `res.text()` 的 Promise 仍在后台运行，可能导致内存泄漏或进程未正确退出

### 3.3 疑点 C：ContinuityReviewAgent 的 `_totalTimeout` 未覆盖 `crossEpisodeValidator`

**问题描述**:
```javascript
async process(shots, blueprint, options = {}) {
    const TOTAL_MS = Math.min(240000, this._remainingMs());
    try {
      return await this._totalTimeout(this._processCore(...), TOTAL_MS, 'ContinuityReview');
    } catch (err) {
      // 降级...
    }
}
```

**问题分析**:
- `_processCore` 在 `llmResult.degraded = false` 时，会进入跨集边界校验逻辑：
  ```javascript
  if (totalEpisodes > 1) {
    boundaryReport = await this.crossEpisodeValidator.validate(...);
  }
  ```
- 但 `_totalTimeout` 只包裹了 `_processCore` 的调用，如果 `crossEpisodeValidator.validate()` 内部挂起，`_totalTimeout` 已经返回了（因为 `_processCore` 已返回），但 `boundaryReport` 的赋值未完成
- **然而**：在本次复现中，`totalEpisodes = 1`，所以未触发此路径，**这不是本次根因**

### 3.4 疑点 D：JSON 提取失败后的无限重试

**问题描述**:
```javascript
// 【v2.1.6-fix2】JSON模式下若content为空或极短（<5000字符），尝试从reasoning提取
if (forceJson && (!content || !content.trim() || content.length < 5000)) {
    if (reasoningContent && reasoningContent.trim()) {
      console.warn('[LLMEngine] JSON模式content为空或极短...');
      const extracted = this._extractJsonObject(reasoningContent);
      if (extracted) { /* ... */ }
    }
    const reasonFile = this._dumpDebugFile('empty_content_reasoning', reasoningContent);
    throw new Error(`LLM返回content为空或极短...`);
}
```

**问题分析**:
- 日志显示：`[LLMEngine] JSON模式content为空或极短（1193字符），尝试从reasoning提取...`
- 然后进程就**停在此处**，没有后续日志
- 怀疑 `_extractJsonObject` 或 `_extractFromReasoning` 在特定输入下进入**无限循环**或极端耗时
- 特别是 `_extractJsonObject` 中有嵌套循环和栈操作，如果输入异常（如极长的 JSON 片段），可能耗尽 CPU

### 3.5 疑点 E：Node.js 运行时层面的信号处理

**问题分析**:
- 进程被 **SIGTERM** 终止，而非自然退出
- 可能是外部健康监控（HealthMonitor）或容器管理器（如 Docker/K8s）检测到进程长时间无响应，强制终止
- 如果是 OpenClaw 的 HealthMonitor，它在 30 秒间隔检查 Agent 状态，如果检测到 Agent 挂起（无心跳），可能发送 SIGTERM

---

## 4. 我们的预期

### 4.1 行为预期

当 `ContinuityReviewAgent` 的 LLM 调用超时时，系统应该：

1. **在 3 分钟内（`perCallTimeout`）返回** —— 无论 LLM 是否响应
2. **如果 3 分钟未返回，触发 `_totalTimeout`（4 分钟）** —— 返回降级结果，不阻塞链路
3. **如果 `_totalTimeout` 也未触发，进程应被 `_callWithTimeout` 的 `Promise.race` 强制退出** —— 绝不永久挂起
4. **返回降级结果后，Phase 2 继续执行** —— 使用规则检查的连续性结果，而非 LLM 审查结果

### 4.2 当前行为 vs 预期

| 场景 | 预期 | 实际 |
|------|------|------|
| LLM 3 分钟未响应 | `_callWithTimeout` 超时，返回降级 | 进程挂起，无返回 |
| LLM 返回无效 JSON | 解析失败，重试 1 次，仍失败则降级 | 疑似在 JSON 提取阶段卡死 |
| 总体超时 4 分钟 | `_totalTimeout` 触发，强制降级 | 未触发，进程被 SIGTERM 终止 |
| 降级结果 | 返回规则检查的连续性评分 | 无返回，链路中断 |

### 4.3 修复目标

1. **根治挂起**：确保无论 LLM 层发生何种异常，`_callWithTimeout` 都能在指定时间后**必胜返回**
2. **强化超时**：引入 `AbortController` 或更底层的超时机制，确保 `res.text()` 读取也能被中断
3. **防止 JSON 提取卡死**：为 `_extractJsonObject` 和 `_extractFromReasoning` 添加时间上限或复杂度限制
4. **增强可观测性**：在挂起前打印更多诊断信息，精确定位卡死行

---

## 5. 附录：相关文件路径

| 文件 | 路径 |
|------|------|
| ContinuityReviewAgent | `/hyperreality-system/engines/production-engine/agents/continuity-review-agent.js` |
| BaseAgent | `/hyperreality-system/engines/production-engine/agents/base-agent.js` |
| LLMEngine | `/systems/llm-reasoning-engine.js` |
| Phase2VisualAudio | `/hyperreality-system/engines/production-engine/phases/phase-2-visual-audio.js` |
| ProductionEngine | `/hyperreality-system/engines/production-engine/production-engine.js` |
| 测试脚本 | `/hyperreality-system/test-continuity-fix.js`（已删除） |

---

> **文档结束**
> 
> 请外部专家基于以上信息，对 ContinuityReviewAgent 挂起问题做深度根因分析，给出修复建议。重点关注：
> 1. `_callWithTimeout` 的 `Promise.race` 在极端场景下的可靠性
> 2. `AbortController` 在 Node.js fetch 中的实际效果
> 3. JSON 提取逻辑的复杂度与潜在死循环
> 4. 系统级超时兜底（`_totalTimeout`）为何未生效
