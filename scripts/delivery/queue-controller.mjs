import { appendEvent, branchName, dependencyState, eligibility, hash, leaseOperation, sensitiveScopes, updateTask } from './queue-model.mjs';
import { alignBranch, dispatchRecovery } from './queue-work.mjs';
import { enqueueReleases } from './queue-release.mjs';
import { performance } from 'node:perf_hooks';

export function integratedDependency(pull, task) {
  return pull.is_merged === true || Boolean(task?.merge && task.merge.sourceSha === pull.head?.sha && ['integrated', 'release_pending', 'delivered'].includes(task.status));
}

export async function dependencies(platform, pulls, state) {
  const graph = new Map(); const merged = new Set();
  const invalid = new Map();
  const { parseIntent } = await import('./queue-model.mjs');
  for (const pull of pulls) {
    try {
      const intent = parseIntent(pull);
      const reviewed = state.tasks[String(pull.number)]?.review?.dependsOn ?? [];
      graph.set(Number(pull.number), [...new Set([...intent.dependsOn, ...reviewed])]);
    } catch (error) { graph.set(Number(pull.number), []); invalid.set(Number(pull.number), error.message); }
  }
  const required = new Set([...graph.values()].flat());
  const unavailable = new Map();
  for (const number of required) {
    try {
      const pull = await platform.pull(number);
      const task = state.tasks[String(number)];
      if (integratedDependency(pull, task)) merged.add(number);
    } catch (error) { unavailable.set(number, `Prerequisite #${number} is unreadable: ${error.message}`); }
    // A closed, unmerged prerequisite is never treated as completed.
  }
  const result = new Map();
  for (const number of graph.keys()) {
    try { result.set(number, { pending: dependencyState(number, graph, merged), error: invalid.get(number) ?? graph.get(number).map(dependency => unavailable.get(dependency)).find(Boolean) ?? null }); }
    catch (error) { result.set(number, { pending: graph.get(number), error: error.message }); }
  }
  return result;
}

async function recoverMerge(platform, task) {
  const expected = task.mergeSnapshot;
  const pull = await platform.pull(expected?.number ?? task.number);
  if (!expected) throw new Error('Incomplete merge intent; repository integration is paused');
  if (pull.is_merged === true) {
    if (task.merge?.sha) return platform.verifyMerge(expected, { sha: task.merge.sha });
    let sha = (await platform.main()).commit?.sha;
    for (let depth = 0; depth < 200; depth++) {
      const commit = await platform.commit(sha);
      const parents = commit.parents?.map(parent => parent.sha) ?? [];
      if (parents.length === 2 && parents[0] === expected.mainSha && parents[1] === expected.headSha) return platform.verifyMerge(expected, { sha });
      if (!parents.length) break;
      sha = parents[0];
    }
    throw new Error('Merged PR cannot be traced to the exact tested parents');
  }
  // No request was issued in these phases; native serialization proves the previous runner has ended.
  if (task.mergePhase === 'prepared') return null;
  throw new Error('Merge response is unknown; no later merge or duplicate request is allowed until positive readback');
}

async function finishIntegration({ platform, store, task, receipt, now }) {
  const original = await platform.pull(task.number);
  const sourceChanged = original.head?.sha !== task.mergeSnapshot.headSha || original.body !== task.originalBody || original.is_wip === true;
  const marker = `delivery-integrated:${task.number}:${receipt.sha}`;
  if (!sourceChanged && original.state === 'open') {
    const comments = await platform.list(`/-/pulls/${task.number}/comments`);
    if (!comments.some(comment => String(comment.body).includes(marker))) await platform.comment(task.number, `本 PR 的准确源码 ${receipt.sourceSha} 已通过独立 AI 审查与必需检查，由不可修改的候选 PR #${task.mergeSnapshot.number} 合入 ${receipt.sha}。原分支保留；无需人工点击批准。\n\n<!-- ${marker} -->`);
    await platform.call(`/-/pulls/${task.number}`, { method: 'PATCH', body: { state: 'closed' } });
    const closed = await platform.pull(task.number);
    if (closed.state !== 'closed' || closed.head?.sha !== receipt.sourceSha) throw new Error('Original PR closure changed; integration receipt retained for recovery');
  }
  await store.mutate(current => {
    releaseIntegrationLease(current, task, now);
    const updated = updateTask(current, task.number, {
      status: sourceChanged ? 'waiting_ci' : (task.intent?.releases?.length ? 'release_pending' : 'integrated'),
      merge: receipt, mergePhase: null, error: sourceChanged ? 'Original source advanced; new work remains open' : null,
      integrationHistory: [...(current.tasks[String(task.number)]?.integrationHistory ?? []).filter(item => item.sha !== receipt.sha), receipt],
      ...(sourceChanged ? { review: null, candidate: null, headSha: original.head?.sha } : {}),
    }, now);
    if (!sourceChanged) enqueueReleases(current, platform.repo, updated, now);
  });
}

