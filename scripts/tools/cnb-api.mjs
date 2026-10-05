/**
 * CNB 平台 API 封装（无外部依赖，Node 24 自带 fetch）。
 * 供 fleet-scan.mjs / provision-protocol.mjs / task.mjs 共用。
 * 令牌来源：环境变量 CNB_TOKEN（CI 内自动注入；本地使用个人令牌）。
 */

export const API_BASE = "https://api.cnb.cool";
export const WEB_BASE = "https://cnb.cool";

export function redactCredentials(value, token = process.env.CNB_TOKEN) {
  let text = String(value);
  const secrets = new Set(Object.entries(process.env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(key) && value && value.length >= 4).map(([, value]) => value));
  if (token) { secrets.add(token); secrets.add(Buffer.from(`cnb:${token}`).toString('base64')); }
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text;
}

export function gitAuthenticationEnvironment(token, source = process.env) {
  if (!token) throw new Error('缺少 CNB_TOKEN');
  const env = { ...source, GIT_TERMINAL_PROMPT: '0' };
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('无效 GIT_CONFIG_COUNT');
  env.GIT_CONFIG_COUNT = String(count + 2);
  env[`GIT_CONFIG_KEY_${count}`] = 'credential.helper'; env[`GIT_CONFIG_VALUE_${count}`] = '';
  env[`GIT_CONFIG_KEY_${count + 1}`] = 'http.https://cnb.cool/.extraHeader';
  env[`GIT_CONFIG_VALUE_${count + 1}`] = `Authorization: Basic ${Buffer.from(`cnb:${token}`).toString('base64')}`;
  return env;
}

export class CnbError extends Error {
  constructor(status, body, url, token) {
    super(redactCredentials(`CNB ${status} ${url} :: ${String(body).slice(0, 200)}`, token));
    this.status = status;
    this.body = redactCredentials(body, token);
    this.url = url;
  }
}

export function requireToken() {
  const token = process.env.CNB_TOKEN;
  if (!token) throw new Error("缺少 CNB_TOKEN（CI 流水线内自动注入；本地请用个人令牌导出到环境变量）");
  return token;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带重试的 API 调用：CNB 对高频调用会返回 429（实测舰队级巡检连续 20+ 次即触发），
 * 因此所有调用默认重试 4 次（指数退避 + 抖动），并尊重 Retry-After。
 */
export async function api(slug, path, options = {}) {
  const { method = "GET", body, token = requireToken(), accept = "application/json", baseDelayMs = 700 } = options;
  // Mutating requests can succeed while their response is lost. Their callers must reconcile by identity.
  const retries = options.retries ?? (method === 'GET' ? 4 : 0);
  const url = path.startsWith("http") ? path : `${API_BASE}/${slug}${path}`;
  if (new URL(url).origin !== API_BASE) throw new Error('CNB API 不允许把凭据发送到其他来源');
  const headers = { Authorization: `Bearer ${token}`, Accept: accept };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    const text = await response.text();
    if (response.ok) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    lastError = new CnbError(response.status, text, url, token);
    if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) throw lastError;
    const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
    await sleep(Math.min(delay, 30000));
  }
  throw lastError;
}

