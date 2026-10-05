#!/usr/bin/env node
/**
 * 并发冲突检测（docs/DEVELOPMENT-PROTOCOL.md §4）。
 * 普通路径重叠只提醒；敏感路径仅受持久化限时开发租约约束。
 * 实时 PR source/main 与 merge-base 新鲜度仍为硬门禁；--strict 是额外诊断模式。
 *
 * 事件语义（2026-09-27 修订）：
 * - **PR 事件**：普通重叠只提醒；其他 owner 的有效敏感租约拒绝；
 *   事件 source/target SHA 必须与实时 PR/main、compare merge base 一致；缺令牌/API 失败也 fail。
 * - **push 事件（main 合并提交）**：合并已经发生，门禁拦不住任何东西，只降级为**提醒**
 *   （列出需要 rebase 的在途 PR），否则每次并发合并都会把 main 门禁打红——
 *   实测：growth PR #211 合入后，因在途 #206/#209 同改 bundle.json 被判红，而同一内容 PR 门禁全绿。
 *   需要 push 也按 fail 处理时：`LOCK_OVERLAP_MODE=fail` 或 `--strict`。
 *
 * 用法：
 *   node scripts/ci/verify-lock-conflict.mjs                 # PR 流水线默认用法
 *   node scripts/ci/verify-lock-conflict.mjs --self-test     # 只跑内置样例，不联网
 *   node scripts/ci/verify-lock-conflict.mjs --base origin/main --strict
 *   LOCK_OVERLAP_MODE=warn node scripts/ci/verify-lock-conflict.mjs
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findFileOverlaps, findModuleConflicts, parseChangedPaths, resolveLockOverlapMode } from "./protocol-rules.mjs";
import { admissionErrors, parseIntent, sensitiveScopes, STATE_BRANCH, validateState } from '../delivery/queue-model.mjs';

const API = "https://api.cnb.cool";
const SHA_RE = /^[0-9a-f]{40,64}$/i;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function changedFiles(base) {
  const candidates = [];
  if (base) candidates.push([`${base}...HEAD`]);
  candidates.push(["origin/main...HEAD"], ["main...HEAD"]);
  if (process.env.CNB_BEFORE_SHA) candidates.push([`${process.env.CNB_BEFORE_SHA}...HEAD`]);
  candidates.push(["HEAD~1...HEAD"], ["HEAD"]);
  for (const [range] of candidates) {
    try {
      const files = parseChangedPaths(git(["diff", "--name-only", "--diff-filter=ACMR", range]));
      if (files.length) return { files, range };
    } catch {
      /* 继续尝试下一个范围 */
    }
  }
  return { files: [], range: null };
}

async function apiJson(url, { raw = false } = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${process.env.CNB_TOKEN}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`CNB API HTTP ${response.status} (${new URL(url).pathname})`), { status: response.status });
  if (!text) throw new Error(`CNB API 返回空响应 (${new URL(url).pathname})`);
  return raw ? text : JSON.parse(text);
}

export function isPrEvent(env = process.env) {
  const event = String(env.CNB_EVENT ?? "");
  return env.CNB_PULL_REQUEST === "true" || (event.startsWith("pull_request") && event !== "pull_request.merged");
}

