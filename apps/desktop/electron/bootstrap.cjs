/**
 * WorkLoom 桌面客户端 · 首启引导（bootstrap）
 *
 * 职责（与 D16 启动器同口径的 JS 移植版，Mac/Windows 统一）：
 *   ① 载荷装配：resourcesDir(Resources 根目录) → supportDir（版本变化才覆盖，并重置 .bootstrapped）
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
const NATS_PORT = Number(process.env.WORKLOOM_NATS_PORT || 4222);

/* ---------------- 日志 ---------------- */
function makeLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `launch-${Date.now()}.log`);
  // appendFileSync 同步落盘——进程异常退出（CI 冒烟失败）时日志不丢（v2.1.1 流未冲刷实证）
  return (msg) => {
    const line = `${new Date().toTimeString().slice(0, 8)} ${msg}`;
    try { fs.appendFileSync(logFile, line + "\n"); } catch { /* 忽略 */ }
    console.log(line);
  };
}

/* ---------------- 进程工具 ---------------- */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { code: r.status ?? -1, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

// runToLog：会派生守护进程的命令（pg_ctl start/stop）必须走文件句柄而非管道——
// postmaster 继承管道写端会导致 spawnSync 永远等不到 EOF 假死
//（v2.1.2 Windows 冒烟挂死 15 分钟实证；与 bat 版 <nul >file 2>&1 句柄脱离同纪律）
function runToLog(cmd, args, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a");
  try {
    const r = spawnSync(cmd, args, { stdio: ["ignore", fd, fd] });
    return { code: r.status ?? -1, out: "", err: "" };
  } finally {
    fs.closeSync(fd);
  }
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

function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, content, mode ? { mode } : undefined);
  fs.renameSync(temporary, file);
}

function writeInstallCheckpoint(supportDir, state) {
  atomicWrite(path.join(supportDir, "install-state.json"), `${JSON.stringify({
    schemaVersion: "workloom.install-state/v1",
    updatedAt: new Date().toISOString(),
    ...state,
  }, null, 2)}\n`, 0o600);
}

/**
 * 在 supportDir 同一文件系统内完成“先装配、后换入”。任何换入阶段异常都会恢复
 * 原目录、VERSION 与首航哨兵；调用方须在迁移、种子和健康检查通过后 commit，失败时
 * rollback。这样 UI 看见的版本永远对应一套完整载荷。
 */
