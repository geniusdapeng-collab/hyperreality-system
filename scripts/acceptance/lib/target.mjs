/**
 * target.mjs · 验收环境档位解析与目标指纹（RDAS v3.1 §19）
 *
 * 为什么需要它（2026-09-20 实测缺口）：
 *  RDAS v1–v3.0 的「真机」= 本机预览（`pnpm preview:all` + 本地演示库 + LLM_PROVIDER=mock），
 *  它证明的是**代码与装配**，既不是生产环境，也不会触发客户端内置模型。
 *  v3.1 把环境拆成三档，验收器必须显式声明自己在验哪一档，禁止用本机预览冒充生产验收：
 *
 *   - `local-preview`  开发预览：本机三端 + 本地库 + 允许种子复位/夹具写入；
 *   - `client-runtime` 真实客户端：已安装的桌面客户端运行时（自包含 PG/NATS + 客户端内置模型配置）；
 *   - `deployed`       生产部署：客户可访问的正式地址 + 正式库（只读优先，写入必须显式授权）。
 *
 * 纪律：生产档位默认**只读**；任何写操作必须先拿到 `--allow-prod-writes`（或不变量级的
 * `environment.allowWrites: true`），且写入必须带夹具标记并披露残留。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ENVIRONMENT_KINDS = ["local-preview", "client-runtime", "deployed"];

export const DEFAULT_ENVIRONMENT = {
  kind: "local-preview",
  allowWrites: false,
  /** client-runtime：桌面客户端支持目录（缺省按产品名推导，见 clientSupportDirCandidates） */
  supportDir: null,
  /** deployed / client-runtime：显式地址；缺省时按 profile.startup.ports 推导本机地址 */
  target: {},
  timeouts: { healthMs: 8000, probeMs: 20000 },
};

/** 秘密值一律不进日志/报告：只保留前 4 位与长度 */
export function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= 4) return "****";
  return `${text.slice(0, 4)}…（len=${text.length}）`;
}

/** 读取 .env（不写入 process.env；只做只读指纹与凭据可用性判断） */
export function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/** 客户端支持目录候选（桌面自包含安装的落点；macOS/Windows/Linux） */
export function clientSupportDirCandidates({ productName, home = process.env.HOME } = {}) {
  const names = [productName, "WorkLoom 织元"].filter(Boolean);
  const out = [];
  for (const name of names) {
    out.push(join(home, "Library", "Application Support", name));
    out.push(join(home, ".config", name));
    out.push(join(home, "AppData", "Roaming", name));
  }
  return out;
}

function urlsFromPorts(ports) {
  return {
    pc: `http://localhost:${ports.pc}`,
    bMobile: `http://localhost:${ports.bMobile}`,
    cMobile: `http://localhost:${ports.cMobile}`,
    api: `http://127.0.0.1:${ports.server}`,
  };
}

/**
 * 解析本次验收的环境档位。
 * 环境只允许一个事实值；CLI、父执行器和显式 profile 相互冲突时拒绝运行。
 */
