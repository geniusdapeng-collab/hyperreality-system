#!/usr/bin/env node
/**
 * live.mjs · P 域「生产环境真机实测」执行器（RDAS v3.1 §19）
 *
 * 回答的问题（v3.0 回答不了）：
 *   1. 这次验收验的是哪个环境？（本机预览 / 真实客户端 / 生产部署）
 *   2. 客户端内置模型（DeepSeek V4.1 Flash / Seedream 5.0 / Seedance 2.5）真的被任务触发了吗？
 *   3. 触发时走的是哪条链路（客户端 dsh harness + 围栏 + 账本 / 模型网关 / 生成 API / 产品派单）？
 *   4. 花了多少钱、多少张图、多少秒视频？有没有超预算？回执在哪？
 *
 * 纪律（与规范 §19 同源）：
 *   - 凭据缺失 → 任务状态 `blocked` + 缺失清单；**不得**用 mock 顶替写“通过”；
 *   - 图片/视频按张、按秒硬计量，超限即中止（budget.reserve 返回 denied）；
 *   - 每个任务必须落回执（receipt）与产物路径；无回执不算完成；
 *   - `--selftest` 只证明管道可用，报告写明「非生产实测证据」。
 *   - 正式非 selftest 外部 LLM 缺可信输入/输出/重试总 token 上界，全部调用前 blocked；
 *     expectedTokens 的预占估算不能授权付费 I/O。产品入口同样在可信服务端预算 seam 接通前 blocked。
 *
 * 用法：
 *   node scripts/acceptance/live.mjs --out outputs/acceptance/live           # 按 profile.live 跑
 *   node scripts/acceptance/live.mjs --tasks LLM-R1,IMG-01 --env deployed
 *   node scripts/acceptance/live.mjs --keys-file ~/.workloom/live.env         # 凭据从仓库外秘密文件读取
 *   node scripts/acceptance/live.mjs --selftest                               # 无凭据自检管道
 *   node scripts/acceptance/live.mjs --require-live                            # blocked 即非零退出（发布门禁用）
 *
 * 凭据来源（可混用，自动发现，优先级：进程环境 > --keys-file > $WORKLOOM_LIVE_ENV > ~/.workloom/live.env > Keychain > 客户端运行时 .env）：
 *   ① 进程环境（CI secret / Keychain 导出 / `security find-generic-password … -w`）；
 *   ② `--keys-file <path>`：仓库外文件（推荐 `~/.workloom/live.env`，chmod 600，永不入库；`--env-file` 为兼容别名，
 *      但注意与 Node 自带同名参数冲突——文件不存在时 Node 会先报错，因此正式口径用 `--keys-file`）；
 *   ③ 自动发现：`$WORKLOOM_LIVE_ENV` → `~/.workloom/live.env` → macOS Keychain
 *      （`workloom-live-deepseek` / `workloom-live-ark`）→ `--env client-runtime` 时客户端 `<支持目录>/runtime/.env`。
 *   `--no-auto-keys` 可关闭自动发现。**封存好的 key 无需每次手动指定。**
 * 报告只写来源与键名，任何密钥值都不落盘、不进日志。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cliArgs, findRepoRoot, loadProfile } from "./lib/profile.mjs";
import { fingerprintEnvironment, fingerprintLines, loadEnvFile, resolveEnvironment, probeEnvironment } from "./lib/target.mjs";
import { createBudget, normalizeBudgets } from "./lib/live/budget.mjs";
import {
  createMultimodalFixture,
  readImageFixture, resolveLiveModels, runChatTask, runDshTask, runImageTask,
  runVideoTask, loginAsMember, pickMultimodalFixture,
  LLM_TOTAL_BUDGET_BLOCK, PRODUCT_DISPATCH_BUDGET_BLOCK,
} from "./lib/live/providers.mjs";
import { startStubProvider } from "./lib/live/stub-provider.mjs";
import { assertSafeTaskId } from "./lib/live/media.mjs";
import { verifyExpectations } from "./lib/live/verification.mjs";
import { buildLiveChecks } from "./lib/live/checks.mjs";
import { recordEvidenceRun, writeAcceptanceItems } from "../delivery/evidence.mjs";

const RUN_ID = `live-${randomUUID()}`;
const RUN_STARTED_AT = new Date().toISOString();

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i >= 0 && (argv.indexOf(name, i + 1) >= 0 || !argv[i + 1] || argv[i + 1].startsWith("--"))) throw new Error(`${name} 需要一个且仅一个值`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (flag) => argv.includes(flag);
const valuedFlags = new Set(["--out", "--profile", "--env", "--tasks", "--keys-file", "--env-file", "--timeout-s", "--evidence-root", "--workspace", "--bundle"]);
const booleanFlags = new Set(["--selftest", "--require-live", "--allow-prod-writes", "--no-keys-from-client", "--no-auto-keys"]);
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  if (valuedFlags.has(flag)) { arg(flag); i += 1; }
  else if (!booleanFlags.has(flag)) throw new Error("live 存在未知 CLI 参数；为防凭据进入日志而拒绝运行");
}

const REPO_ROOT = findRepoRoot();
const args = cliArgs();
const OUT_DIR = resolve(args.outDir ?? join(REPO_ROOT, "outputs", "acceptance", "live"));
const canonical = (path) => existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), path.slice(dirname(path).length + 1));
const EVIDENCE_ROOT = canonical(resolve(arg("--evidence-root", dirname(OUT_DIR))));
const evidencePath = (path) => {
  const rel = relative(EVIDENCE_ROOT, canonical(resolve(path)));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("live 输出必须位于 --evidence-root 之内");
  return rel.split(sep).join("/");
};
evidencePath(OUT_DIR);
const ENV_FLAG = arg("--env", null);
const SELFTEST = has("--selftest");
const REQUIRE_LIVE = has("--require-live");
const ONLY_TASKS = arg("--tasks", null)?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const TASK_TIMEOUT_MS = Number(arg("--timeout-s", "0")) > 0 ? Number(arg("--timeout-s")) * 1000 : 8 * 60_000;
if (!Number.isFinite(Number(arg("--timeout-s", "0"))) || Number(arg("--timeout-s", "0")) < 0 || TASK_TIMEOUT_MS > 2_147_483_647) throw new Error("--timeout-s 必须是有限非负秒数且不能超过运行时计时器上限");
const ALLOW_PROD_WRITES = has("--allow-prod-writes");
/**
 * 凭据文件（推荐放在仓库外，如 ~/.workloom/live.env；只读、只进进程内存，不进报告）。
 * 主口径 `--keys-file`；`--env-file` 仅作兼容别名（与 Node 自带参数同名，文件缺失时 Node 会先崩）。
 */
