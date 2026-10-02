import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateP0Repetition } from './lib/outcome-contract.mjs';

const source = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(process.env.WORKLOOM_TEST_DEPENDENCIES ?? import.meta.url);
const yamlRoot = dirname(require.resolve('yaml/package.json'));

function fixture(t, { suite = true, production = false, fault = null, selftest = true, provider = 'mock' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rdas-outcome-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['scripts/acceptance/outcome.mjs', 'scripts/acceptance/lib/profile.mjs', 'scripts/acceptance/lib/target.mjs', 'scripts/acceptance/lib/outcome-contract.mjs', 'scripts/acceptance/lib/outcome-fixture.mjs', 'scripts/acceptance/lib/live/budget.mjs', 'scripts/delivery/evidence.mjs']) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(join(source, path), join(root, path));
  }
  for (const path of ['acceptance/outcomes', 'bundles/industry/presets', 'node_modules']) mkdirSync(join(root, path), { recursive: true });
  symlinkSync(yamlRoot, join(root, 'node_modules/yaml'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { yaml: JSON.parse(readFileSync(join(yamlRoot, 'package.json'), 'utf8')).version } }));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\noutputs/\n.env\n');
  writeFileSync(join(root, 'product.manifest.json'), JSON.stringify({ repository: 'workloom-ai/fixture', defaultBundle: 'industry' }));
  writeFileSync(join(root, 'bundles/industry/presets/analyst.yml'), 'preset_key: industry-analyst\nreadonly: true\n');
  writeFileSync(join(root, '.env'), 'LLM_PROVIDER=mock\nAPI_KEY=private_fixture_value_for_redaction\n');
  const profile = { schemaVersion: 'workloom.acceptance-profile/v2', repo: 'workloom-ai/fixture', primaryBundle: 'industry', dataMode: 'simulated', workspaceId: null, identity: { workspaceSlug: 'fixture', human: 'MEM-001' }, environment: { kind: production ? 'deployed' : 'local-preview', allowWrites: false, target: {} }, outcome: { taskSuites: ['acceptance/outcomes/industry.yaml'], roles: [{ role: 'industry-analyst', agentPreset: 'industry-analyst' }], fixtureMarker: 'suite.rdas.fixture', residualDisclosure: 'Test-created threads are isolated and reported.' } };
  if (suite) writeFileSync(join(root, 'acceptance/outcomes/industry.yaml'), `role: industry-analyst\nagentPreset: industry-analyst\ntrials: 1\ntasks:\n  - id: NORMAL\n    title: 行业事实摘要\n    input: 今天有哪些待办？\n    scenario: normal\n    criticality: P0\n    trials: 5\n    thread_asserts:\n      - { field: preset_key, equals: industry-analyst }\n    event_asserts:\n      - { action: ask.answer, field: decision.after.text, minLength: 10 }\n    receipt: { require: true, source: thread-events }\n  - id: FAILURE\n    title: 过长标题应拒绝\n    input: 标题边界验证\n    scenario: failure\n    invalidInput: title-too-long\n    expect: { status: 400, code: BAD_REQUEST, noThreadCreated: true }\n  - id: PERMISSION\n    title: 无身份派单应拒绝\n    input: 权限边界验证\n    scenario: permission\n    auth: none\n    expect: { status: 401, code: UNAUTHORIZED, noThreadCreated: true }\n`);
  const requests = []; const threads = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.test'); const procedure = url.pathname.replace('/trpc/', '');
    let body = ''; for await (const chunk of req) body += chunk;
    const input = req.method === 'POST' ? JSON.parse(body || '{}') : JSON.parse(url.searchParams.get('input') || '{}');
    requests.push({ procedure, input, auth: Boolean(req.headers.authorization) });
    const send = (status, data, code) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(code ? { error: { data: { code }, message: code } } : { result: { data } })); };
    if (procedure === 'auth.loginAs') { send(200, { token: ['fixture', 'token', 'is', 'never', 'persisted'].join('-'), identity: { workspaceId: 'ws-fixture' } }); return; }
    if (!req.headers.authorization) { send(401, null, 'UNAUTHORIZED'); return; }
    if (procedure === 'threads.list') { send(200, threads); return; }
    if (procedure === 'threads.dispatch') {
      if (input.title.length > 500) { send(400, null, 'BAD_REQUEST'); return; }
      const thread = { id: `T-${threads.length + 1}`, title: input.title, status: fault === 'running' ? 'running' : 'completed', preset_key: input.presetKey };
      threads.push(thread); send(200, { threadId: thread.id, kind: 'routed', status: thread.status }); return;
    }
    if (procedure === 'threads.get') { assert.equal(typeof input.threadId, 'string'); const thread = threads.find((row) => row.id === input.threadId); send(200, fault === 'wrong-thread' ? { ...thread, id: 'T-other' } : thread); return; }
    if (procedure === 'threads.events') { send(200, fault === 'empty-events' ? [] : [{ event_id: 'E-101', object: { id: input.threadId }, context: { workspace_id: 'ws-fixture' }, who: { id: 'industry-analyst' }, decision: { action: 'ask.answer', after: { text: fault === 'authorization-leak' ? 'Authorization: Basic '+['Q25iOn','ByaXZhdGUtZml4dHVyZQ=='].join('') : '需要处理一项行业待办，未完成项请负责人核对。' }, params: { via: 'rule' } }, model_trace: { model_id: 'mock-001' } }]); return; }
    send(404, null, 'NOT_FOUND');
  });
  return { root, profile, server, requests, threads, fault, selftest, provider };
}

