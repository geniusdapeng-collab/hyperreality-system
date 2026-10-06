import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admissionErrors, admitSource, appendEvent, checksVerdict, dependencyState, eligibility, emptyState, hash, leaseOperation, parseIntent, releaseKey, updateTask, validateReview, validateState, validateDeveloperReview } from './queue-model.mjs';
import { GitStateStore, git } from './git-state.mjs';
import { alignBranch, independentCodeBuddyApproval, prepareReview, finishReview, dispatchRecovery } from './queue-work.mjs';
import { Platform } from './queue-platform.mjs';
import { BASE_POLICY, REVIEW_IMAGE, ciImplementationChanges, loadPolicy, parser, prPipelines, readableCiChanges, resolvePipelineConfig, sourcePipelineReport, validateSourcePipeline } from './queue-policy.mjs';
import { dependencies, integratedDependency, mergeCandidate, reconcile, requestReview, reviewSlotBusy, writeTaskReceipts } from './queue-controller.mjs';
import { downloadReleaseBytes, enqueueReleases, reconcileReleases, releaseEventFor, verifyRelease } from './queue-release.mjs';
import { injectDeliveryConfig } from './install-config.mjs';
import { batchEnvironment, batchSnapshot, botApiEndpoint, combineBatchResults, reviewBatches, reviewEnvironment, runReview, validateIssueSchema } from './review-plugin.mjs';
import { configureAutomaticReviewPolicy, ensureCandidateProtection, ensureStateProtection, prepareInstallation, requireTrustedRunner, verifyInstallerChecks, verifyPreparedInstallation } from './queue-runner.mjs';
import { verifyReleaseSource } from './release-source.mjs';
import { modelGateway } from './model-gateway.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { api, rawFile } from '../tools/cnb-api.mjs';
const repo = 'workloom-ai/test'; const head = 'a'.repeat(40); const main = 'b'.repeat(40); const mergedSha = 'c'.repeat(40); const testedSha = 'd'.repeat(40); const now = 10_000_000;
const policy = { ...BASE_POLICY, hash: 'policy-1', requiredNames: ['static-gate'] };
const intent = { ready: true, dependsOn: [], releases: [], taskId: null };
test('genuine AI endpoint configuration has a clear closed failure for absent, malformed and foreign values', () => {
  assert.equal(botApiEndpoint({ CNB_API_ENDPOINT: 'https://api.cnb.cool' }), 'https://api.cnb.cool');
  for (const value of [undefined, '', 'invalid', 'http://api.cnb.cool', 'https://example.com']) assert.throws(() => botApiEndpoint({ CNB_API_ENDPOINT: value }), /requires CNB_API_ENDPOINT/);
});
function snapshot(number = 1, patch = {}) {
  return { repo, number, headSha: head, mainSha: main, headTime: 0, mergeBase: main, files: ['apps/example.ts'], checkErrors: [], checkSha: testedSha, intent,
    pull: { number, title: 'fix(base): useful change', body: '', author: { username: 'developer' }, state: 'open', is_wip: false, mergeable_state: 'mergeable', labels: [], head: { sha: head, ref: `task/test-${number}`, repo: { path: repo } }, base: { sha: main, ref: 'main' } }, ...patch };
}
function reviewInput(s = snapshot(), p = policy, at = now) {
  return { schemaVersion: 1, provider: 'codex', repo: s.repo, number: s.originNumber ?? s.number, headSha: s.headSha, mainSha: s.mainSha,
    policyHash: p.hash, reviewedFiles: s.files, dependsOn: s.intent.dependsOn,
    ciPolicyChanges: (s.ciPolicyChanges ?? []).map(change => ({ id: change.id, rationale: 'Read exact old/new implementation; retained assertions, failure handling and rollback.' })),
    reviewedAt: new Date(at).toISOString(), summary: 'Actual review of all changed files and their direct dependencies; no unresolved blocking issues.',
    tests: [{ command: 'node --test actual-regression.test.mjs', exitCode: 0, finishedAt: new Date(at).toISOString(), result: 'Actual fixture test succeeded' }] };
}
function review(s = snapshot(), p = policy, at = now) { return validateDeveloperReview(reviewInput(s, p, at), s, p, at); }
function candidateReceipt(s, origin = s.originNumber) {
  const marker = `delivery-origin:${origin}:${s.headSha}:${s.mainSha}`;
  s.pull.body = `<!-- ${marker} -->`;
  return { number: s.number, marker, headSha: s.headSha, mainSha: s.mainSha };
}
function memoryStore(initial = emptyState(repo)) {
  let value = structuredClone(initial);
  return { read: async () => structuredClone(value), mutate: async operation => { const next = structuredClone(value); const result = operation(next); validateState(next, repo); value = next; return { state: structuredClone(value), result }; } };
}
function activate(state) { appendEvent(state, 'activated', { policyHash: policy.hash }, now); return state; }
async function temporary(t, prefix) { const root = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('lease acquisition is atomic across scopes; TTL reclaim fences stale renewal and release', () => {
  const state = emptyState(repo); const generation = leaseOperation(state, { action: 'acquire', owner: 'a', scopes: ['protocol', 'sync'], ttlMs: 60000 }, 0);
  assert.throws(() => leaseOperation(state, { action: 'acquire', owner: 'b', scopes: ['migrations', 'sync'] }, 1), /busy/);
  assert.equal(state.leases.migrations, undefined);
  const next = leaseOperation(state, { action: 'acquire', owner: 'b', scopes: ['sync'], ttlMs: 60000 }, 60000);
  assert.equal(next.sync, generation.sync + 1);
  for (const action of ['release', 'renew']) assert.throws(() => leaseOperation(state, { action, owner: 'a', scopes: ['sync'], generation }, 60001), /expired/);
  leaseOperation(state, { action: 'release', owner: 'b', scopes: ['sync'], generation: next }, 60001);
  assert.equal(state.leases.sync.owner, null); validateState(state, repo);
});
test('lease empty/oversized TTL and mismatched scope generation cannot silently succeed', () => {
  for (const spec of [{ scopes: [] }, { ttlMs: 59999 }, { ttlMs: 1800001 }, { owner: '' }, { scopes: [''] }]) assert.throws(() => leaseOperation(emptyState(repo), { action: 'acquire', owner: 'a', scopes: ['protocol'], ...spec }, 0));
});
test('automatic sensitive-source admission has exact positive owner/generation receipts, blocks live writers and permits released newer generations', () => {
  const state = emptyState(repo); const identity = { number: 1, headSha: head, mainSha: main, files: ['scripts/ci/a.mjs'] };
  assert.ok(admissionErrors(state, identity).length);
  const live = leaseOperation(state, { action: 'acquire', owner: 'developer', scopes: ['protocol'] }, 0);
  assert.throws(() => admitSource(state, identity, 1), /busy/); assert.equal(state.tasks['1'], undefined);
  leaseOperation(state, { action: 'release', owner: 'developer', scopes: ['protocol'], generation: live }, 2);
  admitSource(state, identity, 3); assert.deepEqual(admissionErrors(state, identity), []); assert.equal(state.leases.protocol.owner, null);
  assert.ok(admissionErrors(state, { ...identity, headSha: main }).length); assert.ok(admissionErrors(state, { ...identity, files: ['scripts/ci/b.mjs'] }).length);
  admitSource(state, { ...identity, number: 2 }, 4); assert.deepEqual(admissionErrors(state, identity), []);
  const broken = structuredClone(state); broken.tasks['1'].admission.generation.protocol = 0; assert.ok(admissionErrors(broken, identity).length);
  const missing = structuredClone(state); missing.events = []; assert.ok(admissionErrors(missing, identity).length);
  validateState(state, repo);
});
test('state hash chain detects history tampering and incomplete/foreign snapshots', () => {
  const state = emptyState(repo); updateTask(state, 1, { status: 'waiting_ci' }, now); validateState(state, repo);
  const bad = structuredClone(state); bad.events[0].data.patch.status = 'delivered'; assert.throws(() => validateState(bad, repo), /chain/);
  for (const invalid of [{ ...state, repo: 'foreign/repo' }, { ...state, revision: 5 }, { ...state, tasks: { 1: { status: 'invented' } } }]) assert.throws(() => validateState(invalid, repo));
});
test('explicit intent preserves native prerequisites and rejects duplicates/self dependency/ambiguous releases', () => {
  const pull = { number: 4, title: 'task T-2026-1005-1001', blocked_on: [{ number: 2 }], body: '<!-- workloom-delivery\n{"ready":true,"depends_on":[1],"releases":[{"kind":"ui","version":"1.2.3"}]}\n-->' };
  assert.deepEqual(parseIntent(pull).dependsOn, [1, 2]); assert.equal(parseIntent(pull).taskId, 'T-2026-1005-1001');
  for (const body of [pull.body + pull.body, '<!-- workloom-delivery\n{"depends_on":[4]}\n-->', '<!-- workloom-delivery\n{"releases":[{"kind":"ui","version":"latest"}]}\n-->', '<!-- workloom-delivery\n{"ready":"yes"}\n-->', '<!-- workloom-delivery\n{"bypass":true}\n-->']) assert.throws(() => parseIntent({ ...pull, body }));
});
test('dependency DAG reports cycles and closed unmerged prerequisites remain pending', async () => {
  assert.throws(() => dependencyState(1, new Map([[1, [2]], [2, [1]]]), new Set()), /cycle/);
  const pulls = [{ ...snapshot().pull, body: '<!-- workloom-delivery\n{"depends_on":[2]}\n-->' }];
  const result = await dependencies({ pull: async () => ({ state: 'closed', is_merged: false }) }, pulls, emptyState(repo));
  assert.deepEqual(result.get(1).pending, [2]);
  const advanced = { head: { sha: head }, is_merged: false };
  assert.equal(integratedDependency(advanced, { status: 'waiting_ci', merge: { sourceSha: head } }), false);
  assert.equal(integratedDependency(advanced, { status: 'integrated', merge: { sourceSha: main } }), false);
  assert.equal(integratedDependency(advanced, { status: 'integrated', merge: { sourceSha: head } }), true);
});
test('malformed contract isolates one PR instead of breaking unrelated dependency analysis', async () => {
  const list = [{ ...snapshot(1).pull, body: '<!-- workloom-delivery\nBAD\n-->' }, snapshot(2).pull];
  const map = await dependencies({}, list, emptyState(repo)); assert.ok(map.get(1).error); assert.deepEqual(map.get(2), { pending: [], error: null });
});
test('unreadable dependency blocks its dependents while unrelated PRs keep progressing', async () => {
  const list = [{ ...snapshot(1).pull, body: '<!-- workloom-delivery\n{"depends_on":[3]}\n-->' }, snapshot(2).pull];
  const map = await dependencies({ pull: async () => { throw new Error('denied'); } }, list, emptyState(repo));
  assert.match(map.get(1).error, /Prerequisite #3 is unreadable/); assert.deepEqual(map.get(1).pending, [3]);
  assert.deepEqual(map.get(2), { pending: [], error: null });
});
test('revoked platform review, prepare, finish, recovery and model entry points fail before any IO', async () => {
  let calls = 0;
  const forbidden = new Proxy({}, { get() { calls++; throw new Error('External platform IO is forbidden'); } });
  for (const operation of [requestReview, prepareReview, finishReview, dispatchRecovery, modelGateway, runReview]) await assert.rejects(operation(forbidden, forbidden, forbidden), /Platform AI is disabled/);
  assert.equal(calls, 0);
  assert.equal(await reviewSlotBusy(forbidden, forbidden), false); assert.equal(calls, 0);
});

test('legacy paid-review CLI commands fail before credentials, Git, snapshots or network', () => {
  const cli = fileURLToPath(new URL('./queue-runner.mjs', import.meta.url));
  const env = { ...process.env }; delete env.CNB_TOKEN; delete env.CNB_TOKEN_FOR_AI; delete env.CNB_TOKEN_FOR_CODEBUDDY;
  const prelude = `globalThis.fetch=()=>{console.error('FORBIDDEN_NETWORK');throw new Error('Unexpected network');};`;
  for (const command of ['review-prepare', 'review-finish']) {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(prelude)}`, cli, command], { env, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Platform AI is disabled/); assert.doesNotMatch(result.stderr, /FORBIDDEN_NETWORK|CNB_TOKEN is required/);
  }
});

test('AI receipt requires exact identity, complete unique scope, no unresolved issues and valid prerequisites', () => {
  const s = snapshot(); const good = { status: 'passed', issues: [], reviewed_files: s.files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] };
  assert.equal(validateReview(good, s, policy.hash).passed, true);
  for (const patch of [{ status: 'critical' }, { issues: [{ problem: 'bug' }] }, { reviewed_files: [] }, { reviewed_files: [...s.files, ...s.files] }, { head_sha: main }, { base_sha: head }, { policy_hash: 'old' }, { depends_on: [1] }]) assert.throws(() => validateReview({ ...good, ...patch }, s, policy.hash));
});
test('real platform approval requires an independent known creator, actual NPC identity and a fresh decision', () => {
  const pull = { author: { username: 'creator' } }; const approval = { id: 'review-1', state: 'approved', author: { username: 'CodeBuddy', is_npc: true }, created_at: new Date(now).toISOString() };
  assert.equal(independentCodeBuddyApproval([approval], pull, now).creator, 'creator');
  for (const change of [{ state: 'changes_requested' }, { created_at: new Date(now - 1).toISOString() }, { author: { username: 'CodeBuddy', is_npc: false } }, { author: { username: 'another-bot', is_npc: true } }]) assert.throws(() => independentCodeBuddyApproval([{ ...approval, ...change }], pull, now), /independent/);
  assert.throws(() => independentCodeBuddyApproval([approval], { author: { username: 'codebuddy' } }, now), /independent/);
  assert.throws(() => independentCodeBuddyApproval([approval], {}, now), /known/);
  assert.throws(() => independentCodeBuddyApproval([approval], pull, NaN), /freshness/);
});
test('CI must test exact main/source parents and each trusted required pipeline, never a loose green commit', () => {
  const payload = { sha: testedSha, statuses: [{ context: 'cnb/pull_request/pipeline-1(static-gate)', state: 'success' }, { context: 'cnb/pull_request/pipeline-2(debt-gate)', state: 'error' }] };
  const commit = { sha: testedSha, parents: [{ sha: main }, { sha: head }] };
  assert.deepEqual(checksVerdict(payload, commit, { headSha: head, mainSha: main }, ['static-gate']), []);
  assert.ok(checksVerdict(payload, { ...commit, parents: [{ sha: head }, { sha: main }] }, { headSha: head, mainSha: main }, ['static-gate']).length);
  for (const statuses of [[], [payload.statuses[0], payload.statuses[0]], [{ ...payload.statuses[0], state: 'pending' }], [{ ...payload.statuses[0], context: 'cnb/push/pipeline-1(static-gate)' }]]) assert.ok(checksVerdict({ ...payload, statuses }, commit, { headSha: head, mainSha: main }, ['static-gate']).length);
});
test('installer activation binds tested main to the independent preparation receipt, not a tested parent to itself', () => {
  const state = emptyState(repo); const installer = { number: 234, head: { sha: head } };
  appendEvent(state, 'installation_prepared', { installer: 234, headSha: head, mainSha: main });
  const statuses = { sha: testedSha, statuses: ['static-gate', 'delivery-bootstrap-checks'].map(name => ({ context: `cnb/pull_request/pipeline-1(${name})`, state: 'success' })) };
  const tested = { sha: testedSha, parents: [{ sha: main }, { sha: head }] };
  const input = { state, installer, statuses, tested, requiredNames: ['static-gate'] };
  assert.equal(verifyInstallerChecks(input).mainSha, main);
  assert.throws(() => verifyInstallerChecks({ ...input, tested: { ...tested, parents: [{ sha: mergedSha }, { sha: head }] } }), /source\/main pair/);
  assert.throws(() => verifyInstallerChecks({ ...input, state: emptyState(repo) }), /prepared/);
  assert.throws(() => verifyInstallerChecks({ ...input, installer: { ...installer, head: { sha: main } } }), /prepared/);
});
test('exact Codex review and local tests replace the human review counter, removes the admin manual exception and preserves remaining restrictions including lost acknowledgement recovery', async () => {
  const { branchProtectionPayload, validateBranchProtection } = await import('../tools/cnb-api.mjs');
  let rule = { ...branchProtectionPayload(), id: 'main-rule', required_master_approve: true }; let writes = 0;
  const platform = { protections: async () => [rule], call: async (_path, options) => { writes++; rule = { ...options.body, id: rule.id }; throw new Error('lost acknowledgement'); } };
  const proof = { developerReview: review(), reviewSnapshot: snapshot(), policy, preparation: { headSha: head, mainSha: main } };
  await assert.rejects(configureAutomaticReviewPolicy(platform), /Codex review identity/); assert.equal(writes, 0);
  await assert.rejects(configureAutomaticReviewPolicy(platform, { ...proof, developerReview: { ...proof.developerReview, provider: 'external-platform' } }), /Codex review identity/); assert.equal(writes, 0);
  const before = { ...rule }; const after = await configureAutomaticReviewPolicy(platform, proof);
  assert.equal(after.required_pull_request_reviews, false); assert.equal(after.required_master_approve, false);
  assert.equal(after.allow_master_manual_merge, false);
  for (const [key, value] of Object.entries(before)) if (!['required_pull_request_reviews', 'required_master_approve', 'allow_master_manual_merge'].includes(key)) assert.equal(after[key], value);
  assert.ok(validateBranchProtection({ ...after, allow_master_manual_merge: true }, { requireReview: false, forbidManualOverride: true }).some(error => error.includes('allow_master_manual_merge')));
  await configureAutomaticReviewPolicy(platform, proof); assert.equal(writes, 1);
  rule.allow_master_pushes = true; await assert.rejects(configureAutomaticReviewPolicy(platform, proof), /allow_master_pushes/); assert.equal(writes, 1);
});
test('eligibility rejects draft/block/expired review/wrong main/unhanded head even with green CI', () => {
  const s = snapshot(); assert.deepEqual(eligibility(s, { developerReview: review(s) }, policy, now), []);
  for (const patch of [{ pull: { ...s.pull, is_wip: true } }, { pull: { ...s.pull, labels: ['risk/block'] } }, { mainSha: head }, { intent: { ...intent, ready: false } }, { pendingDependencies: [2] }, { files: ['secrets/real'] }]) assert.ok(eligibility({ ...s, ...patch }, { developerReview: review(s) }, policy, now).length);
  assert.ok(eligibility(s, { developerReview: { ...review(s), policyHash: 'old' } }, policy, now).some(value => /Codex review identity/.test(value)));
});
test('Codex receipt requires exact repository, source/main/policy, full coverage, actual tests and preserved prerequisites', () => {
  const s = snapshot(1, { headTime: now - 1000, intent: { ...intent, dependsOn: [2] } }); const input = reviewInput(s);
  const good = review(s); assert.deepEqual(eligibility(s, { developerReview: good }, policy, now), []);
  const cases = [{ provider: 'codebuddy' }, { repo: 'foreign/repo' }, { number: 2 }, { headSha: main }, { mainSha: head }, { policyHash: 'old' },
    { reviewedFiles: [] }, { reviewedFiles: [...s.files, ...s.files] }, { reviewedAt: new Date(now - 1001).toISOString() }, { reviewedAt: new Date(now + 60001).toISOString() },
    { summary: '' }, { tests: [] }, { tests: [{ ...input.tests[0], exitCode: 1 }] }, { tests: [{ ...input.tests[0], finishedAt: new Date(now - 1001).toISOString() }] },
    { tests: [{ ...input.tests[0], result: '' }] }, { tests: [{ ...input.tests[0], finishedAt: new Date(now + 1).toISOString() }] }, { dependsOn: [] }, { dependsOn: [1,2] }];
  for (const patch of cases) assert.throws(() => validateDeveloperReview({ ...input, ...patch }, s, policy, now), JSON.stringify(patch));
  for (const patch of [{ summary: 'altered' }, { filesHash: 'altered' }, { ciPolicyChangesHash: 'altered' }]) assert.throws(() => validateDeveloperReview({ ...good, ...patch }, s, policy, now), /altered/);
  assert.ok(eligibility(s, { review: { passed: true, platformReview: { author: 'CodeBuddy' } } }, policy, now).length);
  assert.ok(eligibility({ ...s, intent: { ...s.intent, ready: undefined } }, { developerReview: good }, policy, now).includes('Developer has not handed off'));
});

test('only read transport failures and retryable HTTP statuses retry; writes and permission failures remain single attempts', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async () => { if (++calls === 1) throw new TypeError('network interrupted'); return Response.json({ actual: true }); };
  assert.deepEqual(await api(repo, '/-/pulls/1', { token: 'fixture', baseDelayMs: 0 }), { actual: true }); assert.equal(calls, 2);
  calls = 0; globalThis.fetch = async () => { calls++; throw new TypeError('lost write response'); };
  await assert.rejects(api(repo, '/-/pulls', { method: 'POST', body: {}, token: 'fixture', baseDelayMs: 0 }), /lost write/); assert.equal(calls, 1);
  calls = 0; globalThis.fetch = async () => { calls++; return new Response('denied', { status: 403 }); };
  await assert.rejects(api(repo, '/-/pulls/1', { token: 'fixture', baseDelayMs: 0 }), { status: 403 }); assert.equal(calls, 1);
  calls = 0; globalThis.fetch = async () => ++calls === 1 ? new Response('paced', { status: 429, headers: { 'retry-after': '0.001' } }) : Response.json({ recovered: true });
  assert.deepEqual(await api(repo, '/-/pulls/1', { token: 'fixture', baseDelayMs: 0 }), { recovered: true }); assert.equal(calls, 2);
});
test('raw asset permission and transport failures stay errors and redact actual credentials; only 404 means absent', async t => {
  const previous = globalThis.fetch; const credential = randomUUID();
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response('backend ' + credential, { status: 503 });
  await assert.rejects(rawFile(repo, main, 'required.json', { token: credential }), error => error.status === 503 && !error.message.includes(credential));
  globalThis.fetch = async () => { throw new TypeError('network ' + credential); };
  await assert.rejects(rawFile(repo, main, 'required.json', { token: credential }), error => /network/.test(error.message) && !error.message.includes(credential));
  globalThis.fetch = async () => new Response('', { status: 404 }); assert.equal(await rawFile(repo, main, 'absent.json', { token: credential }), null);
});
test('source CI preserves required identities; implementation changes require exact AI migration evidence', async () => {
  const YAML = await parser(); const baseline = { name: 'static-gate', stages: [{ name: 'compile', script: 'compile' }, { name: 'test', script: 'test' }] };
  const p = { requiredPipelines: [baseline] };
  const text = pipeline => YAML.stringify({ '**': { pull_request: [pipeline] } });
  assert.deepEqual(await validateSourcePipeline(text({ ...baseline, stages: [...baseline.stages, { name: 'more', script: 'more' }] }), p), []);
  for (const changed of [{ ...baseline, allowFailure: true }, { ...baseline, name: 'pretend' }, { ...baseline, stages: [baseline.stages[1]] }, { ...baseline, stages: [...baseline.stages].reverse() }]) assert.ok((await validateSourcePipeline(text(changed), p)).length);
  const report = await sourcePipelineReport(text({ ...baseline, stages: [{ ...baseline.stages[0], script: 'upgraded-compile' }, baseline.stages[1]] }), p);
  assert.deepEqual(report.errors, []); assert.equal(report.changes.length, 1);
  const s = snapshot(1, { ciPolicyChanges: report.changes });
  const output = { status: 'passed', issues: [], reviewed_files: s.files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] };
  assert.throws(() => validateReview(output, s, policy.hash), /migration/);
  for (const ci_policy_changes of [[{ id: 'wrong', rationale: 'tested' }], [{ id: report.changes[0].id, rationale: '' }]]) assert.throws(() => validateReview({ ...output, ci_policy_changes }, s, policy.hash), /migration/);
  const receipt = validateReview({ ...output, ci_policy_changes: [{ id: report.changes[0].id, rationale: 'The replacement runs the same compile with updated tooling; compile regression remains required.' }] }, s, policy.hash);
  assert.deepEqual(eligibility(s, { developerReview: review(s) }, policy, now), []);
  assert.throws(() => validateDeveloperReview({ ...reviewInput(s), ciPolicyChanges: [] }, s, policy, now), /CI implementation change/);
});
test('unchanged YAML cannot hide edits to required check implementations and dependency policy', () => {
  const files = [{ path: 'scripts/ci/verify-lock-conflict.mjs', status: 'modify' }, { path: 'governance/scripts/ci/verify.py', status: 'delete' }, { path: 'pnpm-lock.yaml', status: 'modify' }, { path: 'scripts/delivery/cnb.yml', status: 'add' }, { path: 'apps/product.ts', status: 'modify' }];
  const changes = ciImplementationChanges(files, main, head);
  assert.equal(changes.length, 4);
  assert.deepEqual(changes[0].before, { ref: main, path: files[0].path, absent: false });
  assert.equal(changes[1].after.absent, true); assert.equal(changes[3].before.absent, true);
  assert.notEqual(changes[0].id, ciImplementationChanges(files, head, main)[0].id);
  const s = snapshot(1, { files: files.map(file => file.path), ciPolicyChanges: changes });
  const output = { status: 'passed', issues: [], reviewed_files: s.files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] };
  assert.throws(() => validateReview(output, s, policy.hash), /migration/);
  assert.equal(validateReview({ ...output, ci_policy_changes: changes.map(change => ({ id: change.id, rationale: 'Read exact old/new Git source and verified retained assertions.' })) }, s, policy.hash).passed, true);
});
test('root CI and every actual old/new local include require exact receipts even for additive non-required pipelines', async t => {
  const root = await temporary(t, 'delivery-ci-inputs-');
  const before = 'include: old-policy.conf\nmain:\n  pull_request:\n    - name: static-gate\n      stages: [{name: check, script: check}]\n';
  await writeFile(join(root, '.cnb.yml'), before); await writeFile(join(root, 'old-policy.conf'), 'main:\n  push: []\n');
  const trusted = await loadPolicy(root);
  const after = before.replace('old-policy.conf', 'new-policy.conf') + '  push:\n    - name: extra\n      stages: [{name: new action, script: added}]\n';
  const report = await sourcePipelineReport(after, trusted, { readLocal: async path => { assert.equal(path, 'new-policy.conf'); return 'main:\n  push: []\n'; } });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.changes, []);
  assert.deepEqual(trusted.ciFiles, ['.cnb.yml', 'old-policy.conf']); assert.deepEqual(report.ciFiles, ['.cnb.yml', 'new-policy.conf']);
  const paths = ['.cnb.yml', 'old-policy.conf', 'new-policy.conf'];
  const changes = readableCiChanges(ciImplementationChanges(paths.map(path => ({ path, status: 'modify' })), main, head, [...trusted.ciFiles, ...report.ciFiles]));
  assert.deepEqual(changes.map(change => change.file).sort(), paths.sort());
  assert.deepEqual(ciImplementationChanges([{ path: '.cnb.yml', status: 'modify' }], main, head).map(change => change.file), ['.cnb.yml']);
  const s = snapshot(1, { files: paths, ciPolicyChanges: changes });
  const output = { status: 'passed', issues: [], reviewed_files: paths, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] };
  for (const ci_policy_changes of [[], changes.slice(1).map(change => ({ id: change.id, rationale: 'reviewed' }))]) assert.throws(() => validateReview({ ...output, ci_policy_changes }, s, policy.hash), /migration/);
  assert.equal(validateReview({ ...output, ci_policy_changes: changes.map(change => ({ id: change.id, rationale: 'Exact old/new CI input read; product assertions and revert retained.' })) }, s, policy.hash).passed, true);
});
test('short AI migration identifiers are deterministic but retain complete digest binding, even when two snapshots reuse the same ordinal', () => {
  const changes = ciImplementationChanges([{ path: 'scripts/ci/check.mjs', status: 'modify' }, { path: 'scripts/delivery/queue-model.mjs', status: 'modify' }], main, head);
  const readable = readableCiChanges(changes);
  assert.deepEqual(readableCiChanges([...changes].reverse()), readable); assert.deepEqual(readable.map(change => change.id), ['CI-001', 'CI-002']);
  assert.deepEqual(readable.map(change => change.digest).sort(), changes.map(change => change.id).sort());
  assert.throws(() => readableCiChanges([...changes, changes[0]]), /duplicated/);
  const s = snapshot(1, { files: changes.map(change => change.file), ciPolicyChanges: readable });
  const output = { status: 'passed', issues: [], reviewed_files: s.files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [], ci_policy_changes: readable.map(change => ({ id: change.id, rationale: 'Read exact old/new source; retained regression and rollback.' })) };
  const receipt = review(s); assert.deepEqual(eligibility(s, { developerReview: receipt }, policy, now), []);
  assert.ok(eligibility({ ...s, ciPolicyChanges: [{ ...readable[0], digest: 'f'.repeat(64) }, readable[1]] }, { developerReview: receipt }, policy, now).some(value => /altered/.test(value)));
  assert.throws(() => validateReview({ ...output, ci_policy_changes: [{ id: 'CI-001', rationale: 'read' }, { id: 'CI-001', rationale: 'read' }] }, s, policy.hash), /migration/);
});
test('local include graph preserves product arrays and structurally pins delivery events and stage order', async t => {
  const root = await temporary(t, 'delivery-policy-'); const YAML = await parser();
  const gate = { name: 'static-gate', stages: [{ name: 'check', script: 'check' }] };
  const delivery = { name: 'delivery-ai-review', stages: [{ name: 'snapshot', script: 'snapshot' }, { name: 'review', script: 'review' }] };
  const source = YAML.stringify({ include: 'local.yml', main: { pull_request: [gate] } });
  const included = YAML.stringify({ main: { pull_request: [{ name: 'included-gate', stages: [{ name: 'extra', script: 'extra' }] }], 'pull_request.target': [delivery] } });
  await writeFile(join(root, '.cnb.yml'), source); await writeFile(join(root, 'local.yml'), included);
  const p = await loadPolicy(root); assert.deepEqual(p.requiredNames, ['included-gate', 'static-gate']);
  assert.deepEqual((await sourcePipelineReport(source, p, { readLocal: async () => included })).errors, []);
  for (const stages of [delivery.stages.slice(1), [...delivery.stages].reverse()]) {
    const changed = YAML.stringify({ main: { pull_request: [{ name: 'included-gate', stages: [{ name: 'extra', script: 'extra' }] }], 'pull_request.target': [{ ...delivery, stages }] } });
    assert.ok((await sourcePipelineReport(source, p, { readLocal: async () => changed })).errors.length);
  }
  assert.ok((await sourcePipelineReport(YAML.stringify({ main: { pull_request: [gate] } }), p)).errors.length);
  await assert.rejects(resolvePipelineConfig('include: ../escape.yml\n', { readLocal: async () => included }), /safe local/);
  await assert.rejects(resolvePipelineConfig('include: local.yml\n', { readLocal: async () => 'include: local.yml\n' }), /cycle/);
  await assert.rejects(resolvePipelineConfig(source, { readLocal: async () => { throw new Error('denied'); } }), /denied/);
});
test('CI installation is idempotent and preserves every existing product event/stage', async () => {
  const input = '# existing\nmain:\n  push:\n    - name: product\n      stages: [keep]\ninclude: old.yml\n'; const YAML = await parser();
  const installed = await injectDeliveryConfig(input); assert.equal(installed.changed, true);
  assert.deepEqual(YAML.parse(installed.content).main, YAML.parse(input).main);
  assert.deepEqual(YAML.parse(installed.content).include, ['old.yml', 'scripts/delivery/cnb.yml']);
  assert.equal((await injectDeliveryConfig(installed.content)).changed, false);
  await assert.rejects(injectDeliveryConfig('not: [valid'), /valid/);
});
test('review child receives trusted identity and paths; inherited plugin overrides cannot weaken the gate', async t => {
  const root = await temporary(t, 'delivery-review-env-'); const directory = join(root, '.delivery-review/snapshot-x'); await mkdir(directory, { recursive: true });
  const manifest = { snapshot: snapshot(), directory, source: join(directory, 'source'), rules: join(directory, 'rules'), coverage: join(directory, 'coverage'), output: join(directory, 'output') };
  await writeFile(join(root, '.delivery-review/manifest.json'), JSON.stringify(manifest));
  const result = await reviewEnvironment(root, { PLUGIN_REVIEW_EVENT: 'comment', PLUGIN_MAX_FILES: '1', CNB_PULL_REQUEST_SHA: 'wrong' });
  assert.equal(result.CNB_PULL_REQUEST_SHA, head); assert.equal(result.PLUGIN_REVIEW_EVENT, 'auto'); assert.equal(result.PLUGIN_EXCLUDE_CATEGORIES, '');
  manifest.output = '/tmp/escape.json'; await writeFile(join(root, '.delivery-review/manifest.json'), JSON.stringify(manifest));
  await assert.rejects(reviewEnvironment(root, {}), /escapes/);
});
test('AI batch coverage cannot truncate, duplicate or reuse another source/main result', () => {
  for (const [count, lengths] of [[29, [29]], [30, [30]], [31, [30, 1]], [60, [30, 30]], [61, [30, 30, 1]]]) {
    const files = Array.from({ length: count }, (_, index) => `source/${index}.ts`);
    assert.deepEqual(reviewBatches(files).map(batch => batch.length), lengths);
    assert.deepEqual(reviewBatches(files).flat(), [...files].sort());
  }
  const s = snapshot(1, { files: Array.from({ length: 61 }, (_, index) => `source/${index}.ts`) });
  const manifest = { snapshot: s, policyHash: policy.hash };
  const batches = reviewBatches(s.files); assert.deepEqual(batches.map(files => files.length), [30, 30, 1]);
  const outputs = batches.map(files => ({ status: 'passed', issues: [], reviewed_files: files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] }));
  assert.equal(combineBatchResults(manifest, outputs).reviewed_files.length, 61);
  assert.throws(() => combineBatchResults(manifest, outputs.slice(1)), /missing/);
  for (const patch of [{ reviewed_files: batches[1] }, { reviewed_files: batches[0].slice(1) }, { head_sha: main }]) assert.throws(() => combineBatchResults(manifest, [{ ...outputs[0], ...patch }, ...outputs.slice(1)]));
  const rejected = combineBatchResults(manifest, [{ ...outputs[0], status: 'critical', issues: [{ severity: 'critical', file: s.files[0], start_line: 1, end_line: 1, problem: 'real regression', suggestion: 'fix the regression' }] }, ...outputs.slice(1)]);
  assert.equal(rejected.status, 'critical'); assert.equal(rejected.issues.length, 1);
});
test('model tool subprocess excludes approval and unrelated secrets without mutating the publisher environment', () => {
  const env = { CNB_TOKEN: 'gateway', CNB_TOKEN_FOR_CODEBUDDY: 'approve', CNB_TOKEN_FOR_AI: 'approve2', NPM_TOKEN: 'npm', DATABASE_PASSWORD: 'db', PATH: '/bin', CNB_REPO_SLUG: repo };
  assert.deepEqual(batchEnvironment(env), { PATH: '/bin', CNB_REPO_SLUG: repo });
  assert.equal(env.CNB_TOKEN_FOR_CODEBUDDY, 'approve'); assert.equal(env.CNB_TOKEN_FOR_AI, 'approve2');
});
test('model broker is permanently closed for valid and malformed inputs without opening a listener or forwarding a request', async () => {
  let calls = 0;
  for (const value of [{ repo, token: randomUUID(), request: async () => { calls++; } }, { repo: 'bad', endpoint: 'https://elsewhere.example' }, undefined]) await assert.rejects(modelGateway(value), /Platform AI is disabled/);
  assert.equal(calls, 0);
});

test('CI review receipts are assigned to the responsible batch and collected without omission or duplication', () => {
  const files = Array.from({ length: 61 }, (_, index) => `source/${String(index).padStart(2, '0')}.ts`);
  const ciPolicyChanges = [{ id: 'first', file: files[0] }, { id: 'last', file: files[60] }, { id: 'config', file: files[30] }];
  const s = snapshot(1, { files, ciPolicyChanges });
  const manifest = { snapshot: s, policyHash: policy.hash };
  const results = reviewBatches(files).map((paths, index) => ({ status: 'passed', issues: [], reviewed_files: paths, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [], ci_policy_changes: batchSnapshot(s, index).ciPolicyChanges.map(change => ({ id: change.id, rationale: 'Exact old/new check remains required and has regression coverage.' })) }));
  assert.deepEqual(batchSnapshot(s, 0).ciPolicyChanges.map(change => change.id), ['first']);
  assert.deepEqual(batchSnapshot(s, 1).ciPolicyChanges.map(change => change.id), ['config']);
  assert.deepEqual(batchSnapshot(s, 2).ciPolicyChanges.map(change => change.id), ['last']);
  assert.deepEqual(combineBatchResults(manifest, results).ci_policy_changes.map(change => change.id).sort(), ['config', 'first', 'last']);
  const missing = structuredClone(results); missing[2].ci_policy_changes = []; assert.throws(() => combineBatchResults(manifest, missing), /migration/);
  const duplicate = structuredClone(results); duplicate[1].ci_policy_changes = [results[0].ci_policy_changes[0]]; assert.throws(() => combineBatchResults(manifest, duplicate), /migration/);
  for (const change of [{ id: 'absent-owner' }, { id: 'outside-owner', file: 'outside-changed-paths/ci.yml' }]) {
    assert.throws(() => batchSnapshot({ ...s, ciPolicyChanges: [...s.ciPolicyChanges, change] }, 0), /owner/);
  }
});
test('structural included CI changes belong to the exact changed include, never an unrelated root-CI batch', async t => {
  const root = await temporary(t, 'delivery-ci-origin-');
  const file = 'policy/60.yml'; await mkdir(join(root, 'policy'));
  const mainCi = 'include: policy/60.yml\n';
  const before = 'main:\n  pull_request:\n    - name: static-gate\n      stages: [{name: compile, script: original-compile}]\n';
  await writeFile(join(root, '.cnb.yml'), mainCi); await writeFile(join(root, file), before);
  const trusted = await loadPolicy(root); const files = Array.from({ length: 61 }, (_, index) => `policy/${String(index).padStart(2, '0')}.yml`);
  const report = await sourcePipelineReport(mainCi, trusted, { mainSha: main, headSha: head, changedFiles: files,
    readLocal: async path => { assert.equal(path, file); return before.replace('original-compile', 'upgraded-compile'); } });
  assert.deepEqual(report.errors, []); assert.equal(report.changes.length, 1);
  assert.equal(report.changes[0].file, file); assert.equal(report.changes[0].before.path, file);
  assert.equal(report.changes[0].before.ref, main); assert.equal(report.changes[0].after.ref, head);
  const s = snapshot(1, { files, ciPolicyChanges: report.changes });
  assert.equal(batchSnapshot(s, 0).ciPolicyChanges.length, 0);
  assert.deepEqual(batchSnapshot(s, 2).ciPolicyChanges, report.changes);
  const unbound = await sourcePipelineReport(mainCi, trusted, { mainSha: main, headSha: head, changedFiles: ['unrelated.ts'], readLocal: async () => before.replace('original-compile', 'changed') });
  assert.match(unbound.errors.join(';'), /changed-file owner/); assert.deepEqual(unbound.changes, []);
});
test('a changed include edge owns structural changes from an unchanged leaf and inline YAML uses its physical file', async t => {
  const root = await temporary(t, 'delivery-ci-edge-'); await mkdir(join(root, 'policy'));
  const leaf = command => `main:\n  pull_request:\n    - name: static-gate\n      stages: [{name: compile, script: ${command}}]\n`;
  const original = 'include: policy/edge.yml\n';
  await writeFile(join(root, '.cnb.yml'), original); await writeFile(join(root, 'policy/edge.yml'), 'include: policy/old.yml\n');
  await writeFile(join(root, 'policy/old.yml'), leaf('old-compile'));
  const trusted = await loadPolicy(root);
  const report = await sourcePipelineReport(original, trusted, { mainSha: main, headSha: head, changedFiles: ['policy/edge.yml'],
    readLocal: async path => path === 'policy/edge.yml' ? 'include: policy/new.yml\n' : leaf('new-compile') });
  assert.deepEqual(report.errors, []); assert.equal(report.changes[0].file, 'policy/edge.yml');
  assert.deepEqual(report.changes[0].origins, { before: 'policy/old.yml', after: 'policy/new.yml' });
  const inline = await sourcePipelineReport('include:\n  - config:\n      main:\n        pull_request:\n          - name: static-gate\n            stages: [{name: compile, script: inline-compile}]\n', trusted,
    { mainSha: main, headSha: head, changedFiles: ['.cnb.yml'] });
  assert.deepEqual(inline.errors, []); assert.equal(inline.changes[0].file, '.cnb.yml');
  const moved = await sourcePipelineReport('include: policy/added.yml\n', trusted,
    { mainSha: main, headSha: head, changedFiles: [{ path: '.cnb.yml', status: 'modify' }, { path: 'policy/added.yml', status: 'add' }], readLocal: async () => leaf('moved-compile') });
  assert.deepEqual(moved.errors, []); assert.equal(moved.changes[0].file, 'policy/added.yml');
  assert.equal(moved.changes[0].before.absent, true); assert.equal(moved.changes[0].after.absent, false);
});
test('CNB array/mapping collisions retain the array and the official fallback branch binds its product CI', async t => {
  const root = await temporary(t, 'delivery-ci-array-');
  const ci = 'include: included.yml\n$:\n  pull_request: {ignored: mapping}\n';
  await writeFile(join(root, '.cnb.yml'), ci); await writeFile(join(root, 'included.yml'), '$:\n  pull_request:\n    - name: product-gate\n      stages: [{name: check, script: product-check}]\n');
  const p = await loadPolicy(root); assert.deepEqual(p.requiredNames, ['product-gate']); assert.equal(p.prBranch, '$');
  const report = await sourcePipelineReport(ci, p, { changedFiles: [], readLocal: path => readFile(join(root, path), 'utf8') });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.changes, []);
});
test('AI issue schema rejects incompatible severity/category/line data without dropping findings', () => {
  const issue = { severity: 'warning', category: 'bug', confidence: 'high', file: '.cnb.yml', start_line: 126, end_line: 126, problem: 'missing test file', suggestion: 'use the actual test file' };
  assert.equal(validateIssueSchema({ status: 'needs_modification', issues: [issue] }).issues.length, 1);
  for (const patch of [{ severity: 'high' }, { category: 'concurrency' }, { start_line: 0 }, { end_line: 1 }, { suggestion: '' }, { file: null }]) assert.throws(() => validateIssueSchema({ status: 'critical', issues: [{ ...issue, ...patch }] }), /schema/);
});
test('genuine rejected batches retain findings without an approval migration receipt, while every passing batch still needs the complete receipt', () => {
  const s = snapshot(1, { ciPolicyChanges: [{ id: 'CI-001', file: 'apps/example.ts' }] });
  const manifest = { snapshot: s, policyHash: policy.hash };
  const issue = { severity: 'warning', file: 'apps/example.ts', start_line: 1, problem: 'Required assertion is missing', suggestion: 'Restore the assertion before approving' };
  const rejected = { status: 'needs_modification', issues: [issue], reviewed_files: s.files, head_sha: head, base_sha: main, policy_hash: policy.hash, depends_on: [] };
  const output = combineBatchResults(manifest, [rejected]);
  assert.equal(output.status, 'needs_modification'); assert.deepEqual(output.issues, [issue]);
  assert.throws(() => validateReview(output, s, policy.hash), /did not pass/);
  assert.throws(() => combineBatchResults(manifest, [{ ...rejected, status: 'passed', issues: [] }]), /migration/);
  for (const patch of [{ head_sha: main }, { reviewed_files: [] }, { depends_on: [1] }, { ci_policy_changes: {} }]) assert.throws(() => combineBatchResults(manifest, [{ ...rejected, ...patch }]));
});
test('required native node-test stages refer to existing repository files', async () => {
  const root = new URL('../../', import.meta.url); const YAML = await parser();
  const config = await resolvePipelineConfig(await readFile(new URL('.cnb.yml', root), 'utf8'), { readLocal: path => readFile(new URL(path, root), 'utf8') });
  let verified = 0;
  for (const pipeline of (prPipelines(config) ?? []).filter(value => value.allowFailure !== true)) {
    for (const stage of pipeline.stages) {
      for (const line of String(stage.script ?? '').split('\n').filter(value => /node --test /.test(value))) {
        for (const path of line.trim().split(/\s+/).slice(2).filter(value => value.endsWith('.mjs'))) {
          const matches = (await git(['ls-files', '-z', '--', path], { cwd: fileURLToPath(root), raw: true })).split('\0').filter(Boolean);
          assert.ok(matches.length, `Missing native test: ${pipeline.name}/${path}`);
          for (const match of matches) assert.ok((await readFile(new URL(match, root), 'utf8')).length); verified++;
        }
      }
    }
  }
  assert.ok(verified > 0);
});
test('every delivery YAML stage is deterministic and has no model SDK image, legacy executor or NPC call', async () => {
  const YAML = await parser();
  for (const file of ['cnb.yml', 'bootstrap-cnb.yml']) {
    const config = YAML.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    const visit = value => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      if (value.script) {
        assert.doesNotMatch(value.script, /review-prepare|review-finish|node scripts\/delivery\/review-plugin|\/-\/ai\/|work-mode|@CodeBuddy/);
        assert.ok(!value.image, `Unexpected stage image in ${file}`);
      }
      for (const entry of Object.values(value)) visit(entry);
    };
    visit(config);
  }
  assert.equal(BASE_POLICY.platformAI, false); assert.equal(BASE_POLICY.reviewProvider, 'codex');
});

test('archived actual non-installer CNB run proves exit 78 preserves all independent product pipelines', async () => {
  // Public API readback, observed 2026-10-05: all four pipelines at the exact tested parents.
  const proof = {
  "repo": "workloom-ai/workloom-im",
  "number": 236,
  "branch": "refs/heads/task/T-2026-1005-2000",
  "sourceSha": "fd08fae3c81f3d8020cba004538fd572cec37880",
  "mainSha": "e35625d856697ba95edf7cde8d294b35cea0de2f",
  "testedCommit": "10f855ab502684e43135310a4d2f7de86d502727",
  "parents": [
    "e35625d856697ba95edf7cde8d294b35cea0de2f",
    "fd08fae3c81f3d8020cba004538fd572cec37880"
  ],
  "observedAt": "2026-10-05T11:32:11.025Z",
  "statuses": [
    {
      "state": "success",
      "context": "cnb/pull_request/pipeline-1(delivery-bootstrap-review)",
      "target_url": "https://cnb.cool/workloom-ai/workloom-im/-/build/logs/cnb-1v0-1k45smgj6#001"
    },
    {
      "state": "success",
      "context": "cnb/pull_request/pipeline-2(static-gate)",
      "target_url": "https://cnb.cool/workloom-ai/workloom-im/-/build/logs/cnb-1v0-1k45smgj6#002"
    },
    {
      "state": "success",
      "context": "cnb/pull_request/pipeline-3(db-gate)",
      "target_url": "https://cnb.cool/workloom-ai/workloom-im/-/build/logs/cnb-1v0-1k45smgj6#003"
    },
    {
      "state": "success",
      "context": "cnb/pull_request/pipeline-4(ui-gate)",
      "target_url": "https://cnb.cool/workloom-ai/workloom-im/-/build/logs/cnb-1v0-1k45smgj6#004"
    }
  ]
};
  const YAML = await parser();
  const bootstrap = prPipelines(YAML.parse(await readFile(new URL('./bootstrap-cnb.yml', import.meta.url), 'utf8')))[0];
  const skipped = spawnSync('sh', ['-c', bootstrap.stages[0].script], { env: { CNB_PULL_REQUEST_BRANCH: proof.branch.replace(/^refs\/heads\//, '') }, encoding: 'utf8' });
  assert.equal(skipped.status, 78);
  assert.deepEqual(checksVerdict({ sha: proof.testedCommit, statuses: proof.statuses }, { sha: proof.testedCommit, parents: proof.parents.map(sha => ({ sha })) }, { headSha: proof.sourceSha, mainSha: proof.mainSha }, ['delivery-bootstrap-review', 'static-gate', 'db-gate', 'ui-gate']), []);
  assert.equal(new Set(proof.statuses.map(status => status.target_url.split('#')[0])).size, 1);
});

test('installer checks cancel only their own obsolete build and verify prepared assets before the session record', async () => {
  const YAML = await parser();
  const bootstrap = prPipelines(YAML.parse(await readFile(new URL('./bootstrap-cnb.yml', import.meta.url), 'utf8')))[0];
  const ordinary = YAML.parse(await readFile(new URL('./cnb.yml', import.meta.url), 'utf8'))['.delivery-review'];
  assert.equal(bootstrap.lock.key, 'workloom-delivery-bootstrap-$CNB_PULL_REQUEST_IID'); assert.equal(bootstrap.lock['cancel-in-progress'], true);
  assert.notEqual(bootstrap.lock.key, ordinary.lock.key); assert.notEqual(ordinary.lock['cancel-in-progress'], true);
  const verifyAssets = bootstrap.stages.findIndex(stage => String(stage.script).includes('queue-runner.mjs verify-bootstrap'));
  const installParser = bootstrap.stages.findIndex(stage => String(stage.script).includes('npm ci'));
  const verifySession = bootstrap.stages.findIndex(stage => String(stage.script).includes('queue-runner.mjs verify-review'));
  assert.ok(verifyAssets > installParser); assert.ok(verifySession > verifyAssets);
});
test('historical review orchestrator cannot start a batch or publish any platform approval after owner revocation', async () => {
  let invoked = 0;
  await assert.rejects(runReview('/nonexistent/forbidden', { runBatch: async () => { invoked++; }, publish: async () => { invoked++; }, platform: { snapshot: async () => { invoked++; } } }), /Platform AI is disabled/);
  assert.equal(invoked, 0);
});

test('a missing Codex review parks one task without paid repair and does not admit a candidate', async () => {
  const s = snapshot(1, { hasFailedChecks: true, checkErrors: ['Required check failed'] }); const store = memoryStore(activate(emptyState(repo)));
  let writes = 0; let candidates = 0;
  const platform = { repo, error: error => error.message, pulls: async () => [s.pull], snapshot: async () => s, list: async () => [],
    call: async () => { writes++; throw new Error('No platform dispatch'); }, ensureCandidate: async () => { candidates++; } };
  await reconcile({ platform, store, policy, now });
  const task = (await store.read()).tasks['1']; assert.equal(task.status, 'parked'); assert.equal(task.repairRequired.provider, 'codex');
  assert.equal(writes, 0); assert.equal(candidates, 0);
});

test('mutation rejects local/PR-source runners, absent native lock and checkout main drift', async t => {
  const root = await temporary(t, 'delivery-runner-'); await git(['init', '--quiet'], { cwd: root }); await git(['commit', '--allow-empty', '-m', 'init'], { cwd: root });
  const sha = await git(['rev-parse', 'HEAD'], { cwd: root }); const platform = { main: async () => ({ commit: { sha } }) };
  const env = { CNB_BUILD_ID: 'build', CNB_EVENT: 'api_trigger_delivery_reconcile', DELIVERY_NATIVE_LOCK: 'workloom-delivery-merge' };
  await requireTrustedRunner(platform, root, env);
  for (const patch of [{ CNB_BUILD_ID: '' }, { CNB_EVENT: 'pull_request' }, { DELIVERY_NATIVE_LOCK: '' }]) await assert.rejects(requireTrustedRunner(platform, root, { ...env, ...patch }));
  await assert.rejects(requireTrustedRunner({ main: async () => ({ commit: { sha: head } }) }, root, env), /trusted main/);
});
test('state preparation initializes a protected ledger before merge without activating it; lost settings ack is read back', async t => {
  const root = await temporary(t, 'delivery-install-state-'); await git(['init', '--quiet'], { cwd: root }); await git(['commit', '--allow-empty', '-m', 'initial main'], { cwd: root });
  const baseTip = await git(['rev-parse', 'HEAD'], { cwd: root });
  await writeFile(join(root, 'AGENTS.md'), 'Installer rules\n'); await git(['add', 'AGENTS.md'], { cwd: root }); await git(['commit', '-m', 'installer'], { cwd: root });
  const tip = await git(['rev-parse', 'HEAD'], { cwd: root }); let rules = []; let writes = 0;
  const platform = { repo: 'workloom-ai/workloom-im', main: async () => ({ commit: { sha: baseTip } }), protections: async () => rules, call: async (_path, options) => { writes++; rules = [{ ...options.body, id: 'state-rule' }]; throw new Error('lost acknowledgement'); } };
  const installer = { number: 234, state: 'open', is_wip: false, head: { sha: tip }, base: { ref: 'main', sha: baseTip } }; const store = memoryStore();
  const prepared = await prepareInstallation({ platform, store, root, installer }); assert.equal(prepared.activated, false); assert.equal(writes, 1);
  assert.deepEqual(admissionErrors(await store.read(), { number: 234, headSha: tip, mainSha: baseTip, files: ['AGENTS.md'] }), []);
  assert.ok((await store.read()).events.some(event => event.kind === 'installation_prepared')); assert.equal((await store.read()).events.some(event => event.kind === 'activated'), false);
  await ensureStateProtection(platform); assert.equal(writes, 1);
  assert.equal((await verifyPreparedInstallation({ platform, store, root, installer })).verified, true); assert.equal(writes, 1);
  await assert.rejects(verifyPreparedInstallation({ platform, store: memoryStore(), root, installer }), /exact source/);
  const waiting = memoryStore(); let clock = 0; let sleeps = 0;
  await verifyPreparedInstallation({ platform, store: waiting, root, installer, waitMs: 10000, elapsedClock: () => clock, sleep: async ms => {
    clock += ms; sleeps++; await waiting.mutate(current => appendEvent(current, 'installation_prepared', { installer: installer.number, headSha: tip, mainSha: baseTip }));
  } });
  assert.equal(sleeps, 1); assert.equal(writes, 1);
  await assert.rejects(verifyPreparedInstallation({ platform, store: memoryStore(), root, installer, waitMs: 10000, elapsedClock: () => clock, sleep: async ms => { clock += ms; } }), /exact source/);
  rules[0].allow_master_force_pushes = true; await assert.rejects(ensureStateProtection(platform), /protection/);
  await assert.rejects(prepareInstallation({ platform, store, root, installer: { ...installer, head: { sha: head } } }), /checkout/);
  await writeFile(join(root, '.workloom-delivery-install.json'), JSON.stringify({ repo: 'foreign/isolated-copy' }));
  await assert.rejects(prepareInstallation({ platform, store, root, installer }), /another repository/); assert.equal(writes, 1);
});
test('actual handoff CLI rejects absent review, source drift and draft state, and writes only an exact real-Git review without releasing a task lease', async t => {
  const root = await temporary(t, 'delivery-handoff-cli-'); const checkout = join(root, 'checkout'); const remote = join(root, 'remote.git');
  await mkdir(checkout); await git(['init', '--bare', '--quiet', remote]); await git(['init', '--quiet'], { cwd: checkout });
  const ci = 'main:\n  pull_request:\n    - name: product-gate\n      stages: [{name: check, script: actual-check}]\n';
  await writeFile(join(checkout, '.cnb.yml'), ci); await git(['add', '.'], { cwd: checkout }); await git(['commit', '-m', 'initial main'], { cwd: checkout });
  const baseTip = await git(['rev-parse', 'HEAD'], { cwd: checkout });
  await writeFile(join(checkout, 'source.txt'), 'Reviewed source fixture'); await git(['add', '.'], { cwd: checkout }); await git(['commit', '-m', 'actual source'], { cwd: checkout });
  const sourceTip = await git(['rev-parse', 'HEAD'], { cwd: checkout }); const localPolicy = await loadPolicy(checkout); const at = Date.now();
  const source = snapshot(1, { headSha: sourceTip, mainSha: baseTip, files: ['source.txt'], headTime: at - 1000 });
  const receiptPath = join(root, 'review.json'); await writeFile(receiptPath, JSON.stringify(reviewInput(source, localPolicy, at)));
  const store = new GitStateStore({ repo, remote }); const taskId = 'T-2026-1006-1003';
  await store.mutate(state => leaseOperation(state, { action: 'acquire', owner: taskId, scopes: ['protocol'] }));
  const configuration = join(root, 'gitconfig'); await writeFile(configuration, `[url "${remote}"]\n\tinsteadOf = https://cnb.cool/${repo}.git\n`);
  const pull = { ...snapshot().pull, title: `fix(base): handoff [${taskId}]`, head: { sha: sourceTip, ref: 'task/source' }, base: { sha: baseTip, ref: 'main' } };
  const run = mode => {
    const prelude = `let p=${JSON.stringify(pull)};let patched=false;globalThis.fetch=async(u,o)=>{const path=new URL(String(u)).pathname;let v;if(o.method==='PATCH'){p.body=JSON.parse(o.body).body;patched=true;v=p;}else if(path.endsWith('/git/branches/main'))v={commit:{sha:${JSON.stringify(baseTip)}}};else if(path.includes('/git/compare/'))v={base_commit:{sha:${JSON.stringify(baseTip)}},head_commit:{sha:${JSON.stringify(sourceTip)}},merge_base_commit:{sha:${JSON.stringify(baseTip)}},files:[{path:'source.txt',status:'modify'}]};else if(path.includes('/git/commits/'))v={commit:{committer:{date:${JSON.stringify(new Date(at-1000).toISOString())}}}};else if(path.includes('/git/raw/'))v=${JSON.stringify(ci)};else if(path.endsWith('/pulls/1'))v={...p,head:{...p.head,sha:patched&&${JSON.stringify(mode)}==='drift'?${JSON.stringify(main)}:p.head.sha},is_wip:patched&&${JSON.stringify(mode)}==='draft'};else throw new Error('Unexpected fixture path '+path);return Response.json(v);};`;
    return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(prelude)}`, fileURLToPath(new URL('./queue-runner.mjs', import.meta.url)), 'handoff', '--repo', repo, '--root', checkout, '--pr', '1', '--head', sourceTip, ...(mode === 'missing' ? [] : ['--review-receipt', receiptPath])], {
      env: { ...process.env, CNB_TOKEN: randomUUID(), GIT_CONFIG_GLOBAL: configuration, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', timeout: 30000,
    });
  };
  const missing = run('missing'); assert.equal(missing.status, 1); assert.match(missing.stderr, /requires --review-receipt/);
  for (const mode of ['drift', 'draft']) { const result = run(mode); assert.equal(result.status, 1, result.stdout); assert.match(result.stderr, /source\/state changed/); assert.equal((await store.read()).tasks['1'], undefined); }
  const result = run('exact'); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).headSha, sourceTip);
  const state = await store.read(); assert.equal(state.tasks['1'].headSha, sourceTip); assert.equal(state.leases.protocol.owner, taskId);
  assert.equal(state.tasks['1'].developerReview.provider, 'codex'); assert.ok(state.events.some(event => event.kind === 'developer_review'));
  assert.equal(parseIntent(state.tasks['1'].reviewSnapshot.pull).ready, true);
});
test('actual activate and admit CLI routes write and read back the real Git ledger with exact API fixtures', async t => {
  const repo = 'workloom-ai/workloom-im';
  const root = await temporary(t, 'delivery-cli-contract-'); const remote = join(root, 'remote.git'); const checkout = join(root, 'checkout');
  await mkdir(checkout); await mkdir(join(checkout, 'scripts/delivery'), { recursive: true });
  const ci = 'include: scripts/delivery/cnb.yml\nmain:\n  pull_request:\n    - name: static-gate\n      stages: [{name: assertions, script: actual-check}]\n';
  const included = 'main:\n  push: []\n';
  await writeFile(join(checkout, '.cnb.yml'), ci); await writeFile(join(checkout, 'scripts/delivery/cnb.yml'), included);
  await git(['init', '--quiet'], { cwd: checkout }); await git(['add', '.'], { cwd: checkout }); await git(['commit', '-m', 'initial main'], { cwd: checkout });
  const preparedMain = await git(['rev-parse', 'HEAD'], { cwd: checkout });
  await git(['checkout', '--quiet', '-b', 'task/fixture-install'], { cwd: checkout });
  await writeFile(join(checkout, 'installed.txt'), 'Actual base installation source'); await git(['add', '.'], { cwd: checkout }); await git(['commit', '-m', 'installer source'], { cwd: checkout }); const tip = await git(['rev-parse', 'HEAD'], { cwd: checkout });
  await git(['checkout', '--quiet', '--detach', preparedMain], { cwd: checkout });
  await git(['merge', '--no-ff', tip, '-m', 'actual reviewed installation merge'], { cwd: checkout });
  const integratedMain = await git(['rev-parse', 'HEAD'], { cwd: checkout });
  assert.deepEqual((await git(['rev-list', '--parents', '-n', '1', integratedMain], { cwd: checkout })).split(' ').slice(1), [preparedMain, tip]);
  await git(['init', '--bare', '--quiet', remote]); const store = new GitStateStore({ repo, remote });
  const currentPolicy = await loadPolicy(checkout); const at = Date.now();
  const reviewedSnapshot = snapshot(234, { repo, headSha: tip, mainSha: preparedMain, headTime: at - 1000, files: ['installed.txt'] });
  const developerReview = review(reviewedSnapshot, currentPolicy, at);
  await store.mutate(state => { appendEvent(state, 'installation_prepared', { installer: 234, headSha: tip, mainSha: preparedMain }); updateTask(state, 234, { developerReview, reviewSnapshot: reviewedSnapshot }); });
  const { branchProtectionPayload } = await import('../tools/cnb-api.mjs');
  const rules = [
    { ...branchProtectionPayload({ requireReview: false }), id: 'main', allow_master_manual_merge: false },
    { ...branchProtectionPayload({ rule: 'automation/delivery-state', requireReview: false }), id: 'state', allow_master_pushes: true, required_status_checks: false },
    { ...branchProtectionPayload({ rule: 'delivery/candidate/**', requireReview: false }), id: 'candidate', required_status_checks: false, allow_master_manual_merge: false },
  ];
  const installer = { number: '234', is_merged: true, author: { username: 'developer' }, head: { sha: tip } };
  const admissionPull = { ...snapshot().pull, base: { ref: 'main', sha: integratedMain } };
  const fixture = {
    tip: integratedMain, ci, included, rules, installer, admissionPull,
    statuses: { sha: integratedMain, statuses: ['static-gate', 'delivery-bootstrap-checks'].map(name => ({ context: `cnb/pull_request/pipeline-1(${name})`, state: 'success' })) },
    tested: { sha: integratedMain, parents: [{ sha: preparedMain }, { sha: tip }] },
    compare: { base_commit: { sha: integratedMain }, head_commit: { sha: head }, merge_base_commit: { sha: integratedMain }, files: [{ path: 'scripts/ci/contract.mjs' }] },
  };
  const prelude = `const f=${JSON.stringify(fixture)};globalThis.fetch=async input=>{const u=new URL(String(input));const p=u.pathname;let v;if(p.endsWith('/git/branches/main'))v={commit:{sha:f.tip}};else if(p.endsWith('/pulls/234'))v=f.installer;else if(p.endsWith('/pulls/1'))v=f.admissionPull;else if(p.endsWith('/commit-statuses'))v=f.statuses;else if(p.includes('/settings/branch-protections'))v=f.rules;else if(p.includes('/git/compare/'))v=f.compare;else if(p.includes('/git/raw/'))v=p.endsWith('/.cnb.yml')?f.ci:f.included;else if(p.endsWith('/git/commits/${integratedMain}'))v=f.tested;else if(p.includes('/git/commits/'))v={commit:{committer:{date:'2026-01-01T00:00:00Z'}}};else throw new Error('Unexpected CLI API fixture '+p);return new Response(JSON.stringify(v),{status:200});};`;
  const configuration = join(root, 'gitconfig');
  await writeFile(configuration, `[url "${remote}"]\n\tinsteadOf = https://cnb.cool/${repo}.git\n`);
  const cli = fileURLToPath(new URL('./queue-runner.mjs', import.meta.url));
  const run = (command, number, extra = {}) => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(prelude)}`, cli, command, '--repo', repo, '--root', checkout, '--pr', String(number)], {
    cwd: checkout, env: { ...process.env, CNB_TOKEN: randomUUID(), GIT_CONFIG_GLOBAL: configuration, GIT_CONFIG_NOSYSTEM: '1', ...extra }, encoding: 'utf8', timeout: 30000,
  });
  const activated = run('activate', 234); assert.equal(activated.status, 0, activated.stderr); assert.equal(JSON.parse(activated.stdout).mainSha, integratedMain);
  assert.ok((await store.read()).events.some(event => event.kind === 'activated' && event.data.installer === 234 && event.data.mainSha === integratedMain && event.data.platformAI === false));
  assert.equal((await store.read()).events.some(event => event.kind === 'source_admitted'), false);
  const env = { CNB_BUILD_ID: 'fixture-build', CNB_EVENT: 'api_trigger_delivery_admit', DELIVERY_NATIVE_LOCK: 'workloom-delivery-admission' };
  const rejected = run('admit', 0, env); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /requires --pr/);
  const admitted = run('admit', 1, env); assert.equal(admitted.status, 0, admitted.stderr); assert.equal(JSON.parse(admitted.stdout).admitted, true);
  const actual = await store.read(); assert.deepEqual(admissionErrors(actual, { number: 1, headSha: head, mainSha: integratedMain, files: ['scripts/ci/contract.mjs'] }), []);
  assert.equal(actual.leases.protocol.owner, null);
});
test('frozen release requires exact checkout and positive main ancestry, without updating its source', async () => {
  const calls = []; const env = { CNB_TOKEN: 'test-only', CNB_REPO_SLUG: repo, RELEASE_EXPECTED_SHA: head };
  const run = async argv => { calls.push(argv); return argv[0] === 'rev-parse' ? head : ''; };
  assert.equal((await verifyReleaseSource({ env, run })).sha, head); assert.deepEqual(calls.at(-1), ['merge-base', '--is-ancestor', head, 'FETCH_HEAD']);
  await assert.rejects(verifyReleaseSource({ env: { ...env, RELEASE_EXPECTED_SHA: main }, run }), /checkout/);
  const before = calls.length;
  await assert.rejects(verifyReleaseSource({ env: { ...env, RELEASE_EXPECTED_SHA: undefined, CNB_BRANCH_SHA: head }, run }), /identity required/);
  await assert.rejects(verifyReleaseSource({ env: { ...env, CNB_REPO_SLUG: undefined }, run }), /identity required/);
  assert.equal(calls.length, before); // An implicit manual main/tag identity never reaches Git or publishing.
});

test('actual bare Git CAS preserves simultaneous updates and append-only history', async t => {
  const root = await temporary(t, 'delivery-git-cas-'); const remote = join(root, 'remote.git'); await git(['init', '--bare', '--quiet', remote]);
  const stores = Array.from({ length: 6 }, () => new GitStateStore({ repo, remote, retries: 12 }));
  await Promise.all(stores.map((store, index) => store.mutate(state => updateTask(state, index + 1, { status: 'waiting_ci' }), { id: `write-${index}` })));
  const state = await stores[0].read(); assert.equal(Object.keys(state.tasks).length, 6); assert.equal(state.events.filter(event => event.kind === 'transaction').length, 6); validateState(state, repo);
  const count = await git(['--git-dir', remote, 'rev-list', '--count', 'automation/delivery-state']); assert.equal(Number(count), 6);
});
test('actual lost Git push acknowledgement recovers the committed transaction once', async t => {
  const root = await temporary(t, 'delivery-git-lostack-'); const remote = join(root, 'remote.git'); await git(['init', '--bare', '--quiet', remote]);
  class LostAckStore extends GitStateStore { async withRepository(operation) { return super.withRepository(run => operation(async (args, options) => { const result = await run(args, options); if (args[0] === 'push' && !this.lost) { this.lost = true; throw new Error('lost acknowledgement'); } return result; })); } }
  const store = new LostAckStore({ repo, remote }); let mutations = 0;
  const result = await store.mutate(state => { mutations++; updateTask(state, 1, { status: 'waiting_ci' }); }, { id: 'same-transaction' });
  assert.equal(result.recovered, true); await store.mutate(() => { mutations++; }, { id: 'same-transaction' }); assert.equal(mutations, 1);
});
test('actual branch alignment uses ordinary merge/push; semantic conflicts preserve source', async t => {
  const root = await temporary(t, 'delivery-align-'); const remote = join(root, 'remote.git'); const source = join(root, 'source'); await mkdir(source); await git(['init', '--bare', '--quiet', remote]);
  const run = args => git(args, { cwd: source }); await run(['init', '--quiet', '--initial-branch=main']); await writeFile(join(source, 'shared'), 'start\n'); await run(['add', 'shared']); await run(['commit', '-m', 'initial']);
  const common = await run(['rev-parse', 'HEAD']); await run(['checkout', 'main']); await writeFile(join(source, 'mainfile'), 'main\n'); await run(['add', 'mainfile']); await run(['commit', '-m', 'main']); const target = await run(['rev-parse', 'HEAD']);
  await run(['checkout', '-b', 'task/test', common]); await writeFile(join(source, 'taskfile'), 'task\n'); await run(['add', 'taskfile']); await run(['commit', '-m', 'task']); const tip = await run(['rev-parse', 'HEAD']); await run(['push', remote, 'main', 'task/test']);
  const pull = { state: 'open', is_wip: false, head: { sha: tip, ref: 'task/test' } }; const platform = { repo, pull: async () => pull, main: async () => ({ commit: { sha: target } }) };
  const aligned = await alignBranch(platform, { number: 1, headSha: tip, mainSha: target, pull }, { remote });
  await run(['fetch', remote, 'task/test']); const parents = (await run(['rev-list', '--parents', '-n', '1', 'FETCH_HEAD'])).split(' '); assert.deepEqual(parents.slice(1), [tip, target]); assert.equal(parents[0], aligned.sha);
  await run(['checkout', 'main']); await writeFile(join(source, 'shared'), 'main conflict\n'); await run(['add', 'shared']); await run(['commit', '-m', 'main conflict']); const conflictMain = await run(['rev-parse', 'HEAD']); await run(['push', remote, 'main']);
  await run(['checkout', '-b', 'task/conflict', common]); await writeFile(join(source, 'shared'), 'task conflict\n'); await run(['add', 'shared']); await run(['commit', '-m', 'task conflict']); const conflictHead = await run(['rev-parse', 'HEAD']); await run(['push', remote, 'task/conflict']);
  const conflictPull = { ...pull, head: { sha: conflictHead, ref: 'task/conflict' } }; await assert.rejects(alignBranch({ ...platform, pull: async () => conflictPull, main: async () => ({ commit: { sha: conflictMain } }) }, { number: 2, headSha: conflictHead, mainSha: conflictMain, pull: conflictPull }, { remote }), /git merge/);
  assert.equal((await git(['ls-remote', remote, 'refs/heads/task/conflict'])).split(/\s/)[0], conflictHead);
});

test('immutable candidate creation reuses exact protected refs/PRs and rejects source replacement', async () => {
  let created = false; let posts = 0; const s = snapshot(); const marker = `delivery-origin:1:${head}:${main}`;
  const platform = new Platform(repo, undefined, async (_repo, path, options) => {
    if (path.includes('branch-protections')) return [{ id: 'candidate-rule', rule: 'delivery/candidate/**', allow_creation: true, allow_master_creation: true, allow_pushes: false, allow_master_pushes: false, allow_force_pushes: false, allow_master_force_pushes: false, allow_deletions: false, allow_master_deletions: false, allow_master_manual_merge: false }];
    if (path === '/-/git/branches' && options.method === 'POST') { posts++; if (created) throw new Error('already exists'); created = true; return {}; }
    if (path.includes('/git/branches/')) return { commit: { sha: head }, protected: true };
    if (path.includes('/pulls?')) return [];
    if (path === '/-/pulls') return { number: '11', state: 'open' };
    if (path === '/-/pulls/11') return { number: '11', head: { sha: head }, body: `<!-- ${marker} -->` };
    throw new Error(`Unexpected ${path}`);
  });
  assert.equal((await platform.ensureCandidate(s)).number, 11); assert.equal((await platform.ensureCandidate(s)).headSha, head); assert.equal(posts, 2);
  platform.request = async (_repo, path) => path.includes('branch-protections') ? [{ id: 'candidate-rule', rule: 'delivery/candidate/**', allow_creation: true, allow_master_creation: true, allow_pushes: false, allow_master_pushes: false, allow_force_pushes: false, allow_master_force_pushes: false, allow_deletions: false, allow_master_deletions: false, allow_master_manual_merge: false }] : path === '/-/git/branches' ? Promise.reject(new Error('already exists')) : { commit: { sha: main }, protected: true };
  await assert.rejects(platform.ensureCandidate(s), /already exists/);
});
test('real CNB summary bodies do not erase actual PR handoff, age or explicit dependencies', async () => {
  const created = '2026-10-05T00:00:00Z';
  const body = '<!-- workloom-delivery\n' + JSON.stringify({ ready: true, depends_on: [2], releases: [] }) + '\n-->';
  const platform = new Platform(repo, undefined, async (_repo, path) => {
    if (path.startsWith('/-/pulls?')) return [{ number: '1', body: '', created_at: created, head: { ref: 'task/one' } }];
    if (path === '/-/pulls/1') return { ...snapshot().pull, body };
    if (path === '/-/pulls/2') return { number: 2, is_merged: false };
    throw new Error(`Unexpected ${path}`);
  });
  const pulls = await platform.pulls(); assert.equal(pulls[0].body, body); assert.equal(pulls[0].created_at, created);
  assert.deepEqual((await dependencies(platform, pulls, emptyState(repo))).get(1).pending, [2]);
  platform.request = async (_repo, path) => path.startsWith('/-/pulls?') ? [{ number: 1, body: '' }] : { number: 1, body: null };
  await assert.rejects(platform.pulls(), /detail body is unreadable/);
});
test('PR summary hydration propagates read failures and refuses a detail for another identity', async () => {
  const rows = [{ number: 1, body: '' }];
  const platform = new Platform(repo, undefined, async (_repo, path) => {
    if (path.startsWith('/-/pulls?')) return rows;
    throw Object.assign(new Error('Actual detail permission denied'), { status: 403 });
  });
  await assert.rejects(platform.pulls(), /permission denied/);
  platform.request = async (_repo, path) => path.startsWith('/-/pulls?') ? rows : { number: 2, body: '' };
  await assert.rejects(platform.pulls(), /identity is invalid/);
});
test('positive merge readback requires actual is_merged and exact tested parent order', async () => {
  const platform = new Platform(repo); platform.pull = async () => ({ is_merged: true, head: { sha: head }, merged_by: { username: 'npc' } }); platform.commit = async () => ({ parents: [{ sha: main }, { sha: head }] });
  assert.equal((await platform.verifyMerge(snapshot(), { sha: mergedSha })).sha, mergedSha);
  platform.commit = async () => ({ parents: [{ sha: head }, { sha: main }] }); await assert.rejects(platform.verifyMerge(snapshot(), { sha: mergedSha }), /parents/);
  platform.pull = async () => ({ state: 'closed', is_merged: false, head: { sha: head } }); await assert.rejects(platform.verifyMerge(snapshot(), { sha: mergedSha }), /receipt/);
});
test('snapshot accepts label reordering but rejects actual label changes and unreadable sets', async () => {
  const initial = { ...snapshot().pull, labels: [{ name: 'protocol' }, { name: 'src/auto' }] };
  let finalLabels = [{ name: 'src/auto' }, { name: 'protocol' }]; let reads = 0;
  const platform = new Platform(repo, undefined, async (_repo, path) => {
    if (path === '/-/pulls/1') return { ...initial, labels: ++reads % 2 ? initial.labels : finalLabels };
    if (path === '/-/git/branches/main') return { commit: { sha: main } };
    if (path.includes('/git/compare/')) return { base_commit: { sha: main }, head_commit: { sha: head }, merge_base_commit: { sha: main }, files: [{ path: 'apps/example.ts' }] };
    if (path.includes('/git/commits/')) return { sha: head, commit: { committer: { date: new Date(now).toISOString() } } };
    throw new Error(`Unexpected ${path}`);
  });
  assert.equal((await platform.snapshot(1, {}, { checks: false })).headSha, head);
  finalLabels = [{ name: 'risk/block' }, { name: 'protocol' }];
  await assert.rejects(platform.snapshot(1, {}, { checks: false }), /snapshot changed/);
  finalLabels = undefined;
  await assert.rejects(platform.snapshot(1, {}, { checks: false }), /unreadable/);
});
test('unknown merge acknowledgement pauses later integration; never repeats the write', async () => {
  const s = snapshot(11); s.originNumber = 1; s.pull.head.ref = 'delivery/candidate/test';
  const state = activate(emptyState(repo)); updateTask(state, 1, { status: 'waiting_ci', headSha: head, mainSha: main, originalBody: '', intent, developerReview: review(s), candidate: candidateReceipt(s) }, now); const store = memoryStore(state); let writes = 0;
  const platform = { repo, assertCandidateProtection: async () => {}, snapshot: async () => s, pull: async number => number === 1 ? snapshot().pull : s.pull, merge: async () => { writes++; throw new Error('network lost response'); }, error: e => e.message };
  await assert.rejects(mergeCandidate({ platform, store, policy, snapshot: s, dependencies: new Map([[1, { pending: [] }]]), now }), /lost/); assert.equal(writes, 1); assert.equal((await store.read()).tasks['1'].status, 'merging');
  const report = await reconcile({ platform, store, policy, now, services: { reconcileReleases: async () => [] } }); assert.equal(report.failed[0].stage, 'recover-merge'); assert.equal(writes, 1);
});
test('an explicit 409 with positive unmerged readback releases integration while unreadable or changed readbacks stay unknown', async () => {
  for (const mode of ['rejected', 'unreadable', 'changed']) {
    const s = snapshot(11, { files: ['scripts/ci/protocol-rules.mjs'] }); s.originNumber = 1; s.pull.head.ref = 'delivery/candidate/test';
    const state = activate(emptyState(repo)); updateTask(state, 1, { status: 'waiting_ci', headSha: head, mainSha: main, originalBody: '', intent, developerReview: review(s), candidate: candidateReceipt(s) }, now);
    const store = memoryStore(state); let writes = 0;
    const platform = { repo, assertCandidateProtection: async () => {}, snapshot: async () => s, error: error => error.message,
      pull: async number => { if (number === 1) return snapshot().pull; if (mode === 'unreadable') throw new Error('read denied'); return { ...s.pull, is_merged: false, head: { ...s.pull.head, sha: mode === 'changed' ? main : head } }; },
      merge: async () => { writes++; throw Object.assign(new Error('platform rejected'), { status: 409 }); } };
    await assert.rejects(mergeCandidate({ platform, store, policy, snapshot: s, dependencies: new Map(), now }), /platform rejected/);
    const after = await store.read(); assert.equal(writes, 1);
    assert.equal(after.tasks['1'].status, mode === 'rejected' ? 'waiting_ci' : 'merging');
    assert.equal(after.leases.protocol.owner, mode === 'rejected' ? null : 'integration/pr-1');
    assert.equal(after.events.some(event => event.kind === 'merge_rejected'), mode === 'rejected');
  }
});
test('sensitive integration always acquires a fenced lease, even when developers did not opt in', async () => {
  const s = snapshot(11, { files: ['scripts/ci/protocol-rules.mjs'] }); s.originNumber = 1; s.pull.head.ref = 'delivery/candidate/test';
  const original = snapshot(1, { files: s.files }); const state = activate(emptyState(repo));
  updateTask(state, 1, { status: 'waiting_ci', headSha: head, mainSha: main, originalBody: '', intent, developerReview: review(s), candidate: candidateReceipt(s) }, now);
  const store = memoryStore(state); let writes = 0; let phase = 'open';
  const platform = { repo, error: e => e.message, assertCandidateProtection: async () => {}, snapshot: async () => s,
    pull: async number => number === 1 ? { ...original.pull, state: phase } : s.pull, list: async () => [], comment: async () => {},
    call: async (_path, options) => { if (options?.method === 'PATCH') phase = 'closed'; },
    merge: async () => { writes++; const current = await store.read(); assert.equal(current.leases.protocol.owner, 'integration/pr-1'); assert.ok(current.leases.protocol.generation > 0); return { sha: mergedSha }; },
    verifyMerge: async () => ({ sha: mergedSha, sourceSha: head, mainSha: main }) };
  await store.mutate(current => leaseOperation(current, { action: 'acquire', owner: 'other', scopes: ['protocol'] }, now));
  await assert.rejects(mergeCandidate({ platform, store, policy, snapshot: s, dependencies: new Map(), now }), /busy/); assert.equal(writes, 0);
  await store.mutate(current => leaseOperation(current, { action: 'release', owner: 'other', scopes: ['protocol'], generation: { protocol: 1 } }, now));
  await mergeCandidate({ platform, store, policy, snapshot: s, dependencies: new Map(), now });
  assert.equal(writes, 1); assert.equal((await store.read()).leases.protocol.owner, null);
  assert.ok((await store.read()).events.some(event => event.kind === 'lease_acquire' && event.data.owner === 'integration/pr-1'));
});
test('red oldest PR and failed release do not stop a later healthy PR candidate', async () => {
  const state = activate(emptyState(repo)); const good = snapshot(2); const candidate = snapshot(22); candidate.pull.head.ref = 'delivery/candidate/22'; candidate.originNumber = 2;
  updateTask(state, 2, { status: 'waiting_ci', headSha: head, mainSha: main, developerReview: review(good) }, now); const store = memoryStore(state); let candidateCreated = 0; let originalClosed = false;
  const platform = { repo, error: e => e.message, pulls: async () => [snapshot(1).pull, good.pull], snapshot: async number => number === 1 ? snapshot(1, { checkErrors: ['Required check static-gate failed'] }) : number === 22 ? candidate : good,
    pull: async number => number === 2 ? { ...good.pull, state: originalClosed ? 'closed' : 'open' } : number === 22 ? candidate.pull : snapshot(number).pull,
    ensureCandidate: async () => { candidateCreated++; return candidateReceipt(candidate); }, assertCandidateProtection: async () => {}, list: async () => [], comment: async () => {},
    merge: async () => ({ sha: mergedSha }), verifyMerge: async () => ({ sha: mergedSha, sourceSha: head, mainSha: main }),
    call: async (_path, options) => { if (options?.method === 'PATCH') originalClosed = true; return {}; } };
  let releaseCalls = 0;
  const report = await reconcile({ platform, store, policy, now, services: { reconcileReleases: async () => { releaseCalls++; throw new Error('release failed'); } } });
  assert.equal(candidateCreated, 1); assert.equal(report.integrated[0].number, 2); assert.ok(report.waiting.some(item => item.number === 1)); assert.equal(report.failed.length, 0); assert.equal(originalClosed, true); assert.equal(releaseCalls, 0);
});
test('task receipt cannot close an unmerged task or a task with declared unverified release', async () => {
  const state = emptyState(repo); const taskIntent = { ...intent, taskId: 'T-2026-1005-1001', releases: [{ kind: 'desktop', version: 'v1.2.3' }] };
  updateTask(state, 1, { status: 'waiting_ci', intent: taskIntent }, now); updateTask(state, 2, { status: 'release_pending', intent: taskIntent, merge: { sha: mergedSha, sourceSha: head, mainSha: main } }, now);
  let writes = 0; await writeTaskReceipts({ store: memoryStore(state), platform: { list: async () => { writes++; return []; } }, now }); assert.equal(writes, 0);
});
test('a lease acquired by another developer during snapshot reading blocks candidate creation', async () => {
  const store = memoryStore(activate(emptyState(repo))); let candidates = 0;
  const s = snapshot(2, { files: ['AGENTS.md'] });
  const platform = { repo, error: e => e.message, pulls: async () => [s.pull],
    snapshot: async () => { await store.mutate(current => leaseOperation(current, { action: 'acquire', owner: 'other', scopes: ['protocol'] }, now)); return s; },
    ensureCandidate: async () => { candidates++; }, list: async () => [] };
  const report = await reconcile({ platform, store, policy, now });
  assert.equal(candidates, 0); assert.equal(report.waiting[0].reason, 'Active developer lease protocol');
  assert.equal((await store.read()).leases.protocol.owner, 'other');
});
test('a reused task id or a ready PR body cannot release a developer lease or admit a candidate', async () => {
  const taskId = 'T-2026-1006-1003'; const state = activate(emptyState(repo));
  leaseOperation(state, { action: 'acquire', owner: taskId, scopes: ['protocol'] }, now);
  const store = memoryStore(state); const s = snapshot(2, { files: ['AGENTS.md'], intent: { ...intent, taskId } }); let candidates = 0;
  const report = await reconcile({ platform: { repo, error: error => error.message, pulls: async () => [s.pull], snapshot: async () => s,
    ensureCandidate: async () => { candidates++; }, list: async () => [] }, store, policy, now });
  assert.equal(candidates, 0); assert.equal(report.waiting[0].reason, 'Active developer lease protocol');
  assert.equal((await store.read()).leases.protocol.owner, taskId);
});
test('candidate body or origin mutation is rejected before sending a platform merge', async () => {
  for (const mode of ['missing-origin', 'changed-body']) {
    const s = snapshot(11); s.originNumber = 1; s.pull.head.ref = 'delivery/candidate/test'; const candidate = candidateReceipt(s);
    const state = activate(emptyState(repo)); updateTask(state, 1, { status: 'waiting_ci', headSha: head, mainSha: main, originalBody: '', intent, developerReview: review(s), candidate }, now);
    const latest = { ...s, pull: { ...s.pull, body: mode === 'missing-origin' ? '' : s.pull.body + '\nchanged intent' } }; let writes = 0;
    await assert.rejects(mergeCandidate({ platform: { repo, assertCandidateProtection: async () => {}, snapshot: async () => latest,
      error: error => error.message, merge: async () => { writes++; } }, store: memoryStore(state), policy, snapshot: s, dependencies: new Map(), now }), /origin\/body/);
    assert.equal(writes, 0);
  }
});
test('runner deadline uses elapsed time independently of injected lease/calendar time and preserves the exact boundary', async () => {
  const clocks = [0, 240000, 240001]; const scanned = [];
  const platform = { repo, error: e => e.message, pulls: async () => [snapshot(1).pull, snapshot(2).pull], snapshot: async number => { scanned.push(number); return snapshot(number, { checkErrors: ['still pending'] }); } };
  const report = await reconcile({ platform, store: memoryStore(), policy, now: 1, dryRun: true, elapsedClock: () => clocks.shift(), deadlineMs: 240000 });
  assert.deepEqual(scanned, [1]); assert.equal(report.waiting.find(item => item.number === 2).reason, 'Bounded runner time; next reconcile continues');
});
test('legacy review capacity never reads paid build history and cannot block unrelated reviewed source', async () => {
  let calls = 0;
  const platform = { call: async () => { calls++; throw new Error('No build history allowed'); } };
  assert.equal(await reviewSlotBusy(platform, memoryStore(), 2, main, now), false); assert.equal(calls, 0);
});

test('release enqueue is idempotent by frozen source/kind/version and keeps integration separate', () => {
  const state = emptyState(repo); const task = { number: 1, merge: { sha: mergedSha }, intent: { releases: [{ kind: 'ui', version: 'v1.2.3' }] } };
  enqueueReleases(state, repo, task, now); enqueueReleases(state, repo, task, now); assert.equal(Object.keys(state.releases).length, 1); assert.equal(Object.values(state.releases)[0].version, '1.2.3');
});
test('both UI and desktop dispatch pass the explicit frozen SHA to the whole build, independently of current branch SHA', async () => {
  for (const kind of ['ui', 'desktop']) {
    const state = emptyState(repo); enqueueReleases(state, repo, { number: 1, merge: { sha: mergedSha }, intent: { releases: [{ kind, version: '1.2.3' }] } }, now);
    let request;
    const platform = { repo, error: error => error.message, call: async (path, options) => {
      if (path.includes('/build/logs')) return { total: 0, data: [] };
      if (path === '/-/build/start') { request = options.body; return { success: true, sn: `actual-${kind}` }; }
      throw new Error(`Unexpected release dispatch ${path}`);
    } };
    assert.equal((await reconcileReleases({ platform, store: memoryStore(state), now }))[0].status, 'running');
    assert.equal(request.sha, mergedSha); assert.equal(request.env.RELEASE_EXPECTED_SHA, mergedSha);
    assert.equal(request.event, releaseEventFor(kind)); assert.equal(request.env.CNB_REPO_SLUG, undefined);
    assert.equal(request.env.CNB_BRANCH_SHA, undefined); // Native readonly identities are never overridden.
  }
});
test('manual UI event and delivery dispatch use the same actual publishing job and native lock; the scheduler only launches and observes', async t => {
  const YAML = await parser(); const root = YAML.parse(await readFile(new URL('../../.cnb.yml', import.meta.url), 'utf8'), { maxAliasCount: 1000 });
  assert.equal(releaseEventFor('ui'), 'api_trigger_ui_release'); assert.equal(releaseEventFor('desktop'), 'api_trigger_desktop_release');
  assert.throws(() => releaseEventFor('unknown'), /Unknown/);
  if (!root['.ui-release']) { t.skip('This product has no shared UI publishing lane'); return; }
  const jobs = root.$?.[releaseEventFor('ui')] ?? root.main?.[releaseEventFor('ui')];
  assert.deepEqual(jobs, [root['.ui-release']]);
  assert.equal(jobs[0].lock.key, 'workloom-delivery-release-ui'); assert.equal(jobs[0].lock.wait, true);
  const scheduler = YAML.parse(await readFile(new URL('./cnb.yml', import.meta.url), 'utf8'))['.delivery-releases'];
  assert.notEqual(scheduler.lock.key, jobs[0].lock.key);
  assert.ok(!scheduler.stages.some(stage => String(stage.script).includes('cnb-release-publish')));
});
test('release launch intent survives lost acknowledgement and forbids duplicate publication', async () => {
  const state = emptyState(repo); const task = { number: 1, merge: { sha: mergedSha }, intent: { releases: [{ kind: 'ui', version: '1.2.3' }] } }; enqueueReleases(state, repo, task, now); const store = memoryStore(state); let launches = 0;
  const platform = { repo, error: e => e.message, call: async (path, options) => { if (path.includes('/build/logs')) return { total: 0, data: [] }; if (options?.method === 'POST') { launches++; throw new Error('lost ack'); } throw new Error('unexpected call'); } };
  assert.equal((await reconcileReleases({ platform, store, now }))[0].status, 'unknown'); await reconcileReleases({ platform, store, now: now + 60000 }); assert.equal(launches, 1);
});
test('release failures use the latest durable attempt count and park after two launches', async () => {
  const state = emptyState(repo); enqueueReleases(state, repo, { number: 1, merge: { sha: mergedSha }, intent: { releases: [{ kind: 'ui', version: '1.2.3' }] } }, now);
  const item = Object.values(state.releases)[0]; Object.assign(item, { status: 'running', build: { sn: 'failed-second' }, launchedAt: now, attempts: 1 });
  const store = memoryStore(state);
  const platform = { repo, error: error => error.message, call: async () => {
    await store.mutate(current => { current.releases[item.key].attempts = 2; }); return { status: 'error' };
  } };
  await reconcileReleases({ platform, store, now }); assert.equal((await store.read()).releases[item.key].status, 'parked');
});
test('lost release launch cannot adopt a different manual build with the same source/event', async () => {
  const state = emptyState(repo); enqueueReleases(state, repo, { number: 1, merge: { sha: mergedSha }, intent: { releases: [{ kind: 'ui', version: '1.2.3' }] } }, now);
  const item = Object.values(state.releases)[0]; item.status = 'unknown'; item.knownBuilds = [];
  const store = memoryStore(state); let writes = 0;
  const history = [{ sn: 'manual', sha: mergedSha, event: 'api_trigger_ui_release', title: 'Manual UI build' }];
  const platform = { repo, error: e => e.message, call: async (path, options) => { if (options?.method === 'POST') writes++; return path.includes('/build/logs') ? { total: history.length, data: history } : { status: 'pending' }; } };
  assert.equal((await reconcileReleases({ platform, store, now }))[0].status, 'unknown');
  assert.equal((await store.read()).releases[item.key].build, undefined);
  history.push({ sn: 'exact', sha: mergedSha, event: 'api_trigger_ui_release', title: `WorkLoom release ${item.key}` });
  assert.equal((await reconcileReleases({ platform, store, now }))[0].status, 'running');
  assert.equal((await store.read()).releases[item.key].build.sn, 'exact'); assert.equal(writes, 0);
});
test('UI release verifies the real Platform API JSON decoding contract and rejects unreadable registration or different bytes', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const version = '1.2.3'; const release = { sha: mergedSha, kind: 'ui', version, build: { sn: 'ui-build' } };
  const key = releaseKey({ repo, sha: mergedSha, kind: 'ui', version });
  const payload = Buffer.from('actual UI asset fixture'); const sri = `sha512-${createHash('sha512').update(payload).digest('base64')}`;
  let registration = { ui: { latestStableVersion: version, distribution: { integrityByVersion: { [version]: sri } } } };
  const requests = []; let downloaded = 0;
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname; requests.push(path);
    if (path.endsWith('/build/logs')) return Response.json({ total: 1, data: [{ sn: release.build.sn, sha: mergedSha, event: releaseEventFor('ui'), title: `WorkLoom release ${key}` }] });
    if (path.endsWith('/releases/tags/ui-v1.2.3')) return Response.json({ id: 'release-ui', draft: false });
    if (path.endsWith('/git/commits/ui-v1.2.3')) return Response.json({ sha: mergedSha });
    if (path.endsWith(`/git/raw/${mergedSha}/sync/base-capabilities.json`)) return Response.json(registration);
    throw new Error(`Unexpected UI release API path ${path}`);
  };
  const platform = new Platform(repo, 'test-only-ui-release');
  const download = async (actualRepo, tag, name) => { downloaded++; assert.equal(actualRepo, repo); assert.equal(tag, 'ui-v1.2.3'); assert.equal(name, 'workloom-ui-1.2.3.tgz'); return { name, size: payload.length, sri }; };
  const receipt = await verifyRelease(platform, release, download); assert.equal(receipt.assets[0].sri, sri); assert.equal(downloaded, 1);
  assert.ok(requests.some(path => path.endsWith(`/git/raw/${mergedSha}/sync/base-capabilities.json`)));
  for (const value of [null, [], 'not a JSON registration object']) { registration = value; await assert.rejects(verifyRelease(platform, release, download), /registration unreadable/); }
  assert.equal(downloaded, 1);
  registration = { ui: { latestStableVersion: version, distribution: { integrityByVersion: { [version]: 'sha512-different' } } } };
  await assert.rejects(verifyRelease(platform, release, download), /bytes differ/);
  registration.ui.latestStableVersion = '1.2.4'; registration.ui.distribution.integrityByVersion[version] = sri;
  await assert.rejects(verifyRelease(platform, release, download), /bytes differ/);
});
test('release verifies actual tag source, manifest identity and every downloaded digest', async () => {
  const hex = 'a'.repeat(128); const names = ['WorkLoom-mac-arm64.dmg', 'WorkLoom-mac-x64.dmg', 'WorkLoom-win-x64.exe']; const release = { sha: mergedSha, kind: 'desktop', version: 'v1.2.3', build: { sn: 'run' } };
  const manifest = { schemaVersion: 1, tag: release.version, sourceSha: mergedSha, assets: names.map(name => ({ name, size: 5, sha512: hex })) };
  const key = releaseKey({ repo, sha: mergedSha, kind: 'desktop', version: release.version });
  const build = { sn: 'run', sha: mergedSha, event: 'api_trigger_desktop_release', title: `WorkLoom release ${key}` };
  const platform = { repo, call: async path => path.includes('/build/logs') ? { total: 1, data: [build] } : path.includes('/releases/') ? { id: 'r', draft: false } : { sha: mergedSha } }; let downloads = 0;
  const download = async (_repo, _tag, name) => { downloads++; return name.endsWith('.json') ? { data: manifest } : { name, size: 5, sha512: hex }; };
  assert.equal((await verifyRelease(platform, release, download)).assets.length, 3); assert.equal(downloads, 4);
  manifest.sourceSha = head; await assert.rejects(verifyRelease(platform, release, download), /manifest/); manifest.sourceSha = mergedSha;
  await assert.rejects(verifyRelease(platform, release, async () => ({ data: manifest, size: 6, sha512: hex })), /byte/);
  build.sha = head; await assert.rejects(verifyRelease(platform, release, download), /build source/);
});

test('private release download authenticates only the official first request and hashes the actual redirected bytes', async () => {
  const token = randomUUID(); const bytes = Buffer.from('{"sourceSha":"actual-fixture"}'); const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options }); assert.equal(options.redirect, 'manual');
    if (calls.length === 1) {
      assert.equal(url, `https://api.cnb.cool/${repo}/-/releases/download/v1.2.3/manifest.json`);
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      return new Response(null, { status: 302, headers: { location: 'https://download.example/temporary-signed-byte-url' } });
    }
    assert.equal(options.headers.Authorization, undefined); return new Response(bytes);
  };
  const result = await downloadReleaseBytes(repo, 'v1.2.3', 'manifest.json', { token, request, json: true });
  assert.equal(result.size, bytes.length); assert.equal(result.sha512, createHash('sha512').update(bytes).digest('hex'));
  assert.deepEqual(result.data, { sourceSha: 'actual-fixture' }); assert.equal(calls.length, 2);
});