function installPayloadAtomically({ sourceRoot, supportDir, payloadVer, previousEnv, failAt = "", onPhase = () => {} }) {
  const parts = ["runtime", "node", "pg", "nats"].filter((part) => fs.existsSync(path.join(sourceRoot, part)));
  if (!parts.includes("runtime") || !parts.includes("node") || !parts.includes("pg")) {
    throw new Error("载荷不完整：runtime、node、pg 必须同时存在");
  }
  const nonce = `${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  const stagingRoot = path.join(supportDir, `.install-staging-${nonce}`);
  const backupRoot = path.join(supportDir, `.install-backup-${nonce}`);
  const versionFile = path.join(supportDir, "VERSION");
  const bootFlag = path.join(supportDir, ".bootstrapped");
  const oldVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile) : null;
  const oldBootFlag = fs.existsSync(bootFlag) ? fs.readFileSync(bootFlag) : null;
  const movedNew = [];
  const movedOld = [];
  let closed = false;
  const fault = (point) => {
    if (failAt === point) throw new Error(`安装故障注入：${point}`);
  };
  const restore = () => {
    if (closed) return;
    for (const part of [...movedNew].reverse()) {
      fs.rmSync(path.join(supportDir, part), { recursive: true, force: true });
    }
    for (const part of [...movedOld].reverse()) {
      const backup = path.join(backupRoot, part);
      if (fs.existsSync(backup)) fs.renameSync(backup, path.join(supportDir, part));
    }
    if (oldVersion === null) fs.rmSync(versionFile, { force: true });
    else atomicWrite(versionFile, oldVersion);
    if (oldBootFlag === null) fs.rmSync(bootFlag, { force: true });
    else atomicWrite(bootFlag, oldBootFlag);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
    closed = true;
  };

  try {
    fs.mkdirSync(stagingRoot, { recursive: true });
    onPhase("staging");
    for (const part of parts) {
      fs.cpSync(path.join(sourceRoot, part), path.join(stagingRoot, part), { recursive: true, dereference: true });
    }
    if (previousEnv && previousEnv.length > 0) {
      fs.writeFileSync(path.join(stagingRoot, "runtime", ".env"), previousEnv, { mode: 0o600 });
    }
    const assembledVer = fs.readFileSync(path.join(stagingRoot, "runtime", "VERSION"), "utf8").trim();
    if (assembledVer !== payloadVer) throw new Error(`暂存载荷版本不一致：期望 ${payloadVer}，实际 ${assembledVer || "缺失"}`);
    fault("after-stage");

    fs.mkdirSync(backupRoot, { recursive: true });
    onPhase("swapping");
    for (const [index, part] of parts.entries()) {
      const current = path.join(supportDir, part);
      if (fs.existsSync(current)) {
        fs.renameSync(current, path.join(backupRoot, part));
        movedOld.push(part);
      }
      fs.renameSync(path.join(stagingRoot, part), current);
      movedNew.push(part);
      if (index === 0) fault("after-first-swap");
    }
    atomicWrite(versionFile, `${payloadVer}\n`);
    fs.rmSync(bootFlag, { force: true });
    fault("after-version-swap");
    onPhase("swapped");
  } catch (error) {
    restore();
    throw error;
  }

  return {
    rollback: restore,
    commit() {
      if (closed) return;
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
      closed = true;
    },
  };
}

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
 * @param {string} opts.resourcesDir  应用 Resources 根目录（含 payload.tar.gz）
 * @param {string} opts.supportDir    可写支持目录（userData）
 * @param {(msg:string, progress:{phase?:string,percent?:number,etaSeconds?:number})=>void} [opts.onStatus] 状态回调（splash 展示）
 * @param {boolean} [opts.smoke]      冒烟模式：健康检查通过即返回（调用方随后 stop）
 * @returns {Promise<{stop:()=>Promise<void>, webUrl:string}>}
 */
async function bootstrap(opts) {
  const { resourcesDir, supportDir } = opts;
  const onStatus = opts.onStatus || (() => {});
  const logDir = path.join(supportDir, "logs");
  const say = makeLogger(logDir);
  const status = (m, progress = {}) => { say(m); onStatus(m, progress); };

  const RUNTIME = path.join(supportDir, "runtime");
  const PGDATA = path.join(supportDir, "pgdata");
  const NODEEXE = path.join(supportDir, "node", IS_WIN ? "node.exe" : "bin", IS_WIN ? "" : "node");
  const NODE_BIN = IS_WIN ? path.join(supportDir, "node", "node.exe") : path.join(supportDir, "node", "bin", "node");
  const PGBIN = path.join(supportDir, "pg", "bin");
  const pgBin = (n) => path.join(PGBIN, IS_WIN ? `${n}.exe` : n);
  const children = [];
  let pgStartedByBootstrap = false;
  let payloadTransaction = null;
  const failAt = opts.failAt || process.env.WORKLOOM_BOOTSTRAP_FAIL_AT || "";
  const checkpoint = (phase, detail, extra = {}) => writeInstallCheckpoint(supportDir, {
    status: "running", phase, detail, recoverable: true, ...extra,
  });

  try {
  say(`== WorkLoom 织元 · 引导启动（resources=${resourcesDir}）==`);
  checkpoint("inspect", "正在检查本机版本与安装载荷", { percent: 3, etaSeconds: 150 });
  status("正在检查本机版本与安装载荷…", { phase: "inspect", percent: 3, etaSeconds: 150 });

  /* ---------- 0. 载荷装配（版本变化才覆盖） ---------- */
  const readIf = (p) => { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return null; } };
  // 载荷以单文件归档随包（electron-builder extraResources 对 **/node_modules/** 有硬排除、
  // filter 无效——v2.2.0/v2.2.1 三轮实证）：Resources 内为 payload.tar.gz；
  // 按需解压到 supportDir/.payload-cache（PAYLOAD_VERSION 变化才重解），再按老逻辑装配。
  // main.cjs 与 CI 必须传同一个 Resources 根目录。为兼容曾经错误传入
  // Resources/payload 的旧调试脚本，仅在父目录确有归档时回退一级。
  let resourceRoot = resourcesDir;
  if (!fs.existsSync(path.join(resourceRoot, "payload.tar.gz"))
      && fs.existsSync(path.join(path.dirname(resourceRoot), "payload.tar.gz"))) {
    resourceRoot = path.dirname(resourceRoot);
  }
  const archiveFile = path.join(resourceRoot, "payload.tar.gz");
  let effResources = resourceRoot;
  const payloadVer = readIf(path.join(resourceRoot, "payload", "PAYLOAD_VERSION"))
    || readIf(path.join(resourceRoot, "PAYLOAD_VERSION"))
    || readIf(path.join(resourceRoot, "runtime", "VERSION"));
  if (!payloadVer || payloadVer === "unknown") {
    throw new Error(`载荷版本标记缺失（resources=${resourceRoot}）`);
  }
  if (fs.existsSync(archiveFile)) {
    const cacheDir = path.join(supportDir, ".payload-cache");
    const cacheVer = readIf(path.join(cacheDir, "PAYLOAD_VERSION")) || "none";
    if (cacheVer !== payloadVer || !fs.existsSync(path.join(cacheDir, "runtime", "VERSION"))) {
      status(`→ 解压运行时载荷（${payloadVer}）…`, { phase: "payload-unpack", percent: 8, etaSeconds: 140 });
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });
      // 两平台 tar 均可信：macOS 自带 bsdtar；Win10 1803+ System32 自带 tar.exe（bsdtar）
      // 注意：必须以 cwd + 相对文件名调用——GNU tar（CI 的 Git Bash）会把
      // "D:\..." 盘符误判为远程主机（host:path 语法，报 Cannot connect to D:，v2.2.1 实证）；
      // host:path 解析只作用于 -f 参数，-C 绝对路径不受影响
      const r = run("tar", ["-xzf", path.basename(archiveFile), "-C", cacheDir], { cwd: resourceRoot });
      if (r.code !== 0) throw new Error(`载荷解压失败：${(r.err || r.out).slice(-300)}`);
      status("载荷解压完成", { phase: "payload-unpacked", percent: 18, etaSeconds: 105 });
    }
    effResources = cacheDir;
  }
  const installedVer = readIf(path.join(supportDir, "VERSION")) || "none";
  if (payloadVer !== installedVer) {
    status(`→ 装配运行时载荷（${payloadVer}）…`, { phase: "payload-staging", percent: 20, etaSeconds: 100 });
    fs.mkdirSync(supportDir, { recursive: true });
    // runtime 会在升级时整体替换；先保留用户配置，避免 JWT/API Key/模型设置被新版覆盖。
    const previousEnvFile = path.join(supportDir, "runtime", ".env");
    let previousEnv = null;
    try { previousEnv = fs.readFileSync(previousEnvFile); } catch { /* 首装没有旧配置 */ }
    payloadTransaction = installPayloadAtomically({
      sourceRoot: effResources,
      supportDir,
      payloadVer,
      previousEnv,
      failAt,
      onPhase: (phase) => {
        const phaseProgress = { staging: [22, 95], swapping: [29, 85], swapped: [34, 78] }[phase] || [20, 100];
        checkpoint(`payload-${phase}`, "正在校验并安全换入运行时载荷", {
          targetVersion: payloadVer, previousVersion: installedVer,
          percent: phaseProgress[0], etaSeconds: phaseProgress[1],
        });
        status("正在校验并安全换入运行时载荷…", {
          phase: `payload-${phase}`, percent: phaseProgress[0], etaSeconds: phaseProgress[1],
        });
      },
    });
    if (previousEnv && previousEnv.length > 0) say("✓ 已保留上一版本地配置（JWT/API Key/模型设置）");
    if (!IS_WIN) {
      // zip/dmg 往返后确保可执行位
      for (const p of [NODE_BIN, pgBin("postgres"), pgBin("pg_ctl"), pgBin("initdb")]) {
        try { fs.chmodSync(p, 0o755); } catch { /* 忽略 */ }
      }
    }
    status("载荷装配完成", { phase: "payload-ready", percent: 36, etaSeconds: 75 });
  }
  const assembledVer = readIf(path.join(RUNTIME, "VERSION"));
  if (assembledVer !== payloadVer) {
    throw new Error(`载荷版本不一致：期望 ${payloadVer}，实际 ${assembledVer || "缺失"}`);
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
      status("→ 初始化本机数据库…", { phase: "database-init", percent: 42, etaSeconds: 70 });
      fs.mkdirSync(PGDATA, { recursive: true });
      // 超级用户固定 postgres：desktop-bootstrap-db.mjs 以 postgres 角色连接建库（两平台同口径）
      const r = run(pgBin("initdb"), ["-D", PGDATA, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"]);
      if (r.code !== 0) throw new Error(`initdb 失败：${r.err.slice(-300)}`);
    }
    status("→ 启动本机数据库服务…", { phase: "database-start", percent: 50, etaSeconds: 60 });
    // pg_ctl 起服（Windows 上由它对管理员会话降权，v2.0.9 实证不能用 postgres.exe 直起；
    // 输出走文件句柄——postmaster 继承管道会假死，v2.1.2 实证）
    const r = runToLog(pgBin("pg_ctl"), pgCtlArgs(["-l", path.join(logDir, "pg.log"), "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1`, "-w", "-t", "60", "start"]), path.join(logDir, "pgctl.log"));
    if (r.code !== 0) throw new Error(`PostgreSQL 启动失败（详见 logs/pg.log 与 logs/pgctl.log）`);
    pgStartedByBootstrap = true;
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { up = pgUp(); if (!up) await sleep(1000); }
    if (!up) throw new Error("PostgreSQL 40s 内未就绪");
  }
  say("✓ PostgreSQL 就绪");

  // 角色/建库/vector（Node 引导，幂等；Windows 内嵌 PG 无 psql，v2.0.12 实证）
  {
    status("→ 准备数据库角色、业务库和检索能力…", { phase: "database-bootstrap", percent: 57, etaSeconds: 52 });
    const r = run(NODE_BIN, [path.join(RUNTIME, "scripts", "desktop-bootstrap-db.mjs")], {
      env: { ...process.env, WORKLOOM_RUNTIME: RUNTIME },
    });
    if (r.code !== 0) throw new Error(`数据库引导失败：${r.err.slice(-300)}`);
  }

  /* ---------- 1.5 NATS JetStream（内嵌事件总线；缺失降级 memory 不阻断） ---------- */
  // 自包含桌面包按生产信任模型运行：稳定 Bundle 必须使用独立于 Bundle 载荷的公钥环验签。
  // 公钥环是 electron extraResource（可受应用签名保护）；私钥只存在于发布 CI，绝不随客户端分发。
  const serverEnv = { ...process.env, NODE_ENV: "production" };
  const bundleTrustFile = path.join(resourceRoot, "bundle-trust.json");
  if (fs.existsSync(bundleTrustFile)) {
    const trustText = fs.readFileSync(bundleTrustFile, "utf-8");
    try { JSON.parse(trustText); } catch { throw new Error("Bundle 独立公钥环格式无效，拒绝启动"); }
    serverEnv.BUNDLE_VERIFICATION_KEYS = trustText;
    delete serverEnv.BUNDLE_TRUST_PATH;
    say("✓ Bundle 独立公钥环已装载");
  } else {
    say("⚠ Bundle 独立公钥环缺失；任何稳定行业包都将失败关闭");
  }
  const NATS_BIN = path.join(supportDir, "nats", IS_WIN ? "nats-server.exe" : "nats-server");
  if (fs.existsSync(NATS_BIN)) {
    const listening = await httpOk(`http://127.0.0.1:${NATS_PORT}/`) || run(IS_WIN ? "netstat" : "lsof", IS_WIN ? ["-ano"] : ["-nP", `-iTCP:${NATS_PORT}`, "-sTCP:LISTEN"]).out.includes(String(NATS_PORT));
    if (!listening) {
      status("→ 启动本机事件总线…", { phase: "event-bus", percent: 63, etaSeconds: 45 });
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
    const piiSalt = `pii-${crypto.randomBytes(24).toString("hex")}`;
    // D-SEC2 交付审计实证：PII_SALT 此前全客户共用仓内默认值——
    // PII 占位符为 HMAC(盐)，盐相同则跨客户可关联、且盐值公开在仓库里，必须随首启一机一盐
    fs.writeFileSync(envFile, fs.readFileSync(envFile, "utf-8")
      .replace(/^JWT_SECRET=.*/m, `JWT_SECRET=${secret}`)
      .replace(/^PII_SALT=.*/m, `PII_SALT=${piiSalt}`));
    say("→ 生成默认配置 .env（JWT 密钥与 PII 盐已随机化）");
  }

  /* ---------- 3. 首启引导：迁移 + 种子（幂等） ---------- */
  const bootFlag = path.join(supportDir, ".bootstrapped");
  if (!fs.existsSync(bootFlag)) {
    checkpoint("database", "正在执行数据库迁移与示例装配", { targetVersion: payloadVer, percent: 70, etaSeconds: 38 });
    status("→ 正在升级数据结构…", { phase: "database-migrate", percent: 70, etaSeconds: 38 });
    const mig = run(NODE_BIN, [TSX_CLI, "--env-file=.env", "scripts/migrate.ts"], { cwd: RUNTIME });
    if (mig.code !== 0) throw new Error(`数据库迁移失败：${(mig.err || mig.out).slice(-400)}`);
    // 种子脚本按仓配置（.env.defaults DESKTOP_SEED_SCRIPT；不在 base-sync 同步范围）——
    // 基座出厂 AI 产品经理包；行业版子仓配自己行业种子（672cf7b 硬编码 hotel 根因）
    let seedScriptSpec = "scripts/seed-aipm.ts";
    try {
      const m = fs.readFileSync(path.join(RUNTIME, ".env.defaults"), "utf-8").match(/^DESKTOP_SEED_SCRIPT=(.+)$/m);
      if (m) seedScriptSpec = m[1].trim();
    } catch { /* 缺省即可 */ }
    const seedScripts = seedScriptSpec.split(",").map((s) => s.trim()).filter(Boolean);
    if (seedScripts.length === 0) throw new Error("演示数据种子配置为空");
    for (const [seedIndex, seedScript] of seedScripts.entries()) {
      status("→ 正在装配示例团队与起步数据…", {
        phase: "example-seed",
        percent: 78 + Math.floor((seedIndex / seedScripts.length) * 6),
        etaSeconds: Math.max(18, 30 - seedIndex * 5),
      });
      if (!fs.existsSync(path.join(RUNTIME, seedScript))) {
        throw new Error(`演示数据种子缺失（${seedScript}）`);
      }
      const seed = run(NODE_BIN, [TSX_CLI, "--env-file=.env", seedScript], { cwd: RUNTIME });
      if (seed.code !== 0) throw new Error(`演示数据种子失败（${seedScript}）：${(seed.err || seed.out).slice(-400)}`);
    }
    fs.writeFileSync(bootFlag, "done");
    status("示例团队已装配", { phase: "example-ready", percent: 85, etaSeconds: 15 });
  }

  /* ---------- 4. 起服务：server(8787) + web preview(5173) ---------- */
  status("→ 启动 WorkLoom 服务…", { phase: "services-start", percent: 88, etaSeconds: 12 });
  checkpoint("services", "正在启动本机服务并执行健康检查", { targetVersion: payloadVer, percent: 88, etaSeconds: 12 });
  const serverProc = spawnLogged(NODE_BIN, [TSX_CLI, `--env-file=${envFile}`, "src/index.ts"],
    { cwd: path.join(RUNTIME, "apps", "server"), env: serverEnv }, path.join(logDir, "server.log"));
  children.push(serverProc);
  const webProc = spawnLogged(NODE_BIN, [VITE_JS, "preview", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"],
    { cwd: path.join(RUNTIME, "apps", "web") }, path.join(logDir, "web.log"));
  children.push(webProc);

  status("→ 等待工作台与服务就绪…", { phase: "services-health", percent: 90, etaSeconds: 10 });
  let ok = false;
  for (let i = 0; i < 90 && !ok; i++) {
    ok = (await httpOk(`http://127.0.0.1:${SERVER_PORT}/health`)) && (await httpOk(`http://127.0.0.1:${WEB_PORT}/`));
    if (!ok && i > 0 && i % 5 === 0) {
      const percent = Math.min(99, 90 + Math.floor(i / 10));
      status("→ 正在完成本机服务健康检查…", {
        phase: "services-health", percent, etaSeconds: Math.max(1, 90 - i),
      });
      checkpoint("services", "正在启动本机服务并执行健康检查", { targetVersion: payloadVer, percent, etaSeconds: Math.max(1, 90 - i) });
    }
    if (!ok) await sleep(1000);
  }
  if (!ok) throw new Error(`服务 90s 内未就绪（server:${SERVER_PORT} / web:${WEB_PORT}，详见 logs/）`);
  status("启动检查已全部通过", { phase: "ready", percent: 100, etaSeconds: 0 });
  payloadTransaction?.commit();
  payloadTransaction = null;
  writeInstallCheckpoint(supportDir, { status: "complete", phase: "ready", detail: "安装与启动检查已完成", recoverable: true, targetVersion: payloadVer, percent: 100, etaSeconds: 0 });

  const webUrl = `http://127.0.0.1:${WEB_PORT}`;
  const stop = async () => {
    say("→ 停止服务…");
    for (const c of children) killTree(c);
    if (fs.existsSync(path.join(PGDATA, "postmaster.pid"))) {
      runToLog(pgBin("pg_ctl"), pgCtlArgs(["stop", "-m", "fast"]), path.join(logDir, "pgctl.log"));
    }
    say("== 已停止 ==");
  };
  return { stop, webUrl };
  } catch (error) {
    // 失败重试前必须回收本次派生的服务，避免端口占用导致下一次启动继续失败。
    for (const child of children) killTree(child);
    if (pgStartedByBootstrap && fs.existsSync(path.join(PGDATA, "postmaster.pid"))) {
      runToLog(pgBin("pg_ctl"), ["-D", PGDATA, "stop", "-m", "fast"], path.join(logDir, "pgctl.log"));
    }
    const rolledBack = Boolean(payloadTransaction);
    payloadTransaction?.rollback();
    payloadTransaction = null;
    writeInstallCheckpoint(supportDir, {
      status: "failed",
      phase: "recovery",
      detail: "本次安装或启动未完成",
      recoverable: true,
      rolledBack,
      error: String(error instanceof Error ? error.message : error).slice(0, 500),
    });
    throw error;
  }
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

module.exports = { bootstrap, installPayloadAtomically, writeInstallCheckpoint };