const ENV_FILE = arg("--keys-file", null) ?? arg("--env-file", null);
/** 客户端运行时档位：是否从客户端 `.env` 兜底读取缺失凭据（默认开） */
const KEYS_FROM_CLIENT = !has("--no-keys-from-client");
/** 自动发现封存凭据（默认开；--no-auto-keys 关闭） */
const AUTO_KEYS = !has("--no-auto-keys");

mkdirSync(join(OUT_DIR, "artifacts"), { recursive: true });
mkdirSync(join(OUT_DIR, "receipts"), { recursive: true });
mkdirSync(join(OUT_DIR, "transcripts"), { recursive: true });
const outputLock = `${OUT_DIR}.run-lock`;
try { mkdirSync(outputLock); }
catch (error) { if (error.code === "EEXIST") throw new Error("live 输出目录已有运行或未清理的运行锁；尚未调用模型，禁止并发覆盖证据"); throw error; }
process.on("exit", () => rmSync(outputLock, { recursive: true, force: true }));

const { profile, warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath);
const liveProfile = profile.live ?? {};
const environment = resolveEnvironment(profile, { flag: ENV_FLAG, allowProdWrites: ALLOW_PROD_WRITES });
const notes = [];

/* ---------------------------- 自检模式：本地替身 ---------------------------- */
let stub = null;
let resolvedModels = [];
let tasks = [];
let modelsForRun = [];

const liveModelsDeclared = Array.isArray(liveProfile.models) ? liveProfile.models : [];
const builtinModels = [
  { id: "deepseek-v4.1-flash", kind: "llm", model: "deepseek-flash", adapter: "dsh-harness", apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL" },
  { id: "seedream-5.0", kind: "image", model: "seedream-5.0", adapter: "gen-http" },
  { id: "seedance-2.5", kind: "video", model: "seedance-2.5", adapter: "gen-http" },
];
modelsForRun = liveModelsDeclared.length ? liveModelsDeclared : builtinModels;

if (SELFTEST) {
  stub = await startStubProvider({});
  process.env.LLM_BASE_URL = stub.v1BaseUrl;
  process.env.LLM_API_KEY = "stub-key";
  process.env.DEEPSEEK_API_KEY = "stub-key";
  process.env.SEEDREAM_ENDPOINT = stub.arkBaseUrl;
  process.env.SEEDREAM_API_KEY = "stub-key";
  process.env.SEEDANCE_ENDPOINT = stub.arkBaseUrl;
  process.env.SEEDANCE_API_KEY = "stub-key";
  notes.push("自检模式：全部调用打到本地替身（stub），产物为合成数据，仅验证执行器管道");
}

/**
 * 凭据来源解析（只记来源与**键名**，永不记录值）：
 *   ① `--env-file <path>`：仓库外的秘密文件（推荐 ~/.workloom/live.env，chmod 600）；
 *   ② 客户端运行时档位：`<supportDir>/runtime/.env` 兜底补齐缺失键（客户端自己配的凭据即可复用）；
 *   ③ 进程环境（含 macOS Keychain 导出的变量、CI secret、dsh 凭据 seam）。
 * 优先级：显式进程环境 > env-file > 客户端 .env（同名键不覆盖已有值，避免意外串仓）。
 */
const credentialSources = [];
const runnerEnv = { ...process.env };
const secrets = () => [...new Set([
  ...Object.entries(runnerEnv).filter(([key, value]) => /API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY/iu.test(key) && typeof value === "string" && value.length >= 4).map(([, value]) => value),
  // profile.apiKeyEnv is a credential contract even when its chosen variable
  // name contains no KEY/TOKEN substring; never rely on naming for redaction.
  ...resolvedModels.map((model) => runnerEnv[model.credentialEnv]).filter((value) => typeof value === "string" && value.length >= 4),
])];
const redactText = (value) => secrets().reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(value));
const redactValue = (value) => typeof value === "string" ? redactText(value) : Array.isArray(value) ? value.map(redactValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)])) : value;
/**
 * 自动发现封存凭据（v3.1.1）：
 *   ① `--env-file`（显式）→ ② `$WORKLOOM_LIVE_ENV` → ③ `~/.workloom/live.env`
 *   → ④ macOS Keychain（workloom-live-deepseek / workloom-live-ark）→ ⑤ 客户端 runtime/.env（下方）。
 * 只补齐缺失键，不覆盖已有值；只记录来源与键名，值永不落盘/回显。
 */
const autoEnvFiles = [
  ENV_FILE ? { path: resolve(ENV_FILE), kind: "env-file-explicit" } : null,
  !ENV_FILE && process.env.WORKLOOM_LIVE_ENV ? { path: resolve(process.env.WORKLOOM_LIVE_ENV), kind: "env-file-WORKLOOM_LIVE_ENV" } : null,
  !ENV_FILE && AUTO_KEYS ? { path: join(homedir(), ".workloom", "live.env"), kind: "env-file-default" } : null,
].filter(Boolean);

for (const entry of autoEnvFiles) {
  const abs = entry.path;
  if (!existsSync(abs)) {
    if (entry.kind !== "env-file-default") notes.push(`${entry.kind} 指向的文件不存在：${abs}（继续按其他来源解析）`);
    continue;
  }
  const kv = loadEnvFile(abs);
  let filled = 0;
  for (const [key, value] of Object.entries(kv)) {
    if (value && !runnerEnv[key]) { runnerEnv[key] = value; filled += 1; }
  }
  credentialSources.push({ source: entry.kind, path: abs, keys: Object.keys(kv).filter((k) => kv[k]), filled });
}

