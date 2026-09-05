/**
 * service/devtools · 开发场域（DevFabric）执行面
 * 六站流水线：S1 需求(prd-forge 已有) → S2 任务拆解(createTask/confirmTask)
 *   → S3 受管开发(dispatchTask：worktree 隔离+快照+会话+围栏)
 *   → S4 代码审计(harvest：硬门禁+LLM 评审+上线考)
 *   → S5 人审(approveRelease/rejectTask) → S6 版本台账(release)
 * 纪律：
 *  - 机床=设备（AI Coding CLI），权责在岗位层；主分支零直写（worktree 隔离）；
 *  - 未登记目录机床进不去（dev_repos 白名单+路径钳制双重强制）；
 *  - 凭据 L4 注入（env 透传，不进事件明文）；payload 落库前凭据模式脱敏；
 *  - 高危命令默认拦截（deny/escalate 留痕进 dev_fences_audit）；推送远端永远走审批；
 *  - 五元事件镜像关键节点（dispatched/session_end/gates/released/rejected），哈希链零丢失。
 */
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { svcQuery, serviceTx, appendEventOn } from "./events.js";
import { llmCall } from "./llm.js";
import { runExam } from "./eval.js";
import {
  defaultAdapters, startSession, buildTaskPrompt, judgeCommand,
  assertGitRepo, baselineCommit, statusFingerprint, worktreeAdd, worktreeDiscard,
  collectDiff, commitWorktreeChanges, mergeIntoBaseline, createTag, listTags,
  detectGateScripts, suggestVersion,
  type CodingToolAdapter, type DevEvent, type RunningSession, type Changeset,
} from "@workloom/base/dev-bridge";

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const MAX_REPAIR_ROUNDS = 2;
const SESSION_TIMEOUT_MS = Number(process.env.WORKLOOM_DEV_SESSION_TIMEOUT_MS ?? 30 * 60_000);
const MAX_FENCE_DENIALS = 3;
const EXAM_BLOCK_VERDICT = "fail";   // 上线考 fail 才拦（pass/warn 放行——warn 已有人工复核环节兜底）

type Actor = { id: string; type: "human" | "agent" };

/* ---------------- 依赖注入：适配器注册表（验证环境可换夹具） ---------------- */
let adapters: CodingToolAdapter[] = defaultAdapters();
export function setDevToolAdapters(custom: CodingToolAdapter[]): void { adapters = custom; }
function adapterOf(toolKey: string): CodingToolAdapter | undefined {
  return adapters.find((a) => a.toolKey === toolKey);
}

/* ---------------- 运行态会话登记（进程内） ---------------- */
const running = new Map<string, RunningSession>();   // taskId -> session

/* ---------------- 凭据（L4：secret 不出进程、不进事件明文） ---------------- */
const TOOL_CRED_PROVIDER: Record<string, string[]> = {
  codex: ["openai", "codex"],
  "claude-code": ["anthropic", "claude"],
  aider: ["openai", "anthropic"],
};
const PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
};
async function buildToolEnv(workspaceId: string, toolKey: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const provider of TOOL_CRED_PROVIDER[toolKey] ?? []) {
    const rows = await svcQuery<{ secret_enc: string }>(workspaceId,
      `SELECT secret_enc FROM credentials WHERE provider=$1 AND health != 'revoked' LIMIT 1`, [provider]);
    const secret = rows[0]?.secret_enc ?? process.env[`AIPM_${provider.toUpperCase()}_TOKEN`];
    if (secret && PROVIDER_ENV[provider] && !process.env[PROVIDER_ENV[provider]]) {
      env[PROVIDER_ENV[provider]] = secret;
    }
  }
  return env;
}

/** 凭据模式脱敏（payload 落库前） */
const SECRET_RE = /(sk-[a-zA-Z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN[^-]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{20,})/g;
function redact<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload, (_k, v) =>
    typeof v === "string" ? v.replace(SECRET_RE, "†已脱敏†") : v)) as T;
}

/* ================= S0 设备与仓库（供给） ================= */

