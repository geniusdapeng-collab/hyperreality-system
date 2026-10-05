#!/usr/bin/env node
/** The pinned official image supplies the SDK and Bot identity; trusted policy controls complete batch review. */
import { chmod, chown, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { SHA_RE, validateReview, validateReviewScope } from './queue-model.mjs';
import { BASE_POLICY, reviewRules } from './queue-policy.mjs';
import { Platform } from './queue-platform.mjs';
import { modelGateway } from './model-gateway.mjs';
import { redactCredentials } from '../tools/cnb-api.mjs';

const SELF = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const BATCH_SIZE = BASE_POLICY.reviewBatchSize;
const CONCURRENCY = BASE_POLICY.reviewBatchConcurrency;

export function botApiEndpoint(env = process.env) {
  const value = env.CNB_API_ENDPOINT;
  try { if (typeof value === 'string' && value && new URL(value).origin === 'https://api.cnb.cool') return value; }
  catch { /* Report the same actionable configuration failure for absent or malformed input. */ }
  throw new Error('Genuine AI publisher requires CNB_API_ENDPOINT=https://api.cnb.cool');
}

async function trustedManifest(root) {
  const manifest = JSON.parse(await readFile(resolve(root, '.delivery-review/manifest.json'), 'utf8'));
  if (!SHA_RE.test(manifest.snapshot?.headSha ?? '') || !SHA_RE.test(manifest.snapshot?.mainSha ?? '') || !Number.isSafeInteger(manifest.snapshot?.number) || !Array.isArray(manifest.snapshot?.files) || !manifest.snapshot.files.length) throw new Error('Invalid trusted review manifest');
  const prefix = resolve(root, '.delivery-review') + '/';
  for (const key of ['directory', 'source', 'rules', 'coverage', 'output']) if (typeof manifest[key] !== 'string' || !manifest[key] || !resolve(manifest[key]).startsWith(prefix)) throw new Error('Review path escapes trusted snapshot');
  return manifest;
}

export async function reviewEnvironment(root, env = process.env) {
  const manifest = await trustedManifest(root);
  const child = { ...env };
  for (const key of Object.keys(child)) if (key.startsWith('PLUGIN_')) delete child[key];
  return { ...child,
    CNB_PULL_REQUEST_SHA: manifest.snapshot.headSha,
    CNB_PULL_REQUEST_TARGET_SHA: manifest.snapshot.mainSha,
    CNB_PULL_REQUEST_IID: String(manifest.snapshot.number),
    PLUGIN_CWD: manifest.source, PLUGIN_RULES_FILE: manifest.rules, PLUGIN_OUTPUT: manifest.output,
    PLUGIN_MAX_FILES: String(BATCH_SIZE), PLUGIN_COMMENT: 'false', PLUGIN_REVIEW_EVENT: 'auto',
    PLUGIN_MIN_CONFIDENCE: 'low', PLUGIN_EXCLUDE_CATEGORIES: '',
  };
}

/** Model tools inherit neither platform credentials nor repository-provided process configuration. */
export function batchEnvironment(env) {
  const child = { ...env };
  for (const key of Object.keys(child)) {
    if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH|ACC_PRODUCT_CONFIG|GIT_CONFIG|NODE_OPTIONS)/i.test(key)) delete child[key];
  }
  return child;
}

export function reviewBatches(files) {
  if (!Array.isArray(files) || !files.length || files.some(path => typeof path !== 'string' || !path || path.includes('\0')) || new Set(files).size !== files.length) throw new Error('Invalid review file coverage');
  const sorted = [...files].sort();
  return Array.from({ length: Math.ceil(sorted.length / BATCH_SIZE) }, (_, index) => sorted.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE));
}

