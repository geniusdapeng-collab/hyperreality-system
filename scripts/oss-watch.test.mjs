import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch, dockerLatest, githubLatest } from './oss-watch.mjs';
import { run as runCi } from './oss-watch-ci.mjs';

const quiet = () => {};
function fixture(t, component = { name: 'demo', channel: 'github', repo: 'https://github.com/example/demo', cadence: 'monthly', current: '1.0.0', latest: '1.0.0' }) {
  const root = mkdtempSync(join(tmpdir(), 'oss-watch-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  writeFileSync(join(root, 'oss-components.json'), JSON.stringify({ meta: { doc: 'docs/OPEN_SOURCE_COMPONENTS.md' }, components: [component] }));
  writeFileSync(join(root, '.oss-watch-state.json'), JSON.stringify({ schema: 'workloom.oss-watch-state/v2', components: { demo: { last_scan: 123, last_success: 123, latest_seen: '1.0.0' } }, registry_cache: {} }));
  writeFileSync(join(root, 'docs/OPEN_SOURCE_COMPONENTS.md'), 'original document\n');
  writeFileSync(join(root, 'docs/oss-update-plan.md'), 'original plan\n');
  return root;
}
function failingFetch(t) {
  const before = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  t.after(() => { globalThis.fetch = before; });
}
function state(root) { return JSON.parse(readFileSync(join(root, '.oss-watch-state.json'), 'utf8')); }

test('failed upstream lookup never refreshes success time and is nonzero even with exit-zero', async (t) => {
  const root = fixture(t); failingFetch(t);
  const result = await runWatch({ root, all: true, exitZero: true, log: quiet });
  assert.equal(result.exitCode, 1);
  const entry = state(root).components.demo;
  assert.equal(entry.last_success, 123);
  assert.equal(entry.last_scan, 123);
  assert.equal(entry.status, 'error');
  assert.ok(entry.last_attempt > 123);
  assert.equal(entry.latest_seen, '1.0.0');
});

test('offline regeneration preserves upstream success clocks', async (t) => {
  const root = fixture(t);
  await runWatch({ root, all: true, offline: true, log: quiet });
  assert.equal(state(root).components.demo.last_scan, 123);
  assert.equal(state(root).components.demo.last_success, 123);
});

test('dry-run keeps registry, cache, inventory and plan byte-identical', async (t) => {
  const root = fixture(t); failingFetch(t);
  const paths = ['oss-components.json', '.oss-watch-state.json', 'docs/OPEN_SOURCE_COMPONENTS.md', 'docs/oss-update-plan.md'];
  const before = paths.map(p => readFileSync(join(root, p), 'utf8'));
  const result = await runWatch({ root, all: true, dryRun: true, log: quiet });
  assert.equal(result.summary.dryRun, true);
  assert.deepEqual(paths.map(p => readFileSync(join(root, p), 'utf8')), before);
});

test('docker without an explicit registry image is unverified, with no fake success timestamp', async (t) => {
  const root = fixture(t, { name: 'demo', channel: 'docker', repo: 'https://github.com/example/demo', current: '1.0.0', cadence: 'monthly' });
  const result = await runWatch({ root, all: true, log: quiet });
  assert.equal(result.exitCode, 1);
  assert.equal(state(root).components.demo.status, 'unverified');
  assert.equal(state(root).components.demo.last_success, 123);
});

test('successful lookup advances success time and records the precise source', async (t) => {
  const root = fixture(t);
  const before = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ tag_name: 'v1.2.3' });
  t.after(() => { globalThis.fetch = before; });
  const result = await runWatch({ root, all: true, exitZero: true, log: quiet });
  assert.equal(result.exitCode, 0);
  assert.equal(state(root).components.demo.status, 'ok');
  assert.ok(state(root).components.demo.last_success > 123);
  assert.match(state(root).components.demo.source, /api.github.com/);
});

