/**
 * providers.mjs · 生产实测（P 域）真实模型适配器（RDAS v3.1 §19）
 *
 * 四个适配器，报告必须写明链路与当前预算边界：
 * 正式 CLI 当前只放行受数量/时长约束的 gen-http；外部 LLM 缺可信
 * 输入/输出/重试总 token 上界，product 缺服务端逐请求预算 seam，均调用前 blocked。
 * dsh-harness/model-gateway 低层适配器保留给受控 transport/selftest 的机制验证，
 * 不能据此宣称正式付费链路已可执行或有先验总费用保证。
 *
 *   1. `dsh-harness`    客户端内置 DeepSeek Harness（dsh）headless 会话：
 *                       真实 provider → 工具调用过 WorkLoom 围栏瀑布 → session/event 落哈希链账本。
 *                       这是「客户端内置模型 + 生产链路组件」的最深路径（含围栏与账本）。
 *   2. `model-gateway`  OpenAI 兼容网关直连（/chat/completions）：证明模型侧的推理与多模态理解能力，
 *                       不含围栏/账本（报告必须降级说明）。
 *   3. `gen-http`       火山方舟 Ark 生成 API（Seedream 生图 / Seedance 生视频，任务制异步）；
 *                       产物落盘 + 回执（task_id → url）。模型 ID 与端点从 profile/env 解析，不写死。
 *   4. `product-dispatch` 经被测产品自身入口（trpc `threads.dispatch`）派单 + 状态断言，
 *                       走的是产品运行时 → model-router → provider 的完整业务链。
 *
 * fail-closed：永不在凭据缺失时用 mock 顶替并写“通过”——一律返回 status=blocked 并列出缺失项。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { maskSecret } from "../target.mjs";
import { createBudget, LIVE_BUDGET_CAPS } from "./budget.mjs";
import { assertSafeTaskId, downloadArtifact, publicArtifactUrl } from "./media.mjs";
import { loadChromium } from "../playwright.mjs";
import { readDshAudit } from "./audit.plugin.mjs";
import { foldDshUsage, normalizeOpenAiUsage } from "./usage.mjs";
import { evaluateEventAssertion, freshReceipt, realExecution } from "./assertions.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const modelIdentity = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

/** Pinned dsh-v0.2.0-rc.2 API-key plugin and Messages transport configuration. */
export const DSH_DEEPSEEK_DEFAULTS = {
  route: "deepseek-official",
  model: "deepseek-flash",
  baseURL: "https://api.deepseek.com/anthropic",
  openAiBaseURL: "https://api.deepseek.com",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  fallbackApiKeyEnvs: ["LLM_API_KEY"],
  fallbackBaseEnvs: ["LLM_BASE_URL", "DEEPSEEK_BASE_URL"],
};

/**
 * OpenAI 兼容根的环境变量优先级。
 * 背景（2026-09-29 growthmatrix 隔离副本 P 域实测）：封存凭据里两个端点变量是**两种方言**——
 * `DEEPSEEK_BASE_URL` 是 Anthropic 兼容根（`<root>/anthropic`，Messages 协议，dsh-harness 走它），
 * `LLM_BASE_URL` 才是 OpenAI 兼容根。把 Anthropic 根交给 `<root>/chat/completions` 只会得到 404
 * （实测：POST https://api.deepseek.com/anthropic/chat/completions → 404 空体；同一 key 打
 * https://api.deepseek.com/chat/completions → 200）。
 */
export const OPENAI_COMPATIBLE_BASE_ENVS = ["LLM_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "DEEPSEEK_BASE_URL"];

/** Anthropic 兼容面去后缀：`<root>/anthropic` 的 OpenAI 兼容面在 `<root>`（仓库既有口径：scripts/tools/explainer-run.mts） */
export function normalizeOpenAiCompatibleBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.replace(/\/+$/u, "").replace(/\/anthropic$/u, "");
}

export function pickEnv(keys, env = process.env) {
  for (const key of keys) {
    const value = env[key];
    if (value && String(value).trim()) return { key, value: String(value).trim() };
  }
  return { key: null, value: null };
}

/**
 * 解析 profile.live.models 的真实凭据可用性（不打印秘密）。
 * @returns {Array<{id, kind, adapter, ready, missing, resolved}>}
 */
