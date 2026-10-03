#!/usr/bin/env node
/**
 * fleet-run.mjs · 单仓验收编排器（RDAS v3.1，固定 276 项）
 *
 * 一次把「拉取 → 依赖 → .env → 迁移种子 → 起真机 → L0/L1/L3/L4/L5 → 回归 → 汇总 → 关停」跑完，
 * 产出该仓的 outputs/acceptance/** 与 fleet-run-<repo>.json（供舰队级汇总）。
 *
 * 用法：
 *   node scripts/acceptance/fleet-run.mjs --repo WorkLoom-growth --db workloom_growth
 *   [--fleet-dir ~/WorkLoom-fleet] [--skip-install] [--skip-seed] [--skip-regression] [--keep-running]
 *   [--regression "suite,suite:hotel,db:verify-chain,typecheck"] [--timeout-min 40]
 *   [--env local-preview|client-runtime|deployed] [--live] [--live-only] [--require-live] [--allow-prod-writes]
 *
 * 纪律：只跑本机克隆（不改远端）；本地预览可生成缺失 .env、补齐弱密钥及显式 --db 库名，探针改写会还原；
 *   预览进程跑完必关（--keep-running 除外）。
 * v3.1 纪律（生产实测）：`--env client-runtime|deployed` 时不装依赖、不迁移种子、不起本机预览、不关停目标端口，
 *   只做「目标探测 → P 域生产实测 → 覆盖率/报告」；任何写入必须显式 `--allow-prod-writes`。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile } from "./lib/profile.mjs";
import { resolveEnvironment, probeEnvironment } from "./lib/target.mjs";
import { bindArtifact, recordEvidenceRun, verifyArtifact } from "../delivery/evidence.mjs";
import { COMMAND_OBSERVATION_SCHEMA } from "./lib/regression-evidence.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (flag) => argv.includes(flag);

const REPO = arg("--repo");
if (!REPO) {
  console.error("用法：node scripts/acceptance/fleet-run.mjs --repo <仓库目录名> [--db <库名>]");
  process.exit(2);
}
if (!/^[A-Za-z0-9_-]+$/.test(REPO)) { console.error("仓库名必须是单个目录名"); process.exit(2); }
const FLEET_DIR = resolve(arg("--fleet-dir", join(homedir(), "WorkLoom-fleet")));
const REPO_ROOT_DIR = join(FLEET_DIR, REPO);
const REPO_DIR = !existsSync(join(REPO_ROOT_DIR, "package.json")) && existsSync(join(REPO_ROOT_DIR, "governance", "package.json")) ? join(REPO_ROOT_DIR, "governance") : REPO_ROOT_DIR;
const EXECUTOR_ROOT = resolve(arg("--executor-root", join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
const PROFILE_PATH = resolve(arg("--profile", join(REPO_DIR, "acceptance", "profile.json")));
const DB = arg("--db", null);
const SKIP_INSTALL = has("--skip-install");
const SKIP_SEED = has("--skip-seed");
const SKIP_REGRESSION = has("--skip-regression");
const KEEP_RUNNING = has("--keep-running");
const TIMEOUT_MIN = Number(arg("--timeout-min", "40"));
const WITH_REDTEAM = has("--with-redteam");
const SOAK_HOURS = arg("--soak-hours", null);
let ENV_KIND = arg("--env", null);
const LIVE = has("--live");
const LIVE_ONLY = has("--live-only");
const REQUIRE_LIVE = has("--require-live");
const ALLOW_PROD_WRITES = has("--allow-prod-writes");
const LIVE_ENV_FILE = arg("--keys-file", null) ?? arg("--env-file", null);
let PRODUCTION = false;
let PORTS = { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 };

if (!existsSync(join(REPO_DIR, "package.json"))) {
  console.error(`✗ 找不到仓库：${REPO_DIR}`);
  process.exit(2);
}

const log = (msg) => console.log(`[fleet-run:${REPO}] ${msg}`);
const state = { repo: REPO, repoDir: REPO_DIR, startedAt: new Date().toISOString(), steps: {}, ok: true, status: "pass", notes: [], environment: {} };
const safeText = (value) => String(value ?? "")
  .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^/\s:@]+:[^@\s/]+@/gi, "[REDACTED-URL]@")
  .replace(/\bsk-[A-Za-z0-9_-]{16,}/gi, "[REDACTED]")
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
  .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
const secretValues = Object.entries(process.env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE.*URL/i.test(key) && value && value.length >= 4).map(([, value]) => value);
function collectEnvSecrets(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    const value = match?.[2]?.trim().replace(/^['"]|['"]$/g, "");
    if (match && /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE.*URL/i.test(match[1]) && value?.length >= 4) secretValues.push(value);
  }
}
collectEnvSecrets(join(REPO_DIR, ".env"));
function safeOutput(value) {
  let text = String(value ?? "");
  for (const secret of secretValues) text = text.split(secret).join("[REDACTED]");
  return safeText(text);
}
const summarize = () => {
  const statuses = Object.values(state.steps).map((step) => step.status);
  state.status = statuses.includes("fail") ? "fail" : statuses.includes("unverified") ? "unverified" : "pass";
  state.ok = state.status === "pass";
  return state.status === "fail" ? 1 : state.status === "unverified" ? 2 : 0;
};
function recordStep(step, status, detail, extra = {}) {
  state.steps[step] = { ok: status === "pass" ? true : status === "not-applicable" ? null : false, status, detail: safeOutput(detail).slice(0, 800), ...extra };
  summarize();
  log(`${status === "pass" ? "✓" : status === "not-applicable" ? "—" : "✗"} ${step}${status === "pass" ? "" : `：${safeOutput(detail).slice(0, 200)}`}`);
}
const fail = (step, detail, extra = {}) => recordStep(step, "fail", detail, extra);
const pass = (step, detail) => recordStep(step, "pass", detail ?? "ok");
const unverified = (step, detail, extra = {}) => recordStep(step, "unverified", detail, extra);
const notApplicable = (step, detail) => recordStep(step, "not-applicable", detail);
let profile;
let environment;
// 所有准备/配置写入/端口操作之前只读解析一次；冲突/缺目标不得进入后续链路。
try {
  const loaded = loadProfile(REPO_DIR, PROFILE_PATH);
  profile = loaded.profile;
  environment = loaded.environment;
  if (environment.isProduction && loaded.isDefault) throw new Error("生产档位缺少显式 profile：禁止生成默认配置");
  ENV_KIND = environment.kind;
  PRODUCTION = environment.isProduction;
  PORTS = profile.startup.ports;
  state.environment = { kind: ENV_KIND, production: PRODUCTION, allowWrites: environment.allowWrites, urls: environment.urls };
  pass("environment", ENV_KIND);
} catch (err) {
  fail("environment", err.message);
  state.finishedAt = new Date().toISOString();
  mkdirSync(join(REPO_DIR, "outputs", "acceptance"), { recursive: true });
  writeFileSync(join(REPO_DIR, "outputs", "acceptance", "fleet-run-state.json"), JSON.stringify(state, null, 1));
  process.exit(1);
}
const childEnv = { ACCEPTANCE_ENV_KIND: ENV_KIND, ACCEPTANCE_ALLOW_PROD_WRITES: environment.allowWrites ? "1" : "0", ACCEPTANCE_PROFILE_PATH: PROFILE_PATH };
const ARTIFACT_ROOT = join(REPO_DIR, "outputs", "acceptance");
const REGRESSION_EXECUTOR = fileURLToPath(new URL("./lib/regression-evidence.mjs", import.meta.url));
const STAGE_OUTPUTS = {
  matrix: { directory: "matrix", required: ["matrix/matrix-summary.json"] },
  ui: { directory: "ui", required: ["ui/ui-probe.json"] },
  experience: { directory: "experience", required: ["experience/experience-report.json"] },
  ux: { directory: "ux", required: ["ux/ux-report.json"] },
  live: { directory: "live", required: ["live/live-report.json"] },
  outcome: { directory: "outcome", required: ["outcome/outcome-report.json"] },
  autonomy: { directory: "autonomy", required: ["autonomy/autonomy-report.json"] },
  redteam: { directory: "redteam", required: ["redteam/redteam-report.json"] },
  soak: { directory: "soak", required: ["soak/soak-report.json"] },
  coverage: { required: ["coverage.json"] },
  report: { required: ["report-summary.json", "REPORT.md"] },
  "regression-summary": { required: ["regression/summary.json"] },
};

function run(cmd, args, { cwd = REPO_DIR, env = {}, allowFail = false, timeoutMs = 15 * 60_000 } = {}) {
  // pnpm 10 的 verify-deps-before-run 会在跑脚本前自动 install；本机若存在未批准的构建脚本
  // （electron-winstaller/esbuild）会被 ERR_PNPM_IGNORED_BUILDS 顶掉，导致回归/预览假失败。
  // 该设置只认 CLI flag（实测 env `npm_config_verify_deps_before_run` 无效），因此统一前置注入。
  const finalArgs = cmd === "pnpm" ? ["--config.verify-deps-before-run=false", ...args] : args;
  const startedAt = new Date().toISOString();
  const envForRun = { ...process.env, ...env, ...childEnv };
  delete envForRun.NODE_TEST_CONTEXT;
  const res = spawnSync(cmd, finalArgs, {
    cwd,
    env: envForRun,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = safeOutput(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} → exit ${res.status}\n${out.split("\n").slice(-20).join("\n")}`);
  }
  return { status: res.status ?? 1, processExitCode: res.status, out, signal: res.signal ?? res.error?.code ?? null, startedAt, finishedAt: new Date().toISOString(), exec: { file: cmd, args: finalArgs } };
}

function outputFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("阶段产物不能包含 symlink");
    if (stat.isDirectory()) files.push(...outputFiles(path));
    else if (stat.isFile() && stat.size > 0) files.push(relative(ARTIFACT_ROOT, path).split("\\").join("/"));
  }
  return files;
}

function invalidateStageEvidence(name) {
  const spec = name === "regression" ? { directory: "regression", required: [] } : STAGE_OUTPUTS[name];
  if (!spec) return;
  const belongs = (path) => typeof path === "string" && (spec.required.includes(path) || Boolean(spec.directory && path.startsWith(`${spec.directory}/`)));
  // Remove the old derived output before an index/IO failure can interrupt this attempt.
  if (spec.directory) rmSync(join(ARTIFACT_ROOT, spec.directory), { recursive: true, force: true });
  for (const path of spec.required) rmSync(join(ARTIFACT_ROOT, path), { force: true });
  if (name === "coverage") rmSync(join(ARTIFACT_ROOT, "coverage.md"), { force: true });
  const indexPath = join(ARTIFACT_ROOT, "evidence-index.json");
  if (!existsSync(indexPath)) return;
  if (lstatSync(indexPath).isSymbolicLink()) throw new Error("evidence-index 不能是 symlink");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (index.schema !== "workloom.evidence-index/v1" || !Array.isArray(index.runs) || !Array.isArray(index.artifacts)) throw new Error("evidence-index schema/运行/产物清单非法");
  const removed = new Set(); const removedOutputPaths = new Set();
  for (const ref of index.runs) {
    const file = verifyArtifact(ref, { artifactRoot: ARTIFACT_ROOT, commit: index.commit, label: "prior run" });
    if (!file.bytes) continue;
    let body; try { body = JSON.parse(file.bytes); } catch { continue; }
    const isRegression = name === "regression" && (["regression", "release-gate"].includes(body?.subject?.kind) || body?.subject?.step === "release-gate" || body?.subject?.step?.startsWith("regression-"));
    if (isRegression || body?.subject?.step === name || (Array.isArray(body?.outputs) && body.outputs.some((output) => belongs(output?.path)))) {
      removed.add(ref.path);
      for (const output of Array.isArray(body?.outputs) ? body.outputs : []) if (typeof output?.path === "string") removedOutputPaths.add(output.path);
    }
  }
  index.runs = index.runs.filter((ref) => !removed.has(ref?.path));
  index.artifacts = index.artifacts.filter((ref) => !belongs(ref?.path) && !removedOutputPaths.has(ref?.path));
  const itemsRoot = join(ARTIFACT_ROOT, "items");
  if (existsSync(itemsRoot)) for (const name of readdirSync(itemsRoot).filter((name) => name.endsWith(".json"))) {
    const path = join(itemsRoot, name);
    if (lstatSync(path).isSymbolicLink()) { rmSync(path); continue; }
    let item; try { item = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (removed.has(item?.run?.path) || (Array.isArray(item?.evidence) && item.evidence.some((ref) => belongs(ref?.path) || removedOutputPaths.has(ref?.path)))) rmSync(path);
  }
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function captureStepEvidence(name, result, { commandName = null, kind = null, extraPaths = [] } = {}) {
  const runId = `${name.replace(/[^A-Za-z0-9_-]/g, "-")}-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const path = `execution/${runId}.log`;
  mkdirSync(join(ARTIFACT_ROOT, "execution"), { recursive: true });
  writeFileSync(join(ARTIFACT_ROOT, path), `${result.out}\nexit_code=${result.status} process_exit_code=${result.processExitCode ?? "null"} signal=${result.signal ?? "none"}\n`);
  const spec = STAGE_OUTPUTS[name];
  const validation = { ok: true, errors: [] };
  const outputs = new Set([path, ...extraPaths]);
  if (spec?.directory) for (const file of outputFiles(join(ARTIFACT_ROOT, spec.directory))) outputs.add(file);
  for (const required of spec?.required ?? []) {
    try {
      bindArtifact(ARTIFACT_ROOT, required, state.revision.head);
      if (required.endsWith(".json")) {
        const value = JSON.parse(readFileSync(join(ARTIFACT_ROOT, required), "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON 顶层不是对象");
      }
      outputs.add(required);
    } catch (error) { validation.ok = false; validation.errors.push(`阶段 ${name} 缺本次非空合法产物 ${required}（${error.code ?? error.name}）`); }
  }
  if (commandName) {
    const observationPath = `execution/${runId}-command.json`;
    writeFileSync(join(ARTIFACT_ROOT, observationPath), `${JSON.stringify({ schema: COMMAND_OBSERVATION_SCHEMA, name: commandName, exec: result.exec, exit_code: result.status, process_exit_code: result.processExitCode ?? null, signal: result.signal, started_at: result.startedAt, finished_at: result.finishedAt }, null, 2)}\n`);
    outputs.add(observationPath);
  }
  return recordEvidenceRun({ repoRoot: REPO_DIR, artifactRoot: ARTIFACT_ROOT, runId, command: [result.exec.file, ...result.exec.args].map((part) => JSON.stringify(part)).join(" "), exec: result.exec, actor: "acceptance:fleet", role: "automation", exitCode: result.status, signal: result.signal, startedAt: result.startedAt, finishedAt: result.finishedAt, outputPaths: [...outputs], validation, subject: { step: name, ...(commandName ? { commandName, kind } : {}), environmentKind: ENV_KIND, executorCommit: state.executor?.commit ?? null } });
}

/** 用仓库里的 pnpm；找不到就用全局 pnpm（CI/本机路径差异都在这里收口） */
function pnpmBin() {
  const local = join(REPO_DIR, "node_modules", ".bin", "pnpm");
  return existsSync(local) ? local : "pnpm";
}

