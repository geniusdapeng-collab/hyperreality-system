#!/usr/bin/env node
/**
 * oss-watch · 上游最新版本扫描器（联网、只读依赖、不改锁文件）
 *
 * 职责：
 *   ① 按周期刷新 oss-components.json 登记组件的上游最新版本（npm / PyPI / GitHub / Docker）；
 *   ② 按 TTL 刷新本仓全部直接依赖的上游最新版本缓存（.oss-watch-state.json#registry_cache）；
 *   ③ 重新生成 docs/OPEN_SOURCE_COMPONENTS.md（全量清单）与 docs/oss-update-plan.md（更新计划）。
 *
 * 用法：
 *   node scripts/oss-watch.mjs                # 到期组件 + 过期缓存刷新
 *   node scripts/oss-watch.mjs --all          # 忽略周期与 TTL，全量刷新
 *   node scripts/oss-watch.mjs --exit-zero    # 有更新也返回 0（定时任务用）
 *   node scripts/oss-watch.mjs --offline      # 不联网，只用现有缓存重算清单与计划
 *
 * 退出码：0=全部最新 / 2=有可用更新（提醒，非错误） / 1=执行错误
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAN_FILE,
  REGISTRY_FILE,
  STATE_FILE,
  buildInventory,
  compareVersions,
  renderMarkdown,
  repoIdentity,
  highestVersion,
  isOutdated,
  loadRegistry,
  loadState,
  normalizeVersion,
  probeVersions,
  resolveCurrent,
  upstreamObservation,
} from "./oss-inventory.mjs";

const DEFAULT_REGISTRY = "https://registry.npmmirror.com";
const DEFAULT_PYPI = "https://pypi.tuna.tsinghua.edu.cn/pypi";
const GITHUB_API = "https://api.github.com";
const CADENCE_SECONDS = { weekly: 7 * 86400, monthly: 30 * 86400, event: 3650 * 86400 };
const CACHE_TTL_SECONDS = 7 * 86400;
const CONCURRENCY = 8;

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fetchJson(url, { timeout = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "workloom-oss-watch/2.0", ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ 上游查询 ============================ */

export async function npmLatest(packageName, registry = DEFAULT_REGISTRY) {
  const url = `${registry}/${packageName.replace("/", "%2f")}/latest`;
  const data = await fetchJson(url);
  const repository =
    typeof data.repository === "string" ? data.repository : data.repository?.url ?? null;
  return {
    latest: data.version ?? null,
    license: data.license ?? null,
    repo: repository ? repository.replace(/^git\+/, "").replace(/\.git$/, "") : null,
    source: url,
  };
}

export async function pypiLatest(packageName, registry = DEFAULT_PYPI, { fallbackRegistry = "https://pypi.org/pypi" } = {}) {
  let data;
  let source = `${registry}/${packageName}/json`;
  try {
    data = await fetchJson(source);
  } catch (error) {
    if (!fallbackRegistry) throw error;
    source = `${fallbackRegistry}/${packageName}/json`;
    data = await fetchJson(source, { timeout: 45000 });
  }
  const info = data.info ?? {};
  const urls = info.project_urls ?? {};
  const repo =
    Object.entries(urls).find(([key]) => /source|repository|homepage|code/i.test(key))?.[1] ??
    info.home_page ??
    null;
  return { latest: info.version ?? null, license: info.license ?? null, repo, source };
}