export function resolveEnvironment(profile, { flag = null, allowProdWrites = false } = {}) {
  const declared = profile?.environment ?? DEFAULT_ENVIRONMENT;
  const inherited = process.env.ACCEPTANCE_ENV_KIND || null;
  const explicitProfileKind = profile?.environmentKindDeclared === false ? null : profile?.environment?.kind ?? null;
  const declarations = [flag, inherited, explicitProfileKind].filter((value) => value !== null && value !== undefined);
  if (new Set(declarations).size > 1) throw new Error("环境档位冲突：CLI / 父执行器 / profile 必须一致");
  const kind = declarations[0] ?? DEFAULT_ENVIRONMENT.kind;
  if (!ENVIRONMENT_KINDS.includes(kind)) {
    throw new Error(`未知环境档位：${kind}（可选 ${ENVIRONMENT_KINDS.join(" | ")}）`);
  }
  const ports = profile?.startup?.ports ?? { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 };
  const target = declared.target ?? {};
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("environment.target 必须是 URL 对象");
  if (kind === "deployed" && !target.apiUrl) throw new Error("deployed 目标未声明：必须显式配置 environment.target.apiUrl");
  const checkedUrl = (key, fallback) => {
    const value = target[key];
    if (value === undefined || value === null) return fallback;
    try {
      if (typeof value !== "string" || value.trim() !== value || !value) throw new Error();
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      return value.replace(/\/$/, "");
    } catch { throw new Error(`environment.target.${key} 必须是无凭据、无查询参数的 HTTP(S) URL`); }
  };
  const localUrls = urlsFromPorts(ports);
  const isLocal = kind === "local-preview";
  /**
   * 档位默认地址：
   *   - local-preview：三端 3000/3001/3002 + server 8787（scripts/preview-all.sh 口径）；
   *   - client-runtime：真实客户端由启动器拉起 server 8787 + web 5173（bootstrap.cjs 的
   *     WORKLOOM_SERVER_PORT / WORKLOOM_WEB_PORT 缺省值），B/C 端点由客户端自持，不假设端口；
   *   - deployed：必须显式声明 target，否则判为“目标未声明”（不得默认打本机）。
   */
  const clientDefaults = { pc: "http://localhost:5173", bMobile: null, cMobile: null, api: "http://127.0.0.1:8787" };
  const kindDefaults = isLocal ? localUrls : kind === "client-runtime" ? clientDefaults : { pc: null, bMobile: null, cMobile: null, api: null };
  const urls = {
    pc: checkedUrl("pcUrl", kindDefaults.pc),
    bMobile: checkedUrl("bMobileUrl", kindDefaults.bMobile),
    cMobile: checkedUrl("cMobileUrl", kindDefaults.cMobile),
    api: checkedUrl("apiUrl", kindDefaults.api),
  };
  const supportDir = declared.supportDir
    ?? (kind === "client-runtime"
      ? clientSupportDirCandidates({ productName: profile?.productName })
        .find((dir) => existsSync(join(dir, "runtime", "VERSION"))) ?? clientSupportDirCandidates({ productName: profile?.productName })[0]
      : null);
  const declaredTarget = Boolean(target.apiUrl || target.pcUrl || target.bMobileUrl || target.cMobileUrl);
  return {
    kind,
    isProduction: !isLocal,
    isLocal,
    urls,
    /** 生产部署档位缺显式地址时判为“目标未声明”；客户端档位按启动器缺省端口推导 */
    declaredTarget: kind === "client-runtime" ? true : declaredTarget,
    targetDeclaredExplicitly: declaredTarget,
    supportDir,
    allowWrites: Boolean(allowProdWrites || declared.allowWrites || process.env.ACCEPTANCE_ALLOW_PROD_WRITES === "1"),
    timeouts: { ...DEFAULT_ENVIRONMENT.timeouts, ...(declared.timeouts ?? {}) },
    /** 生产档位禁止的步骤：装依赖、迁移/种子复位、起本机预览、写演示夹具 */
    gateLocalSteps: isLocal,
  };
}

async function probe(url, { timeoutMs, expect = "any" } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 健康页（HTML 预览）按文本判定 */ }
    const ok = res.ok && (expect !== "json" || Boolean(json));
    return { url, status: res.status, ok, ms: Date.now() - started, sample: text.slice(0, 160), json };
  } catch (err) {
    return { url, status: 0, ok: false, ms: Date.now() - started, error: String(err?.message ?? err).slice(0, 200) };
  }
}

/** 目标可达性与身份探测：/health（server）+ 三端首页可加载 */
export async function probeEnvironment({ env, timeoutMs = 8000 } = {}) {
  const checks = [];
  if (env.urls.api) {
    const apiHealth = await probe(`${env.urls.api}/health`, { timeoutMs, expect: "json" });
    checks.push({ name: "server.health", ...apiHealth });
  } else {
    checks.push({ name: "server.health", ok: false, detail: "未声明 apiUrl（生产部署档位必须显式声明）" });
  }
  const payloadRoot = env.supportDir && existsSync(join(env.supportDir, "runtime")) ? env.supportDir : null;
  if (payloadRoot) {
    const versionFile = join(payloadRoot, "runtime", "VERSION");
    checks.push({ name: "client.payload", ok: existsSync(versionFile), detail: versionFile, version: existsSync(versionFile) ? readFileSync(versionFile, "utf-8").trim() : null });
  }
  for (const [name, url] of Object.entries({ pc: env.urls.pc, bMobile: env.urls.bMobile, cMobile: env.urls.cMobile })) {
    if (!url) continue;
    const r = await probe(url, { timeoutMs });
    checks.push({ name: `surface.${name}`, ...r });
  }
  return { ok: checks.filter((c) => c.name.startsWith("server.") || c.name.startsWith("surface.")).every((c) => c.ok), checks };
}