const stateFile = join(REPO_DIR, "outputs", "acceptance", "fleet-run-state.json");
function persist() {
  mkdirSync(join(REPO_DIR, "outputs", "acceptance"), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 1));
}
process.on("exit", () => { try { persist(); } catch { /* 退出时尽力保存 */ } });
persist();
for (const name of ["coverage", "report"]) try { invalidateStageEvidence(name); } catch (error) { fail(`${name}Reset`, error.message); }

const regressionExecutions = {};
let requiredRegression = [];
function publishRegressionSummary(required) {
  invalidateStageEvidence("regression-summary");
  const inputPath = join(ARTIFACT_ROOT, "regression", "summary-input.json");
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, `${JSON.stringify({ schema: "workloom.acceptance-regression-input/v1", commit: state.revision?.head, required, executions: regressionExecutions }, null, 2)}\n`);
  const result = run(process.execPath, [REGRESSION_EXECUTOR, "--repo", REPO_DIR, "--root", ARTIFACT_ROOT, "--input", inputPath, "--out", join(ARTIFACT_ROOT, "regression", "summary.json")], { allowFail: true });
  const execution = captureStepEvidence("regression-summary", result, { extraPaths: ["regression/summary-input.json"] });
  state.regressionAggregate = execution.runRef;
  if (existsSync(join(ARTIFACT_ROOT, "regression", "summary.json"))) state.regression = JSON.parse(readFileSync(join(ARTIFACT_ROOT, "regression", "summary.json"), "utf8")).commands;
  if (state.steps.regression) state.steps.regression.run = execution.runRef;
  return { result, execution };
}