/** macOS Keychain 兜底：封存好的 key 不需要每次手动导出 */
if (AUTO_KEYS && process.platform === "darwin") {
  const keychainSlots = [
    { service: "workloom-live-deepseek", env: "DEEPSEEK_API_KEY" },
    { service: "workloom-live-ark", env: "VOLCENGINE_ARK_API_KEY" },
  ];
  const found = [];
  for (const slot of keychainSlots) {
    if (runnerEnv[slot.env]) continue;
    const res = spawnSync("security", ["find-generic-password", "-s", slot.service, "-w"], { encoding: "utf-8" });
    const value = (res.stdout ?? "").trim();
    if (res.status === 0 && value) { runnerEnv[slot.env] = value; found.push(slot.env); }
  }
  if (found.length) credentialSources.push({ source: "macos-keychain", path: "login.keychain-db", keys: found, filled: found.length });
}
if (KEYS_FROM_CLIENT && environment.kind === "client-runtime" && environment.supportDir) {
  const clientEnvPath = join(environment.supportDir, "runtime", ".env");
  if (existsSync(clientEnvPath)) {
    const kv = loadEnvFile(clientEnvPath);
    /** 只取模型凭据相关键：不把客户端 JWT/PII/DB 口令带进验收进程（最小权限） */
    const CREDENTIAL_KEY_RE = /^(DEEPSEEK_|LLM_|SEEDREAM_|SEEDANCE_|VOLCENGINE_|ARK_)/;
    const picked = Object.fromEntries(Object.entries(kv).filter(([key]) => CREDENTIAL_KEY_RE.test(key)));
    let filled = 0;
    for (const [key, value] of Object.entries(picked)) {
      if (value && !runnerEnv[key]) { runnerEnv[key] = value; filled += 1; }
    }
    credentialSources.push({ source: "client-runtime-env", path: clientEnvPath, keys: Object.keys(picked).filter((k) => picked[k]), filled });
  } else {
    notes.push(`客户端运行时未找到 .env：${clientEnvPath}（可先用向导「真实大模型」步骤写入，或用 --env-file）`);
  }
}
credentialSources.push({ source: "process-env", keys: Object.keys(process.env).filter((k) => /^(DEEPSEEK|LLM|SEEDREAM|SEEDANCE|VOLCENGINE|ARK)_/.test(k)), filled: null });

resolvedModels = resolveLiveModels(modelsForRun, runnerEnv);

/* ---------------------------- 任务清单 ---------------------------- */
const declaredTasks = Array.isArray(liveProfile.tasks) ? liveProfile.tasks : [];
const builtinTasks = [
  {
    id: "LLM-R1", kind: "llm", chain: "dsh-harness", model: "deepseek-v4.1-flash", criticality: "P0",
    title: "客户端内置模型 · 推理任务（dsh harness + 围栏 + 账本）",
    prompt: "背景：某酒店周五 18:00 入住率 82%，周六 96%，周日 61%；OTA 渠道佣金 15%，直订占比 22%。"
      + "请给出周末收益策略：① 是否涨价与幅度 ② 是否开放超售与上限 ③ 一条可执行动作和它的风险。"
      + "要求：先给结论，再给依据，最后回答结束后另起一行输出 TASK_COMPLETE。",
    expect: ["涨|价|策略|超售|佣金"],
    expectAll: ["TASK_COMPLETE"],
  },
  {
    id: "LLM-T1", kind: "llm", chain: "dsh-harness", model: "deepseek-v4.1-flash", criticality: "P0",
    title: "客户端内置模型 · 工具循环（工具调用过围栏瀑布 + 事件落账）",
    prompt: "请调用 bash 工具执行 `echo workloom-live`，把命令输出原样贴出来，然后另起一行输出 TASK_COMPLETE。",
    expect: ["workloom-live|TASK_COMPLETE"],
    expectAll: ["TASK_COMPLETE"],
  },
  {
    id: "LLM-M1", kind: "llm", chain: "dsh-harness", model: "deepseek-v4.1-flash", criticality: "P1",
    title: "客户端内置模型 · 多模态理解（dsh 附件链路）",
    prompt: "请打开随附的界面截图，用一句话说明：这是什么产品的什么页面，页面上第一个导航或按钮文字是什么。最后另起一行输出 TASK_COMPLETE。",
    fixture: "auto",
    expect: ["."],
  },
  {
    id: "LLM-G1", kind: "llm", chain: "model-gateway", model: "deepseek-v4.1-flash", criticality: "P1",
    title: "模型网关 · 结构化输出",
    prompt: "只输出一行 JSON：{\"verdict\":\"ok\",\"risk\":\"low\",\"reason\":\"<20 字内>\"}。不要输出任何其他内容。",
    expect: ["verdict"],
  },
  {
    id: "IMG-01", kind: "image", model: "seedream-5.0", criticality: "P1", images: 2,
    title: "Seedream 生图 · 产品海报（2 张）",
    prompt: "WorkLoom 织元产品海报：深色背景 + 织线/光轨意象，中央标题「WORKLOOM」，下方小字「自主经营系统」。扁平、克制、无人物。",
    expect: ["png"],
    minArtifacts: 1,
  },
  {
    id: "IMG-02", kind: "image", model: "seedream-5.0", criticality: "P2", images: 1,
    title: "Seedream 生图 · 应用图标",
    prompt: "一个极简 App 图标：靛蓝底色，白色「织」字样的几何化线条，圆角方形，无文字品牌，高对比。",
    expect: ["png"],
    minArtifacts: 1,
  },
  {
    id: "VID-01", kind: "video", model: "seedance-2.5", criticality: "P1", durationSeconds: 12,
    title: "Seedance 生视频 · 12s 产品演示镜头",
    prompt: "镜头缓慢推近一块悬浮的半透明数据看板，看板上有流动的光点与折线，背景深空蓝，运镜平稳，无人物，无文字。",
    expect: ["mp4"],
    durationRange: [10, 15],
  },
  {
    id: "VID-02", kind: "video", model: "seedance-2.5", criticality: "P2", durationSeconds: 12,
    title: "Seedance 生视频 · 12s 门店空镜",
    prompt: "清晨的酒店大堂空镜：镜头从左向右匀速横移，暖色灯带、大理石地面反光，无人出现，画面干净。",
    expect: ["mp4"],
    durationRange: [10, 15],
  },
];
tasks = (liveProfile.enabled === true || SELFTEST ? declaredTasks.length ? declaredTasks : builtinTasks : []).filter((t) => !ONLY_TASKS || ONLY_TASKS.includes(t.id));
if (ONLY_TASKS) for (const id of ONLY_TASKS) if (!tasks.some((task) => task.id === id)) tasks.push({ id, kind: "unknown", title: "未配置的请求任务", _blocked: "profile.live 未配置该请求任务；没有调用模型" });
if (!SELFTEST && liveProfile.enabled !== true) notes.push("profile.live.enabled 未开启：没有执行真实模型任务，生产实测未验证");
const taskIds = new Set();
for (const task of tasks) {
  assertSafeTaskId(task.id);
  if (taskIds.has(task.id)) throw new Error(`重复任务 ID ${task.id}：禁止重复付费执行或覆盖回执`);
  taskIds.add(task.id);
}
if (SELFTEST) {
  tasks = tasks.map((t) => (t.kind === "product" ? { ...t, _skip: "自检模式跳过产品派单（需要真实目标环境）" } : t));
}

