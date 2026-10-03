#!/usr/bin/env node
/**
 * 基座 fanout（CNB 版）：把 workloom-im 的根级受控资产变更，变成舰队每一条子仓的同步 PR。
 *
 * 与已禁用的历史 `sync/base-sync.mjs push` 的差别：
 *   · 历史 push 模式直接更新子仓 main；该入口现在失败关闭。本脚本只**开 PR**，
 *     由子仓自己的 .cnb.yml 门禁 + 自动合并流水线决定是否落地（协议 §1/§9）。
 *   · 先用 CNB API 低成本比对子仓 `.workloom-base-sync.json` 的资产摘要，只有真漂移的子仓
 *     才会被 clone；舰队巡检因此可以在流水线里每 30 分钟跑一次而不浪费构建资源。
 *   · 隔离副本（`sync/child-repos.json#isolatedRepos`）即使被误写进 children 也在此处被拦下：
 *     不下发、不建 PR（双向不同步，见 docs/DEVELOPMENT-PROTOCOL.md §11）。
 *
 * 用法：
 *   node sync/fanout-cnb.mjs [--mode required-only|full] [--only <slug[,slug]>] [--dry-run]
 *                            [--no-pr] [--json] [--base-dir <基座工作树>] [--tolerate-scope-error]
 * 环境：
 *   CNB_TOKEN（CI 内自动注入；本地用个人访问令牌）——需具备子仓读 + 建 PR 的权限。
 * 退出码：0 全部齐平/已开 PR；1 存在失败项（--tolerate-scope-error 时跨仓权限不足只告警）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScope } from "./base-sync.mjs";
import {
  hasInFlightSyncPull, pausedWaveChildren, requiredAssetDigests, syncDrift, syncedChildren, SYNC_BRANCH_PREFIX,
} from "./fanout-rules.mjs";
import { isolatedFleet } from "../scripts/tools/fleet-rules.mjs";
import { addPullLabels, createPull, gitAuthenticationEnvironment, listPulls, rawFile, redactCredentials, requireToken } from "../scripts/tools/cnb-api.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_BASE_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_BASE_URL = "https://cnb.cool";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

export function redact(text, token = process.env.CNB_TOKEN ?? "") {
  let value = redactCredentials(text ?? "", token);
  for (const secret of [token, token ? encodeURIComponent(token) : ""].filter(Boolean)) {
    value = value.split(secret).join("[REDACTED]");
  }
  return value.replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@");
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`git ${args[0]} 失败：${redact(error?.stderr?.toString?.() || error?.message)}`);
  }
}

/** 子仓 clone 走匿名只读；推送才带上令牌（且令牌永远不出现在日志里） */
function cloneChild(slug, dir, baseUrl) {
  git(process.cwd(), ["clone", "--depth", "1", "--branch", "main", "--single-branch", `${baseUrl}/${slug}.git`, dir]);
}

/**
 * 推送同步分支。凭据只经限定 CNB HTTPS 来源的子进程配置注入，
 * 不写进 remote URL（既避免令牌落进日志/进程表，也避开基座秘密扫描的
 * credential-in-url 规则）。
 */
function pushBranch(dir, slug, branch, token, baseUrl) {
  const env = gitAuthenticationEnvironment(token);
  try {
    execFileSync("git", ["push", `${baseUrl}/${slug}.git`, `HEAD:refs/heads/${branch}`], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`推送 ${branch} 失败：${redact(error?.stderr?.toString?.() || error?.message)}`);
  }
}

function runBaseSync(childDir, baseDir, mode) {
  const args = [join(baseDir, "sync/base-sync.mjs"), "pull", "--repo", childDir, "--base-dir", baseDir, "--json"];
  if (mode === "required-only") args.push("--required-only");
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const stdout = result.stdout ?? "";
  let report = null;
  try {
    report = JSON.parse(stdout.slice(stdout.indexOf("{")));
  } catch {
    report = null;
  }
  if (result.status !== 0 || !report) {
    throw new Error(`base-sync pull 失败（exit=${result.status}）：${redact((result.stderr || stdout).slice(-500))}`);
  }
  return report;
}

function pullBody({ mode, baseSha, baseRepo, files }) {
  return [
    "## 背景",
    "",
    `基座 \`${baseRepo}\` 的根级受控资产更新到 \`${baseSha.slice(0, 8)}\`，本 PR 由 \`sync/fanout-cnb.mjs\` 自动同步（模式：\`${mode}\`）。`,
    "",
    "## 改动清单",
    "",
    ...files.map((file) => `- \`${file}\``),
    "",
    "## 处理规则",
    "",
    mode === 'required-only' ? "- 本 PR 覆盖根级受控资产及其执行依赖，不覆盖行业业务实现；" : "- 本 PR 覆盖受控清单内的公共基座资产，行业身份和声明的扩展路径由本仓保留；",
    "- 门禁由本仓 `.cnb.yml` 执行；无人值守合并仅限非执行性白名单。协议、规则、执行器、同步器与发布器即使全绿，也须已授权的会话显式审查并串行合并；",
    "- 需要暂缓时：关掉本 PR 即可，fanout 在存在在途同步 PR 时不会重复开门。",
    "",
    `> 相关：${baseRepo} sync/fanout-cnb.mjs`,
  ].join("\n");
}