/** PR 门禁只接受事件、平台实时状态和 compare 三方一致的最新 main 快照。 */
export function validatePrSnapshot({ number, branch, eventSourceSha, eventTargetSha, pull, main, compare, finalPull, finalMain }) {
  const errors = [];
  const sha = (value) => String(value ?? "").trim();
  const source = sha(eventSourceSha);
  const target = sha(eventTargetSha);
  const head = sha(pull?.head?.sha);
  const base = sha(pull?.base?.sha);
  const mainSha = sha(main?.commit?.sha);
  const compareBase = sha(compare?.base_commit?.sha);
  const compareHead = sha(compare?.head_commit?.sha);
  const mergeBase = sha(compare?.merge_base_commit?.sha);
  for (const [name, value] of [["事件 source", source], ["事件 target", target], ["实时 PR head", head], ["实时 PR base", base], ["实时 main", mainSha], ["compare base", compareBase], ["compare head", compareHead], ["compare merge base", mergeBase]]) {
    if (!SHA_RE.test(value)) errors.push(`${name} SHA 缺失或无效`);
  }
  if (!Number.isSafeInteger(Number(number)) || Number(number) <= 0 || String(pull?.number ?? "") !== String(number)) errors.push("PR 编号与实时 PR 不一致");
  if (pull?.state !== "open") errors.push("PR 已不处于 open 状态");
  if (String(pull?.base?.ref ?? "").replace(/^refs\/heads\//, "") !== "main") errors.push("PR 目标分支不是 main");
  if (branch && String(pull?.head?.ref ?? "").replace(/^refs\/heads\//, "") !== branch) errors.push("事件 source 分支与实时 PR 不一致");
  if (source && head && source !== head) errors.push("事件 source 已过时，需重跑 PR 门禁");
  if (target && mainSha && target !== mainSha) errors.push("事件 target 已过时，需在最新 main 上重跑 PR 门禁");
  if (base && mainSha && base !== mainSha) errors.push("实时 PR base 与 main 不一致");
  if (compareBase && mainSha && compareBase !== mainSha) errors.push("compare base 与 main 不一致");
  if (compareHead && head && compareHead !== head) errors.push("compare head 与 PR head 不一致");
  if (mergeBase && mainSha && mergeBase !== mainSha) errors.push("PR 分支未包含最新 main，需 rebase 后重跑门禁");
  if (sha(finalPull?.head?.sha) !== head || sha(finalPull?.base?.sha) !== base
    || finalPull?.head?.ref !== pull?.head?.ref || finalPull?.base?.ref !== pull?.base?.ref
    || finalPull?.state !== "open" || String(finalPull?.number ?? "") !== String(number) || finalPull?.body !== pull?.body) {
    errors.push("查询期间 PR 状态发生变化，需重跑门禁");
  }
  if (sha(finalMain?.commit?.sha) !== mainSha) errors.push("查询期间 main 已变化，需重跑门禁");
  if (!Array.isArray(compare?.files)) errors.push("compare 缺少文件列表");
  const files = Array.isArray(compare?.files) ? compare.files.map((entry) => String(entry?.path ?? entry?.name ?? "").trim()) : [];
  if (files.some((path) => !path)) errors.push("compare 文件列表含无效路径");
  return { errors, files };
}

export async function verifyPrFreshness({ repoSlug, number, branch, eventSourceSha, eventTargetSha, request = apiJson }) {
  if (!repoSlug || !number || !SHA_RE.test(String(eventSourceSha ?? "")) || !SHA_RE.test(String(eventTargetSha ?? ""))) {
    throw new Error("PR 事件缺少仓库、编号或 source/target SHA，无法证明主干新鲜度");
  }
  const pullUrl = `${API}/${repoSlug}/-/pulls/${encodeURIComponent(number)}`;
  const mainUrl = `${API}/${repoSlug}/-/git/branches/main`;
  const pull = await request(pullUrl);
  const main = await request(mainUrl);
  const head = String(pull?.head?.sha ?? "");
  const mainSha = String(main?.commit?.sha ?? "");
  if (!SHA_RE.test(head) || !SHA_RE.test(mainSha)) throw new Error("实时 PR/main API 未返回有效 SHA");
  const compare = await request(`${API}/${repoSlug}/-/git/compare/${encodeURIComponent(`${mainSha}...${head}`)}`);
  const finalPull = await request(pullUrl);
  const finalMain = await request(mainUrl);
  const verdict = validatePrSnapshot({ number, branch, eventSourceSha, eventTargetSha, pull, main, compare, finalPull, finalMain });
  if (verdict.errors.length) throw new Error(`PR 新鲜度门禁失败：${verdict.errors.join("；")}`);
  return { ...verdict, headSha: head, mainSha, taskId: parseIntent(finalPull).taskId };
}

/** CNB PR 列表按页读取；页重复、结构异常时拒绝给出不完整的无冲突结论。 */
async function allOpenPulls(repoSlug, request = apiJson) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 100; page += 1) {
    const payload = await request(`${API}/${repoSlug}/-/pulls?state=open&page_size=100&page=${page}`);
    const list = Array.isArray(payload) ? payload : payload?.data;
    if (!Array.isArray(list)) throw new Error(`open PR 列表第 ${page} 页格式错误`);
    for (const pull of list) {
      const number = String(pull?.number ?? "");
      if (!number || seen.has(number)) throw new Error(`open PR 列表第 ${page} 页编号缺失或重复`);
      seen.add(number);
      all.push(pull);
    }
    if (list.length < 100) return all;
  }
  throw new Error("open PR 列表超过 100 页，无法完成全量比对");
}

/**
 * 自身 PR 判定（协议 §4 三重排除 + 祖先兜底）。
 *
 * CNB 实测：当分支 tip 由流水线回推（如视觉基线重生成提交）时，`pulls` 接口在数分钟内
 * 仍返回旧的 head.sha，而构建检出的 HEAD 已是新 tip —— 仅按编号/分支/SHA 相等判定会把
 * 自己的 PR 当成"别人的 PR"，报出与自身路径冲突的假红灯（2026-09-18 审计批次实测）。
 * 因此追加：PR 记录的 head 是本地 HEAD 的祖先时同样视为自身（本地分支已包含其全部提交）。
 */
export function isSelfPull({ number, headRef, headSha, selfNumber, selfBranch, selfHeadSha, ancestorOfHead = false }) {
  const short = (value) => String(value ?? "").slice(0, 12);
  if (number && selfNumber && String(number) === String(selfNumber)) return true;
  // 编号已知时，祖先关系不能把其它（尤其是 stacked）PR 误排除。
  if (number && selfNumber) return false;
  if (selfBranch && headRef && String(headRef).replace(/^refs\/heads\//, "") === String(selfBranch)) return true;
  if (selfHeadSha && headSha) {
    if (String(headSha) === String(selfHeadSha)) return true;
    if (short(headSha) === short(selfHeadSha)) return true;
    if (short(headSha) && short(selfHeadSha) && String(headSha).startsWith(short(selfHeadSha))) return true;
    if (short(headSha) && short(selfHeadSha) && String(selfHeadSha).startsWith(short(headSha))) return true;
  }
  return Boolean(selfHeadSha && headSha && ancestorOfHead);
}

/** PR 记录的 head 是否为本地 HEAD 的祖先（本地分支已包含该提交）。 */
function isAncestorOfHead(sha) {
  if (!sha) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function openPrFiles(repoSlug, selfNumber, selfBranch, selfHeadSha, request = apiJson) {
  let resolvedSelfNumber = selfNumber && selfNumber !== "true" ? String(selfNumber) : null;
  const list = await allOpenPulls(repoSlug, request);
  const result = [];
  for (const pull of list) {
    const number = String(pull?.number ?? "");
    if (!number) continue;
    const headRef = String(pull?.head?.ref ?? "").replace(/^refs\/heads\//, "");
    const headSha = String(pull?.head?.sha ?? "");
    const isSelf = isSelfPull({
      number,
      headRef,
      headSha,
      selfNumber,
      selfBranch,
      selfHeadSha,
      ancestorOfHead: !selfNumber && headSha !== selfHeadSha && isAncestorOfHead(headSha),
    });
    if (isSelf) {
      console.log(`- 跳过自身 PR #${number}（head=${headSha.slice(0, 12)} ref=${headRef}）`);
      if (selfHeadSha && headSha === selfHeadSha) resolvedSelfNumber = number;
      continue;
    }
    const baseSha = String(pull?.base?.sha ?? "");
    if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) throw new Error(`PR #${number} 缺少有效 base/head SHA`);
    // pulls/{n}/files 的 filename 实测只给基名；compare.files.path 才是完整路径。
    const compare = await request(`${API}/${repoSlug}/-/git/compare/${encodeURIComponent(`${baseSha}...${headSha}`)}`);
    if (String(compare?.base_commit?.sha ?? "") !== baseSha || String(compare?.head_commit?.sha ?? "") !== headSha || !Array.isArray(compare?.files)) {
      throw new Error(`PR #${number} compare 不完整或 SHA 已变化`);
    }
    const paths = compare.files.map((file) => String(file?.path ?? "").trim());
    if (paths.some((path) => !path)) throw new Error(`PR #${number} compare 含无效路径`);
    result.push({ number, title: pull?.title ?? "", paths, headSha });
  }
  const latest = await allOpenPulls(repoSlug, request);
  const snapshot = new Map(list.map((pull) => [String(pull.number), `${pull?.base?.sha ?? ""}:${pull?.head?.sha ?? ""}`]));
  if (latest.length !== list.length || latest.some((pull) => snapshot.get(String(pull?.number ?? "")) !== `${pull?.base?.sha ?? ""}:${pull?.head?.sha ?? ""}`)) {
    throw new Error("扫描期间 open PR 列表或分支 SHA 变化，需重跑门禁");
  }
  return { prs: result, selfNumber: resolvedSelfNumber };
}

/** Development occupation is a bounded lease, never the age or open state of a PR. */
export function activeLeaseConflicts(files, state, now = Date.now()) {
  // PR readiness is a handoff boundary, not a lease mutation. Even the same
  // owner must release its live generation before CI; a reused task id grants no exemption.
  return sensitiveScopes(files).filter(scope => state.leases[scope]?.owner && state.leases[scope].expiresAt > now);
}

export function legacySensitiveConflict(installed, selfNumber, otherNumber) {
  if (installed !== false) return false;
  const self = Number(selfNumber); const other = Number(otherNumber);
  if (!Number.isSafeInteger(self) || self <= 0 || !Number.isSafeInteger(other) || other <= 0) return true;
  return self > other;
}

export async function verifyPrLeases(repoSlug, files, request = apiJson, now = Date.now(), identity = {}, { waitMs = 0, elapsedClock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!sensitiveScopes(files).length) return { installed: true };
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 180000) throw new Error('Invalid admission wait');
  const started = elapsedClock();
  for (;;) {
    const state = await readLeases(repoSlug, request);
    if (state === null) return { installed: false }; // A distributed file does not activate the new gate.
    const conflicts = activeLeaseConflicts(files, state, now + elapsedClock() - started);
    if (conflicts.length) throw new Error(`敏感模块仍有有效开发租约：${conflicts.join(', ')}；持有者须交接释放或等待期限到期，不按 open PR 编号占锁`);
    const errors = admissionErrors(state, { ...identity, files });
    if (!errors.length) return { installed: true, admitted: true };
    if (elapsedClock() - started >= waitMs) throw new Error(`敏感源码缺少受信接纳回执：${errors.join('; ')}；由 main admission 执行器自动取得并释放 owner/generation 后重跑，不依赖开发者自愿占锁`);
    await sleep(Math.min(5000, waitMs - (elapsedClock() - started)));
  }
}

export async function readLeases(repoSlug, request = apiJson) {
  try {
    const state = await request(`${API}/${repoSlug}/-/git/raw/${encodeURIComponent(STATE_BRANCH)}/state.json`);
    return validateState(state, repoSlug);
  } catch (error) {
    if (error.status !== 404) throw error;
    // A missing file on an existing control branch is corruption, never an empty lease set.
    try {
      await request(`${API}/${repoSlug}/-/git/branches/${encodeURIComponent(STATE_BRANCH)}`);
    } catch (branchError) {
      if (branchError.status !== 404) throw branchError;
      const ci = await request(`${API}/${repoSlug}/-/git/raw/main/.cnb.yml`, { raw: true });
      if (typeof ci !== 'string') throw new Error('DELIVERY_STATE_UNKNOWN：无法读取 main 交付配置，拒绝将缺失账本当成空租约');
      if (ci.includes('scripts/delivery/cnb.yml')) throw new Error('DELIVERY_LEDGER_CORRUPT：main 已启用交付配置，但租约控制分支缺失，拒绝放行');
      return null; // Retain the legacy sensitive overlap gate until explicit installation/preparation.
    }
    throw new Error('DELIVERY_LEDGER_CORRUPT：租约控制分支存在但 state.json 缺失，拒绝放行');
  }
}

function selfTest() {
  const mine = ["sync/base-sync.mjs"];
  const theirs = ["sync/client-foundation.mjs"];
  const moduleConflicts = findModuleConflicts(mine, theirs);
  const fileOverlaps = findFileOverlaps(["a/b.ts"], ["a/b.ts", "c/d.ts"]);
  const clean = findFileOverlaps(["x/y.ts"], ["a/b.ts"]);
  if (moduleConflicts.join(",") !== "sync/") {
    console.error("✗ self-test: 模块级互斥未命中 sync/");
    process.exit(1);
  }
  if (fileOverlaps.join(",") !== "a/b.ts" || clean.length !== 0) {
    console.error("✗ self-test: 文件重叠判定错误");
    process.exit(1);
  }
  const selfCases = [
    // 编号一致 → 自身
    [{ number: "27", headRef: "audit/x", headSha: "aaaaaaaaaaaa", selfNumber: "27", selfHeadSha: "bbbbbbbbbbbb" }, true],
    // head 与本地 HEAD 一致 → 自身
    [{ number: "27", headRef: "audit/x", headSha: "bbbbbbbbbbbb", selfNumber: null, selfHeadSha: "bbbbbbbbbbbb" }, true],
    // 平台 head.sha 滞后（旧提交是本地 HEAD 的祖先）→ 仍视为自身，避免自比对假红灯
    [{ number: "27", headRef: "audit/x", headSha: "aaaaaaaaaaaa", selfNumber: null, selfHeadSha: "bbbbbbbbbbbb", ancestorOfHead: true }, true],
    // 真并发 PR：既非同一编号，也非祖先 → 不排除
    [{ number: "25", headRef: "task/T-1", headSha: "cccccccccccc", selfNumber: null, selfHeadSha: "bbbbbbbbbbbb", ancestorOfHead: false }, false],
  ];
  for (const [input, expected] of selfCases) {
    if (isSelfPull(input) !== expected) {
      console.error(`✗ self-test: 自身 PR 判定错误 ${JSON.stringify(input)} 期望 ${expected}`);
      process.exit(1);
    }
  }
  const modeCases = [
    // push 事件（main 合并）→ 只提醒：合并已发生，拦不住任何东西（2026-09-27 误报回归）
    [{ event: "push" }, "warn"],
    [{ event: "pull_request" }, "warn"],
    [{ event: null }, "warn"],
    [{ event: "push", envMode: "fail" }, "fail"],
    [{ event: "pull_request", strict: true }, "fail"],
  ];
  for (const [input, expected] of modeCases) {
    if (resolveLockOverlapMode(input) !== expected) {
      console.error(`✗ self-test: 处置级别解析错误 ${JSON.stringify(input)} 期望 ${expected}`);
      process.exit(1);
    }
  }
  console.log("✓ verify-lock-conflict self-test 通过（模块互斥 / 文件重叠 / 无冲突 / 自身 PR 判定 4 例 / 事件处置级别 5 例）");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const repoSlug = arg("--repo") ?? process.env.CNB_REPO_SLUG ?? null;
  // 注意：下面解析 open PR 时可能回填（自身编号来自 head 匹配），因此必须是 let——写成 const 会在
  // 任何「有 open PR」的流水线里抛 TypeError，被 catch 吞成「跳过冲突检测」，等于门禁静默失效。
  let selfNumber = arg("--pr") ?? process.env.CNB_PULL_REQUEST_IID
    ?? (process.env.CNB_PULL_REQUEST !== "true" ? process.env.CNB_PULL_REQUEST : null);
  const strict = process.argv.includes("--strict");
  const event = process.env.CNB_EVENT ?? null;
  const prEvent = isPrEvent();
  const overlapMode = resolveLockOverlapMode({ event, envMode: process.env.LOCK_OVERLAP_MODE, strict });
  const advisory = overlapMode !== "fail";
  const base = arg("--base");
  // CNB 实测语义（2026-09-18，pull_request 构建）：
  //   CNB_BRANCH=main（目标分支）、CNB_BRANCH_SHA=<目标分支提交>、CNB_PULL_REQUEST=true（仅标记）
  //   检出目录的 HEAD 就是源分支 tip —— 自比对以 HEAD 为准；push 构建才用 CNB_BRANCH_SHA。
  let selfHeadSha = null;
  try {
    if (process.env.CNB_EVENT === "push" && process.env.CNB_BRANCH_SHA) {
      selfHeadSha = String(process.env.CNB_BRANCH_SHA).trim();
    } else {
      selfHeadSha = git(["rev-parse", "HEAD"]).trim();
    }
  } catch {
    selfHeadSha = null;
  }
  let selfBranch = null;
  if (process.env.CNB_EVENT === "push") selfBranch = (process.env.CNB_BRANCH ?? "").trim() || null;
  if (prEvent) selfBranch = (process.env.CNB_PULL_REQUEST_BRANCH ?? "").trim() || null;
  if (process.env.PROTOCOL_DEBUG === "1") {
    for (const key of ["CNB_EVENT", "CNB_BRANCH", "CNB_BRANCH_SHA", "CNB_PULL_REQUEST", "CNB_REPO_SLUG"]) {
      console.log(`  [debug] ${key}=${process.env[key] ?? "<unset>"}`);
    }
    console.log(`  [debug] resolved selfHeadSha=${selfHeadSha ?? "<none>"}`);
  }
  // PR 必须先验证实时源/目标/merge-base，再从 compare 取完整路径；不能因本地 diff 为空提前放行。
  let mine;
  let range;
  let prSnapshot;
  if (prEvent) {
    if (!repoSlug || !process.env.CNB_TOKEN) throw new Error("PR 事件缺少 CNB_REPO_SLUG 或 CNB_TOKEN，锁冲突门禁拒绝放行");
    const snapshot = await verifyPrFreshness({
      repoSlug,
      number: selfNumber,
      branch: selfBranch,
      eventSourceSha: process.env.CNB_PULL_REQUEST_SHA,
      eventTargetSha: process.env.CNB_PULL_REQUEST_TARGET_SHA,
    });
    mine = snapshot.files;
    range = `${snapshot.mainSha.slice(0, 12)}...${snapshot.headSha.slice(0, 12)} (CNB compare)`;
    selfHeadSha = snapshot.headSha;
    prSnapshot = snapshot;
  } else {
    ({ files: mine, range } = changedFiles(base));
  }
  if (!mine.length) {
    console.log(`✓ 锁冲突检测：${prEvent ? "实时 PR compare" : "分支"} 无改动文件，跳过`);
    return;
  }
  console.log(`本分支改动 ${mine.length} 个文件（范围 ${range}）`);
  if (advisory) {
    console.log(`ℹ 事件=${event ?? "unknown"}：重叠只作提醒（不判红）——合并已发生，命中的在途 PR 需 rebase 后重跑门禁`);
  }

  if (!repoSlug || !process.env.CNB_TOKEN) {
    const message = "缺少 CNB_REPO_SLUG 或 CNB_TOKEN，无法比对同仓 open PR";
    if (prEvent || strict) throw new Error(message);
    console.warn(`! ${message}；本次跳过（本地环境属预期，流水线内会拿到令牌）`);
    return;
  }

  let others;
  let legacySensitive = false;
  if (prEvent) {
    const leases = await verifyPrLeases(repoSlug, mine, apiJson, Date.now(), { number: Number(selfNumber), headSha: prSnapshot.headSha, mainSha: prSnapshot.mainSha }, { waitMs: 180000 });
    legacySensitive = leases.installed === false;
  }
  try {
    const scanned = await openPrFiles(repoSlug, selfNumber, selfBranch, selfHeadSha);
    others = scanned.prs;
    if (scanned.selfNumber) {
      selfNumber = scanned.selfNumber;
      console.log(`  自身 PR 编号：#${selfNumber}（排除自身比对）`);
    }
  } catch (error) {
    if (prEvent || strict) throw new Error(`查询 open PR 失败：${error?.message ?? error}`);
    console.warn(`! 查询 open PR 失败，跳过冲突检测：${String(error).slice(0, 200)}`);
    return;
  }

  let failed = 0;
  if (!others.length) console.log("✓ 同仓无其它 open PR，无冲突");
  for (const other of others) {
    const moduleConflicts = findModuleConflicts(mine, other.paths);
    const overlaps = findFileOverlaps(mine, other.paths);
    // Explicit strict diagnostics can reject overlap; normal CI never leases by PR number.
    if (moduleConflicts.length) {
      if (advisory && !legacySensitiveConflict(!legacySensitive, selfNumber, other.number)) {
        console.warn(`! 与 PR #${other.number}「${other.title}」同改互斥模块：${moduleConflicts.join(", ")}（push 事件提醒：该 PR 需 rebase）`);
      } else {
        failed += 1;
        console.error(`✗ 与 PR #${other.number}「${other.title}」互斥模块冲突：${moduleConflicts.join(", ")}`);
        console.error("   显式 strict 诊断拒绝重叠；正常开发互斥以有效租约为准（协议 §4）。");
      }
    }
    if (overlaps.length) {
      const head = `PR #${other.number}「${other.title}」同时修改：${overlaps.slice(0, 5).join(", ")}${overlaps.length > 5 ? " …" : ""}`;
      if (advisory) {
        console.warn(`! ${head}（push 事件提醒：该 PR 需 rebase 后重跑门禁）`);
      } else {
        failed += 1;
        console.error(`✗ ${head}`);
      }
    }
  }

  if (failed) {
    console.error(`\n拒绝：检测到 ${failed} 处并发冲突（协议 §4）`);
    process.exit(1);
  }
  console.log("✓ 锁冲突检测通过");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`锁冲突检测异常：${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
