/**
 * providers.mjs · 生产实测（P 域）真实模型适配器（RDAS v3.1 §19）
 *
 * 四个执行通道，报告里必须写明每个任务走的是哪一条（链路深度不同，证据等级不同）：
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
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskSecret } from "../target.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** DeepSeek Harness 内置适配器的默认事实（来源：@deepseek-ai/dsh-llm-deepseek README，0.1.5-rc.2） */
export const DSH_DEEPSEEK_DEFAULTS = {
  route: "deepseek-official",
  model: "deepseek-flash",
  baseURL: "https://api.deepseek.com",
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
        ? normalizeOpenAiCompatibleBaseUrl(openAiBase.value ?? DSH_DEEPSEEK_DEFAULTS.baseURL)
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
function renderLivePatch({ repoRoot, auditFile, rulesUrl, rulesFile, rulesToken, model, provider = "deepseek-official" }) {
  const fenceConfig = rulesFile
    ? [`        rulesFile: '${rulesFile}'`]
    : [`        rulesUrl: '${rulesUrl}'`, ...(rulesToken ? [`        rulesToken: '${rulesToken}'`] : [])];
  return [
    "# RDAS v3.1 · 生产实测 dsh patch（真实 provider；mock 仅供 selftest）",
    "- name: '@deepseek-ai/dsh-llm-deepseek'",
    "  config:",
    `    apiKeyEnv: ${DSH_DEEPSEEK_DEFAULTS.apiKeyEnv}`,
    `    baseURL: ${DSH_DEEPSEEK_DEFAULTS.baseURL}`,
    "    reasoningEffort: high",
    "- id: agent-default-model",
    "  config:",
    `    provider: ${provider}`,
    `    model: ${model}`,
    "- insert:",
    "    - id: workloom-fence",
    `      name: '${join(repoRoot, "packages", "runtime", "plugins", "workloom-fence.plugin.js")}'`,
    "      config:",
    ...fenceConfig,
    "    - id: workloom-audit",
    `      name: '${join(repoRoot, "packages", "runtime", "plugins", "workloom-audit.plugin.js")}'`,
    "      config:",
    `        file: '${auditFile}'`,
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
}) {
  const { gate, bin, patchTemplate } = dshPaths(repoRoot);
  if (!existsSync(bin)) {
    return { status: "blocked", reason: `dsh 可执行文件缺失：${bin}（先跑 packages/runtime/dsh-gate 的 pnpm install）` };
  }
  if (!existsSync(patchTemplate)) {
    return { status: "blocked", reason: `dsh patch 模板缺失：${patchTemplate}` };
  }
  const dshHome = home ?? join(workDir, "dsh-home");
  mkdirSync(join(dshHome, "profiles", "headless"), { recursive: true });
  const auditFile = join(workDir, `dsh-audit-${Date.now()}.jsonl`);

  // ① 初始化 headless profile（幂等：已存在 package.json 即跳过）
  const profilePkg = join(dshHome, "profiles", "headless", "package.json");
  if (!existsSync(profilePkg)) {
    await runProcess(bin, ["--profile", "headless", "--dump-config"], {
      cwd: gate,
      env: { ...process.env, ...env, DSH_HOME: dshHome },
      timeoutMs: 120_000,
    });
  }
  if (!existsSync(profilePkg)) {
    return { status: "blocked", reason: `dsh headless profile 初始化失败（${profilePkg} 未生成）` };
  }

  // ② patch：真实 provider + 围栏瀑布（打真实 fence.activeRules）+ 哈希链账本
  writeFileSync(join(dshHome, "profiles", "headless", "cordis.patch.yml"), renderLivePatch({
    repoRoot, auditFile,
    rulesUrl: rulesUrl ?? "http://127.0.0.1:8787/trpc/fence.activeRules",
    rulesFile, rulesToken,
    model,
  }));
  // ③ settings.yaml 留空 providers 段（凭据经 apiKeyEnv 由 dsh credential seam 解析，不落盘）
  writeFileSync(join(dshHome, "settings.yaml"), "# RDAS v3.1 生产实测：provider 走 cordis patch + apiKeyEnv，不在文件里落任何密钥\nllm-pi-ai:\n  providers: {}\n");

  const started = Date.now();
  const task = imagePath
    ? `${prompt}\n\n【验收夹具】本地图片路径：${imagePath}\n请用你的文件读取能力打开该图片，再回答上面的问题。`
    : prompt;
  const res = await runProcess(bin, ["--profile", "headless", task], {
    cwd: gate,
    env: { ...process.env, ...env, DSH_HOME: dshHome, DSH_LIVE_RUN: "1" },
    timeoutMs,
  });
  const ms = Date.now() - started;
  const out = `${res.stdout}${res.stderr}`;
  const fenceHits = (out.match(/\[workloom-fence\] judge tool=[^\n]*/g) ?? []).map((l) => l.trim());
  const auditLines = existsSync(auditFile)
    ? readFileSync(auditFile, "utf-8").split("\n").filter((l) => l.trim()).length
    : 0;
  const answer = extractDshAnswer(out);
  const ok = res.code === 0 && Boolean(answer);
  // 账本链验证（与 E6 门禁同一验证器）：链断 = 生产链路证据无效，必须在任务结果里暴露
  let chain = null;
  if (auditLines > 0) {
    const verify = await runProcess(process.execPath, [join(gate, "verify-audit.mjs"), auditFile], {
      cwd: gate, env: {}, timeoutMs: 60_000,
    });
    chain = { ok: verify.code === 0, detail: `${verify.stdout}${verify.stderr}`.trim().slice(-400) };
  }
  return {
    status: ok ? "ok" : "failed",
    answer,
    exitCode: res.code,
    ms,
    model,
    audit: { file: auditFile, lines: auditLines, chain },
    fenceHits,
    evidence: { transcript: out.slice(-8000), command: `${bin} --profile headless <task>` },
    receipt: {
      kind: "dsh-harness",
      model,
      auditLines,
      auditChainOk: chain?.ok ?? null,
      fenceJudgements: fenceHits.length,
      synced: auditLines > 0 && chain?.ok === true,
      verified_at: new Date().toISOString(),
    },
    raw: out.slice(-2000),
  };
}

/** dsh headless 的最终答案形态：以 TASK_COMPLETE 标记或最后一段自然语言为答案 */
function extractDshAnswer(out) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => !l.startsWith("[") && !l.startsWith("▸") && !l.startsWith("✅") && !l.startsWith("❌"));
  const completeAt = lines.findIndex((l) => l.includes("TASK_COMPLETE"));
  if (completeAt >= 0) {
    // 最终答案可能跨多行（结论 + 依据 + TASK_COMPLETE 结尾）：回溯取到上一个段落边界
    const tail = lines.slice(Math.max(0, completeAt - 4), completeAt + 1).join("\n");
    return tail.slice(-800);
  }
  const tail = lines.slice(-5).join("\n");
  return tail.length > 8 ? tail.slice(-800) : null;
}