async function run(t, f, args = []) {
  await new Promise((done) => f.server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => f.server.close(done)));
  f.profile.environment.target.apiUrl = `http://127.0.0.1:${f.server.address().port}`;
  if (f.configure) f.configure();
  writeFileSync(join(f.root, 'acceptance/profile.json'), JSON.stringify(f.profile));
  for (const gitArgs of [['init', '-qb', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.test'], ['add', '.'], ['commit', '-qm', 'fixture source']]) execFileSync('git', gitArgs, { cwd: f.root, stdio: 'ignore' });
  const result = await new Promise((done, reject) => {
    const fixtureArgs = f.selftest && !args.includes('--validate-only') ? ['--selftest', ...(f.fault ? ['--selftest-fault', f.fault] : [])] : [];
    const child = spawn(process.execPath, ['scripts/acceptance/outcome.mjs', '--timeout-s', f.fault === 'running' ? '1' : '5', '--poll-ms', '10', ...fixtureArgs, ...args], { cwd: f.root, env: { ...process.env, ACCEPTANCE_ENV_KIND: '', ACCEPTANCE_ALLOW_PROD_WRITES: '', LLM_PROVIDER: f.provider, DATABASE_URL: '' } });
    let output = ''; child.stdout.on('data', (data) => output += data); child.stderr.on('data', (data) => output += data);
    child.on('error', reject); child.on('close', (code) => done({ code, output }));
  });
  return { ...result, report: JSON.parse(readFileSync(join(f.root, 'outputs/acceptance/outcome/outcome-report.json'), 'utf8')) };
}

test('G14: absent suites exit unverified without creating a template or touching the service', async (t) => {
  const f = fixture(t, { suite: false }); const result = await run(t, f);
  assert.equal(result.code, 2, result.output); assert.equal(result.report.configured, false); assert.equal(result.report.stats.passAt1, null);
  assert.equal(existsSync(join(f.root, 'acceptance/outcomes/outcome-suite.example.yaml')), false); assert.deepEqual(f.requests, []);
});
test('G14: validate-only checks a complete industry matrix without network, DB or model calls', async (t) => {
  const f = fixture(t); const result = await run(t, f, ['--validate-only']);
  assert.equal(result.code, 0, result.output); assert.equal(result.report.contractValid, true); assert.equal(result.report.verified, false); assert.equal(result.report.status, 'unverified');
  assert.deepEqual(f.requests, []); assert.equal(result.report.stats.trials, 0); assert.equal(existsSync(join(f.root, 'outputs/acceptance/items/O2-07.json')), false);
});
test('G14: a P1 five-trial task cannot substitute for a P0 single-trial declaration', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'acceptance/outcomes/industry.yaml');
  const YAML = require('yaml');
  const suite = YAML.parse(readFileSync(path, 'utf8'));
  suite.tasks[0].trials = 1;
  suite.tasks.push({ ...suite.tasks[0], id: 'P1_REPEAT', criticality: 'P1', trials: 5 });
  writeFileSync(path, YAML.stringify(suite));
  const result = await run(t, f);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.report.configured, false);
  assert.match(result.report.errors.join('\n'), /P0.*(?:5|重复)/u);
  assert.deepEqual(f.requests, []);
});
test('G14: repetition counts actual distinct P0 trials and rejects duplicates or missing verification', () => {
  const tasks = [{ id: 'P0', criticality: 'P0', scenario: 'normal' }, { id: 'P1', criticality: 'P1', scenario: 'normal' }];
  const observed = (taskId, n, criticality) => Array.from({ length: n }, (_, index) => ({ taskId, criticality, scenario: 'normal', trial: index + 1, pass: true, verified: true }));
  const p1 = observed('P1', 5, 'P1');
  assert.equal(evaluateP0Repetition(tasks, [...observed('P0', 1, 'P0'), ...p1]).ok, false);
  const complete = observed('P0', 5, 'P0');
  assert.equal(evaluateP0Repetition(tasks, [...complete, ...p1]).ok, true);
  assert.equal(evaluateP0Repetition(tasks, [...complete.slice(0, 4), complete[0], ...p1]).ok, false);
  assert.equal(evaluateP0Repetition(tasks, [...complete.slice(0, 4), { ...complete[4], verified: false }, ...p1]).ok, false);
  assert.equal(evaluateP0Repetition([], complete).ok, false);
});
test('G14: a runtime trials override cannot turn one actual P0 observation into O2-01 pass', async (t) => {
  const f = fixture(t); const result = await run(t, f, ['--trials', '1']);
  assert.equal(result.code, 2, result.output);
  assert.equal(result.report.p0Stats.minTrials, 1);
  assert.equal(result.report.p0Stats.ok, false);
  assert.equal(result.report.checks.find((check) => check.id === 'O2-01').status, 'unverified');
  assert.equal(existsSync(join(f.root, 'outputs/acceptance/items/O2-01.json')), false);
});
test('G14: an invalid evidence boundary cannot write into its rejected destination', async (t) => {
  const f = fixture(t); const rejected = join(f.root, 'rejected-output');
  const result = await run(t, f, ['--out', rejected, '--evidence-root', rejected]);
  assert.equal(result.code, 1, result.output); assert.equal(result.report.status, 'fail');
  assert.equal(existsSync(rejected), false); assert.deepEqual(f.requests, []);
});
test('G14: production without write authorization performs no demo login, dispatch or DB connection', async (t) => {
  const f = fixture(t, { production: true }); const before = JSON.stringify(f.profile); const result = await run(t, f);
  assert.equal(result.code, 2, result.output); assert.deepEqual(f.requests, []); assert.equal(result.report.verified, false);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'acceptance/profile.json'), 'utf8')).environment.kind, 'deployed'); assert.equal(f.profile.environment.allowWrites, false);
  assert.ok(before.includes('deployed'));
});
test('G14: actual HTTP matrix yields structure results while mock never claims production capability', async (t) => {
  const f = fixture(t); const result = await run(t, f);
  assert.equal(result.code, 2, result.output); assert.equal(result.report.status, 'unverified'); assert.equal(result.report.stats.passed, 7);
  assert.equal(result.report.trials[0].receipt.threadId, 'T-1'); assert.deepEqual(result.report.trials[0].receipt.eventIds, ['E-101']);
  assert.equal(result.report.fixtureObservation.threads.length, 5); assert.equal(result.report.fixtureObservation.requests.some((request) => request.procedure === 'threads.dispatch' && !request.auth), true);
  assert.deepEqual(f.requests, []); assert.equal(result.report.fixtureObservation.closed, true); assert.equal(result.report.fixtureObservation.externalTargetUsed, false);
  assert.equal(JSON.stringify(result.report).includes('fixture-token-is-never-persisted'), false);
});
test('G14: authorization headers returned in task events are removed from the bound report', async (t) => {
  const f = fixture(t, { fault: 'authorization-leak' }); const result = await run(t, f);
  const header = 'Authorization: Basic '+['Q25iOn','ByaXZhdGUtZml4dHVyZQ=='].join('');
  assert.equal(result.code, 2, result.output); assert.equal(JSON.stringify(result.report).includes(header), false); assert.equal(result.output.includes(header), false);
  const trial = result.report.trials[0];
  assert.equal(trial.evidenceRedacted, true); assert.equal(trial.verified, false);
  assert.equal(trial.receipt.evidenceSha256, createHash('sha256').update(JSON.stringify(trial.observed.events)).digest('hex'));
});
for (const fault of ['empty-events', 'wrong-thread', 'running']) test(`G14: ${fault} cannot become an outcome success`, async (t) => {
  const f = fixture(t, { fault }); const result = await run(t, f);
  assert.equal(result.code, 1, result.output); assert.equal(result.report.status, 'fail'); assert.equal(result.report.trials[0].pass, false);
  if (fault !== 'running') { assert.equal(result.report.trials[0].falseSuccess, true); assert.equal(existsSync(join(f.root, 'outputs/acceptance/items/O2-07.json')), true); }
  else { assert.equal(result.report.trials[0].status, 'running'); assert.equal(result.report.fixtureObservation.requests.some((request) => request.procedure === 'threads.events'), true); }
});