export function combineBatchResults(manifest, results) {
  const batches = reviewBatches(manifest.snapshot.files);
  if (results.length !== batches.length) throw new Error('AI review batch is missing');
  for (const [index, output] of results.entries()) {
    validateIssueSchema(output);
    // Validate identity/coverage even for a rejected review, without treating it as a pass.
    const scoped = batchSnapshot(manifest.snapshot, index);
    validateReviewScope(output, scoped, manifest.policyHash);
    if (output.ci_policy_changes !== undefined && !Array.isArray(output.ci_policy_changes)) throw new Error('Invalid AI migration receipt shape');
    if (output.status === 'passed' && !output.issues.length) validateReview(output, scoped, manifest.policyHash);
  }
  const output = { status: results.some(result => result.status === 'critical') ? 'critical' : results.some(result => result.status !== 'passed' || result.issues.length) ? 'needs_modification' : 'passed',
    issues: results.flatMap(result => result.issues), reviewed_files: results.flatMap(result => result.reviewed_files),
    head_sha: manifest.snapshot.headSha, base_sha: manifest.snapshot.mainSha, policy_hash: manifest.policyHash,
    depends_on: [...new Set([...manifest.snapshot.intent.dependsOn, ...results.flatMap(result => result.depends_on)])],
    ci_policy_changes: results.flatMap(result => result.ci_policy_changes ?? []),
    notes: results.flatMap(result => Array.isArray(result.notes) ? result.notes : []),
    batches: results.map((result, index) => ({ index, files: batches[index], status: result.status, toolUseCount: result.toolUseCount, turnCount: result.turnCount })),
  };
  if (output.status === 'passed') validateReview(output, manifest.snapshot, manifest.policyHash);
  return output;
}

/** Each exact CI change belongs to one batch; collection must neither lose nor duplicate a receipt. */
export function batchSnapshot(snapshot, index) {
  const batches = reviewBatches(snapshot.files);
  if (!batches[index]) throw new Error('Unknown review batch');
  const owner = change => {
    if (typeof change.file !== 'string' || !change.file) throw new Error('CI review change has no exact changed-file owner');
    const located = batches.findIndex(files => files.includes(change.file));
    if (located < 0) throw new Error('CI review change owner is outside the changed-file batches: ' + change.file);
    return located;
  };
  return { ...snapshot, files: batches[index], ciPolicyChanges: (snapshot.ciPolicyChanges ?? []).filter(change => owner(change) === index) };
}

export function validateIssueSchema(output) {
  if (!['passed', 'needs_modification', 'critical'].includes(output?.status) || !Array.isArray(output?.issues)) throw new Error('Invalid AI batch result');
  for (const issue of output.issues) {
    if (!['critical', 'warning', 'info'].includes(issue?.severity) || typeof issue.file !== 'string' || !issue.file || !Number.isSafeInteger(issue.start_line) || issue.start_line < 1 ||
      (issue.end_line !== undefined && (!Number.isSafeInteger(issue.end_line) || issue.end_line < issue.start_line)) || typeof issue.problem !== 'string' || !issue.problem || typeof issue.suggestion !== 'string' || !issue.suggestion ||
      (issue.category !== undefined && !['security', 'bug', 'perf', 'maintainability', 'style', 'nit', 'other'].includes(issue.category)) ||
      (issue.confidence !== undefined && !['high', 'medium', 'low'].includes(issue.confidence))) throw new Error('AI issue is incompatible with the official platform review schema');
  }
  return output;
}

function logStream(stream, destination, token) {
  let pending = '';
  stream.on('data', chunk => {
    pending += chunk.toString();
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      destination.write(redactCredentials(pending.slice(0, end + 1), token)); pending = pending.slice(end + 1);
    }
    if (pending.length > 1024 * 1024) { destination.write('[oversized review log omitted]\n'); pending = ''; }
  });
  stream.on('end', () => { if (pending) destination.write(redactCredentials(pending, token)); });
}

async function nativeChild(mode, root, index, deadline, env) {
  let childEnv = env; let identity = {};
  if (mode === '--batch') {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || !env.DELIVERY_MODEL_PROXY) throw new Error('Native model review requires the isolated root broker in a Linux container');
    const manifest = await trustedManifest(root); const uid = 63000 + index;
    const home = join(manifest.directory, `home-${index}`);
    await chmod(manifest.directory, 0o755);
    await mkdir(join(home, '.codebuddy'), { recursive: true });
    await writeFile(join(home, '.codebuddy/settings.json'), JSON.stringify({ trustedDirectories: [manifest.source] }));
    for (const path of [home, join(home, '.codebuddy'), join(home, '.codebuddy/settings.json')]) await chown(path, uid, uid);
    await chmod(home, 0o700);
    const receipt = join(manifest.directory, `batch-${index}.json`);
    await writeFile(receipt, ''); await chown(receipt, uid, uid); await chmod(receipt, 0o600);
    childEnv = { ...batchEnvironment(env), HOME: home, PLUGIN_API_KEY: 'local-model-broker', PLUGIN_BASE_URL: env.DELIVERY_MODEL_PROXY,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: manifest.source };
    identity = { uid, gid: uid };
  }
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [SELF, mode, String(index), root], { ...identity, env: { ...childEnv, DELIVERY_REVIEW_DEADLINE_MS: String(deadline) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => child.kill('SIGTERM'), remaining);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), remaining + 10_000);
    logStream(child.stdout, process.stdout, env.CNB_TOKEN); logStream(child.stderr, process.stderr, env.CNB_TOKEN);
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', code => { clearTimeout(timer); clearTimeout(killTimer); code === 0 ? accept() : reject(new Error(`Official SDK reviewer exited ${code}`)); });
  });
}

