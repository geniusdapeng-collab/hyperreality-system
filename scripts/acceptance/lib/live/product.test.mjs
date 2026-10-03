import assert from "node:assert/strict";
import { test } from "node:test";
import { runProductDispatchTask } from "./providers.mjs";
import { verifyExpectations } from "./verification.mjs";

const apiUrl = "https://synthetic.invalid";
const threadId = "synthetic-thread";
const json = (data, status = 200) => new Response(JSON.stringify({ result: { data } }), { status });
const task = () => ({ id: "PROD-01", kind: "product", title: "synthetic", state_asserts: [{ http: { url: `${apiUrl}/state`, status: 200, contains: "healthy" } }] });
const executed = () => ({ event_id: "E-1", context: { time: new Date().toISOString() }, object: { id: threadId }, decision: { kind: "execute", step_id: "step-1", action: "test.execute" }, receipt: { synced: true, mode: "real", snapshot_uri: "https://synthetic.invalid/proof?token=must-not-be-recorded", verified_at: new Date().toISOString() } });
const answered = () => ({ event_id: "E-2", context: { time: new Date().toISOString() }, object: { id: threadId }, decision: { action: "ask.answer", params: { via: "llm" }, after: { text: "行业业务报告已读取：3项事实" } }, model_trace: { model_id: "synthetic-real-model" } });
function setup(t, options = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url); calls.push({ target, init });
    if (target.includes("/threads.dispatch")) return options.dispatch ?? json({ threadId, kind: "routed" });
    if (target.includes("/threads.get")) return options.poll?.(calls) ?? json({ id: threadId, status: "completed", progress_total: 1, progress_done: 1 });
    if (target.includes("/threads.events")) return options.eventsResponse ?? json(options.events ?? [executed()]);
    if (target === `${apiUrl}/state`) return options.state ?? new Response("healthy");
    throw new Error(`Unexpected synthetic URL: ${target}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const run = (input = task(), extra = {}) => runProductDispatchTask({ apiUrl, token: "test-only-synthetic-token", task: input, timeoutMs: 500, pollMs: 0, ...extra });

test("product: completed matching thread, real receipt and every assertion jointly pass", async (t) => {
  const calls = setup(t);
  const input = task(); const result = await run(input);
  assert.equal(result.status, "ok"); assert.equal(result.receipt.synced, true); assert.equal(result.falseSuccess, false);
  assert.equal((await verifyExpectations(input, result)).ok, true);
  const poll = new URL(calls.find((call) => call.target.includes("threads.get")).target);
  assert.deepEqual(JSON.parse(poll.searchParams.get("input")), { threadId });
  assert.equal(result.receipt.realReceipts[0].snapshot_uri, `${apiUrl}/proof`);
  assert.match(result.receipt.evidenceSha256, /^[0-9a-f]{64}$/);
});

for (const status of ["failed", "paused", "pending_review", "cancelled", "canceled", "timeout"]) {
  test(`product: ${status} cannot be turned into completion by a passing HTTP assertion`, async (t) => {
    setup(t, { poll: () => json({ id: threadId, status }) });
    const result = await run(); assert.equal(result.status, "failed"); assert.equal(result.receipt.synced, false); assert.equal(result.finalStatus, status);
  });
}

for (const dispatch of [json({ kind: "clarify" }), json({ kind: "routed" }), json({}, 403), new Response("not JSON")]) {
  test("product: rejected, clarified or malformed dispatch cannot fabricate a thread identity", async (t) => {
    setup(t, { dispatch }); const result = await run();
    assert.equal(result.status, "blocked"); assert.equal(result.threadId, null); assert.equal(result.receipt.synced, false);
  });
}

test("product: another thread's completed poll response is rejected", async (t) => {
  setup(t, { poll: () => json({ id: "other-thread", status: "completed" }) });
  const result = await run(); assert.equal(result.status, "failed"); assert.equal(result.receipt.synced, false); assert.match(result.reason, /身份/);
});

test("product: a valid execution receipt for another thread cannot prove the dispatched result", async (t) => {
  const event = executed(); event.object.id = "another-thread"; setup(t, { events: [event] });
  const result = await run(); assert.equal(result.status, "failed"); assert.equal(result.receipt.synced, false);
});

test("product: running thread times out without a success receipt", async (t) => {
  setup(t, { poll: () => json({ id: threadId, status: "running" }) });
  const result = await run(task(), { timeoutMs: 15 }); assert.equal(result.status, "failed"); assert.equal(result.timedOut, true); assert.equal(result.receipt.synced, false);
});

for (const change of [
  (event) => { event.receipt.mode = "simulated"; },
  (event) => { event.receipt.synced = false; },
  (event) => { event.receipt.snapshot_uri = "workloom-sim://receipt"; },
  (event) => { event.receipt.error = "connector failure"; },
  (event) => { event.receipt.verified_at = "invalid"; },
  (event) => { event.receipt.verified_at = new Date(Date.now() + 3600_000).toISOString(); },
]) {
  test("product: completed thread with invalid or simulated execution evidence remains false success", async (t) => {
    const event = executed(); change(event); setup(t, { events: [event] }); const result = await run();
    assert.equal(result.status, "failed"); assert.equal(result.falseSuccess, true); assert.equal(result.receipt.synced, false);
  });
}

test("product: missing, truncated or unauthorized event receipt fails closed", async (t) => {
  const eventsResponse = json([], 403); setup(t, { eventsResponse });
  const result = await run(); assert.equal(result.status, "failed"); assert.equal(result.falseSuccess, true);
});

test("product: incomplete progress or latest failed receipt cannot be hidden by earlier success", async (t) => {
  const good = executed(); const later = executed(); later.event_id = "E-3"; later.receipt.synced = false;
  setup(t, { events: [good, later] }); const result = await run(); assert.equal(result.status, "failed"); assert.equal(result.receipt.realReceipts.length, 1); assert.equal(result.receipt.realReceipts[0].eventId, "E-3");
});

test("product: empty, malformed and unexecuted SQL assertions cannot pass vacuously", async (t) => {
  setup(t); for (const state_asserts of [[], [{ unknown: "unsupported" }], [{ sql: { query: "SELECT 1", value: 1 } }]]) {
    const result = await run({ ...task(), state_asserts }); assert.equal(result.status, "failed"); assert.equal(result.falseSuccess, true);
  }
});

test("product: SQL connector errors are explicit failed assertions", async (t) => {
  setup(t); const result = await run({ ...task(), state_asserts: [{ sql: { query: "SELECT 1", op: "==", value: 1 } }] }, { allowDb: true, db: { query() { throw new Error("unavailable"); } } });
  assert.equal(result.status, "failed"); assert.equal(result.asserts[0].ok, false); assert.match(result.asserts[0].detail, /失败/);
});

test("product: actual failed HTTP assertion is mandatory even with a real completed receipt", async (t) => {
  setup(t, { state: new Response("unhealthy", { status: 500 }) }); const result = await run();
  assert.equal(result.status, "failed"); assert.equal(result.asserts[0].ok, false); assert.equal(result.receipt.synced, false);
});

test("product: ASK completion uses an actual event read-back and a specific result assertion", async (t) => {
  setup(t, { events: [answered()], poll: () => json({ id: threadId, status: "completed" }) });
  const input = { ...task(), state_asserts: [{ event: { action: "ask.answer", field: "decision.after.text", contains: "行业业务报告", minLength: 10 } }] };
  const result = await run(input); assert.equal(result.status, "ok"); assert.equal(result.receipt.realReceipts[0].type, "api-readback"); assert.equal((await verifyExpectations(input, result)).ok, true);
  result.eventEvidence.events[0].decision.after.text = "tampered";
  assert.equal((await verifyExpectations(input, result)).ok, false);
});

test("product: ASK cannot pass from a health check, another thread or an earlier matching answer", async (t) => {
  const good = answered(); const later = answered(); later.event_id = "E-3"; later.decision.after.text = "unrelated";
  setup(t, { events: [good, later], poll: () => json({ id: threadId, status: "completed" }) });
  assert.equal((await run()).status, "failed");
  const input = { ...task(), state_asserts: [{ event: { action: "ask.answer", field: "decision.after.text", contains: "行业业务报告" } }] };
  assert.equal((await run(input)).status, "failed");
});

test("product: opaque requireModel dispatch is blocked before any model-capable server request", async (t) => {
  const answer = answered(); answer.decision.params.via = "rule"; answer.model_trace.model_id = "mock-001";
  const calls = setup(t, { events: [answer], poll: () => json({ id: threadId, status: "completed" }) });
  const input = { ...task(), requireModel: true, state_asserts: [{ event: { action: "ask.answer", field: "decision.after.text", minLength: 2 } }] };
  const result = await run(input);
  assert.equal(result.status, "blocked"); assert.equal(result.called, false);
  assert.match(result.reason, /逐请求.*预算|预算.*逐请求/); assert.equal(calls.length, 0);
});

test("product: verification recomputes event result and rejects hand-written actual/ok/target claims", async (t) => {
  setup(t, { events: [answered()], poll: () => json({ id: threadId, status: "completed" }) });
  const input = { ...task(), state_asserts: [{ event: { action: "ask.answer", field: "decision.after.text", contains: "行业业务报告" } }] };
  const original = await run(input); assert.equal((await verifyExpectations(input, original)).ok, true);
  for (const mutate of [(result) => { result.asserts[0].actual = ["fabricated"]; }, (result) => { result.asserts[0].target = "other#field"; }, (result) => { result.asserts[0].type = "http"; }]) {
    const result = structuredClone(original); mutate(result); result.asserts[0].ok = true;
    assert.equal((await verifyExpectations(input, result)).ok, false);
  }
});

test("product: dispatch cannot adopt stale receipts or stale ASK answer as current completion", async (t) => {
  const event = executed(); event.receipt.verified_at = "2000-01-01T00:00:00.000Z"; setup(t, { events: [event] });
  assert.equal((await run()).status, "failed");
  const answer = answered(); answer.context.time = "2000-01-01T00:00:00.000Z";
  setup(t, { events: [answer], poll: () => json({ id: threadId, status: "completed" }) });
  const input = { ...task(), state_asserts: [{ event: { action: "ask.answer", field: "decision.after.text", contains: "行业业务报告" } }] };
  assert.equal((await run(input)).status, "failed");
});
