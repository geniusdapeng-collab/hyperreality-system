#!/usr/bin/env node
/**
 * 提交信息校验（docs/DEVELOPMENT-PROTOCOL.md §5）。
 *
 * 用法：
 *   node scripts/ci/verify-commit-msg.mjs                 # 校验 CNB_BEFORE_SHA..HEAD，缺失时退化为 HEAD
 *   node scripts/ci/verify-commit-msg.mjs --range A..B    # 指定范围
 *   node scripts/ci/verify-commit-msg.mjs --self-test     # 只跑内置样例，不读 git
 *   PROTOCOL_TASK_ID_OPTIONAL=1 node ...                  # 过渡期：只校格式，不强制任务号
 */
import { execFileSync } from "node:child_process";
import { isExemptSubject, parseCommitLog, validateSubject } from "./protocol-rules.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveRange() {
  const explicit = arg("--range");
  if (explicit) return explicit;
  const before = process.env.CNB_BEFORE_SHA?.trim();
  if (before) {
    try {
      git(["cat-file", "-e", `${before}^{commit}`]);
      return `${before}..HEAD`;
    } catch {
      /* 首次推送或浅克隆，退化为 HEAD */
    }
  }
  try {
    git(["rev-parse", "--verify", "HEAD~1"]);
    return "HEAD~1..HEAD";
  } catch {
    return "HEAD";
  }
}

function readCommits(range) {
  const out = git(["log", "--no-merges", "--format=%H\u001f%s", range]);
  return parseCommitLog(out);
}

function selfTest() {
  const cases = [
    ["feat(hotel): 徽章由 manifest 生成 [T-2026-0918-0042]", "workloom-hotel", true],
    ["ci(base): 新增协议门禁阶段 [T-2026-0918-0043]", "workloom-im", true],
    ["docs(cnb): 补迁移手册", "workloom-im", false],
    ["feat(hotel): 缺任务号", "workloom-hotel", false],
    ["feat(wrong): layer 不符 [T-2026-0918-0044]", "workloom-hotel", false],
    ["feat(base): 层名写错 [T-2026-0918-0045]", "workloom-hotel", false],
    ["HP-31 共同根因：UI 制品补 ESM 扩展名", "workloom-im", true],
    ["sync(base): 基座下发", "workloom-hotel", true],
    ["Merge branch 'main' into task/x", "workloom-im", true],
  ];
  let failed = 0;
  for (const [subject, repoSlug, shouldPass] of cases) {
    const errors = validateSubject(subject, { repoSlug });
    const passed = errors.length === 0;
    if (passed !== shouldPass) {
      failed += 1;
      console.error(`✗ self-test: "${subject}" 期望 ${shouldPass ? "通过" : "拒绝"}，实际相反`);
    }
  }
  if (failed) process.exit(1);
  console.log(`✓ verify-commit-msg self-test 通过（${cases.length} 例）`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const repoSlug = arg("--repo") ?? process.env.CNB_REPO_SLUG ?? null;
  const requireTaskId = process.env.PROTOCOL_TASK_ID_OPTIONAL !== "1";
  const range = resolveRange();
  const commits = readCommits(range);
  if (!commits.length) {
    console.log(`✓ 提交信息校验：范围 ${range} 无提交，跳过`);
    return;
  }

  let failed = 0;
  for (const { sha, subject } of commits) {
    if (isExemptSubject(subject)) {
      console.log(`- ${sha} 豁免：${subject}`);
      continue;
    }
    const errors = validateSubject(subject, { repoSlug, requireTaskId });
    if (errors.length) {
      failed += 1;
      console.error(`✗ ${sha} ${subject}`);
      for (const error of errors) console.error(`    - ${error}`);
    } else {
      console.log(`✓ ${sha} ${subject}`);
    }
  }

  if (failed) {
    console.error(`\n拒绝：${failed}/${commits.length} 条提交不符合 docs/DEVELOPMENT-PROTOCOL.md §5`);
    console.error("提示：任务号来自 CNB Issue 标题 [T-YYYYMMDD-XXXX]；自动化提交请用 sync(...) / chore(ci) 或设 PROTOCOL_TASK_ID_OPTIONAL=1。");
    process.exit(1);
  }
  console.log(`\n✓ 提交信息校验通过（${commits.length} 条，范围 ${range}）`);
}

main();