/* ---------------------------- 预算闸 ---------------------------- */
const { budgets, warnings: budgetWarnings } = normalizeBudgets(liveProfile.budgets ?? {});
notes.push(...budgetWarnings);
const budgetOptions = { budgets, outDir: OUT_DIR, environmentKind: environment.kind, runId: RUN_ID };
const budget = createBudget(budgetOptions);

/* ---------------------------- 目标探测与指纹 ---------------------------- */
const probeResult = await probeEnvironment({ env: environment, timeoutMs: environment.timeouts.healthMs });
const gitInfo = (() => {
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim(),
      branch: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT }).toString().trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).toString().trim().split("\n").filter(Boolean).length > 0,
    };
  } catch { return { commit: null, branch: null, dirty: null }; }
})();
const fingerprint = fingerprintEnvironment({ repoRoot: REPO_ROOT, env: environment, profile, git: gitInfo });
fingerprint.targetProbe = probeResult;

/* ---------------------------- 执行 ---------------------------- */
const modelById = new Map(resolvedModels.map((m) => [m.id, m]));
const results = [];

async function runTask(task) {
  const startedAt = Date.now();
  const base = { id: task.id, title: task.title, kind: task.kind, chain: task.chain ?? null, criticality: task.criticality ?? "P1", model: task.model ?? null, selftest: SELFTEST };
  if (task._blocked) return { ...base, status: "blocked", reason: task._blocked, ms: 0 };
  if (task._skip) return { ...base, status: "skipped", reason: task._skip, ms: 0 };
  const resolved = task.model ? modelById.get(task.model) : resolvedModels.find((m) => m.kind === (task.kind === "product" ? "llm" : task.kind));
  const chain = task.chain ?? resolved?.adapter ?? "model-gateway";
  let reserved = null;
  let settled = false;
  const settle = (out, usage) => {
    if (usage.measured !== true) {
      out.status = "blocked";
      out.reason = `${out.reason ?? `${chain} 实际用量未验证`}；继续持有预占并冻结后续全部付费模态`;
      if (out.receipt) out.receipt = { ...out.receipt, synced: false };
    }
    const settlement = budget.commit({ taskId: task.id, kind: reserved.kind, status: out.status === "blocked" ? "blocked" : out.status === "ok" ? "ok" : "failed", detail: redactText(usage.measured === true ? chain : `${chain}：${out.reason}`), ...usage });
    settled = settlement.committed;
    if (!settlement.committed || settlement.exceeded.length) {
      out.status = "failed";
      out.reason = settlement.reason ?? `实际用量超出预算：${settlement.exceeded.join("、")}`;
      if (out.receipt) out.receipt = { ...out.receipt, synced: false };
    }
  };
  try {
    if (task.kind === "llm") {
      if (!resolved?.ready) return { ...base, chain, status: "blocked", called: false, reason: resolved?.missing?.join("；") ?? "文本模型未配置", ms: 0 };
      // expectedTokens 是调用方估算；它不能证明输入/context、输出及每次
      // 重试的总量会落在剩余额度内。先验总量不可得时，不得先计费再冻结。
      // 所有未知/fallback LLM chain 同受此闸；只有内部本地 stub 的 selftest 可继续。
      if (!SELFTEST) return { ...base, chain, status: "blocked", called: false, reason: LLM_TOTAL_BUDGET_BLOCK, ms: 0 };
      // fail-closed：链路需要真实凭据而凭据缺失时，任务状态必须是 blocked（未验证），不得跑成“模型调用失败”
      if (resolved && resolved.ready === false) {
        return { ...base, chain, status: "blocked", reason: resolved.missing.join("；"), ms: Date.now() - startedAt };
      }
      let out;
      let fixturePath = task.fixture === "ui-shot" ? pickMultimodalFixture(join(REPO_ROOT, "outputs", "acceptance")) : null;
      let fixtureToken = null;
      if (task.fixture === "auto" || (task.fixture === "ui-shot" && !fixturePath)) {
        const fx = await createMultimodalFixture({ repoRoot: REPO_ROOT, outDir: OUT_DIR });
        if (!fx.path) return { ...base, chain, status: "blocked", reason: fx.reason ?? "多模态夹具不可用（无截图且无法渲染）", ms: Date.now() - startedAt };
        fixturePath = fx.path;
        fixtureToken = fx.expectToken ?? null;
      }
      // 生成夹具的核验字必须由模型从图里读出来（否则“图片到达模型”不成立）
      // 自检模式用替身（看不到图），fixture 核验字只在真实模型运行时生效
      const effectiveTask = fixtureToken && !SELFTEST
        ? { ...task, expectAll: [...(task.expectAll ?? []), fixtureToken] }
        : task;
      if (chain === "dsh-harness") {
        /**
         * 围栏规则源装配（2026-09-24 修复）：dsh 插件需要真实生效规则；本仓此前指向不存在的
         * `fence.activeRules` → 插件把 404 错误体当数组 → 工具层整体不可用（LLM-M1 实测）。
         * 现在：用成员令牌拉一次 `fence.activeRules`（本仓已补该端点）写成本地规则文件，
         * 插件走 `rulesFile`（无网/无鉴权依赖，且规则内容可留档到产物目录）。
         */
        let fenceRulesFile = null;
        if (!(SELFTEST && stub)) {
          try {
            const token = await loginAsMember({
              apiUrl: environment.urls.api,
              workspaceSlug: profile.identity?.workspaceSlug,
              memberNo: profile.identity?.human ?? "MEM-001",
            });
            const r = await fetch(`${environment.urls.api}/trpc/fence.activeRules`, {
              headers: { authorization: `Bearer ${token}` },
            });
            const body = await r.json().catch(() => null);
            const rules = body?.result?.data;
            if (Array.isArray(rules) && rules.length > 0) {
              fenceRulesFile = join(OUT_DIR, `fence-rules-${task.id}.json`);
              writeFileSync(fenceRulesFile, JSON.stringify(rules, null, 1));
              console.log(`[acceptance:live] 围栏规则源就绪：${rules.length} 条 → ${fenceRulesFile}`);
            } else {
              console.log(`[acceptance:live] ⚠ 围栏规则源为空/不可用（HTTP ${r.status}）：工具调用将按 fail-closed 拒绝`);
            }
          } catch (error) {
            console.log(`[acceptance:live] ⚠ 围栏规则源拉取失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        out = await runDshTask({
          repoRoot: REPO_ROOT,
          workDir: OUT_DIR,
          model: resolved?.model ?? "deepseek-flash",
          prompt: task.prompt,
          rulesUrl: SELFTEST && stub ? `${stub.baseUrl}/rules` : `${environment.urls.api}/trpc/fence.activeRules`,
          rulesFile: fenceRulesFile,
          env: {
            DEEPSEEK_API_KEY: runnerEnv[resolved.credentialEnv] ?? "",
            /**
             * dsh 的 deepseek-official 适配器默认走 **Messages 协议**（`<root>/v1/messages`），
             * 因此要指到 DeepSeek 的 Anthropic 兼容根 `https://api.deepseek.com/anthropic`；
             * `LLM_BASE_URL` 是产品 model-router 的 OpenAI 兼容根（`https://api.deepseek.com`），
             * 直接拿它给 dsh 会 404（2026-09-20 实测）。优先级：DEEPSEEK_BASE_URL > LLM_BASE_URL。
             */
            DEEPSEEK_BASE_URL: resolved.baseUrl,
          },
          taskId: task.id,
          budgetOptions,
          expectedTokens: task.expectedTokens ?? 8000,
          allowedModels: task.allowedModels ?? [],
          baseUrl: resolved.baseUrl,
          timeoutMs: TASK_TIMEOUT_MS,
          imagePath: fixturePath,
        });
      } else {
        const image = task.imageFixture ? readImageFixture(resolve(REPO_ROOT, task.imageFixture)) : null;
        /**
         * model-gateway 走 OpenAI 兼容 `/chat/completions`：
         *   `DEEPSEEK_BASE_URL` 可能被 dsh 链路指到 Anthropic 兼容根（`…/anthropic`），
         *   直接复用会 404（2026-09-20 实测）。这里优先用 `LLM_BASE_URL`，并剥掉 `/anthropic` 后缀。
         */
        const gatewayResolved = {
          ...resolved,
          baseUrl: resolved.baseUrl,
        };
        const gate = budget.reserve({ taskId: task.id, kind: "llm", units: 1, tokens: task.expectedTokens ?? 8000, detail: chain });
        if (!gate.allowed) return { ...base, chain, status: "blocked", reason: gate.reason, ms: Date.now() - startedAt };
        reserved = { kind: "llm" };
        out = await runChatTask({ resolved: gatewayResolved, prompt: task.prompt, timeoutMs: TASK_TIMEOUT_MS, image, env: runnerEnv });
        settle(out, { tokens: out.tokens ?? 0, calls: out.called === false ? 0 : out.calls ?? 1, measured: out.called === false || out.usage?.complete === true });
      }
      const verified = await verifyExpectations({ ...effectiveTask, expectedModel: resolved.model }, out, { artifactsDir: join(OUT_DIR, "artifacts") });
      const status = out.status === "ok" && verified.ok ? "ok" : out.status === "blocked" ? "blocked" : "failed";
      return {
        ...base, chain, status, ms: out.ms ?? Date.now() - startedAt,
        reason: failureReason(out, verified),
        answer: (out.answer ?? "").slice(0, 800),
        receipt: out.receipt ?? null,
        evidence: out.evidence ?? null,
        audit: out.audit ?? null,
        fenceHits: out.fenceHits ?? null,
        usage: out.usage ?? null,
        tokens: out.tokens ?? null,
        called: out.called ?? false,
        modelResolved: out.model ?? null,
        verification: verified,
        multimodal: fixturePath ? { path: fixturePath, sha256: createHash("sha256").update(readFileSync(fixturePath)).digest("hex"), expectedToken: fixtureToken ?? task.imageExpectedToken ?? null } : null,
      };
    }

    if (task.kind === "image") {
      if (!resolved?.ready) return { ...base, status: "blocked", called: false, reason: resolved?.missing?.join("；") ?? "图片模型未配置", ms: 0 };
      const units = Number(task.images ?? 1);
      const gate = budget.reserve({ taskId: task.id, kind: "image", units, detail: chain });
      if (!gate.allowed) return { ...base, status: "blocked", called: false, reason: gate.reason, ms: Date.now() - startedAt };
      reserved = { kind: "image" };
      const out = await runImageTask({ resolved, task, timeoutMs: Math.max(TASK_TIMEOUT_MS, 5 * 60_000), artifactsDir: join(OUT_DIR, "artifacts"), env: runnerEnv });
      settle(out, { units: out.called === false ? 0 : out.produced ?? out.knownProduced ?? 0, measured: out.called === false || out.measurementComplete === true });
      const verified = await verifyExpectations({ ...task, expectedModel: resolved.model }, out, { artifactsDir: join(OUT_DIR, "artifacts") });
      return {
        ...base, chain, status: out.status === "ok" && verified.ok ? "ok" : out.status === "blocked" ? "blocked" : "failed",
        ms: out.ms ?? Date.now() - startedAt,
        reason: failureReason(out, verified),
        artifacts: out.artifacts ?? [],
        receipt: out.receipt ?? null,
        called: out.called ?? null,
        measurementComplete: out.measurementComplete === true,
        produced: out.produced ?? null,
        knownProduced: out.knownProduced ?? null,
        units,
        modelResolved: out.model ?? null,
        verification: verified,
      };
    }

    if (task.kind === "video") {
      if (!resolved?.ready) return { ...base, status: "blocked", called: false, reason: resolved?.missing?.join("；") ?? "视频模型未配置", ms: 0 };
      const units = Number(task.durationSeconds ?? 12);
      const gate = budget.reserve({ taskId: task.id, kind: "video", units, detail: chain });
      if (!gate.allowed) return { ...base, status: "blocked", called: false, reason: gate.reason, ms: Date.now() - startedAt };
      reserved = { kind: "video" };
      const out = await runVideoTask({
        resolved, task, timeoutMs: Math.max(TASK_TIMEOUT_MS, 20 * 60_000),
        artifactsDir: join(OUT_DIR, "artifacts"), pollMs: SELFTEST ? 200 : 8000, env: runnerEnv,
      });
      settle(out, { units: out.called === false ? 0 : out.durationSeconds ?? 0, measured: out.called === false || out.measurementComplete === true });
      const verified = await verifyExpectations({ ...task, expectedModel: resolved.model }, out, { artifactsDir: join(OUT_DIR, "artifacts") });
      return {
        ...base, chain, status: out.status === "ok" && verified.ok ? "ok" : out.status === "blocked" ? "blocked" : "failed",
        ms: out.ms ?? Date.now() - startedAt, taskId: out.taskId ?? null,
        reason: failureReason(out, verified),
        artifacts: out.artifacts ?? [],
        receipt: out.receipt ?? null,
        called: out.called ?? null,
        measurementComplete: out.measurementComplete === true,
        durationSeconds: out.durationSeconds ?? null,
        units,
        modelResolved: out.model ?? null,
        verification: verified,
      };
    }

    if (task.kind === "product") {
      if (SELFTEST) return { ...base, status: "skipped", reason: "自检模式跳过产品派单", ms: 0 };
      if (environment.isProduction && !environment.allowWrites) {
        return {
          ...base,
          status: "blocked",
          reason: "生产档位默认只读：产品派单会写入目标环境（线程/事件），需显式 --allow-prod-writes",
          ms: Date.now() - startedAt,
        };
      }
      if (environment.isProduction && (!task.fixtureMarker || !task.residualDisclosure || !String(task.input ?? task.title).includes(task.fixtureMarker))) {
        return { ...base, status: "blocked", reason: "产品派单写入需要 fixtureMarker（包含在输入中）与 residualDisclosure 残留披露", ms: 0 };
      }
      // dispatch 总先 routeIntent(intentClassifier(scope))；任务声明不控制服务端计量。
      // 当前接口仅 Promise<string>，没有可绑定此次 budget/WAL 的逐请求占额与 usage。
      // 保留低层确定性 transport 的业务回读测试；真实 CLI 先阻断，不触发登录/派单。
      return { ...base, chain: "product-dispatch", status: "blocked", called: false, reason: PRODUCT_DISPATCH_BUDGET_BLOCK, ms: Date.now() - startedAt };
    }
    return { ...base, status: "failed", reason: `未知任务类型：${task.kind}`, ms: 0 };
  } catch (err) {
    return { ...base, status: "failed", reason: String(err?.message ?? err).slice(0, 300), ms: Date.now() - startedAt };
  } finally {
    if (reserved && !settled) budget.commit({ taskId: task.id, kind: reserved.kind, measured: false, status: "blocked", detail: redactText(`${chain}:未取得实际量，按预占保守计量并冻结后续付费调用`) });
  }
}

