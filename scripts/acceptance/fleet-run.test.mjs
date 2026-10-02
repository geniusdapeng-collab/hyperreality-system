import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { acceptanceContext, validateReportInputs } from './lib/evidence.mjs';
import { verifyRun } from '../delivery/evidence.mjs';

const script = fileURLToPath(new URL('./fleet-run.mjs', import.meta.url));
function fixture(t, { kind = 'local-preview', target = {}, scripts = { suite: 'true', 'release:gate': 'true' }, reportExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rdas-fleet-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'probe');
  const bin = join(root, 'bin');
  for (const dir of [bin, join(repo, 'acceptance'), join(repo, 'scripts', 'acceptance'), join(repo, 'node_modules', '.bin')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts }));
  writeFileSync(join(repo, 'product.manifest.json'), JSON.stringify({ repository: 'workloom-ai/probe', defaultBundle: 'fixture' }));
  writeFileSync(join(repo, '.env'), `JWT_SECRET=${'mock'.repeat(16)}\nPII_SALT=${'mock'.repeat(16)}\nDATABASE_URL=mock\nLLM_PROVIDER=mock\n`);
  writeFileSync(join(repo, 'acceptance', 'profile.json'), JSON.stringify({ schemaVersion: 'workloom.acceptance-profile/v2', primaryBundle: 'fixture', environment: { kind, target }, startup: { ports: { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 } }, live: { enabled: false } }));
  const commandLog = join(root, 'commands.jsonl');
  const stepLog = join(root, 'steps.jsonl');
  for (const name of ['git', 'pnpm', 'lsof']) {
    const file = join(bin, name);
    writeFileSync(file, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);appendFileSync(process.env.COMMAND_LOG,JSON.stringify({name:${JSON.stringify(name)},args})+'\\n');\nif(${JSON.stringify(name)}==='git'){if(args.includes('rev-parse'))console.log(args.includes('--abbrev-ref')?'task/fixture':'a'.repeat(40));}\nif(${JSON.stringify(name)}==='lsof'&&args.includes('-iTCP'))console.log('server :8787\\npc :3000\\nb :3001\\nc :3002');\nif(${JSON.stringify(name)}==='pnpm'){if(args.includes('suite'))process.exit(Number(process.env.SUITE_EXIT??0));if(args.includes('release:gate'))process.exit(Number(process.env.RELEASE_EXIT??0));if(args.includes('preview:all'))setInterval(()=>{},1000);}\n`, { mode: 0o755 });
  }
  writeFileSync(join(repo, 'node_modules', '.bin', 'tsx'), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const args=process.argv.slice(2).filter(arg=>!arg.startsWith('--env-file='));const result=spawnSync(process.execPath,args,{stdio:'inherit',env:process.env});process.exit(result.status??1);\n`, { mode: 0o755 });
  const outputNames = { matrix: 'matrix-summary.json', 'ui-probe': 'ui-probe.json', experience: 'experience-report.json', ux: 'ux-report.json', live: 'live-report.json', outcome: 'outcome-report.json', autonomy: 'autonomy-report.json', redteam: 'redteam-report.json', soak: 'soak-report.json', coverage: 'coverage.json', 'report-v3': 'report-summary.json' };
  for (const [name, outputName] of Object.entries(outputNames)) {
    const extraOutput = name === 'report-v3' ? "writeFileSync(join(out,'REPORT.md'),'# Fixture report\\n');" : '';
    writeFileSync(join(repo, 'scripts', 'acceptance', `${name}.${name === 'matrix' ? 'mts' : 'mjs'}`), `import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';import {dirname,join,resolve} from 'node:path';const args=process.argv.slice(2);appendFileSync(process.env.STEP_LOG,JSON.stringify({name:${JSON.stringify(name)},env:process.env.ACCEPTANCE_ENV_KIND,argv:args})+'\\n');const out=args.includes('--out')?resolve(args[args.indexOf('--out')+1]):resolve('outputs/acceptance');const path=${name === 'coverage' ? 'out' : `join(out,${JSON.stringify(outputName)})`};mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify({stage:${JSON.stringify(name)},observedPid:process.pid})+'\\n');${extraOutput}process.exit(${name === 'report-v3' ? reportExit : 0});\n`);
  }
  return { root, repo, bin, commandLog, stepLog };
}
async function run(f, argv = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--repo', 'probe', '--fleet-dir', f.root, '--executor-root', f.repo, '--skip-install', '--skip-seed', ...argv], { env: { ...process.env, ACCEPTANCE_ENV_KIND: '', ACCEPTANCE_ALLOW_PROD_WRITES: '', ...env, PATH: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, COMMAND_LOG: f.commandLog, STEP_LOG: f.stepLog } });
    let out = '';
    child.stdout.on('data', (b) => out += b);
    child.stderr.on('data', (b) => out += b);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, state: JSON.parse(readFileSync(join(f.repo, 'outputs', 'acceptance', 'fleet-run-state.json'), 'utf8')) }));
  });
}
const readLog = (path) => { try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
test('G06: failed required regression makes aggregate state and exit fail', async (t) => {
  const f = fixture(t);
  const result = await run(f, [], { SUITE_EXIT: '1' });
  assert.equal(result.code, 1, result.out);
  assert.equal(result.state.ok, false);
  assert.equal(result.state.steps.regression.ok, false);
});
test('G06: failed release gate is a failed aggregate step', async (t) => {
  const result = await run(fixture(t), [], { RELEASE_EXIT: '1' });
  assert.equal(result.code, 1, result.out);
  assert.equal(result.state.steps.releaseGate.ok, false);
});
test('G06: explicitly requested missing regression is unverified with nonzero exit', async (t) => {
  const result = await run(fixture(t), ['--regression', 'missing']);
  assert.equal(result.code, 2, result.out);
  assert.equal(result.state.steps.regression.status, 'unverified');
});
test('G07: production CLI/profile conflict blocks before any command or target request', async (t) => {
  const f = fixture(t);
  const result = await run(f, ['--env', 'deployed']);
  assert.notEqual(result.code, 0);
  assert.match(result.state.steps.environment.detail, /冲突|conflict/);
  assert.deepEqual(readLog(f.commandLog), []);
});
test('G07: production avoids checkout/pull/install/seed/local probes and propagates one environment', async (t) => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const f = fixture(t, { kind: 'deployed', target: { apiUrl } });
  const result = await run(f);
  assert.equal(result.code, 0, result.out);
  const commands = readLog(f.commandLog);
  assert.equal(commands.some((c) => c.name !== 'git' || c.args.some((a) => ['fetch', 'checkout', 'pull', 'install', 'db:migrate', 'preview:all'].includes(a))), false, JSON.stringify(commands));
  const steps = readLog(f.stepLog);
  assert.deepEqual(steps.map((s) => s.name), ['live', 'coverage', 'report-v3']);
  for (const step of steps) {
    assert.equal(step.env, 'deployed');
    assert.equal(step.argv.filter((arg) => arg === '--env').length, 1, JSON.stringify(step));
    assert.equal(step.argv.filter((arg) => arg === '--profile').length, 1, JSON.stringify(step));
    assert.ok(step.argv.includes('--evidence-root'));
  }
});
test('G06: report unverified exit 2 is preserved in aggregate result', async (t) => {
  const f = fixture(t, { reportExit: 2 });
  const result = await run(f, ['--skip-regression']);
  assert.equal(result.code, 2, result.out);
  assert.equal(result.state.steps.report.status, 'unverified');
  assert.equal(result.state.status, 'unverified');
});
test('G06: invalid evidence binding records a failed step and still reports and tears down', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, 'outputs', 'acceptance'), { recursive: true });
  writeFileSync(join(f.repo, 'outputs', 'acceptance', 'evidence-index.json'), JSON.stringify({ schema: 'workloom.evidence-index/v1', commit: 'b'.repeat(40), runs: [], artifacts: [] }));
  const result = await run(f);
  assert.equal(result.code, 1, result.out);
  assert.equal(result.state.steps.regression.status, 'fail');
  assert.ok(readLog(f.stepLog).some((step) => step.name === 'report-v3'), result.out);
  assert.equal(result.state.steps.teardown.status, 'pass');
});
test('G07: duplicate environment flags reject before commands and do not echo secrets', async (t) => {
  const f = fixture(t);
  const result = await run(f, ['--env', 'local-preview', '--env', 'deployed']);
  assert.notEqual(result.code, 0, result.out);
  assert.deepEqual(readLog(f.commandLog), []);
});
test('G07: encoded Git Basic credentials printed by a child are removed before persistence', async (t) => {
  const f = fixture(t); const header = 'Authorization: Basic ' + ['Q25iOn', 'ByaXZhdGUtZml4dHVyZQ=='].join('');
  const pnpm = join(f.bin, 'pnpm');
  writeFileSync(pnpm, readFileSync(pnpm, 'utf8').replace('const args=process.argv.slice(2);', 'console.log(process.env.GIT_CONFIG_VALUE_2);const args=process.argv.slice(2);'), { mode: 0o755 });
  const result = await run(f, [], { GIT_CONFIG_VALUE_2: header });
  assert.equal(result.out.includes(header), false); assert.equal(JSON.stringify(result.state).includes(header), false);
  const logs = readdirSync(join(f.repo, 'outputs/acceptance/execution')).filter((name) => name.endsWith('.log'));
  assert.ok(logs.length > 0);
  for (const name of logs) assert.equal(readFileSync(join(f.repo, 'outputs/acceptance/execution', name), 'utf8').includes(header), false);
});

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const stagePaths = { matrix: 'matrix/matrix-summary.json', ui: 'ui/ui-probe.json', experience: 'experience/experience-report.json', ux: 'ux/ux-report.json', outcome: 'outcome/outcome-report.json', autonomy: 'autonomy/autonomy-report.json', redteam: 'redteam/redteam-report.json', soak: 'soak/soak-report.json' };
function producerFixture(t) {
  const f = fixture(t); rmSync(join(f.bin, 'git'));
  const checklistPath = join(sourceRoot, 'docs/acceptance/checklist.v3.json');
  mkdirSync(join(f.repo, 'docs/acceptance'), { recursive: true }); copyFileSync(checklistPath, join(f.repo, 'docs/acceptance/checklist.v3.json'));
  const profilePath = join(f.repo, 'acceptance/profile.json'); const profile = JSON.parse(readFileSync(profilePath)); profile.repo = 'workloom-ai/probe'; profile.productName = 'Isolated fleet evidence fixture'; writeFileSync(profilePath, JSON.stringify(profile));
  // Each real fixture child observes its own PID and writes exactly its stage output.
  // coverage/report are the actual consumers; P is intentionally left unexecuted.
  const bodyFor = {
    matrix: "{counts:{agents:1,agentsPass:1,skills:1,skillsPass:1}}",
    ui: "{totals:{routesChecked:1,routesOk:1},issues:[]}",
    experience: "{totals:{checks:1,passed:1,failed:0},issues:[]}",
    ux: "{issues:[]}",
    outcome: "{configured:true,falseSuccess:0,stats:{passAtK:1,k:1},trials:[{id:'fixture-task',pass:true}]}",
    autonomy: "{overall:{delivered:{n:1}},anomalies:{externalWithoutReceipt:0}}",
    redteam: "{cases:[{id:'fixture-case',pass:true}],findings:[]}",
    soak: "{samples:[{observed:true,at:new Date().toISOString()}]}",
  };
  const layerFor = { matrix: 'L0', ui: 'L3', experience: 'L4', ux: 'U5', outcome: 'O0', autonomy: 'ADR', redteam: 'O6', soak: 'O5' };
  for (const [stage, path] of Object.entries(stagePaths)) {
    const entry = stage === 'ui' ? 'ui-probe' : stage;
    writeFileSync(join(f.repo, 'scripts/acceptance', `${entry}.${stage === 'matrix' ? 'mts' : 'mjs'}`), `import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {dirname,join} from 'node:path';const stage=${JSON.stringify(stage)};const argv=process.argv.slice(2);appendFileSync(process.env.STEP_LOG,JSON.stringify({name:stage,env:process.env.ACCEPTANCE_ENV_KIND,argv})+'\\n');if(process.env.OMIT_STAGE_JSON===stage)process.exit(0);const definitions=JSON.parse(readFileSync('docs/acceptance/checklist.v3.json')).items;const definition=definitions.find(item=>item.layer.startsWith(${JSON.stringify(layerFor[stage])}));const checks=definition?[{id:definition.id,pass:true,expected:'fixture process must execute this stage',actual:{stage,observedPid:process.pid}}]:[];const output={...${bodyFor[stage]},checks,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),fixtureOnly:true};const path=join('outputs/acceptance',${JSON.stringify(path)});mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(output)+'\\n');console.log(JSON.stringify({stage,observedPid:process.pid}));process.exit(process.env.FAIL_STAGE===stage?7:0);\n`);
  }
  for (const name of ['coverage', 'report-v3']) writeFileSync(join(f.repo, 'scripts/acceptance', `${name}.mjs`), `import ${JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/acceptance', `${name}.mjs`)).href)};\n`);
  writeFileSync(join(f.repo, '.gitignore'), 'outputs/\n.env\nnode_modules/\n');
  const git = (args) => execFileSync('git', args, { cwd: f.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fleet Evidence Fixture']); git(['config', 'user.email', 'fixture@workloom.local']); git(['add', '.']); git(['commit', '-qm', 'commit fixture producer and canonical checklist']);
  // Keep local preparation from trying a remote fetch; evidence sees the real clean tree.
  const gitShim = join(f.bin, 'git');
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(gitShim, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args[0]==='fetch'||args[0]==='pull')process.exit(0);const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);\n`, { mode: 0o755 });
  return { ...f, artifactRoot: join(f.repo, 'outputs/acceptance'), commit: git(['rev-parse', 'HEAD']) };
}
function proofFor(f, ref) { return verifyRun(ref, { repoRoot: f.repo, artifactRoot: f.artifactRoot, commit: f.commit, requirePass: false }); }
test('G05: actual fleet producer binds every stage JSON and actual regression commands before real coverage/report', async (t) => {
  const f = producerFixture(t); const result = await run(f, ['--with-redteam', '--soak-hours', '0.001']);
  assert.equal(result.code, 2, result.out); // Fixed 276 includes unexecuted manual/P checks.
  const index = JSON.parse(readFileSync(join(f.artifactRoot, 'evidence-index.json')));
  for (const [stage, path] of Object.entries(stagePaths)) {
    const ref = index.artifacts.find((ref) => ref.path === path);
    assert.ok(ref, `${stage} actual JSON must be indexed`);
    const proof = proofFor(f, result.state.steps[stage].run);
    assert.equal(proof.ok, true, proof.errors.join('; ')); assert.equal(proof.data.exit_code, 0);
    assert.ok(proof.data.outputs.some((output) => JSON.stringify(output) === JSON.stringify(ref)), `${stage} JSON must be from the observed run`);
  }
  const regression = JSON.parse(readFileSync(join(f.artifactRoot, 'regression/summary.json')));
  assert.equal(regression.schemaVersion, 'workloom.acceptance-regression/v2');
  for (const name of ['suite', 'release:gate']) {
    const proof = proofFor(f, regression.executions[name].run);
    assert.equal(proof.ok, true, proof.errors.join('; ')); assert.equal(proof.data.exit_code, 0);
    assert.ok(proof.data.exec.args.includes(name));
  }
  const verified = validateReportInputs(acceptanceContext(f.repo, f.artifactRoot));
  for (const path of [...Object.values(stagePaths), 'regression/summary.json']) assert.equal(verified.verifications[path].ok, true, verified.verifications[path].errors.join('; '));
  const coverage = JSON.parse(readFileSync(join(f.artifactRoot, 'coverage.json'))); assert.equal(coverage.items.length, 276); assert.ok(coverage.totals.byStatus.pass > 0); assert.ok(coverage.totals.byStatus.unverified > 0);
  const report = JSON.parse(readFileSync(join(f.artifactRoot, 'report-summary.json'))); assert.equal(report.reportGenerated, true); assert.equal(report.acceptancePassed, false); assert.equal(report.layers.P, '未验证');
});
test('G05: failed fleet child binds its newly produced JSON and the real report preserves failure', async (t) => {
  const f = producerFixture(t); const result = await run(f, ['--with-redteam', '--soak-hours', '0.001'], { FAIL_STAGE: 'matrix' });
  assert.equal(result.code, 1, result.out);
  const proof = proofFor(f, result.state.steps.matrix.run); assert.equal(proof.ok, true, proof.errors.join('; ')); assert.equal(proof.data.exit_code, 7);
  assert.ok(proof.data.outputs.some((ref) => ref.path === stagePaths.matrix));
  const report = JSON.parse(readFileSync(join(f.artifactRoot, 'report-summary.json'))); assert.equal(report.status, 'fail'); assert.ok(report.failedStages.includes(stagePaths.matrix));
});
test('G05: fleet rerun clears prior stage pass before a zero-output child returns exit zero', async (t) => {
  const f = producerFixture(t); const first = await run(f, ['--with-redteam', '--soak-hours', '0.001']); assert.equal(first.state.steps.matrix.status, 'pass', first.out);
  const second = await run(f, ['--with-redteam', '--soak-hours', '0.001'], { OMIT_STAGE_JSON: 'matrix' });
  assert.notEqual(second.code, 0); assert.notEqual(second.state.steps.matrix.status, 'pass');
  assert.equal(existsSync(join(f.artifactRoot, stagePaths.matrix)), false);
  const index = JSON.parse(readFileSync(join(f.artifactRoot, 'evidence-index.json'))); assert.equal(index.artifacts.some((ref) => ref.path === stagePaths.matrix), false);
  const coverage = JSON.parse(readFileSync(join(f.artifactRoot, 'coverage.json'))); const definition = JSON.parse(readFileSync(join(f.repo, 'docs/acceptance/checklist.v3.json'))).items.find((item) => item.layer.startsWith('L0'));
  assert.equal(coverage.items.find((item) => item.id === definition.id).status, 'unverified');
});
function rebindStageFile(f, path) {
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const indexPath = join(f.artifactRoot, 'evidence-index.json'); const index = JSON.parse(readFileSync(indexPath));
  const newRef = { path, sha256: hash(join(f.artifactRoot, path)), commit: f.commit };
  index.artifacts = index.artifacts.map((ref) => ref.path === path ? newRef : ref);
  index.runs = index.runs.map((ref) => {
    const runPath = join(f.artifactRoot, ref.path); const body = JSON.parse(readFileSync(runPath));
    if (!body.outputs.some((output) => output.path === path)) return ref;
    body.outputs = body.outputs.map((output) => output.path === path ? newRef : output); writeFileSync(runPath, JSON.stringify(body) + '\n');
    return { ...ref, sha256: hash(runPath) };
  });
  writeFileSync(indexPath, JSON.stringify(index) + '\n');
}
test('G05: report rejects a regression summary that cuts a required command from the actual captured input', async (t) => {
  const f = producerFixture(t); const result = await run(f, ['--with-redteam', '--soak-hours', '0.001']); assert.equal(result.code, 2, result.out);
  const path = 'regression/summary.json'; const summary = JSON.parse(readFileSync(join(f.artifactRoot, path)));
  assert.deepEqual(summary.required, ['suite', 'release:gate']);
  summary.required = ['release:gate']; delete summary.commands.suite; delete summary.executions.suite;
  writeFileSync(join(f.artifactRoot, path), JSON.stringify(summary) + '\n'); rebindStageFile(f, path);
  const verified = validateReportInputs(acceptanceContext(f.repo, f.artifactRoot));
  assert.equal(verified.verifications[path].ok, false, 'summary required must match the actual aggregator input after all hashes are rebound');
  assert.match(verified.verifications[path].errors.join('; '), /input|输入|必需命令/);
});
