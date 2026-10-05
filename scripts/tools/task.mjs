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
import { closeIssue, createIssue, createIssueComment, getPull, listIssues, redactCredentials, requireToken } from "./cnb-api.mjs";
import { GitStateStore } from '../delivery/git-state.mjs';
import { parseIntent } from '../delivery/queue-model.mjs';
import { Platform } from '../delivery/queue-platform.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyTaskCompletion(repo, number, taskId, { readPull = getPull, store, platform } = {}) {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('--close requires an exact --pr number');
  const pull = await readPull(repo, number);
  const intent = parseIntent(pull);
  if (intent.taskId !== taskId) throw new Error('PR belongs to another task');
  const state = await (store ?? new GitStateStore({ repo, token: requireToken() })).read();
  const task = state.tasks[String(number)];
  if (!task?.merge || task.merge.sourceSha !== pull.head?.sha || !['integrated', 'delivered'].includes(task.status) || task.intent?.taskId !== taskId ||
    task.mergeSnapshot?.headSha !== task.merge.sourceSha || task.mergeSnapshot.mainSha !== task.merge.mainSha || task.mergeSnapshot.checkSha !== task.merge.checkSha) throw new Error('Task has no current verified integration/delivery receipt');
  await (platform ?? new Platform(repo, requireToken())).verifyMerge(task.mergeSnapshot, { sha: task.merge.sha });
  const declarations = [...new Map([...(task.intent?.releases ?? []), ...intent.releases].map(item => [`${item.kind}:${item.version.replace(/^v/, '')}`, item])).values()];
  for (const declaration of declarations) {
    const version = declaration.version.replace(/^v/, '');
    const receipt = Object.values(state.releases).find(release => release.number === number && release.sha === task.merge.sha && release.kind === declaration.kind && release.version.replace(/^v/, '') === version);
    if (!receipt || receipt.status !== 'delivered' || receipt.receipt?.sha !== task.merge.sha) throw new Error('Declared release lacks a verified frozen-source byte receipt');
  }
  return { number, integrated: true, releaseDeclared: declarations.length > 0 };
}

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
  if (process.argv.includes('--close')) await verifyTaskCompletion(repo, Number(arg('--pr')), taskId);
  const lines = [
    `**回执 · ${taskId}**`,
    "",
    `- 进展：${arg("--progress", "（未填写）")}`,
    `- 决策：${arg("--decisions", "（未填写）")}`,
    `- 未完成：${arg("--open", "无")}`,
    `- 下一步：${arg("--next", "（未填写）")}`,
    `- 分支状态：${arg("--branch", process.argv.includes('--close') ? '已核验合入；源分支保留' : '未核验；源分支保留')}`,
  ];
  await createIssueComment(repo, issue.number, lines.join("\n"));
  if (process.argv.includes("--close")) await closeIssue(repo, issue.number);
  console.log(`回执已写入 #${issue.number}${process.argv.includes("--close") ? "，并已关单" : ""}`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const run = { new: commandNew, list: commandList, receipt: commandReceipt }[command];
  if (!run) { console.error('用法：task.mjs <new|list|receipt> [options]'); process.exitCode = 2; }
  else run().catch(error => { console.error(`任务卡命令失败：${redactCredentials(error.message)}`); process.exitCode = 1; });
}
