/** Publish only UI bytes whose digest is already reviewed on main; tags are immutable. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitAuthenticationEnvironment, redactCredentials, requireToken } from './tools/cnb-api.mjs';

const SHA = /^[a-f0-9]{40}$/;
export function validateRegistration(manifest, metadata, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('UI_VERSION must be an exact x.y.z version');
  if (metadata?.version !== version || metadata?.asset !== `workloom-ui-${version}.tgz` || !Number.isSafeInteger(metadata?.size) || metadata.size <= 0) throw new Error('UI artifact metadata is incomplete or belongs to another version');
  const encoded = metadata.sha512?.replace(/^sha512-/, '');
  if (!encoded || !metadata.sha512.startsWith('sha512-') || Buffer.from(encoded, 'base64').length !== 64 || Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error('UI artifact requires an actual SHA-512 digest');
  if (manifest?.ui?.latestStableVersion !== version || manifest?.clientFoundation?.latestStableVersion !== version || manifest?.ui?.distribution?.integrityByVersion?.[version] !== metadata.sha512) throw new Error('UI integrity is not registered on reviewed main; submit the measured sha512 in a PR, satisfy its checks/review, merge it, then rerun release');
  return true;
}
function gitCommand(root, argv, { token, network = false } = {}) {
  const run = spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: network ? gitAuthenticationEnvironment(token) : process.env });
  if (run.error || run.status !== 0) throw new Error(redactCredentials(`UI release git ${argv[0]} failed: ${run.error?.code ?? run.stderr}`, token));
  return run.stdout.trim();
}
export function prepareUiRelease(root, { version, metadata, token, git = gitCommand } = {}) {
  root = resolve(root);
  const manifest = JSON.parse(readFileSync(resolve(root, 'sync/base-capabilities.json'), 'utf8'));
  validateRegistration(manifest, metadata, version);
  const head = git(root, ['rev-parse', 'HEAD'], { token });
  if (!SHA.test(head)) throw new Error('UI source requires a full Git commit');
  if (git(root, ['status', '--porcelain', '--untracked-files=no'], { token })) throw new Error('UI release source is dirty');
  const origin = git(root, ['remote', 'get-url', 'origin'], { token });
  if (!/^https:\/\/cnb\.cool\/workloom-ai\/workloom-im(?:\.git)?$/.test(origin)) throw new Error('UI release origin must be the credential-free CNB base repository');
  const tag = `ui-v${version}`; const ref = `refs/tags/${tag}`;
  const lines = git(root, ['ls-remote', 'origin', 'refs/heads/main', ref, ref + '^{}'], { token, network: true }).split('\n').filter(Boolean);
  const refs = new Map();
  for (const line of lines) {
    const [sha, name] = line.split(/\s+/);
    if (!SHA.test(sha) || !['refs/heads/main', ref, ref + '^{}'].includes(name) || refs.has(name)) throw new Error('Unexpected UI release reference response');
    refs.set(name, sha);
  }
  if (refs.get('refs/heads/main') !== head) throw new Error('Release checkout differs from current reviewed remote main');
  let releaseCommit = refs.get(ref + '^{}') ?? refs.get(ref);
  if (releaseCommit) {
    git(root, ['fetch', '--no-tags', 'origin', ref], { token, network: true });
    const registered = JSON.parse(git(root, ['show', `${releaseCommit}:sync/base-capabilities.json`], { token }));
    validateRegistration(registered, metadata, version);
  } else {
    releaseCommit = head;
    const local = git(root, ['for-each-ref', '--format=%(objectname)', ref], { token });
    if (local && local !== head) throw new Error('Existing local UI tag conflicts with reviewed main');
    if (!local) git(root, ['tag', tag, head], { token });
    git(root, ['push', 'origin', ref], { token, network: true });
    const confirmed = git(root, ['ls-remote', 'origin', ref], { token, network: true }).split(/\s+/);
    if (confirmed[0] !== head || confirmed[1] !== ref) throw new Error('UI tag push did not read back the reviewed commit');
  }
  return { tag, releaseCommit, integrity: metadata.sha512, registered: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: ui-release-registration.mjs METADATA_JSON OUTPUT_COMMIT_FILE');
    const result = prepareUiRelease(process.cwd(), { version: process.env.UI_VERSION, metadata: JSON.parse(readFileSync(process.argv[2], 'utf8')), token: requireToken() });
    writeFileSync(process.argv[3], result.releaseCommit + '\n');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(redactCredentials(error.message)); process.exitCode = 1; }
}
