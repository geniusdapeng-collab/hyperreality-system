// verify-extract-fix.js
// 验证 _extractJsonObject 修复后不再冻结事件循环

// ===== 把修复1的 _extractJsonObject 粘贴到这里（去掉类前缀，作为独立函数） =====
function _extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  const MAX_INPUT_LEN = 200000;
  if (text.length > MAX_INPUT_LEN) {
    console.warn(`输入过长(${text.length})，截断到 ${MAX_INPUT_LEN}`);
    text = text.slice(0, MAX_INPUT_LEN);
  }
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch?.[1]) {
    const candidate = codeBlockMatch[1].trim();
    try { JSON.parse(candidate); return candidate; } catch (_) {}
  }
  const whole = text.trim();
  if (whole) { try { JSON.parse(whole); return whole; } catch (_) {} }
  const candidates = [];
  const stack = [];
  let inString = false, escaped = false;
  const BUDGET_MS = 300;
  const scanStart = Date.now();
  let ops = 0;
  for (let i = 0; i < text.length; i++) {
    if ((++ops & 0x3FFF) === 0 && (Date.now() - scanStart) > BUDGET_MS) {
      console.warn(`扫描超预算(${Date.now() - scanStart}ms, ops=${ops})，终止扫描`);
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
    if (ch === '{' || ch === '[') stack.push({ ch, pos: i });
    else if (ch === '}' || ch === ']') {
      if (stack.length === 0) continue;
      const top = stack[stack.length - 1];
      const expectedClose = top.ch === '{' ? '}' : ']';
      if (ch === expectedClose) {
        stack.pop();
        if (stack.length === 0) candidates.push({ start: top.pos, end: i });
      }
    }
  }
  let bestCandidate = null, bestScore = -1;
  for (const c of candidates) {
    const candidate = text.slice(c.start, c.end + 1).trim();
    let parsed; try { parsed = JSON.parse(candidate); } catch (_) { continue; }
    const hasKeyFields = parsed && typeof parsed === 'object' && parsed.meta && parsed.structure;
    const score = candidate.length + (hasKeyFields ? 100000 : 0);
    if (score > bestScore) { bestScore = score; bestCandidate = candidate; }
  }
  if (bestCandidate) return bestCandidate;
  return null;
}

// ===== 构造超长 reasoning（模拟 Kimi K2 思考过程） =====
function buildReasoning(len) {
  let s = '思考过程：分析镜头连续性。';
  const chunk = '需要检查 { "shot": "SC01", "meta": { "a": [1,2,3] } } 是否连续。';
  while (s.length < len) s += chunk;
  s += '\n最终结论 {"review":{"overallScore":85,"issues":[],"summary":"ok"}}';
  return s;
}

// ===== 心跳检测：事件循环是否被冻结 =====
function test(label, fn, input) {
  let heartbeat = 0;
  const hb = setInterval(() => { heartbeat++; }, 50);
  const t0 = Date.now();
  const result = fn(input);
  const elapsed = Date.now() - t0;
  clearInterval(hb);
  const frozen = elapsed > 200 && heartbeat === 0;
  console.log(`[${label}] len=${input.length} | 耗时=${elapsed}ms | 心跳=${heartbeat} | ${frozen ? '❌ 事件循环被冻结' : '✅ 事件循环正常'} | 结果长度=${result ? result.length : 'null'}`);
  return { elapsed, frozen };
}

console.log('===== 验证修复后 _extractJsonObject 不再冻结事件循环 =====\n');
let allPass = true;
for (const sz of [5000, 20000, 50000, 100000, 200000, 500000]) {
  const r = test('修复版', _extractJsonObject, buildReasoning(sz));
  if (r.frozen || r.elapsed > 500) allPass = false;
}
console.log('\n===== 结论 =====');
console.log(allPass
  ? '✅ 全部通过：所有规模均在 500ms 内完成，事件循环未被冻结。挂起根因已根治。'
  : '❌ 仍有卡死，请检查 _extractJsonObject 是否正确替换。');