async function recoverMerges({ platform, store, now }) {
  const state = await store.read();
  for (const task of Object.values(state.tasks).filter(task => task.status === 'merging')) {
    const receipt = await recoverMerge(platform, task);
    if (receipt) await finishIntegration({ platform, store, task, receipt, now });
    else await store.mutate(current => { releaseIntegrationLease(current, task, now); updateTask(current, task.number, { status: 'waiting_ci', mergePhase: null, error: null }, now); });
  }
}

function releaseIntegrationLease(state, task, now) {
  const intent = task.integrationLease;
  if (!intent) return;
  for (const scope of intent.scopes) {
    const lease = state.leases[scope];
    if (lease?.owner === intent.owner && lease.generation === intent.generation[scope] && lease.expiresAt > now) leaseOperation(state, { action: 'release', owner: intent.owner, scopes: [scope], generation: intent.generation }, now);
  }
}

/** All merge callers use one native repository lock and an immutable, preprotected candidate. */
export async function mergeCandidate({ platform, store, policy, snapshot, dependencies: dependencyMap, now = Date.now() }) {
  const number = snapshot.originNumber ?? snapshot.number;
  await platform.assertCandidateProtection();
  if (!branchName(snapshot.pull.head.ref).startsWith('delivery/candidate/')) throw new Error('Merge requires an immutable candidate');
  const scopes = sensitiveScopes(snapshot.files);
  const owner = `integration/pr-${number}`;
  const preparation = await store.mutate(state => {
    const generation = scopes.length ? leaseOperation(state, { action: 'acquire', owner, scopes }, now) : {};
    updateTask(state, number, { status: 'merging', mergePhase: 'prepared', mergeSnapshot: snapshot, integrationLease: { owner, scopes, generation } }, now);
    return generation;
  });
  const generation = preparation.result;
  const release = state => {
    for (const scope of scopes) {
      const lease = state.leases[scope];
      if (lease?.owner === owner && lease.generation === generation[scope] && lease.expiresAt > now) leaseOperation(state, { action: 'release', owner, scopes: [scope], generation }, now);
    }
  };
  let issued = false;
  try {
    const latest = await platform.snapshot(snapshot.number, policy);
    if (latest.headSha !== snapshot.headSha || latest.mainSha !== snapshot.mainSha) throw new Error('Source or main changed before merge');
    const state = await store.read();
    const deps = dependencyMap.get(number);
    if (deps?.error) throw new Error(deps.error);
    // Read real prerequisites again after the source was frozen.
    latest.pendingDependencies = [];
    for (const dependency of [...new Set([...state.tasks[String(number)].intent.dependsOn, ...(state.tasks[String(number)]?.review?.dependsOn ?? [])])]) {
      if (!integratedDependency(await platform.pull(dependency), state.tasks[String(dependency)])) latest.pendingDependencies.push(dependency);
    }
    const reasons = eligibility(latest, state.tasks[String(number)], policy, now);
    if (reasons.length) throw new Error(reasons.join('; '));
    const original = await platform.pull(number);
    if (original.state !== 'open' || original.is_wip || original.head?.sha !== snapshot.headSha || original.body !== state.tasks[String(number)].originalBody) throw new Error('Developer changed source/handoff before candidate merge');
    await store.mutate(current => {
      for (const scope of scopes) {
        const lease = current.leases[scope];
        if (lease?.owner !== owner || lease.generation !== generation[scope] || lease.expiresAt <= now) throw new Error('Integration lease is fenced/expired');
      }
      updateTask(current, number, { mergePhase: 'merge_requested', mergeRequestedAt: now }, now);
    });
    issued = true;
    const result = await platform.merge(latest);
    const receipt = await platform.verifyMerge(latest, result);
    // Keep the durable receipt before releasing any protections.
    await store.mutate(current => updateTask(current, number, { mergePhase: 'merge_verified', merge: receipt }, now));
    await finishIntegration({ platform, store, task: (await store.read()).tasks[String(number)], receipt, now });
    return receipt;
  } catch (error) {
    if (!issued) {
      await store.mutate(current => { release(current); updateTask(current, number, { status: 'waiting_ci', mergePhase: null, error: platform.error(error) }, now); });
    } else {
      let rejected = false;
      if (error.status === 409) {
        try { const actual = await platform.pull(snapshot.number); rejected = actual.is_merged === false && actual.head?.sha === snapshot.headSha; }
        catch (readError) { error = new Error(`${platform.error(error)}; merge rejection readback unavailable: ${platform.error(readError)}`); }
      }
      await store.mutate(current => {
        if (rejected) {
          release(current);
          appendEvent(current, 'merge_rejected', { number, candidate: snapshot.number, headSha: snapshot.headSha, httpStatus: 409, verifiedUnmerged: true }, now);
        }
        updateTask(current, number, { error: platform.error(error), ...(rejected ? { status: 'waiting_ci', mergePhase: null } : {}) }, now);
      });
    }
    throw error;
  }
}