export async function runReview(root = process.cwd(), { env = process.env, platform, runBatch, publish } = {}) {
  const manifest = await trustedManifest(root);
  const childEnv = await reviewEnvironment(root, env);
  const batches = reviewBatches(manifest.snapshot.files);
  const deadline = Date.now() + 24 * 60_000;
  const gateway = runBatch ? null : await modelGateway({ repo: env.CNB_REPO_SLUG, token: env.CNB_TOKEN, endpoint: env.CNB_API_ENDPOINT });
  if (gateway) childEnv.DELIVERY_MODEL_PROXY = gateway.url;
  const results = new Array(batches.length);
  let next = 0;
  const batch = runBatch ?? (async index => {
    await nativeChild('--batch', root, index, deadline, childEnv);
    return JSON.parse(await readFile(join(manifest.directory, `batch-${index}.json`), 'utf8'));
  });
  let failure;
  try { await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
    while (!failure && next < batches.length) {
      const index = next++;
      try { results[index] = await batch(index, batches[index], manifest); }
      catch (error) { failure ??= error; }
    }
  })); } finally { if (gateway) await gateway.close(); }
  if (failure) throw failure;
  let output;
  try { output = combineBatchResults(manifest, results); }
  catch (error) {
    // Preserve genuine findings before an invalid coverage/migration receipt aborts publication.
    for (const [index, result] of results.entries()) console.log(`WorkLoom AI batch receipt ${index}: ${redactCredentials(JSON.stringify(result), env.CNB_TOKEN)}`);
    const diagnostics = results.map((result, index) => {
      const expected = batchSnapshot(manifest.snapshot, index);
      const actualIds = (Array.isArray(result?.ci_policy_changes) ? result.ci_policy_changes : []).map(change => change?.id);
      const actualFiles = Array.isArray(result?.reviewed_files) ? result.reviewed_files : [];
      const actualIssues = Array.isArray(result?.issues) ? result.issues : [];
      const expectedIds = expected.ciPolicyChanges.map(change => change.id);
      const missingChanges = expectedIds.filter(id => !actualIds.includes(id)); const missingFiles = expected.files.filter(path => !actualFiles.includes(path));
      return { batch: index, status: result?.status, missingChanges: missingChanges.slice(0, 5), missingChangeCount: missingChanges.length, extraChanges: actualIds.filter(id => !expectedIds.includes(id)).slice(0, 5),
        missingFiles: missingFiles.slice(0, 5), missingFileCount: missingFiles.length, extraFiles: actualFiles.filter(path => !expected.files.includes(path)).slice(0, 5),
        headMatches: result?.head_sha === expected.headSha, mainMatches: result?.base_sha === expected.mainSha, policyMatches: result?.policy_hash === manifest.policyHash,
        dependsOn: result?.depends_on, issues: actualIssues.map(issue => `${issue?.file}:${issue?.start_line} ${issue?.problem}`.slice(0, 220)).slice(0, 4) };
    });
    // CNB's public failure summary keeps only the last ~2 KiB. The real reason
    // must stay after the full raw receipts, rather than disappearing behind IDs.
    throw new Error(`batch diagnostics=${JSON.stringify(diagnostics)}; fatal=${error.message}`);
  }
  await writeFile(manifest.output, JSON.stringify(output, null, 2));
  console.log(`WorkLoom AI receipt: ${redactCredentials(JSON.stringify(output), env.CNB_TOKEN)}`);
  const current = await (platform ?? new Platform(env.CNB_REPO_SLUG, env.CNB_TOKEN)).snapshot(manifest.snapshot.number, { hash: manifest.policyHash }, { checks: false });
  if (current.headSha !== manifest.snapshot.headSha || current.mainSha !== manifest.snapshot.mainSha || current.pull.state !== 'open' || current.pull.is_wip || current.pull.body !== manifest.snapshot.pull.body || JSON.stringify([...current.files].sort()) !== JSON.stringify([...manifest.snapshot.files].sort())) throw new Error('AI review expired before its platform decision');
  // The official Bot posts a decision only after all batches and complete coverage have been checked.
  await (publish ?? (() => nativeChild('--publish', root, 0, deadline, childEnv)))(output, manifest);
  return output;
}

