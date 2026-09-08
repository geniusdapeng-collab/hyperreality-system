/**
 * WorkLoom 桌面客户端 · 首启引导（bootstrap）
 *
 * 职责（与 D16 启动器同口径的 JS 移植版，Mac/Windows 统一）：
 *   ① 载荷装配：resourcesDir(payload) → supportDir（版本变化才覆盖，并重置 .bootstrapped）
 *   ② PostgreSQL：initdb（首启）→ pg_ctl 起服 → 角色/建库/vector（desktop-bootstrap-db.mjs）
 *   ③ NATS JetStream：内嵌 nats-server 用户态拉起（缺失降级 memory，不阻断）
 *   ④ 配置：.env.defaults → .env（首启），JWT_SECRET 随机化
 *   ⑤ 引导：migrate + seed-aipm（幂等，.bootstrapped 哨兵）
 *   ⑥ 服务：server(8787) + web preview(5173)，健康检查 90s
 *
 * 本文件不依赖 electron——CI 冒烟直接以 Node 运行：
 *   node apps/desktop/electron/bootstrap.cjs --smoke --resources <payload目录> --support <可写目录>
 * 桌面端由 main.cjs require 并传入 app 路径。
 *
 * 载荷目录约定（scripts/pack-electron-payload.sh 产出，两平台同构）：
 *   payload/runtime/  产品载荷（源码+迁移+种子+扁平 node_modules+web dist+VERSION）
 *   payload/node/     Node 24 官方二进制（bin/node 或 node.exe）
 *   payload/pg/       PostgreSQL 17 + pgvector（bin/lib/share 同构；mac 从 Postgres.app 摊平）
 *   payload/nats/     nats-server（可选）
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const IS_WIN = process.platform === "win32";
const SERVER_PORT = Number(process.env.WORKLOOM_SERVER_PORT || 8787);
const WEB_PORT = Number(process.env.WORKLOOM_WEB_PORT || 5173);
const PG_PORT = Number(process.env.WORKLOOM_PG_PORT || 5432);
const NATS_PORT = 4222;

/* ---------------- 日志 ---------------- */
function makeLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const stream = fs.createWriteStream(path.join(logDir, `launch-${Date.now()}.log`), { flags: "a" });
  return (msg) => {
    const line = `${new Date().toTimeString().slice(0, 8)} ${msg}`;
    stream.write(line + "\n");
    console.log(line);
  };
}