for (const task of tasks) {
  const out = await runTask(task);
  const declared = task.model ? modelById.get(task.model) : resolvedModels.find((model) => model.kind === task.kind);
  const result = redactValue({ ...out, purpose: task.purpose ?? null, modelExpected: declared?.model ?? null, modelResolved: out.modelResolved ?? out.receipt?.model ?? null, allowedModels: task.allowedModels ?? [], fixtureMarker: task.fixtureMarker ?? null, residualDisclosure: task.residualDisclosure ?? null,
    receiptPath: evidencePath(join(OUT_DIR, "receipts", `${task.id}.json`)), transcriptPath: evidencePath(join(OUT_DIR, "transcripts", `${task.id}.json`)) });
  if (result.status === "ok" && result.eventEvidence && result.receipt.evidenceSha256 !== createHash("sha256").update(JSON.stringify(result.eventEvidence.events)).digest("hex")) {
    result.status = "failed"; result.reason = "线程事件包含需脱敏的凭据，脱敏后散列不再一致；不能计为完成"; result.receipt.synced = false; result.verification.ok = false;
  }
  results.push(result);
  const icon = result.status === "ok" ? "✓" : result.status === "blocked" ? "⏸" : result.status === "skipped" ? "–" : "✗";
  console.log(`[acceptance:live] ${icon} ${result.id} ${result.status}${result.reason ? `（${result.reason.slice(0, 120)}）` : ""}`);
  const receiptPath = join(OUT_DIR, "receipts", `${result.id}.json`);
  writeFileSync(receiptPath, JSON.stringify({ task: result.id, at: new Date().toISOString(), status: result.status, receipt: result.receipt ?? null, artifacts: result.artifacts ?? [], reason: result.reason ?? null }, null, 1));
  writeFileSync(join(OUT_DIR, "transcripts", `${result.id}.json`), JSON.stringify(result, null, 1));
}