test('private release permission, unsafe redirect, empty/oversized stream and malformed manifest remain explicit failures', async () => {
  const token = randomUUID(); let calls = 0;
  const download = options => downloadReleaseBytes(repo, 'v1.2.3', 'asset', { token, ...options });
  for (const status of [401, 403, 404, 500]) await assert.rejects(download({ request: async () => { calls++; return new Response(token, { status }); } }), error => error.message.includes(`HTTP ${error.status ?? status}`) && !error.message.includes(token));
  assert.equal(calls, 4);
  const credentialUrl = new URL('https://download.example/file'); credentialUrl.username = 'fixture'; credentialUrl.password = randomUUID();
  for (const location of ['http://download.example/file', credentialUrl.href, 'https://download.example/file#fragment'])
    await assert.rejects(download({ request: async () => new Response(null, { status: 302, headers: { location } }) }), /unsafe/);
  await assert.rejects(download({ request: async () => new Response(null, { status: 302 }) }), /lacks a location/);
  await assert.rejects(download({ request: async () => new Response('') }), /empty/);
  await assert.rejects(download({ maximum: 2, request: async () => new Response('123') }), /exceeds limit/);
  await assert.rejects(download({ json: true, request: async () => new Response('{invalid') }), /JSON is invalid/);
  await assert.rejects(download({ request: async () => { throw new Error(token); } }), error => /transport failed/.test(error.message) && !error.message.includes(token));
  await assert.rejects(download({ request: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)); } })) }), error => /stream failed/.test(error.message) && !error.message.includes(token));
});

test('a release redirect loop is bounded and every later same-origin or foreign request omits the token', async () => {
  const token = randomUUID(); let calls = 0;
  await assert.rejects(downloadReleaseBytes(repo, 'v1.2.3', 'asset', { token, request: async (url, options) => {
    calls++; assert.equal(options.headers.Authorization, calls === 1 ? `Bearer ${token}` : undefined);
    return new Response(null, { status: 302, headers: { location: calls % 2 ? '/same-origin-redirect' : 'https://download.example/again' } });
  } }), /redirect limit/);
  assert.equal(calls, 6);
});