export function resolveLiveModels(models = [], env = process.env) {
  return models.map((m) => {
    const kind = m.kind ?? "llm";
    const adapter = m.adapter ?? (kind === "llm" ? "dsh-harness" : "gen-http");
    const missing = [];
    const warnings = [];
    const resolved = { id: m.id, kind, adapter, model: m.model ?? null, baseUrl: null, credentialEnv: null };
    if (adapter === "dsh-harness" || adapter === "model-gateway") {
      const key = pickEnv([...(m.apiKeyEnv ? [m.apiKeyEnv] : []), DSH_DEEPSEEK_DEFAULTS.apiKeyEnv, ...DSH_DEEPSEEK_DEFAULTS.fallbackApiKeyEnvs], env);
      /**
       * 端点按链路方言分流（2026-09-29 修复，失败现象 = LLM-G1 `HTTP 404`）：
       *   · dsh-harness     → Anthropic 兼容根（Messages 协议）：`baseUrlEnv` → `fallbackBaseEnvs`；
       *   · model-gateway   → OpenAI 兼容根（`/chat/completions`）：`openAiBaseUrlEnv` → `OPENAI_COMPATIBLE_BASE_ENVS`
       *                       → 声明值 → `fallbackBaseEnvs`，并统一做 `…/anthropic` 归一。
       * 修复前两条链路共用同一套解析，封存文件里 `DEEPSEEK_BASE_URL=…/anthropic` 一旦命中，
       * model-gateway 就必然 404——且该断言在任何仓库、任何凭据下都永远无法通过。
       */
      const declaredBase = pickEnv([...(m.baseUrlEnv ? [m.baseUrlEnv] : []), ...DSH_DEEPSEEK_DEFAULTS.fallbackBaseEnvs], env);
      const openAiBase = pickEnv([
        ...(m.openAiBaseUrlEnv ? [m.openAiBaseUrlEnv] : []),
        ...OPENAI_COMPATIBLE_BASE_ENVS,
        ...(m.baseUrlEnv ? [m.baseUrlEnv] : []),
        ...DSH_DEEPSEEK_DEFAULTS.fallbackBaseEnvs,
      ], env);
      resolved.credentialEnv = key.key;
      resolved.baseUrl = adapter === "model-gateway"
        ? normalizeOpenAiCompatibleBaseUrl(openAiBase.value ?? DSH_DEEPSEEK_DEFAULTS.openAiBaseURL)
        : declaredBase.value ?? DSH_DEEPSEEK_DEFAULTS.baseURL;
      resolved.baseUrlDialect = adapter === "model-gateway" ? "openai" : "anthropic";
      resolved.model = m.model ?? resolveModelFromBaseUrl(resolved.baseUrl) ?? DSH_DEEPSEEK_DEFAULTS.model;
      if (!key.value) missing.push(`凭据未配置（可用环境变量：${unique([m.apiKeyEnv, DSH_DEEPSEEK_DEFAULTS.apiKeyEnv, ...DSH_DEEPSEEK_DEFAULTS.fallbackApiKeyEnvs]).join(" / ")}）`);
      // 端点缺失不是阻断项：两个适配器都有内置默认端点（可用环境变量覆盖）
      if (!declaredBase.value) warnings.push(`端点未显式配置，使用内置默认 ${DSH_DEEPSEEK_DEFAULTS.baseURL}（可用 ${unique([m.baseUrlEnv, ...DSH_DEEPSEEK_DEFAULTS.fallbackBaseEnvs]).join(" / ")} 覆盖）`);
      if (adapter === "model-gateway" && String(openAiBase.value ?? "") && String(openAiBase.value) !== resolved.baseUrl) {
        warnings.push(`model-gateway 端点按 OpenAI 兼容根归一：${openAiBase.value} → ${resolved.baseUrl}（Anthropic 兼容根不接受 /chat/completions）`);
      }
      if (!m.model) resolved.modelNote = `model 未显式声明，按端点推导/内置默认 ${resolved.model}（dsh 内置目录：deepseek-flash 支持文本+图像）`;
    } else if (adapter === "gen-http" || adapter === "arkcli") {
      const key = pickEnv([...(m.apiKeyEnv ? [m.apiKeyEnv] : []), kind === "image" ? "SEEDREAM_API_KEY" : "SEEDANCE_API_KEY", "VOLCENGINE_ARK_API_KEY", "ARK_API_KEY"], env);
      const base = pickEnv([...(m.baseUrlEnv ? [m.baseUrlEnv] : []), kind === "image" ? "SEEDREAM_ENDPOINT" : "SEEDANCE_ENDPOINT", "ARK_BASE_URL"], env);
      resolved.credentialEnv = key.key;
      resolved.baseUrl = base.value ?? "https://ark.cn-beijing.volces.com/api/v3";
      resolved.model = m.model ?? (kind === "image" ? "seedream-5.0" : "seedance-2.5");
      if (!key.value) missing.push(`凭据未配置（可用环境变量：${unique([m.apiKeyEnv, kind === "image" ? "SEEDREAM_API_KEY" : "SEEDANCE_API_KEY", "VOLCENGINE_ARK_API_KEY", "ARK_API_KEY"]).join(" / ")}）`);
    } else if (adapter === "product-dispatch") {
      resolved.credentialEnv = null;
      resolved.model = m.model ?? null;
    }
    return { ...resolved, ready: missing.length === 0, missing, warnings };
  });
}

/** LLM_MODEL 未声明时，按端点推导一个保守默认（DeepSeek 官方端点 → deepseek-flash） */
function resolveModelFromBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  if (/deepseek/i.test(baseUrl)) return DSH_DEEPSEEK_DEFAULTS.model;
  return null;
}

const unique = (list) => [...new Set(list.filter(Boolean))];

/* ------------------------------------------------------------------ */
/* 通道一：dsh-harness（客户端内置 DeepSeek Harness + 围栏 + 账本）        */
/* ------------------------------------------------------------------ */

function dshPaths(repoRoot) {
  const gate = join(repoRoot, "packages", "runtime", "dsh-gate");
  return {
    gate,
    bin: join(gate, "node_modules", ".bin", "dsh"),
    patchTemplate: join(gate, "profile.cordis.patch.yml"),
  };
}

/**
 * 生成真实 provider 的 cordis patch（不使用 dsh-gate 的 mock settings）。
 * 围栏规则源两种装配（2026-09-24 修复）：`rulesFile`（离线/无鉴权，优先）或 `rulesUrl`（+可选 bearer）。
 * 修复前只支持 rulesUrl 且插件对非数组响应会抛错 → 工具层整体不可用（P 域 LLM-M1 实测）。
 */
function renderLivePatch({ repoRoot, auditFile, budgetConfigFile, rulesUrl, rulesFile, model, baseUrl, expectedTokens, provider = "deepseek-official" }) {
  const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;
  const fenceConfig = rulesFile
    ? [`        rulesFile: ${quote(rulesFile)}`]
    : [`        rulesUrl: ${quote(rulesUrl)}`];
  return [
    "# RDAS v3.1 · 生产实测 dsh patch（真实 provider；mock 仅供 selftest）",
    "- id: llm-deepseek",
    "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
    "  config:",
    `    apiKeyEnv: ${DSH_DEEPSEEK_DEFAULTS.apiKeyEnv}`,
    `    baseURL: ${quote(baseUrl)}`,
    "    reasoningEffort: high",
    `    maxTokens: ${expectedTokens}`,
    "- id: agent-default-model",
    "  config:",
    `    provider: ${provider}`,
    `    model: ${quote(model)}`,
    "- insert:",
    "    - id: workloom-fence",
    `      name: ${quote(join(repoRoot, "packages", "runtime", "plugins", "workloom-fence.plugin.js"))}`,
    "      config:",
    ...fenceConfig,
    "    - id: workloom-live-audit",
    `      name: ${quote(join(repoRoot, "scripts", "acceptance", "lib", "live", "audit.plugin.mjs"))}`,
    "      config:",
    `        file: ${quote(auditFile)}`,
    `        budgetConfigFile: ${quote(budgetConfigFile)}`,
    "",
  ].join("\n");
}

/**
 * 跑一次真实的 dsh headless 任务。
 * @returns {{status:"ok"|"failed"|"blocked", answer, audit, fenceHits, ms, model, evidence, receipt}}
 */