export async function githubLatest(repoUrl, { tagPrefix = "" } = {}) {
  const match = String(repoUrl).match(/github\.com[/:]([^/\s)]+)\/([^/\s)#]+)/);
  if (!match) return { latest: null, repo: repoUrl };
  const slug = `${match[1]}/${match[2].replace(/\.git$/, "").replace(/（.*/, "")}`;
  try {
    const release = await fetchJson(`${GITHUB_API}/repos/${slug}/releases/latest`);
    if (release?.tag_name) return { latest: release.tag_name, repo: slug, source: `${GITHUB_API}/repos/${slug}/releases/latest` };
  } catch {
    /* 无 release 的仓库回退 tags */
  }
  const tags = await fetchJson(`${GITHUB_API}/repos/${slug}/tags?per_page=100`);
  const names = (Array.isArray(tags) ? tags : [])
    .map((tag) => tag.name)
    .filter((name) => (tagPrefix ? name.startsWith(tagPrefix) : true))
    .map((name) => (tagPrefix ? name.slice(tagPrefix.length) : name))
    .filter((name) => /^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(name));
  if (!names.length) throw new Error(`没有可识别的稳定版本标签：${slug}`);
  const sorted = names.sort((a, b) => compareVersions(a, b) ?? 0);
  return { latest: sorted[sorted.length - 1], repo: slug, source: `${GITHUB_API}/repos/${slug}/tags?per_page=100` };
}

/** Docker Hub 的真实 tags 通道。未声明镜像、不完整分页或无版本均不能报成功。 */
export async function dockerLatest(image, { tagPattern = "^v?(\\d+\\.\\d+(?:\\.\\d+)?)$", request = fetchJson } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(String(image ?? ""))) {
    throw new Error("docker 通道必须声明 registryImage=namespace/repository");
  }
  const matcher = new RegExp(tagPattern);
  const source = `https://hub.docker.com/v2/namespaces/${image.split('/')[0]}/repositories/${image.split('/')[1]}/tags`;
  const versions = [];
  const seen = new Set();
  let url = `${source}?page_size=100`;
  for (let page = 0; url && page < 100; page += 1) {
    if (seen.has(url) || new URL(url).origin !== "https://hub.docker.com" || !new URL(url).pathname.startsWith(new URL(source).pathname)) {
      throw new Error("docker tags 分页重复或逃逸来源");
    }
    seen.add(url);
    const data = await request(url);
    if (!Array.isArray(data.results)) throw new Error("docker tags 响应缺少 results");
    for (const tag of data.results) {
      const match = matcher.exec(String(tag.name ?? ""));
      if (match && tag.tag_status !== "inactive") versions.push(match[1] ?? match[0]);
    }
    url = data.next ? new URL(data.next, source).href : null;
  }
  if (url) throw new Error("docker tags 超出分页上限，无法核实最新版本");
  const latest = highestVersion(versions);
  if (!latest) throw new Error("docker tags 无匹配的稳定版本");
  return { latest, source, repo: `https://hub.docker.com/r/${image}` };
}

/* ============================ 扫描主流程 ============================ */

function dueFor(component, state, now) {
  const entry = state.components?.[component.name];
  if (entry?.status === "error" || entry?.status === "unverified") return true;
  const last = entry?.last_success ?? entry?.last_scan ?? 0;
  const cadence = CADENCE_SECONDS[component.cadence] ?? CADENCE_SECONDS.monthly;
  return now - last >= cadence;
}

function cacheFresh(entry, now, ttl) {
  return upstreamObservation(entry, { now, ttlSeconds: ttl }).verified;
}