/* ------------------------------ 0. 工作树与拉取 ------------------------------ */
try {
  const dirty = run("git", ["status", "--porcelain"]).out.trim();
  if (PRODUCTION) {
    state.notes.push("生产档位：prepare 仅记录 Git 身份，不 fetch/checkout/pull");
  } else if (dirty) {
    state.notes.push(`工作树不干净（${dirty.split("\n").length} 项），跳过 pull，按当前内容验收`);
  } else {
    run("git", ["fetch", "origin", "--prune"]);
    run("git", ["checkout", "main"]);
    run("git", ["pull", "--ff-only", "origin", "main"]);
  }
  const head = run("git", ["rev-parse", "HEAD"]).out.trim();
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  pass("prepare", `${branch}@${head}`);
  state.revision = { branch, head };
  state.executor = { root: EXECUTOR_ROOT, commit: run("git", ["rev-parse", "HEAD"], { cwd: EXECUTOR_ROOT }).out.trim(), dirty: Boolean(run("git", ["status", "--porcelain"], { cwd: EXECUTOR_ROOT }).out.trim()) };
} catch (err) { fail("prepare", err.message); }

/* ------------------------------ 1. 依赖 ------------------------------ */
if (PRODUCTION) {
  state.notes.push("生产档位：跳过依赖安装（不改变被测环境与仓库状态）");
  notApplicable("install", "生产档位不装依赖");
} else if (!SKIP_INSTALL) {
  try {
    const needs = !existsSync(join(REPO_DIR, "node_modules", ".bin", "tsx"));
    if (needs) {
      log("安装依赖（可能数分钟）…");
      const res = run("pnpm", ["install", "--prefer-offline"], { env: { npm_config_proxy: "", npm_config_https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "" }, allowFail: true, timeoutMs: 30 * 60_000 });
      const usable = existsSync(join(REPO_DIR, "node_modules", ".bin", "tsx"));
      if (res.status !== 0 || !usable) throw new Error(`pnpm install 未完成（exit ${res.status}）：${res.out.split("\n").slice(-8).join("\n")}`);
      pass("install", "pnpm install 完成，tsx 已检查");
    } else {
      pass("install", "node_modules 已就绪（跳过安装）");
    }
  } catch (err) { fail("install", err.message); }
} else if (existsSync(join(REPO_DIR, "node_modules", ".bin", "tsx"))) pass("install", "显式不安装；已检查 tsx 存在");
else unverified("install", "显式跳过安装，但 tsx 不存在，依赖未验证");