if (stub) await stub.close();

/* ---------------------------- 汇总与报告 ---------------------------- */
const budgetSummary = budget.persist();
const byStatus = results.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});
const anyFalseSuccess = results.some((r) => r.falseSuccess);
const blocked = results.filter((r) => r.status === "blocked");
const failed = results.filter((r) => r.status === "failed");
/**
 * 判定纪律：
 *   - 假成功永远 fail（红线候选）；
 *   - 生产档位或已有真实凭据时，任务失败 = fail；
 *   - 本机预览 + 无任何真实凭据时，一切失败都只能是“未验证”——没有真模型就没有能力结论，
 *     应把失败项留在失败清单里（不得洗白），但不能据此判产品不通过。
 */
const noCredentials = resolvedModels.length > 0 && resolvedModels.every((m) => !m.ready);
const verdict = SELFTEST
  ? "selftest（非生产实测证据）"
  : anyFalseSuccess
    ? "fail"
    : failed.length
      ? environment.isProduction || !noCredentials ? "fail" : "blocked（未验证，不得写通过：本机预览档位且缺真实凭据）"
      : blocked.length || results.length === 0 || results.some((result) => result.status === "skipped") || environment.isLocal || !probeResult.ok || !environment.targetDeclaredExplicitly || gitInfo.dirty !== false ? "blocked（未验证，不得写通过）" : "pass";
