import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './git-state.mjs';
import { branchName } from './queue-model.mjs';

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

export async function prepareReview() {
  throw new Error('Platform AI is disabled. Use a review receipt from the current Codex session.');
}

export async function finishReview() {
  throw new Error('Platform AI is disabled. No platform approval is required or published.');
}

export async function dispatchRecovery() {
  throw new Error('Platform AI is disabled. Repair the original task in the current Codex session; no NPC work-mode request was sent.');
}