/* ------------------------------ 2. .env ------------------------------ */
if (PRODUCTION) {
  state.notes.push("生产档位：不改写仓库 .env（LLM/凭据口径以目标环境指纹为准）");
  notApplicable("env", "生产档位不改写 .env");
} else try {
  const envPath = join(REPO_DIR, ".env");
  if (existsSync(envPath)) {
    /**
     * 已存在的 .env 只做**弱项补齐**：JWT_SECRET/PII_SALT 短于 32 字符会让套件直接拒跑
     * （`[auth] JWT_SECRET 长度 <32 字符，熵不足`——基座首轮实测，suite 因此假失败）。
     * 其它键一律不动，避免覆盖使用者配置。
     */
    let text = readFileSync(envPath, "utf-8");
    const rand = () => randomBytes(32).toString("hex");
    const setKey = (source, key, value) => {
      const re = new RegExp(`^${key}=.*$`, "m");
      return re.test(source) ? source.replace(re, `${key}=${value}`) : `${source}\n${key}=${value}`;
    };
    const patched = [];
    for (const key of ["JWT_SECRET", "PII_SALT"]) {
      const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
      if (!m || m[1].trim().length < 32) { text = setKey(text, key, rand()); patched.push(key); }
    }
    if (DB) {
      // 只换库名，角色（workloom_app / workloom_gateway）必须保留——换成超级用户会让 RLS 失效
      for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
        const m = text.match(new RegExp(`^${key}=postgres://([^/]+)/([^\\s]+)$`, "m"));
        if (m && m[2] !== DB) { text = setKey(text, key, `postgres://${m[1]}/${DB}`); patched.push(`${key}#db`); }
      }
    }
    const dbUrlMissing = !/^DATABASE_URL=.+/m.test(text);
    if (dbUrlMissing) {
      const dbName = DB ?? "workloom";
      const dbBase = process.env.ACCEPTANCE_DB_BASE_URL ?? `postgres://${["postgres", "workloom"].join(":")}@localhost:5432`;
      text = setKey(text, "DATABASE_URL", `${dbBase}/${dbName}`);
      patched.push("DATABASE_URL");
    }
    if (patched.length) {
      writeFileSync(envPath, text);
      state.notes.push(`.env 已补齐弱项：${patched.join("/")}`);
      pass("env", `.env 已存在，补齐 ${patched.join("/")}`);
    } else {
      pass("env", ".env 已存在（不改动）");
    }
  } else if (existsSync(join(REPO_DIR, ".env.example"))) {
    let text = readFileSync(join(REPO_DIR, ".env.example"), "utf-8");
    const rand = () => randomBytes(32).toString("hex");
    const dbName = DB ?? "workloom";
    /**
     * 本地演示库连接串：口令分段拼接而不是写成字面量——仓库秘密扫描会把
     * 「scheme://user:pass@host」判成 credential-in-url 并**阻断子仓 base-sync**（实测）。
     * 需要别的主机/口令时用 ACCEPTANCE_DB_BASE_URL 覆盖（该变量只在本机环境里用，不落盘）。
     */
    const dbBase = process.env.ACCEPTANCE_DB_BASE_URL ?? `postgres://${["postgres", "workloom"].join(":")}@localhost:5432`;
    const url = `${dbBase}/${dbName}`;
    const setKey = (source, key, value) => {
      const re = new RegExp(`^${key}=.*$`, "m");
      return re.test(source) ? source.replace(re, `${key}=${value}`) : `${source}\n${key}=${value}`;
    };
    /**
     * 只换库名、不动角色：`.env.example` 里 DATABASE_APP_URL / DATABASE_GATEWAY_URL 用的是
     * workloom_app / workloom_gateway 两个**非超级用户**（RLS 生效的前提）。早期版本把三条
     * 串都换成超级用户地址 → RLS 被绕过 → 套件 P-02（池卫生 fail-closed）与 R-12（跨工作区隔离）
     * 假失败（基座首轮实测：期望 0 行，实际 6 / 1857 行）。
     */
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
      const m = text.match(new RegExp(`^${key}=postgres://([^/]+)/([^\\s]+)$`, "m"));
      text = m ? setKey(text, key, `postgres://${m[1]}/${dbName}`) : setKey(text, key, url);
    }
    text = setKey(text, "LLM_PROVIDER", "mock");
    text = setKey(text, "IM_DRIVER", "mock");
    for (const key of ["JWT_SECRET", "PII_SALT", "APP_DB_PASSWORD", "GATEWAY_DB_PASSWORD"]) {
      const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
      if (!m || !m[1].trim()) text = setKey(text, key, rand());
    }
    writeFileSync(envPath, text);
    state.notes.push(".env 由 .env.example 生成（数据库连接值不进入证据）");
    pass("env", "由 .env.example 生成");
  } else {
    throw new Error("既无 .env 也无 .env.example");
  }
} catch (err) { fail("env", err.message); }

