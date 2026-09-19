/**
 * CNB 平台 API 封装（无外部依赖，Node 24 自带 fetch）。
 * 供 fleet-scan.mjs / provision-protocol.mjs / task.mjs 共用。
 * 令牌来源：环境变量 CNB_TOKEN（CI 内自动注入；本地使用个人令牌）。
 */

export const API_BASE = "https://api.cnb.cool";
export const WEB_BASE = "https://cnb.cool";

export class CnbError extends Error {
  constructor(status, body, url) {
    super(`CNB ${status} ${url} :: ${String(body).slice(0, 200)}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function requireToken() {
  const token = process.env.CNB_TOKEN;
  if (!token) throw new Error("缺少 CNB_TOKEN（CI 流水线内自动注入；本地请用个人令牌导出到环境变量）");
  return token;
}

export async function api(slug, path, options = {}) {
  const { method = "GET", body, token = requireToken(), accept = "application/json" } = options;
  const url = path.startsWith("http") ? path : `${API_BASE}/${slug}${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: accept };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new CnbError(response.status, text, url);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 读取仓库内文件原文；不存在返回 null（而非抛错） */
export async function rawFile(slug, ref, path, options = {}) {
  try {
    const response = await fetch(`${API_BASE}/${slug}/-/git/raw/${ref}/${path}`, {
      headers: { Authorization: `Bearer ${options.token ?? requireToken()}` },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export function listRepos(groupSlug, options = {}) {
  return api(groupSlug, "/-/repos?per_page=100", options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? data?.repos ?? []));
}

export function listLabels(slug, options = {}) {
  return api(slug, "/-/labels?per_page=100", options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function createLabel(slug, label, options = {}) {
  return api(slug, "/-/labels", { method: "POST", body: label, ...options });
}

export function deleteLabel(slug, name, options = {}) {
  return api(slug, `/-/labels/${encodeURIComponent(name)}`, { method: "DELETE", ...options });
}

export function listBranchProtections(slug, options = {}) {
  return api(slug, "/-/settings/branch-protections", options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function createBranchProtection(slug, payload, options = {}) {
  return api(slug, "/-/settings/branch-protections", { method: "POST", body: payload, ...options });
}

/** CNB 分支保护在字段缺失时返回笼统 400，必须给全字段 */
export function branchProtectionPayload({ rule = "main", requireReview = false } = {}) {
  return {
    rule,
    allow_creation: true,
    allow_deletions: false,
    allow_force_pushes: false,
    allow_master_creation: true,
    allow_master_deletions: true,
    allow_master_force_pushes: true,
    allow_master_manual_merge: true,
    allow_master_pushes: true,
    allow_pushes: false,
    forbid_approve_pull_created_by_own_npc: true,
    required_approved_review_count: 1,
    required_approved_review_ratio: 100,
    required_commit_signatures: false,
    required_linear_history: false,
    required_master_approve: false,
    required_must_auto_merge: false,
    required_must_push_via_pull_request: true,
    required_pull_request_reviews: Boolean(requireReview),
    required_status_checks: true,
  };
}

export function createIssue(slug, { title, body, labels = [] }, options = {}) {
  return api(slug, "/-/issues", { method: "POST", body: { title, body, labels }, ...options });
}

export function createIssueComment(slug, number, body, options = {}) {
  return api(slug, `/-/issues/${number}/comments`, { method: "POST", body: { body }, ...options });
}

export function closeIssue(slug, number, options = {}) {
  return api(slug, `/-/issues/${number}`, {
    method: "PATCH",
    body: { state: "closed", state_reason: "completed" },
    ...options,
  });
}

export function listIssues(slug, { state = "open" } = {}, options = {}) {
  return api(slug, `/-/issues?state=${state}&per_page=100`, options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function createPull(slug, { title, head, base = "main", body }, options = {}) {
  return api(slug, "/-/pulls", { method: "POST", body: { title, head, base, body }, ...options });
}

export function listPulls(slug, { state = "open" } = {}, options = {}) {
  return api(slug, `/-/pulls?state=${state}`, options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function getBranch(slug, branch, options = {}) {
  return api(slug, `/-/git/branches/${branch}`, options);
}