/** 探测台账 + 全部已知适配器（未安装的附安装指引——真运行态纪律） */
export async function listTools(workspaceId: string) {
  const installs = await svcQuery(workspaceId,
    `SELECT * FROM dev_tool_installs ORDER BY detected_at DESC`);
  const known = adapters.map((a) => ({
    toolKey: a.toolKey, displayName: a.displayName, capabilities: a.capabilities(),
    install: installs.find((i) => (i as { tool_key?: string }).tool_key === a.toolKey) ?? null,
  }));
  return { tools: known };
}

/** 重新探测本机设备（PATH 扫描 + 版本握手；消失的标 lost） */
export async function refreshTools(workspaceId: string, actor: Actor) {
  const found: string[] = [];
  for (const adapter of adapters) {
    const install = await adapter.detect().catch(() => null);
    if (!install) {
      await svcQuery(workspaceId,
        `UPDATE dev_tool_installs SET status='lost', detected_at=now() WHERE workspace_id=$1 AND tool_key=$2`,
        [workspaceId, adapter.toolKey]).catch(() => undefined);
      continue;
    }
    found.push(adapter.toolKey);
    const credEnv = await buildToolEnv(workspaceId, adapter.toolKey);
    const credHealth = Object.keys(credEnv).length > 0 || adapter.toolKey === "codex" || adapter.toolKey === "claude-code"
      ? "unknown" : "unknown";   // CLI 自有登录态（~/.codex 等），凭据表只是补充——健康度诚实标 unknown
    await svcQuery(workspaceId,
      `INSERT INTO dev_tool_installs (id, workspace_id, tool_key, bin_path, version, capabilities, credential_health, status, detected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',now())
       ON CONFLICT (workspace_id, tool_key) DO UPDATE
         SET bin_path=EXCLUDED.bin_path, version=EXCLUDED.version, capabilities=EXCLUDED.capabilities,
             status='active', detected_at=now()`,
      [`dti-${adapter.toolKey}`, workspaceId, adapter.toolKey, install.binPath, install.version,
       JSON.stringify(install.capabilities), credHealth]);
  }
  if (found.length > 0) {
    await serviceTx(workspaceId, async (client, sc) => {
      await appendEventOn(client, sc, actor, {
        objectType: "dev_tools", objectId: workspaceId,
        action: "dev.tools.refresh", after: { found },
      });
    });
  }
  return listTools(workspaceId);
}

export async function listRepos(workspaceId: string) {
  return { repos: await svcQuery(workspaceId, `SELECT * FROM dev_repos ORDER BY created_at DESC`) };
}

/** 登记仓库（白名单唯一入口；登记即校验确为 git 仓库） */
export async function registerRepo(workspaceId: string, input: {
  name: string; path: string; baselineBranch?: string; allowedDirs?: string[];
}, actor: Actor) {
  const absPath = resolve(input.path);
  await assertGitRepo(absPath);   // 不是 git 仓库直接抛错
  const id = newId("dr");
  const repo = await serviceTx(workspaceId, async (client, sc) => {
    const r = await client.query(
      `INSERT INTO dev_repos (id, workspace_id, name, path, baseline_branch, allowed_dirs, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, path) DO UPDATE SET name=EXCLUDED.name, status='active'
       RETURNING *`,
      [id, workspaceId, input.name, absPath, input.baselineBranch ?? "main",
       JSON.stringify(input.allowedDirs ?? []), actor.id]);
    await appendEventOn(client, sc, actor, {
      objectType: "dev_repo", objectId: id, action: "dev.repo.register",
      after: { name: input.name, path: absPath },
    });
    return r.rows[0];
  });
  return { repo };
}

