#!/usr/bin/env node
/**
 * oss-watch-ci · 流水线里的开源组件周期扫描与「更新清单 PR」（CNB crontab 专用入口）
 *
 * 作用：在无人值守的定时流水线里
 *   ① 全量刷新上游最新版本（npm / PyPI / GitHub）；
 *   ② 重新生成 docs/OPEN_SOURCE_COMPONENTS.md 与 docs/oss-update-plan.md；
 *   ③ 有变化时自动开一支 `chore/oss-watch-YYYYMMDD` 分支 + 提交 + 推送 + PR。
 *      —— 只提议、不合并：升级永远由人圈定后执行（AGENTS.md 与 skill 铁律）。
 *
 * 用法（CI）：node scripts/oss-watch-ci.mjs [--dry-run] [--exit-zero]
 * 前置：CNB_TOKEN（CNB 流水线自动注入，作用域限当前仓库）
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWatch } from "./oss-watch.mjs";
import { createPull, listPulls, requireToken } from "./tools/cnb-api.mjs";

const WATCHED_PATHS = [
  "oss-components.json",
  ".oss-watch-state.json",
  "docs/OPEN_SOURCE_COMPONENTS.md",
  "docs/oss-update-plan.md",
];

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

function slugFromRemote(cwd) {
  const remote = git(["-C", cwd, "remote", "get-url", "origin"]);
  const match = remote.match(/cnb\.cool[/:]([^/]+\/[^/\s]+?)(?:\.git)?$/);
  if (!match) throw new Error(`无法从 origin 推断仓库 slug：${remote}`);
  return match[1];
}

/**
 * 推送分支：优先用环境已有凭据的 origin；失败再用 CNB_TOKEN 走 http.extraheader。
 * 不在命令行里拼带凭据的 URL（会被增量秘密扫描判为 credential-in-url）。
 */
function pushBranch(repoDir, slug, branch, token, log) {
  const refspec = `HEAD:refs/heads/${branch}`;
  try {
    git(["-C", repoDir, "push", "origin", refspec]);
    return "origin";
  } catch (error) {
    log(`  · origin 推送失败（${String(error.message).split("\n")[0]}），改用 CNB_TOKEN 头部鉴权`);
  }
  const basic = Buffer.from(`cnb:${token}`, "utf8").toString("base64");
  git([
    "-C",
    repoDir,
    "-c",
    `http.extraheader=Authorization: Basic ${basic}`,
    "push",
    `https://cnb.cool/${slug}.git`,
    refspec,
  ]);
  return "token-header";
}

function changedFiles(cwd) {
  const out = git(["-C", cwd, "status", "--porcelain", "--", ...WATCHED_PATHS]);
  return out ? out.split("\n").map((line) => line.slice(3).trim()).filter(Boolean) : [];
}

export async function run({ cwd, dryRun = false, taskId = "", log = console.log } = {}) {
  const root = resolve(cwd);
  const { summary } = await runWatch({ root, all: false, exitZero: true, log });
  const changed = changedFiles(root);
  if (!changed.length) {
    log("✓ 开源组件清单无变化：无需 PR");
    return { changed: false, summary };
  }
  log(`→ 检测到 ${changed.length} 个文件变化：${changed.join(", ")}`);

  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" })
    .format(new Date())
    .replace(/-/g, "");
  const branch = `chore/oss-watch-${date}`;
  const slug = slugFromRemote(root);
  const token = requireToken();

  const openPulls = await listPulls(slug, { state: "open" });
  const existing = openPulls.find((pull) => (pull.head ?? pull.source_branch?.ref ?? "").includes(branch));
  if (existing) {
    log(`已有当日 PR #${existing.number}（${branch}），跳过重复创建`);
    return { changed: true, branch, pull: existing.number, summary, reused: true };
  }

  if (dryRun) {
    log(`--dry-run：将创建分支 ${branch} 并提交 ${changed.length} 个文件`);
    return { changed: true, branch, dryRun: true, summary };
  }

  git(["-C", root, "config", "user.name", "cnb-oss-watch-bot"]);
  git(["-C", root, "config", "user.email", "oss-watch-bot@cnb.cool"]);
  git(["-C", root, "checkout", "-b", branch]);
  git(["-C", root, "add", "--", ...WATCHED_PATHS]);
  const subject = `chore(deps): 开源组件清单与更新计划周期刷新（oss-watch 自动扫描）${taskId ? ` [${taskId}]` : ""}`;
  git(["-C", root, "commit", "-m", subject]);
  const pushedVia = pushBranch(root, slug, branch, token, log);
  log(`✓ 已推送分支 ${branch}（${pushedVia}）`);

  const lines = [];
  lines.push("## oss-watch 周期扫描（自动）");
  lines.push("");
  lines.push(`- 扫描时间：${summary.scannedAt}`);
  lines.push(`- 登记组件有更新：**${summary.componentUpdates}** 个 ｜ 直接依赖有更新：**${summary.dependencyUpdates}** 个`);
  lines.push(`- npm 查询 ${summary.npmQueried} 个 ｜ PyPI 查询 ${summary.pypiQueried} 个 ｜ 查询失败 ${summary.failures.length} 个`);
  lines.push(`- 变更文件：${changed.map((file) => `\`${file}\``).join("、")}`);
  lines.push("");
  lines.push("## 升级纪律（人工执行）");
  lines.push("");
  lines.push("1. 在 `docs/oss-update-plan.md` 圈定本轮批次（dsh 永远单独一批）；");
  lines.push("2. 按组件 gate 逐项升级并过门禁（smoke/standard/full/runtime-gate）；");
  lines.push("3. 全绿后更新 `oss-components.json` 的 current 并发布。");
  lines.push("");
  lines.push("> 本 PR 只刷新事实与计划，**不代表任何升级已批准**。");
  if (summary.failures.length) {
    lines.push("");
    lines.push("## 上游查询失败（需人工复核）");
    lines.push("");
    for (const failure of summary.failures.slice(0, 20)) lines.push(`- \`${failure}\``);
  }

  const pull = await createPull(slug, {
    title: `chore(deps): 开源组件清单与更新计划周期刷新（${date}）`,
    head: branch,
    base: "main",
    body: lines.join("\n"),
  });
  log(`✓ 已创建 PR #${pull?.number ?? "?"}（${branch}）`);
  return { changed: true, branch, pull: pull?.number, summary };
}

async function main() {
  const cwd = resolve(process.env.CNB_BUILD_WORKSPACE ?? process.cwd());
  const taskId = process.argv.includes("--task-id") ? process.argv[process.argv.indexOf("--task-id") + 1] : "";
  const result = await run({ cwd, dryRun: process.argv.includes("--dry-run"), taskId });
  const exitZero = process.argv.includes("--exit-zero");
  process.exit(result.changed && !exitZero ? 2 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`✗ oss-watch-ci 执行失败：${error?.stack ?? error}`);
    process.exit(1);
  });
}
