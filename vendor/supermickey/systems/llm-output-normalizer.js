/**
 * llm-output-normalizer.js
 * LLM 输出归一化模块 — v6.6.7-fix
 *
 * 修复要点：
 * 1. 新增 extractJsonObject()，从任意文本中提取合法 JSON（对象/数组）
 * 2. normalizeLLMOutput() 如实返回 hasJson/jsonText，杜绝"纯文本冒充 JSON"的伪 ok
 * 3. reasoning 来源时优先 JSON 提取，失败才回退纯文本（并显式标记 hasJson:false）
 * 4. 兼容代码围栏、注释、尾逗号
 */
'use strict';

/**
 * 安全转字符串
 */
function safeString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

/**
 * 去除 markdown 代码围栏（```json ... ``` / ``` ... ```）
 */
function stripCodeFence(text) {
  if (!text || typeof text !== 'string') return text;
  let s = text.trim();
  const fenceMatch = s.match(/^```(?:json|JSON|javascript|js)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  } else {
    // 容忍只有开头围栏没有结尾的情况
    const headMatch = s.match(/^```(?:json|JSON|javascript|js)?\s*\n([\s\S]*)$/);
    if (headMatch) s = headMatch[1].replace(/\n```\s*$/, '').trim();
  }
  return s;
}

/**
 * 清理 JSON 文本：去注释、去尾逗号
 */
function cleanJsonText(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避免误伤 http://）
    .replace(/,\s*([}\]])/g, '$1'); // 尾逗号
}

/**
 * 从任意文本中提取合法 JSON（对象优先，数组次之）
 * 【SIGKILL 根因修复】O(n²) → O(n) 单次栈扫描
 * 
 * 原算法：对每个 '{'/'[' 起始位置扫描到末尾，最坏 O(n²)
 * 当输入 20 万字符时，循环 4×10¹⁰ 次，冻结事件循环数十秒，
 * 所有超时兜底失效，进程被 SIGKILL 终止。
 * 
 * 新算法：单次栈扫描 O(n) + 输入截断 + 同步时间预算
 */
function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return { json: '', type: null };

  // 【防线1】输入硬截断：reasoning 中的目标 JSON 不会出现在 20 万字符之后
  const MAX_INPUT_LEN = 200000;
  if (text.length > MAX_INPUT_LEN) {
    console.warn(`[extractJsonObject] 输入过长(${text.length})，截断到 ${MAX_INPUT_LEN}`);
    text = text.slice(0, MAX_INPUT_LEN);
  }

  // 1. 优先尝试 ```json 代码块
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch?.[1]) {
    const candidate = codeBlockMatch[1].trim();
    try { JSON.parse(candidate); return { json: candidate, type: 'object' }; } catch (_) {}
  }

  // 2. 尝试整段
  const whole = text.trim();
  if (whole) {
    try { JSON.parse(whole); return { json: whole, type: whole.startsWith('[') ? 'array' : 'object' }; } catch (_) {}
  }

  // 3. 【核心】单次栈扫描找出所有"顶层完整 JSON"候选 —— O(n)
  const candidates = []; // { start, end, type }
  const stack = []; // { ch, pos }
  let inString = false, escaped = false;

  // 【防线2】同步时间预算：扫描中定期检查耗时
  const BUDGET_MS = 300;
  const scanStart = Date.now();
  let ops = 0;

  for (let i = 0; i < text.length; i++) {
    // 每 16384 次操作检查一次时间
    if ((++ops & 0x3FFF) === 0 && (Date.now() - scanStart) > BUDGET_MS) {
      console.warn(`[extractJsonObject] 扫描超预算(${Date.now() - scanStart}ms, ops=${ops})，终止扫描`);
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
      if (stack.length === 0) continue;
      const top = stack[stack.length - 1];
      const expectedClose = top.ch === '{' ? '}' : ']';
      if (ch === expectedClose) {
        stack.pop();
        if (stack.length === 0) {
          candidates.push({ start: top.pos, end: i, type: top.ch === '{' ? 'object' : 'array' });
        }
      }
    }
  }

  // 4. 从候选中选最优：最长 + 含关键字段加权
  let bestCandidate = null, bestType = null, bestScore = -1;
  for (const c of candidates) {
    const candidate = text.slice(c.start, c.end + 1).trim();
    let parsed;
    try { parsed = JSON.parse(candidate); } catch (_) { continue; }
    const hasKeyFields = parsed && typeof parsed === 'object' && (
      parsed.meta || parsed.structure || parsed.shots || parsed.scenes || parsed.characters
    );
    const score = candidate.length + (hasKeyFields ? 100000 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
      bestType = c.type;
    }
  }
  if (bestCandidate) return { json: bestCandidate, type: bestType };

  // 5. 截断补全：处理被 max_tokens 截断的不完整 JSON
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const startChar = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket) ? '{' : '[';
  const startPos = startChar === '{' ? firstBrace : firstBracket;
  
  if (startPos >= 0) {
    const endChar = startChar === '{' ? '}' : ']';
    const lastClose = text.lastIndexOf(endChar);
    const endPos = lastClose >= startPos ? lastClose + 1 : text.length;
    let candidate = text.slice(startPos, endPos);
    
    // 配对校验 + 补全
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
      candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*"[^"]*$/, '');
      candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*$/, '');
      try { JSON.parse(candidate); return { json: candidate, type: startChar === '{' ? 'object' : 'array' }; } catch (_) {}
    }
  }

  return { json: '', type: null };
}