function runProcess(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: killed ? -9 : (code ?? -1), stdout, stderr }); });
  });
}

/* ------------------------------------------------------------------ */
/* 通道二：model-gateway（OpenAI 兼容网关，文本 + 多模态理解）              */
/* ------------------------------------------------------------------ */

export async function runChatTask({ resolved, prompt, timeoutMs = 180_000, env = process.env, image = null }) {
  if (!resolved.ready) return { status: "blocked", reason: resolved.missing.join("；") };
  const apiKey = pickEnv([resolved.credentialEnv, DSH_DEEPSEEK_DEFAULTS.apiKeyEnv, "LLM_API_KEY"], env).value;
  /** 兜底再归一一次：即使 profile 直接把 Anthropic 根声明给 model-gateway，也不至于打出 /anthropic/chat/completions（404） */
  const base = normalizeOpenAiCompatibleBaseUrl(resolved.baseUrl);
  const url = `${base}/chat/completions`;
  const content = image
    ? [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } },
    ]
    : prompt;
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: resolved.model, messages: [{ role: "user", content }], temperature: 0.2, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: "failed", reason: `模型调用失败：${String(err?.message ?? err).slice(0, 200)}`, ms: Date.now() - started };
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 错误体 */ }
  if (!res.ok) {
    return { status: "failed", reason: `HTTP ${res.status}：${text.slice(0, 300)}`, ms: Date.now() - started, model: resolved.model };
  }
  const answer = json?.choices?.[0]?.message?.content ?? "";
  const usage = json?.usage ?? {};
  return {
    status: answer ? "ok" : "failed",
    answer,
    ms: Date.now() - started,
    model: json?.model ?? resolved.model,
    tokens: Number(usage.total_tokens ?? 0) || (Number(usage.prompt_tokens ?? 0) + Number(usage.completion_tokens ?? 0)),
    receipt: {
      kind: "model-gateway",
      endpoint: url,
      model: json?.model ?? resolved.model,
      id: json?.id ?? null,
      tokens: usage.total_tokens ?? null,
      synced: true,
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
  if (!resolved.ready) return { status: "blocked", reason: resolved.missing.join("；") };
  const apiKey = pickEnv([resolved.credentialEnv, "SEEDREAM_API_KEY", "VOLCENGINE_ARK_API_KEY", "ARK_API_KEY"], env).value;
  const base = String(resolved.baseUrl).replace(/\/$/, "");
  const count = Number(task.images ?? 1);
  const started = Date.now();
  const groupable = count > 1 && supportsSequentialImageGeneration(resolved.model);
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
      return { error: `生图调用失败：${String(err?.message ?? err).slice(0, 200)}` };
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok) return { error: `HTTP ${res.status}：${text.slice(0, 300)}` };
    const urls = (json?.data ?? []).map((d) => d?.url).filter(Boolean);
    if (!urls.length) return { error: `生图未返回图片 URL：${text.slice(0, 200)}` };
    return { urls, json };
  }

  const rounds = groupable ? 1 : Math.max(1, count);
  const urls = [];
  let lastJson = null;
  for (let round = 0; round < rounds; round += 1) {
    const r = await callOnce(groupable);
    if (r.error) {
      // 逐张调用中途失败：保留已落盘产物作证据，状态如实 failed（不伪造数量）
      return { status: "failed", reason: r.error, ms: Date.now() - started, model: resolved.model, urls, calls: round + 1 };
    }
    urls.push(...r.urls);
    lastJson = r.json;
    if (!groupable && urls.length >= count) break;
  }
  const saved = [];
  for (const [i, url] of urls.entries()) {
    const savedPath = await downloadArtifact(url, artifactsDir, `${task.id}-${i + 1}.png`);
    saved.push({ url, path: savedPath, bytes: savedPath ? readFileSync(savedPath).byteLength : null });
  }
  return {
    status: "ok",
    ms: Date.now() - started,
    model: resolved.model,
    artifacts: saved,
    receipt: {
      kind: "gen-http.image",
      model: resolved.model,
      endpoint: `${base}/images/generations`,
      created: lastJson?.created ?? null,
      urls,
      calls: rounds,
      requested: count,
      produced: urls.length,
      synced: urls.length > 0,
      verified_at: new Date().toISOString(),
    },
  };
}

