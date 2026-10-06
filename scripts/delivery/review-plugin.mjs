#!/usr/bin/env node
/** Pure historical receipt readers remain available; all platform AI execution is disabled. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHA_RE, validateReview, validateReviewScope } from './queue-model.mjs';
import { BASE_POLICY, reviewRules } from './queue-policy.mjs';

const SELF = fileURLToPath(import.meta.url);
const BATCH_SIZE = BASE_POLICY.reviewBatchSize;

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

export async function runReview() {
  throw new Error('Platform AI is disabled. The current Codex session must review and test the exact change before handoff.');
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  console.error('Platform AI is disabled; no model, SDK, subprocess, or platform approval was invoked. Use queue-runner handoff with a Codex review receipt.');
  process.exitCode = 1;
}