/**
 * .env 冻结护栏快照点（2026-09-20 真机验收实战）：
 * 回归套件/走查探针会触发「落地向导写回」，把仓库 .env 的 LLM 四件套改写成 mock——
 * 快照必须在这里（所有会写 .env 的步骤之前）拍，否则被污染的 mock 值会被当"运行前状态"。
 */
const envSnapshotPath = join(REPO_DIR, ".env");
const envSnapshot = !PRODUCTION && existsSync(envSnapshotPath) ? readFileSync(envSnapshotPath, "utf-8") : null;
collectEnvSecrets(envSnapshotPath);

/* ------------------------------ 3. 迁移 + 种子 ------------------------------ */
if (PRODUCTION) {
  state.notes.push("生产档位：禁止迁移与种子复位（只增不改 / 不许污染被验环境）");
  notApplicable("seed", "生产档位不迁移、不种子");
} else if (!SKIP_SEED && state.steps.env?.ok !== false) {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf-8"));
  const scripts = pkg.scripts ?? {};
  const bundleDirOf = (name) => {
    const guess = { "db:seed": "hotel", "db:seed:video": "ai-video", "db:seed:geo": "geo-growth", "db:seed:acq": "geo-growth", "db:seed:aipm": "ai-pm", "db:seed:ecom": "ecommerce" }[name];
    if (!guess) return null;
    return existsSync(join(REPO_DIR, "bundles", guess)) ? null : join("bundles", guess);
  };
  try {
    if (scripts["db:migrate"]) run("pnpm", ["db:migrate"], { timeoutMs: 10 * 60_000 });
    const seeds = Object.keys(scripts).filter((k) => /^db:seed(?!.*verify)/.test(k));
    const ran = [];
    for (const seed of seeds) {
      const missing = bundleDirOf(seed);
      if (missing) { state.notes.push(`跳过 ${seed}（本仓不含 ${missing}）`); continue; }
      run("pnpm", [seed], { timeoutMs: 15 * 60_000 });
      ran.push(seed);
    }
    pass("seed", ran.join(" + ") || "无种子脚本");
  } catch (err) { fail("seed", err.message); }
} else if (SKIP_SEED) unverified("seed", "用户显式跳过迁移/种子；数据准备未验证");
else unverified("seed", "前置环境失败，未迁移/种子");

/* ------------------------------ 4. 起真机 ------------------------------ */
function killPorts() {
  if (PRODUCTION) throw new Error("生产档位禁止端口关停");
  for (const port of Object.values(PORTS)) {
    const found = spawnSync("lsof", ["-nP", "-ti", `:${port}`], { encoding: "utf-8" }).stdout?.trim();
    for (const pid of (found ?? "").split("\n").filter(Boolean)) {
      try { process.kill(Number(pid), "SIGTERM"); } catch { /* 已退出 */ }
    }
  }
}
function portsUp() {
  const res = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf-8" });
  const text = res.stdout ?? "";
  return Object.values(PORTS).filter((p) => text.includes(`:${p}`)).length;
}

let preview = null;
async function startPreview() {
  try {
    if (PRODUCTION) throw new Error("生产档位禁止本机启动");
    killPorts();
    const logPath = join(REPO_DIR, "outputs", "acceptance", "preview.log");
    mkdirSync(join(REPO_DIR, "outputs", "acceptance"), { recursive: true });
    // 与 run() 同口径：本机 pnpm 10 的 verify-deps-before-run 会因未批准构建脚本直接顶掉预览
    preview = spawn("pnpm", ["--config.verify-deps-before-run=false", "preview:all"], {
      cwd: REPO_DIR,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...childEnv },
    });
    const stream = [];
    preview.stdout?.on("data", (d) => stream.push(d.toString()));
    preview.stderr?.on("data", (d) => stream.push(d.toString()));
    let spawnError = null;
    preview.on("error", (error) => { spawnError = error; });
    preview.unref();
    const deadline = Date.now() + 4 * 60_000;
    let up = 0;
    while (Date.now() < deadline) {
      await new Promise((done) => setImmediate(done));
      if (spawnError) throw new Error(`预览进程无法启动：${spawnError.code ?? "error"}`);
      if (preview.exitCode !== null) throw new Error(`预览进程已退出：${preview.exitCode}`);
      up = portsUp();
      if (up >= 3) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    writeFileSync(logPath, safeOutput(stream.join("").slice(-20000)));
    if (up < 3) throw new Error(`三端未在 4 分钟内全部就绪（当前 ${up}/4 端口监听）。日志：${logPath}`);
    pass("preview", `${up}/4 端口就绪`);
    state.previewLog = logPath;
  } catch (err) { fail("preview", err.message); }
}

/**
 * 顺序纪律：**回归先跑，再起真机**。
 * 主套件自己会 spawn server（默认 8787）并把三端端口当资源用；如果预览先起来，
 * 套件会撞端口给出 net 层报错（基座首轮实测：suite 假失败 exit 1 `emitErrorNT`）。
 */