/** 生视频（异步任务制）：POST {base}/contents/generations/tasks → GET …/tasks/{id} */
export async function runVideoTask({ resolved, task, timeoutMs = 20 * 60_000, env = process.env, artifactsDir, pollMs = 8000 }) {
  if (!resolved.ready) return { status: "blocked", reason: resolved.missing.join("；") };
  const apiKey = pickEnv([resolved.credentialEnv, "SEEDANCE_API_KEY", "VOLCENGINE_ARK_API_KEY", "ARK_API_KEY"], env).value;
  const base = String(resolved.baseUrl).replace(/\/$/, "");
  const duration = Number(task.durationSeconds ?? 12);
  const started = Date.now();
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
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    return { status: "failed", reason: `视频提交失败：${String(err?.message ?? err).slice(0, 200)}`, ms: Date.now() - started };
  }
  const submitText = await submit.text().catch(() => "");
  let submitJson = null;
  try { submitJson = JSON.parse(submitText); } catch { /* 非 JSON */ }
  if (!submit.ok) return { status: "failed", reason: `提交 HTTP ${submit.status}：${submitText.slice(0, 300)}`, ms: Date.now() - started, model: resolved.model };
  const taskId = submitJson?.id ?? submitJson?.data?.id ?? null;
  if (!taskId) return { status: "failed", reason: `未返回 task_id：${submitText.slice(0, 200)}`, ms: Date.now() - started, model: resolved.model };

  let last = null;
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const r = await fetch(`${base}/contents/generations/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(60_000),
    }).catch((err) => ({ ok: false, status: 0, text: async () => String(err?.message ?? err) }));
    const text = await r.text().catch(() => "");
    try { last = JSON.parse(text); } catch { last = { raw: text.slice(0, 200) }; }
    const status = last?.status ?? last?.data?.status;
    if (status === "succeeded" || status === "success") {
      const url = last?.content?.video_url ?? last?.data?.content?.video_url ?? last?.data?.video_url ?? null;
      const durationSeconds = Number(last?.duration ?? last?.data?.duration ?? duration);
      const savedPath = url ? await downloadArtifact(url, artifactsDir, `${task.id}.mp4`) : null;
      return {
        status: url ? "ok" : "failed",
        reason: url ? undefined : "任务成功但未返回 video_url",
        ms: Date.now() - started,
        model: resolved.model,
        taskId,
        artifacts: [{ url, path: savedPath, bytes: savedPath ? readFileSync(savedPath).byteLength : null, durationSeconds }],
        receipt: {
          kind: "gen-http.video",
          model: resolved.model,
          endpoint: `${base}/contents/generations/tasks`,
          taskId,
          videoUrl: url,
          durationSeconds,
          synced: Boolean(url),
          verified_at: new Date().toISOString(),
        },
      };
    }
    if (status === "failed" || status === "cancelled") {
      return { status: "failed", reason: `生成任务失败：${JSON.stringify(last).slice(0, 300)}`, ms: Date.now() - started, model: resolved.model, taskId };
    }
  }
  return { status: "failed", reason: `轮询超时（${Math.round(timeoutMs / 1000)}s），最后状态：${JSON.stringify(last).slice(0, 200)}`, ms: Date.now() - started, model: resolved.model, taskId };
}

async function downloadArtifact(url, dir, name) {
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf);
    return path;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 通道四：product-dispatch（经被测产品入口派单 + 状态断言）                */
/* ------------------------------------------------------------------ */

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
 * 派单 + 轮询 + 状态断言。
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
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const dispatch = await fetch(`${apiUrl}/trpc/threads.dispatch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: task.input ?? task.title, ...(task.presetKey ? { presetKey: task.presetKey } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  const dispatchJson = await dispatch.json().catch(() => ({}));
  const d = dispatchJson?.result?.data ?? {};
  const threadId = d.threadId ?? null;
  const started = Date.now();
  let final = { status: null, calls: [] };
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const r = await fetch(`${apiUrl}/trpc/threads.get?input=${encodeURIComponent(JSON.stringify({ id: threadId }))}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!r) continue;
    const j = await r.json().catch(() => ({}));
    final = j?.result?.data ?? final;
    if (["completed", "failed", "paused"].includes(final?.status)) break;
  }
  const asserts = [];
  for (const a of task.state_asserts ?? []) {
    if (a.http) {
      const res = await fetch(a.http.url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
      const body = res ? await res.text().catch(() => "") : "";
      const ok = Boolean(res) && (a.http.status ? res.status === a.http.status : res.ok) && (!a.http.contains || body.includes(a.http.contains));
      asserts.push({ type: "http", target: a.http.url, ok, detail: res ? `HTTP ${res.status}` : "不可达" });
    } else if (a.sql && allowDb && db) {
      const q = await db.query(a.query, a.params ?? []).catch((err) => ({ rows: [], error: String(err.message) }));
      const value = q.rows?.[0] ? Object.values(q.rows[0])[0] : null;
      const ok = q.error ? false : compareAssert(value, a.op ?? ">=", a.value);
      asserts.push({ type: "sql", target: String(a.query).slice(0, 120), ok, detail: `value=${value}${q.error ? ` error=${q.error}` : ""}` });
    }
  }
  const claimedDone = final?.status === "completed";
  const assertsOk = asserts.length ? asserts.every((a) => a.ok) : null;
  const falseSuccess = claimedDone && assertsOk === false;
  return {
    status: falseSuccess ? "failed" : assertsOk === false ? "failed" : claimedDone || asserts.length ? "ok" : "failed",
    kind: d.kind ?? "unknown",
    threadId,
    finalStatus: final?.status ?? null,
    asserts,
    falseSuccess,
    ms: Date.now() - started,
    receipt: {
      kind: "product-dispatch",
      threadId,
      finalStatus: final?.status ?? null,
      responseKind: d.kind ?? null,
      synced: Boolean(threadId) && final?.status === "completed",
      verified_at: new Date().toISOString(),
    },
  };
}

function compareAssert(value, op, expected) {
  const num = Number(value);
  const exp = Number(expected);
  switch (op) {
    case ">=": return num >= exp;
    case ">": return num > exp;
    case "==": return value === expected || num === exp;
    case "<=": return num <= exp;
    case "contains": return String(value).includes(String(expected));
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
  const existing = pickMultimodalFixture(join(repoRoot, "outputs", "acceptance"));
  if (existing) return { path: existing, kind: "ui-shot", expectToken: null };
  const artifacts = join(outDir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const target = join(artifacts, "fixture-multimodal.png");
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2 });
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
      await browser.close().catch(() => {});
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