export async function runDshTask({
  repoRoot,
  workDir,
  model,
  prompt,
  rulesUrl,
  rulesFile = null,
  rulesToken = null,
  env = {},
  timeoutMs = 8 * 60_000,
  home = null,
  imagePath = null,
  taskId,
  budgetOptions,
  expectedTokens = 8000,
  allowedModels = [],
  baseUrl = null,
}) {
  const { gate, bin, patchTemplate } = dshPaths(repoRoot);
  if (!existsSync(bin)) {
    return { status: "blocked", reason: `dsh 可执行文件缺失：${bin}（先跑 packages/runtime/dsh-gate 的 pnpm install）` };
  }
  if (!existsSync(patchTemplate)) {
    return { status: "blocked", reason: `dsh patch 模板缺失：${patchTemplate}` };
  }
  if (rulesToken) return { status: "blocked", called: false, reason: "DSH 围栏需 rulesFile 或无凭据 URL；禁止把 rulesToken 写入 patch" };
  if (!Array.isArray(allowedModels) || allowedModels.some((value) => !modelIdentity(value))) return { status: "blocked", called: false, reason: "DSH allowedModels 必须是非空模型名组成的显式数组" };
  try { assertSafeTaskId(taskId); } catch (error) { return { status: "blocked", called: false, reason: error.message }; }
  if (!budgetOptions || resolve(budgetOptions.outDir ?? "") !== resolve(workDir) || !Number.isSafeInteger(expectedTokens) || expectedTokens <= 0) return { status: "blocked", called: false, reason: "DSH 缺少同次运行预算配置或有效逐请求 token 预占" };
  const installedPackage = join(gate, "node_modules", "@deepseek-ai", "dsh", "package.json");
  let version;
  try { version = JSON.parse(readFileSync(installedPackage, "utf8")).version; } catch { return { status: "blocked", called: false, reason: "DSH 已安装运行时版本不可回读，尚未调用模型" }; }
  if (version !== "0.2.0-rc.2") return { status: "blocked", called: false, reason: "DSH live adapter 只验证固定 0.2.0-rc.2 事件协议，当前安装版本未验证" };
  const endpoint = baseUrl ?? env.DEEPSEEK_BASE_URL ?? DSH_DEEPSEEK_DEFAULTS.baseURL;
  try {
    const target = new URL(endpoint);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("unsafe endpoint");
  } catch { return { status: "blocked", called: false, reason: "DSH Messages 端点必须是无凭据、查询或片段的 HTTP(S) 根" }; }
  if (!env.DEEPSEEK_API_KEY?.trim()) return { status: "blocked", called: false, reason: "DSH 显式调用环境缺少 DEEPSEEK_API_KEY" };
  const budget = createBudget(budgetOptions);
  const dshHome = home ?? join(workDir, "dsh-home");
  const homeRelative = relative(resolve(workDir), resolve(dshHome));
  if (isAbsolute(homeRelative) || homeRelative === ".." || homeRelative.startsWith(`..${sep}`)) return { status: "blocked", called: false, reason: "DSH 临时 HOME 必须位于本次产物目录内" };
  mkdirSync(join(dshHome, "profiles", "headless"), { recursive: true });
  const auditFile = join(workDir, `dsh-audit-${taskId}-${budgetOptions.runId}.jsonl`);
  const budgetConfigFile = join(workDir, `dsh-budget-${taskId}.json`);
  writeFileSync(budgetConfigFile, JSON.stringify({ ...budgetOptions, taskId, expectedTokens, expectedModel: model, allowedModels }, null, 1), { mode: 0o600 });
  const processEnv = { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, HOME: dshHome, ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), ...env, DSH_HOME: dshHome };

  // ① 初始化 headless profile（幂等：已存在 package.json 即跳过）
  const profilePkg = join(dshHome, "profiles", "headless", "package.json");
  if (!existsSync(profilePkg)) {
    const init = await runProcess(bin, ["--profile", "headless", "--dump-config"], {
      cwd: gate,
      env: processEnv,
      timeoutMs: Math.min(timeoutMs, 120_000),
    });
    if (init.code !== 0) return { status: "blocked", called: false, reason: "DSH headless profile 初始化失败，尚未调用模型", exitCode: init.code };
  }
  if (!existsSync(profilePkg)) {
    return { status: "blocked", reason: `dsh headless profile 初始化失败（${profilePkg} 未生成）` };
  }

  // ② patch：真实 provider + 围栏瀑布（打真实 fence.activeRules）+ 哈希链账本
  const patch = renderLivePatch({ repoRoot, auditFile, budgetConfigFile, rulesUrl, rulesFile, model, baseUrl: endpoint, expectedTokens });
  const patchPath = join(workDir, `dsh-patch-${taskId}.yml`);
  writeFileSync(join(dshHome, "profiles", "headless", "cordis.patch.yml"), patch);
  writeFileSync(patchPath, patch);
  // ③ settings.yaml 留空 providers 段（凭据经 apiKeyEnv 由 dsh credential seam 解析，不落盘）
  writeFileSync(join(dshHome, "settings.yaml"), "# RDAS v3.1 生产实测：provider 走 cordis patch + apiKeyEnv，不在文件里落任何密钥\nllm-pi-ai:\n  providers: {}\n");

  const started = Date.now();
  const task = imagePath
    ? `${prompt}\n\n【验收夹具】本地图片路径：${imagePath}\n请用你的文件读取能力打开该图片，再回答上面的问题。`
    : prompt;
  const res = await runProcess(bin, ["--profile", "headless", task], {
    cwd: gate,
    env: { ...processEnv, DSH_LIVE_RUN: "1" },
    timeoutMs,
  });
  const ms = Date.now() - started;
  const out = `${res.stdout}${res.stderr}`;
  const fenceHits = (out.match(/\[workloom-fence\] judge tool=[^\n]*/g) ?? []).map((l) => l.trim());
  const audit = readDshAudit(auditFile);
  const usage = audit.ok ? foldDshUsage(audit.events) : { complete: false, completed: false, totalTokens: null, calls: null, routes: [], reason: audit.reason };
  let taskReservations = budget.summary().reservations.filter((row) => row.taskId === taskId);
  for (const row of taskReservations.filter((row) => row.status === "pending")) {
    budget.commit({ taskId, reservationId: row.reservationId, kind: "llm", measured: false, status: "blocked", detail: "DSH 进程退出/超时后尚有未结算请求；继续持有预占并冻结" });
  }
  taskReservations = budget.summary().reservations.filter((row) => row.taskId === taskId);
  const called = taskReservations.length > 0;
  const measured = usage.complete === true && taskReservations.length === usage.calls && taskReservations.every((row) => row.settlement?.measured === true) && taskReservations.reduce((sum, row) => sum + row.settlement.tokens, 0) === usage.totalTokens;
  const routeOk = usage.routes.length > 0 && usage.routes.every((route) => route.provider === "deepseek-official" && (route.model === model || allowedModels.includes(route.model)));
  if (called && (!measured || audit.redacted)) budget.freeze({ taskId, reason: audit.redacted ? "DSH 事件脱敏后不能成为真实成功证据" : usage.reason ?? "DSH durable usage 与逐请求预算结算不一致" });
  const budgetState = budget.summary();
  const blocked = !measured || !routeOk || audit.redacted || budgetState.frozenBy.length > 0 || budgetState.blocked.some((row) => row.taskId === taskId);
  const answer = usage.answer ?? null;
  const ok = res.code === 0 && !res.truncated && audit.ok && measured && routeOk && usage.completed && Boolean(answer?.trim()) && !blocked && budgetState.exceeded.length === 0;
  const chain = { ok: audit.ok && !audit.redacted, detail: audit.ok ? `完整 ${audit.lines} 条；sha256 ${audit.head}` : audit.reason };
  const actualModel = modelIdentity([...audit.events].reverse().find((event) => event.type === "assistant/message")?.data?.message?.source?.model);
  return {
    status: ok ? "ok" : blocked ? "blocked" : "failed",
    reason: ok ? undefined : blocked ? usage.reason ?? "DSH 真实用量、路由或预算证据未验证" : "DSH 进程/turn 未成功完成或实际用量超限",
    called,
    tokens: measured ? usage.totalTokens : null,
    calls: measured ? usage.calls : null,
    usage: { ...usage, complete: measured, routesVerified: routeOk },
    answer,
    exitCode: res.code,
    ms,
    model: actualModel,
    requestedModel: model,
    audit: { file: auditFile, lines: audit.lines, chain },
    fenceHits,
    evidence: { transcript: out.slice(-8000), command: `${bin} --profile headless <task>`, patchPath, budgetConfigFile, runtimeVersion: version },
    receipt: {
      kind: "dsh-harness",
      model: actualModel,
      requestedModel: model,
      runtimeVersion: version,
      tokens: measured ? usage.totalTokens : null,
      calls: measured ? usage.calls : null,
      usageComplete: measured,
      turnCompleted: usage.completed === true,
      routes: usage.routes,
      auditLines: audit.lines,
      auditChainOk: chain?.ok ?? null,
      fenceJudgements: fenceHits.length,
      synced: ok,
      verified_at: new Date().toISOString(),
    },
    raw: out.slice(-2000),
  };
}

