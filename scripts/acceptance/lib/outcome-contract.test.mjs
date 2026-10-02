import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSuite, evaluateThread, evaluateDenial, assertReadOnlySql, outcomeStats } from './outcome-contract.mjs';

const task = {
  id: 'O2-NORMAL', title: '行业事实摘要', input: '今天需要处理哪些待办？', scenario: 'normal', criticality: 'P0', trials: 5,
  thread_asserts: [{ field: 'preset_key', equals: 'industry-analyst' }],
  event_asserts: [{ action: 'ask.answer', field: 'decision.after.text', minLength: 10 }],
  receipt: { require: true, source: 'thread-events' },
};
const event = { event_id: 'E-101', context: { workspace_id: 'ws-1' }, object: { id: 'T-1' }, who: { id: 'industry-analyst' }, decision: { action: 'ask.answer', after: { text: '需要处理一条待办，事实不足时明确说明。' }, params: { via: 'llm' } }, model_trace: { model_id: 'real-model' } };
const observation = { threadId: 'T-1', workspaceId: 'ws-1', thread: { id: 'T-1', status: 'completed', preset_key: 'industry-analyst' }, events: [event], externalAsserts: [] };

test('G14: an empty suite or health-only result contract is rejected', () => {
  assert.ok(validateSuite({ role: 'analyst', tasks: [] }).length);
  const weak = { ...task, thread_asserts: [], event_asserts: [], http_asserts: [{ url: '/health', status: 200 }] };
  assert.match(validateSuite({ role: 'analyst', tasks: [weak] }).join(' '), /结果断言|result/);
});
test('G14: literal assertion values cannot resolve through Object.prototype', () => {
  const literal = { ...task, thread_asserts: [{ field: 'preset_key', equals: 'toString' }] };
  assert.equal(evaluateThread(literal, { ...observation, thread: { ...observation.thread, preset_key: 'toString' } }).pass, true);
  assert.match(validateSuite({ role: 'analyst', tasks: [{ ...task, thread_asserts: [{ field: '__proto__.status', equals: 'completed' }] }] }).join(' '), /thread_asserts/);
});
test('G14: trial limits, duplicate identifiers, malformed assertions and undeclared presets are rejected', () => {
  const errors = validateSuite({ role: 'analyst', agentPreset: 'missing', tasks: [{ ...task, trials: 0 }, { ...task, event_asserts: [{ action: 'ask.answer' }] }] }, { presetKeys: new Set(['industry-analyst']) });
  assert.match(errors.join(' '), /trials/); assert.match(errors.join(' '), /重复/); assert.match(errors.join(' '), /preset/); assert.match(errors.join(' '), /event_asserts/);
});
test('G14: the required normal/failure/permission matrix cannot silently omit a scenario', () => {
  assert.match(validateSuite({ role: 'analyst', tasks: [task] }, { requireScenarioMatrix: true }).join(' '), /failure|permission/);
});
test('G14: completed, concrete result assertions and thread-bound read-back receipt agree', () => {
  const result = evaluateThread(task, observation);
  assert.equal(result.pass, true, JSON.stringify(result)); assert.equal(result.receipt.threadId, 'T-1');
  assert.deepEqual(result.receipt.eventIds, ['E-101']);
});
test('G14: completed without a result or with a wrong identity is false success', () => {
  for (const changed of [{ events: [] }, { thread: { ...observation.thread, id: 'T-other' } }, { events: [{ ...event, object: { id: 'T-other' } }] }, { events: [{ ...event, context: { workspace_id: 'ws-other' } }] }]) {
    const result = evaluateThread(task, { ...observation, ...changed });
    assert.equal(result.pass, false); assert.equal(result.falseSuccess, true);
  }
});
test('G14: assertions cannot pass a still-running or failed thread', () => {
  for (const status of ['running', 'failed', 'pending_review']) {
    const result = evaluateThread(task, { ...observation, thread: { ...observation.thread, status } });
    assert.equal(result.pass, false); assert.equal(result.falseSuccess, false);
  }
});
test('G14: an external tool receipt must be synced and have a real verified timestamp', () => {
  const realTask = { ...task, receipt: { require: true, source: 'tool-events', requireReal: true } };
  const withReceipt = (receipt) => ({ ...observation, events: [{ ...event, receipt }] });
  assert.equal(evaluateThread(realTask, withReceipt({ synced: true, mode: 'real', verified_at: new Date().toISOString() })).pass, true);
  for (const receipt of [{ synced: false }, { synced: true, mode: 'simulated', verified_at: new Date().toISOString() }, { synced: true, mode: 'real' }]) assert.equal(evaluateThread(realTask, withReceipt(receipt)).pass, false);
});
test('G14: expected rejection checks HTTP, typed error, and absence of a created thread', () => {
  const denied = { scenario: 'permission', expect: { status: 401, code: 'UNAUTHORIZED', noThreadCreated: true } };
  assert.equal(evaluateDenial(denied, { status: 401, code: 'UNAUTHORIZED', threadId: null, createdThreads: [] }).pass, true);
  for (const changed of [{ status: 500 }, { code: 'BAD_REQUEST' }, { threadId: 'T-new' }, { createdThreads: ['T-new'] }]) assert.equal(evaluateDenial(denied, { status: 401, code: 'UNAUTHORIZED', threadId: null, createdThreads: [], ...changed }).pass, false);
});
test('G14: SQL assertions reject state changes and stacked statements before connecting', () => {
  assertReadOnlySql('SELECT count(*)::int AS n FROM threads WHERE workspace_id=$1 AND id=$2');
  for (const sql of ['DELETE FROM threads', 'SELECT 1; UPDATE threads SET status=\'completed\'', 'SELECT * FROM threads FOR UPDATE', 'WITH x AS (DELETE FROM threads RETURNING *) SELECT * FROM x', 'SELECT pg_sleep(60)']) assert.throws(() => assertReadOnlySql(sql));
});
test('G14: no trials cannot produce pass metrics and pass^k means every repeated trial passed', () => {
  assert.deepEqual(outcomeStats([]), { tasks: 0, trials: 0, passAt1: null, passAtK: null, k: 0, passed: 0, falseSuccess: 0, clarify: 0, interventions: 0 });
  const stats = outcomeStats([{ taskId: 'A', trial: 1, pass: true }, { taskId: 'A', trial: 2, pass: false }, { taskId: 'B', trial: 1, pass: true }]);
  assert.equal(stats.passAt1, 0.6667); assert.equal(stats.passAtK, 0.5);
});
