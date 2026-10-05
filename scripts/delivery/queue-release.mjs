/** Release queue is independent of integration. Completion requires source, build and byte receipts. */
import { createHash } from 'node:crypto';
import { appendEvent, releaseKey, SHA_RE, updateTask } from './queue-model.mjs';

export function releaseEventFor(kind) {
  if (!['ui', 'desktop'].includes(kind)) throw new Error('Unknown release kind');
  return kind === 'ui' ? 'api_trigger_ui_release' : 'api_trigger_desktop_release';
}
export function enqueueReleases(state, repo, task, now = Date.now()) {
  for (const intent of task.intent?.releases ?? []) {
    const version = intent.kind === 'ui' ? intent.version.replace(/^v/, '') : `v${intent.version.replace(/^v/, '')}`;
    const identity = { repo, sha: task.merge.sha, kind: intent.kind, version };
    const key = releaseKey(identity);
    if (state.releases[key]) continue;
    state.releases[key] = { key, ...identity, number: task.number, status: 'pending', attempts: 0, createdAt: now, builds: [] };
    appendEvent(state, 'release_enqueued', identity, now);
  }
}

async function bytes(repo, tag, name, { maximum = 1024 * 1024 * 1024, json = false } = {}) {
  const response = await fetch(`https://cnb.cool/${repo}/-/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Release download failed: ${name} HTTP ${response.status}`);
  const digest = createHash('sha512'); let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error(`Release asset exceeds limit: ${name}`);
    digest.update(chunk);
    if (json) chunks.push(chunk);
  }
  const hex = digest.digest('hex');
  return { name, size, sha512: hex, sri: `sha512-${Buffer.from(hex, 'hex').toString('base64')}`, ...(json ? { data: JSON.parse(Buffer.concat(chunks).toString('utf8')) } : {}) };
}

export async function verifyRelease(platform, release, download = bytes) {
  if (!release.build?.sn) throw new Error('Release has no actual build receipt');
  const key = release.key ?? releaseKey({ repo: platform.repo, sha: release.sha, kind: release.kind, version: release.version });
  const actualBuild = (await releaseBuilds(platform, release)).filter(build => build.sn === release.build.sn && build.sha === release.sha && build.event === releaseEventFor(release.kind) && build.title === `WorkLoom release ${key}`);
  if (actualBuild.length !== 1) throw new Error('Release build source/event/intent did not read back');
  const tag = release.kind === 'ui' ? `ui-v${release.version}` : release.version;
  const metadata = await platform.call(`/-/releases/tags/${encodeURIComponent(tag)}`);
  const source = await platform.call(`/-/git/commits/${encodeURIComponent(tag)}`);
  if (!metadata?.id || metadata.draft === true || source.sha !== release.sha) throw new Error('Release tag/source identity mismatch');
  let assets;
  if (release.kind === 'ui') {
    // Platform.call uses the API transport, which already decodes successful JSON responses.
    const registration = await platform.call(`/-/git/raw/${release.sha}/sync/base-capabilities.json`);
    if (!registration || typeof registration !== 'object' || Array.isArray(registration)) throw new Error('UI registration unreadable');
    const asset = await download(platform.repo, tag, `workloom-ui-${release.version}.tgz`);
    if (registration.ui?.latestStableVersion !== release.version || registration.ui?.distribution?.integrityByVersion?.[release.version] !== asset.sri) throw new Error('Published UI bytes differ from reviewed registration');
    assets = [asset];
  } else {
    const manifest = await download(platform.repo, tag, 'WorkLoom-release-manifest.json', { maximum: 1024 * 1024, json: true });
    const expected = ['WorkLoom-mac-arm64.dmg', 'WorkLoom-mac-x64.dmg', 'WorkLoom-win-x64.exe'];
    if (manifest.data.schemaVersion !== 1 || manifest.data.tag !== tag || manifest.data.sourceSha !== release.sha || !Array.isArray(manifest.data.assets) || manifest.data.assets.length !== expected.length) throw new Error('Desktop release manifest/source is incomplete');
    assets = [];
    for (const name of expected) {
      const record = manifest.data.assets.filter(asset => asset.name === name);
      if (record.length !== 1 || !Number.isSafeInteger(record[0].size) || record[0].size <= 0 || !/^[a-f0-9]{128}$/.test(record[0].sha512 ?? '')) throw new Error('Desktop manifest digest/size is invalid');
      const actual = await download(platform.repo, tag, name);
      if (actual.size !== record[0].size || actual.sha512 !== record[0].sha512) throw new Error(`Desktop byte receipt mismatch: ${name}`);
      assets.push(actual);
    }
  }
  return { releaseId: metadata.id, tag, sha: source.sha, build: release.build?.sn ?? null, assets, verifiedAt: new Date().toISOString() };
}

async function releaseBuilds(platform, release) {
  const data = await platform.call(`/-/build/logs?event=${releaseEventFor(release.kind)}&sha=${release.sha}&page_size=100`);
  if (!Array.isArray(data?.data) || !Number.isSafeInteger(data.total)) throw new Error('Release build history unreadable');
  if (data.total > 100) throw new Error('Release build history is too large to reconcile safely');
  return data.data;
}