export async function requestReview(platform, store, snapshot, _task, now) {
  let state = await store.read(); let task = state.tasks[String(snapshot.number)];
  const same = value => value?.headSha === snapshot.headSha && value.mainSha === snapshot.mainSha;
  const fail = async (sn, reason) => store.mutate(current => {
    const old = current.tasks[String(snapshot.number)];
    if (old?.reviewFailures?.lastBuild === sn && same(old.reviewFailures)) return;
    updateTask(current, snapshot.number, { status: 'parked', reviewBuild: null, reviewDispatch: null,
      reviewFailures: { headSha: snapshot.headSha, mainSha: snapshot.mainSha, count: (same(old?.reviewFailures) ? old.reviewFailures.count : 0) + 1, lastBuild: sn },
      blockedUntil: now + 10 * 60_000, error: reason }, now);
  });
  if (same(task?.reviewBuild) && task.reviewBuild.sn) {
    const status = await platform.call(`/-/build/status/${encodeURIComponent(task.reviewBuild.sn)}`);
    if (status?.status === 'pending') return { waiting: 'running' };
    if (!['success', 'error', 'cancel'].includes(status?.status)) throw new Error('AI build status is unreadable; duplicate launch refused');
    if (same(task.review) && task.review.passed) return { waiting: 'reviewed' };
    await fail(task.reviewBuild.sn, `AI build ${status.status} without a complete review receipt`);
    return { waiting: 'failed-build' };
  }
  if (same(task?.reviewDispatch)) {
    const dispatch = task.reviewDispatch;
    const builds = await platform.builds(snapshot.mainSha, 'api_trigger_delivery_review');
    const matches = builds.filter(build => build.title === dispatch.title && build.sha === snapshot.mainSha && build.event === 'api_trigger_delivery_review' && !dispatch.knownBuilds.includes(build.sn));
    if (matches.length > 1) throw new Error('Ambiguous AI launch receipt; duplicate launch refused');
    if (matches.length === 1) {
      await store.mutate(current => updateTask(current, snapshot.number, { reviewBuild: { sn: matches[0].sn, headSha: snapshot.headSha, mainSha: snapshot.mainSha, at: dispatch.at }, reviewDispatch: null }, now));
      return { waiting: 'recovered-launch' };
    }
    return { waiting: 'unknown-launch' }; // Absence in logs is not proof that the write failed.
  }
  if (same(task?.reviewFailures) && task.reviewFailures.count >= 2) return { waiting: 'budget' };
  if (task?.blockedUntil > now) return { waiting: 'backoff' };
  // Target-event review normally starts itself. Give it time before considering API recovery.
  if (!task) {
    await store.mutate(current => updateTask(current, snapshot.number, { status: 'waiting_review', headSha: snapshot.headSha, mainSha: snapshot.mainSha }, now));
    return { waiting: 'target-event' };
  }
  if (now - task.firstSeen < 2 * 60_000) return { waiting: 'target-event' };
  const busy = Object.values(state.tasks).some(other => other.number !== snapshot.number && other.status === 'waiting_review' && ((other.reviewDispatch && now - other.reviewDispatch.at < 45 * 60_000) || (other.reviewBuild && now - other.reviewBuild.at < 45 * 60_000)));
  if (busy) return { waiting: 'capacity' };
  const builds = await platform.builds(snapshot.mainSha, 'api_trigger_delivery_review');
  const dispatch = { headSha: snapshot.headSha, mainSha: snapshot.mainSha, at: now, title: `WorkLoom AI review #${snapshot.number} ${hash({ head: snapshot.headSha, main: snapshot.mainSha, at: now }).slice(0, 20)}`, knownBuilds: builds.map(build => build.sn) };
  await store.mutate(current => updateTask(current, snapshot.number, { status: 'waiting_review', reviewDispatch: dispatch }, now));
  // Persist before the write. Any lost acknowledgement is recovered by its unique title.
  const build = await platform.call('/-/build/start', { method: 'POST', body: {
    branch: 'main', sha: snapshot.mainSha, event: 'api_trigger_delivery_review', sync: 'false',
    title: dispatch.title, env: { DELIVERY_PR: String(snapshot.number) },
  } });
  if (!build?.success || !build.sn) throw new Error('AI review launch has no build receipt; awaiting readback');
  await store.mutate(current => updateTask(current, snapshot.number, { reviewBuild: { ...build, headSha: snapshot.headSha, mainSha: snapshot.mainSha, at: now }, reviewDispatch: null }, now));
  return { waiting: 'launched' };
}

