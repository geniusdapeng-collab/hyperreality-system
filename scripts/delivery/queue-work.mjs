import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git } from './git-state.mjs';
import { branchName, hash, SHA_RE, updateTask, validateReview } from './queue-model.mjs';
import { reviewRules } from './queue-policy.mjs';

export function independentCodeBuddyApproval(reviews, pull, startedAt) {
  const creator = pull.author?.username;
  if (typeof creator !== 'string' || !creator || !Number.isFinite(startedAt)) throw new Error('Independent approval requires a known PR creator and review freshness boundary');
  const approval = reviews.find(review => review.state === 'approved' && review.author?.is_npc === true &&
    typeof review.author.username === 'string' && review.author.username && review.author.username.toLowerCase() !== creator.toLowerCase() &&
    `${review.author.username} ${review.author.nickname ?? ''}`.toLowerCase().includes('codebuddy') && Date.parse(review.created_at) >= startedAt);
  if (!approval) throw new Error('No current independent real CodeBuddy platform approval was read back');
  return { id: approval.id, author: approval.author.username, creator, isNpc: true, createdAt: approval.created_at };
}

export async function alignBranch(platform, snapshot, { remote: testRemote } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workloom-delivery-align-'));
  const remote = testRemote ?? `https://cnb.cool/${platform.repo}.git`;
  const run = (args, authenticated = false) => git(args, { cwd: directory, remote, token: authenticated ? platform.token : undefined });
  try {
    await run(['init', '--quiet']);
    await run(['fetch', '--quiet', '--no-tags', remote, snapshot.mainSha, snapshot.headSha], true);
    await run(['checkout', '--quiet', '--detach', snapshot.headSha]);
    await run(['merge', '--no-ff', '--no-edit', snapshot.mainSha]);
    const sha = await run(['rev-parse', 'HEAD']);
    const [pull, main] = await Promise.all([platform.pull(snapshot.number), platform.main()]);
    if (pull.state !== 'open' || pull.is_wip || pull.head?.sha !== snapshot.headSha || main.commit?.sha !== snapshot.mainSha || branchName(pull.head?.ref) !== branchName(snapshot.pull.head?.ref)) throw new Error('Branch/main changed before alignment push');
    await run(['push', '--porcelain', remote, `${sha}:refs/heads/${branchName(pull.head.ref)}`], true);
    const actual = (await run(['ls-remote', remote, `refs/heads/${branchName(pull.head.ref)}`], true)).split(/\s/)[0];
    if (actual !== sha) throw new Error('Alignment push could not be verified');
    return { sha, previousHead: snapshot.headSha, mainSha: snapshot.mainSha, verifiedAt: new Date().toISOString() };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function prepareReview({ platform, store, policy, root, number, stateless = false }) {
  const snapshot = await platform.snapshot(number, policy, { checks: false });
  snapshot.reviewStartedAt = Date.now() - 5000;
  if (snapshot.pull.state !== 'open' || snapshot.pull.is_wip !== false || snapshot.intent.ready === false) return null;
  if (!stateless && !branchName(snapshot.pull.head?.ref).startsWith('delivery/candidate/')) return null;
  if (!stateless) {
    const old = (await store.read()).tasks[String(number)];
    const same = value => value?.headSha === snapshot.headSha && value.mainSha === snapshot.mainSha;
    if ((same(old?.review) && old.review.passed && old.review.policyHash === policy.hash) ||
      (same(old?.reviewFailures) && old.reviewFailures.count >= 2) || old?.blockedUntil > Date.now()) return null;
    if (!process.env.CNB_BUILD_ID) throw new Error('Stateful AI review requires a real CNB build identity');
  }
  const reviewRoot = resolve(root, '.delivery-review');
  await mkdir(reviewRoot, { recursive: true });
  const directory = await mkdtemp(join(reviewRoot, 'snapshot-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const remote = `https://cnb.cool/${platform.repo}.git`;
  try {
    await git(['init', '--quiet'], { cwd: source });
    await git(['fetch', '--quiet', '--no-tags', remote, snapshot.mainSha, snapshot.headSha], { cwd: source, remote, token: platform.token });
    await git(['checkout', '--quiet', '--detach', snapshot.headSha], { cwd: source });
    const files = (await git(['diff', '--name-only', '-z', `${snapshot.mainSha}...${snapshot.headSha}`], { cwd: source, raw: true })).split('\0').filter(Boolean).sort();
    if (JSON.stringify(files) !== JSON.stringify([...snapshot.files].sort())) throw new Error('Platform changed-file coverage differs from Git');
    // Never activate source-controlled agent hooks/skills. They remain available as Git data for review.
    for (const path of ['.codebuddy', '.claude', '.codex']) await rm(join(source, path), { recursive: true, force: true });
    const rules = join(directory, 'rules.txt');
    const coverage = join(directory, 'coverage.json');
    await writeFile(rules, reviewRules(snapshot, policy.hash));
    const manifest = { snapshot, policyHash: policy.hash, directory, source, rules, coverage, output: join(directory, 'result.json') };
    await writeFile(join(reviewRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (!stateless) await store.mutate(state => updateTask(state, number, { status: 'waiting_review', headSha: snapshot.headSha, mainSha: snapshot.mainSha, branch: branchName(snapshot.pull.head.ref), intent: snapshot.intent, reviewAttemptAt: Date.now(), policyHash: policy.hash,
      reviewBuild: { sn: process.env.CNB_BUILD_ID, headSha: snapshot.headSha, mainSha: snapshot.mainSha, at: Date.now() }, reviewDispatch: null }));
    return { head: snapshot.headSha, base: snapshot.mainSha, pr: String(number), cwd: source, rules, output: manifest.output, maxFiles: String(Math.max(1, files.length)) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function finishReview({ platform, store, policy, root, stateless = false }) {
  const manifest = JSON.parse(await readFile(join(root, '.delivery-review/manifest.json'), 'utf8'));
  try {
    if (manifest.policyHash !== policy.hash || !SHA_RE.test(manifest.snapshot?.headSha ?? '')) throw new Error('Review manifest policy changed');
    let output = JSON.parse(await readFile(manifest.output, 'utf8'));
    if (!Array.isArray(output.reviewed_files)) {
      const coverage = JSON.parse(await readFile(manifest.coverage, 'utf8'));
      const allowed = ['reviewed_files', 'head_sha', 'base_sha', 'policy_hash', 'depends_on'];
      if (!coverage || Object.keys(coverage).some(key => !allowed.includes(key))) throw new Error('AI coverage receipt contains unsupported fields');
      output = { ...output, ...coverage };
    }
    const latest = await platform.snapshot(manifest.snapshot.number, policy, { checks: false });
    if (latest.headSha !== manifest.snapshot.headSha || latest.mainSha !== manifest.snapshot.mainSha || latest.pull.state !== 'open') throw new Error('Review result expired while AI was running');
    if (stateless && !(await store.read()).events.some(event => event.kind === 'installation_prepared' && event.data.installer === latest.number && event.data.headSha === latest.headSha && event.data.mainSha === latest.mainSha)) throw new Error('Installer ledger must be prepared for the exact source/main before merge');
    const receipt = validateReview(output, latest, policy.hash);
    // Dependencies cannot be silently dropped by the model.
    receipt.dependsOn = [...new Set([...latest.intent.dependsOn, ...receipt.dependsOn])];
    const actual = await platform.list(`/-/pulls/${latest.number}/reviews`);
    receipt.platformReview = independentCodeBuddyApproval(actual, latest.pull, manifest.snapshot.reviewStartedAt);
    if (!stateless) await store.mutate(state => updateTask(state, latest.number, { status: 'waiting_ci', review: { ...receipt, result: output, approvedAt: Date.now() }, headSha: latest.headSha, mainSha: latest.mainSha, intent: latest.intent, error: null, blockedUntil: 0 }));
    return receipt;
  } catch (error) {
    if (!stateless) await store.mutate(state => {
      const old = state.tasks[String(manifest.snapshot.number)];
      const same = old?.reviewFailures?.headSha === manifest.snapshot.headSha && old.reviewFailures.mainSha === manifest.snapshot.mainSha;
      const lastBuild = process.env.CNB_BUILD_ID ?? old?.reviewBuild?.sn;
      const count = same ? old.reviewFailures.count + (lastBuild && old.reviewFailures.lastBuild === lastBuild ? 0 : 1) : 1;
      updateTask(state, manifest.snapshot.number, { status: 'parked', review: null, reviewBuild: null, reviewDispatch: null, error: platform.error(error), reviewFailures: { headSha: manifest.snapshot.headSha, mainSha: manifest.snapshot.mainSha, lastBuild, count }, blockedUntil: Date.now() + 10 * 60_000 });
    });
    throw error;
  } finally {
    // manifest is generated by trusted code; reject arbitrary cleanup locations before deleting anything.
    const prefix = resolve(root, '.delivery-review') + '/';
    if (typeof manifest.directory === 'string' && resolve(manifest.directory).startsWith(prefix)) await rm(manifest.directory, { recursive: true, force: true });
  }
}

export async function dispatchRecovery(platform, snapshot, reason) {
  const marker = `delivery-repair:${hash({ head: snapshot.headSha, main: snapshot.mainSha, reason }).slice(0, 24)}`;
  const reviews = await platform.call(`/-/pulls/${snapshot.number}/reviews`);
  const list = Array.isArray(reviews) ? reviews : reviews?.data;
  if (!Array.isArray(list)) throw new Error('Recovery review history is unreadable');
  if (list.some(review => String(review.body ?? '').includes(marker))) return { marker, recovered: true };
  const body = `@CodeBuddy 请在工作模式下接管这条 PR 的研发修复并提交到原任务分支。当前 source=${snapshot.headSha}，main=${snapshot.mainSha}。先读取本仓上下文、任务卡、真实失败检查和实际代码，再修复并运行相关回归。原因：${reason}。保留现有代码和真实依赖 ${JSON.stringify(snapshot.intent.dependsOn)}；只准普通提交，禁止 force push、删除分支、伪造检查/审批、降低既有门禁、碰真实资金/账户/生产秘密。解决冲突需按代码语义修复，不能整文件选 ours/theirs。修复后由独立 AI 评审和交付执行器继续，不等待用户点击批准。无法可靠修复就写明失败证据并保留分支。\n\n<!-- ${marker} -->`;
  // Genuine system NPC work mode. No approval is fabricated with a human token.
  const result = await platform.call(`/-/pulls/${snapshot.number}/reviews`, { method: 'POST', body: { event: 'comment', work_mode: true, body } });
  const after = await platform.call(`/-/pulls/${snapshot.number}/reviews`);
  const actual = Array.isArray(after) ? after : after?.data;
  if (!actual?.some(review => String(review.body ?? '').includes(marker))) throw new Error('Recovery dispatch could not be read back');
  return { marker, reviewId: result?.id ?? null, dispatchedAt: Date.now() };
}