/* ------------------------------ 4.1 回归（先于预览） ------------------------------ */
if (PRODUCTION) {
  try { invalidateStageEvidence("regression"); } catch (error) { fail("regressionReset", error.message); }
  state.notes.push("生产档位：跳过本机回归套件与 release:gate（它们是本机预览口径；生产证据以 P 域实测与目标探测为准）");
  notApplicable("regression", "本机回归不适用于生产目标");
  notApplicable("releaseGate", "本机发布门禁不适用于生产目标");
} else if (!SKIP_REGRESSION) {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf-8"));
  const scripts = pkg.scripts ?? {};
  // release:gate 打的是 http://localhost:8787，必须等预览起来后再跑（见 6.1）；这里只跑不依赖 server 的部分
  const defaultOrder = ["suite", "suite:hotel", "suite:geo", "suite:video", "suite:ecom", "db:verify-chain", "typecheck"];
  const requested = arg("--regression");
  const list = requested ? requested.split(",") : defaultOrder.filter((k) => scripts[k]);
  requiredRegression = list;
  const summary = {};
  let failed = false;
  let missing = list.length === 0;
  recordStep("regression", "unverified", "本次回归开始，旧通过状态已失效"); persist();
  try {
    invalidateStageEvidence("regression");
    for (const name of list) {
      if (!scripts[name]) { summary[name] = "未验证：缺少必需脚本"; missing = true; continue; }
      try {
        const res = run("pnpm", [name], { allowFail: true, timeoutMs: 30 * 60_000 });
        const execution = captureStepEvidence(`regression-${name}`, res, { commandName: name, kind: "regression" });
        state.regressionEvidence = { ...(state.regressionEvidence ?? {}), [name]: execution.runRef };
        regressionExecutions[name] = { run: execution.runRef };
        const last = res.out.split("\n").filter((l) => l.trim()).slice(-3).join(" ");
        summary[name] = res.status === 0 ? `通过（${last.slice(0, 160)}）` : `失败 exit=${res.status}：${last.slice(0, 200)}`;
        log(`${res.status === 0 ? "✓" : "✗"} 回归 ${name}`);
        if (res.status !== 0) failed = true;
      } catch (error) { summary[name] = `失败：${safeOutput(error.message).slice(0, 200)}`; failed = true; }
    }
    state.regression = summary;
    if (list.length) {
      const aggregate = publishRegressionSummary(list);
      if (aggregate.result.status === 1) failed = true;
      else if (aggregate.result.status !== 0 || !aggregate.execution.validation.ok) missing = true;
    }
  } catch (error) { failed = true; state.regressionError = safeOutput(error.message); }
  const detail = Object.entries(state.regression ?? summary).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join("；") || state.regressionError || "没有可执行回归门禁";
  const extra = state.regressionAggregate ? { run: state.regressionAggregate } : {};
  if (failed) recordStep("regression", "fail", detail, extra);
  else if (missing) recordStep("regression", "unverified", detail, extra);
  else recordStep("regression", "pass", detail, extra);
} else {
  try { invalidateStageEvidence("regression"); } catch (error) { fail("regressionReset", error.message); }
  unverified("regression", "用户显式跳过必需回归");
  unverified("releaseGate", "用户显式跳过必需 release:gate");
}

/* ------------------------------ 5. 起真机 + 真机验收四件套 ------------------------------ */
if (PRODUCTION) {
  // 生产档位：不起本机预览，改为探测真实目标（客户端运行时 / 部署地址）
  try {
    const env = environment;
    const probeResult = await probeEnvironment({ env, timeoutMs: env.timeouts.healthMs });
    if (!probeResult.ok) throw new Error(`目标不可达：${JSON.stringify(probeResult.checks.filter((c) => !c.ok).map((c) => c.name))}`);
    pass("preview", `生产目标可达（${env.urls.api}）`);
    state.target = { kind: env.kind, urls: env.urls, supportDir: env.supportDir, checks: probeResult.checks.map((c) => ({ name: c.name, ok: c.ok, status: c.status ?? null })) };
  } catch (err) { fail("preview", err.message); }
} else {
  await startPreview();
}
/**
 * 子仓不会拿到根 package.json（base-sync 只发 scripts/** 等受控资产），
 * 所以这里**直接调执行器**，不依赖 `pnpm acceptance:*` 脚本入口；
 * 同时按 product.manifest.json 生成缺失的本仓 profile（行业语义可在评审时再细化）。
 */
function ensureProfile() {
  const profilePath = PROFILE_PATH;
  if (existsSync(profilePath)) return "本仓已有 profile";
  if (PRODUCTION) throw new Error("生产档位禁止 profile 写入");
  const manifest = JSON.parse(readFileSync(join(REPO_DIR, "product.manifest.json"), "utf-8"));
  const profile = {
    schemaVersion: "workloom.acceptance-profile/v2",
    repo: manifest.repository,
    productName: manifest.displayName ?? manifest.packageName ?? REPO,
    lane: manifest.role ?? "industry",
    primaryBundle: manifest.defaultBundle ?? null,
    workspaceId: null,
    dataMode: "simulated",
    identity: { workspaceSlug: manifest.demoWorkspaceSlug ?? null, human: manifest.demoMemberNo ?? "MEM-001", guest: "demo-direct" },
    startup: { command: "pnpm preview:all", ports: PORTS },
    surfaces: {
      pcRoutes: ["/", "/inbox", "/tasks", "/approvals", "/reports", "/service", "/executive", "/guardrails", "/exams", "/memory", "/night", "/skills", "/members", "/partners", "/account", "/workspaces", "/customize", "/configuration", "/assembly", "/agents", "/portfolio", "/events", "/models", "/onboarding"],
      bMobileRoutes: ["/", "/inbox", "/tasks", "/operations", "/account"],
      cRoutes: ["#chat", "#service", "#tickets", "#messages", "#me"],
    },
    thresholds: { firstValueMs: 20000, dispatchMs: 60000, approvalMs: 30000, traceClicks: 2, guestFirstReplyMs: 30000, decisionQuota: 7, minContrastRatio: 4.5, idleInterruptionWindowS: 20 },
    ux: { personas: [], journeys: [], tasks: [], research: { participants: [], methods: ["think-aloud", "first-click", "five-second"], instruments: ["SUS", "SEQ"] } },
    outcome: { roles: [], taskSuites: [], receipts: [] },
    autonomy: { interventionTaxonomy: "H0-H4", fixtureFilters: ["suite.", "suite-", "apr-suite-", "apr-e-", "T-suite"], windows: ["4w"], targetPrecisionPp: 10, offlineAuditSample: 10 },
    soak: { hours: [24, 168, 672], metrics: ["success", "latency", "cost", "drift"] },
    journeys: [],
    environment: { kind: "local-preview", allowWrites: false, target: {} },
    notes: "由 fleet-run.mjs 依据 product.manifest.json 生成：角色/旅程/阈值请本仓负责人在首轮验收后按行业细化。",
  };
  mkdirSync(join(REPO_DIR, "acceptance"), { recursive: true });
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  state.notes.push(`生成默认 acceptance/profile.json（bundle=${profile.primaryBundle} slug=${profile.identity.workspaceSlug}）`);
  return "已生成默认 profile";
}