function runProcess(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let truncated = false;
    const stop = () => {
      killed = true;
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") stderr += "\nDSH process-group termination failed"; }
    };
    const timer = setTimeout(stop, timeoutMs);
    const capture = (data, destination) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + data.byteLength > 2 * 1024 * 1024) { truncated = true; stop(); return; }
      if (destination === "stdout") stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on("data", (d) => capture(d, "stdout"));
    child.stderr.on("data", (d) => capture(d, "stderr"));
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: killed ? -9 : (code ?? -1), stdout, stderr, truncated }); });
  });
}

/* ------------------------------------------------------------------ */
/* 通道二：model-gateway（OpenAI 兼容网关，文本 + 多模态理解）              */
/* ------------------------------------------------------------------ */

export const LLM_TOTAL_BUDGET_BLOCK = "文本模型入口缺少可信的输入、输出及重试总 token 用量上界；expectedTokens 只是估算，DSH maxTokens 仅约束输出。正式非 selftest 执行在调用前阻断，尚未预占、登录、启动 DSH 或请求供应商，真实 LLM 链未验证";

/** Controlled low-level transport only; formal CLI blocks external LLM admission before this adapter. */
export async function runChatTask({ resolved, prompt, timeoutMs = 180_000, env = process.env, image = null }) {
  if (!resolved?.ready) return { status: "blocked", called: false, reason: resolved?.missing?.join("；") ?? "文本模型未配置" };
  const apiKey = pickEnv([resolved.credentialEnv, DSH_DEEPSEEK_DEFAULTS.apiKeyEnv, "LLM_API_KEY"], env).value;
  if (!apiKey) return { status: "blocked", called: false, reason: "文本模型凭据未配置" };
  /** 兜底再归一一次：即使 profile 直接把 Anthropic 根声明给 model-gateway，也不至于打出 /anthropic/chat/completions（404） */
  const base = normalizeOpenAiCompatibleBaseUrl(resolved.baseUrl);
  const url = `${base}/chat/completions`;
  try {
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("unsafe endpoint");
  } catch { return { status: "blocked", called: false, reason: "模型端点必须是无凭据、查询或片段的 HTTP(S) 根" }; }
  const content = image
    ? [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } },
    ]
    : prompt;
  const started = Date.now();
  const unknown = (status, reason) => ({ status, reason, called: true, tokens: null, usage: { complete: false, calls: 1, totalTokens: null, reason: "已尝试请求，供应商实际计量不可得" }, ms: Date.now() - started,
    receipt: { kind: "model-gateway", endpoint: url, id: null, model: null, usageComplete: false, tokens: null, synced: false, verified_at: new Date().toISOString() } });
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: resolved.model, messages: [{ role: "user", content }], temperature: 0.2, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return unknown("blocked", `模型调用失败/超时，实际用量未验证：${String(err?.message ?? err).slice(0, 200)}`);
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 错误体 */ }
  if (!res.ok) {
    return unknown([401, 403].includes(res.status) ? "blocked" : "failed", `HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const answer = typeof json?.choices?.[0]?.message?.content === "string" ? json.choices[0].message.content : "";
  const usage = normalizeOpenAiUsage(json?.usage);
  const actualModel = modelIdentity(json?.model);
  const identity = typeof json?.id === "string" && json.id.trim() && actualModel;
  return {
    status: !usage ? "blocked" : answer && identity ? "ok" : "failed",
    reason: !usage ? "模型响应没有有效的供应商实际 usage；不能记为零用量或完成" : !identity ? "模型响应没有可回读的调用 ID/实际模型" : !answer ? "模型没有返回答案" : undefined,
    called: true,
    answer,
    ms: Date.now() - started,
    model: actualModel,
    requestedModel: resolved.model,
    tokens: usage?.totalTokens ?? null,
    usage: { complete: Boolean(usage), calls: 1, totalTokens: usage?.totalTokens ?? null },
    receipt: {
      kind: "model-gateway",
      endpoint: url,
      model: actualModel,
      requestedModel: resolved.model,
      id: json?.id ?? null,
      tokens: usage?.totalTokens ?? null,
      usageComplete: Boolean(usage),
      synced: Boolean(answer && identity && usage),
      verified_at: new Date().toISOString(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 通道三：gen-http（火山方舟 Ark：Seedream 生图 / Seedance 生视频）        */
/* ------------------------------------------------------------------ */

/**
 * 组图能力矩阵（官方文档查证 2026-09-24 · 火山方舟「图片生成 API」）：
 *  - Doubao Seedream 5.0 pro / 5.0 flash：**不支持** `sequential_image_generation`，
 *    能力口径是"生成单图、暂不支持组图生成"；
 *  - Seedream 5.0 lite / 4.5 / 4.0：支持 `sequential_image_generation: auto` 组图（最多 15 张）。
 * 拿不准的模型名一律按"不支持"处理：宁可按单图逐张调用（结果等价、配额口径不变），
 * 也不要把不支持的参数发给生产端点——实测 IMG-01 因该参数被 Ark 直接 400 InvalidParameter。
 */
function supportsSequentialImageGeneration(model) {
  const m = String(model ?? "").toLowerCase();
  if (/5[.\-]0[.\-]?(pro|flash)/.test(m)) return false; // 5.0 pro / 5.0 flash：只出单图
  if (/5[.\-]0[.\-]?lite/.test(m)) return true;
  if (/4[.\-]?5|4[.\-]?0/.test(m)) return true;
  return false;
}

/** 生图（同步 API）：POST {base}/images/generations → data[].url */
export async function runImageTask({ resolved, task, timeoutMs = 300_000, env = process.env, artifactsDir }) {
  const preflight = (reason) => ({ status: "blocked", called: false, measurementComplete: false, produced: null, reason });
  if (!resolved?.ready) return preflight(resolved?.missing?.join("；") ?? "图片模型未配置");
  try { assertSafeTaskId(task.id); } catch (error) { return preflight(error.message); }
  const apiKey = pickEnv([resolved.credentialEnv, "SEEDREAM_API_KEY", "VOLCENGINE_ARK_API_KEY", "ARK_API_KEY"], env).value;
  if (!apiKey) return preflight("图片模型凭据未配置");
  const base = String(resolved.baseUrl).replace(/\/$/, "");
  const count = Number(task.images ?? 1);
  if (!Number.isSafeInteger(count) || count <= 0 || count > LIVE_BUDGET_CAPS.maxImages) return preflight("图片张数必须是配额范围内的正整数");
  if (["model", "prompt", "response_format", "sequential_image_generation", "sequential_image_generation_options", "n"].some((key) => Object.hasOwn(task.params ?? {}, key))) {
    return preflight("图片 params 不得覆盖模型、内容或已占额的生成数量");
  }
  const started = Date.now();
  const groupable = count > 1 && supportsSequentialImageGeneration(resolved.model);
  const urls = [];
  const generationUsage = [];
  let produced = 0;
  let calls = 0;
  let lastJson = null;
  const finish = (status, reason, measurementComplete, artifacts = []) => {
    const models = generationUsage.map((row) => row.model);
    const model = measurementComplete && models.length > 0 && models.every((value) => value && value === models[0]) ? models[0] : null;
    if (status === "ok" && !model) { status = "failed"; reason = "生成/交付已完成，但缺少各轮一致的供应商实际返回模型，不能借请求配置证明路由"; }
    return {
    status, reason, called: calls > 0, measurementComplete,
    ms: Date.now() - started, model, requestedModel: resolved.model, calls,
    produced: measurementComplete ? produced : null,
    knownProduced: produced, observedProduced: urls.length, artifacts,
    receipt: {
      kind: "gen-http.image", model, requestedModel: resolved.model, endpoint: `${base}/images/generations`,
      created: lastJson?.created ?? null, urls: urls.map(publicArtifactUrl), calls,
      requested: count, produced: measurementComplete ? produced : null,
      knownProduced: produced, observedProduced: urls.length,
      measurementComplete, measurementSource: measurementComplete ? "usage.generated_images" : null,
      generationUsage, delivered: artifacts.length, artifacts: artifacts.map((artifact) => ({ ...artifact })),
      synced: status === "ok", verified_at: new Date().toISOString(),
    },
    };
  };
  /** 一次调用：组图模型一轮出 N 张；不支持组图的模型（如 5.0 pro）逐张调用 N 轮 */
  async function callOnce(sequential) {
    let res;
    try {
      res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: resolved.model,
          prompt: task.prompt,
          size: task.size ?? "1024x1024",
          response_format: "url",
          watermark: task.watermark ?? false,
          ...(sequential ? { sequential_image_generation: "auto", sequential_image_generation_options: { max_images: count } } : {}),
          ...(task.params ?? {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { error: `生图调用失败/超时，实际张数未验证：${String(err?.message ?? err).slice(0, 200)}`, urls: [], measurementComplete: false };
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok) return { error: `HTTP ${res.status}：${text.slice(0, 300)}；实际张数未验证`, urls: [], measurementComplete: false };
    const urls = Array.isArray(json?.data) ? json.data.map((d) => d?.url).filter((url) => typeof url === "string" && url) : [];
    const generatedImages = json?.usage?.generated_images;
    // URL 数量只证明观察到的输出；只有完整供应商 usage 才能回填实际张数。
    // 缺失/畸形/矛盾计量不得变成 actual=0，即使 HTTP 为 200。
    const measurementComplete = Array.isArray(json?.data) && json.data.every((entry) => entry && typeof entry === "object"
      && (typeof entry.url === "string" && entry.url || entry.error && typeof entry.error === "object")) && Number.isSafeInteger(generatedImages) && generatedImages >= 0
      && generatedImages === urls.length && !json?.error;
    if (!measurementComplete) return { error: "生图响应没有完整且一致的 usage.generated_images，实际总张数未验证", urls, generatedImages, json, measurementComplete: false };
    if (!urls.length) return { error: "供应商返回实际生成 0 张，任务没有可交付图片", urls, generatedImages, json, measurementComplete: true };
    return { urls, generatedImages, json, measurementComplete: true };
  }

  const rounds = groupable ? 1 : Math.max(1, count);
  for (let round = 0; round < rounds; round += 1) {
    const r = await callOnce(groupable);
    calls += 1;
    urls.push(...r.urls);
    // Partial/contradictory replies retain every observed lower bound while the
    // whole task remains unmeasured; the reservation still holds all its units.
    produced += Math.max(r.urls.length, Number.isSafeInteger(r.generatedImages) && r.generatedImages >= 0 ? r.generatedImages : 0);
    generationUsage.push({ call: calls, model: modelIdentity(r.json?.model), generatedImages: Number.isSafeInteger(r.generatedImages) && r.generatedImages >= 0 ? r.generatedImages : null,
      returnedImages: r.urls.length, measurementComplete: r.measurementComplete === true });
    lastJson = r.json ?? lastJson;
    if (r.error) {
      // 未知轮次立即停止；此前返回 URL 与可信部分用量留在回执，不能再调用下一轮。
      return finish(r.measurementComplete ? "failed" : "blocked", r.error, r.measurementComplete === true);
    }
    if (!groupable && urls.length >= count) break;
  }
  if (produced > count) return finish("failed", "供应商产出数量超过已占额数量，禁止继续下载并将实际产出全额计量", true);
  const saved = [];
  const failures = [];
  for (const [i, url] of urls.entries()) {
    const delivery = await downloadArtifact({ url, artifactsDir, taskId: task.id, index: i + 1, kind: "image", timeoutMs });
    if (delivery.ok) saved.push(delivery.artifact);
    else failures.push(delivery);
  }
  const complete = failures.length === 0 && saved.length === count && urls.length === count;
  const reason = failures.map((f) => f.reason).join("；") || (!complete ? `生成/落盘数量 ${urls.length}/${saved.length} 与请求 ${count} 不一致` : undefined);
  return finish(complete ? "ok" : failures.some((f) => f.status === "blocked") ? "blocked" : "failed", reason, true, saved);
}

/** 生视频（异步任务制）：POST {base}/contents/generations/tasks → GET …/tasks/{id} */
export async function runVideoTask({ resolved, task, timeoutMs = 20 * 60_000, env = process.env, artifactsDir, pollMs = 8000 }) {
  const preflight = (reason) => ({ status: "blocked", called: false, measurementComplete: false, durationSeconds: null, reason });
  if (!resolved?.ready) return preflight(resolved?.missing?.join("；") ?? "视频模型未配置");
  try { assertSafeTaskId(task.id); } catch (error) { return preflight(error.message); }
  const apiKey = pickEnv([resolved.credentialEnv, "SEEDANCE_API_KEY", "VOLCENGINE_ARK_API_KEY", "ARK_API_KEY"], env).value;
  if (!apiKey) return preflight("视频模型凭据未配置");
  const base = String(resolved.baseUrl).replace(/\/$/, "");
  const duration = Number(task.durationSeconds ?? 12);
  if (!Number.isFinite(duration) || duration < LIVE_BUDGET_CAPS.minVideoSeconds || duration > LIVE_BUDGET_CAPS.maxVideoSeconds) return preflight("视频时长超出配额允许范围");
  if (["model", "content", "duration"].some((key) => Object.hasOwn(task.params ?? {}, key))) return preflight("视频 params 不得覆盖模型、内容或已占额时长");
  const started = Date.now();
  let taskId = null;
  let last = null;
  let actualModel = null;
  const unknown = (reason) => ({ status: "blocked", reason, called: true, measurementComplete: false,
    ms: Date.now() - started, model: actualModel, requestedModel: resolved.model, taskId, durationSeconds: null, artifacts: [],
    receipt: { kind: "gen-http.video", model: actualModel, requestedModel: resolved.model, endpoint: `${base}/contents/generations/tasks`, taskId,
      durationSeconds: null, reportedDurationSeconds: last?.duration ?? last?.data?.duration ?? null,
      measurementComplete: false, measurementSource: null, artifacts: [], synced: false, verified_at: new Date().toISOString() } });
  let submit;
  try {
    submit = await fetch(`${base}/contents/generations/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: resolved.model,
        content: [{ type: "text", text: task.prompt }],
        duration,
        ratio: task.ratio ?? "16:9",
        resolution: task.resolution ?? "720p",
        generate_audio: task.generateAudio ?? false,
        ...(task.params ?? {}),
      }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 120_000))),
    });
  } catch (err) {
    return unknown(`视频提交失败/超时，实际时长未验证：${String(err?.message ?? err).slice(0, 200)}`);
  }
  const submitText = await submit.text().catch(() => "");
  let submitJson = null;
  try { submitJson = JSON.parse(submitText); } catch { /* 非 JSON */ }
  if (!submit.ok) return unknown(`提交 HTTP ${submit.status}：${submitText.slice(0, 300)}；实际时长未验证`);
  const submittedId = submitJson?.id ?? submitJson?.data?.id;
  if (typeof submittedId !== "string" || !submittedId.trim()) return unknown(`未返回有效 task_id：${submitText.slice(0, 200)}；实际时长未验证`);
  taskId = submittedId;

  while (Date.now() - started < timeoutMs) {
    await sleep(Math.max(0, Math.min(pollMs, timeoutMs - (Date.now() - started))));
    if (Date.now() - started >= timeoutMs) break;
    const r = await fetch(`${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, timeoutMs - (Date.now() - started)))),
    }).catch((err) => ({ ok: false, status: 0, text: async () => String(err?.message ?? err) }));
    const text = await r.text().catch(() => "");
    try { last = JSON.parse(text); } catch { last = { raw: text.slice(0, 200) }; }
    if (!r.ok) return unknown(`视频轮询 HTTP ${r.status}；实际时长未验证`);
    if ((last?.id ?? last?.data?.id) !== taskId) return unknown("视频轮询返回的任务身份与提交不一致；实际时长未验证");
    actualModel = modelIdentity(last?.model ?? last?.data?.model);
    const status = last?.status ?? last?.data?.status;
    if (status === "succeeded" || status === "success") {
      const url = last?.content?.video_url ?? last?.data?.content?.video_url ?? last?.data?.video_url ?? null;
      // API duration 是约数，且缺失字段不能回落到请求 duration；只有
      // 实际落盘且完成播放的媒体时长可以成为完整计量。
      const reportedDurationSeconds = last?.duration ?? last?.data?.duration ?? null;
      const delivery = url ? await downloadArtifact({ url, artifactsDir, taskId: task.id, kind: "video", timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)) }) : { ok: false, status: "failed", reason: "任务成功但未返回 video_url" };
      const artifacts = delivery.ok ? [delivery.artifact] : [];
      const durationSeconds = delivery.ok ? delivery.artifact.durationSeconds : null;
      const measurementComplete = delivery.ok && Number.isFinite(durationSeconds) && durationSeconds > 0;
      const validDuration = Number.isFinite(durationSeconds) && durationSeconds >= LIVE_BUDGET_CAPS.minVideoSeconds && durationSeconds <= LIVE_BUDGET_CAPS.maxVideoSeconds;
      const complete = delivery.ok && validDuration && Boolean(actualModel);
      return {
        status: complete ? "ok" : !measurementComplete || delivery.status === "blocked" ? "blocked" : "failed",
        reason: !delivery.ok ? delivery.reason : !validDuration ? "视频真实时长超出允许范围" : !actualModel ? "视频没有返回可核验的实际模型，不能借请求配置证明路由" : undefined,
        called: true,
        measurementComplete,
        ms: Date.now() - started,
        model: actualModel,
        requestedModel: resolved.model,
        taskId,
        artifacts,
        durationSeconds,
        receipt: {
          kind: "gen-http.video",
          model: actualModel,
          requestedModel: resolved.model,
          endpoint: `${base}/contents/generations/tasks`,
          taskId,
          videoUrl: url ? publicArtifactUrl(url) : null,
          durationSeconds,
          reportedDurationSeconds,
          measurementComplete,
          measurementSource: measurementComplete ? "decoded-local-file" : null,
          artifacts: artifacts.map((a) => ({ ...a })),
          synced: complete,
          verified_at: new Date().toISOString(),
        },
      };
    }
    if (["failed", "cancelled", "canceled", "expired"].includes(status)) {
      return unknown(`生成任务 ${status}，实际时长未验证：${JSON.stringify(last).slice(0, 300)}`);
    }
  }
  return unknown(`轮询超时（${Math.round(timeoutMs / 1000)}s），实际时长未验证；最后状态：${JSON.stringify(last).slice(0, 200)}`);
}

/* ------------------------------------------------------------------ */
/* 通道四：product-dispatch（经被测产品入口派单 + 状态断言）                */
/* ------------------------------------------------------------------ */

export const PRODUCT_DISPATCH_BUDGET_BLOCK = "产品入口缺少可信的服务端逐请求预算预占/结算接口；派单的意图分类、规划与回答可能隐式调用模型，requireModel:false 不能证明无费用。尚未登录或派单，生产产品模型链未验证";

export async function loginAsMember({ apiUrl, workspaceSlug, memberNo = "MEM-001", timeoutMs = 20_000 }) {
  const res = await fetch(`${apiUrl}/trpc/auth.loginAs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceSlug, memberNo }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  const token = json?.result?.data?.token;
  if (!token) throw new Error(`登录失败（loginAs）：${JSON.stringify(json).slice(0, 200)}`);
  return token;
}

