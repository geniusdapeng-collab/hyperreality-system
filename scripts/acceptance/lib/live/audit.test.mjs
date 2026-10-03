import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, readDshAudit } from "./audit.plugin.mjs";
import { createBudget, normalizeBudgets } from "./budget.mjs";

function mounted(t, caps = {}) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-live-audit-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { outDir: dir, budgets: normalizeBudgets(caps).budgets, environmentKind: "synthetic", runId: "synthetic-run" };
  const budget = createBudget(options); const budgetConfigFile = join(dir, "config.json"); const file = join(dir, "audit.jsonl");
  writeFileSync(budgetConfigFile, JSON.stringify({ ...options, taskId: "LLM-R1", expectedTokens: 1000 }));
  const listeners = new Map(); const ctx = { on: (name, listener) => listeners.set(name, listener) };
  apply(ctx, { file, budgetConfigFile });
  return { dir, file, budget, listeners, ctx, budgetConfigFile };
}
const usage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 };
const request = { provider: "synthetic", model: "synthetic-model" };
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
async function* valid() { yield { type: "usage", usage }; yield { type: "finish", reason: { kind: "stop" } }; }

test("audit: pinned session/event(session,event) writes events, distinct seq identities and idempotent replay", (t) => {
  const f = mounted(t); const onEvent = f.listeners.get("session/event");
  const event = { type: "turn/start", seq: 0, time: 1000, data: { turn: 0 } };
  onEvent({ id: "session-1" }, event); onEvent({ id: "session-1" }, event);
  onEvent({ id: "session-2" }, event);
  const actual = readDshAudit(f.file); assert.equal(actual.ok, true, actual.reason); assert.equal(actual.lines, 2);
  assert.equal(actual.events[0].type, "turn/start"); assert.equal(actual.events[0].sessionId, "session-1");
  assert.equal(actual.events[1].sessionId, "session-2");
  assert.throws(() => onEvent({ id: "session-1" }, { ...event, data: { turn: 5 } }), /身份复用/);
});

test("audit: damaged hashes, duplicate identities, missing newline and unreadable storage never verify", (t) => {
  for (const mutate of [
    (text) => text.replace('"turn":0', '"turn":5'), (text) => `${text}${text}`, (text) => text.trimEnd(), (text) => `${text}{truncated\n`,
  ]) {
    const f = mounted(t); f.listeners.get("session/event")({ id: "synthetic" }, { type: "turn/start", seq: 0, time: 1000, data: { turn: 0 } });
    writeFileSync(f.file, mutate(readFileSync(f.file, "utf8"))); assert.equal(readDshAudit(f.file).ok, false);
  }
  assert.equal(readDshAudit(join(mounted(t).dir, "missing.jsonl")).ok, false);
});

test("audit: every stream attempt is admitted and settled separately; call cap rejects before provider I/O", async (t) => {
  const f = mounted(t, { maxLlmCalls: 1 }); let calls = 0; const next = () => { calls += 1; return valid(); };
  await collect(f.listeners.get("llm/stream")(request, next)); assert.equal(calls, 1);
  assert.equal(f.budget.summary().actual.llmCalls, 1); assert.equal(f.budget.summary().actual.llmTokens, 10);
  await assert.rejects(() => collect(f.listeners.get("llm/stream")(request, next)), /上限/); assert.equal(calls, 1);
});

test("audit: retries accumulate actual tokens and conservative reservations", async (t) => {
  const f = mounted(t); const call = f.listeners.get("llm/stream"); await collect(call(request, valid)); await collect(call(request, valid));
  assert.equal(f.budget.summary().actual.llmCalls, 2); assert.equal(f.budget.summary().actual.llmTokens, 20);
  assert.equal(f.budget.summary().used.llmTokens, 2000);
});

test("audit: absent, unsafe or interrupted stream usage freezes the next attempt before external I/O", async (t) => {
  for (const stream of [
    async function* () { yield { type: "finish", reason: { kind: "stop" } }; },
    async function* () { yield { type: "usage", usage: { ...usage, totalTokens: -1 } }; yield { type: "finish", reason: { kind: "stop" } }; },
    async function* () { yield { type: "usage", usage }; throw new Error("synthetic lost stream"); },
  ]) {
    const f = mounted(t); const call = f.listeners.get("llm/stream"); await assert.rejects(() => collect(call(request, stream)));
    assert.equal(f.budget.summary().measurementComplete, false); assert.equal(f.budget.summary().unmeasured.llmTokens, 1000);
    let calls = 0; await assert.rejects(() => collect(call(request, () => { calls += 1; return valid(); })));
    assert.equal(calls, 0);
  }
});

test("audit: storage failure rejects model admission, including contained observer exceptions", async (t) => {
  const f = mounted(t); writeFileSync(f.file, ""); chmodSync(f.file, 0o400);
  assert.throws(() => f.listeners.get("session/event")({ id: "synthetic" }, { type: "turn/start", seq: 0, time: 1000, data: { turn: 0 } }));
  let calls = 0; await assert.rejects(() => collect(f.listeners.get("llm/stream")(request, () => { calls += 1; return valid(); })));
  assert.equal(calls, 0); chmodSync(f.file, 0o600);
});

test("audit: secret-bearing events are redacted before persistence and cannot become evidence of success", async (t) => {
  const f = mounted(t); process.env.WORKLOOM_SYNTHETIC_TOKEN = "synthetic-secret-value"; t.after(() => { delete process.env.WORKLOOM_SYNTHETIC_TOKEN; });
  f.listeners.get("session/event")({ id: "synthetic" }, { type: "user/message", seq: 0, time: 1000, data: { text: "synthetic-secret-value" } });
  assert.equal(readFileSync(f.file, "utf8").includes("synthetic-secret-value"), false); assert.equal(readDshAudit(f.file).redacted, true);
  let calls = 0; await assert.rejects(() => collect(f.listeners.get("llm/stream")(request, () => { calls += 1; return valid(); })));
  assert.equal(calls, 0);
});