/** 读取仓库内文件原文；不存在返回 null（而非抛错） */
export async function rawFile(slug, ref, path, options = {}) {
  const token = options.token ?? requireToken();
  const url = `${API_BASE}/${slug}/-/git/raw/${ref}/${path}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) throw new CnbError(response.status, text, url, token);
  return text;
}

export function listRepos(groupSlug, options = {}) {
  return api(groupSlug, "/-/repos?page_size=100", options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? data?.repos ?? []));
}

export function listLabels(slug, options = {}) {
  return api(slug, "/-/labels?page_size=100", options).then((data) =>
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
export function branchProtectionPayload({ rule = "main", requireReview = true } = {}) {
  return {
    rule,
    allow_creation: true,
    allow_deletions: false,
    allow_force_pushes: false,
    allow_master_creation: true,
    allow_master_deletions: false,
    allow_master_force_pushes: false,
    allow_master_manual_merge: true,
    allow_master_pushes: false,
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

/** 规则存在不等于保护有效；只接受可回读的实际强约束。 */
export function validateBranchProtection(rule, { requireReview = true, forbidManualOverride = false } = {}) {
  const expected = {
    allow_deletions: false, allow_force_pushes: false, allow_pushes: false,
    allow_master_deletions: false, allow_master_force_pushes: false, allow_master_pushes: false,
    required_must_push_via_pull_request: true, required_status_checks: true,
  };
  if (requireReview) {
    expected.required_pull_request_reviews = true;
    expected.forbid_approve_pull_created_by_own_npc = true;
  }
  if (forbidManualOverride) expected.allow_master_manual_merge = false;
  const errors = Object.entries(expected).filter(([name, value]) => rule?.[name] !== value).map(([name, value]) => `${name} 必须为 ${value}`);
  if (rule?.rule !== 'main') errors.push('分支保护目标必须为 main');
  if (requireReview && !(Number.isSafeInteger(rule?.required_approved_review_count) && rule.required_approved_review_count >= 1)) errors.push("required_approved_review_count 必须至少为1");
  return errors;
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
  // CNB 的 state 只接受 open|closed（传 all 会 400），all 由两次查询合并实现。
  if (state === "all") {
    return Promise.all([
      listIssues(slug, { state: "open" }, options),
      listIssues(slug, { state: "closed" }, options),
    ]).then((pages) => pages.flat());
  }
  if (state !== "open" && state !== "closed") {
    throw new Error(`listIssues 不支持 state=${state}（CNB 只接受 open|closed）`);
  }
  return api(slug, `/-/issues?page_size=100&state=${state}`, options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function createPull(slug, { title, head, base = "main", body }, options = {}) {
  return api(slug, "/-/pulls", { method: "POST", body: { title, head, base, body }, ...options });
}

export function listPulls(slug, { state = "open", baseRef } = {}, options = {}) {
  const query = new URLSearchParams({ page_size: "100", state });
  if (baseRef) query.set("base_ref", baseRef);
  return api(slug, `/-/pulls?${query.toString()}`, options).then((data) =>
    Array.isArray(data) ? data : (data?.data ?? []));
}

export function getPull(slug, number, options = {}) {
  return api(slug, `/-/pulls/${number}`, options);
}

export function getPullFiles(slug, number, options = {}) {
  return api(slug, `/-/pulls/${number}/files`, options).then((data) =>
    (Array.isArray(data) ? data : (data?.data ?? [])).map((file) => ({
      filename: file.filename ?? file.new_path ?? file.path,
      status: file.status,
    })));
}

export function getPullCommitStatuses(slug, number, options = {}) {
  return api(slug, `/-/pulls/${number}/commit-statuses`, options);
}

/**
 * 合并合并请求。CNB 未暴露 auto-merge 开关，自动合并由调用方在
 * “全部门禁 success 且 mergeable_state=mergeable” 后调用本函数完成。
 */
export function mergePull(slug, number, { mergeStyle = "squash", commitTitle, commitMessage, force } = {}, options = {}) {
  if (!commitTitle) throw new Error("mergePull 需要 commitTitle（CNB 合并接口要求显式提交标题）");
  if (force === true) throw new Error('禁止强制合并；必须满足平台评审与状态检查');
  const body = { merge_style: mergeStyle };
  body.commit_title = commitTitle;
  if (commitMessage) body.commit_message = commitMessage;
  if (force !== undefined) body.force = Boolean(force);
  return api(slug, `/-/pulls/${number}/merge`, { method: "PUT", body, ...options });
}

export function addPullLabels(slug, number, labels, options = {}) {
  return api(slug, `/-/pulls/${number}/labels`, { method: "POST", body: { labels }, ...options });
}

/**
 * 比较 `base...head` 的提交差异（返回**完整路径**）。
 * 注意：`GET /pulls/{n}/files` 的 `filename` 字段会丢目录（实测把
 * `docs/DEVELOPMENT-PROTOCOL.md` 报成 `DEVELOPMENT-PROTOCOL.md`），
 * 因此“改动文件白名单”判定必须用本接口，PR 文件接口只作兜底展示。
 */
export function compareCommits(slug, baseHead, options = {}) {
  return api(slug, `/-/git/compare/${encodeURIComponent(baseHead)}`, options).then((data) => ({
    totalCommits: data?.total_commits ?? 0,
    headSha: data?.head_commit?.sha ?? null,
    files: (data?.files ?? []).map((file) => ({ path: file.path ?? file.name, status: file.status })),
  }));
}

export function getBranch(slug, branch, options = {}) {
  return api(slug, `/-/git/branches/${branch}`, options);
}
