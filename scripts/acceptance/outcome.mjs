#!/usr/bin/env node
/**
 * outcome.mjs · O 域受控任务套件执行器（RDAS v3.0 M2）
 *
 * 任务套件：acceptance/outcomes/*.yaml（格式见 docs/acceptance/outcome-suite.example.yaml）
 * 每次尝试：真实入口派发 → 轮询线程状态 → （可选）脚本化人工介入 → 状态断言/HTTP 断言/回执校验
 * 产出：outcome-report.json + trials.jsonl + outcome-report.md（pass@1 / pass^k / 假成功 / 介入计数）
 *
 * 纪律：结果以环境状态/回执为准；agent 自述完成但状态断言失败 → 记 falseSuccess（红线候选）。
 * 无 suite 时不伪造通过：写 configured=false 并生成模板，交给 report-v3 标“未验证”。
 *
 * 用法：node scripts/acceptance/outcome.mjs [--out <dir>] [--suite <yaml>] [--trials 5] [--timeout-s 120]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import YAML from "yaml";
import { cliArgs, findRepoRoot, loadProfile, urlsOf } from "./lib/profile.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const { profile, warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath);
const OUT_DIR = resolve(args.outDir ?? join(REPO_ROOT, "outputs", "acceptance", "outcome"));
mkdirSync(OUT_DIR, { recursive: true });
const URLS = urlsOf(profile);
const TRIALS = Number(process.env.ACCEPTANCE_TRIALS ?? (args.has("--trials") ? process.argv[process.argv.indexOf("--trials") + 1] : 5));
const TIMEOUT_S = Number(process.env.ACCEPTANCE_TASK_TIMEOUT_S ?? (args.has("--timeout-s") ? process.argv[process.argv.indexOf("--timeout-s") + 1] : 120));
const SUITE_DIR = join(REPO_ROOT, "acceptance", "outcomes");
const explicitSuite = args.has("--suite") ? process.argv[process.argv.indexOf("--suite") + 1] : null;

function readEnvValue(key) {
  const p = join(REPO_ROOT, ".env");
  if (!existsSync(p)) return undefined;
  const line = readFileSync(p, "utf-8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}
const DB_URL = process.env.DATABASE_URL ?? readEnvValue("DATABASE_URL");

const files = explicitSuite ? [resolve(REPO_ROOT, explicitSuite)] : (existsSync(SUITE_DIR) ? readdirSync(SUITE_DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(SUITE_DIR, f)) : []);
if (!files.length) {
  const template = `# RDAS v3.0 O 域任务套件模板（复制为 <role>.yaml 并填写）
role: channel-ops
agentPreset: channel-watcher
tasks:
  - id: O2-T01
    title: 为酒店写一条可发布的促销文案
    input: 为云栖酒店写一条周末促销文案，交付物：文案（含标题/正文/标签），截止：今天 18:00
    criticality: P0
    trials: 5
    allowClarify: true
    intervention: none        # none | approval | edit | reject
    state_asserts:
      - sql: "SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1 AND session_id=$2 AND payload->>'decision' IS NOT NULL"
        params: [workspaceId, threadId]
        op: ">="
        value: 1
    http_asserts:
      - url: "http://127.0.0.1:8787/health"
        status: 200
    receipt:
      require: false
      ref: acceptance/receipts/example.json
`;
  mkdirSync(SUITE_DIR, { recursive: true });
  writeFileSync(join(SUITE_DIR, "outcome-suite.example.yaml"), template);
  const report = { at: new Date().toISOString(), spec: "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v3.0", configured: false, note: "未配置 acceptance/outcomes/*.yaml；已生成模板。O 域按“未验证”处理。", trials: [] };
  writeFileSync(join(OUT_DIR, "outcome-report.json"), JSON.stringify(report, null, 1));
  writeFileSync(join(OUT_DIR, "outcome-report.md"), `# O 域任务套件报告\n\n未配置 \`acceptance/outcomes/*.yaml\`；已生成模板 \`acceptance/outcomes/outcome-suite.example.yaml\`。O 域按“结构合规/能力未验证”处理，不得写通过。\n`);
  console.log("[acceptance:outcome] 未配置任务套件：configured=false（已生成模板）");
  process.exit(0);
}

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();
const login = await fetch(`${URLS.api}/trpc/auth.loginAs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceSlug: profile.identity?.workspaceSlug ?? null, memberNo: profile.identity?.human ?? "MEM-001" }) });
const loginJson = await login.json().catch(() => ({}));
const TOKEN = loginJson?.result?.data?.token;
if (!TOKEN) throw new Error(`登录失败：${JSON.stringify(loginJson).slice(0, 200)}`);
const wsRow = profile.workspaceId
  ? (await client.query("SELECT id FROM workspaces WHERE id=$1", [profile.workspaceId])).rows[0]
  : (await client.query("SELECT id FROM workspaces WHERE slug=$1 LIMIT 1", [profile.identity?.workspaceSlug ?? ""])).rows[0];
if (!wsRow) throw new Error("找不到工作区");

const authHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const trpcPost = async (path, data) => {
  const res = await fetch(`${URLS.api}/trpc/${path}`, { method: "POST", headers: authHeaders, body: JSON.stringify(data) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const trpcGet = async (path, input) => {
  const res = await fetch(`${URLS.api}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const trials = [];
for (const file of files) {
  const suite = YAML.parse(readFileSync(file, "utf-8"));
  for (const task of suite.tasks ?? []) {
    const k = Number(task.trials ?? suite.trials ?? TRIALS);
    for (let t = 1; t <= k; t += 1) {
      const startedAt = Date.now();
      const trial = { suite: file.replace(REPO_ROOT, "."), taskId: task.id, title: task.title, criticality: task.criticality ?? "P1", trial: t, interventions: [], asserts: [], pass: false, clarify: false, falseSuccess: false, status: null, threadId: null, ms: 0 };
      try {
        const preset = task.presetKey ?? suite.agentPreset;
        const dispatchInput = { title: task.input ?? task.title };
        if (preset) dispatchInput.presetKey = preset;
        const dispatch = await trpcPost("threads.dispatch", dispatchInput);
        const d = dispatch.json?.result?.data ?? {};
        trial.kind = d.kind ?? "unknown";
        if (d.kind === "clarify") {
          trial.clarify = true;
          if (task.allowClarify === false || task.retryOnClarify === true) {
            const retryInput = { title: `${task.input ?? task.title}（交付物/截止已明确）` };
            if (preset) retryInput.presetKey = preset;
            const retry = await trpcPost("threads.dispatch", retryInput);
            trial.threadId = retry.json?.result?.data?.threadId ?? null;
          }
        } else trial.threadId = d.threadId ?? null;

        if (trial.threadId && task.intervention && task.intervention !== "none") {
          const gesture = task.intervention === "edit" ? "edit" : task.intervention === "reject" ? "reject" : "approve";
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            const queue = await trpcGet("approvals.list", { status: "pending" });
            const first = queue.json?.result?.data?.[0];
            if (first) {
              const body = { approvalId: first.approval_id, gesture };
              if (gesture === "edit") { body.editedAfter = task.editAfter ?? { note: "acceptance-edit" }; body.editKind = "correction"; }
              if (gesture === "reject") { body.reasonEnum = "other"; body.reasonText = "acceptance-reject"; }
              const decided = await trpcPost("approvals.decide", body);
              trial.interventions.push({ class: gesture === "approve" ? "H1" : gesture === "edit" ? "H2" : "H3", approvalId: first.approval_id, ok: decided.status === 200 });
              break;
            }
            await sleep(1000);
          }
        }

        if (trial.threadId) {
          const deadline = Date.now() + TIMEOUT_S * 1000;
          while (Date.now() < deadline) {
            const got = await trpcGet("threads.get", { threadId: trial.threadId });
            trial.status = got.json?.result?.data?.status ?? trial.status;
            if (["completed", "failed", "paused"].includes(trial.status)) break;
            await sleep(1500);
          }
        }
        for (const a of task.state_asserts ?? []) {
          try {
            const params = (a.params ?? []).map((p) => (p === "workspaceId" ? wsRow.id : p === "threadId" ? trial.threadId : p));
            const res = await client.query(a.sql, params);
            const value = res.rows?.[0]?.n ?? res.rows?.[0]?.count ?? res.rows?.[0]?.value ?? res.rows?.length ?? 0;
            const target = Number(a.value ?? 1);
            const num = Number(value);
            const ok = a.op === ">=" ? num >= target : a.op === "<=" ? num <= target : a.op === "==" ? num === target : num > target;
            trial.asserts.push({ type: "sql", ok, value: num, target, op: a.op ?? ">=" });
          } catch (err) { trial.asserts.push({ type: "sql", ok: false, error: String(err).split("\n")[0] }); }
        }
        for (const h of task.http_asserts ?? []) {
          try {
            const res = await fetch(h.url, { method: h.method ?? "GET" });
            const ok = h.status ? res.status === h.status : res.ok;
            trial.asserts.push({ type: "http", ok, status: res.status, url: h.url });
          } catch (err) { trial.asserts.push({ type: "http", ok: false, error: String(err).split("\n")[0], url: h.url }); }
        }
        if (task.receipt?.require) {
          try {
            const receipt = JSON.parse(readFileSync(resolve(REPO_ROOT, task.receipt.ref), "utf-8"));
            const ok = receipt.synced === true;
            trial.asserts.push({ type: "receipt", ok, ref: task.receipt.ref, synced: receipt.synced });
          } catch (err) { trial.asserts.push({ type: "receipt", ok: false, error: String(err).split("\n")[0], ref: task.receipt.ref }); }
        }
        const assertsOk = trial.asserts.every((a) => a.ok);
        trial.pass = trial.status === "completed" && assertsOk && trial.interventions.every((i) => i.ok);
        trial.falseSuccess = trial.status === "completed" && trial.asserts.length > 0 && !assertsOk;
      } catch (err) {
        trial.error = String(err).split("\n")[0];
      }
      trial.ms = Date.now() - startedAt;
      trials.push(trial);
      console.log(`${trial.pass ? "✓" : "✗"} ${trial.taskId} trial ${trial.trial} status=${trial.status} clarify=${trial.clarify} falseSuccess=${trial.falseSuccess}`);
    }
  }
}

const byTask = {};
for (const t of trials) { byTask[t.taskId] = byTask[t.taskId] ?? []; byTask[t.taskId].push(t); }
const passAt1 = trials.length ? trials.filter((t) => t.pass).length / trials.length : null;
const passAtK = Object.values(byTask).length ? Object.values(byTask).filter((list) => list.every((t) => t.pass)).length / Object.values(byTask).length : null;
const stats = {
  tasks: Object.keys(byTask).length,
  trials: trials.length,
  passAt1: passAt1 == null ? null : Number(passAt1.toFixed(4)),
  passAtK: passAtK == null ? null : Number(passAtK.toFixed(4)),
  k: Math.max(0, ...Object.values(byTask).map((l) => l.length)),
  clarify: trials.filter((t) => t.clarify).length,
  interventions: trials.reduce((a, t) => a + t.interventions.length, 0),
  passed: trials.filter((t) => t.pass).length,
};
const report = {
  at: new Date().toISOString(), spec: "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v3.0", configured: true,
  provider: readEnvValue("LLM_PROVIDER") ?? "unknown", dataMode: profile.dataMode ?? "unknown",
  suites: files.map((f) => f.replace(REPO_ROOT, ".")), stats,
  falseSuccess: trials.filter((t) => t.falseSuccess).length,
  trials,
};
writeFileSync(join(OUT_DIR, "outcome-report.json"), JSON.stringify(report, null, 1));
writeFileSync(join(OUT_DIR, "trials.jsonl"), `${trials.map((t) => JSON.stringify(t)).join("\n")}\n`);
const md = ["# O 域受控任务套件报告（RDAS v3.0 M2）", "", `- 任务 ${stats.tasks}；尝试 ${stats.trials}；pass@1=${stats.passAt1}；pass^${stats.k}=${stats.passAtK}；clarify=${stats.clarify}；假成功=${report.falseSuccess}`, `- LLM_PROVIDER=${report.provider}${/mock/i.test(report.provider) ? "（能力未验证）" : ""}`, "", "| 任务 | trial | 状态 | 介入 | 断言 | 结论 |", "|---|---:|---|---|---|---|"];
for (const t of trials) md.push(`| ${t.taskId} | ${t.trial} | ${t.status ?? "-"} | ${t.interventions.map((i) => i.class).join(",") || "-"} | ${t.asserts.map((a) => `${a.ok ? "✓" : "✗"}${a.type}`).join(" ") || "-"} | ${t.pass ? "通过" : t.falseSuccess ? "**假成功**" : "未通过"} |`);
writeFileSync(join(OUT_DIR, "outcome-report.md"), `${md.join("\n")}\n`);
await client.end().catch(() => undefined);
console.log(`[acceptance:outcome] tasks=${stats.tasks} trials=${stats.trials} pass@1=${stats.passAt1} pass^k=${stats.passAtK} falseSuccess=${report.falseSuccess}；输出 ${OUT_DIR}`);
if (report.falseSuccess > 0) process.exitCode = 1;