/**
 * 受调用方控制的无模型 transport：派单 + 轮询 + 状态断言。
 * 当前产品 server 没有可信逐请求预算 seam；真实 live CLI 不进入此通道。
 * requireModel:true 在任何 dispatch I/O 前拒绝，不能先付费再冻结未知 usage。
 * 断言支持：
 *   - `http`：{ url, status, contains }
 *   - `sql` ：{ query, params, op, value }（需调用方提供 pg client；生产档位默认禁用）
 */
export async function runProductDispatchTask({
  apiUrl,
  token,
  task,
  timeoutMs = 8 * 60_000,
  pollMs = 5000,
  db = null,
  allowDb = false,
}) {
  if (task?.requireModel === true) return { status: "blocked", called: false, reason: PRODUCT_DISPATCH_BUDGET_BLOCK, ms: 0 };
  const started = Date.now();
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  let d = {};
  let threadId = null;
  let final = { status: null };
  let reason = null;
  let unavailable = false;
  let timedOut = false;
  const receipt = { kind: "product-dispatch", threadId: null, finalStatus: null, responseKind: null, dispatched_at: new Date(started).toISOString(), source: `${apiUrl}/trpc/threads.events`, evidenceSha256: null, realReceipts: [], synced: false, verified_at: new Date().toISOString() };
  const finish = ({ status = "failed", asserts = [], falseSuccess = false } = {}) => ({ status, reason, kind: d.kind ?? "unknown", threadId, finalStatus: final.status ?? null, asserts, falseSuccess, timedOut, ms: Date.now() - started, receipt });
  try {
    const dispatch = await fetch(`${apiUrl}/trpc/threads.dispatch`, {
      method: "POST", headers,
      body: JSON.stringify({ title: task.input ?? task.title, ...(task.presetKey ? { presetKey: task.presetKey } : {}) }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, timeoutMs))),
    });
    const json = await dispatch.json().catch(() => null);
    if (!dispatch.ok || json?.error) {
      reason = `派单未被目标接受（HTTP ${dispatch.status}）`;
      return finish({ status: [401, 403].includes(dispatch.status) ? "blocked" : "failed" });
    }
    d = json?.result?.data?.json ?? json?.result?.data ?? {};
    threadId = typeof d.threadId === "string" && d.threadId.trim() ? d.threadId : null;
    receipt.threadId = threadId;
    receipt.responseKind = d.kind ?? null;
    if (!threadId) {
      reason = "派单没有返回线程身份（澄清/拒绝/畸形响应不能作为完成回执）";
      return finish({ status: "blocked" });
    }
  } catch {
    reason = "派单请求失败或超时；没有取得可核验线程";
    return finish({ status: "blocked" });
  }
  while (Date.now() - started < timeoutMs) {
    await sleep(Math.max(0, Math.min(pollMs, timeoutMs - (Date.now() - started))));
    if (Date.now() - started >= timeoutMs) break;
    const r = await fetch(`${apiUrl}/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ threadId }))}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, timeoutMs - (Date.now() - started)))),
    }).catch(() => null);
    if (!r) continue;
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.error) {
      reason = `线程轮询失败（HTTP ${r.status}）`;
      unavailable = [401, 403].includes(r.status);
      break;
    }
    const data = j?.result?.data?.json ?? j?.result?.data;
    if (!data || typeof data.status !== "string") { reason = "目标未返回可核验线程状态"; break; }
    final = data;
    if (final.id !== threadId) { reason = "轮询返回的线程身份与派单不一致"; break; }
    if (["completed", "failed", "paused", "pending_review", "cancelled", "canceled", "timeout"].includes(final.status)) break;
  }
  const claimedDone = final.status === "completed" && final.id === threadId && !reason;
  if (!claimedDone && !reason) {
    timedOut = !["failed", "paused", "pending_review", "cancelled", "canceled", "timeout"].includes(final.status);
    reason = timedOut ? "线程等待超时；没有 completed 终态" : `线程终态/等待状态 ${final.status}，不能作为完成`;
  }
  let receiptOk = false;
  let eventEvidence = null;
  let events = [];
  let readbackAnswer = null;
  if (claimedDone) {
    try {
      const r = await fetch(`${apiUrl}/trpc/threads.events?input=${encodeURIComponent(JSON.stringify({ threadId, limit: 200 }))}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json().catch(() => null);
      events = j?.result?.data?.json ?? j?.result?.data;
      if (!r.ok || j?.error || !Array.isArray(events) || events.length >= 200) throw new Error("线程事件回执不可读或可能被截断");
      const latest = new Map();
      for (const event of events) {
        if (event?.decision?.kind === "execute") latest.set(event.decision.step_id ?? event.event_id, event);
      }
      const executed = [...latest.values()];
      receiptOk = executed.length > 0 && executed.every((event) => realExecution(event, receipt.dispatched_at, threadId));
      if (Number.isSafeInteger(final.progress_total) && final.progress_total > 0) {
        receiptOk = receiptOk && final.progress_done === final.progress_total && executed.length >= final.progress_total;
      }
      receipt.realReceipts = executed.map((event) => ({ eventId: event.event_id ?? null, stepId: event.decision?.step_id ?? null,
        type: "tool-execution",
        synced: event.receipt?.synced === true, mode: event.receipt?.mode ?? null,
        snapshot_uri: event.receipt?.snapshot_uri ? publicArtifactUrl(event.receipt.snapshot_uri) : null,
        verified_at: event.receipt?.verified_at ?? null }));
      if (executed.length === 0) {
        const answers = events.filter((event) => event?.decision?.action === "ask.answer" && event?.object?.id === threadId);
        const answer = answers.at(-1);
        readbackAnswer = answer?.decision?.after?.text;
        receiptOk = /^E-\d+$/u.test(answer?.event_id ?? "") && typeof readbackAnswer === "string" && readbackAnswer.trim().length > 0 && freshReceipt(answer?.context?.time ?? answer?.ts, receipt.dispatched_at);
        if (task.requireModel === true) receiptOk = receiptOk && answer.decision?.params?.via === "llm" && !/mock|stub|simulat/iu.test(answer.model_trace?.model_id ?? "mock");
        if (receiptOk) receipt.realReceipts = [{ type: "api-readback", eventId: answer.event_id, stepId: "ask.answer", source: `${apiUrl}/trpc/threads.events`, threadId,
          synced: true, mode: "real", via: answer.decision?.params?.via ?? null, model: answer.model_trace?.model_id ?? null,
          snapshot_uri: `${apiUrl}/trpc/threads.events`, verified_at: new Date().toISOString() }];
      }
      eventEvidence = { source: `${apiUrl}/trpc/threads.events`, threadId, events, observedAt: new Date().toISOString() };
      receipt.evidenceSha256 = createHash("sha256").update(JSON.stringify(eventEvidence.events)).digest("hex");
      if (!receiptOk) reason = "completed 线程缺少有效的真实执行回执";
    } catch {
      reason = "completed 线程的真实事件回执不可读取或核验";
    }
  }
  const asserts = [];
  const declaredAsserts = Array.isArray(task.state_asserts) ? task.state_asserts : [];
  for (const a of declaredAsserts) {
    if (a?.http && typeof a.http.url === "string") {
      const res = await fetch(a.http.url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
      const body = res ? await res.text().catch(() => "") : "";
      const ok = Boolean(res) && (a.http.status !== undefined ? res.status === a.http.status : res.ok) && (a.http.contains === undefined || body.includes(String(a.http.contains)));
      asserts.push({ type: "http", target: a.http.url, ok, detail: res ? `HTTP ${res.status}` : "不可达" });
    } else if (a?.event && typeof a.event === "object") {
      asserts.push(evaluateEventAssertion({ events, threadId, assertion: a.event }));
    } else if (a?.sql) {
      const sql = typeof a.sql === "object" ? a.sql : a;
      if (!allowDb || !db) { asserts.push({ type: "sql", ok: false, detail: "SQL 断言未获准或没有数据库连接" }); continue; }
      if (typeof sql.query !== "string" || !/^\s*SELECT\b/iu.test(sql.query) || /;\s*\S/u.test(sql.query) || (sql.params !== undefined && !Array.isArray(sql.params))) {
        asserts.push({ type: "sql", ok: false, detail: "SQL 断言必须是单条 SELECT 与参数数组" }); continue;
      }
      let q;
      try { q = await db.query(sql.query, sql.params ?? []); }
      catch { q = { rows: [], error: "数据库断言调用失败" }; }
      const value = q.rows?.[0] ? Object.values(q.rows[0])[0] : null;
      const ok = q.error ? false : compareAssert(value, sql.op ?? ">=", sql.value);
      asserts.push({ type: "sql", target: String(sql.query).slice(0, 120), ok, detail: q.error ?? `value=${value}` });
    } else asserts.push({ type: "unknown", ok: false, detail: "不支持或畸形的状态断言，未执行" });
  }
  const assertsOk = declaredAsserts.length > 0 && asserts.length === declaredAsserts.length && asserts.every((a) => a.ok === true);
  if (receipt.realReceipts.some((proof) => proof.type === "api-readback") && !asserts.some((assertion) => assertion.type === "event" && assertion.ok === true)) {
    receiptOk = false;
    reason = "ASK API 回读需至少一条具体事件结果断言，通用健康检查不能证明任务完成";
  }
  const ok = claimedDone && receiptOk && assertsOk;
  if (!assertsOk) reason = [reason, "状态断言未全部执行并通过"].filter(Boolean).join("；");
  receipt.finalStatus = final.status ?? null;
  receipt.synced = ok;
  receipt.verified_at = new Date().toISOString();
  return { ...finish({ status: ok ? "ok" : unavailable ? "blocked" : "failed", asserts, falseSuccess: claimedDone && !ok }), eventEvidence, answer: readbackAnswer };
}

