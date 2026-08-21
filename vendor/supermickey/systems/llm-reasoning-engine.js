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
    this.baseUrl = options.baseUrl || process.env.LLM_ENDPOINT || 'https://agent-gw.kimi.com/coding/v1/chat/completions';
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
    // 【v2.1.8-fix2】增加5秒缓冲，避免边界超时竞争条件
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
    let textTimer;
    try {
      console.log(`[LLMEngine._fetchWithTimeout] fetch 开始...`);
      const res = await fetch(url, { ...options, signal: controller.signal });
      console.log(`[LLMEngine._fetchWithTimeout] fetch 返回 | status=${res.status} | ok=${res.ok}`);

      // 响应体读取加独立超时，防止流半开挂死
      const textTimeoutMs = Math.max(10000, timeoutMs);
      console.log(`[LLMEngine._fetchWithTimeout] 开始读取响应体 | textTimeout=${textTimeoutMs}ms`);
      // 修复: 防止 res.text() 超时后成为悬空 Promise
      const textPromise = res.text();
      textPromise.catch(() => {});
      
      const text = await Promise.race([
        textPromise,
        new Promise((_, reject) => {
          textTimer = setTimeout(() => {
            try { controller.abort(); } catch (_) {}
            try { res.body && typeof res.body.cancel === 'function' && res.body.cancel(); } catch (_) {}
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
      clearTimeout(textTimer);
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

  /**
   * 【根因修复】从文本中提取合法 JSON 字符串
   *
   * 原算法为 O(n²)：先找所有 '{'/'[' 起始位置，再对每个起始位置扫描到末尾。
   * 当输入为 Kimi K2 的 reasoning_content（可达数十万字符）时，会独占 CPU
   * 数十秒，冻结 Node.js 事件循环，导致所有基于 setTimeout 的超时兜底
   * （_callWithTimeout / _totalTimeout / AbortController）全部失效，
   * 进程被外部健康监控 SIGTERM 终止。
   *
   * 本修复：单次栈扫描 O(n) + 输入截断 + 同步时间预算，绝不阻塞事件循环。
   */
  _extractJsonObject(text) {
    if (!text || typeof text !== 'string') return null;

    // 【防线1】输入硬截断：reasoning 中的目标 JSON 不会出现在 20 万字符之后
    const MAX_INPUT_LEN = 200000;
    if (text.length > MAX_INPUT_LEN) {
      console.warn(`[LLMEngine._extractJsonObject] 输入过长(${text.length})，截断到 ${MAX_INPUT_LEN}`);
      text = text.slice(0, MAX_INPUT_LEN);
    }

    // 1. 优先尝试 ```json 代码块
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch?.[1]) {
      const candidate = codeBlockMatch[1].trim();
      try { JSON.parse(candidate); return candidate; } catch (_) {}
    }

    // 2. 尝试整段
    const whole = text.trim();
    if (whole) {
      try { JSON.parse(whole); return whole; } catch (_) {}
    }

    // 3. 【核心】单次栈扫描找出所有"顶层完整 JSON"候选 —— O(n)
    // 遇到 '{'/'[' 入栈，遇到匹配的 '}'/']' 出栈，栈空时记录一个完整候选
    const candidates = []; // { start, end }
    const stack = []; // { ch, pos }
    let inString = false, escaped = false;

    // 【防线2】同步时间预算：扫描中定期检查耗时，超过预算立即终止
    const BUDGET_MS = 300;
    const scanStart = Date.now();
    let ops = 0;

    for (let i = 0; i < text.length; i++) {
      // 每 16384 次操作检查一次时间，避免检查本身成为瓶颈
      if ((++ops & 0x3FFF) === 0 && (Date.now() - scanStart) > BUDGET_MS) {
        console.warn(`[LLMEngine._extractJsonObject] 扫描超预算(${Date.now() - scanStart}ms, ops=${ops})，终止扫描`);
        break;
      }
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') {
        stack.push({ ch, pos: i });
      } else if (ch === '}' || ch === ']') {
        if (stack.length === 0) continue; // 多余的闭合符，跳过
        const top = stack[stack.length - 1];
        const expectedClose = top.ch === '{' ? '}' : ']';
        if (ch === expectedClose) {
          stack.pop();
          if (stack.length === 0) {
            // 栈空 = 找到一个顶层完整 JSON
            candidates.push({ start: top.pos, end: i });
          }
        }
        // 不匹配的闭合符（如 '{' 遇到 ']'）忽略，避免误判
      }
    }

    // 4. 从候选中选最优：最长 + 含关键字段(meta/structure/shots/scenes)加权
    let bestCandidate = null;
    let bestScore = -1;
    for (const c of candidates) {
      const candidate = text.slice(c.start, c.end + 1).trim();
      let parsed;
      try { parsed = JSON.parse(candidate); } catch (_) { continue; }
      const hasKeyFields = parsed && typeof parsed === 'object' &&
        (parsed.meta || parsed.structure || parsed.shots || parsed.scenes || parsed.characters);
      const score = candidate.length + (hasKeyFields ? 100000 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }
    if (bestCandidate) return bestCandidate;

    // 5. 【截断补全】处理被 max_tokens 截断的不完整 JSON（保留原逻辑，加配对校验）
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
      const lastBrace = text.lastIndexOf('}');
      const endPos = lastBrace >= firstBrace ? lastBrace + 1 : text.length;
      let candidate = text.slice(firstBrace, endPos);
      const stk = [];
      let inStr = false, esc = false, wellFormed = true;
      for (const ch of candidate) {
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{' || ch === '[') stk.push(ch);
        else if (ch === '}') {
          if (stk[stk.length - 1] === '{') stk.pop();
          else { wellFormed = false; break; }
        } else if (ch === ']') {
          if (stk[stk.length - 1] === '[') stk.pop();
          else { wellFormed = false; break; }
        }
      }
      if (wellFormed) {
        let suffix = '';
        while (stk.length) {
          const open = stk.pop();
          suffix += (open === '{') ? '}' : ']';
        }
        candidate += suffix;
        // 截掉最后一个不完整的键值对
        candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*"[^"]*$/, '');
        candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*$/, '');
        try { JSON.parse(candidate); return candidate; } catch (_) {}
      }
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

    // 【审计修复】透传 thinking 配置：BaseAgent 下发的 thinking:{type:'disabled'} 此前被静默丢弃，
    // 导致所有 Agent 调用仍带着完整 reasoning 运行（更长延迟/更大响应/更高超时风险）
    if (options.thinking && typeof options.thinking === 'object') {
      body.thinking = options.thinking;
    }

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

      // 【根因修复·源头】JSON 模式下仅当 content 为空/空白时才回退 reasoning 提取
      //
      // 原阈值 content.length < 5000 过于激进：会把 ContinuityReview 等场景的
      // 完整短 JSON（如 1193 字符的审查结果）误判为"极短/不完整"，强行对超长
      // reasoning_content 触发 _extractJsonObject 的 O(n²) 扫描，同步阻塞事件循环，
      // 导致所有 setTimeout 超时兜底失效 → 进程挂起 → SIGTERM。
      //
      // 修复策略：content 非空即信任，交给上层 reasonStructured 解析；解析失败由
      // reasonStructured 的重试机制处理，绝不在此处对 reasoning 做重量级提取。
      if (forceJson) {
        const contentEmpty = !content || !content.trim();
        if (contentEmpty) {
          if (reasoningContent && reasoningContent.trim()) {
            console.warn('[LLMEngine] JSON模式content为空，尝试从reasoning提取...');
            const extracted = this._extractJsonObject(reasoningContent);
            if (extracted) {
              console.log('[LLMEngine] 从reasoning成功提取JSON，长度：' + extracted.length);
              return { success: true, content: extracted, reasoning_content: reasoningContent, source: 'reasoning-extract-json', tokenCount, raw: result };
            }
          }
          const reasonFile = this._dumpDebugFile('empty_content_reasoning', reasoningContent);
          throw new Error(`LLM返回content为空，JSON模式下无法从reasoning提取有效JSON${reasonFile ? ` | reasoning_dump=${reasonFile}` : ''}`);
        }
        // content 非空（即使较短）：信任，正常返回，交给上层解析
      } else {
        if (!normalized.ok || !finalContent || !finalContent.trim()) {
          const reasonFile = this._dumpDebugFile('empty_content_reasoning', reasoningContent);
          throw new Error(`LLM返回content为空，且当前请求未获得有效正文${reasonFile ? ` | reasoning_dump=${reasonFile}` : ''}`);
        }
      }

      return { success: true, content: forceJson ? content : finalContent, reasoning_content: reasoningContent, source: forceJson ? 'content-only-json-mode' : normalized.source, tokenCount, raw: result };
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
   * 【修复 P0-4】兼容旧接口 reasonRaw（shot-design-agent-v4 / promptforge-worker 使用）
   * 自由文本推理：不做 JSON 强制，返回与 reason() 相同的信封结构
   * { success, content, reasoning_content, source, tokenCount, raw } 或 { success:false, error, retryable }
   */
  async reasonRaw(prompt, options = {}) {
    return this.reason(prompt, { ...options, forceJson: false });
  }

  /**
   * chat 接口（BaseAgent 标准接口兼容）
   * 【P0-2 修复】LLMEngine 原本没有 chat 方法，但 field-check-agent / field-repair-agent /
   * cross-episode-validator 都调用 this.llm.chat(systemPrompt, userPrompt, temperature)，
   * 期望返回字符串。缺失 chat 会导致同步 TypeError → 模块失效 + 定时器泄漏 + 进程崩溃。
   * @param {string} systemPrompt - 系统提示词
   * @param {string} userPrompt - 用户提示词
   * @param {number} [temperature=1] - 温度
   * @returns {Promise<string>} 返回 content 字符串
   */
  async chat(systemPrompt, userPrompt, temperature = 1) {
    if (this._noApiKey) {
      throw new Error('API Key 未配置');
    }
    const result = await this.reason(userPrompt, {
      systemPrompt: systemPrompt || '你是一个可靠的助手。',
      temperature: temperature,
      forceJson: false
    });
    if (!result || !result.success) {
      throw new Error(result && result.error ? result.error : 'LLM chat 调用失败');
    }
    const content = typeof result.content === 'string' ? result.content : '';
    if (!content) {
      throw new Error('LLM chat 返回 content 为空');
    }
    return content;
  }

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
    let lastRetryable = true; // 【修复 P1-5】追踪底层 retryable 判定

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
        // 【修复 P2-6】结构化输出默认降温到 0.6：显著降低 JSON 畸形率，
        // 创意多样性由 prompt 内容保证，不靠采样温度（调用方仍可显式覆盖）
        temperature: options.temperature ?? 0.6,
        maxTokens: options.maxTokens ?? this.maxTokens,
        timeoutMs: attemptTimeout
      });

      if (!result.success) {
        lastError = result.error;
        lastRetryable = result.retryable !== false; // 【修复 P1-5】记录
        console.warn(`[LLMEngine] reasonStructured attempt ${attempt}/${maxRetries} 失败: ${lastError}`);
        // 【P0-12 修复】超时/鉴权错误不可重试
        if (result.retryable === false) {
          console.warn(`[LLMEngine] 错误不可重试(${lastError})，停止重试`);
          break;
        }
        continue;
      }

      try {
        // 【修复】当 content 为空但 reasoning 有内容时，尝试从 reasoning 提取 JSON
        let sourceContent = result.content;
        if (!sourceContent || !sourceContent.trim()) {
          if (result.reasoning_content && result.reasoning_content.trim()) {
            console.log(`[LLMEngine] content为空，尝试从reasoning提取JSON...`);
            sourceContent = result.reasoning_content;
          } else {
            const dump = this._dumpDebugFile('json_extract_fail_content', result.content || '');
            throw new Error(`content为空，无法解析JSON${dump ? ` | dump=${dump}` : ''}`);
          }
        }
        const extracted = this._extractJsonObject(sourceContent);
        if (!extracted) {
          const dump = this._dumpDebugFile('json_extract_fail_content', sourceContent);
          throw new Error(`无法从content提取合法JSON${dump ? ` | dump=${dump}` : ''}`);
        }
        const parsed = JSON.parse(extracted);
        
        // 【v2.1.8-fix】校验必需字段：如果提取的JSON缺少schema.required字段，报错触发重试
        if (schema && schema.required) {
          const missing = schema.required.filter(field => {
            const value = parsed[field];
            return value === undefined || value === null || 
              (Array.isArray(value) && value.length === 0) ||
              (typeof value === 'string' && !value.trim());
          });
          if (missing.length > 0) {
            throw new Error(`提取的JSON缺少必需字段: ${missing.join(', ')}`);
          }
        }
        
        return { success: true, data: parsed, rawContent: sourceContent, reasoning_content: result.reasoning_content };
      } catch (parseError) {
        lastError = `JSON parse error: ${parseError.message}`;
        console.warn(`[LLMEngine] reasonStructured attempt ${attempt}/${maxRetries} 解析失败: ${lastError}`);
      }
    }

    // 【修复 P1-5】带出 retryable，上层 BaseAgent 不再只靠字符串猜
    return { success: false, error: lastError || '未知错误', retryable: lastRetryable };
  }
}

module.exports = { LLMEngine };