export async function setRepoStatus(workspaceId: string, repoId: string, status: "active" | "disabled", actor: Actor) {
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(`UPDATE dev_repos SET status=$3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, repoId, status]);
    await appendEventOn(client, sc, actor, { objectType: "dev_repo", objectId: repoId, action: `dev.repo.${status}` });
  });
  return { ok: true };
}

/* ================= S2 任务拆解 ================= */

export async function createTask(workspaceId: string, input: {
  prdRef?: string; repoId: string; title: string; prdSummary: string;
  acceptance: string[]; constraints?: string[]; changeKind?: "feat" | "fix" | "breaking" | "chore";
  assignedTool?: string;
}, actor: Actor) {
  const repos = await svcQuery<{ id: string; name: string; status: string }>(workspaceId,
    `SELECT id, name, status FROM dev_repos WHERE id=$1`, [input.repoId]);
  const repo = repos[0];
  if (!repo) throw new Error("仓库未登记——先登记白名单（机床未登记目录进不去）");
  if (repo.status !== "active") throw new Error("仓库已停用");
  if (input.acceptance.length === 0) throw new Error("验收标准至少一条（逐条可测，机床才知道什么叫完成）");

  const id = newId("dt");
  const prompt = buildTaskPrompt({
    prdTitle: input.title, prdSummary: input.prdSummary,
    acceptance: input.acceptance, constraints: input.constraints, repoName: repo.name,
  });
  const task = await serviceTx(workspaceId, async (client, sc) => {
    const r = await client.query(
      `INSERT INTO dev_tasks (id, workspace_id, prd_ref, repo_id, title, task_prompt, acceptance, constraints, assigned_tool, change_kind, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, workspaceId, input.prdRef ?? null, input.repoId, input.title, prompt,
       JSON.stringify(input.acceptance), JSON.stringify(input.constraints ?? []),
       input.assignedTool ?? null, input.changeKind ?? "feat", actor.id]);
    await appendEventOn(client, sc, actor, {
      objectType: "dev_task", objectId: id, action: "dev.task.create",
      after: { title: input.title, repo: repo.name, acceptance: input.acceptance.length },
    });
    return r.rows[0];
  });
  return { task };
}

/** S2 人审确认（拆解确认卡：确认才进 S3——拆错了比不拆更浪费） */
export async function confirmTask(workspaceId: string, taskId: string, actor: Actor) {
  return transit(workspaceId, taskId, ["draft", "rejected"], "confirmed", actor, "dev.task.confirm");
}