test('G02: O-domain simulated runtime cannot dispatch an opaque model task before budget authorization', async t => {
  const f = fixture(t, { selftest: false }); const result = await run(t, f);
  assert.equal(result.code, 2, result.output); assert.deepEqual(f.requests, []);
  assert.equal(result.report.stats.trials, 0); assert.match(result.report.errors.join('\n'), /预算|逐请求|不透明/);
  assert.equal(result.report.called, false); assert.equal(existsSync(join(f.root, 'outputs/acceptance/items/O2-01.json')), false);
});

for (const kind of ['local-preview', 'client-runtime', 'deployed']) test(`G02: ${kind} real-provider runtime cannot bypass the pre-request budget guard`, async t => {
  const f = fixture(t, { selftest: false, provider: 'deepseek' });
  f.profile.environment.kind = kind; f.profile.environment.allowWrites = true; f.profile.dataMode = 'real';
  f.profile.outcome.maxModelCalls = 1;
  const result = await run(t, f, ['--trials', '1', '--allow-prod-writes', '--allow-measurement-interventions']);
  assert.equal(result.code, 2, result.output); assert.deepEqual(f.requests, []);
  assert.equal(result.report.called, false); assert.equal(result.report.stats.trials, 0);
  assert.equal(result.report.provider, 'deepseek'); assert.equal(result.report.verified, false);
  assert.match(result.report.errors.join('\n'), /总输入.*输出.*重试.*上下文/);
});