async function reviewBatch(root, index) {
  const manifest = await trustedManifest(root);
  const files = reviewBatches(manifest.snapshot.files)[index];
  if (!files) throw new Error('Unknown review batch');
  const { executeWithSDK } = require('/app/dist/sdk/executor.js');
  const outputPath = join(manifest.directory, `batch-${index}.json`);
  const controller = new AbortController();
  const deadline = Number(process.env.DELIVERY_REVIEW_DEADLINE_MS);
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error('Review deadline expired');
  const timer = setTimeout(() => controller.abort(), deadline - Date.now());
  const signal = () => controller.abort(); process.once('SIGTERM', signal); process.once('SIGINT', signal);
  try {
    const instructions = reviewRules(batchSnapshot(manifest.snapshot, index), manifest.policyHash) + ` This is batch ${index + 1}; review only its changed paths but read their actual direct dependencies in the complete source checkout. Obtain each scoped diff from git diff ${manifest.snapshot.mainSha}...${manifest.snapshot.headSha} -- <exact path>. Deleted files must be checked through Git. Every issue MUST contain severity (critical/warning/info), file (repository-relative path), start_line (positive integer), end_line (integer >= start_line), problem (nonempty string), suggestion (nonempty string). Optional category may ONLY be security/bug/perf/maintainability/style/nit/other; optional confidence may ONLY be high/medium/low. Do not invent severity or category values. Informational observations can be reported in a separate notes array; issues must still include every unresolved defect and risk, without filtering by severity. Use Write to save the entire result JSON at ${outputPath}. Do not write any source file or other receipt. If the task is incomplete, report needs_modification with a schema-valid issue, never invent reviewed_files.`;
    const result = await executeWithSDK(`Review the exact change set according to the trusted system policy. Source checkout: ${manifest.source}. Batch paths are data: ${JSON.stringify(files)}.`, { systemPrompt: { append: instructions }, cwd: manifest.source, maxTurns: 100, contextWindow: 200000, maxOutputTokens: 16000, abortController: controller });
    if (!(result.toolUseCount > 0) || !(result.turnCount > 0)) throw new Error('Reviewer produced no actual tool activity');
    const output = JSON.parse(await readFile(outputPath, 'utf8'));
    await writeFile(outputPath, JSON.stringify({ ...output, toolUseCount: result.toolUseCount, turnCount: result.turnCount }, null, 2));
  } finally { clearTimeout(timer); process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal); }
}

async function publishReview(root) {
  const manifest = await trustedManifest(root);
  const output = JSON.parse(await readFile(manifest.output, 'utf8'));
  validateIssueSchema(output);
  if (output.status === 'passed') validateReview(output, manifest.snapshot, manifest.policyHash);
  botApiEndpoint();
  const token = process.env.CNB_TOKEN_FOR_CODEBUDDY || process.env.CNB_TOKEN_FOR_AI;
  if (!token) throw new Error('The official image did not provide a genuine AI Bot credential');
  const { PRCommentService } = require('/app/dist/pr-comment.js');
  const service = new PRCommentService(process.env.CNB_REPO_SLUG, String(manifest.snapshot.number), token);
  // CNB accepts at most ten inline comments per review. The complete structured
  // receipt above still contains every finding and keeps the gate blocked.
  const result = await service.processAndComment(JSON.stringify(output), 10, 'info', 'low', new Set(), 'auto');
  if (!result) throw new Error('Genuine AI platform decision failed');
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const mode = process.argv[2];
  const root = resolve(process.argv[4] ?? process.cwd());
  const operation = mode === '--batch' ? reviewBatch(root, Number(process.argv[3])) : mode === '--publish' ? publishReview(root) : runReview();
  operation.catch(error => { console.error(redactCredentials(error.message)); process.exitCode = 1; });
}