export async function runWatch({ root, all = false, offline = false, exitZero = false, dryRun = false, log = console.log } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const iso = new Date(now * 1000).toISOString();
  const registry = loadRegistry(root);
  const state = loadState(root);
  state.schema = state.schema ?? "workloom.oss-watch-state/v2";
  state.components = state.components ?? {};
  state.registry_cache = state.registry_cache ?? {};

  const inventory = buildInventory(root);
  const pythonPackages = inventory.python.map((entry) => entry.package);
  const cacheTtl = all ? 0 : CACHE_TTL_SECONDS;

  const registryNpmPackages = registry.components
    .filter((component) => component.channel === "npm" && (component.registryPackage ?? component.package))
    .map((component) => component.registryPackage ?? component.package);
  const npmTargets = [...new Set([
    ...inventory.npm.packages.map((entry) => entry.package),
    ...registryNpmPackages,
  ])]
    .filter((name) => !name.startsWith("@workloom/"))
    .filter((name) => all || !cacheFresh(state.registry_cache[name], now, cacheTtl))
    .sort();
  const pypiTargets = [...new Set([...pythonPackages, ...registry.components.filter((c) => c.channel === "pypi" && c.package).map((c) => c.registryPackage ?? c.package)])]
    .filter((name) => all || !cacheFresh(state.registry_cache[name], now, cacheTtl))
    .sort();

  const failures = [];
  if (!offline) {
    log(`→ npm 上游查询 ${npmTargets.length} 个…`);
    await mapLimit(npmTargets, CONCURRENCY, async (name) => {
      try {
        const info = await npmLatest(name, arg("--npm-registry", DEFAULT_REGISTRY));
        if (!info.latest) throw new Error("npm 未返回 version");
        state.registry_cache[name] = {
          ecosystem: "npm",
          latest: info.latest,
          license: info.license,
          repo: info.repo,
          checked_at: now,
          checked_at_iso: iso,
          last_attempt: now, last_success: now, status: info.latest ? "ok" : "unverified",
          source: `${arg("--npm-registry", DEFAULT_REGISTRY)}/${name.replace("/", "%2f")}/latest`,
        };
      } catch (error) {
        state.registry_cache[name] = { ...state.registry_cache[name], last_attempt: now, status: "error", error: error.message };
        failures.push(`npm:${name} ${error.message}`);
      }
    });
    log(`→ PyPI 上游查询 ${pypiTargets.length} 个…`);
    await mapLimit(pypiTargets, CONCURRENCY, async (name) => {
      try {
        const info = await pypiLatest(name, arg("--pypi", DEFAULT_PYPI));
        if (!info.latest) throw new Error("PyPI 未返回 version");
        state.registry_cache[name] = {
          ecosystem: "pypi",
          latest: info.latest,
          license: info.license,
          repo: info.repo,
          checked_at: now,
          checked_at_iso: iso,
          last_attempt: now, last_success: now, status: info.latest ? "ok" : "unverified",
          source: info.source ?? `${arg("--pypi", DEFAULT_PYPI)}/${name}/json`,
        };
      } catch (error) {
        state.registry_cache[name] = { ...state.registry_cache[name], last_attempt: now, status: "error", error: error.message };
        failures.push(`pypi:${name} ${error.message}`);
      }
    });
  }

  /* 登记组件上游刷新（github / docker / vendor 通道 + 到期的 npm/pypi 覆盖） */
  const componentTargets = registry.components.filter(
    (component) =>
      !["vendor", "skill"].includes(component.channel) &&
      (all || dueFor(component, state, now)),
  );
  log(`→ 登记组件上游刷新 ${componentTargets.length} 个（GitHub releases/tags；Docker Hub tags；npm/PyPI 已成功缓存）…`);
  await mapLimit(componentTargets, 4, async (component) => {
    if (offline) return; // 离线重算绝不伪造联网成功时间。
    const previous = state.components[component.name] ?? {};
    const entry = { ...previous, channel: component.channel, last_attempt: now, last_attempt_iso: iso };
    state.components[component.name] = entry;
    try {
      let info;
      if (component.channel === "github" && component.repo) info = await githubLatest(component.repo, { tagPrefix: component.tag_prefix ?? "" });
      else if (component.channel === "docker") info = await dockerLatest(component.registryImage, { tagPattern: component.tag_pattern });
      else if (["npm", "pypi"].includes(component.channel)) {
        info = state.registry_cache[component.registryPackage ?? component.package];
        if (!info || info.status === "error" || !cacheFresh(info, now, CACHE_TTL_SECONDS)) throw new Error("没有本次或TTL内成功核实的上游缓存");
      } else throw new Error(`未实现的上游通道：${component.channel}`);
      if (!info.latest) throw new Error("上游未返回可用版本");
      Object.assign(entry, { last_scan: now, last_scan_iso: iso, last_success: now, last_success_iso: iso, status: "ok", error: null, source: info.source, latest_seen: info.latest });
      component.latest = info.latest;
      component.latest_checked_at = iso;
      if (info.license && !component.license) component.license = info.license;
      if (info.repo && !component.repo) component.repo = info.repo;
    } catch (error) {
      entry.status = component.channel === "docker" && !component.registryImage ? "unverified" : "error";
      entry.error = error.message;
      failures.push(`${component.channel}:${component.name} ${error.message}`);
    }
  });

  /* 写回登记表（current 只随升级 PR 改写：扫描器不直接改包版本） */
  const registryPath = join(root, REGISTRY_FILE);
  registry.meta = { ...registry.meta, updated: iso.slice(0, 10) };
  if (!dryRun) writeFileSync(
    registryPath,
    `${JSON.stringify({ meta: registry.meta, components: registry.components }, null, 2)}\n`,
  );

  if (!offline) {
    state.last_attempt = iso;
    if (!failures.length) { state.last_full_scan = iso; state.last_full_scan_epoch = now; state.last_success = iso; }
  }
  state.registry = { npm: DEFAULT_REGISTRY, pypi: DEFAULT_PYPI, github: "api.github.com" };
  if (!dryRun) writeFileSync(join(root, STATE_FILE), `${JSON.stringify(state, null, 1)}\n`);

  /* 重新生成全量清单 + 更新计划 */
  const content = renderMarkdown({ root, repo: repoIdentity(root), registry, inventory, state });
  const plan = renderPlan({ root, registry, inventory, state, iso });
  if (!dryRun) {
    writeFileSync(join(root, registry.meta?.doc ?? "docs/OPEN_SOURCE_COMPONENTS.md"), content);
    writeFileSync(join(root, PLAN_FILE), plan.content);
  }

  const summary = {
    scannedAt: iso,
    npmQueried: npmTargets.length,
    pypiQueried: pypiTargets.length,
    componentUpdates: plan.updates.length,
    dependencyUpdates: plan.dependencyUpdates.length,
    failures,
    status: failures.length ? "unverified" : offline ? "offline" : "ok",
    dryRun,
    plannedFiles: [REGISTRY_FILE, STATE_FILE, registry.meta?.doc ?? "docs/OPEN_SOURCE_COMPONENTS.md", PLAN_FILE],
  };
  log(
    `[oss-watch] 刷新完成：登记组件更新 ${summary.componentUpdates} 个，直接依赖更新 ${summary.dependencyUpdates} 个，失败 ${failures.length} 个`,
  );
  for (const failure of failures.slice(0, 10)) log(`  ⚠ ${failure}`);
  log(`[oss-watch] 清单 → docs/OPEN_SOURCE_COMPONENTS.md；计划 → ${PLAN_FILE}`);

  const hasUpdates = summary.componentUpdates > 0 || summary.dependencyUpdates > 0;
  return { summary, exitCode: failures.length ? 1 : hasUpdates && !exitZero ? 2 : 0 };
}