/** One launch per release environment, while failed releases do not hold the integration lock. */
export async function reconcileReleases({ platform, store, now = Date.now(), verify = verifyRelease }) {
  const report = [];
  let state = await store.read();
  for (const kind of ['ui', 'desktop']) {
    const queue = Object.values(state.releases).filter(item => item.kind === kind && item.status !== 'delivered').sort((a, b) => a.createdAt - b.createdAt);
    if (!queue.length) continue;
    const item = queue[0];
    try {
      if (item.status === 'launching' || item.status === 'unknown') {
        const matches = (await releaseBuilds(platform, item)).filter(build => !item.knownBuilds.includes(build.sn) && build.sha === item.sha && build.event === releaseEventFor(item.kind) && build.title === `WorkLoom release ${item.key}`);
        if (matches.length !== 1 || !matches[0].sn) {
          report.push({ kind, status: 'unknown', key: item.key, reason: 'Launch acknowledgement cannot be resolved; no duplicate launch' });
          continue;
        }
        await store.mutate(current => {
          current.releases[item.key] = { ...current.releases[item.key], status: 'running', build: { sn: matches[0].sn }, launchedAt: now };
          appendEvent(current, 'release_launch_recovered', { key: item.key, sn: matches[0].sn }, now);
        });
        state = await store.read();
      }
      const release = state.releases[item.key];
      if (release.status === 'running') {
        const status = await platform.call(`/-/build/status/${encodeURIComponent(release.build.sn)}`);
        if (status.status === 'success') {
          const receipt = await verify(platform, release);
          await store.mutate(current => {
            current.releases[item.key] = { ...current.releases[item.key], status: 'delivered', receipt };
            appendEvent(current, 'release_verified', { key: item.key, receipt }, now);
            const task = current.tasks[String(item.number)];
            if (task && Object.values(current.releases).filter(r => r.number === task.number).every(r => r.status === 'delivered')) updateTask(current, task.number, { status: 'delivered' }, now);
          });
          report.push({ kind, status: 'delivered', receipt });
        } else if (['error', 'cancel'].includes(status.status)) {
          await store.mutate(current => {
            current.releases[item.key] = { ...current.releases[item.key], status: release.attempts < 2 ? 'pending' : 'parked', retryAfter: now + 5 * 60_000, error: `Build ${release.build.sn}: ${status.status}` };
            appendEvent(current, 'release_failed', { key: item.key, sn: release.build.sn, status: status.status }, now);
          });
          report.push({ kind, status: 'failed', sn: release.build.sn });
        } else if (now - release.launchedAt > 6 * 60 * 60_000) {
          // Never start another deployment while an old writer is still running.
          report.push({ kind, status: 'timeout_running', sn: release.build.sn });
        } else report.push({ kind, status: 'running', sn: release.build.sn });
        continue;
      }
      if (release.status !== 'pending' || (release.retryAfter ?? 0) > now) continue;
      if (!SHA_RE.test(release.sha)) throw new Error('Invalid frozen release source');
      const knownBuilds = (await releaseBuilds(platform, release)).map(build => build.sn);
      await store.mutate(current => {
        current.releases[item.key] = { ...current.releases[item.key], status: 'launching', knownBuilds, attempts: release.attempts + 1, launchIntentAt: now };
        appendEvent(current, 'release_launch_intent', { key: item.key, sha: release.sha, attempt: release.attempts + 1 }, now);
      });
      const build = await platform.call('/-/build/start', { method: 'POST', body: {
        branch: 'main', sha: release.sha, event: releaseEventFor(kind), sync: 'false', title: `WorkLoom release ${item.key}`,
        env: { DELIVERY_RELEASE_ID: item.key, RELEASE_EXPECTED_SHA: release.sha, CNB_REPO: platform.repo, ...(kind === 'ui' ? { UI_VERSION: release.version } : { DESKTOP_RELEASE_VERSION: release.version }) },
      } });
      if (!build?.success || !build.sn) throw new Error('Release start has no real build acknowledgement');
      await store.mutate(current => {
        current.releases[item.key] = { ...current.releases[item.key], status: 'running', build, launchedAt: now, builds: [...current.releases[item.key].builds, build.sn] };
        appendEvent(current, 'release_started', { key: item.key, sn: build.sn }, now);
      });
      report.push({ kind, status: 'running', sn: build.sn });
    } catch (error) {
      const latest = (await store.read()).releases[item.key];
      const uncertain = latest.status === 'launching';
      await store.mutate(current => {
        current.releases[item.key] = { ...current.releases[item.key], status: uncertain ? 'unknown' : 'parked', error: platform.error(error) };
        appendEvent(current, 'release_error', { key: item.key, uncertain, error: platform.error(error) }, now);
      });
      report.push({ kind, status: uncertain ? 'unknown' : 'parked', error: platform.error(error) });
    }
    state = await store.read();
  }
  return report;
}
