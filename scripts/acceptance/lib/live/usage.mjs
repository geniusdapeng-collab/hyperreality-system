/**
 * Exact usage for the pinned DSH durable event schema. Counters stay unavailable
 * when a boundary, attempt, route or authoritative sample is missing.
 * Schema and cache accounting: upstream dsh-v0.2.0-rc.2
 * packages/llm/token-meter/src/turn-usage.ts and core/session/src/types.ts.
 */
const count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const add = (values) => { const total = values.reduce((sum, value) => sum + value, 0); return count(total) ? total : null; };

export function normalizeDshUsage(value) {
  if (!object(value) || !count(value.inputTokens) || !count(value.outputTokens)) return null;
  const optional = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];
  if (optional.some((key) => value[key] !== undefined && !count(value[key])) || (value.reasoningTokens !== undefined && value.reasoningTokens > value.outputTokens)) return null;
  const prompt = add([value.inputTokens, value.cacheReadTokens ?? 0, value.cacheWriteTokens ?? 0]);
  if (prompt === null) return null;
  let total = value.totalTokens;
  if (total === undefined) {
    if (value.cacheReadTokens === undefined || value.cacheWriteTokens === undefined) return null;
    total = add([prompt, value.outputTokens]);
  }
  if (!count(total) || total - value.outputTokens < prompt || (value.cacheReadTokens !== undefined && value.cacheWriteTokens !== undefined && total - value.outputTokens !== prompt)) return null;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: total,
    ...Object.fromEntries(optional.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) };
}

export function normalizeOpenAiUsage(value) {
  if (!object(value)) return null;
  const hasParts = count(value.prompt_tokens) && count(value.completion_tokens);
  if (["prompt_tokens", "completion_tokens", "total_tokens"].some((key) => value[key] !== undefined && !count(value[key]))) return null;
  const derived = hasParts ? add([value.prompt_tokens, value.completion_tokens]) : null;
  const total = value.total_tokens ?? derived;
  if (!count(total) || (hasParts && total !== derived)) return null;
  return { totalTokens: total, ...(hasParts ? { inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens } : {}) };
}

function streamUsage(stream) {
  if (!Array.isArray(stream)) throw new Error("DSH attempt 没有完整 durable stream");
  let sample = null;
  for (const record of stream) {
    if (!object(record) || !["chunk", "text-chunks", "reasoning-chunks", "tool-call-chunks"].includes(record.type)) throw new Error("DSH durable stream 形态不可识别");
    if (record.type === "chunk") {
      if (!count(record.time) || !object(record.chunk)) throw new Error("DSH stream chunk 形态无效");
      if (record.chunk.type === "usage") {
        sample = normalizeDshUsage(record.chunk.usage);
        if (!sample) throw new Error("DSH stream usage 缺失或计量无效");
      }
    }
  }
  return sample;
}

const routeOf = (value) => object(value) && typeof value.provider === "string" && value.provider.length > 0 && typeof value.model === "string" && value.model.length > 0 ? { provider: value.provider, model: value.model } : null;
const ancillary = new Set(["system/message", "developer/message", "user/message", "tool/call", "tool/result", "session/end-seed"]);