async function requestRepair(platform, store, snapshot, task, reason, policy, now) {
  const count = task?.recoveryCount ?? 0;
  if (count >= policy.maxInfrastructureAttempts || (task?.recovery?.dispatchedAt && now - task.recovery.dispatchedAt < policy.ciTimeoutMs)) return;
  await store.mutate(state => updateTask(state, snapshot.number, { status: 'parked', recoveryCount: count + 1, recoveryIntent: { headSha: snapshot.headSha, reason, at: now }, error: reason, blockedUntil: now + 10 * 60_000 }, now));
  const receipt = await dispatchRecovery(platform, snapshot, reason);
  await store.mutate(state => updateTask(state, snapshot.number, { recovery: receipt, recoveryIntent: null }, now));
}

/** Candidate creation triggers a real target-event review; reserve capacity before creating another one. */
export async function reviewSlotBusy(platform, store, originNumber, mainSha, now) {
  const state = await store.read();
  for (const origin of Object.values(state.tasks)) {
    const candidate = origin.candidate;
    if (origin.number === originNumber || !candidate || candidate.mainSha !== mainSha || candidate.headSha !== origin.headSha || ['integrated', 'release_pending', 'delivered', 'closed'].includes(origin.status)) continue;
    const task = state.tasks[String(candidate.number)];
    if (task?.review?.passed && task.review.headSha === candidate.headSha && task.review.mainSha === mainSha) continue;
    if (task?.reviewBuild?.sn && now - task.reviewBuild.at < 45 * 60_000) {
      const actual = await platform.call(`/-/build/status/${encodeURIComponent(task.reviewBuild.sn)}`);
      if (actual?.status === 'pending') return true;
      if (!['success', 'error', 'cancel'].includes(actual?.status)) throw new Error('In-flight AI build status is unreadable; new candidate deferred');
      continue; // A terminal failed review cannot reserve unrelated candidate capacity.
    }
    if (task?.reviewDispatch && now - task.reviewDispatch.at < 45 * 60_000) return true;
    if (!task && now - candidate.at < 2 * 60_000) return true; // Target event is starting.
  }
  return false;
}