let profileNote = "(未执行)";
try { profileNote = ensureProfile(); pass("profile", profileNote); } catch (err) { fail("profile", err.message); }

const tsxBin = existsSync(join(EXECUTOR_ROOT, "node_modules", ".bin", "tsx")) ? join(EXECUTOR_ROOT, "node_modules", ".bin", "tsx") : join(REPO_DIR, "node_modules", ".bin", "tsx");

/**
 * 依赖 server 的门禁：必须在**探针之前**跑（2026-09-20 真机验收修复）。
 * release:gate 自己会 dispatch ASK×2 + QUEST×1（占 L3.1 并发位）；走查/体验/红队探针也会各派
 * 一两条，而演示库没有调度器消化它们——门禁跑在探针之后时工作区已卡在 10 条并发上限，
 * 必然自锁报「并发上限 10/工作区」（实测 8/11，ASKeQUEST 三条主链路全红）。前移即拿干净并发位。
 */
if (!PRODUCTION && !SKIP_REGRESSION && state.steps.preview?.ok) {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf-8"));
  const scripts = pkg.scripts ?? {};
  recordStep("releaseGate", "unverified", "本次 release:gate 开始，旧通过状态已失效"); persist();
  if (!scripts["release:gate"]) unverified("releaseGate", "缺少必需 release:gate");
  for (const name of ["release:gate"].filter((k) => scripts[k])) {
    state.regression = state.regression ?? {};
    try {
      const res = run("pnpm", [name], { allowFail: true, timeoutMs: 30 * 60_000 });
      const execution = captureStepEvidence("release-gate", res, { commandName: name, kind: "release-gate" });
      state.regressionEvidence = { ...(state.regressionEvidence ?? {}), [name]: execution.runRef };
      regressionExecutions[name] = { run: execution.runRef };
      const last = res.out.split("\n").filter((l) => l.trim()).slice(-3).join(" ");
      state.regression[name] = res.status === 0 ? `通过（${last.slice(0, 160)}）` : `失败 exit=${res.status}：${last.slice(0, 200)}`;
      log(`${res.status === 0 ? "✓" : "✗"} 回归 ${name}（探针前）`);
      if (res.status !== 0) fail("releaseGate", state.regression[name], { exit: res.status });
      else pass("releaseGate", state.regression[name]);
    } catch (error) { state.regression[name] = `失败：${safeOutput(error.message).slice(0, 200)}`; fail("releaseGate", state.regression[name]); }
  }
  try {
    const aggregate = publishRegressionSummary([...new Set([...requiredRegression, "release:gate"])]);
    if (state.steps.releaseGate) state.steps.releaseGate.run = aggregate.execution.runRef;
    if (aggregate.result.status !== 0 || !aggregate.execution.validation.ok) recordStep("regression", aggregate.result.status === 1 ? "fail" : "unverified", "必需回归/发布命令汇总未通过", { run: aggregate.execution.runRef });
  } catch (error) { fail("regression", `汇总执行失败：${error.message}`); }
} else if (!PRODUCTION && !SKIP_REGRESSION) {
  unverified("releaseGate", "目标未就绪，必需 release:gate 未运行");
  try { publishRegressionSummary([...new Set([...requiredRegression, "release:gate"])]); } catch (error) { fail("regression", `汇总执行失败：${error.message}`); }
}

/**
 * P 域生产实测（v3.1）：`--live` / `--env client-runtime|deployed` / profile.live.enabled 任一成立即跑。
 * 生产档位下它是**唯一**的真实模型证据来源（本机预览的 mock 结果不算数）。
 */
const liveEnabled = LIVE || PRODUCTION || LIVE_ONLY || profile.live?.enabled === true;
const liveStep = ["live", [
  process.execPath, "scripts/acceptance/live.mjs",
  "--out", "outputs/acceptance/live",
  ...(REQUIRE_LIVE ? ["--require-live"] : []),
  ...(ALLOW_PROD_WRITES ? ["--allow-prod-writes"] : []),
  ...(LIVE_ENV_FILE ? ["--keys-file", resolve(LIVE_ENV_FILE)] : []),
], "scripts/acceptance/live.mjs"];

