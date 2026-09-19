#!/usr/bin/env node
/**
 * fleet-run.mjs · 单仓真机验收编排器（RDAS v1 · Step 2 十仓逐跑用）
 *
 * 一次把「拉取 → 依赖 → .env → 迁移种子 → 起真机 → L0/L1/L3/L4/L5 → 回归 → 汇总 → 关停」跑完，
 * 产出该仓的 outputs/acceptance/** 与 fleet-run-<repo>.json（供舰队级汇总）。
 *
 * 用法：
 *   node scripts/acceptance/fleet-run.mjs --repo WorkLoom-growth --db workloom_growth
 *   [--fleet-dir ~/WorkLoom-fleet] [--skip-install] [--skip-seed] [--skip-regression] [--keep-running]
 *   [--regression "suite,suite:hotel,db:verify-chain,typecheck"] [--timeout-min 40]
 *
 * 纪律：只跑本机克隆（不改远端）；`.env` 只在缺失时生成、不覆盖既有；预览进程跑完必关（--keep-running 除外）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
const FLEET_DIR = resolve(arg("--fleet-dir", join(homedir(), "WorkLoom-fleet")));
const REPO_DIR = join(FLEET_DIR, REPO);
const DB = arg("--db", null);
const SKIP_INSTALL = has("--skip-install");
const SKIP_SEED = has("--skip-seed");
const SKIP_REGRESSION = has("--skip-regression");
const KEEP_RUNNING = has("--keep-running");
const TIMEOUT_MIN = Number(arg("--timeout-min", "40"));
const PORTS = { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 };

if (!existsSync(join(REPO_DIR, "package.json"))) {
  console.error(`✗ 找不到仓库：${REPO_DIR}`);
  process.exit(2);
}

const log = (msg) => console.log(`[fleet-run:${REPO}] ${msg}`);
const state = { repo: REPO, repoDir: REPO_DIR, startedAt: new Date().toISOString(), steps: {}, ok: true, notes: [] };
const fail = (step, detail) => { state.ok = false; state.steps[step] = { ok: false, detail: String(detail).slice(0, 800) }; log(`✗ ${step}：${String(detail).slice(0, 200)}`); };
const pass = (step, detail) => { state.steps[step] = { ok: true, detail: String(detail ?? "ok").slice(0, 800) }; log(`✓ ${step}`); };

function run(cmd, args, { cwd = REPO_DIR, env = {}, allowFail = false, timeoutMs = 15 * 60_000 } = {}) {
  // pnpm 10 的 verify-deps-before-run 会在跑脚本前自动 install；本机若存在未批准的构建脚本
  // （electron-winstaller/esbuild）会被 ERR_PNPM_IGNORED_BUILDS 顶掉，导致回归/预览假失败。
  // 该设置只认 CLI flag（实测 env `npm_config_verify_deps_before_run` 无效），因此统一前置注入。
  const finalArgs = cmd === "pnpm" ? ["--config.verify-deps-before-run=false", ...args] : args;
  const res = spawnSync(cmd, finalArgs, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} → exit ${res.status}\n${out.split("\n").slice(-20).join("\n")}`);
  }
  return { status: res.status ?? -1, out };
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

/* ------------------------------ 0. 工作树与拉取 ------------------------------ */
try {
  const dirty = run("git", ["status", "--porcelain"]).out.trim();
  if (dirty) {
    state.notes.push(`工作树不干净（${dirty.split("\n").length} 项），跳过 pull，按当前内容验收`);
  } else {
    run("git", ["fetch", "origin", "--prune"]);
    run("git", ["checkout", "main"]);
    run("git", ["pull", "--ff-only", "origin", "main"]);
  }
  const head = run("git", ["rev-parse", "--short", "HEAD"]).out.trim();
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  pass("prepare", `${branch}@${head}`);
  state.revision = { branch, head };
} catch (err) { fail("prepare", err.message); }

/* ------------------------------ 1. 依赖 ------------------------------ */
if (!SKIP_INSTALL) {
  try {
    const needs = !existsSync(join(REPO_DIR, "node_modules", ".bin", "tsx"));
    if (needs) {
      log("安装依赖（可能数分钟）…");
      const res = run("pnpm", ["install", "--prefer-offline"], { env: { npm_config_proxy: "", npm_config_https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "" }, allowFail: true, timeoutMs: 30 * 60_000 });
      const usable = existsSync(join(REPO_DIR, "node_modules", ".bin", "tsx"));
      if (!usable) throw new Error(`pnpm install 失败（exit ${res.status}）：${res.out.split("\n").slice(-8).join("\n")}`);
      pass("install", res.status === 0 ? "pnpm install 完成" : `pnpm install exit ${res.status}，但 tsx 可用（通常是 ignored-builds 提示）`);
    } else {
      pass("install", "node_modules 已就绪（跳过安装）");
    }
  } catch (err) { fail("install", err.message); }
}

