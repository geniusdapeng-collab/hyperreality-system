#!/usr/bin/env node
/**
 * 任务卡自动化（把"手动写 JSON"变成一条命令）。
 *
 *   node scripts/tools/task.mjs new --repo workloom-ai/workloom-hotel --title "修复差评 SLA" \
 *        --q1 industry --q3 workloom-hotel --q4 "单测+打包门禁；回滚=revert" [--risk review] [--labels t/draft]
 *   node scripts/tools/task.mjs list [--repo ...] [--state open]
 *   node scripts/tools/task.mjs receipt --repo ... --id T-2026-0918-0042 --progress "..." \
 *        --decisions "..." --next "..." [--close]
 */
import { closeIssue, createIssue, createIssueComment, listIssues } from "./cnb-api.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function nextTaskId(existing) {
  // 任务号格式由 docs/DEVELOPMENT-PROTOCOL.md §5 与 scripts/ci/protocol-rules.mjs#TASK_ID_RE 定义：
  // T-YYYY-MMDD-XXXX（四段八位→四段），此前按 T-YYYYMMDD-XXXX 生成会被提交信息门禁判为「缺少任务号」。
  const now = new Date();
  const year = now.getUTCFullYear();
  const monthDay = `${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  const prefix = `T-${year}-${monthDay}`;
  const today = new RegExp(`${prefix}-(\\d{4})`);
  let max = 0;
  for (const issue of existing) {
    const match = today.exec(issue.title ?? "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

async function commandNew() {
  const repo = arg("--repo");
  const title = arg("--title");
  if (!repo || !title) throw new Error("new 需要 --repo 与 --title");
  const existing = await listIssues(repo, { state: "all" });
  const taskId = arg("--id", nextTaskId(existing));
  const card = {
    task_id: taskId,
    title,
    source: arg("--source", "human"),
    four_questions: {
      q1_layer: arg("--q1", "base"),
      q2_trust_elements_touched: arg("--q2", "") ? arg("--q2").split(",") : [],
      q3_target_repos: arg("--q3", repo.split("/").pop()).split(","),
      q4_test_rollback_plan: arg("--q4", "待补：测试与回滚方案"),
    },
    scope: { repos: [repo.split("/").pop()], paths: arg("--paths", "**").split(",") },
    acceptance: arg("--acceptance", "见任务描述").split(","),
    risk_tier: arg("--risk", "normal"),
    protocol_version: arg("--protocol", "1.0.0"),
    status: "draft",
  };
  const issue = await createIssue(repo, {
    title: `[${taskId}] ${title}`,
    labels: arg("--labels", "t/draft").split(","),
    body: ["## 任务卡", "", "```json", JSON.stringify(card, null, 2), "```"].join("\n"),
  });
  console.log(`任务卡已创建：${repo} #${issue?.number} ${taskId}`);
  console.log(`分支建议：task/${taskId}`);
  return { repo, number: issue?.number, taskId };
}

async function commandList() {
  const repo = arg("--repo");
  const state = arg("--state", "open");
  if (!repo) throw new Error("list 需要 --repo");
  const issues = await listIssues(repo, { state });
  for (const issue of issues) {
    console.log(`#${issue.number} ${issue.state} ${issue.title}`);
  }
  console.log(`共 ${issues.length} 张`);
}

async function commandReceipt() {
  const repo = arg("--repo");
  const taskId = arg("--id");
  if (!repo || !taskId) throw new Error("receipt 需要 --repo 与 --id");
  const issues = await listIssues(repo, { state: "all" });
  const issue = issues.find((item) => (item.title ?? "").includes(taskId));
  if (!issue) throw new Error(`未找到任务卡 ${taskId}`);
  const lines = [
    `**回执 · ${taskId}**`,
    "",
    `- 进展：${arg("--progress", "（未填写）")}`,
    `- 决策：${arg("--decisions", "（未填写）")}`,
    `- 未完成：${arg("--open", "无")}`,
    `- 下一步：${arg("--next", "（未填写）")}`,
    `- 分支状态：${arg("--branch", "已合并/可删")}`,
  ];
  await createIssueComment(repo, issue.number, lines.join("\n"));
  if (process.argv.includes("--close")) await closeIssue(repo, issue.number);
  console.log(`回执已写入 #${issue.number}${process.argv.includes("--close") ? "，并已关单" : ""}`);
}

const command = process.argv[2];
const run = { new: commandNew, list: commandList, receipt: commandReceipt }[command];
if (!run) {
  console.error("用法：task.mjs <new|list|receipt> [options]");
  process.exit(2);
}
run().catch((error) => {
  console.error(`任务卡命令失败：${error?.message ?? error}`);
  process.exit(1);
});