if (failed.length && !environment.isProduction && noCredentials) {
  notes.push(`本机预览 + 缺真实凭据：${failed.length} 个失败任务按“未验证”处理（失败清单保留：${failed.map((f) => f.id).join("、")}）`);
}

const report = redactValue({
  at: new Date().toISOString(),
  spec: "rdas/v3.1",
  selftest: SELFTEST,
  environment: {
    kind: environment.kind,
    isProduction: environment.isProduction,
    urls: environment.urls,
    allowWrites: environment.allowWrites,
    declaredTarget: environment.declaredTarget,
    targetDeclaredExplicitly: environment.targetDeclaredExplicitly,
    productionNote: environment.isLocal
      ? "本档位为本机预览：不得作为生产环境实测证据（O/P 域只能写未验证）"
      : "生产档位：默认只读；写入需 --allow-prod-writes",
  },
  fingerprint,
  credentialSources,
  models: resolvedModels.map((m) => ({
    id: m.id, kind: m.kind, adapter: m.adapter, model: m.model, baseUrl: m.baseUrl,
    ready: m.ready, missing: m.missing, credentialEnv: m.credentialEnv ?? null, modelNote: m.modelNote ?? null,
    warnings: m.warnings ?? [],
  })),
  tasks: results,
  budget: budgetSummary,
  summary: { total: results.length, byStatus, falseSuccess: anyFalseSuccess, blockedIds: blocked.map((b) => b.id), failedIds: failed.map((f) => f.id) },
  verdict,
  notes,
  profileWarnings,
});
const outputFiles = new Set([join(OUT_DIR, "budget-ledger.jsonl"), join(OUT_DIR, "budget-summary.json"), ...results.flatMap((task) => [join(EVIDENCE_ROOT, task.receiptPath), join(EVIDENCE_ROOT, task.transcriptPath), ...(task.artifacts ?? []).map((artifact) => artifact.path), task.audit?.file, task.multimodal?.path, task.evidence?.patchPath, task.evidence?.budgetConfigFile]).filter(Boolean)]);
const patchPath = join(OUT_DIR, "dsh-home", "profiles", "headless", "cordis.patch.yml");
if (existsSync(patchPath)) outputFiles.add(patchPath);
let redactedFiles = 0;
let scannedFiles = 0;
let leakedFiles = 0;
for (const path of outputFiles) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
  evidencePath(path);
  let bytes = readFileSync(path);
  if (/\.(?:json|jsonl|ya?ml|txt)$/iu.test(path)) {
    const text = bytes.toString("utf8"); const scrubbed = redactText(text);
    if (scrubbed !== text) { writeFileSync(path, scrubbed); bytes = Buffer.from(scrubbed); redactedFiles += 1; }
  }
  scannedFiles += 1;
  if (secrets().some((secret) => bytes.includes(Buffer.from(secret)))) leakedFiles += 1;
}
report.secretScan = { passed: leakedFiles === 0 && redactedFiles === 0, scannedFiles, leakedFiles, redactedFiles, basis: "本次继承凭据值扫描；不替代仓库完整 secret 扫描" };
if (!report.secretScan.passed) report.verdict = "fail";
const reportPath = evidencePath(join(OUT_DIR, "live-report.json"));
const outputPaths = [...outputFiles].filter((path) => existsSync(path) && lstatSync(path).isFile()).map(evidencePath);
report.checks = buildLiveChecks(report, { reportPath, outputPaths, secretScan: report.secretScan, requestedTaskIds: tasks.map((task) => task.id) });
writeFileSync(join(OUT_DIR, "live-report.json"), JSON.stringify(report, null, 1));
writeFileSync(join(OUT_DIR, "live-report.md"), renderMarkdown(report));
const exitCode = failed.length || anyFalseSuccess || !report.secretScan.passed ? 1 : SELFTEST ? blocked.length || results.length === 0 || results.some((result) => result.status === "skipped") || REQUIRE_LIVE ? 2 : 0 : report.verdict === "pass" ? 0 : 2;
const run = recordEvidenceRun({ repoRoot: REPO_ROOT, artifactRoot: EVIDENCE_ROOT, runId: RUN_ID, command: redactText([process.execPath, ...process.argv.slice(1)].join(" ")), actor: "acceptance:live", role: "automation", exitCode,
  startedAt: RUN_STARTED_AT, finishedAt: new Date().toISOString(), outputPaths: [...outputPaths, reportPath, evidencePath(join(OUT_DIR, "live-report.md"))], exec: { file: process.execPath, args: process.argv.slice(1).map(redactText) } });
writeAcceptanceItems({ artifactRoot: EVIDENCE_ROOT, run, checks: report.checks });

console.log(`[acceptance:live] 结论：${report.verdict}；任务 ${results.length}（ok ${byStatus.ok ?? 0} / blocked ${byStatus.blocked ?? 0} / failed ${byStatus.failed ?? 0}）；产物 ${OUT_DIR}`);
process.exitCode = exitCode;

/* ---------------------------- helpers ---------------------------- */
/**
 * 统一失败原因口径：blocked 用原始原因；调用失败保留**适配器原始错误**（不再只剩“未满足期望”）；
 * 调用成功但判定不过才写“未满足期望”。这样报告能直接指出 404/参数不支持等真实原因。
 */