/**
 * 从 reasoning 中提取最后一段"看起来像输出"的段落（纯文本回退，非 JSON 专用）
 * 保留原逻辑，供非结构化调用方使用
 */
function extractFinalSegment(reasoning) {
  if (!reasoning || typeof reasoning !== 'string') return '';
  const segments = reasoning.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return '';
  // 从后向前优先找含 { 或 [ 的段落
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.includes('{') || seg.includes('[')) return seg;
  }
  return segments[segments.length - 1];
}

/**
 * 归一化 LLM 输出
 * @param {Object} raw - LLM 原始返回 { content, reasoning_content, ... }
 * @returns {{
 * ok: boolean,
 * text: string,
 * source: 'content'|'reasoning_content'|'empty',
 * hasJson: boolean,
 * jsonText: string,
 * jsonType: 'object'|'array'|null
 * }}
 */
function normalizeLLMOutput(raw) {
  const content = safeString(raw?.content).trim();
  const reasoning = safeString(raw?.reasoning_content).trim();

  // 情况 1：content 有内容
  if (content) {
    const stripped = stripCodeFence(content);
    const { json, type } = extractJsonObject(stripped);
    return {
      ok: true,
      text: stripped,
      source: 'content',
      hasJson: !!json,
      jsonText: json || '',
      jsonType: type
    };
  }

  // 情况 2：content 空，reasoning 有内容
  if (reasoning) {
    // 2a) 优先从 reasoning 中提取 JSON
    const { json, type } = extractJsonObject(reasoning);
    if (json) {
      return {
        ok: true,
        text: json,
        source: 'reasoning_content',
        hasJson: true,
        jsonText: json,
        jsonType: type
      };
    }
    // 2b) JSON 抠不到 → 回退纯文本，但显式标记 hasJson:false（关键修复点）
    const extracted = extractFinalSegment(reasoning);
    return {
      ok: !!extracted,
      text: stripCodeFence(extracted || reasoning),
      source: 'reasoning_content',
      hasJson: false, // ← 如实报告：这不是 JSON
      jsonText: '',
      jsonType: null
    };
  }

  // 情况 3：都为空
  return { ok: false, text: '', source: 'empty', hasJson: false, jsonText: '', jsonType: null };
}

module.exports = {
  normalizeLLMOutput,
  extractJsonObject,
  extractFinalSegment,
  stripCodeFence,
  cleanJsonText,
  safeString
};