/* ---------------- 进程工具 ---------------- */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { code: r.status ?? -1, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

function spawnLogged(cmd, args, opts, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a");
  const child = spawn(cmd, args, { stdio: ["ignore", fd, fd], ...opts });
  child.on("error", () => {});
  return child;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(child.pid, "SIGTERM");
  } catch { /* 已退出 */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpOk(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

/* ---------------- 主流程 ---------------- */
/**
 * @param {object} opts
 * @param {string} opts.resourcesDir  载荷根目录（含 runtime/node/pg/nats）
 * @param {string} opts.supportDir    可写支持目录（userData）
 * @param {(msg:string)=>void} [opts.onStatus] 状态回调（splash 展示）
 * @param {boolean} [opts.smoke]      冒烟模式：健康检查通过即返回（调用方随后 stop）
 * @returns {Promise<{stop:()=>Promise<void>, webUrl:string}>}
 */
async function bootstrap(opts) {
  const { resourcesDir, supportDir } = opts;
  const onStatus = opts.onStatus || (() => {});
  const logDir = path.join(supportDir, "logs");
  const say = makeLogger(logDir);
  const status = (m) => { say(m); onStatus(m); };

  const RUNTIME = path.join(supportDir, "runtime");
  const PGDATA = path.join(supportDir, "pgdata");
  const NODEEXE = path.join(supportDir, "node", IS_WIN ? "node.exe" : "bin", IS_WIN ? "" : "node");
  const NODE_BIN = IS_WIN ? path.join(supportDir, "node", "node.exe") : path.join(supportDir, "node", "bin", "node");
  const PGBIN = path.join(supportDir, "pg", "bin");
  const pgBin = (n) => path.join(PGBIN, IS_WIN ? `${n}.exe` : n);

  say(`== WorkLoom 织元 · 引导启动（resources=${resourcesDir}）==`);

  /* ---------- 0. 载荷装配（版本变化才覆盖） ---------- */
  const readIf = (p) => { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return null; } };
  const payloadVer = readIf(path.join(resourcesDir, "runtime", "VERSION")) || "unknown";
  const installedVer = readIf(path.join(supportDir, "VERSION")) || "none";
  if (payloadVer !== installedVer) {
    status(`→ 装配运行时载荷（${payloadVer}）…（首次约 1 分钟）`);
    fs.mkdirSync(supportDir, { recursive: true });
    for (const part of ["runtime", "node", "pg", "nats"]) {
      const src = path.join(resourcesDir, part);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(supportDir, part);
      fs.rmSync(dst, { recursive: true, force: true });
      // dereference:true —— 摊平符号链接，Windows/macOS 通吃
      fs.cpSync(src, dst, { recursive: true, dereference: true });
    }
    if (!IS_WIN) {
      // zip/dmg 往返后确保可执行位
      for (const p of [NODE_BIN, pgBin("postgres"), pgBin("pg_ctl"), pgBin("initdb")]) {
        try { fs.chmodSync(p, 0o755); } catch { /* 忽略 */ }
      }
    }
    fs.writeFileSync(path.join(supportDir, "VERSION"), payloadVer);
    fs.rmSync(path.join(supportDir, ".bootstrapped"), { force: true });
    status("✅ 载荷装配完成");
  }

  const TSX_CLI = fs.existsSync(path.join(RUNTIME, "node_modules", "tsx", "dist", "cli.mjs"))
    ? path.join(RUNTIME, "node_modules", "tsx", "dist", "cli.mjs")
    : path.join(RUNTIME, "node_modules", ".bin", "tsx");
  const VITE_JS = path.join(RUNTIME, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(NODE_BIN)) throw new Error(`载荷不完整：Node 运行时缺失（${NODE_BIN}）`);
  if (!fs.existsSync(TSX_CLI)) throw new Error("载荷不完整：tsx 缺失");

  /* ---------- 1. PostgreSQL ---------- */
  const pgCtlArgs = (a) => ["-D", PGDATA, ...a];
  const pgUp = () => {
    if (fs.existsSync(pgBin("pg_isready"))) {
      return run(pgBin("pg_isready"), ["-h", "127.0.0.1", "-p", String(PG_PORT), "-d", "workloom"]).code === 0;
    }
    return run(pgBin("pg_ctl"), ["status", "-D", PGDATA]).code === 0; // zonky 三件套无 pg_isready（v2.0.12 实证）
  };

  if (pgUp()) {
    say("✓ PostgreSQL 已在运行（复用）");
  } else {
    if (!fs.existsSync(path.join(PGDATA, "PG_VERSION"))) {
      status("→ 初始化数据库（initdb）…");
      fs.mkdirSync(PGDATA, { recursive: true });
      // 超级用户固定 postgres：desktop-bootstrap-db.mjs 以 postgres 角色连接建库（两平台同口径）
      const r = run(pgBin("initdb"), ["-D", PGDATA, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"]);
      if (r.code !== 0) throw new Error(`initdb 失败：${r.err.slice(-300)}`);
    }
    status("→ 启动 PostgreSQL 17 …");
    // pg_ctl 起服（Windows 上由它对管理员会话降权，v2.0.9 实证不能用 postgres.exe 直起）
    const r = run(pgBin("pg_ctl"), pgCtlArgs(["-l", path.join(logDir, "pg.log"), "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1`, "-w", "-t", "60", "start"]));
    if (r.code !== 0) throw new Error(`PostgreSQL 启动失败（详见 logs/pg.log）：${r.err.slice(-300)}`);
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { up = pgUp(); if (!up) await sleep(1000); }
    if (!up) throw new Error("PostgreSQL 40s 内未就绪");
  }
  say("✓ PostgreSQL 就绪");

  // 角色/建库/vector（Node 引导，幂等；Windows 内嵌 PG 无 psql，v2.0.12 实证）
  {
    status("→ 数据库引导（角色/库/vector）…");
    const r = run(NODE_BIN, [path.join(RUNTIME, "scripts", "desktop-bootstrap-db.mjs")], {
      env: { ...process.env, WORKLOOM_RUNTIME: RUNTIME },
    });
    if (r.code !== 0) throw new Error(`数据库引导失败：${r.err.slice(-300)}`);
  }

  /* ---------- 1.5 NATS JetStream（内嵌事件总线；缺失降级 memory 不阻断） ---------- */
  const children = [];
  const serverEnv = { ...process.env };
  const NATS_BIN = path.join(supportDir, "nats", IS_WIN ? "nats-server.exe" : "nats-server");
  if (fs.existsSync(NATS_BIN)) {
    const listening = await httpOk(`http://127.0.0.1:${NATS_PORT}/`) || run(IS_WIN ? "netstat" : "lsof", IS_WIN ? ["-ano"] : ["-nP", `-iTCP:${NATS_PORT}`, "-sTCP:LISTEN"]).out.includes(String(NATS_PORT));
    if (!listening) {
      status("→ 启动内嵌 nats-server（JetStream，用户态）…");
      const natsDir = path.join(supportDir, "nats-data");
      fs.mkdirSync(natsDir, { recursive: true });
      const proc = spawnLogged(NATS_BIN, ["-js", "--store_dir", natsDir, "-a", "127.0.0.1", "-p", String(NATS_PORT)], {}, path.join(logDir, "nats.log"));
      children.push(proc);
      await sleep(3000);
    }
    serverEnv.EVENT_BUS = "nats";
    serverEnv.EVENT_BUS_URL = `nats://127.0.0.1:${NATS_PORT}`;
    say("✓ 事件总线：nats（JetStream 持久化）");
  } else {
    say("⚠ 内嵌 nats-server 未随包——事件总线降级 memory");
  }

  /* ---------- 2. 配置 ---------- */
  const envFile = path.join(RUNTIME, ".env");
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(RUNTIME, ".env.defaults"), envFile);
    const secret = `wl-${crypto.randomBytes(24).toString("hex")}`;
    fs.writeFileSync(envFile, fs.readFileSync(envFile, "utf-8").replace(/^JWT_SECRET=.*/m, `JWT_SECRET=${secret}`));
    say("→ 生成默认配置 .env（JWT 密钥已随机化）");
  }

  /* ---------- 3. 首启引导：迁移 + 种子（幂等） ---------- */
  const bootFlag = path.join(supportDir, ".bootstrapped");
  if (!fs.existsSync(bootFlag)) {
    status("→ 首航引导：数据库迁移 + 演示数据种子（约 30 秒）…");
    const mig = run(NODE_BIN, [TSX_CLI, "--env-file=.env", "scripts/migrate.ts"], { cwd: RUNTIME });
    if (mig.code !== 0) throw new Error(`数据库迁移失败：${(mig.err || mig.out).slice(-400)}`);
    // 种子脚本按仓配置（.env.defaults DESKTOP_SEED_SCRIPT；不在 base-sync 同步范围）——
    // 基座出厂 AI 产品经理包；行业版子仓配自己行业种子（672cf7b 硬编码 hotel 根因）
    let seedScript = "scripts/seed-aipm.ts";
    try {
      const m = fs.readFileSync(path.join(RUNTIME, ".env.defaults"), "utf-8").match(/^DESKTOP_SEED_SCRIPT=(.+)$/m);
      if (m) seedScript = m[1].trim();
    } catch { /* 缺省即可 */ }
    const seed = run(NODE_BIN, [TSX_CLI, "--env-file=.env", seedScript], { cwd: RUNTIME });
    if (seed.code !== 0) throw new Error(`演示数据种子失败（${seedScript}）：${(seed.err || seed.out).slice(-400)}`);
    fs.writeFileSync(bootFlag, "done");
    status("✅ 首航引导完成（示例团队已装配）");
  }

  /* ---------- 4. 起服务：server(8787) + web preview(5173) ---------- */
  status("→ 启动服务…");
  const serverProc = spawnLogged(NODE_BIN, [TSX_CLI, `--env-file=${envFile}`, "src/index.ts"],
    { cwd: path.join(RUNTIME, "apps", "server"), env: serverEnv }, path.join(logDir, "server.log"));
  children.push(serverProc);
  const webProc = spawnLogged(NODE_BIN, [VITE_JS, "preview", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"],
    { cwd: path.join(RUNTIME, "apps", "web") }, path.join(logDir, "web.log"));
  children.push(webProc);

  status("→ 等待服务就绪…");
  let ok = false;
  for (let i = 0; i < 90 && !ok; i++) {
    ok = (await httpOk(`http://127.0.0.1:${SERVER_PORT}/health`)) && (await httpOk(`http://127.0.0.1:${WEB_PORT}/`));
    if (!ok) await sleep(1000);
  }
  if (!ok) throw new Error(`服务 90s 内未就绪（server:${SERVER_PORT} / web:${WEB_PORT}，详见 logs/）`);
  status("✅ 首航检查单全绿：PG ✅ 迁移 ✅ 种子 ✅ server ✅ web ✅");

  const webUrl = `http://127.0.0.1:${WEB_PORT}`;
  const stop = async () => {
    say("→ 停止服务…");
    for (const c of children) killTree(c);
    if (fs.existsSync(path.join(PGDATA, "postmaster.pid"))) {
      run(pgBin("pg_ctl"), pgCtlArgs(["stop", "-m", "fast"]));
    }
    say("== 已停止 ==");
  };
  return { stop, webUrl };
}

/* ---------------- CLI（CI 冒烟） ---------------- */
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const smoke = args.includes("--smoke");
  const resourcesDir = path.resolve(get("--resources", process.env.WORKLOOM_RESOURCES || "dist-payload"));
  const supportDir = path.resolve(get("--support", process.env.WORKLOOM_SUPPORT || path.join(require("node:os").tmpdir(), "workloom-smoke")));
  bootstrap({ resourcesDir, supportDir, smoke })
    .then(async ({ stop, webUrl }) => {
      console.log(`== SMOKE 通过：${webUrl} 健康 ==`);
      await stop();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error(`❌ 引导失败：${e.message}`);
      process.exit(1);
    });
}

module.exports = { bootstrap };