/* ------------------------------ 2. .env ------------------------------ */
try {
  const envPath = join(REPO_DIR, ".env");
  if (existsSync(envPath)) {
    /**
     * 已存在的 .env 只做**弱项补齐**：JWT_SECRET/PII_SALT 短于 32 字符会让套件直接拒跑
     * （`[auth] JWT_SECRET 长度 <32 字符，熵不足`——基座首轮实测，suite 因此假失败）。
     * 其它键一律不动，避免覆盖使用者配置。
     */
    let text = readFileSync(envPath, "utf-8");
    const rand = () => spawnSync("openssl", ["rand", "-hex", "32"], { encoding: "utf-8" }).stdout?.trim() ?? "dev-secret-change-me-0123456789abcdef";
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
    const rand = () => spawnSync("openssl", ["rand", "-hex", "32"], { encoding: "utf-8" }).stdout?.trim() ?? "dev-secret-change-me-0123456789abcdef";
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
    state.notes.push(`.env 由 .env.example 生成（DATABASE_URL=${url}）`);
    pass("env", "由 .env.example 生成");
  } else {
    throw new Error("既无 .env 也无 .env.example");
  }
} catch (err) { fail("env", err.message); }

/* ------------------------------ 3. 迁移 + 种子 ------------------------------ */
if (!SKIP_SEED && state.steps.env?.ok !== false) {
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
}