async function main() {
  const mode = arg("--mode", "required-only");
  if (mode !== "required-only" && mode !== "full") throw new Error(`--mode 只支持 required-only|full，收到 ${mode}`);
  const baseDir = resolve(arg("--base-dir", DEFAULT_BASE_DIR));
  const baseUrl = arg("--base-url", DEFAULT_BASE_URL).replace(/\/$/, "");
  // Validate before acquiring a credential or performing any API/Git operation.
  if (baseUrl !== DEFAULT_BASE_URL) throw new Error('--base-url 只允许无凭据的 https://cnb.cool 来源');
  const only = arg("--only", "").split(",").map((item) => item.trim()).filter(Boolean);
  const dryRun = has("--dry-run");
  const noPr = has("--no-pr");
  const json = has("--json");
  const tolerateScopeError = has("--tolerate-scope-error");
  const token = requireToken();

  const scope = loadScope(baseDir);
  const fleet = JSON.parse(readFileSync(join(baseDir, "sync/child-repos.json"), "utf8"));
  const baseRepo = fleet.baseRepo ?? "workloom-ai/workloom-im";
  const baseSha = git(baseDir, ["rev-parse", "HEAD"]);
  const digests = requiredAssetDigests(baseDir, scope.raw);
  const isolated = isolatedFleet(fleet);
  const selected = (fleet.children ?? []).filter((child) => !only.length || only.includes(child.repo));
  if (selected.some((child) => !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(child?.repo ?? '') || child.repo.split('/').some((part) => part === '.' || part === '..'))) throw new Error('子仓 slug 必须是安全的 owner/repository');
  const { synced: subscribed, skipped: skippedIsolated } = syncedChildren(selected, isolated);
  /**
   * full 波次跳过 paused 波次仓（2026-09-29 实测事故）：
   * paused 仓（获客实验车道）在共享包上已分叉出基座尚未收编的能力，
   * full 下发会把它们整文件回退 → 该仓 typecheck/seed 直接崩（详见 fanout-rules.pausedWaveChildren 注释）。
   * 除非显式 `--only <slug>`（人工单仓推进），否则 full 一律不给 paused 仓开 PR。
   */
  const { synced: children, skipped: skippedPaused } = mode === "full" && !only.length
    ? pausedWaveChildren(subscribed)
    : { synced: subscribed, skipped: [] };
  if (!children.length && !skippedIsolated.length) throw new Error(`--only 没有匹配到任何子仓：${only.join(", ")}`);
  if (skippedIsolated.length && !json) {
    console.log(`⏸ 隔离副本不下发（sync/child-repos.json#isolatedRepos）：${skippedIsolated.join(", ")}`);
  }
  if (skippedPaused.length && !json) {
    console.log(`⏸ full 波次跳过暂停波次仓（uiRolloutWave=paused，仅接 required-only）：${skippedPaused.join(", ")}`);
  }

  const results = [];
  let failed = 0;
  let scopeError = 0;

  for (const child of children) {
    const record = { repo: child.repo, status: "unknown", mode, reasons: [] };
    let workdir = "";
    try {
      const stateText = await rawFile(child.repo, "main", ".workloom-base-sync.json");
      const state = stateText ? JSON.parse(stateText) : null;
      const drift = syncDrift({ state, mode, baseSha, digests });
      record.reasons = drift.reasons;

      const openPulls = await listPulls(child.repo, { state: "open", baseRef: "main" });
      const inFlight = hasInFlightSyncPull(openPulls);
      if (inFlight) {
        record.status = "in-flight";
        record.pull = Number(inFlight.number);
        record.reasons = [...drift.reasons, `已有在途同步 PR #${inFlight.number}`];
        results.push(record);
        continue;
      }
      if (!drift.drift) {
        record.status = "aligned";
        results.push(record);
        continue;
      }
      if (dryRun || noPr) {
        record.status = dryRun ? "would-sync" : "drift";
        results.push(record);
        continue;
      }

      workdir = mkdtempSync(join(tmpdir(), `workloom-fanout-${child.repo.split("/").pop()}-`));
      cloneChild(child.repo, workdir, baseUrl);
      const prefix = (child.pathPrefix ?? "").replace(/\/$/, "");
      const childDir = prefix ? join(workdir, prefix) : workdir;
      const report = runBaseSync(childDir, baseDir, mode);
      record.changed = report.changed ?? 0;
      record.stateUpdated = Boolean(report.stateUpdated);
      if (!report.changed && !report.stateUpdated) {
        record.status = "aligned";
        record.reasons = ["CNB 摘要显示漂移，但实际逐文件复核后已对齐"];
        results.push(record);
        continue;
      }

      const branch = `${SYNC_BRANCH_PREFIX}${baseSha.slice(0, 8)}${mode === "full" ? "-full" : ""}`;
      const commit = git(workdir, ["rev-parse", "HEAD"]);
      const existing = git(workdir, ["ls-remote", "--heads", `${baseUrl}/${child.repo}.git`, branch], { allowFailure: true });
      if (existing) {
        record.status = "branch-exists";
        record.branch = branch;
        record.reasons = [...record.reasons, `分支 ${branch} 已存在（对应 PR 可能已关闭），不重复推送`];
        results.push(record);
        continue;
      }
      pushBranch(workdir, child.repo, branch, token, baseUrl);
      const changedFiles = [
        ...(report.copied ?? []),
        ...(report.merged ?? []),
        ...(report.managed ?? []),
        ...(report.adopted ?? []),
      ];
      record.headSha = commit;
      const pullBodyText = pullBody({ mode, baseSha, baseRepo, files: changedFiles.length ? changedFiles : ["(仅同步登记文件 .workloom-base-sync.json)"] });
      const pull = await createPull(child.repo, {
        title: `sync(base): 基座根级资产同步 → ${baseSha.slice(0, 8)}（fanout 自动）`,
        head: branch,
        base: "main",
        body: pullBodyText,
      });
      record.status = "pr-opened";
      record.branch = branch;
      record.pull = pull?.number ? Number(pull.number) : undefined;
      record.changedFiles = changedFiles;
      try {
        await addPullLabels(child.repo, pull.number, ["src/auto", "protocol"]);
      } catch (error) {
        record.warnings = [`打标签失败（不影响合并判定）：${redact(error?.message).slice(0, 200)}`];
      }
      results.push(record);
    } catch (error) {
      const message = redact(error?.message ?? error);
      const isScope = /403|401|Forbidden|not logged in|permission/i.test(message);
      record.status = isScope ? "scope-denied" : "failed";
      record.error = message.slice(0, 500);
      if (isScope) scopeError += 1;
      else failed += 1;
      results.push(record);
    } finally {
      if (workdir) rmSync(workdir, { recursive: true, force: true });
    }
  }

  const summary = {
    baseRepo,
    baseSha,
    mode,
    dryRun,
    children: results.length,
    isolatedDeclared: [...isolated],
    skippedIsolated,
    skippedPaused,
    aligned: results.filter((item) => item.status === "aligned").length,
    inFlight: results.filter((item) => item.status === "in-flight").length,
    opened: results.filter((item) => item.status === "pr-opened").length,
    drift: results.filter((item) => item.status === "drift" || item.status === "would-sync").length,
    branchExists: results.filter((item) => item.status === "branch-exists").length,
    failed,
    scopeDenied: scopeError,
    results,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const item of results) {
      const label = { aligned: "✅ 已对齐", "in-flight": "🕒 在途 PR", "pr-opened": "📦 已开 PR", "branch-exists": "🧷 分支已存在", drift: "⚠️ 漂移", "would-sync": "⚠️ [dry-run] 待同步", failed: "❌ 失败", "scope-denied": "🔒 权限不足" }[item.status] ?? item.status;
      console.log(`${label} ${item.repo}${item.pull ? ` #${item.pull}` : ""}${item.reasons.length ? `：${item.reasons.join("；")}` : ""}${item.error ? `：${item.error}` : ""}`);
    }
    console.log(`\n基座 ${baseSha.slice(0, 8)}（模式 ${mode}${dryRun ? "，dry-run" : ""}）：对齐 ${summary.aligned} · 在途 ${summary.inFlight} · 新开 PR ${summary.opened} · 分支已存在 ${summary.branchExists} · 待同步 ${summary.drift} · 隔离副本 ${summary.isolatedDeclared.length}（不下发） · paused 波次 ${summary.skippedPaused.length}（不下发） · 失败 ${failed} · 权限不足 ${scopeError}`);
  }

  if (failed) process.exitCode = 1;
  if (scopeError && !tolerateScopeError) process.exitCode = 1;
  if (scopeError && tolerateScopeError) {
    console.log("⚠️ 跨仓权限不足：请在 CNB「组织设置 → 仓库管控」开启「允许定时任务跨仓操作」，或改用带跨仓权限的令牌触发本流水线。");
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  main().catch((error) => {
    console.error(`❌ fanout 失败：${redact(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}

export { main, runBaseSync, redact as redactFanout };
