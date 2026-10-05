import { api, redactCredentials } from '../tools/cnb-api.mjs';
import { SHA_RE, parseIntent, checksVerdict, hash, validRepoSlug } from './queue-model.mjs';
import { ciImplementationChanges, readableCiChanges, sourcePipelineReport } from './queue-policy.mjs';

function labelSignature(labels) {
  if (!Array.isArray(labels)) throw new Error('Platform label set is unreadable');
  const names = labels.map(label => typeof label === 'string' ? label : label?.name);
  if (names.some(name => typeof name !== 'string' || !name) || new Set(names).size !== names.length) throw new Error('Platform label set is invalid');
  return JSON.stringify(names.sort());
}

export class Platform {
  constructor(repo, token, request = api) {
    if (!validRepoSlug(repo)) throw new Error('Invalid repository slug');
    this.repo = repo; this.token = token; this.request = request;
  }
  call(path, options = {}) { return this.request(this.repo, path, { token: this.token, retries: options.method && options.method !== 'GET' ? 0 : 2, ...options }); }
  async pull(number) {
    const pull = await this.call(`/-/pulls/${Number(number)}`);
    const actual = Number(pull?.number);
    if (!Number.isSafeInteger(actual) || actual !== Number(number) || actual <= 0) throw new Error('Platform PR identity is invalid');
    return { ...pull, number: actual };
  }
  main() { return this.call('/-/git/branches/main'); }
  commit(sha) {
    if (!SHA_RE.test(sha ?? '')) throw new Error('Invalid commit SHA');
    return this.call(`/-/git/commits/${sha}`);
  }
  async list(path, key = 'data') {
    const all = []; const seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const result = await this.call(`${path}${path.includes('?') ? '&' : '?'}page_size=100&page=${page}`);
      const list = Array.isArray(result) ? result : result?.[key];
      if (!Array.isArray(list)) throw new Error('Invalid paginated platform result');
      for (const item of list) {
        const id = String(item.number ?? item.id ?? '');
        if (!id || seen.has(id)) throw new Error('Repeated/missing pagination identity');
        seen.add(id); all.push(item.number === undefined ? item : { ...item, number: Number(item.number) });
      }
      if (list.length < 100) return all;
    }
    throw new Error('Platform pagination limit exceeded');
  }
  pulls() { return this.list('/-/pulls?state=open&base_ref=main'); }
  async builds(sha, event) {
    const all = []; const seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const result = await this.call(`/-/build/logs?sha=${encodeURIComponent(sha)}&event=${encodeURIComponent(event)}&page_size=100&page=${page}`);
      if (!Array.isArray(result?.data)) throw new Error('Build history is unreadable');
      for (const build of result.data) {
        if (!build.sn || seen.has(build.sn)) throw new Error('Build history identity is ambiguous');
        seen.add(build.sn); all.push(build);
      }
      if (result.data.length < 100) return all;
    }
    throw new Error('Build history exceeds recovery bounds');
  }
  protections() { return this.list('/-/settings/branch-protections'); }
  async snapshot(number, policy, { checks = true } = {}) {
    const pull = await this.pull(number);
    const main = await this.main();
    const headSha = pull.head?.sha; const mainSha = main.commit?.sha;
    if (!SHA_RE.test(headSha ?? '') || !SHA_RE.test(mainSha ?? '')) throw new Error('Platform source/main is incomplete');
    const compare = await this.call(`/-/git/compare/${mainSha}...${headSha}`);
    if (compare.base_commit?.sha !== mainSha || compare.head_commit?.sha !== headSha || !Array.isArray(compare.files)) throw new Error('Compare identity is incomplete');
    const files = compare.files.map(f => f.path ?? f.name);
    if (files.some(p => typeof p !== 'string' || !p || p.includes('\0'))) throw new Error('Invalid compare path');
    const headCommit = await this.commit(headSha);
    let checkErrors = []; let hasFailedChecks = false;
    let checkSha = null;
    let ciPolicyChanges = [];
    if (Array.isArray(policy.requiredPipelines)) {
      const sourceYaml = await this.call(`/-/git/raw/${headSha}/.cnb.yml`);
      if (typeof sourceYaml !== 'string') throw new Error('Source CI configuration is unreadable');
      const report = await sourcePipelineReport(sourceYaml, policy, { mainSha, headSha, changedFiles: compare.files, readLocal: path => this.call(`/-/git/raw/${headSha}/${path}`) });
      checkErrors.push(...report.errors); ciPolicyChanges = readableCiChanges([...report.changes, ...ciImplementationChanges(compare.files, mainSha, headSha, [...(policy.ciFiles ?? []), ...(report.ciFiles ?? [])])]);
    }
    if (checks) {
      const payload = await this.call(`/-/pulls/${number}/commit-statuses`);
      hasFailedChecks = Array.isArray(payload?.statuses) && payload.statuses.some(status => policy.requiredNames.some(name => String(status.context ?? '').startsWith('cnb/pull_request/') && String(status.context).endsWith(`(${name})`)) && ['error', 'failure', 'cancel'].includes(status.state));
      checkSha = payload.sha;
      if (!SHA_RE.test(checkSha ?? '')) checkErrors.push('Missing tested commit');
      else checkErrors.push(...checksVerdict(payload, await this.commit(checkSha), { headSha, mainSha }, policy.requiredNames));
    }
    const [finalPull, finalMain] = await Promise.all([this.pull(number), this.main()]);
    if (finalPull.head?.sha !== headSha || finalPull.base?.sha !== pull.base?.sha || finalMain.commit?.sha !== mainSha || finalPull.state !== pull.state || finalPull.head?.ref !== pull.head?.ref || finalPull.base?.ref !== pull.base?.ref || labelSignature(finalPull.labels) !== labelSignature(pull.labels) || finalPull.is_wip !== pull.is_wip || finalPull.body !== pull.body) throw new Error('Platform snapshot changed while reading');
    return { number: Number(number), pull: finalPull, headSha, mainSha, files, intent: parseIntent(finalPull), headTime: Date.parse(headCommit.commit?.committer?.date ?? headCommit.commit?.author?.date), mergeBase: compare.merge_base_commit?.sha, checkErrors, checkSha, hasFailedChecks, ciPolicyChanges };
  }

  async assertCandidateProtection() {
    const rule = (await this.protections()).find(rule => rule.rule === 'delivery/candidate/**');
    if (!rule || rule.allow_creation !== true || rule.allow_master_creation !== true ||
      ['allow_pushes', 'allow_master_pushes', 'allow_force_pushes', 'allow_master_force_pushes', 'allow_deletions', 'allow_master_deletions'].some(key => rule[key] !== false)) throw new Error('Immutable candidate protection missing/changed');
    return rule;
  }

  async ensureCandidate(snapshot) {
    await this.assertCandidateProtection();
    const branch = `delivery/candidate/pr-${snapshot.number}-${hash({ head: snapshot.headSha, main: snapshot.mainSha }).slice(0, 32)}`;
    const path = `/-/git/branches/${encodeURIComponent(branch)}`;
    try { await this.call('/-/git/branches', { method: 'POST', body: { name: branch, start_point: snapshot.headSha } }); }
    catch (error) {
      // Creation is idempotent by immutable branch name. Never replace an existing ref.
      const existing = await this.call(path);
      if (existing.commit?.sha !== snapshot.headSha || existing.protected !== true) throw error;
    }
    const actual = await this.call(path);
    if (actual.commit?.sha !== snapshot.headSha || actual.protected !== true) throw new Error('Candidate source identity/protection mismatch');
    const marker = `delivery-origin:${snapshot.number}:${snapshot.headSha}:${snapshot.mainSha}`;
    const list = await this.list('/-/pulls?state=all&base_ref=main');
    let candidate = list.find(p => String(p.head?.ref ?? '').replace(/^refs\/heads\//, '') === branch);
    if (!candidate) {
      const intent = { ready: true, depends_on: snapshot.intent.dependsOn, releases: [] };
      const body = `Immutable delivery candidate for #${snapshot.number}. Exact source ${snapshot.headSha}; tested main ${snapshot.mainSha}.\n\n<!-- ${marker} -->\n\n<!-- workloom-delivery\n${JSON.stringify(intent)}\n-->`;
      try { candidate = await this.call('/-/pulls', { method: 'POST', body: { head: branch, base: 'main', title: `chore(ci): deliver #${snapshot.number} ${String(snapshot.pull.title).slice(0, 100)}`, body } }); }
      catch (error) {
        candidate = (await this.list('/-/pulls?state=all&base_ref=main')).find(p => String(p.head?.ref ?? '').replace(/^refs\/heads\//, '') === branch);
        if (!candidate) throw error;
      }
    }
    if (!Number.isSafeInteger(Number(candidate.number)) || Number(candidate.number) <= 0) throw new Error('Candidate PR creation receipt lacks an identity');
    candidate = await this.pull(Number(candidate.number));
    if (candidate.head?.sha !== snapshot.headSha || !String(candidate.body).includes(marker)) throw new Error('Candidate PR did not match immutable source intent');
    return { number: candidate.number, branch, headSha: snapshot.headSha, mainSha: snapshot.mainSha, marker };
  }

  async merge(snapshot) {
    return this.call(`/-/pulls/${snapshot.number}/merge`, { method: 'PUT', body: { merge_style: 'merge', force: false, commit_title: `${String(snapshot.pull.title).trim()} (#${snapshot.number})`, commit_message: `WorkLoom delivery\nReviewed source: ${snapshot.headSha}\nTested main: ${snapshot.mainSha}` } });
  }

  async verifyMerge(snapshot, result) {
    const after = await this.pull(snapshot.number);
    if (after.is_merged !== true || after.head?.sha !== snapshot.headSha) throw new Error('Merge receipt did not match reviewed source');
    const sha = result?.sha;
    if (!SHA_RE.test(sha ?? '')) throw new Error('Merged commit SHA unavailable; recovery must resolve it before completion');
    const commit = await this.commit(sha);
    const parents = commit.parents?.map(parent => parent.sha) ?? [];
    if (parents.length !== 2 || parents[0] !== snapshot.mainSha || parents[1] !== snapshot.headSha) throw new Error('Merge parents differ from the tested source/main pair');
    return { sha, sourceSha: snapshot.headSha, mainSha: snapshot.mainSha, checkSha: snapshot.checkSha, mergedBy: after.merged_by?.username ?? null, verifiedAt: new Date().toISOString() };
  }

  async comment(number, body) { return this.call(`/-/pulls/${number}/comments`, { method: 'POST', body: { body } }); }
  error(error) { return redactCredentials(error.message ?? error, this.token).slice(0, 800); }
}