function compareAssert(value, op, expected) {
  if (op === "contains") return value !== null && value !== undefined && String(value).includes(String(expected));
  if (op === "==" && value === expected) return true;
  if (value === null || value === undefined || expected === null || expected === undefined) return false;
  const num = Number(value);
  const exp = Number(expected);
  if (!Number.isFinite(num) || !Number.isFinite(exp)) return false;
  switch (op) {
    case ">=": return num >= exp;
    case ">": return num > exp;
    case "==": return num === exp;
    case "<=": return num <= exp;
    default: return false;
  }
}

/** 选出最近的 UI 截图作为多模态夹具（无则返回 null） */
export function pickMultimodalFixture(rootDir) {
  const shots = join(rootDir, "ui", "shots");
  if (!existsSync(shots)) return null;
  const files = readdirSync(shots).filter((f) => /\.png$/i.test(f)).sort();
  if (!files.length) return null;
  return join(shots, files[0]);
}

/**
 * 多模态夹具（确定性优先）：
 *   ① 已有 UI 截图 → 直接用（真实页面）；
 *   ② 否则用本仓 playwright 渲染一张带可核验字样的 HTML 截图（内容已知：LIVEFIX-7），
 *      保证「图片真的到达模型」这件事可以用答案内容验证；
 *   ③ 两者都不可用 → 返回 null（调用方必须把任务标 blocked，不得降级成纯文本任务）。
 */
