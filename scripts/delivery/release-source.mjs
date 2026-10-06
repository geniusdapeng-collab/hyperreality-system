#!/usr/bin/env node
/** Every publisher phase proves its checkout is the frozen reviewed commit, even after main advances. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git-state.mjs';
import { SHA_RE } from './queue-model.mjs';
import { requireToken, redactCredentials } from '../tools/cnb-api.mjs';
export async function verifyReleaseSource({ root = process.cwd(), env = process.env, run = git } = {}) {
  const expected = env.RELEASE_EXPECTED_SHA;
  const repo = env.CNB_REPO_SLUG;
  if (!SHA_RE.test(expected ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('Release source/repository identity required');
  const head = await run(['rev-parse', 'HEAD'], { cwd: root });
  if (head !== expected) throw new Error('Release checkout differs from frozen reviewed source');
  const remote = `https://cnb.cool/${repo}.git`;
  const token = env.CNB_TOKEN ?? requireToken();
  await run(['fetch', '--quiet', '--no-tags', remote, 'refs/heads/main'], { cwd: root, remote, token });
  await run(['merge-base', '--is-ancestor', expected, 'FETCH_HEAD'], { cwd: root });
  return { repo, sha: expected, integratedAncestor: true };
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) verifyReleaseSource().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(redactCredentials(error.message)); process.exitCode = 1; });