test('npm failure keeps historical version unverified in document and out of upgrade plan; retry bypasses old TTL', async t => {
  const root = fixture(t, { name: 'demo', channel: 'npm', package: 'demo', current: '1.0.0', latest: '9.0.0', cadence: 'monthly' });
  const now = Math.floor(Date.now() / 1000);
  const original = state(root); original.registry_cache.demo = { ecosystem: 'npm', latest: '9.0.0', checked_at: now, last_success: now, status: 'ok' };
  writeFileSync(join(root, '.oss-watch-state.json'), JSON.stringify(original));
  failingFetch(t);
  const failed = await runWatch({ root, all: true, log: quiet }); assert.equal(failed.exitCode, 1);
  assert.equal(state(root).registry_cache.demo.last_success, now);
  assert.match(readFileSync(join(root, 'docs/OPEN_SOURCE_COMPONENTS.md'), 'utf8'), /9\.0\.0（历史记录；本次查询失败）/);
  assert.equal(failed.summary.componentUpdates, 0);
  const retried = await runWatch({ root, log: quiet }); assert.equal(retried.summary.npmQueried, 1);
});
test('PyPI mirror fallback records the official source; later double failure keeps the old success clock', async t => {
  const root = fixture(t, { name: 'demo', channel: 'pypi', package: 'demo', current: '1.0.0', cadence: 'monthly' });
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  globalThis.fetch = async url => String(url).includes('pypi.org') ? Response.json({ info: { version: '2.0.0' } }) : new Response('unavailable', { status: 503 });
  const passed = await runWatch({ root, all: true, exitZero: true, log: quiet }); assert.equal(passed.exitCode, 0);
  const success = state(root).registry_cache.demo.last_success;
  assert.match(state(root).registry_cache.demo.source, /^https:\/\/pypi\.org/);
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  assert.equal((await runWatch({ root, all: true, exitZero: true, log: quiet })).exitCode, 1);
  assert.equal(state(root).registry_cache.demo.last_success, success);
});
test('Docker real tags channel consumes all pages and refuses repeated or escaped next links', async () => {
  let calls = 0;
  const result = await dockerLatest('library/demo', { request: async () => ++calls === 1
    ? { results: [{ name: '1.0.0' }, { name: 'latest' }], next: '?page=2' }
    : { results: [{ name: '2.0.0' }, { name: '99.0.0', tag_status: 'inactive' }], next: null } });
  assert.equal(result.latest, '2.0.0'); assert.equal(calls, 2);
  await assert.rejects(dockerLatest('library/demo', { request: async () => ({ results: [], next: 'https://example.com/tags' }) }), /逃逸/);
  await assert.rejects(dockerLatest('library/demo', { request: async () => ({ results: [], next: '?page_size=100' }) }), /重复/);
});
test('GitHub tags fallback keeps prerelease tags out of the stable candidate set', async t => {
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  globalThis.fetch = async url => String(url).includes('/releases/latest')
    ? new Response('no release', { status: 404 })
    : Response.json([{ name: 'v2.0.0-rc.10' }, { name: 'v1.9.9' }, { name: 'v2.0.0-alpha.1' }]);
  const result = await githubLatest('https://github.com/example/demo');
  assert.equal(result.latest, 'v1.9.9');
  assert.match(result.source, /\/tags\?per_page=100$/u);
});
test('CI dry-run has no credential, branch, file or PR mutations', async t => {
  const root = fixture(t); const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  globalThis.fetch = async () => Response.json({ tag_name: 'v2.0.0' });
  const paths = ['oss-components.json', '.oss-watch-state.json', 'docs/OPEN_SOURCE_COMPONENTS.md', 'docs/oss-update-plan.md'];
  const content = paths.map(p => readFileSync(join(root, p), 'utf8'));
  const result = await runCi({ cwd: root, dryRun: true, log: quiet });
  assert.equal(result.dryRun, true); assert.equal(result.changed, false);
  assert.deepEqual(paths.map(p => readFileSync(join(root, p), 'utf8')), content);
});

for (const invalid of ['missing', 'malformed', 'non-array', 'empty']) test(`required registry ${invalid} fails before lookup and leaves facts unchanged`, async t => {
  const root = fixture(t);
  const registry = join(root, 'oss-components.json');
  if (invalid === 'missing') rmSync(registry);
  else writeFileSync(registry, invalid === 'malformed' ? '{broken' : JSON.stringify({ components: invalid === 'empty' ? [] : 'wrong' }));
  const paths = ['.oss-watch-state.json', 'docs/OPEN_SOURCE_COMPONENTS.md', 'docs/oss-update-plan.md'];
  const bytes = paths.map(path => readFileSync(join(root, path)));
  const beforeFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('No external request is allowed'); };
  t.after(() => { globalThis.fetch = beforeFetch; });
  await assert.rejects(runWatch({ root, all: true, exitZero: true, log: quiet }), /oss-components\.json|登记表/u);
  assert.equal(calls, 0);
  assert.deepEqual(paths.map(path => readFileSync(join(root, path))), bytes);
});
