/**
 * 舰队识别与纳管规则（纯函数，可单测）。
 *
 * 判定"是不是 WorkLoom 仓"：仓库根存在 product.manifest.json 且 schemaVersion 以 workloom.product/ 开头；
 * 若没有 manifest，则退化为检查 .workloom-base-sync.json 或 bundles/*\/bundle.json 的 schemaVersion/name。
 */

export const WORKLOOM_MANIFEST_SCHEMA_PREFIX = "workloom.product/";

export function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @returns {{isWorkloom: boolean, productId?: string, role?: string, displayName?: string, reason: string}}
 */
export function classifyRepo({ manifestText, baseSyncText, bundleText } = {}) {
  const manifest = parseJsonSafe(manifestText);
  if (manifest && String(manifest.schemaVersion ?? "").startsWith(WORKLOOM_MANIFEST_SCHEMA_PREFIX)) {
    return {
      isWorkloom: true,
      productId: manifest.productId,
      role: manifest.role,
      displayName: manifest.displayName,
      reason: "product.manifest.json",
    };
  }
  const state = parseJsonSafe(baseSyncText);
  if (state && (state.baseRepo || state.lastRequiredAssetsBaseSha)) {
    return { isWorkloom: true, role: "unknown", reason: ".workloom-base-sync.json" };
  }
  const bundle = parseJsonSafe(bundleText);
  if (bundle && String(bundle.schemaVersion ?? "").startsWith("workloom.bundle/")) {
    return { isWorkloom: true, role: "unknown", reason: "bundles/*/bundle.json" };
  }
  return { isWorkloom: false, reason: "无 WorkLoom 标记" };
}

const asJson = (value) => (typeof value === "string" ? parseJsonSafe(value) : value);

/**
 * 隔离副本集合（`sync/child-repos.json#isolatedRepos`）。
 * 隔离副本既不接收基座下发，也不向基座回流：舰队扫描不纳管、fanout 不分发、纳管脚本拒绝执行。
 * @returns {Set<string>}
 */
export function isolatedFleet(childReposJson) {
  const parsed = asJson(childReposJson);
  const isolated = new Set();
  for (const entry of parsed?.isolatedRepos ?? []) {
    if (entry?.repo) isolated.add(entry.repo);
  }
  return isolated;
}

/** 单个仓是否被登记为隔离副本 */
export function isIsolated(slug, childReposJson) {
  return isolatedFleet(childReposJson).has(slug);
}

/** 已纳管集合 = 基座仓 + sync/child-repos.json 的 children + 已登记的隔离副本 */
export function knownFleet(baseRepo, childReposJson) {
  const parsed = asJson(childReposJson);
  const known = new Set();
  if (baseRepo) known.add(baseRepo);
  for (const child of parsed?.children ?? []) {
    if (child?.repo) known.add(child.repo);
  }
  for (const repo of isolatedFleet(parsed)) known.add(repo);
  return known;
}

/**
 * 舰队差分：已纳管（订阅）/ 隔离副本 / 新发现 WorkLoom 仓 / 非 WorkLoom 仓。
 * 隔离副本必须从“新发现”里剔除，否则每日舰队扫描会重复给它们开纳管 PR。
 * @param {{repos: string[], classifications: object, known: Set<string>|string[], isolated?: Set<string>|string[]}} input
 * @returns {{known: string[], isolated: string[], newWorkloom: object[], unrelated: string[]}}
 */
export function diffFleet({ repos, classifications, known, isolated = new Set() }) {
  const isolatedSet = isolated instanceof Set ? isolated : new Set(isolated);
  const knownList = [];
  const isolatedList = [];
  const newWorkloom = [];
  const unrelated = [];
  for (const repo of repos) {
    const verdict = classifications[repo] ?? { isWorkloom: false, reason: "未检查" };
    if (!verdict.isWorkloom) {
      unrelated.push(repo);
      continue;
    }
    if (isolatedSet.has(repo)) isolatedList.push(repo);
    else if (known.has(repo)) knownList.push(repo);
    else newWorkloom.push({ repo, ...verdict });
  }
  return { known: knownList, isolated: isolatedList, newWorkloom, unrelated };
}

/** 仓库短名 → 协议提交 layer（与 protocol-rules 的 LAYER_BY_REPO 同源，额外支持未知仓回退） */
export function layerForFleetRepo(slug, layerByRepo) {
  const name = String(slug ?? "").split("/").pop().toLowerCase();
  for (const [repoName, layer] of Object.entries(layerByRepo)) {
    if (repoName.toLowerCase() === name) return layer;
  }
  return null;
}