/** Fold every live session, including retried and child attempts; return no guessed total. */
export function foldDshUsage(events) {
  try {
    if (!Array.isArray(events) || events.length === 0) throw new Error("DSH 没有实际会话事件");
    const sessions = new Map();
    const attempts = [];
    const endings = [];
    let answer = "";
    for (const event of events) {
      if (!object(event) || typeof event.sessionId !== "string" || !event.sessionId || typeof event.type !== "string" || !count(event.seq) || !count(event.time) || !object(event.data)) throw new Error("DSH 会话事件身份/序号/时间/数据无效");
      let session = sessions.get(event.sessionId);
      if (!session) { session = { seq: 0, turn: null, attempt: null, route: null, turns: new Set(), steps: new Set() }; sessions.set(event.sessionId, session); }
      if (event.seq !== session.seq++) throw new Error("DSH 会话事件缺失或序号不连续");
      const data = event.data;
      const sameAttempt = () => session.attempt && data.turn === session.turn && data.step === session.attempt.step;
      const account = (usage, route) => {
        if (!usage || !route) throw new Error("DSH attempt 没有可证明的完整 usage 或模型路由");
        attempts.push({ ...usage, route });
      };
      if (event.type === "request/header" || event.type === "request/context") {
        const route = routeOf(event.type === "request/header" ? data.header?.config : data);
        if (!route) throw new Error("DSH 请求没有可回读 provider/model 路由");
        session.route = route; continue;
      }
      switch (event.type) {
        case "turn/start":
          if (!count(data.turn) || session.turn !== null || session.attempt || session.turns.has(data.turn)) throw new Error("DSH turn 开始边界矛盾");
          session.turn = data.turn; session.turns.add(data.turn); session.steps.clear(); break;
        case "step/start":
          if (session.turn === null || data.turn !== session.turn || !count(data.step) || session.attempt || session.steps.has(data.step)) throw new Error("DSH step 开始边界矛盾");
          session.steps.add(data.step); session.attempt = { step: data.step, state: "open" }; break;
        case "assistant/message": {
          if (!sameAttempt() || session.attempt.state !== "open") throw new Error("DSH assistant message 不属于已开始 attempt");
          const streamed = streamUsage(data.stream);
          const direct = data.usage === undefined ? null : normalizeDshUsage(data.usage);
          if (data.usage !== undefined && !direct) throw new Error("DSH message usage 无效");
          if (direct && streamed && (direct.totalTokens !== streamed.totalTokens || direct.inputTokens !== streamed.inputTokens || direct.outputTokens !== streamed.outputTokens)) throw new Error("DSH message 与 stream usage 矛盾");
          const route = routeOf(data.message?.source);
          if (session.route && route && (session.route.provider !== route.provider || session.route.model !== route.model)) throw new Error("DSH 实际 message 模型与请求路由不一致");
          account(direct ?? streamed, route);
          if (data.interrupted === true) session.attempt.interrupted = true;
          answer = Array.isArray(data.message?.content) ? data.message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : "";
          session.attempt.state = "message"; break;
        }
        case "assistant/attempt":
          if (!sameAttempt() || session.attempt.state !== "open") throw new Error("DSH failed attempt 边界矛盾");
          account(streamUsage(data.stream), session.route); session.attempt.state = "attempt"; break;
        case "llm/retry":
          if (!sameAttempt() || session.attempt.state !== "attempt") throw new Error("DSH retry 缺少已结算 failed attempt");
          session.attempt.state = "retry"; break;
        case "llm/retry-started":
          if (!sameAttempt() || session.attempt.state !== "retry") throw new Error("DSH retry-started 缺少已归集的前次 attempt");
          session.attempt.state = "open"; break;
        case "step/end":
          if (!sameAttempt() || !["message", "attempt", "retry"].includes(session.attempt.state)) throw new Error("DSH step 结束前没有完整 attempt usage");
          if (session.attempt.interrupted) session.interrupted = true;
          session.attempt = null; break;
        case "turn/end":
          if (session.turn === null || data.turn !== session.turn || session.attempt || typeof data.reason?.kind !== "string") throw new Error("DSH turn 结束边界缺失或矛盾");
          if (session.interrupted && data.reason.kind === "completed") throw new Error("DSH interrupted message 与 completed 终态矛盾");
          endings.push(data.reason.kind); session.turn = null; session.interrupted = false; break;
        default:
          if (!ancillary.has(event.type) && event.ignorable !== true) throw new Error(`DSH required event ${event.type} 尚未支持，不能推定计量完整`);
      }
    }
    if (!attempts.length || !endings.length || [...sessions.values()].some((session) => session.turn !== null || session.attempt)) throw new Error("DSH attempt/turn 未完整结束");
    const totalTokens = add(attempts.map((attempt) => attempt.totalTokens));
    if (totalTokens === null) throw new Error("DSH 累计 token 超过安全整数范围");
    const routes = [...new Map(attempts.map((attempt) => [JSON.stringify(attempt.route), attempt.route])).values()];
    return { complete: true, completed: endings.every((ending) => ending === "completed"), calls: attempts.length, totalTokens, routes, answer, turnEndings: endings };
  } catch (error) {
    return { complete: false, completed: false, calls: null, totalTokens: null, routes: [], answer: null, reason: error instanceof Error ? error.message : "DSH 计量核验异常" };
  }
}