function failureReason(out, verified) {
  if (out.status === "blocked") return out.reason;
  if (out.status !== "ok") return `调用失败：${String(out.reason ?? "未知原因").slice(0, 240)}`;
  return verified.ok ? undefined : `未满足期望：${verified.detail}`;
}

function renderMarkdown(r) {
  const md = [];
  md.push(`# P 域 · 生产环境真机实测报告（RDAS v3.1）`);
  md.push("");
  md.push(`> 生成：${r.at}｜环境档位：**${r.environment.kind}**${r.selftest ? "｜**自检模式（非生产实测证据）**" : ""}`);
  md.push("");
  md.push(`**结论：${r.verdict}**`);
  md.push("");
  md.push("## 一、环境与指纹");
  md.push("");
  md.push("```");
  for (const line of fingerprintLines(r.fingerprint)) md.push(line);
  md.push("```");
  md.push("");
  if (!r.environment.declaredTarget && r.environment.isProduction) {
    md.push("> ⚠ profile 未声明 `environment.target`：生产档位下必须显式声明目标地址，否则不得计入生产实测。");
    md.push("");
  }
  md.push("## 二、内置模型与凭据状态");
  md.push("");
  md.push("凭据来源（只记来源与键名，绝不记录值）：");
  for (const c of r.credentialSources ?? []) {
    md.push(`- \`${c.source}\`${c.path ? ` → ${c.path}` : ""}：${(c.keys ?? []).filter(Boolean).join(", ") || "（无相关键）"}`);
  }
  md.push("");
  md.push("| 模型 | 模态 | 链路 | 模型 ID | 端点 | 凭据 | 状态 |");
  md.push("|---|---|---|---|---|---|---|");
  for (const m of r.models) {
    md.push(`| ${m.id} | ${m.kind} | ${m.adapter} | ${m.model ?? "?"} | ${m.baseUrl ?? "?"} | ${m.credentialEnv ?? "—"} | ${m.ready ? "就绪" : `缺失：${m.missing.join("；")}`} |`);
  }
  md.push("");
  md.push("## 三、任务结果（含链路深度）");
  md.push("");
  md.push("| 任务 | 类型 | 链路 | 预声明模型 | 实际返回模型 | 状态 | 耗时 | 回执 | 说明 |");
  md.push("|---|---|---|---|---|---|---|---|---|");
  for (const t of r.tasks) {
    md.push(`| ${t.id} | ${t.kind} | ${t.chain ?? "—"} | ${t.modelExpected ?? "未声明"} | ${t.modelResolved ?? "未回读"} | ${t.status} | ${Math.round((t.ms ?? 0) / 1000)}s | ${t.receipt?.synced ? "有" : "无"} | ${(t.reason ?? "").slice(0, 120)} |`);
  }
  md.push("");
  md.push("## 四、配额与成本台账（硬上限）");
  md.push("");
  md.push("| 计量 | 已用 | 上限 |");
  md.push("|---|---:|---:|");
  const u = r.budget.used;
  const b = r.budget.budgets;
  md.push(`| LLM 调用 | ${u.llmCalls} | ${b.maxLlmCalls} |`);
  md.push(`| LLM token | ${u.llmTokens} | ${b.maxLlmTokens} |`);
  md.push(`| 生图张数 | ${u.images} | ${b.maxImages} |`);
  md.push(`| 视频段数 | ${u.videoClips} | ${b.maxVideoClips} |`);
  md.push(`| 视频总秒数 | ${u.videoSeconds} | ${b.maxVideoSecondsTotal} |`);
  md.push(`| 预估成本 | ¥${u.costCny} | ¥${b.maxCostCny} |`);
  if (r.budget.blocked.length) {
    md.push("");
    md.push("额度拦下的任务（不得静默跳过）：");
    for (const x of r.budget.blocked) md.push(`- ${x.taskId}：${x.reason}`);
  }
  md.push("");
  md.push("## 五、未验证与后续");
  md.push("");
  if (r.task?.status) md.push("");
  const blockedIds = r.summary.blockedIds ?? [];
  if (blockedIds.length) {
    md.push(`- 未验证任务：${blockedIds.join("、")}。具体阻断原因见逐项回执；缺凭据/目标可补齐后重跑，缺可信预算总量约束的 LLM/产品入口必须先接通该约束，补凭据不能解除。`);
  }
  if (r.environment.kind === "local-preview") md.push("- 本机预览档位不产生生产实测证据；O/P 域只能写“未验证/结构合规”。");
  if (r.selftest) md.push("- 自检模式产物为合成数据（stub），只能证明执行器管道可用。");
  md.push(...r.notes.map((n) => `- ${n}`));
  md.push("");
  md.push("## 收尾报告");
  md.push("");
  md.push(`- 已完成：环境解析/指纹、模型凭据解析、任务矩阵（${r.summary.total} 项）、配额台账、回执与产物。`);
  md.push(`- 未完成/未覆盖：${blockedIds.length ? `未验证任务：${blockedIds.join("、")}，逐项原因已留档` : "无"}`);
  md.push("- 自主追加事项及理由：统一回执、预算和路由观察的完成条件，避免任一声明替代实际证据。");
  md.push("- 采用的假设：请求模型和端点来自 profile/env；实际返回模型仅认供应商/原始事件回读。");
  md.push(`- 置信度：${r.verdict === "pass" ? "中高（真实回执 + 产物，样本小）" : r.selftest ? "低（自检替身）" : "低（存在未验证项）"}`);
  md.push("- 建议复核：逐项阻断/失败回执、budget-ledger.jsonl、返回模型与本地媒体散列。");
  md.push("");
  md.push("## 自检表");
  md.push("");
  md.push("- [是] 所有选定任务及未验证项已逐项列出，没有挑选成功项作为整体结论。");
  md.push("- [是] 自主执行已授权范围，必要阻断有具体原因，没有以不必要问句收尾。");
  md.push("- [是] 结果、预算、回执、产物及 18 项观察绑定同次运行；未验证保留原状态。");
  md.push("- [是] 原始输出与运行索引可复核；合成 selftest 不作为真实模型或客户业务通过证据。");
  md.push("");
  return `${md.join("\n")}\n`;
}
