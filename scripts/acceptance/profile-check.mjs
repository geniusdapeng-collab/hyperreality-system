#!/usr/bin/env node
/** Raw profile and industry asset validation. 0 valid declaration, 1 invalid, 2 missing/unverified. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cliArgs, bundleDirOf, findRepoRoot } from './lib/profile.mjs';
import { resolveEnvironment } from './lib/target.mjs';
import { validateProfileContract } from './lib/profile-contract.mjs';
import { hashBytes, recordEvidenceRun, revisionOf } from '../delivery/evidence.mjs';

const startedAt = new Date().toISOString();
const repoRoot = findRepoRoot();
let outDir = join(repoRoot, 'outputs/acceptance/profile');
let artifactRoot = join(repoRoot, 'outputs/acceptance');
const report = { schema: 'workloom.profile-validation/v1', startedAt, mode: 'contract-validation', configurationStatus: 'missing', status: 'unverified', businessVerified: false, errors: [], warnings: [], assets: [], suiteCount: 0, taskCount: 0, networkCalls: 0, modelCalls: 0, databaseConnections: 0 };
const value = (flag, fallback) => {
  const argv = process.argv.slice(2); const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  if (argv.indexOf(flag, i + 1) >= 0 || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag} 需要一个且仅一个值`);
  return argv[i + 1];
};
function readAsset(path) {
  const rel = relative(repoRoot, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('配置资产必须位于本仓目录内');
  let part = repoRoot;
  for (const segment of rel.split(sep)) { part = join(part, segment); if (lstatSync(part).isSymbolicLink()) throw new Error(`配置资产不得使用 symlink：${rel}`); }
  if (!realpathSync(path).startsWith(`${realpathSync(repoRoot)}${sep}`)) throw new Error('配置资产 realpath 越界');
  const bytes = readFileSync(path);
  report.assets.push({ path: rel.split(sep).join('/'), sha256: hashBytes(bytes) });
  return bytes.toString('utf8');
}
async function main() {
  const args = cliArgs();
  const requestedOut = resolve(args.outDir ?? outDir);
  const requestedRoot = resolve(value('--evidence-root', dirname(requestedOut)));
  const rel = relative(requestedRoot, requestedOut);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('--out 必须位于 --evidence-root 内的独立子目录');
  outDir = requestedOut; artifactRoot = requestedRoot;
  const path = args.profilePath ? resolve(repoRoot, args.profilePath) : join(repoRoot, 'acceptance/profile.json');
  report.profilePath = relative(repoRoot, path).split(sep).join('/');
  report.revision = revisionOf(repoRoot);
  if (!existsSync(path)) { report.errors.push('本仓显式 profile 缺失；未使用默认配置或生成模板'); return 2; }
  const raw = JSON.parse(readAsset(path));
  const manifest = JSON.parse(readAsset(join(repoRoot, 'product.manifest.json')));
  const environment = resolveEnvironment(raw, { flag: args.environmentKind, allowProdWrites: args.has('--allow-prod-writes') });
  report.environmentKind = environment.kind; report.effectiveAllowWrites = environment.allowWrites;
  let YAML;
  try { YAML = (await import('yaml')).default; }
  catch { report.configurationStatus = 'unverified'; report.errors.push('执行器 yaml 依赖未就绪；配置与结果契约未验证'); return 2; }
  const bundle = bundleDirOf(repoRoot, raw.primaryBundle);
  const presetDir = join(bundle, 'presets'); const presetKeys = new Set();
  if (existsSync(presetDir)) for (const name of readdirSync(presetDir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const preset = YAML.parse(readAsset(join(presetDir, name)));
    if (typeof preset?.preset_key === 'string' && preset.preset_key.trim()) {
      if (presetKeys.has(preset.preset_key)) report.errors.push(`重复 preset_key：${preset.preset_key}`);
      presetKeys.add(preset.preset_key);
    } else report.errors.push(`preset 缺少 preset_key：${name}`);
  }
  const suiteDir = join(repoRoot, 'acceptance/outcomes'); const suiteEntries = [];
  if (existsSync(suiteDir)) for (const name of readdirSync(suiteDir).filter((name) => /\.ya?ml$/.test(name) && !/\.example\./.test(name)).sort()) {
    const path = join(suiteDir, name); const relativePath = relative(repoRoot, path).split(sep).join('/');
    try { suiteEntries.push({ path: relativePath, suite: YAML.parse(readAsset(path)) }); }
    catch (error) { suiteEntries.push({ path: relativePath, error: error.name }); }
  }
  const instanceSlug = basename(repoRoot) === 'governance' ? basename(dirname(repoRoot)) : basename(repoRoot);
  const result = validateProfileContract(raw, { manifest, bundleExists: existsSync(bundle), presetKeys, suiteEntries, instanceSlug });
  report.errors.push(...result.errors); report.warnings.push(...result.warnings);
  report.suiteCount = result.suiteCount; report.taskCount = result.taskCount;
  report.configurationStatus = report.errors.length ? 'invalid' : 'valid';
  report.status = report.errors.length ? 'fail' : 'unverified';
  return report.errors.length ? 1 : 0;
}
let exitCode = 2;
try { exitCode = await main(); }
catch (error) { report.errors.push(error.message); report.configurationStatus = 'invalid'; report.status = 'fail'; exitCode = 1; }
report.finishedAt = new Date().toISOString();
try {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'profile-validation.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  const outputPath = relative(artifactRoot, path).split(sep).join('/');
  recordEvidenceRun({ repoRoot, artifactRoot, runId: `profile-${process.pid}-${Date.now()}`, command: [process.execPath, ...process.argv.slice(1)].map((arg) => JSON.stringify(arg)).join(' '), exec: { file: process.execPath, args: process.argv.slice(1) }, actor: 'acceptance:profile-check', role: 'acceptance', exitCode, startedAt, finishedAt: report.finishedAt, outputPaths: [outputPath], subject: { mode: report.mode, configurationStatus: report.configurationStatus } });
} catch (error) { console.error(`[acceptance:profile] 证据未绑定：${error.message}`); exitCode = 1; }
console.log(`[acceptance:profile] configuration=${report.configurationStatus} business=${report.status} suites=${report.suiteCount} tasks=${report.taskCount}`);
for (const error of report.errors) console.error(`  ✗ ${error}`);
for (const warning of report.warnings) console.log(`  说明：${warning}`);
process.exitCode = exitCode;