/* ============================ 更新计划 ============================ */

export function renderPlan({ root, registry, inventory, state, iso }) {
  const probes = root ? probeVersions(root, registry.components) : {};
  const updates = [];
  for (const component of registry.components) {
    if (!upstreamObservation(state.components?.[component.name], { ttlSeconds: CADENCE_SECONDS[component.cadence] ?? CADENCE_SECONDS.monthly }).verified) continue;
    if (!component.latest) continue;
    const resolved = root
      ? resolveCurrent(component, inventory, probes)
      : { current: component.current ?? null };
    const current = highestVersion(String(resolved.current ?? "").split(" / ")) ?? resolved.current;
    if (current && isOutdated(current, component.latest)) {
      updates.push({ component, current, latest: component.latest });
    }
  }
  const vendorOnly = (entry) =>
    entry.importers.length > 0 && entry.importers.every((importer) => importer.startsWith("vendor/"));
  const dependencyUpdates = [];
  for (const entry of inventory.npm.packages) {
    if (!upstreamObservation(state.registry_cache?.[entry.package]).verified) continue;
    const latest = state.registry_cache?.[entry.package]?.latest;
    const current = highestVersion(entry.versions);
    if (!latest || !current || !isOutdated(current, latest)) continue;
    if (vendorOnly(entry)) {
      dependencyUpdates.push({
        name: entry.name,
        current,
        latest,
        kinds: entry.kinds,
        note: "随 dsh 批次",
      });
      continue;
    }
    dependencyUpdates.push({ name: entry.name, current, latest, kinds: entry.kinds });
  }
  const pythonUpdates = [];
  for (const entry of inventory.python) {
    if (!upstreamObservation(state.registry_cache?.[entry.package]).verified) continue;
    const latest = state.registry_cache?.[entry.package]?.latest;
    const pinned = entry.specifier.includes("==") || entry.specifier.includes("~=");
    if (latest && pinned && entry.versions[0] && isOutdated(entry.versions[0], latest)) {
      pythonUpdates.push({ name: entry.package, current: entry.versions[0], latest });
    }
  }

  const lines = [];
  lines.push("# 开源组件更新计划（oss-watch）");
  lines.push("");
  lines.push(
    `> 生成：${iso} ｜ 登记组件有更新 **${updates.length}** 个 ｜ 直接依赖有更新 **${dependencyUpdates.length + pythonUpdates.length}** 个`,
  );
  lines.push("> 使用：Agent 按清单组批 → 逐项升级 → 按 gate 过门禁 → 门禁全绿后按协议 §1/§9.5 合并。破坏性/大版本升级须在 PR 显著标注并按 §3 人审放行；人保留叫停与回滚权。");
  lines.push("");
  if (updates.length) {
    lines.push("## 一、登记组件更新（待处理：AI 组批执行，破坏性升级人审放行）");
    lines.push("");
    lines.push("| 组件 | 现版 | 最新 | 周期 | 门禁 | 备注 |");
    lines.push("|---|---|---|---|---|---|");
    for (const item of updates) {
      lines.push(
        `| \`${item.component.name}\` | ${item.current} | **${item.latest}** | ${item.component.cadence ?? "monthly"} | ${item.component.gate ?? "—"} | ${(item.component.notes ?? "").replace(/\|/g, "\\|").slice(0, 60)} |`,
      );
    }
    lines.push("");
    lines.push("## 二、执行剧本（逐项）");
    lines.push("");
    lines.push("1. 每项单独 commit：`pnpm update <pkg>@<latest>`（工作区包用 `pnpm -C <包目录> update`）→ 更新 `oss-components.json` 的 current");
    lines.push("2. 门禁：smoke=`pnpm typecheck`｜standard=+`pnpm test`｜full=+`pnpm suite`｜runtime-gate=+`bash scripts/dsh-gate.sh`");
    lines.push("3. 失败立即回滚该批并在本文件标「⛔ 阻塞」；全绿 → push 并标「✅ 已发布(hash)」");
    lines.push("4. dsh 永远单独一批；发布前建议先做仓库快照（git bundle）");
    lines.push("");
    lines.push("## 三、新能力评估（人工裁决区 · 大版本升级必填）");
    lines.push("");
    lines.push("> 底层升级常带来新能力而非仅修复。下列大跨度项请逐项评估「能否产品化」，结论写回本文件。");
    lines.push("");
    lines.push("| 组件 | 跨度 | 发布说明 | 新能力线索与产品化设想（人工填写） |");
    lines.push("|---|---|---|---|");
    for (const item of updates) {
      const major = (value) => Number.parseInt(String(value).replace(/^v/, ""), 10) || 0;
      const span = major(item.latest) > major(item.current) ? "⚠ major" : "minor/patch";
      lines.push(`| \`${item.component.name}\` | ${item.current} → ${item.latest}（${span}） | 见 repo releases |  |`);
    }
    lines.push("");
  } else {
    lines.push(Object.values(state.components ?? {}).some(entry => entry.status === "error" || entry.status === "unverified")
      ? "## 没有可据本次扫描判定的更新；仍有上游未核实项"
      : "## 已核实记录未发现可用更新（未登记或未扫描项不在此结论内）");
    lines.push("");
  }
  if (dependencyUpdates.length || pythonUpdates.length) {
    lines.push("## 四、直接依赖更新（全量清单扫描结果）");
    lines.push("");
    lines.push("| 包 | 现版 | 最新 | 类型 | 备注 |");
    lines.push("|---|---|---|---|---|");
    for (const item of dependencyUpdates) {
      lines.push(
        `| \`${item.name}\` | ${item.current} | ${item.latest} | ${item.kinds.join("/")} | ${item.note ?? "—"} |`,
      );
    }
    for (const item of pythonUpdates) {
      lines.push(`| \`${item.name}\` | ${item.current} | ${item.latest} | python | — |`);
    }
    lines.push("");
    lines.push("> 说明：直接依赖含传递层升级线索；批量升级前先按「登记组件」批次处理运行时关键路径，避免一次跨度过大。");
    lines.push("");
  }
  const stale = Object.entries(state.registry_cache ?? {})
    .filter(([, entry]) => !entry?.latest || !upstreamObservation(entry).verified)
    .map(([name]) => name);
  if (stale.length) {
    lines.push("## 附：复核项（未取到上游版本；AI 重试 / 人工兜底）");
    lines.push("");
    for (const name of stale.sort()) lines.push(`- \`${name}\`：上游查询失败或需人工核对`);
    lines.push("");
  }
  return { content: `${lines.join("\n")}\n`, updates, dependencyUpdates, pythonUpdates };
}

/* ============================ CLI ============================ */

async function main() {
  const root = resolve(process.env.OSS_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const { exitCode } = await runWatch({
    root,
    all: has("--all"),
    offline: has("--offline"),
    exitZero: has("--exit-zero"),
    dryRun: has("--dry-run"),
  });
  process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`✗ oss-watch 执行失败：${error?.stack ?? error}`);
    process.exit(1);
  });
}
