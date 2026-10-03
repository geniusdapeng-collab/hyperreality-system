/** DSH v0.2.0-rc.2 durable lifecycles; no credentials or provider I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldDshUsage, normalizeDshUsage, normalizeOpenAiUsage } from "./usage.mjs";

const sample = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20 };
const ev = (type, data, seq) => ({ type, data, seq, time: 1_000 + seq, sessionId: "synthetic-session" });
const message = (turn, step, usage = sample) => ({ turn, step, usage, stream: [], message: { source: { kind: "model", provider: "synthetic-provider", model: "synthetic-model" }, content: [{ type: "text", text: "TASK_COMPLETE" }] } });
function turn(usage = sample, end = "completed") {
  return [ev("turn/start", { turn: 0 }, 0), ev("step/start", { turn: 0, step: 0 }, 1), ev("assistant/message", message(0, 0, usage), 2), ev("step/end", { turn: 0, step: 0 }, 3), ev("turn/end", { turn: 0, reason: { kind: end } }, 4)];
}

test("usage: exact provider totals include cache buckets and never coerce unsafe counts", () => {
  assert.equal(normalizeDshUsage(sample)?.totalTokens, 20);
  assert.equal(normalizeDshUsage({ ...sample, totalTokens: undefined })?.totalTokens, 20);
  assert.equal(normalizeDshUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 20 })?.totalTokens, 20);
  for (const invalid of [null, {}, { inputTokens: 10, outputTokens: 5 }, { ...sample, inputTokens: "10" }, { ...sample, totalTokens: 19 }, { ...sample, outputTokens: -1 }, { ...sample, totalTokens: Infinity }, { ...sample, reasoningTokens: 6 }, { ...sample, cacheReadTokens: 0.5 }]) assert.equal(normalizeDshUsage(invalid), null);
  assert.equal(normalizeOpenAiUsage({ total_tokens: 15, prompt_tokens: 10, completion_tokens: 5 })?.totalTokens, 15);
  assert.equal(normalizeOpenAiUsage({ prompt_tokens: 10, completion_tokens: 5 })?.totalTokens, 15);
  for (const invalid of [{}, { total_tokens: "15" }, { total_tokens: 14, prompt_tokens: 10, completion_tokens: 5 }, { total_tokens: -1 }]) assert.equal(normalizeOpenAiUsage(invalid), null);
});

test("usage: a complete terminal turn accounts for actual attempts and model route", () => {
  const actual = foldDshUsage(turn());
  assert.equal(actual.complete, true, actual.reason); assert.equal(actual.completed, true); assert.equal(actual.totalTokens, 20); assert.equal(actual.calls, 1);
  assert.deepEqual(actual.routes, [{ provider: "synthetic-provider", model: "synthetic-model" }]);
});

test("usage: every failed attempt and retry is accounted before its successful final message", () => {
  const stream = [{ type: "chunk", time: 1_003, chunk: { type: "usage", usage: sample } }];
  const entries = [["turn/start", { turn: 0 }], ["step/start", { turn: 0, step: 0 }], ["request/header", { header: { config: { provider: "synthetic-provider", model: "synthetic-model" } } }], ["assistant/attempt", { turn: 0, step: 0, stream }], ["llm/retry", { turn: 0, step: 0, retry: 1 }], ["llm/retry-started", { turn: 0, step: 0, retry: 1 }], ["assistant/message", message(0, 0)], ["step/end", { turn: 0, step: 0 }], ["turn/end", { turn: 0, reason: { kind: "completed" } }]];
  const events = entries.map(([type, data], seq) => ev(type, data, seq));
  const actual = foldDshUsage(events); assert.equal(actual.complete, true, actual.reason); assert.equal(actual.totalTokens, 40); assert.equal(actual.calls, 2);
});

test("usage: multiple steps and separate sessions accumulate rather than overwrite", () => {
  const events = [...turn(), ...turn().map((event) => ({ ...event, sessionId: "synthetic-child" }))];
  const actual = foldDshUsage(events); assert.equal(actual.complete, true, actual.reason); assert.equal(actual.totalTokens, 40); assert.equal(actual.calls, 2);
});

test("usage: missing boundaries, usage, identity, truncated streams and unknown required events remain unavailable", () => {
  for (const corrupt of [
    (events) => events.pop(), (events) => events.splice(1, 1), (events) => { delete events[2].data.usage; },
    (events) => { events[2].data.usage.totalTokens = -1; }, (events) => { events[2].data.step = 5; },
    (events) => { events[2].seq = 10; }, (events) => { events[0].type = "unknown/required"; },
    (events) => { events[2].data.interrupted = true; }, (events) => { events[2].data.message.source.model = ""; },
  ]) {
    const events = structuredClone(turn()); corrupt(events); assert.equal(foldDshUsage(events).complete, false);
  }
  const failed = foldDshUsage(turn(sample, "error")); assert.equal(failed.complete, true); assert.equal(failed.completed, false);
  assert.equal(foldDshUsage([]).complete, false);
});