export async function createMultimodalFixture({ repoRoot, outDir, expectToken = "LIVEFIX-7" } = {}) {
  const artifacts = join(outDir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const target = join(artifacts, "fixture-multimodal.png");
  try {
    const chromium = loadChromium(repoRoot);
    const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
    try {
      const context = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2, serviceWorkers: "block" });
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
        body{margin:0;height:420px;display:flex;flex-direction:column;align-items:center;justify-content:center;
             background:#0b1e3a;color:#f4f7ff;font-family:-apple-system,"PingFang SC",sans-serif}
        .t{font-size:64px;font-weight:800;letter-spacing:4px}
        .s{font-size:24px;opacity:.85;margin-top:12px}
        .chip{margin-top:26px;padding:8px 18px;border:2px solid #5eead4;border-radius:999px;color:#5eead4;font-size:20px}
      </style></head><body>
        <div class="t">WORKLOOM 验收夹具</div>
        <div class="s">内置模型多模态理解测试图</div>
        <div class="chip">${expectToken}</div>
      </body></html>`);
      await page.screenshot({ path: target });
    } finally {
      await browser.close();
    }
    return { path: target, kind: "generated", expectToken };
  } catch (err) {
    return { path: null, kind: "unavailable", reason: `playwright 渲染夹具失败：${String(err?.message ?? err).slice(0, 160)}` };
  }
}

/** 读取图片为 base64（多模态直连用） */
export function readImageFixture(path) {
  const buf = readFileSync(path);
  const mime = path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { mime, base64: buf.toString("base64"), bytes: buf.byteLength, path };
}

export { maskSecret };