export async function writeTaskReceipts({ platform, store, now = Date.now() }) {
  const state = await store.read();
  const tasks = Object.values(state.tasks).filter(task => ['integrated', 'delivered'].includes(task.status) && !task.issueReceipt && task.intent?.taskId && task.merge && (task.intent.releases ?? []).every(intent => Object.values(state.releases).some(release => release.number === task.number && release.sha === task.merge.sha && release.kind === intent.kind && release.version.replace(/^v/, '') === intent.version.replace(/^v/, '') && release.status === 'delivered' && release.receipt?.sha === task.merge.sha)));
  if (!tasks.length) return;
  const issues = [...await platform.list('/-/issues?state=open'), ...await platform.list('/-/issues?state=closed')];
  for (const task of tasks) {
    const matches = issues.filter(issue => String(issue.title ?? '').includes(`[${task.intent.taskId}]`));
    if (matches.length > 1) throw new Error('Ambiguous task issue identity; refuse automatic closure');
    const issue = matches[0];
    if (!issue) continue; // Legacy PRs may have no task card. Their Git receipt still remains durable.
    const marker = `delivery-receipt:${task.number}:${task.merge.sha}`;
    const comments = await platform.list(`/-/issues/${issue.number}/comments`);
    if (!comments.some(comment => String(comment.body ?? '').includes(marker))) {
      const releases = Object.values(state.releases).filter(release => release.number === task.number);
      const body = `**回执 · ${task.intent.taskId}**\n\n- 进展：PR #${task.number} 已真实合入 ${task.merge.sha}${releases.length ? '，所声明制品发布已回读验证' : '；本任务未声明安装包/制品发布'}。\n- 决策：AI 审查与必需检查绑定 source=${task.merge.sourceSha} / main=${task.merge.mainSha}；无 force 合并。\n- 未完成：${releases.length ? '无声明的发布欠项' : '未声明的客户部署不计入本回执'}。\n- 下一步：由持续执行器处理后续任务；回滚通过新 revert PR。\n- 分支状态：已合并，源分支保留，可恢复。\n\n<!-- ${marker} -->`;
      await platform.call(`/-/issues/${issue.number}/comments`, { method: 'POST', body: { body } });
      if (!(await platform.list(`/-/issues/${issue.number}/comments`)).some(comment => String(comment.body ?? '').includes(marker))) throw new Error('Issue receipt did not read back');
    }
    if (issue.state !== 'closed') {
      await platform.call(`/-/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
      const after = await platform.call(`/-/issues/${issue.number}`);
      if (after.state !== 'closed') throw new Error('Task closure did not read back');
    }
    await store.mutate(current => updateTask(current, task.number, { issueReceipt: { issue: issue.number, marker, verifiedAt: now } }, now));
  }
}

/** A bad PR never stops scanning unrelated candidates. Unknown merge writes deliberately pause integration. */
export async function reconcile({ platform, store, policy, now = Date.now(), dryRun = false, services = {}, deadlineMs = 240_000, elapsedClock = () => performance.now() }) {
  const report = { repo: platform.repo, dryRun, integrated: [], aligned: [], waiting: [], parked: [], releases: [], failed: [] };
  const started = elapsedClock();
  if (!dryRun) {
    const durable = await store.read();
    if (!durable.events.some(event => event.kind === 'activated')) {
      report.waiting.push({ reason: 'Installed pipelines await verified activation' });
      return report;
    }
    // Release IO runs in its own native pipeline/lock; it never occupies the integration executor.
    try { await recoverMerges({ platform, store, now }); }
    catch (error) { report.failed.push({ stage: 'recover-merge', error: platform.error(error) }); return report; }
  }
  const pulls = await platform.pulls();
  let state = await store.read();
  const dependencyMap = await dependencies(platform, pulls, state);
  let alignments = 0; let reviews = 0; let repairs = 0; let createdCandidates = 0;
  const age = pull => state.tasks[String(pull.number)]?.firstSeen ?? (Date.parse(pull.created_at ?? '') || now);
  const queue = [...pulls].sort((a, b) => age(a) - age(b) || Number(a.number) - Number(b.number));
  for (const pull of queue) {
    const number = Number(pull.number);
    if (branchName(pull.head?.ref).startsWith('delivery/candidate/')) continue;
    if (elapsedClock() - started > deadlineMs) { report.waiting.push({ number, reason: 'Bounded runner time; next reconcile continues' }); continue; }
    try {
      const snapshot = await platform.snapshot(number, policy);
      const stored = state.tasks[String(number)];
      const identityChanged = stored && (stored.headSha !== snapshot.headSha || stored.mainSha !== snapshot.mainSha);
      const previous = identityChanged ? { ...stored, alignmentCount: 0, recoveryCount: 0, reviewFailures: null, blockedUntil: 0, review: null } : stored;
      if (previous?.blockedUntil > now) { report.parked.push({ number, reason: 'Recovery backoff is active', until: previous.blockedUntil }); continue; }
      const dependencies = dependencyMap.get(number);
      snapshot.pendingDependencies = dependencies?.pending ?? [];
      if (dependencies?.error) throw new Error(dependencies.error);
      const labels = (snapshot.pull.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
      if (!Array.isArray(snapshot.pull.labels) || labels.includes('risk/block') || policy.businessHoldPaths.some(prefix => snapshot.files.some(path => path.startsWith(prefix)))) {
        report.parked.push({ number, reason: 'Blocked risk/business lane or unreadable labels' }); continue;
      }
      if (snapshot.pull.head?.repo?.path && snapshot.pull.head.repo.path !== platform.repo) {
        report.parked.push({ number, reason: 'Cross-repository source is outside this repository writer' }); continue;
      }
      if (!policy.branchPrefixes.some(prefix => branchName(snapshot.pull.head?.ref).startsWith(prefix))) {
        report.parked.push({ number, reason: 'Source is outside delivery branch lanes' }); continue;
      }
      if (snapshot.pull.is_wip || snapshot.intent.ready === false || snapshot.pull.state !== 'open') {
        report.waiting.push({ number, reason: 'Draft/developer owns task' });
        if (!dryRun) await store.mutate(current => updateTask(current, number, { status: 'developing', headSha: snapshot.headSha, intent: snapshot.intent }, now));
        continue;
      }
      if (snapshot.intent.ready !== true && (!Number.isFinite(snapshot.headTime) || now - snapshot.headTime < policy.cooldownMs)) {
        report.waiting.push({ number, reason: 'Developer handoff/cooldown is pending' }); continue;
      }
      if (snapshot.pendingDependencies.length) {
        report.waiting.push({ number, reason: `Explicit prerequisites ${snapshot.pendingDependencies.join(',')}` });
        if (!dryRun) await store.mutate(current => updateTask(current, number, { status: 'waiting_dependency', headSha: snapshot.headSha, intent: snapshot.intent, dependencies: snapshot.pendingDependencies }, now));
        continue;
      }
      // Lease writers are independent of this native merge runner, and earlier
      // iterations may continue after a handoff mutation. Never reuse loop state.
      state = await store.read();
      const activeScopes = sensitiveScopes(snapshot.files).filter(scope => state.leases[scope]?.owner && state.leases[scope].expiresAt > now);
      if (activeScopes.some(scope => state.leases[scope].owner !== snapshot.intent.taskId) || (activeScopes.length && snapshot.intent.ready !== true)) {
        report.waiting.push({ number, reason: `Active developer lease ${activeScopes.join(',')}` }); continue;
      }
      if (!dryRun) {
        await store.mutate(current => {
          const changedScopes = sensitiveScopes(snapshot.files).filter(scope => current.leases[scope]?.owner && current.leases[scope].expiresAt > now);
          if (changedScopes.some(scope => current.leases[scope].owner !== snapshot.intent.taskId) || (changedScopes.length && snapshot.intent.ready !== true)) throw new Error('Developer lease changed before handoff');
          if (snapshot.intent.ready === true && snapshot.intent.taskId) {
            for (const scope of sensitiveScopes(snapshot.files)) {
              const lease = current.leases[scope];
              if (lease?.owner === snapshot.intent.taskId && lease.expiresAt > now) leaseOperation(current, { action: 'release', scopes: [scope], owner: lease.owner, generation: { [scope]: lease.generation } }, now);
            }
          }
          updateTask(current, number, { ...(identityChanged ? { alignmentCount: 0, recoveryCount: 0, reviewFailures: null, blockedUntil: 0, review: null, candidate: null } : {}), headSha: snapshot.headSha, mainSha: snapshot.mainSha, branch: branchName(snapshot.pull.head.ref), intent: snapshot.intent, originalBody: snapshot.pull.body, files: snapshot.files, status: previous?.status === 'parked' ? 'parked' : 'waiting_ci', ciSince: stored?.headSha === snapshot.headSha ? (stored.ciSince ?? now) : now }, now);
        });
      }
      if (snapshot.mergeBase !== snapshot.mainSha) {
        if (alignments >= 2) { report.waiting.push({ number, reason: 'Alignment capacity for this run reached' }); continue; }
        if ((previous?.alignmentCount ?? 0) >= policy.maxAlignmentAttempts) {
          report.parked.push({ number, reason: 'Alignment retry budget exhausted' });
          if (!dryRun) await store.mutate(current => updateTask(current, number, { status: 'parked', error: 'Alignment retry budget exhausted' }, now));
          if (!dryRun && repairs++ < 2) await requestRepair(platform, store, snapshot, previous, '需按实际代码语义更新 main 并解决冲突；自动主干对齐预算已耗尽', policy, now);
          continue;
        }
        if (dryRun) { report.aligned.push({ number, dryRun: true }); continue; }
        await store.mutate(current => updateTask(current, number, { status: 'aligning', alignmentCount: (previous?.alignmentCount ?? 0) + 1, alignmentIntent: { headSha: snapshot.headSha, mainSha: snapshot.mainSha, at: now }, review: null }, now));
        try {
          const receipt = await (services.alignBranch ?? alignBranch)(platform, snapshot);
          await store.mutate(current => updateTask(current, number, { status: 'waiting_ci', alignment: receipt, alignmentIntent: null, headSha: receipt.sha, ciSince: now }, now));
          report.aligned.push({ number, ...receipt }); alignments++;
        } catch (error) {
          report.parked.push({ number, reason: platform.error(error) });
          await store.mutate(current => updateTask(current, number, { status: 'parked', error: platform.error(error), blockedUntil: now + 10 * 60_000 }, now));
          if (repairs++ < 2) await requestRepair(platform, store, snapshot, previous, `主干对齐失败：${platform.error(error)}`, policy, now);
        }
        continue;
      }
      const task = (await store.read()).tasks[String(number)] ?? previous;
      const reasons = eligibility(snapshot, task, policy, now);
      if (!reasons.length || reasons.every(reason => reason === 'No current complete AI review')) {
        if (dryRun) report.integrated.push({ number, dryRun: true });
        else {
          const existingCandidate = task?.candidate?.headSha === snapshot.headSha && task.candidate.mainSha === snapshot.mainSha;
          if (!existingCandidate && (createdCandidates || await reviewSlotBusy(platform, store, number, snapshot.mainSha, now))) {
            report.waiting.push({ number, reason: 'Independent AI parent capacity is occupied; source remains available for development' }); continue;
          }
          const candidate = await platform.ensureCandidate(snapshot);
          candidate.at = existingCandidate ? (task.candidate.at ?? now) : now;
          if (!existingCandidate) createdCandidates++;
          await store.mutate(current => updateTask(current, number, { candidate }, now));
          const candidateSnapshot = await platform.snapshot(candidate.number, policy);
          candidateSnapshot.originNumber = number;
          candidateSnapshot.pendingDependencies = snapshot.pendingDependencies;
          const candidateTask = (await store.read()).tasks[String(candidate.number)];
          const review = candidateTask?.review;
          const candidateReasons = eligibility(candidateSnapshot, { ...task, review }, policy, now);
          if (candidateReasons.length) {
            report.waiting.push({ number, candidate: candidate.number, reasons: candidateReasons });
            const currentReview = review?.headSha === candidateSnapshot.headSha && review.mainSha === candidateSnapshot.mainSha && review.policyHash === policy.hash;
            if (!currentReview && reviews++ < 2) await requestReview(platform, store, candidateSnapshot, candidateTask, now);
            if ((candidateTask?.reviewFailures?.count ?? 0) >= 2 && repairs++ < 2) await requestRepair(platform, store, snapshot, task, `不可修改候选 #${candidate.number} 的 AI 审查未通过；请修复原分支，交付器会创建新候选`, policy, now);
            continue;
          }
          await store.mutate(current => updateTask(current, number, { review }, now));
          const receipt = await mergeCandidate({ platform, store, policy, snapshot: candidateSnapshot, dependencies: dependencyMap, now });
          report.integrated.push({ number, ...receipt });
          break; // Main changed. The next trusted-main runner recalculates all combinations.
        }
        continue;
      }
      report.waiting.push({ number, reasons });
      if (!dryRun) {
        // AI review runs on the immutable candidate after source checks/handoff.
        if ((snapshot.hasFailedChecks || (task?.ciSince && now - task.ciSince > policy.ciTimeoutMs) || (task?.reviewFailures?.count >= 2)) && repairs++ < 2) await requestRepair(platform, store, snapshot, task, `检查/评审阻断：${reasons.join('; ')}`, policy, now);
      }
    } catch (error) {
      report.failed.push({ number, stage: 'task', error: platform.error(error) });
      if (!dryRun) {
        const current = await store.read();
        if (current.tasks[String(number)]?.status === 'merging') break;
        await store.mutate(current => updateTask(current, number, { status: 'parked', error: platform.error(error), blockedUntil: now + 10 * 60_000 }, now));
      }
    }
    state = await store.read();
  }
  if (!dryRun) {
    try { await writeTaskReceipts({ platform, store, now }); }
    catch (error) { report.failed.push({ stage: 'task-receipts', error: platform.error(error) }); }
  }
  return report;
}
