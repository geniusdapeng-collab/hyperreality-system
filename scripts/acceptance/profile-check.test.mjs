import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(process.env.WORKLOOM_TEST_DEPENDENCIES ?? import.meta.url);
const yamlRoot = dirname(require.resolve('yaml/package.json'));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rdas-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['scripts/acceptance/profile-check.mjs', 'scripts/acceptance/lib/profile-contract.mjs', 'scripts/acceptance/lib/outcome-contract.mjs', 'scripts/acceptance/lib/profile.mjs', 'scripts/acceptance/lib/target.mjs', 'scripts/acceptance/lib/live/budget.mjs', 'scripts/delivery/evidence.mjs']) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(join(source, path), join(root, path));
  }
  for (const path of ['acceptance/outcomes', 'bundles/industry/presets', 'node_modules']) mkdirSync(join(root, path), { recursive: true });
  symlinkSync(yamlRoot, join(root, 'node_modules/yaml'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\noutputs/\n');
  writeFileSync(join(root, 'product.manifest.json'), JSON.stringify({ repository: 'workloom-ai/fixture', defaultBundle: 'industry', demoWorkspaceSlug: 'fixture', demoMemberNo: 'MEM-001' }));
  writeFileSync(join(root, 'bundles/industry/presets/analyst.yml'), 'preset_key: industry-analyst\nreadonly: true\n');
  const profile = { schemaVersion: 'workloom.acceptance-profile/v2', repo: 'workloom-ai/fixture', productName: '行业验收夹具', primaryBundle: 'industry', dataMode: 'simulated', identity: { workspaceSlug: 'fixture', human: 'MEM-001' }, startup: { command: 'pnpm preview:all', ports: { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 } }, environment: { kind: 'local-preview', allowWrites: false, target: {} }, surfaces: { pcRoutes: ['/'], bMobileRoutes: ['/'], cRoutes: ['#chat'] }, journeys: [{ id: 'EXP-01', title: '事实摘要', persona: 'owner', script: 'builtin:first-value' }], ux: { personas: [{ id: 'owner', criticality: 'P0', jtbd: ['看到事实与待核实项'] }], journeys: [{ id: 'U-01', title: '事实摘要', persona: 'owner', stage: 'daily' }], tasks: [{ id: 'U2-T01', persona: 'owner', criticality: 'P0', budgetMs: 30000, paths: ['normal', 'error', 'permission'] }] }, outcome: { fixtureMarker: 'suite.rdas.fixture', residualDisclosure: '带标记的验收线程和事件保留，不纳入业务指标。', roles: [{ role: 'industry-analyst', agentPreset: 'industry-analyst', al: 'AL3', deliverableUnit: '事实摘要', minSubstance: '来源、缺失项、待核实项' }], taskSuites: ['acceptance/outcomes/industry.yaml'] }, autonomy: { fixtureFilters: ['suite.rdas.'] }, live: { enabled: true, models: [], tasks: [{ id: 'PROD-01', kind: 'product', input: 'suite.rdas.fixture：当前事实有哪些未核实？', presetKey: 'industry-analyst', requireModel: true, fixtureMarker: 'suite.rdas.fixture', residualDisclosure: '保留验收线程。', state_asserts: [{ event: { action: 'ask.answer', field: 'decision.after.text', minLength: 10 } }] }] } };
  writeFileSync(join(root, 'acceptance/profile.json'), JSON.stringify(profile));
  writeFileSync(join(root, 'acceptance/outcomes/industry.yaml'), `role: industry-analyst\nagentPreset: industry-analyst\ntrials: 5\ntasks:\n  - id: NORMAL\n    title: 行业事实摘要\n    input: 当前有哪些未核实的事实？\n    scenario: normal\n    criticality: P0\n    event_asserts:\n      - { action: ask.answer, field: decision.after.text, minLength: 10 }\n    receipt: { require: true, source: thread-events }\n  - id: FAILURE\n    title: 超长标题拒绝\n    input: 边界验证\n    scenario: failure\n    invalidInput: title-too-long\n    expect: { status: 400, code: BAD_REQUEST, noThreadCreated: true }\n  - id: PERMISSION\n    title: 无身份拒绝\n    input: 权限验证\n    scenario: permission\n    auth: none\n    expect: { status: 401, code: UNAUTHORIZED, noThreadCreated: true }\n`);
  for (const args of [['init', '-qb', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.test'], ['add', '.'], ['commit', '-qm', 'profile source']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  return { root, profile };
}
function run(f, args = [], env = {}) {
  const result = spawnSync(process.execPath, ['scripts/acceptance/profile-check.mjs', ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, ACCEPTANCE_ENV_KIND: '', ACCEPTANCE_ALLOW_PROD_WRITES: '', ...env } });
  const path = join(f.root, 'outputs/acceptance/profile/profile-validation.json');
  return { code: result.status, output: `${result.stdout}\n${result.stderr}`, report: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null };
}
test('G14: profile CLI binds structural evidence but never emits a business or checklist pass', (t) => {
  const f = fixture(t); const result = run(f);
  assert.equal(result.code, 0, result.output); assert.equal(result.report.configurationStatus, 'valid'); assert.equal(result.report.status, 'unverified');
  assert.equal(result.report.businessVerified, false); assert.equal(result.report.taskCount, 3); assert.match(result.report.revision.commit, /^[0-9a-f]{40}$/);
  assert.equal(existsSync(join(f.root, 'outputs/acceptance/items')), false);
});
test('G14: CLI rejects raw missing routes instead of accepting loader defaults', (t) => {
  const f = fixture(t); delete f.profile.surfaces; writeFileSync(join(f.root, 'acceptance/profile.json'), JSON.stringify(f.profile));
  const result = run(f); assert.equal(result.code, 1, result.output); assert.match(result.report.errors.join(' '), /surfaces/);
});
test('G07 G14: CLI, inherited environment and profile conflicts are rejected before using a target', (t) => {
  for (const [args, env] of [[['--env', 'client-runtime'], {}], [[], { ACCEPTANCE_ENV_KIND: 'client-runtime' }], [['--env', 'local-preview', '--env', 'deployed'], {}]]) {
    const f = fixture(t); const result = run(f, args, env); assert.equal(result.code, 1, result.output); assert.equal(result.report.businessVerified, false);
  }
});
test('G14: explicitly missing profile is unverified and cannot fall back to a present default', (t) => {
  const f = fixture(t); const result = run(f, ['--profile', 'acceptance/missing.json']);
  assert.equal(result.code, 2, result.output); assert.equal(result.report.configurationStatus, 'missing'); assert.equal(result.report.status, 'unverified');
});
test('G14: malformed industry suite and stale undeclared suite fail the actual profile consumer', (t) => {
  for (const name of ['industry.yaml', 'undeclared.yaml']) {
    const f = fixture(t); writeFileSync(join(f.root, 'acceptance/outcomes', name), 'role: industry-analyst\ntasks: []\n');
    const result = run(f); assert.equal(result.code, 1, result.output); assert.equal(result.report.configurationStatus, 'invalid');
  }
});
test('G14: invalid output boundary writes only the safe fallback diagnostic', (t) => {
  const f = fixture(t); const rejected = join(f.root, 'rejected'); const result = run(f, ['--out', rejected, '--evidence-root', rejected]);
  assert.equal(result.code, 1, result.output); assert.equal(existsSync(rejected), false); assert.equal(result.report.configurationStatus, 'invalid');
});
test('G14: root CLI resolves governance assets only when both product manifests agree', (t) => {
  const f = fixture(t); mkdirSync(join(f.root, 'governance'));
  copyFileSync(join(f.root, 'product.manifest.json'), join(f.root, 'governance/product.manifest.json'));
  renameSync(join(f.root, 'bundles'), join(f.root, 'governance/bundles'));
  mkdirSync(join(f.root, 'bundles/industry'), { recursive: true });
  writeFileSync(join(f.root, 'bundles/industry/README.md'), 'Root metadata mirror; application presets are in governance.\n');
  const valid = run(f); assert.equal(valid.code, 0, valid.output);
  writeFileSync(join(f.root, 'governance/product.manifest.json'), JSON.stringify({ repository: 'workloom-ai/other', defaultBundle: 'industry' }));
  const invalid = run(f); assert.equal(invalid.code, 1, invalid.output); assert.match(invalid.report.errors.join(' '), /manifest/);
});