test('G02: a production profile and explicit write flag cannot turn the selftest fixture into production evidence', async t => {
  const f = fixture(t, { production: true }); f.profile.environment.allowWrites = true;
  const result = await run(t, f, ['--allow-prod-writes']);
  assert.equal(result.code, 2, result.output); assert.deepEqual(f.requests, []);
  assert.equal(result.report.called, false); assert.equal(result.report.stats.trials, 0);
  assert.equal(result.report.fixtureObservation, undefined);
  assert.match(result.report.errors.join('\n'), /自有 selftest.*生产验收/);
});

for (const operation of ['sql', 'approval']) test(`G02: selftest ${operation} adapters remain blocked before creating a fixture or calling external services`, async t => {
  const f = fixture(t); const path = join(f.root, 'acceptance/outcomes/industry.yaml');
  const YAML = require('yaml'); const suite = YAML.parse(readFileSync(path, 'utf8'));
  if (operation === 'sql') suite.tasks[0].state_asserts = [{ sql: 'SELECT count(*) AS n FROM threads', params: [], op: '>=', value: 0 }];
  else suite.tasks[0].intervention = 'approval';
  writeFileSync(path, YAML.stringify(suite));
  const result = await run(t, f, ['--allow-measurement-interventions']);
  assert.equal(result.code, 2, result.output); assert.deepEqual(f.requests, []);
  assert.equal(result.report.called, false); assert.equal(result.report.stats.trials, 0);
  assert.equal(result.report.fixtureObservation, undefined);
  assert.match(result.report.errors.join('\n'), /外部数据库或审批服务/);
});

test('G02: an absolute HTTP assertion cannot redirect the selftest into the supplied external target', async t => {
  const f = fixture(t);
  f.configure = () => {
    const YAML = require('yaml'); const path = join(f.root, 'acceptance/outcomes/industry.yaml');
    const suite = YAML.parse(readFileSync(path, 'utf8'));
    suite.tasks[0].http_asserts = [{ url: `${f.profile.environment.target.apiUrl}/outside-state`, status: 200, method: 'GET' }];
    writeFileSync(path, YAML.stringify(suite));
  };
  const result = await run(t, f);
  assert.equal(result.code, 1, result.output); assert.deepEqual(f.requests, []);
  assert.equal(result.report.fixtureObservation.externalTargetUsed, false);
  assert.equal(result.report.fixtureObservation.closed, true);
  assert.equal(result.report.fixtureObservation.modelCalls, 0);
  assert.equal(result.report.fixtureObservation.databaseConnections, 0);
  assert.equal(result.report.trials[0].asserts.find(item => item.type === 'http').ok, false);
  assert.match(result.report.trials[0].asserts.find(item => item.type === 'http').error, /同一目标/);
});