async function transit(workspaceId: string, taskId: string, from: string[], to: string, actor: Actor, action: string, extra?: Record<string, unknown>) {
  const rows = await svcQuery<{ status: string }>(workspaceId,
    `SELECT status FROM dev_tasks WHERE id=$1`, [taskId]);
  if (!rows[0]) throw new Error(`任务单不存在：${taskId}`);
  if (!from.includes(rows[0].status)) throw new Error(`任务单状态 ${rows[0].status} 不允许此操作（需 ${from.join("/")}）`);
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(`UPDATE dev_tasks SET status=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, taskId, to]);
    await appendEventOn(client, sc, actor, { objectType: "dev_task", objectId: taskId, action, after: extra ?? { to } });
  });
  return { ok: true, status: to };
}

/* ================= S3 受管开发 ================= */

interface TaskRow {
  id: string; repo_id: string; title: string; task_prompt: string; status: string;
  assigned_tool: string | null; repair_round: number; review_note: string | null;
  [key: string]: unknown;
}
interface RepoRow {
  id: string; name: string; path: string; baseline_branch: string; status: string;
  [key: string]: unknown;
}

async function pickTool(workspaceId: string, assigned: string | null): Promise<{ adapter: CodingToolAdapter; binPath: string }> {
  const installs = await svcQuery<{ tool_key: string; bin_path: string }>(workspaceId,
    `SELECT tool_key, bin_path FROM dev_tool_installs WHERE status='active'`);
  if (assigned) {
    const hit = installs.find((i) => i.tool_key === assigned);
    const adapter = adapterOf(assigned);
    if (!hit || !adapter) throw new Error(`指派机床 ${assigned} 不在线——先刷新设备探测`);
    return { adapter, binPath: hit.bin_path };
  }
  // 自动选派：注册表顺序即优先级（Codex 优先）
  for (const adapter of adapters) {
    const hit = installs.find((i) => i.tool_key === adapter.toolKey);
    if (hit) return { adapter, binPath: hit.bin_path };
  }
  throw new Error("没有已连接的机床——请在「设备」页按指引安装 Codex / Claude Code / Aider 后刷新探测");
}

/** 派发任务（异步执行：函数立即返回，会话在后台跑，前端轮询） */
export async function dispatchTask(workspaceId: string, taskId: string, actor: Actor) {
  if (running.has(taskId)) throw new Error("任务已有会话在跑");
  const tasks = await svcQuery<TaskRow>(workspaceId, `SELECT * FROM dev_tasks WHERE id=$1`, [taskId]);
  const task = tasks[0];
  if (!task) throw new Error("任务单不存在");
  if (!["confirmed", "auditing"].includes(task.status)) {
    throw new Error(`状态 ${task.status} 不可派发（需 confirmed；返修由系统自动再派）`);
  }
  const repos = await svcQuery<RepoRow>(workspaceId, `SELECT * FROM dev_repos WHERE id=$1`, [task.repo_id]);
  const repo = repos[0]!;
  const { adapter, binPath } = await pickTool(workspaceId, task.assigned_tool);

  // 隔离 + 快照（快照先行：任何一步失控可整棵丢弃）
  const { worktreePath, branch } = await worktreeAdd(repo.path, task.id, repo.baseline_branch);
  if (!resolve(worktreePath).startsWith(resolve(repo.path) + sep)) {
    throw new Error("worktree 路径钳制失败——越界拒跑");
  }
  const baseCommit = await baselineCommit(repo.path, repo.baseline_branch);
  const fingerprint = await statusFingerprint(repo.path);

  const sessionId = newId("ds");
  const extraEnv = await buildToolEnv(workspaceId, adapter.toolKey);
  // 返修第 2 轮起：带打回原因续跑（有 thread 则 resume）
  const lastSession = await svcQuery<{ thread_id: string | null }>(workspaceId,
    `SELECT thread_id FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1`, [taskId]);
  const resumeId = task.repair_round > 0 && adapter.capabilities().sessionResume
    ? lastSession[0]?.thread_id ?? undefined : undefined;
  const repairNote = task.repair_round > 0 && task.review_note
    ? `\n\n# 上轮打回原因（必须逐条解决）\n${task.review_note}` : "";

  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(
      `INSERT INTO dev_sessions (id, workspace_id, task_id, tool_key, worktree_path, branch, baseline_commit, status_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sessionId, workspaceId, taskId, adapter.toolKey, worktreePath, branch, baseCommit, fingerprint]);
    await client.query(`UPDATE dev_tasks SET status='running', updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, taskId]);
    await appendEventOn(client, sc, actor, {
      objectType: "dev_task", objectId: taskId, action: "dev.task.dispatch",
      after: { tool: adapter.toolKey, branch, sessionId, repairRound: task.repair_round },
    });
  });

  // —— 启动受管会话（后台） ——
  let seq = 0;
  const persistEvent = async (type: string, payload: Record<string, unknown>) => {
    seq += 1;
    await svcQuery(workspaceId,
      `INSERT INTO dev_events (workspace_id, session_id, seq, type, payload) VALUES ($1,$2,$3,$4,$5)`,
      [workspaceId, sessionId, seq, type, JSON.stringify(redact(payload))]).catch(() => undefined);
  };
  const session = startSession(adapter, binPath, {
    taskId, prompt: task.task_prompt + repairNote, worktreePath,
    timeoutMs: SESSION_TIMEOUT_MS, maxFenceDenials: MAX_FENCE_DENIALS, resumeId, extraEnv,
  }, {
    onEvent: async (ev: DevEvent) => {
      if (ev.type === "started") {
        await svcQuery(workspaceId, `UPDATE dev_sessions SET thread_id=$3 WHERE workspace_id=$1 AND id=$2 AND $3 IS NOT NULL`,
          [workspaceId, sessionId, ev.threadId ?? null]).catch(() => undefined);
      }
      await persistEvent(ev.type, ev as unknown as Record<string, unknown>);
    },
    onFenceVerdict: async (cmd, verdict, ruleId, note) => {
      await svcQuery(workspaceId,
        `INSERT INTO dev_fences_audit (workspace_id, session_id, cmd, verdict, rule_id, note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [workspaceId, sessionId, redact(cmd), verdict, ruleId ?? null, note ?? null]).catch(() => undefined);
      await persistEvent("fence_verdict", { cmd, verdict, ruleId, note });
    },
  });
  running.set(taskId, session);

  // 会话终点 → S4 审计（后台接续，不阻塞派发响应）
  void session.result.then(async (result) => {
    running.delete(taskId);
    try {
      await svcQuery(workspaceId,
        `UPDATE dev_sessions SET ended_at=now(), exit_reason=$3, last_message=$4, usage=$5, thread_id=COALESCE($6, thread_id)
         WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, sessionId, result.exitReason, redact(result.lastMessage),
         JSON.stringify(result.usage ?? {}), result.threadId ?? null]);
      await serviceTx(workspaceId, async (client, sc) => {
        await appendEventOn(client, sc, { id: "dev-orchestrator", type: "agent" }, {
          objectType: "dev_task", objectId: taskId, action: "dev.session.end",
          after: { sessionId, exitReason: result.exitReason, usage: result.usage },
        });
      });
      if (result.exitReason === "done") {
        await harvest(workspaceId, taskId, sessionId, repo, actor);
      } else {
        await handleFailure(workspaceId, taskId, repo, worktreePath, branch,
          `机床会话异常结束：${result.exitReason}（${result.lastMessage.slice(0, 200)}）`, actor);
      }
    } catch (e) {
      await svcQuery(workspaceId,
        `UPDATE dev_tasks SET status='failed', review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, taskId, `审计管线异常：${(e as Error).message.slice(0, 300)}`]).catch(() => undefined);
    }
  });

  return { sessionId, tool: adapter.toolKey, branch };
}

/** 失败处置：返修（≤2 轮自动再派）或转人工 */
async function handleFailure(workspaceId: string, taskId: string, repo: RepoRow,
  worktreePath: string, branch: string, reason: string, actor: Actor) {
  const rows = await svcQuery<{ repair_round: number }>(workspaceId,
    `SELECT repair_round FROM dev_tasks WHERE id=$1`, [taskId]);
  const round = rows[0]?.repair_round ?? 0;
  if (round < MAX_REPAIR_ROUNDS) {
    await svcQuery(workspaceId,
      `UPDATE dev_tasks SET repair_round=repair_round+1, status='confirmed', review_note=$3, updated_at=now()
       WHERE workspace_id=$1 AND id=$2`, [workspaceId, taskId, reason]);
    await worktreeDiscard(repo.path, worktreePath, branch).catch(() => undefined);
    await dispatchTask(workspaceId, taskId, actor).catch(async (e) => {
      await svcQuery(workspaceId,
        `UPDATE dev_tasks SET status='failed', review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, taskId, `返修再派失败：${(e as Error).message.slice(0, 300)}`]);
    });
  } else {
    await svcQuery(workspaceId,
      `UPDATE dev_tasks SET status='failed', review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, taskId, `${reason}（返修 ${MAX_REPAIR_ROUNDS} 轮已尽，转人工）`]);
  }
}

/* ================= S4 代码审计（三道关） ================= */

interface GateResult { name: string; ok: boolean; log: string }

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<GateResult["log"] extends string ? { ok: boolean; log: string } : never> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      const log = `${stdout}${stderr}`.trim().slice(-1500);
      res({ ok: !err, log: log || (err ? String(err.message).slice(0, 300) : "(无输出)") });
    });
  });
}

/** 变更回收 + 三道关；全过 → pending_approval；不过 → 返修/转人工 */
async function harvest(workspaceId: string, taskId: string, sessionId: string, repo: RepoRow, actor: Actor) {
  const sessions = await svcQuery<{ worktree_path: string; branch: string; last_message: string | null }>(workspaceId,
    `SELECT worktree_path, branch, last_message FROM dev_sessions WHERE id=$1`, [sessionId]);
  const session = sessions[0]!;
  const tasks = await svcQuery<TaskRow>(workspaceId, `SELECT * FROM dev_tasks WHERE id=$1`, [taskId]);
  const task = tasks[0]!;
  await svcQuery(workspaceId, `UPDATE dev_tasks SET status='auditing', updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, taskId]);

  const diff = await collectDiff(session.worktree_path, repo.baseline_branch);
  const changeset: Changeset = { ...diff, selfSummary: session.last_message ?? "" };

  // —— 第一关：硬门禁（仓库自带 typecheck/lint/test + 凭据泄露扫描 + 禁改区比对） ——
  const hardGates: GateResult[] = [];
  const scripts = await detectGateScripts(session.worktree_path);
  const pm = existsSync(join(session.worktree_path, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  for (const [name, script] of Object.entries(scripts) as Array<[string, string]>) {
    if (!script) continue;
    const r = await runCmd(pm, ["run", script, "--if-present"], session.worktree_path);
    hardGates.push({ name, ok: r.ok, log: r.log });
    if (!r.ok) break;   // 一门不过不再烧时间
  }
  // 凭据泄露扫描（变更文件内容）
  const leaked: string[] = [];
  for (const f of [...diff.files.map((x) => x.path), ...diff.untracked]) {
    const p = join(session.worktree_path, f);
    if (!existsSync(p) || /node_modules|\.lock|lock\.yaml/.test(f)) continue;
    try {
      const content = readFileSync(p, "utf8");
      SECRET_RE.lastIndex = 0;
      if (SECRET_RE.test(content)) leaked.push(f);
    } catch { /* 二进制等跳过 */ }
  }
  hardGates.push({
    name: "secret-scan", ok: leaked.length === 0,
    log: leaked.length === 0 ? "变更文件未发现凭据模式" : `疑似凭据泄露：${leaked.join("、")}`,
  });

  // —— 第二关：LLM 评审（任务书 vs diff 对照；缺配置走确定性摘要兜底并标 mock） ——
  let llmReview: { ok: boolean; report: string; mock: boolean };
  const llm = llmCall("dev-review");
  const diffBrief = `任务：${task.title}\n机床自总结：${changeset.selfSummary.slice(0, 800)}\n变更统计：\n${diff.diffStat.slice(0, 1500)}\n未跟踪新文件：${diff.untracked.join("、") || "无"}`;
  if (llm) {
    try {
      const report = await llm(
        `你是发布守护。对照任务与变更统计做代码审计：①变更是否覆盖任务目标 ②有无明显夹带/坏味道/风险点。` +
        `首行输出结论：PASS 或 FAIL（附一句话理由），随后列要点。\n\n${diffBrief}`);
      const pass = /^\s*PASS/i.test(report);
      llmReview = { ok: pass, report: report.slice(0, 3000), mock: false };
    } catch (e) {
      llmReview = { ok: true, report: `（LLM 评审调用失败，降级放行由人工把关：${(e as Error).message.slice(0, 120)}）`, mock: true };
    }
  } else {
    llmReview = { ok: true, report: `（模型未配置，跳过 LLM 评审——硬门禁结果与 diff 请人工过目）`, mock: true };
  }

  // —— 第三关：上线考（eval-core 复用：变更即考，fail 才拦） ——
  let exam: { examId: string; score: number | null; verdict: string | null; mock: boolean };
  try {
    const r = await runExam(workspaceId, { examType: "on-change", triggerSource: `dev-task:${taskId}`, perStructure: 1 });
    exam = { examId: r.exam.id, score: r.exam.totalScore, verdict: r.exam.verdict, mock: false };
  } catch (e) {
    exam = { examId: "", score: null, verdict: null, mock: true };
    void e;
  }

  const hardOk = hardGates.every((g) => g.ok);
  const examOk = exam.verdict !== EXAM_BLOCK_VERDICT;
  const gatesPassed = hardOk && llmReview.ok && examOk;
  const gateResults = { hardGates, llmReview, exam };

  const changesetId = newId("dc");
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(
      `INSERT INTO dev_changesets (id, workspace_id, session_id, task_id, diff_stat, files, untracked, self_summary, gate_results, gates_passed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [changesetId, workspaceId, sessionId, taskId, diff.diffStat, JSON.stringify(diff.files),
       JSON.stringify(diff.untracked), redact(changeset.selfSummary), JSON.stringify(redact(gateResults)), gatesPassed]);
    await client.query(
      `UPDATE dev_tasks SET status=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, taskId, gatesPassed ? "pending_approval" : "auditing"]);
    await appendEventOn(client, sc, { id: "release-guardian", type: "agent" }, {
      objectType: "dev_task", objectId: taskId, action: "dev.gates.done",
      after: { changesetId, gatesPassed, hardOk, llmOk: llmReview.ok, examVerdict: exam.verdict },
    });
  });

  if (!gatesPassed) {
    const reasons = [
      ...hardGates.filter((g) => !g.ok).map((g) => `硬门禁 ${g.name} 未过：${g.log.slice(0, 300)}`),
      ...(llmReview.ok ? [] : [`LLM 评审未过：${llmReview.report.slice(0, 300)}`]),
      ...(examOk ? [] : [`上线考 verdict=fail（exam ${exam.examId}）`]),
    ].join("\n");
    const sessions2 = await svcQuery<{ worktree_path: string; branch: string }>(workspaceId,
      `SELECT worktree_path, branch FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1`, [taskId]);
    await handleFailure(workspaceId, taskId, repo, sessions2[0]!.worktree_path, sessions2[0]!.branch, reasons, actor);
  }
  return { changesetId, gatesPassed, gateResults };
}