const readJsonSafe = (path) => {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
};

/**
 * 环境与资产指纹（报告硬性字段；缺一报告无效）。
 * 只输出可核验、无秘密的字段；凭据只输出“是否配置 + 掩码”。
 */
export function fingerprintEnvironment({ repoRoot, env, profile, git = null }) {
  const envFile = loadEnvFile(join(repoRoot, ".env"));
  const clientEnv = env.supportDir ? loadEnvFile(join(env.supportDir, "runtime", ".env")) : {};
  const dshPkg = readJsonSafe(join(repoRoot, "packages", "runtime", "dsh-gate", "package.json"));
  const runtimeVersion = env.supportDir && existsSync(join(env.supportDir, "runtime", "VERSION"))
    ? readFileSync(join(env.supportDir, "runtime", "VERSION"), "utf-8").trim()
    : null;
  const installState = env.supportDir ? readJsonSafe(join(env.supportDir, "install-state.json")) : null;
  const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? ""]));
  const provider = {
    repo: pick(envFile, ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL"]),
    repoApiKeySet: Boolean(envFile.LLM_API_KEY),
    client: pick(clientEnv, ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL"]),
    clientApiKeySet: Boolean(clientEnv.LLM_API_KEY),
    productionKeySet: Boolean(process.env.VOLCENGINE_ARK_API_KEY),
  };
  return {
    at: new Date().toISOString(),
    environmentKind: env.kind,
    isProduction: env.isProduction,
    allowWrites: env.allowWrites,
    urls: env.urls,
    supportDir: env.supportDir,
    clientRuntimeVersion: runtimeVersion,
    clientInstallState: installState ? { status: installState.status, phase: installState.phase, updatedAt: installState.updatedAt } : null,
    repo: {
      commit: git?.commit ?? null,
      branch: git?.branch ?? null,
      dirty: git?.dirty ?? null,
      node: process.version,
      profile: profile?.schemaVersion ?? null,
      dataMode: profile?.dataMode ?? null,
    },
    dsh: { package: dshPkg?.name ?? null, version: dshPkg?.dependencies?.["@deepseek-ai/dsh"] ?? null },
    provider,
  };
}

/** 指纹转 Markdown（报告用） */
export function fingerprintLines(fp) {
  const lines = [];
  lines.push(`environment=${fp.environmentKind} production=${fp.isProduction} allowWrites=${fp.allowWrites}`);
  lines.push(`urls=${JSON.stringify(fp.urls)}`);
  lines.push(`clientRuntime=${fp.clientRuntimeVersion ?? "未接入"} installState=${fp.clientInstallState ? `${fp.clientInstallState.status}/${fp.clientInstallState.phase}` : "n/a"}`);
  lines.push(`repo=${fp.repo.commit ?? "?"}@${fp.repo.branch ?? "?"} dirty=${fp.repo.dirty ?? "?"} node=${fp.repo.node} dataMode=${fp.repo.dataMode ?? "?"}`);
  lines.push(`dsh=${fp.dsh.package ?? "?"}@${fp.dsh.version ?? "?"}`);
  lines.push(`provider.repo=${fp.provider.repo.LLM_PROVIDER || "(未声明)"} base=${fp.provider.repo.LLM_BASE_URL || "(未声明)"} model=${fp.provider.repo.LLM_MODEL || "(未声明)"} key=${fp.provider.repoApiKeySet ? "已配置" : "缺失"}`);
  lines.push(`provider.client=${fp.provider.client.LLM_PROVIDER || "(未声明)"} model=${fp.provider.client.LLM_MODEL || "(未声明)"} key=${fp.provider.clientApiKeySet ? "已配置" : "缺失"}`);
  lines.push(`provider.ark=${fp.provider.productionKeySet ? "已配置（VOLCENGINE_ARK_API_KEY）" : "缺失"}`);
  return lines;
}
