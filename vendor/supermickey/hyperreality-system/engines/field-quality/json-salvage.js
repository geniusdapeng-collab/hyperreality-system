/**
 * json-salvage.js - LLM 响应 JSON 鲁棒提取（v2.1.14-fix 新增）
 *
 * 解决【故障A】：LLM（尤其推理型模型）在修复任务中返回非 JSON 内容
 * （如 "等等，重新看"需要修"... 这类自然语言开头），JSON.parse 直接崩溃，
 * 导致整轮修复作废（0 项修复动作）。
 *
 * 提取策略（逐级降级）：
 * 1. 直接 JSON.parse（最快路径）
 * 2. 剥离 markdown 代码围栏（```json ... ```）后解析
 * 3. 截取第一个 '{' 到最后一个 '}' 的子串解析
 * 4. 括号配对扫描（字符串/转义感知），提取第一个完整 JSON 对象解析
 * 5. 全部失败 → 返回 ok:false，调用方记录原始响应并降级，绝不抛出
 *
 * 返回：{ ok: boolean, data?: any, method?: string, rawPreview?: string }
 */

/**
 * 括号配对扫描：从 startIdx 处的 '{' 开始，找到配对的 '}'
 * 感知字符串字面量与转义字符，避免被字符串内的括号干扰
 */
function findMatchingBrace(text, startIdx) {
  let depth = 0;
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') { escaped = true; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // JSON 标准只认双引号，但 LLM 偶尔输出单引号字符串，扫描时同样跳过其内容
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 从 LLM 响应文本中提取 JSON
 * @param {string} text - LLM 原始响应
 * @returns {{ ok: boolean, data?: any, method?: string, rawPreview?: string }}
 */
function extractJson(text) {
  if (text === null || text === undefined) {
    return { ok: false, rawPreview: '(null)' };
  }
  if (typeof text === 'object') {
    return { ok: true, data: text, method: 'already-object' };
  }
  const raw = String(text);
  const rawPreview = raw.slice(0, 120);
  const trimmed = raw.trim();

  // 策略1：直接解析
  try {
    return { ok: true, data: JSON.parse(trimmed), method: 'direct' };
  } catch (_) { /* 继续降级 */ }

  // 策略2：剥离 markdown 代码围栏
  const fenceMatch = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return { ok: true, data: JSON.parse(fenceMatch[1].trim()), method: 'code-fence' };
    } catch (_) { /* 继续降级 */ }
  }

  // 策略3：第一个 '{' 到最后一个 '}'
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return { ok: true, data: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)), method: 'first-last-brace' };
    } catch (_) { /* 继续降级 */ }
  }

  // 策略4：括号配对扫描（从第一个 '{' 开始逐个尝试）
  let scanFrom = 0;
  while (true) {
    const start = trimmed.indexOf('{', scanFrom);
    if (start === -1) break;
    const end = findMatchingBrace(trimmed, start);
    if (end !== -1) {
      try {
        return { ok: true, data: JSON.parse(trimmed.slice(start, end + 1)), method: 'brace-matching' };
      } catch (_) {
        scanFrom = start + 1; // 该对象解析失败，尝试下一个 '{'
      }
    } else {
      break;
    }
  }

  return { ok: false, rawPreview };
}

module.exports = { extractJson, findMatchingBrace };