/* ================= S5 人审 + S6 发布 ================= */

/** 打回（人类裁决：一句话意见回灌，重排返修） */
export async function rejectTask(workspaceId: string, taskId: string, note: string, actor: Actor) {
  const r = await transit(workspaceId, taskId, ["pending_approval", "running", "auditing"], "rejected", actor, "dev.task.reject", { note });
  running.get(taskId)?.cancel();
  await svcQuery(workspaceId,
    `UPDATE dev_tasks SET review_note=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, taskId, note]);
  return r;
}

export async function cancelTask(workspaceId: string, taskId: string, actor: Actor) {
  running.get(taskId)?.cancel();
  const sessions = await svcQuery<{ worktree_path: string; branch: string }>(workspaceId,
    `SELECT worktree_path, branch FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1`, [taskId]);
  const tasks = await svcQuery<{ repo_id: string }>(workspaceId, `SELECT repo_id FROM dev_tasks WHERE id=$1`, [taskId]);
  const repos = await svcQuery<RepoRow>(workspaceId, `SELECT * FROM dev_repos WHERE id=$1`, [tasks[0]?.repo_id ?? ""]);
  if (sessions[0] && repos[0]) {
    await worktreeDiscard(repos[0].path, sessions[0].worktree_path, sessions[0].branch).catch(() => undefined);
  }
  return transit(workspaceId, taskId, ["draft", "confirmed", "running", "auditing", "rejected", "failed"], "canceled", actor, "dev.task.cancel");
}

/** 批准发布（S5 人审 → S6 版本台账：合并→semver→tag→changelog→releases） */
export async function approveRelease(workspaceId: string, taskId: string, input: {
  version?: string; changelog?: string;
}, actor: Actor) {
  const tasks = await svcQuery<TaskRow>(workspaceId, `SELECT * FROM dev_tasks WHERE id=$1`, [taskId]);
  const task = tasks[0];
  if (!task) throw new Error("任务单不存在");
  if (task.status !== "pending_approval") throw new Error(`状态 ${task.status} 不可发布（需 pending_approval——三道关全过）`);

  const repos = await svcQuery<RepoRow>(workspaceId, `SELECT * FROM dev_repos WHERE id=$1`, [task.repo_id]);
  const repo = repos[0]!;
  const sessions = await svcQuery<{ id: string; worktree_path: string; branch: string }>(workspaceId,
    `SELECT id, worktree_path, branch FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC LIMIT 1`, [taskId]);
  const session = sessions[0]!;
  const changesets = await svcQuery<{ gate_results: unknown }>(workspaceId,
    `SELECT gate_results FROM dev_changesets WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1`, [taskId]);

  // 机床未提交的改动由系统兜底提交（合并前置）
  await commitWorktreeChanges(session.worktree_path, `feat(dev): ${task.title}（DevFabric 任务 ${task.id}）`);
  const mergeCommit = await mergeIntoBaseline(repo.path, repo.baseline_branch, session.branch);

  // semver 建议（人类可改）
  const tags = await listTags(repo.path);
  const tasksRow = await svcQuery<{ change_kind: string }>(workspaceId,
    `SELECT change_kind FROM dev_tasks WHERE id=$1`, [taskId]);
  const version = input.version ?? suggestVersion(tags[0] ?? null,
    (tasksRow[0]?.change_kind ?? "feat") as "feat" | "fix" | "breaking" | "chore");

  // changelog（LLM 优先生成；缺配置确定性模板兜底）
  let changelog = input.changelog ?? "";
  if (!changelog) {
    const llm = llmCall("dev-changelog");
    if (llm) {
      try {
        changelog = await llm(`为以下发布写一段中文 changelog（3-6 条要点，面向用户）：\n任务：${task.title}\n${changesets[0] ? JSON.stringify(changesets[0].gate_results).slice(0, 600) : ""}`);
      } catch { changelog = `- ${task.title}（DevFabric 自动发布）`; }
    } else {
      changelog = `- ${task.title}（DevFabric 自动发布）`;
    }
  }
  await createTag(repo.path, version, `release ${version}：${task.title}`);
  await worktreeDiscard(repo.path, session.worktree_path, session.branch).catch(() => undefined);

  const auditHash = createHash("sha1").update(JSON.stringify(changesets[0]?.gate_results ?? {})).digest("hex");
  const releaseId = newId("rel");
  const release = await serviceTx(workspaceId, async (client, sc) => {
    const r = await client.query(
      `INSERT INTO releases (id, workspace_id, repo_id, version, tasks, audit_hash, merge_commit, changelog, released_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [releaseId, workspaceId, repo.id, version, JSON.stringify([taskId]), auditHash, mergeCommit, changelog, actor.id]);
    await client.query(`UPDATE dev_tasks SET status='released', updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, taskId]);
    await appendEventOn(client, sc, actor, {
      objectType: "release", objectId: releaseId, action: "dev.release.approve",
      after: { version, taskId, repo: repo.name, mergeCommit: mergeCommit.slice(0, 8) },
    });
    return r.rows[0];
  });
  return { release };
}

/* ================= 查询面（P25 轮询） ================= */

export async function listTasks(workspaceId: string) {
  return { tasks: await svcQuery(workspaceId,
    `SELECT t.*, r.name AS repo_name FROM dev_tasks t JOIN dev_repos r ON r.id=t.repo_id
     ORDER BY t.created_at DESC LIMIT 100`) };
}

export async function taskDetail(workspaceId: string, taskId: string) {
  const tasks = await svcQuery(workspaceId,
    `SELECT t.*, r.name AS repo_name, r.path AS repo_path FROM dev_tasks t JOIN dev_repos r ON r.id=t.repo_id WHERE t.id=$1`, [taskId]);
  const sessions = await svcQuery(workspaceId,
    `SELECT * FROM dev_sessions WHERE task_id=$1 ORDER BY started_at DESC`, [taskId]);
  const changesets = await svcQuery(workspaceId,
    `SELECT * FROM dev_changesets WHERE task_id=$1 ORDER BY created_at DESC`, [taskId]);
  const fences = await svcQuery(workspaceId,
    `SELECT f.* FROM dev_fences_audit f JOIN dev_sessions s ON s.id=f.session_id
     WHERE s.task_id=$1 ORDER BY f.id DESC LIMIT 50`, [taskId]);
  return { task: tasks[0] ?? null, sessions, changesets, fences, live: running.has(taskId) };
}

/** 会话事件流（增量轮询：afterSeq 之后的新事件） */
export async function sessionEvents(workspaceId: string, sessionId: string, afterSeq = 0) {
  return { events: await svcQuery(workspaceId,
    `SELECT seq, type, payload, created_at FROM dev_events WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT 500`,
    [sessionId, afterSeq]) };
}

export async function listReleases(workspaceId: string) {
  return { releases: await svcQuery(workspaceId,
    `SELECT rel.*, r.name AS repo_name FROM releases rel JOIN dev_repos r ON r.id=rel.repo_id
     ORDER BY rel.released_at DESC LIMIT 50`) };
}
