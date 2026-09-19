#!/usr/bin/env node
/**
 * 并发冲突检测（docs/DEVELOPMENT-PROTOCOL.md §4）。
 * 逻辑：取本分支改动文件 → 拉同仓 open PR 的改动文件 → 模块级互斥命中即拒；同文件重叠默认拒（LOCK_OVERLAP_MODE=warn 可降级）。
 *
 * 用法：
 *   node scripts/ci/verify-lock-conflict.mjs                 # PR 流水线默认用法
 *   node scripts/ci/verify-lock-conflict.mjs --self-test     # 只跑内置样例，不联网
 *   node scripts/ci/verify-lock-conflict.mjs --base origin/main --strict
 *   LOCK_OVERLAP_MODE=warn node scripts/ci/verify-lock-conflict.mjs
 */
import { execFileSync } from "node:child_process";
import { findFileOverlaps, findModuleConflicts, parseChangedPaths } from "./protocol-rules.mjs";

const API = "https://api.cnb.cool";

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

async function apiJson(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.CNB_TOKEN}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * CNB 的 pulls/{n}/files 只返回基名（如 apps/web/package.json 会返回 "package.json"），
 * 完整路径要从 blob_url / raw_url 中解出，否则不同目录的同名文件会被误判为冲突。
 */
function fullPathOf(entry) {
  const url = String(entry?.blob_url ?? entry?.raw_url ?? "");
  const match = /\/blob\/[0-9a-f]{7,40}\/(.+)$/.exec(url) ?? /\/raw\/[^/]+\/(.+)$/.exec(url);
  return match ? decodeURIComponent(match[1]) : String(entry?.filename ?? "");
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

async function openPrFiles(repoSlug, selfNumber, selfBranch, selfHeadSha) {
  let resolvedSelfNumber = selfNumber && selfNumber !== "true" ? String(selfNumber) : null;
  const pulls = await apiJson(`${API}/${repoSlug}/-/pulls?state=open`);
  const list = Array.isArray(pulls) ? pulls : (pulls?.data ?? []);
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
      ancestorOfHead: headSha !== selfHeadSha && isAncestorOfHead(headSha),
    });
    if (isSelf) {
      console.log(`- 跳过自身 PR #${number}（head=${headSha.slice(0, 12)} ref=${headRef}）`);
      if (selfHeadSha && headSha === selfHeadSha) resolvedSelfNumber = number;
      continue;
    }
    const files = await apiJson(`${API}/${repoSlug}/-/pulls/${number}/files`);
    const paths = (Array.isArray(files) ? files : (files?.data ?? []))
      .map(fullPathOf)
      .filter(Boolean);
    result.push({ number, title: pull?.title ?? "", paths, headSha });
  }
  return { prs: result, selfNumber: resolvedSelfNumber };
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
  console.log("✓ verify-lock-conflict self-test 通过（模块互斥 / 文件重叠 / 无冲突 / 自身 PR 判定 4 例）");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const repoSlug = arg("--repo") ?? process.env.CNB_REPO_SLUG ?? null;
  // 注意：下面解析 open PR 时可能回填（自身编号来自 head 匹配），因此必须是 let——写成 const 会在
  // 任何「有 open PR」的流水线里抛 TypeError，被 catch 吞成「跳过冲突检测」，等于门禁静默失效。
  let selfNumber = arg("--pr") ?? (process.env.CNB_PULL_REQUEST !== "true" ? process.env.CNB_PULL_REQUEST : null);
  const strict = process.argv.includes("--strict");
  const overlapMode = process.env.LOCK_OVERLAP_MODE === "warn" ? "warn" : "fail";
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
  if (process.env.PROTOCOL_DEBUG === "1") {
    for (const key of ["CNB_EVENT", "CNB_BRANCH", "CNB_BRANCH_SHA", "CNB_PULL_REQUEST", "CNB_REPO_SLUG"]) {
      console.log(`  [debug] ${key}=${process.env[key] ?? "<unset>"}`);
    }
    console.log(`  [debug] resolved selfHeadSha=${selfHeadSha ?? "<none>"}`);
  }
  const { files: mine, range } = changedFiles(base);
  if (!mine.length) {
    console.log("✓ 锁冲突检测：分支无改动文件，跳过");
    return;
  }
  console.log(`本分支改动 ${mine.length} 个文件（范围 ${range}）`);

  if (!repoSlug || !process.env.CNB_TOKEN) {
    const message = "缺少 CNB_REPO_SLUG 或 CNB_TOKEN，无法比对同仓 open PR";
    if (strict) {
      console.error(`✗ ${message}（--strict 模式下视为失败）`);
      process.exit(1);
    }
    console.warn(`! ${message}；本次跳过（本地环境属预期，流水线内会拿到令牌）`);
    return;
  }

  let others;
  try {
    const scanned = await openPrFiles(repoSlug, selfNumber, selfBranch, selfHeadSha);
    others = scanned.prs;
    if (scanned.selfNumber) {
      selfNumber = scanned.selfNumber;
      console.log(`  自身 PR 编号：#${selfNumber}（先到先得判定依据）`);
    }
  } catch (error) {
    console.warn(`! 查询 open PR 失败，跳过冲突检测：${String(error).slice(0, 200)}`);
    if (strict) process.exit(1);
    return;
  }

  let failed = 0;
  if (!others.length) console.log("✓ 同仓无其它 open PR，无冲突");
  for (const other of others) {
    const moduleConflicts = findModuleConflicts(mine, other.paths);
    const overlaps = findFileOverlaps(mine, other.paths);
    // 先到先得：编号小的 PR 优先合并；编号大的（后到者）自行排队；无法判定自身编号时保持对称拦截
    const mineNumber = Number(selfNumber);
    const theirNumber = Number(other.number);
    const iAmLater = Number.isFinite(mineNumber) && Number.isFinite(theirNumber)
      ? theirNumber < mineNumber
      : true;
    if (moduleConflicts.length) {
      if (iAmLater) {
        failed += 1;
        console.error(`✗ 与 PR #${other.number}「${other.title}」互斥模块冲突：${moduleConflicts.join(", ")}`);
        console.error("   模块级互斥路径同一时刻只允许一个任务（协议 §4）——你是后到者，请排队等其合并后 rebase。");
      } else {
        console.warn(`! 与 PR #${other.number}「${other.title}」同改互斥模块 ${moduleConflicts.join(", ")}：该 PR 编号更大（后到），由它排队。`);
      }
    }
    if (overlaps.length) {
      const head = `PR #${other.number}「${other.title}」同时修改：${overlaps.slice(0, 5).join(", ")}${overlaps.length > 5 ? " …" : ""}`;
      if (overlapMode === "fail" && iAmLater) {
        failed += 1;
        console.error(`✗ ${head}`);
      } else if (overlapMode === "fail") {
        console.warn(`! ${head}（该 PR 后到，由它排队）`);
      } else {
        console.warn(`! ${head}（LOCK_OVERLAP_MODE=warn，仅告警）`);
      }
    }
  }

  if (failed) {
    console.error(`\n拒绝：检测到 ${failed} 处并发冲突（协议 §4）`);
    process.exit(1);
  }
  console.log("✓ 锁冲突检测通过");
}

main().catch((error) => {
  console.error(`锁冲突检测异常：${error?.message ?? error}`);
  process.exit(1);
});
