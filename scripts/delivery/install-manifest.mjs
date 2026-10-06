/** Exact reviewed target package identity; sourceSha is the upstream origin, not the target installer commit. */
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git } from './git-state.mjs';
import { hash, SHA_RE, validRepoSlug } from './queue-model.mjs';

export const CORE_ASSETS = Object.freeze([
  ...['queue-model.mjs', 'queue-policy.mjs', 'queue-platform.mjs', 'queue-controller.mjs', 'queue-work.mjs', 'queue-release.mjs', 'queue-runner.mjs', 'git-state.mjs', 'review-plugin.mjs', 'model-gateway.mjs', 'install-config.mjs', 'install-manifest.mjs', 'release-source.mjs', 'queue.test.mjs', 'cnb.yml', 'bootstrap-cnb.yml', 'runtime/package.json', 'runtime/package-lock.json'].map(path => `scripts/delivery/${path}`),
  ...['protocol-rules.mjs', 'protocol-rules.test.mjs', 'verify-commit-msg.mjs', 'verify-lock-conflict.mjs'].map(path => `scripts/ci/${path}`),
  'scripts/tools/cnb-api.mjs', 'scripts/tools/task.mjs',
]);
export const INSTALL_MARKER = '.workloom-delivery-install.json';
export const TIGER_ALIASES = Object.freeze(['protocol-rules.mjs', 'protocol-rules.test.mjs', 'verify-commit-msg.mjs', 'verify-lock-conflict.mjs'].map(name => `governance/scripts/ci/${name}`));
const GENERATED_ASSETS = ['docs/AUTOMATIC-RD-DELIVERY.md', 'scripts/delivery/install-cnb.yml'];
const BOUND_ASSETS = ['scripts/ci/verify-delivery-admission.mjs', 'scripts/ci/verify-commit-msg.test.mjs', 'scripts/ci/verify-lock-conflict.test.mjs'];
const DIGEST_RE = /^[a-f0-9]{64}$/;

export function packageDigest(digests) {
  return hash(Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}

export function validateInstallationManifest(manifest, repo) {
  if (manifest?.repo !== repo) throw new Error('Installation manifest belongs to another repository');
  if (manifest.schemaVersion !== 2 || !validRepoSlug(repo) || !validRepoSlug(manifest.sourceRepo) || !SHA_RE.test(manifest.sourceSha ?? '') || manifest.isolationChanged !== false) throw new Error('Installation manifest identity/provenance is incomplete');
  const assets = manifest.assets;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) throw new Error('Installation manifest asset set is invalid');
  const permitted = new Set([...CORE_ASSETS, ...GENERATED_ASSETS, ...BOUND_ASSETS, ...(repo.endsWith('/workroom-tiger') ? TIGER_ALIASES : [])]);
  if (Object.entries(assets).some(([path, digest]) => !permitted.has(path) || !DIGEST_RE.test(digest))) throw new Error('Installation manifest has an unknown asset or invalid digest');
  if ([...CORE_ASSETS, ...GENERATED_ASSETS, ...(repo.endsWith('/workroom-tiger') ? TIGER_ALIASES : [])].some(path => !Object.hasOwn(assets, path))) throw new Error('Installation manifest lacks the complete execution closure');
  for (const optional of [BOUND_ASSETS, TIGER_ALIASES]) {
    if (optional.some(path => Object.hasOwn(assets, path)) && optional.some(path => !Object.hasOwn(assets, path))) throw new Error('Installation manifest has a partial target adapter');
  }
  if (manifest.packageHash !== packageDigest(assets)) throw new Error('Installation manifest package digest mismatch');
  return manifest;
}

export async function verifyInstallationManifest({ root, repo, sha, allowAbsent = false }) {
  if (!SHA_RE.test(sha ?? '')) throw new Error('Installation verification requires the exact reviewed commit');
  const base = resolve(root);
  let text;
  try { text = await readFile(join(base, INSTALL_MARKER), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' && allowAbsent) return null; throw error; }
  const manifest = validateInstallationManifest(JSON.parse(text), repo);
  for (const path of [INSTALL_MARKER, ...Object.keys(manifest.assets)]) {
    let current = base;
    for (const part of path.split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Installation manifest asset path contains a symlink');
    }
    const mode = await git(['ls-tree', sha, '--', path], { cwd: base });
    if (!mode.startsWith('100644 ') && !mode.startsWith('100755 ')) throw new Error(`Reviewed installation asset is missing/nonregular: ${path}`);
    const committed = await git(['show', `${sha}:${path}`], { cwd: base, raw: true });
    if (await readFile(join(base, path), 'utf8') !== committed) throw new Error(`Installation checkout differs from reviewed asset: ${path}`);
    if (path === INSTALL_MARKER ? committed !== text : hash(committed) !== manifest.assets[path]) throw new Error(`Reviewed installation asset digest mismatch: ${path}`);
  }
  return { upstreamRepo: manifest.sourceRepo, upstreamSourceSha: manifest.sourceSha, installerSourceSha: sha, packageHash: manifest.packageHash, assetCount: Object.keys(manifest.assets).length };
}