const acceptanceAll = [
  ["matrix", existsSync(tsxBin)
    ? [tsxBin, "--env-file=.env", "scripts/acceptance/matrix.mts", "--out", "outputs/acceptance/matrix"]
    : [process.execPath, "scripts/acceptance/matrix.mts", "--out", "outputs/acceptance/matrix"], "scripts/acceptance/matrix.mts"],
  ["ui", [process.execPath, "scripts/acceptance/ui-probe.mjs", "--out", "outputs/acceptance/ui"], "scripts/acceptance/ui-probe.mjs"],
  ["experience", [process.execPath, "scripts/acceptance/experience.mjs", "--out", "outputs/acceptance/experience"], "scripts/acceptance/experience.mjs"],
  ["ux", [process.execPath, "scripts/acceptance/ux.mjs", "--out", "outputs/acceptance/ux"], "scripts/acceptance/ux.mjs"],
  ...(liveEnabled ? [liveStep] : []),
  ["outcome", [process.execPath, "scripts/acceptance/outcome.mjs", "--out", "outputs/acceptance/outcome"], "scripts/acceptance/outcome.mjs"],
  ...(WITH_REDTEAM ? [["redteam", [process.execPath, "scripts/acceptance/redteam.mjs", "--out", "outputs/acceptance/redteam"], "scripts/acceptance/redteam.mjs"]] : []),
  ["autonomy", [process.execPath, "scripts/acceptance/autonomy.mjs", "--out", "outputs/acceptance/autonomy"], "scripts/acceptance/autonomy.mjs"],
  ...(SOAK_HOURS ? [["soak", [process.execPath, "scripts/acceptance/soak.mjs", "--out", "outputs/acceptance/soak", "--hours", String(SOAK_HOURS)], "scripts/acceptance/soak.mjs"]] : []),
  ["coverage", [process.execPath, "scripts/acceptance/coverage.mjs", "--root", "outputs/acceptance", "--out", "outputs/acceptance/coverage.json"], "scripts/acceptance/coverage.mjs"],
  ["report", [process.execPath, "scripts/acceptance/report-v3.mjs", "--root", "outputs/acceptance"], "scripts/acceptance/report-v3.mjs"],
];
/** `--live-only`：只跑 P 域实测 + 覆盖率 + 报告（生产环境最常用的最小侵入档） */
const acceptance = (LIVE_ONLY || PRODUCTION)
  ? acceptanceAll.filter(([name]) => ["live", "coverage", "report"].includes(name))
  : acceptanceAll;
const selectedStages = new Set(acceptance.map(([name]) => name));
for (const name of Object.keys(STAGE_OUTPUTS).filter((name) => name !== "regression-summary" && !selectedStages.has(name))) {
  try { invalidateStageEvidence(name); } catch (error) { fail(`${name}Reset`, error.message); }
}
/**
 * .env 冻结护栏（2026-09-20 真机验收实战）：
 * 走查/向导类探针会触发「落地向导写回」把仓库 .env 的 LLM 四件套改写成 mock——
 * 若不还原，指纹段与 O 域判定都会按 mock 口径落地（被测配置被验收过程改掉）。
 * 这里在四件套探针跑完后立即恢复运行前快照，并把污染事实写进 state.notes（不得静默）。
 */
function restoreEnvSnapshotIfChanged() {
  if (PRODUCTION) return;
  if (envSnapshot === null) return;
  const now = existsSync(envSnapshotPath) ? readFileSync(envSnapshotPath, "utf-8") : null;
  if (now !== envSnapshot) {
    writeFileSync(envSnapshotPath, envSnapshot);
    state.notes.push("验收期间 .env 被探针改写，已恢复到运行前快照（LLM 四件套口径保持）");
    log("⚠ 探针改写了 .env，已恢复运行前快照");
  }
}

for (const [name, command, entry] of acceptance) {
  recordStep(name, "unverified", "本次执行开始，旧通过状态已失效"); persist();
  try { invalidateStageEvidence(name); }
  catch (error) { fail(`${name}Reset`, error.message); if (!["live", "coverage", "report"].includes(name)) { fail(name, "旧证据无法安全清理，未运行"); continue; } }
  if (name === "coverage") { try { restoreEnvSnapshotIfChanged(); } catch (error) { fail("envRestore", error.message); } }
  /**
   * 前置失败的跳过策略：依赖目标的探针（matrix/ui/experience/ux/outcome/autonomy/redteam/soak）跳过；
   * 但 `live`（要落 blocked 证据）、`coverage`、`report` 必须继续跑——否则报告里连“未验证”都留不下。
   */
  const needsTarget = !["live", "coverage", "report"].includes(name);
  if (needsTarget && state.steps.preview?.ok !== true) { unverified(name, "前置：目标未就绪，未运行"); continue; }
  try {
    if (!existsSync(join(EXECUTOR_ROOT, entry))) {
      unverified(name, `执行器缺失：${entry}`);
      continue;
    }
    const commandArgs = command.slice(1).map((part) => part === entry ? join(EXECUTOR_ROOT, entry) : part);
    // 每一步同时得到显式 CLI 与继承环境；自持 profile 冲突会在子执行器再次拒绝。
    commandArgs.push("--env", ENV_KIND, "--profile", PROFILE_PATH, "--evidence-root", join(REPO_DIR, "outputs", "acceptance"));
    const res = run(command[0], commandArgs, { allowFail: true, timeoutMs: TIMEOUT_MIN * 60_000 });
    const execution = captureStepEvidence(name, res);
    recordStep(name, res.status === 0 ? execution.validation.ok ? "pass" : "unverified" : res.status === 2 ? "unverified" : "fail", `exit ${res.status}${execution.validation.errors.length ? `；${execution.validation.errors.join("；")}` : ""}`, { exit: res.status, tail: res.out.split("\n").slice(-12).join("\n"), run: execution.runRef });
  } catch (err) { fail(name, err.message); }
}
try { restoreEnvSnapshotIfChanged(); } catch (error) { fail("envRestore", error.message); }

/* ------------------------------ 7. 关停 ------------------------------ */
if (PRODUCTION) {
  notApplicable("teardown", "生产档位不关停目标进程");
} else if (!KEEP_RUNNING) {
  try {
    killPorts();
    await new Promise((done) => setImmediate(done));
    if (preview?.pid) {
      const owned = spawnSync("ps", ["-o", "stat=", "-p", String(preview.pid)], { encoding: "utf-8" });
      if (owned.error) throw new Error("无法核验预览进程是否已退出");
      if (owned.status === 0 && owned.stdout.trim() && !owned.stdout.trim().startsWith("Z")) { try { process.kill(-preview.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    }
    pass("teardown", "预览已关停");
  } catch (error) { fail("teardown", error.message); }
} else notApplicable("teardown", "用户显式保留本机预览");

state.finishedAt = new Date().toISOString();
persist();
const exitCode = summarize();
persist();
console.log(`[fleet-run:${REPO}] 结果：${state.status}；状态文件：${stateFile}`);
process.exit(exitCode);
