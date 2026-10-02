import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareUiRelease, validateRegistration } from './ui-release-registration.mjs';
import { gitAuthenticationEnvironment } from './tools/cnb-api.mjs';
const head = 'a'.repeat(40); const older = 'b'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ui-registration-')); t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(join(root, 'sync'));
  const metadata = { version: '1.2.3', asset: 'workloom-ui-1.2.3.tgz', size: 10, sha512: 'sha512-' + Buffer.alloc(64, 7).toString('base64') };
  const manifest = { ui: { latestStableVersion: metadata.version, distribution: { integrityByVersion: { [metadata.version]: metadata.sha512 } } }, clientFoundation: { latestStableVersion: metadata.version } };
  writeFileSync(join(root, 'sync/base-capabilities.json'), JSON.stringify(manifest));
  return { root, metadata, manifest };
}
function transport({ manifest, remote = head, tagged, local = '', readback = head, dirty = '', origin = 'https://cnb.cool/workloom-ai/workloom-im', failure } = {}) {
  const calls = [];
  const git = (root, argv, context) => {
    calls.push({ argv, context }); if (failure?.(argv)) throw new Error('network denied');
    if (argv[0] === 'rev-parse') return head;
    if (argv[0] === 'status') return dirty;
    if (argv[0] === 'remote') return origin;
    if (argv[0] === 'for-each-ref') return local;
    if (argv[0] === 'show') return JSON.stringify(manifest);
    if (argv[0] === 'ls-remote') return argv.includes('refs/heads/main') ? `${remote}\trefs/heads/main${tagged ? '\n' + tagged + '\trefs/tags/ui-v1.2.3' : ''}` : `${readback}\trefs/tags/ui-v1.2.3`;
    return '';
  };
  return { git, calls };
}
test('unregistered digest or version rejects before Git, source writes, tags or publication', t => {
  const f = fixture(t); f.manifest.ui.distribution.integrityByVersion['1.2.3'] = 'wrong'; writeFileSync(join(f.root, 'sync/base-capabilities.json'), JSON.stringify(f.manifest));
  const stub = transport(f); assert.throws(() => prepareUiRelease(f.root, { ...f, version: '1.2.3', git: stub.git }), /PR/); assert.equal(stub.calls.length, 0);
  assert.throws(() => validateRegistration(f.manifest, f.metadata, 'latest'), /exact/);
});
test('new tag points to reviewed main and is read back; no direct main push or force exists', t => {
  const f = fixture(t); const stub = transport(f); const result = prepareUiRelease(f.root, { ...f, version: '1.2.3', git: stub.git });
  assert.equal(result.releaseCommit, head); assert.equal(stub.calls.filter(x => x.argv[0] === 'push').length, 1);
  assert.deepEqual(stub.calls.find(x => x.argv[0] === 'push').argv, ['push', 'origin', 'refs/tags/ui-v1.2.3']);
  assert.equal(stub.calls.some(x => x.argv.includes('--force') || x.argv.includes('-f') || x.argv.includes('HEAD:refs/heads/main')), false);
});
test('dirty source, foreign origin or remote main drift prevents tag mutation', t => {
  const f = fixture(t);
  for (const options of [{ dirty: ' M sync/base-capabilities.json' }, { origin: 'https://example.invalid/repo' }, { remote: older }]) {
    const stub = transport({ ...f, ...options }); assert.throws(() => prepareUiRelease(f.root, { ...f, version: '1.2.3', git: stub.git }));
    assert.equal(stub.calls.some(x => ['push', 'tag'].includes(x.argv[0])), false);
  }
});
test('existing immutable tag is reused only when its registration matches actual bytes', t => {
  const f = fixture(t); const stub = transport({ ...f, tagged: older });
  assert.equal(prepareUiRelease(f.root, { ...f, version: '1.2.3', git: stub.git }).releaseCommit, older);
  assert.equal(stub.calls.some(x => ['push', 'tag'].includes(x.argv[0])), false);
  const weak = structuredClone(f.manifest); weak.ui.distribution.integrityByVersion['1.2.3'] = 'different';
  const conflicting = transport({ manifest: weak, tagged: older }); assert.throws(() => prepareUiRelease(f.root, { ...f, version: '1.2.3', git: conflicting.git }), /PR/);
});
test('failed push or wrong readback remains failure and never reverts main', t => {
  const f = fixture(t);
  for (const options of [{ failure: argv => argv[0] === 'push' }, { readback: older }]) {
    const stub = transport({ ...f, ...options }); assert.throws(() => prepareUiRelease(f.root, { ...f, version: '1.2.3', git: stub.git }));
    assert.equal(stub.calls.some(x => ['revert', 'reset'].includes(x.argv[0]) || x.argv.includes('--delete')), false);
  }
});
test('retry reuses a matching local tag; conflicting local tag never pushes', t => {
  const f = fixture(t); const retry = transport({ ...f, local: head });
  prepareUiRelease(f.root, { ...f, version: '1.2.3', git: retry.git });
  assert.equal(retry.calls.some(x => x.argv[0] === 'tag'), false);
  const conflict = transport({ ...f, local: older });
  assert.throws(() => prepareUiRelease(f.root, { ...f, version: '1.2.3', git: conflict.git }), /local UI tag conflicts/);
  assert.equal(conflict.calls.some(x => x.argv[0] === 'push'), false);
});
test('Git credentials are transient scoped environment values, absent from argv/config files', () => {
  const token = ['test', 'only', 'secret'].join('-'); const env = gitAuthenticationEnvironment(token, {});
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper'); assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.https://cnb.cool/.extraHeader'); assert.match(env.GIT_CONFIG_VALUE_1, /^Authorization: Basic /);
});