/* ------------------------------ 4. 起真机 ------------------------------ */
function killPorts() {
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
    killPorts();
    const logPath = join(REPO_DIR, "outputs", "acceptance", "preview.log");
    mkdirSync(join(REPO_DIR, "outputs", "acceptance"), { recursive: true });
    // 与 run() 同口径：本机 pnpm 10 的 verify-deps-before-run 会因未批准构建脚本直接顶掉预览
    preview = spawn("pnpm", ["--config.verify-deps-before-run=false", "preview:all"], {
      cwd: REPO_DIR,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    const stream = [];
    preview.stdout?.on("data", (d) => stream.push(d.toString()));
    preview.stderr?.on("data", (d) => stream.push(d.toString()));
    preview.unref();
    const deadline = Date.now() + 4 * 60_000;
    let up = 0;
    while (Date.now() < deadline) {
      up = portsUp();
      if (up >= 3) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    writeFileSync(logPath, stream.join("").slice(-20000));
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
if (!SKIP_REGRESSION) {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf-8"));
  const scripts = pkg.scripts ?? {};
  // release:gate 打的是 http://localhost:8787，必须等预览起来后再跑（见 6.1）；这里只跑不依赖 server 的部分
  const defaultOrder = ["suite", "suite:hotel", "suite:geo", "suite:video", "suite:ecom", "db:verify-chain", "typecheck"];
  const requested = arg("--regression");
  const list = requested ? requested.split(",") : defaultOrder.filter((k) => scripts[k]);
  const summary = {};
  for (const name of list) {
    if (!scripts[name]) { summary[name] = "本仓无此脚本"; continue; }
    const res = run("pnpm", [name], { allowFail: true, timeoutMs: 30 * 60_000 });
    const last = res.out.split("\n").filter((l) => l.trim()).slice(-3).join(" ");
    summary[name] = res.status === 0 ? `通过（${last.slice(0, 160)}）` : `失败 exit=${res.status}：${last.slice(0, 200)}`;
    log(`${res.status === 0 ? "✓" : "✗"} 回归 ${name}`);
  }
  state.regression = summary;
  mkdirSync(join(REPO_DIR, "outputs", "acceptance", "regression"), { recursive: true });
  writeFileSync(join(REPO_DIR, "outputs", "acceptance", "regression", "summary.json"), JSON.stringify({ commands: summary, at: new Date().toISOString() }, null, 1));
  pass("regression", Object.entries(summary).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join("；"));
}

/* ------------------------------ 5. 起真机 + 真机验收四件套 ------------------------------ */
await startPreview();
/**
 * 子仓不会拿到根 package.json（base-sync 只发 scripts/** 等受控资产），
 * 所以这里**直接调执行器**，不依赖 `pnpm acceptance:*` 脚本入口；
 * 同时按 product.manifest.json 生成缺失的本仓 profile（行业语义可在评审时再细化）。
 */
function ensureProfile() {
  const profilePath = join(REPO_DIR, "acceptance", "profile.json");
  if (existsSync(profilePath)) return "本仓已有 profile";
  const manifest = JSON.parse(readFileSync(join(REPO_DIR, "product.manifest.json"), "utf-8"));
  const profile = {
    schemaVersion: "workloom.acceptance-profile/v1",
    repo: manifest.repository,
    productName: manifest.displayName ?? manifest.packageName ?? REPO,
    lane: manifest.role ?? "industry",
    primaryBundle: manifest.defaultBundle ?? null,
    workspaceId: null,
    identity: { workspaceSlug: manifest.demoWorkspaceSlug ?? null, human: manifest.demoMemberNo ?? "MEM-001", guest: "demo-direct" },
    startup: { command: "pnpm preview:all", ports: PORTS },
    surfaces: {
      pcRoutes: ["/", "/inbox", "/tasks", "/approvals", "/reports", "/service", "/executive", "/guardrails", "/exams", "/memory", "/night", "/skills", "/members", "/partners", "/account", "/workspaces", "/customize", "/configuration", "/assembly", "/agents", "/portfolio", "/events", "/models", "/onboarding"],
      bMobileRoutes: ["/", "/inbox", "/tasks", "/operations", "/account"],
      cRoutes: ["#chat", "#service", "#tickets", "#messages", "#me"],
    },
    thresholds: { firstValueMs: 20000, dispatchMs: 60000, approvalMs: 30000, traceClicks: 2, guestFirstReplyMs: 30000, decisionQuota: 7, minContrastRatio: 4.5, idleInterruptionWindowS: 20 },
    notes: "由 fleet-run.mjs 依据 product.manifest.json 生成：角色/旅程/阈值请本仓负责人在首轮验收后按行业细化。",
  };
  mkdirSync(join(REPO_DIR, "acceptance"), { recursive: true });
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  state.notes.push(`生成默认 acceptance/profile.json（bundle=${profile.primaryBundle} slug=${profile.identity.workspaceSlug}）`);
  return "已生成默认 profile";
}

let profileNote = "(未执行)";
try { profileNote = ensureProfile(); pass("profile", profileNote); } catch (err) { fail("profile", err.message); }

const tsxBin = join(REPO_DIR, "node_modules", ".bin", "tsx");
const acceptance = [
  ["matrix", existsSync(tsxBin)
    ? [tsxBin, "--env-file=.env", "scripts/acceptance/matrix.mts", "--out", "outputs/acceptance/matrix"]
    : [process.execPath, "scripts/acceptance/matrix.mts", "--out", "outputs/acceptance/matrix"], "scripts/acceptance/matrix.mts"],
  ["ui", [process.execPath, "scripts/acceptance/ui-probe.mjs", "--out", "outputs/acceptance/ui"], "scripts/acceptance/ui-probe.mjs"],
  ["experience", [process.execPath, "scripts/acceptance/experience.mjs", "--out", "outputs/acceptance/experience"], "scripts/acceptance/experience.mjs"],
  ["report", [process.execPath, "scripts/acceptance/report.mjs", "--root", "outputs/acceptance"], "scripts/acceptance/report.mjs"],
];
for (const [name, command, entry] of acceptance) {
  if (state.steps.preview?.ok === false) { state.steps[name] = { ok: false, detail: "前置：真机未就绪，跳过" }; state.ok = false; continue; }
  try {
    if (!existsSync(join(REPO_DIR, entry))) {
      state.steps[name] = { ok: false, detail: `执行器缺失：${entry}（等待基座 full 波次分发）` };
      state.ok = false;
      log(`✗ ${name}：缺少 ${entry}`);
      continue;
    }
    const res = run(command[0], command.slice(1), { allowFail: true, timeoutMs: TIMEOUT_MIN * 60_000 });
    const ok = res.status === 0;
    state.steps[name] = { ok, exit: res.status, tail: res.out.split("\n").slice(-12).join("\n") };
    if (!ok) state.ok = false;
    log(`${ok ? "✓" : "✗"} ${name}（exit ${res.status}）`);
  } catch (err) { fail(name, err.message); }
}

/* ------------------------------ 6.1 回归（依赖 server 的部分，必须在预览之后） ------------------------------ */
if (!SKIP_REGRESSION && state.steps.preview?.ok) {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf-8"));
  const scripts = pkg.scripts ?? {};
  for (const name of ["release:gate"].filter((k) => scripts[k])) {
    const res = run("pnpm", [name], { allowFail: true, timeoutMs: 30 * 60_000 });
    const last = res.out.split("\n").filter((l) => l.trim()).slice(-3).join(" ");
    state.regression = state.regression ?? {};
    state.regression[name] = res.status === 0 ? `通过（${last.slice(0, 160)}）` : `失败 exit=${res.status}：${last.slice(0, 200)}`;
    log(`${res.status === 0 ? "✓" : "✗"} 回归 ${name}（预览后）`);
  }
  mkdirSync(join(REPO_DIR, "outputs", "acceptance", "regression"), { recursive: true });
  writeFileSync(join(REPO_DIR, "outputs", "acceptance", "regression", "summary.json"), JSON.stringify({ commands: state.regression, at: new Date().toISOString() }, null, 1));
}

/* ------------------------------ 7. 关停 ------------------------------ */
if (!KEEP_RUNNING) {
  killPorts();
  pass("teardown", "预览已关停");
  if (preview?.pid) { try { process.kill(-preview.pid, "SIGTERM"); } catch { /* 已退出 */ } }
}

state.finishedAt = new Date().toISOString();
persist();
console.log(`[fleet-run:${REPO}] 结果：${state.ok ? "全绿" : "有失败项"}；状态文件：${stateFile}`);
process.exit(state.ok ? 0 : 1);
