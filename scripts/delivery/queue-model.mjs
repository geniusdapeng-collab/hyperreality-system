/** Durable delivery rules. No platform calls or credentials belong in this module. */
import { createHash, randomUUID } from 'node:crypto';

export const STATE_BRANCH = 'automation/delivery-state';
export const SHA_RE = /^[a-f0-9]{40,64}$/;
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const branchName = ref => String(ref ?? '').replace(/^refs\/heads\//, '');
export const validRepoSlug = repo => typeof repo === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repo) && repo.split('/').every(part => part !== '.' && part !== '..');
export const STATES = new Set(['developing', 'waiting_dependency', 'waiting_ci', 'waiting_review', 'ready', 'aligning', 'merging', 'integrated', 'release_pending', 'releasing', 'delivered', 'parked', 'closed']);

export function emptyState(repo) {
  return { schemaVersion: 1, repo, revision: 0, tasks: {}, leases: {}, releases: {}, events: [] };
}

export function validateState(state, repo) {
  if (state?.schemaVersion !== 1 || state.repo !== repo || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('Invalid delivery state identity/revision');
  for (const key of ['tasks', 'leases', 'releases']) if (!state[key] || Array.isArray(state[key]) || typeof state[key] !== 'object') throw new Error(`Invalid state ${key}`);
  if (!Array.isArray(state.events) || state.events.length !== state.revision) throw new Error('Delivery event history is incomplete');
  let previous = null;
  state.events.forEach((event, index) => {
    const { digest, ...body } = event;
    if (event.sequence !== index + 1 || event.previous !== previous || digest !== hash(body)) throw new Error('Delivery event chain is invalid');
    previous = digest;
  });
  for (const task of Object.values(state.tasks)) if (!STATES.has(task.status)) throw new Error('Unknown task state');
  return state;
}

export function appendEvent(state, kind, data, now = Date.now()) {
  const event = { sequence: state.revision + 1, at: new Date(now).toISOString(), kind, data: structuredClone(data), previous: state.events.at(-1)?.digest ?? null };
  state.events.push({ ...event, digest: hash(event) });
  state.revision++;
}

export function updateTask(state, number, patch, now = Date.now()) {
  const key = String(number);
  if (!/^\d+$/.test(key) || Number(key) <= 0) throw new Error('Invalid PR number');
  if (patch.status && !STATES.has(patch.status)) throw new Error('Unknown task status');
  const old = state.tasks[key] ?? { number: Number(number), status: 'developing', firstSeen: now, attempts: {} };
  state.tasks[key] = { ...old, ...structuredClone(patch), updatedAt: now };
  appendEvent(state, 'task', { number: Number(number), patch }, now);
  return state.tasks[key];
}

export function leaseOperation(state, { action, scopes, owner, generation, ttlMs = 15 * 60_000 }, now = Date.now()) {
  if (!owner || typeof owner !== 'string' || owner.length > 200 || !Array.isArray(scopes) || !scopes.length || scopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 200)) throw new Error('Lease owner/scopes required');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 60_000) throw new Error('Lease TTL must be between 1 and 30 minutes');
  const keys = [...new Set(scopes)].sort();
  if (!['acquire', 'renew', 'release'].includes(action)) throw new Error('Invalid lease action');
  for (const key of keys) {
    const old = state.leases[key];
    if (action === 'acquire') {
      if (old?.owner && old.expiresAt > now) throw new Error(`Lease busy: ${key}`);
    } else if (!old || old.owner !== owner || old.generation !== generation?.[key] || old.expiresAt <= now) {
      throw new Error(`Lease owner/generation expired: ${key}`);
    }
  }
  const result = {};
  for (const key of keys) {
    const old = state.leases[key];
    const value = action === 'acquire'
      ? { owner, generation: (old?.generation ?? 0) + 1, acquiredAt: now, expiresAt: now + ttlMs }
      : { ...old, owner: action === 'release' ? null : owner, expiresAt: action === 'release' ? now : now + ttlMs };
    state.leases[key] = value;
    result[key] = value.generation;
  }
  appendEvent(state, `lease_${action}`, { scopes: keys, owner, generation: result }, now);
  return result;
}

