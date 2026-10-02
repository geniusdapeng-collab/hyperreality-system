import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { capabilityStatus } from './capability-status.mjs';
import { recordEvidenceRun } from './delivery/evidence.mjs';

function fixture(t, patch = {}, role = 'acceptance') {
  const root = mkdtempSync(join(tmpdir(), 'capability-proof-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.test']); git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, 'source.txt'), 'source\n');
  writeFileSync(join(root, '.gitignore'), 'evidence/\nruns/\nevidence-index.json\n');
  git(['add', 'source.txt', '.gitignore']); git(['commit', '-qm', 'source']);
  const commit = git(['rev-parse', 'HEAD']); mkdirSync(join(root, 'evidence'));
  const value = { capabilityId: 'test:cap', commit, exitCode: 0, callable: true, verified: true, verifiedBy: 'independent', fixedBy: 'repair', environment: 'local-preview', completedAt: new Date().toISOString(), ...patch };
  const startedAt = new Date().toISOString();
  const execution = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);process.exit(Number(process.argv[2]))', JSON.stringify(value), String(value.exitCode)], { encoding: 'utf8' });
  writeFileSync(join(root, 'evidence/result.json'), execution.stdout);
  const run = recordEvidenceRun({ repoRoot: root, artifactRoot: root, runId: 'cap-result', command: 'capability fixture subprocess', actor: 'independent', role, exitCode: execution.status, startedAt, outputPaths: ['evidence/result.json'], subject: { capabilityId: 'test:cap' } });
  return { root, id: 'test:cap', discoverable: true, currentCommit: commit, attestation: { evidence: run.artifacts[0], run: run.runRef } };
}
test('源文件可发现不等于可调用或已验证', () => {
  const out = capabilityStatus({ discoverable: true });
  assert.equal(out.discoverable, true); assert.equal(out.callable, 'unverified'); assert.equal(out.verified, 'unverified');
});
test('真实子进程成功且提交/散列/独立角色一致才能升级', t => {
  const options = fixture(t);
  assert.equal(capabilityStatus(options).verified, true);
  for (const change of [
    { currentCommit: 'b'.repeat(40) },
    { attestation: { ...options.attestation, run: null } },
    { attestation: { ...options.attestation, evidence: { ...options.attestation.evidence, sha256: '0'.repeat(64) } } },
    { attestation: { ...options.attestation, evidence: { ...options.attestation.evidence, path: '../escape.json' } } },
  ]) assert.equal(capabilityStatus({ ...options, ...change }).verified, 'unverified');
});
for (const [name, patch, role] of [
  ['failed', { exitCode: 1 }], ['stale', { completedAt: '2000-01-01T00:00:00Z' }],
  ['future', { completedAt: '2099-01-01T00:00:00Z' }], ['wrong-id', { capabilityId: 'other' }],
  ['uncallable', { callable: false }], ['self-verify', { fixedBy: 'independent' }], ['repair-role', {}, 'repair'],
]) test(`${name} 不能升级为已验证能力`, t => { assert.equal(capabilityStatus(fixture(t, patch, role)).verified, 'unverified'); });
test('符号链接证据拒绝，即便内容与散列相同', t => {
  const options = fixture(t); symlinkSync('result.json', join(options.root, 'evidence/link.json'));
  options.attestation.evidence.path = 'evidence/link.json';
  assert.equal(capabilityStatus(options).verified, 'unverified');
});
test('手写成功 JSON、缺证据与未发现入口不能升级', t => {
  const options = fixture(t); delete options.attestation.run;
  assert.equal(capabilityStatus(options).callable, 'unverified');
  assert.equal(capabilityStatus({ discoverable: false, attestation: { verified: true } }).verified, 'unverified');
});
