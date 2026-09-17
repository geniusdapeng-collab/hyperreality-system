/**
 * scripts/verify-devfabric.ts · 开发场域六站流水线真实验证
 * 假机床（node 脚本模拟 Codex JSONL 协议 + 真实写文件 + 故意打印假凭据测脱敏）
 * 走真管线：登记仓库 → S2 建单/确认 → S3 派发（真 spawn+worktree+快照）
 *   → S4 三道关（硬门禁+LLM兜底+上线考）→ S5 批准 → S6 合并/tag/版本台账
 * 用法：pnpm tsx --env-file=.env scripts/verify-devfabric.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setDevToolAdapters, refreshTools, registerRepo, createTask, confirmTask,
  dispatchTask, taskDetail, sessionEvents, approveRelease, listReleases,
} from "../apps/server/src/service/devtools.js";
import { CodexAdapter } from "@workloom/base/dev-bridge";

const WS = process.env.VERIFY_WS ?? "ws-aipm-demo";
const ACTOR = { id: "verify-human", type: "human" as const };

/** 假 Codex：detect 直接命中 node；buildArgs 跑夹具脚本 */
const FIXTURE_SCRIPT = `
const fs = require("node:fs");
fs.mkdirSync("src", { recursive: true });
fs.writeFileSync("src/greeting.ts", "export const greeting = () => '你好，开发场域';\\n");
const lines = [
  {"type":"thread.started","thread_id":"th-verify-1"},
  {"type":"item.started","item":{"type":"command_execution","command":"mkdir -p src"}},
  {"type":"item.completed","item":{"type":"file_change","changes":[{"path":"src/greeting.ts"}]}},
  {"type":"item.completed","item":{"type":"agent_message","text":"已实现问候函数（附带一句 sk-FAKEKEYFAKEKEY123456 测脱敏）"}},
  {"type":"turn.completed","usage":{"input_tokens":800,"output_tokens":120}}
];
for (const l of lines) console.log(JSON.stringify(l));
`;
class FixtureCodex extends CodexAdapter {
  override async detect() {
    return { toolKey: "codex", binPath: process.execPath, version: "fixture-codex 0.0.0",
      capabilities: this.capabilities(), detectedAt: new Date().toISOString() };
  }
  override buildArgs(): string[] { return ["-e", FIXTURE_SCRIPT]; }
}

function initDemoRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "devfabric-e2e-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "v@v"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "v"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# e2e demo\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("== ① 注入夹具适配器并刷新设备台账");
  setDevToolAdapters([new FixtureCodex()]);
  const tools = await refreshTools(WS, ACTOR);
  const codex = tools.tools.find((t) => t.toolKey === "codex");
  if (!codex?.install) throw new Error("夹具机床未上台账");
  console.log("   ✓ codex(夹具) 在册:", (codex.install as { version: string }).version);

  console.log("== ② 登记仓库白名单（真实 git 仓库）");
  const repoDir = initDemoRepo();
  const { repo } = await registerRepo(WS, { name: "e2e-demo", path: repoDir, baselineBranch: "main" }, ACTOR);
  console.log("   ✓ 已登记:", (repo as { id: string }).id, repoDir);

  console.log("== ③ S2 建任务单 + 人审确认");
  const { task } = await createTask(WS, {
    repoId: (repo as { id: string }).id, title: "新增问候函数",
    prdSummary: "在 src/ 下新增 greeting.ts，导出一个返回中文问候语的函数。",
    acceptance: ["src/greeting.ts 存在且导出 greeting 函数", "不改变 README"],
    changeKind: "feat",
  }, ACTOR);
  const taskId = (task as { id: string }).id;
  await confirmTask(WS, taskId, ACTOR);
  console.log("   ✓ 任务单已确认:", taskId);

  console.log("== ④ S3 派发（真 spawn + worktree 隔离 + 快照）");
  const disp = await dispatchTask(WS, taskId, ACTOR);
  console.log("   ✓ 会话启动:", disp.sessionId, "分支:", disp.branch);

  console.log("== ⑤ 等待 S4 三道关（含上线考）...");
  let detail = await taskDetail(WS, taskId);
  const deadline = Date.now() + 180_000;
  while (!["pending_approval", "failed", "confirmed"].includes((detail.task as { status: string }).status) && Date.now() < deadline) {
    await sleep(2000);
    detail = await taskDetail(WS, taskId);
  }
  // confirmed 说明在返修途中，继续等
  while ((detail.task as { status: string }).status === "confirmed" && Date.now() < deadline) {
    await sleep(3000);
    detail = await taskDetail(WS, taskId);
  }
  const status = (detail.task as { status: string }).status;
  console.log("   任务状态:", status);
  if (status !== "pending_approval") {
    console.log("   ✗ 未达待审批——审查记录:", JSON.stringify(detail.changesets[0]?.gate_results ?? detail.task, null, 2).slice(0, 1200));
    process.exit(1);
  }
  const gates = detail.changesets[0]?.gate_results as { hardGates: Array<{ name: string; ok: boolean }>; exam: { verdict: string | null; mock: boolean } };
  console.log("   ✓ 三道关全过。硬门禁:", gates.hardGates.map((g) => `${g.name}:${g.ok ? "✓" : "✗"}`).join(" "),
    "| 上线考 verdict:", gates.exam.verdict ?? `(mock:${gates.exam.mock})`);

  console.log("== ⑥ 校验事件流与凭据脱敏");
  const evts = await sessionEvents(WS, disp.sessionId);
  const types = (evts.events as Array<{ type: string }>).map((e) => e.type);
  for (const t of ["started", "command_run", "file_edited", "progress"]) {
    if (!types.includes(t)) throw new Error(`事件流缺 ${t}`);
  }
  const raw = JSON.stringify(evts.events);
  if (raw.includes("sk-FAKEKEYFAKEKEY123456")) throw new Error("凭据未脱敏！");
  if (!raw.includes("†已脱敏†")) throw new Error("脱敏标记未出现");
  console.log("   ✓ 事件流完整（", types.length, "条），假凭据已脱敏");

  console.log("== ⑦ S5 批准 → S6 版本台账");
  const { release } = await approveRelease(WS, taskId, {}, ACTOR);
  const rel = release as { version: string; merge_commit: string };
  console.log("   ✓ 发布:", rel.version, "合并:", rel.merge_commit.slice(0, 8));

  console.log("== ⑧ 终验：git 侧与台账侧一致");
  const fileInMain = execFileSync("git", ["show", "main:src/greeting.ts"], { cwd: repoDir }).toString();
  if (!fileInMain.includes("你好，开发场域")) throw new Error("机床产出未进基线分支");
  const tags = execFileSync("git", ["tag", "--list"], { cwd: repoDir }).toString();
  if (!tags.includes(rel.version)) throw new Error(`tag ${rel.version} 未创建`);
  const { releases } = await listReleases(WS);
  if (!(releases as Array<{ version: string }>).some((r) => r.version === rel.version)) throw new Error("版本台账缺行");
  const taskFinal = await taskDetail(WS, taskId);
  if ((taskFinal.task as { status: string }).status !== "released") throw new Error("任务未置 released");
  console.log("   ✓ 基线含机床产出 / tag 就位 / 台账有行 / 任务=released");

  console.log("\n🎉 开发场域六站流水线全链路验证通过");
  process.exit(0);
}

main().catch((e) => { console.error("验证失败：", e); process.exit(1); });