export function sensitiveScopes(files) {
  const result = new Set();
  for (const file of files) {
    const path = String(file).replace(/^\.\//, '');
    if (/^sync\//.test(path)) result.add('sync');
    if (/^(protocol\/|AGENTS(?:\.repo)?\.md$|docs\/DEVELOPMENT-PROTOCOL\.md$|scripts\/(ci|tools|delivery)\/|\.cnb(?:\.yml|\/))/.test(path)) result.add('protocol');
    if (/(^|\/)migrations\//.test(path)) result.add('migrations');
    if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)) result.add('dependencies');
  }
  return [...result].sort();
}

/** Mandatory sensitive-source admission is automatic; its released generation is historical proof, not a CI-held lock. */
export function admitSource(state, { number, headSha, mainSha, files }, now = Date.now()) {
  if (!Number.isSafeInteger(number) || number <= 0 || !SHA_RE.test(headSha ?? '') || !SHA_RE.test(mainSha ?? '') || !Array.isArray(files) || files.some(path => typeof path !== 'string' || !path) || new Set(files).size !== files.length) throw new Error('Source admission identity/files are invalid');
  const scopes = sensitiveScopes(files); const owner = `admission/pr-${number}`;
  const generation = scopes.length ? leaseOperation(state, { action: 'acquire', owner, scopes }, now) : {};
  if (scopes.length) leaseOperation(state, { action: 'release', owner, scopes, generation }, now);
  const admission = { number, headSha, mainSha, filesHash: hash([...files].sort()), scopes, owner, generation };
  appendEvent(state, 'source_admitted', admission, now);
  updateTask(state, number, { admission }, now);
  return admission;
}

export function admissionErrors(state, { number, headSha, mainSha, files }) {
  const scopes = sensitiveScopes(files);
  if (!scopes.length) return [];
  const admission = state.tasks[String(number)]?.admission;
  const expected = { number: Number(number), headSha, mainSha, filesHash: hash([...files].sort()), scopes, owner: `admission/pr-${Number(number)}` };
  if (!admission || Object.entries(expected).some(([key, value]) => JSON.stringify(admission[key]) !== JSON.stringify(value))) return ['Sensitive source lacks exact trusted admission'];
  const recorded = state.events.findLast(event => event.kind === 'source_admitted' && hash(event.data) === hash(admission));
  if (!recorded) return ['Source admission has no append-only receipt'];
  for (const scope of scopes) {
    const generation = admission.generation?.[scope];
    if (!Number.isSafeInteger(generation) || generation <= 0) return ['Source admission has no positive lease generation'];
    const acquired = state.events.findLast(event => event.sequence < recorded.sequence && event.kind === 'lease_acquire' && event.data.owner === expected.owner && event.data.generation?.[scope] === generation && event.data.scopes.includes(scope));
    const released = state.events.findLast(event => event.sequence < recorded.sequence && event.kind === 'lease_release' && event.data.owner === expected.owner && event.data.generation?.[scope] === generation && event.data.scopes.includes(scope));
    if (!acquired || !released || acquired.sequence >= released.sequence) return ['Source admission lease acquisition/release cannot be verified'];
  }
  return [];
}

/** Explicit PR contract; platform blocked_on is authoritative too. Legacy PRs remain eligible after a cooldown. */
export function parseIntent(pull) {
  const body = String(pull.body ?? '');
  const matches = [...body.matchAll(/<!--\s*workloom-delivery\s*\n([\s\S]*?)\n\s*-->/g)];
  if (matches.length > 1) throw new Error('Duplicate delivery intent');
  const intent = matches.length ? JSON.parse(matches[0][1]) : {};
  if (Object.keys(intent).some(key => !['task_id', 'ready', 'depends_on', 'releases'].includes(key))) throw new Error('Unknown delivery intent field');
  if (intent.ready !== undefined && typeof intent.ready !== 'boolean') throw new Error('ready must be boolean');
  const dependencies = intent.depends_on ?? [];
  if (!Array.isArray(dependencies) || dependencies.some(n => !Number.isSafeInteger(n) || n <= 0 || n === Number(pull.number))) throw new Error('Invalid dependency PR list');
  const releases = intent.releases ?? [];
  if (!Array.isArray(releases) || releases.length > 2 || releases.some(r => !['ui', 'desktop'].includes(r.kind) || !/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(r.version ?? '') || Object.keys(r).some(k => !['kind', 'version'].includes(k)))) throw new Error('Invalid release intent');
  if (new Set(releases.map(r => r.kind)).size !== releases.length) throw new Error('Duplicate release kind');
  const taskId = intent.task_id ?? /T-\d{4}-\d{4}-\d{4}/.exec(`${pull.title ?? ''} ${branchName(pull.head?.ref)}`)?.[0] ?? null;
  if (taskId !== null && !/^T-\d{4}-\d{4}-\d{4}$/.test(taskId)) throw new Error('Invalid task id');
  const native = Array.isArray(pull.blocked_on) ? pull.blocked_on.map(d => Number(d.number ?? d)) : [];
  if (native.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('Invalid platform dependency');
  return { taskId, ready: intent.ready, dependsOn: [...new Set([...dependencies, ...native])], releases };
}

export function dependencyState(number, graph, merged) {
  const visiting = new Set();
  const visited = new Set();
  const walk = n => {
    if (visiting.has(n)) throw new Error('Dependency cycle');
    if (visited.has(n)) return;
    visiting.add(n);
    for (const dependency of graph.get(n) ?? []) walk(dependency);
    visiting.delete(n); visited.add(n);
  };
  walk(number);
  return (graph.get(number) ?? []).filter(n => !merged.has(n));
}

/** Scope validation also applies to a genuine rejection; it never grants approval. */
export function validateReviewScope(output, snapshot, policyHash) {
  if (!output || output.head_sha !== snapshot.headSha || output.base_sha !== snapshot.mainSha || output.policy_hash !== policyHash) throw new Error('AI review identity mismatch');
  if (!Array.isArray(output.reviewed_files) || output.reviewed_files.some(p => typeof p !== 'string') || new Set(output.reviewed_files).size !== output.reviewed_files.length) throw new Error('AI review coverage is invalid');
  const expected = [...snapshot.files].sort();
  if (JSON.stringify([...output.reviewed_files].sort()) !== JSON.stringify(expected)) throw new Error('AI review omitted changed files');
  if (!Array.isArray(output.depends_on) || output.depends_on.some(n => !Number.isSafeInteger(n) || n <= 0 || n === snapshot.number)) throw new Error('AI review dependencies are invalid');
  return expected;
}

export function validateReview(output, snapshot, policyHash) {
  if (!output || output.status !== 'passed' || !Array.isArray(output.issues) || output.issues.length) throw new Error('AI review did not pass without unresolved issues');
  const expected = validateReviewScope(output, snapshot, policyHash);
  const migration = output.ci_policy_changes ?? [];
  const ciIds = (snapshot.ciPolicyChanges ?? []).map(change => change.id).sort();
  if (!Array.isArray(migration) || migration.some(change => typeof change.id !== 'string' || typeof change.rationale !== 'string' || !change.rationale.trim()) ||
    JSON.stringify(migration.map(change => change.id).sort()) !== JSON.stringify(ciIds)) throw new Error('AI CI migration receipt is incomplete or for another policy change');
  const ciDigests = (snapshot.ciPolicyChanges ?? []).map(change => change.digest ?? change.id).sort();
  return { id: randomUUID(), number: snapshot.number, headSha: snapshot.headSha, mainSha: snapshot.mainSha, policyHash, filesHash: hash(expected), resultHash: hash(output), dependsOn: output.depends_on, ciPolicyChangesHash: hash(ciDigests), passed: true };
}

/** A Codex session attests its actual code review and local tests; this is not a platform approval. */
export function validateDeveloperReview(output, snapshot, policy, now = Date.now()) {
  const number = snapshot.originNumber ?? snapshot.number;
  if (output?.schemaVersion !== 1 || output.provider !== 'codex' || !validRepoSlug(snapshot.repo) || output.repo !== snapshot.repo ||
    output.number !== number || output.headSha !== snapshot.headSha || output.mainSha !== snapshot.mainSha || output.policyHash !== policy.hash) throw new Error('Codex review identity differs from the exact repository/source/main/policy');
  const files = [...snapshot.files].sort();
  if (!files.length || !Array.isArray(output.reviewedFiles) || output.reviewedFiles.some(path => typeof path !== 'string' || !path) ||
    new Set(output.reviewedFiles).size !== output.reviewedFiles.length || JSON.stringify([...output.reviewedFiles].sort()) !== JSON.stringify(files)) throw new Error('Codex review must cover every changed file exactly once');
  const reviewedAt = Date.parse(output.reviewedAt);
  if (!Number.isFinite(snapshot.headTime) || !Number.isFinite(reviewedAt) || reviewedAt < snapshot.headTime || reviewedAt > now + 60_000 ||
    typeof output.summary !== 'string' || !output.summary.trim() || output.summary.length > 20_000) throw new Error('Codex review needs a current timestamp and actual review summary');
  if (!Array.isArray(output.tests) || !output.tests.length || output.tests.length > 100 || output.tests.some(value =>
    !value || typeof value.command !== 'string' || !value.command.trim() || value.command.length > 4000 || value.exitCode !== 0 ||
    !Number.isFinite(Date.parse(value.finishedAt)) || Date.parse(value.finishedAt) < snapshot.headTime || Date.parse(value.finishedAt) > reviewedAt ||
    typeof value.result !== 'string' || !value.result.trim() || value.result.length > 20_000)) throw new Error('Codex review requires actual successful local test results for this source');
  const dependsOn = output.dependsOn;
  if (!Array.isArray(dependsOn) || dependsOn.some(value => !Number.isSafeInteger(value) || value <= 0 || value === number) ||
    new Set(dependsOn).size !== dependsOn.length || (snapshot.intent?.dependsOn ?? []).some(value => !dependsOn.includes(value))) throw new Error('Codex review cannot omit a real prerequisite');
  const expectedChanges = snapshot.ciPolicyChanges ?? [];
  const changes = output.ciPolicyChanges ?? [];
  if (!Array.isArray(changes) || changes.some(value => typeof value?.id !== 'string' || typeof value.rationale !== 'string' || !value.rationale.trim()) ||
    JSON.stringify(changes.map(value => value.id).sort()) !== JSON.stringify(expectedChanges.map(value => value.id).sort())) throw new Error('Codex review must explain each exact CI implementation change');
  const receipt = { schemaVersion: 1, provider: 'codex', repo: output.repo, number, headSha: output.headSha, mainSha: output.mainSha,
    policyHash: policy.hash, reviewedFiles: files, filesHash: hash(files), dependsOn: [...dependsOn].sort((a,b) => a-b),
    ciPolicyChanges: structuredClone(changes), ciPolicyChangesHash: hash(expectedChanges.map(value => value.digest ?? value.id).sort()),
    tests: structuredClone(output.tests), reviewedAt: output.reviewedAt, summary: output.summary, passed: true };
  const id = hash(receipt);
  if (output.id !== undefined && (output.id !== id || output.passed !== true || output.filesHash !== receipt.filesHash || output.ciPolicyChangesHash !== receipt.ciPolicyChangesHash)) throw new Error('Stored Codex review receipt was altered');
  return { ...receipt, id };
}

export function developerReviewErrors(snapshot, task, policy, now = Date.now()) {
  try { validateDeveloperReview(task?.developerReview, snapshot, policy, now); return []; }
  catch (error) { return [error.message]; }
}

export function checksVerdict(payload, testedCommit, { headSha, mainSha }, requiredNames) {
  const errors = [];
  if (!Array.isArray(payload?.statuses) || !payload.statuses.length || !SHA_RE.test(payload.sha ?? '')) return ['Missing combined status result'];
  const parents = testedCommit?.parents?.map(parent => parent.sha) ?? [];
  // PR checks run on CNB's temporary merge commit, not necessarily the source tip.
  if (testedCommit?.sha !== payload.sha || parents.length !== 2 || parents[0] !== mainSha || parents[1] !== headSha) errors.push('Checks are for another source/main pair');
  for (const required of requiredNames) {
    const entries = payload.statuses.filter(s => String(s.context ?? '').startsWith('cnb/pull_request/') && String(s.context).endsWith(`(${required})`));
    if (entries.length !== 1 || entries[0].state !== 'success') errors.push(`Required check ${required} missing/failed/ambiguous`);
  }
  return errors;
}

export function eligibility(snapshot, task, policy, now = Date.now()) {
  const { pull, headSha, mainSha, files, intent, pendingDependencies = [], checkErrors = [] } = snapshot;
  const reasons = [];
  if (pull.state !== 'open' || pull.is_wip !== false || branchName(pull.base?.ref) !== 'main') reasons.push('PR is closed, draft or not targeting main');
  if (!Array.isArray(pull.labels)) reasons.push('Missing labels');
  const labels = (pull.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
  if (labels.includes('risk/block')) reasons.push('risk/block');
  if (policy.businessHoldPaths.some(prefix => files.some(path => path.startsWith(prefix)))) reasons.push('Business action requires separate authorization');
  if (!policy.branchPrefixes.some(prefix => branchName(pull.head?.ref).startsWith(prefix))) reasons.push('Branch is outside delivery lanes');
  if (!SHA_RE.test(headSha ?? '') || !SHA_RE.test(mainSha ?? '') || pull.head?.sha !== headSha || pull.base?.sha !== mainSha || !files.length) reasons.push('Snapshot is incomplete');
  if (intent.ready !== true) reasons.push('Developer has not handed off');
  if (pendingDependencies.length) reasons.push(`Unmerged dependencies: ${pendingDependencies.join(',')}`);
  if (pull.mergeable_state !== 'mergeable') reasons.push('Platform does not allow merge');
  reasons.push(...checkErrors);
  reasons.push(...developerReviewErrors(snapshot, task, policy, now));
  return reasons;
}

export function releaseKey({ repo, sha, kind, version }) {
  if (!repo || !SHA_RE.test(sha ?? '') || !['ui', 'desktop'].includes(kind) || !version) throw new Error('Invalid release identity');
  return hash({ repo, sha, kind, version });
}
