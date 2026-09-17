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

function parseDesktopPort(name, fallback, env = process.env) {
  const raw = env[name] === undefined ? String(fallback) : String(env[name]);
  if (!/^\d{1,5}$/u.test(raw)) throw new Error(`${name} 必须是 1 到 65535 的十进制整数`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} 必须是 1 到 65535 的十进制整数`);
  }
  return value;
}

const SERVER_PORT = parseDesktopPort("WORKLOOM_SERVER_PORT", 8787);
const WEB_PORT = parseDesktopPort("WORKLOOM_WEB_PORT", 5173);
const PG_PORT = parseDesktopPort("WORKLOOM_PG_PORT", 5432);
const NATS_PORT = parseDesktopPort("WORKLOOM_NATS_PORT", 4222);

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

function openExternalUrl(url, {
  platform = process.platform,
  spawnCommand = spawn,
} = {}) {
  const command = platform === "win32" ? "cmd.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32"
    ? ["/d", "/s", "/c", "start", "", url]
    : [url];
  const child = spawnCommand(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on?.("error", () => {});
  child.unref?.();
  return child;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tarExtractionPlan(archiveFile, destination, {
  pathApi = path,
  realpath = fs.realpathSync.native,
} = {}) {
  const canonicalArchive = realpath(archiveFile);
  const canonicalDestination = realpath(destination);
  const relativeArchive = pathApi.relative(canonicalDestination, canonicalArchive);
  // Windows 跨盘符时 path.relative 会返回另一个绝对路径；GNU tar 会把
  // X:\\... 误认为 host:path。同盘符使用相对路径，跨盘符则先暂存到目标目录。
  if (pathApi.isAbsolute(relativeArchive) || /^[A-Za-z]:[\\/]/u.test(relativeArchive)) {
    const stagedArchive = pathApi.join(canonicalDestination, ".workloom-payload.tar.gz");
    return { cwd: canonicalDestination, archiveArg: pathApi.basename(stagedArchive), stagedArchive };
  }
  return {
    cwd: canonicalDestination,
    archiveArg: relativeArchive.replaceAll("\\", "/"),
    stagedArchive: null,
  };
}

function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, content, mode ? { mode } : undefined);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const BOOTSTRAP_LOCK_SCHEMA = "workloom.bootstrap-lock/v1";

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readBootstrapLockOwner(lockDir) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    if (owner?.schemaVersion !== BOOTSTRAP_LOCK_SCHEMA
        || !Number.isSafeInteger(owner.pid)
        || owner.pid <= 0
        || typeof owner.token !== "string"
        || !/^[a-f0-9]{32}$/u.test(owner.token)) return null;
    return owner;
  } catch {
    return null;
  }
}

function assessBootstrapLock(lockDir, {
  nowMs,
  isProcessAlive,
  malformedGraceMs,
}) {
  const owner = readBootstrapLockOwner(lockDir);
  if (owner) {
    return isProcessAlive(owner.pid)
      ? { recoverable: false, message: `WorkLoom 已在启动或运行（PID ${owner.pid}）` }
      : { recoverable: true };
  }
  let ageMs = 0;
  try { ageMs = Math.max(0, nowMs - fs.statSync(lockDir).mtimeMs); } catch { return { recoverable: true }; }
  return ageMs >= malformedGraceMs
    ? { recoverable: true }
    : { recoverable: false, message: "WorkLoom 启动锁正在创建，请稍后重试" };
}

function acquireBootstrapLock(supportDir, {
  pid = process.pid,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  isProcessAlive = processIsAlive,
  malformedGraceMs = 30_000,
} = {}) {
  fs.mkdirSync(supportDir, { recursive: true });
  const lockDir = path.join(supportDir, ".bootstrap-lock");
  const recoveryDir = path.join(supportDir, ".bootstrap-lock-recovery");
  const token = randomBytes(16).toString("hex");
  const owner = {
    schemaVersion: BOOTSTRAP_LOCK_SCHEMA,
    pid,
    token,
    startedAt: new Date(now()).toISOString(),
  };
  const createOwnedLock = () => {
    fs.mkdirSync(lockDir, { mode: 0o700 });
    try {
      atomicWrite(path.join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, 0o600);
    } catch (error) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      throw error;
    }
  };
  const makeHandle = () => {
    let released = false;
    return {
      lockDir,
      release() {
        if (released) return true;
        const current = readBootstrapLockOwner(lockDir);
        if (!current || current.token !== token) return false;
        fs.rmSync(lockDir, { recursive: true, force: true });
        released = true;
        return true;
      },
    };
  };

  if (fs.existsSync(recoveryDir)) throw new Error("WorkLoom 启动锁正在恢复，请稍后重试");
  try {
    createOwnedLock();
    return makeHandle();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  // Only one contender may retire a dead/corrupt lock. The recovery directory is intentionally
  // fail-closed if a process dies inside this tiny critical section; blindly stealing it would
  // recreate the same two-winner race this guard prevents.
  try {
    fs.mkdirSync(recoveryDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("WorkLoom 启动锁正在恢复，请稍后重试");
    throw error;
  }
  try {
    const assessment = assessBootstrapLock(lockDir, {
      nowMs: now(), isProcessAlive, malformedGraceMs,
    });
    if (!assessment.recoverable) throw new Error(assessment.message);
    fs.rmSync(lockDir, { recursive: true, force: true });
    createOwnedLock();
    return makeHandle();
  } finally {
    fs.rmSync(recoveryDir, { recursive: true, force: true });
  }
}

function normalizeDataDirectory(directory) {
  let normalized;
  try { normalized = fs.realpathSync.native(directory); } catch { normalized = path.resolve(directory); }
  normalized = normalized.normalize("NFC").replace(/[\\/]+$/u, "");
  return IS_WIN ? normalized.replaceAll("\\", "/").toLowerCase() : normalized;
}

function readPostmasterIdentity(pgData) {
  const pidFile = path.join(pgData, "postmaster.pid");
  let lines;
  try { lines = fs.readFileSync(pidFile, "utf8").split(/\r?\n/u); } catch {
    throw new Error("PostgreSQL 状态异常：pg_ctl 报告运行中但 postmaster.pid 缺失");
  }
  const pid = Number(lines[0]?.trim());
  const dataDirectory = lines[1]?.trim() ?? "";
  const portRaw = lines[3]?.trim() ?? "";
  if (!Number.isSafeInteger(pid) || pid <= 0 || !dataDirectory || !/^\d{1,5}$/u.test(portRaw)) {
    throw new Error("PostgreSQL 状态异常：postmaster.pid 格式无效");
  }
  const port = Number(portRaw);
  if (port < 1 || port > 65535) throw new Error("PostgreSQL 状态异常：postmaster.pid 端口无效");
  return { pid, dataDirectory, port };
}

function assertPostmasterIdentity(pgData, expectedPort) {
  const identity = readPostmasterIdentity(pgData);
  if (normalizeDataDirectory(identity.dataDirectory) !== normalizeDataDirectory(pgData)) {
    throw new Error("PostgreSQL 实例归属校验失败：运行实例的数据目录不属于当前产品");
  }
  if (identity.port !== expectedPort) {
    throw new Error(`PostgreSQL 实例归属校验失败：运行端口 ${identity.port} 与期望端口 ${expectedPort} 不一致`);
  }
  return identity;
}

function ownedPostgresRunning({ pgCtl, pgData, expectedPort, runCommand = run }) {
  const status = runCommand(pgCtl, ["status", "-D", pgData]);
  if (status.code !== 0) return false;
  assertPostmasterIdentity(pgData, expectedPort);
  return true;
}

function stopOwnedPostgres({
  pgCtl,
  pgData,
  expectedPort,
  logFile,
  runCommand = run,
  stopCommand = runToLog,
}) {
  if (!ownedPostgresRunning({ pgCtl, pgData, expectedPort, runCommand })) return false;
  const result = stopCommand(pgCtl, ["-D", pgData, "stop", "-m", "fast"], logFile);
  if (result.code !== 0) throw new Error("PostgreSQL 自有实例停止失败");
  return true;
}

function readEnvValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return text.match(new RegExp(`^${escaped}=(.*)$`, "mu"))?.[1] ?? null;
}

function upsertEnvValue(text, key, value) {
  if (/[\r\n]/u.test(value)) throw new Error(`${key} 不能包含换行`);
  const lines = String(text).replace(/\r\n/gu, "\n").split("\n");
  let written = false;
  const next = [];
  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      if (!written) next.push(`${key}=${value}`);
      written = true;
    } else {
      next.push(line);
    }
  }
  if (!written) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(`${key}=${value}`);
  }
  while (next.length > 1 && next[next.length - 1] === "" && next[next.length - 2] === "") next.pop();
  return `${next.join("\n").replace(/\n*$/u, "")}\n`;
}

function databaseUrl(user, password, port) {
  const url = new URL("postgres://127.0.0.1/workloom");
  url.username = user;
  url.password = password;
  url.port = String(port);
  return url.toString();
}

function existingUrlPassword(text, key) {
  try {
    const value = readEnvValue(text, key);
    return value ? decodeURIComponent(new URL(value).password) : null;
  } catch { return null; }
}

function buildDesktopEnvironment(text, {
  pgPort,
  serverPort,
  webPort,
  adminPassword,
  appPassword,
  gatewayPassword,
}) {
  const values = {
    DATABASE_URL: databaseUrl("postgres", adminPassword, pgPort),
    APP_DB_PASSWORD: appPassword,
    GATEWAY_DB_PASSWORD: gatewayPassword,
    DATABASE_APP_URL: databaseUrl("workloom_app", appPassword, pgPort),
    DATABASE_GATEWAY_URL: databaseUrl("workloom_gateway", gatewayPassword, pgPort),
    SERVER_PORT: String(serverPort),
    WEB_PORT: String(webPort),
  };
  let next = text;
  for (const [key, value] of Object.entries(values)) next = upsertEnvValue(next, key, value);
  return { text: next, values };
}

const DATABASE_STATE_SCHEMA = "workloom.database-state/v1";

function databaseStateFile(supportDir) {
  return path.join(supportDir, "database-state.json");
}

function validateDatabaseCredential(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,}$/u.test(value)) {
    throw new Error(`数据库状态无效：${label} 凭据格式不符合要求`);
  }
  return value;
}

function validateDatabaseState(state) {
  if (!state || state.schemaVersion !== DATABASE_STATE_SCHEMA) {
    throw new Error("数据库状态无效：schemaVersion 不受支持");
  }
  if (!state.credentials || typeof state.credentials !== "object") {
    throw new Error("数据库状态无效：credentials 缺失");
  }
  const owner = validateDatabaseCredential(state.credentials.owner, "owner");
  const app = validateDatabaseCredential(state.credentials.app, "app");
  const gateway = validateDatabaseCredential(state.credentials.gateway, "gateway");
  if (new Set([owner, app, gateway]).size !== 3) throw new Error("数据库状态无效：三类凭据必须互异");
  if (!state.auth || !["pending", "scram-sha-256"].includes(state.auth.status)) {
    throw new Error("数据库状态无效：认证状态不受支持");
  }
  if (typeof state.instanceId !== "string" || !/^[a-f0-9]{32}$/u.test(state.instanceId)) {
    throw new Error("数据库状态无效：instanceId 格式错误");
  }
  if (state.cluster !== null && state.cluster !== undefined) {
    if (!/^\d{10,30}$/u.test(String(state.cluster.systemIdentifier ?? ""))
        || typeof state.cluster.dataDirectory !== "string"
        || typeof state.cluster.hbaFile !== "string"
        || !Number.isInteger(state.cluster.port)
        || state.cluster.port < 1
        || state.cluster.port > 65535) {
      throw new Error("数据库状态无效：cluster 绑定信息格式错误");
    }
  }
  if (!Array.isArray(state.legacyOwnerPasswords)
      || state.legacyOwnerPasswords.some((value) => (
        typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\r\n]/u.test(value)
      ))) {
    throw new Error("数据库状态无效：legacyOwnerPasswords 格式错误");
  }
  if (state.auth.status === "scram-sha-256" && state.legacyOwnerPasswords.length > 0) {
    throw new Error("数据库状态无效：安全迁移完成后不得保留旧凭据");
  }
  if (state.auth.status === "scram-sha-256" && !state.cluster) {
    throw new Error("数据库状态无效：安全迁移完成但未绑定 PostgreSQL 实例");
  }
  return state;
}

function generateDistinctCredentials(randomBytes = crypto.randomBytes) {
  const values = new Set();
  for (let attempt = 0; attempt < 16 && values.size < 3; attempt += 1) {
    values.add(randomBytes(32).toString("base64url"));
  }
  if (values.size !== 3) throw new Error("无法生成互异的数据库凭据");
  const [owner, app, gateway] = values;
  return { owner, app, gateway };
}

function writeDatabaseState(file, state) {
  validateDatabaseState(state);
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function ensureDatabaseState(supportDir, { legacyOwnerPasswords = [], randomBytes = crypto.randomBytes } = {}) {
  const file = databaseStateFile(supportDir);
  if (fs.existsSync(file)) {
    let state;
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
      throw new Error("数据库状态损坏，拒绝生成新凭据覆盖现有实例");
    }
    validateDatabaseState(state);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 不保证 POSIX mode */ }
    if (state.auth.status === "pending") {
      const recovered = legacyOwnerPasswords.filter((value) => (
        typeof value === "string"
        && value.length > 0
        && value.length <= 1024
        && !/[\r\n]/u.test(value)
        && value !== state.credentials.owner
      ));
      const merged = [...new Set([...state.legacyOwnerPasswords, ...recovered])];
      if (merged.length !== state.legacyOwnerPasswords.length) {
        state = { ...state, updatedAt: new Date().toISOString(), legacyOwnerPasswords: merged };
        writeDatabaseState(file, state);
      }
    }
    return { file, state, created: false };
  }
  const credentials = generateDistinctCredentials(randomBytes);
  const legacy = [...new Set(legacyOwnerPasswords.filter((value) => (
    typeof value === "string"
      && value.length > 0
      && value.length <= 1024
      && !/[\r\n]/u.test(value)
      && value !== credentials.owner
  )))];
  const now = new Date().toISOString();
  const state = {
    schemaVersion: DATABASE_STATE_SCHEMA,
    instanceId: randomBytes(16).toString("hex"),
    createdAt: now,
    updatedAt: now,
    auth: { status: "pending" },
    cluster: null,
    credentials,
    legacyOwnerPasswords: legacy,
  };
  writeDatabaseState(file, state);
  return { file, state, created: true };
}

function bindDatabaseState(file, state, identity) {
  const cluster = {
    systemIdentifier: String(identity.systemIdentifier ?? ""),
    dataDirectory: normalizeDataDirectory(String(identity.dataDirectory ?? "")),
    hbaFile: normalizeDataDirectory(String(identity.hbaFile ?? "")),
    port: Number(identity.port),
  };
  const candidate = { ...state, cluster };
  validateDatabaseState(candidate);
  if (state.cluster) {
    for (const key of ["systemIdentifier", "dataDirectory", "hbaFile", "port"]) {
      if (state.cluster[key] !== cluster[key]) {
        throw new Error(`数据库实例归属校验失败：持久状态中的 ${key} 与运行实例不一致`);
      }
    }
    return state;
  }
  const next = { ...candidate, updatedAt: new Date().toISOString() };
  writeDatabaseState(file, next);
  return next;
}

function parseDatabaseIdentity(output) {
  const line = String(output).split(/\r?\n/u).find((entry) => entry.startsWith("workloom-db-identity "));
  if (!line) throw new Error("数据库只读探测未返回实例身份");
  try {
    return JSON.parse(line.slice("workloom-db-identity ".length));
  } catch {
    throw new Error("数据库只读探测返回的实例身份格式无效");
  }
}

function completeDatabaseHardening(file, state) {
  const hardenedAt = new Date().toISOString();
  const next = {
    ...state,
    updatedAt: hardenedAt,
    auth: { status: "scram-sha-256", hardenedAt },
    legacyOwnerPasswords: [],
  };
  writeDatabaseState(file, next);
  return next;
}

function secureInitdbArgs(pgData, passwordFile) {
  return [
    "-D", pgData,
    "-U", "postgres",
    "--auth-host=scram-sha-256",
    "--auth-local=scram-sha-256",
    `--pwfile=${passwordFile}`,
    "-E", "UTF8",
    "--locale=C",
  ];
}

function renderStrictPgHba() {
  return [
    "# WorkLoom managed PostgreSQL client authentication",
    "# This dedicated desktop cluster only accepts authenticated local clients.",
    "local all all scram-sha-256",
    "host all all 127.0.0.1/32 scram-sha-256",
    "host all all ::1/128 scram-sha-256",
    "",
  ].join("\n");
}

function enforceStrictPgHba({
  pgData,
  pgCtl,
  runCommand = run,
  verifyCommand,
  rollbackOnFailure,
  forceReload = false,
}) {
  const hbaFile = path.join(pgData, "pg_hba.conf");
  const original = fs.readFileSync(hbaFile, "utf8");
  const desired = renderStrictPgHba();
  const changed = original !== desired;
  const reload = () => runCommand(pgCtl, ["reload", "-D", pgData]);
  try {
    if (changed) atomicWrite(hbaFile, desired, 0o600);
    if (changed || forceReload) {
      const result = reload();
      if (result.code !== 0) throw new Error("PostgreSQL SCRAM 配置 reload 失败");
    }
    const verified = verifyCommand();
    if (verified.code !== 0) {
      const detail = String(verified.err || verified.out || "未知原因").trim().slice(-300);
      throw new Error(`PostgreSQL SCRAM 新凭据复验失败：${detail}`);
    }
    return { changed };
  } catch (error) {
    if (changed && rollbackOnFailure) {
      atomicWrite(hbaFile, original, 0o600);
      const restored = reload();
      if (restored.code !== 0) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}；原认证配置恢复后 reload 仍失败`);
      }
    }
    throw error;
  }
}

function validateDatabaseHelper(nodeBin, helperFile, runCommand = run) {
  const result = runCommand(nodeBin, ["--check", helperFile]);
  if (result.code !== 0) {
    throw new Error(`数据库安全引导 helper 语法校验失败：${String(result.err || result.out).slice(-300)}`);
  }
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
 * 原目录、VERSION 与首航哨兵。调用方必须在修改持久数据库认证前 commit：凭据轮换
 * 一旦发生便只能向前恢复，绝不能回滚到不理解新状态文件的旧 helper。
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
      // Mark the transaction irreversible before cleanup. Database credentials may be
      // rotated immediately after this call, so a cleanup failure must never re-enable
      // rollback to a helper that cannot understand the new database state.
      closed = true;
      try {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        fault("during-commit-cleanup");
        fs.rmSync(backupRoot, { recursive: true, force: true });
      } catch { /* stale backup is safer than rolling runtime back after credential rotation */ }
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
  const abortSignal = opts.signal;
  const throwIfAborted = () => {
    if (abortSignal?.aborted) throw new Error("WorkLoom 启动已取消");
  };
  let bootstrapLock = null;
  let bootstrapLockReleased = false;
  const releaseBootstrapLock = () => {
    if (!bootstrapLock || bootstrapLockReleased) return;
    bootstrapLockReleased = bootstrapLock.release();
  };
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
  const stopDatabaseIfOwned = () => {
    try {
      return stopOwnedPostgres({
        pgCtl: pgBin("pg_ctl"),
        pgData: PGDATA,
        expectedPort: PG_PORT,
        logFile: path.join(logDir, "pgctl.log"),
      });
    } catch (error) {
      say(`⚠ 拒绝停止未通过归属复验的 PostgreSQL：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  // Log-directory creation above is benign; every payload/state/database mutation below is
  // serialized across Electron and the emergency browser shell by this shared lock.
  bootstrapLock = acquireBootstrapLock(supportDir);
  try {
  throwIfAborted();
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
      // 从目标目录使用相对归档路径，避免 -f 和 -C 接收 Windows 盘符。
      const extraction = tarExtractionPlan(archiveFile, cacheDir);
      try {
        if (extraction.stagedArchive) fs.copyFileSync(archiveFile, extraction.stagedArchive, fs.constants.COPYFILE_EXCL);
        const r = run("tar", ["-xzf", extraction.archiveArg], { cwd: extraction.cwd });
        if (r.code !== 0) throw new Error(`载荷解压失败：${(r.err || r.out).slice(-300)}`);
      } finally {
        if (extraction.stagedArchive) fs.rmSync(extraction.stagedArchive, { force: true });
      }
      throwIfAborted();
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
  const DB_HELPER = path.join(RUNTIME, "scripts", "desktop-bootstrap-db.mjs");
  if (!fs.existsSync(NODE_BIN)) throw new Error(`载荷不完整：Node 运行时缺失（${NODE_BIN}）`);
  if (!fs.existsSync(TSX_CLI)) throw new Error("载荷不完整：tsx 缺失");
  if (!fs.existsSync(VITE_JS)) throw new Error("载荷不完整：vite 缺失");
  if (!fs.existsSync(DB_HELPER)) throw new Error("载荷不完整：数据库安全引导 helper 缺失");
  for (const executable of ["postgres", "pg_ctl", "initdb"]) {
    if (!fs.existsSync(pgBin(executable))) throw new Error(`载荷不完整：PostgreSQL ${executable} 缺失`);
  }
  validateDatabaseHelper(NODE_BIN, DB_HELPER);
  throwIfAborted();

  /* ---------- 0.5 桌面托管配置 ---------- */
  const envFile = path.join(RUNTIME, ".env");
  const defaultsFile = path.join(RUNTIME, ".env.defaults");
  if (!fs.existsSync(defaultsFile)) throw new Error("载荷不完整：.env.defaults 缺失");
  const defaultsText = fs.readFileSync(defaultsFile, "utf8");
  const envExisted = fs.existsSync(envFile);
  let envText = envExisted ? fs.readFileSync(envFile, "utf8") : defaultsText;
  const clusterExisted = fs.existsSync(path.join(PGDATA, "PG_VERSION"));
  const legacyOwnerPasswords = [...new Set([
    existingUrlPassword(envText, "DATABASE_URL"),
    existingUrlPassword(defaultsText, "DATABASE_URL"),
  ].filter((value) => typeof value === "string" && value.length > 0))];

  // From this boundary onward database-state.json and PostgreSQL may be mutated. Keeping an
  // old payload rollback candidate would be unsafe: the old helper cannot recover new SCRAM
  // credentials. Static payload validation above must therefore finish before this commit.
  payloadTransaction?.commit();
  payloadTransaction = null;
  const databaseStateRecord = ensureDatabaseState(supportDir, {
    legacyOwnerPasswords: clusterExisted ? legacyOwnerPasswords : [],
  });
  let databaseState = databaseStateRecord.state;
  const bootFlag = path.join(supportDir, ".bootstrapped");
  if (databaseStateRecord.created || !clusterExisted) fs.rmSync(bootFlag, { force: true });
  if (!clusterExisted && databaseState.cluster) {
    throw new Error("持久状态绑定的 PostgreSQL 实例已缺失，拒绝静默初始化为另一实例");
  }

  if (!envExisted) {
    const jwtValue = `wl-${crypto.randomBytes(24).toString("hex")}`;
    const piiValue = `pii-${crypto.randomBytes(24).toString("hex")}`;
    envText = upsertEnvValue(envText, "JWT_SECRET", jwtValue);
    envText = upsertEnvValue(envText, "PII_SALT", piiValue);
  }
  const adminPassword = databaseState.credentials.owner;
  const appPassword = databaseState.credentials.app;
  const gatewayPassword = databaseState.credentials.gateway;
  const desktopConfig = buildDesktopEnvironment(envText, {
    pgPort: PG_PORT,
    serverPort: SERVER_PORT,
    webPort: WEB_PORT,
    adminPassword,
    appPassword,
    gatewayPassword,
  });
  if (!envExisted || desktopConfig.text !== envText) atomicWrite(envFile, desktopConfig.text, 0o600);
  else {
    try { fs.chmodSync(envFile, 0o600); } catch { /* Windows 不保证 POSIX mode */ }
  }
  if (!envExisted) say("→ 生成默认配置 .env（JWT 密钥与 PII 盐已随机化）");
  const desktopEnv = {
    ...process.env,
    ...desktopConfig.values,
    WORKLOOM_PG_PORT: String(PG_PORT),
    WORKLOOM_SERVER_PORT: String(SERVER_PORT),
    WORKLOOM_WEB_PORT: String(WEB_PORT),
    WORKLOOM_NATS_PORT: String(NATS_PORT),
  };
  const serverEnv = { ...desktopEnv, NODE_ENV: "production" };
  const runDatabaseHelper = (mode, legacyPasswords = []) => run(NODE_BIN, [DB_HELPER], {
    env: {
      ...desktopEnv,
      WORKLOOM_RUNTIME: RUNTIME,
      WORKLOOM_EXPECTED_PGDATA: PGDATA,
      WORKLOOM_EXPECTED_HBA_FILE: path.join(PGDATA, "pg_hba.conf"),
      WORKLOOM_PG_ADMIN_PASSWORD: adminPassword,
      WORKLOOM_PG_APP_PASSWORD: appPassword,
      WORKLOOM_PG_GATEWAY_PASSWORD: gatewayPassword,
      WORKLOOM_PG_BOOTSTRAP_MODE: mode,
      WORKLOOM_PG_LEGACY_PASSWORDS_JSON: JSON.stringify(legacyPasswords),
      ...(databaseState.cluster ? {
        WORKLOOM_EXPECTED_SYSTEM_IDENTIFIER: databaseState.cluster.systemIdentifier,
      } : {}),
    },
  });

  /* ---------- 1. PostgreSQL ---------- */
  const pgCtlArgs = (a) => ["-D", PGDATA, ...a];
  const pgUp = () => ownedPostgresRunning({
    pgCtl: pgBin("pg_ctl"), pgData: PGDATA, expectedPort: PG_PORT,
  });

  if (pgUp()) {
    say("✓ PostgreSQL 已在运行（复用）");
  } else {
    if (!fs.existsSync(path.join(PGDATA, "PG_VERSION"))) {
      status("→ 初始化本机数据库…", { phase: "database-init", percent: 42, etaSeconds: 70 });
      if (fs.existsSync(PGDATA) && fs.readdirSync(PGDATA).length > 0) {
        throw new Error("PostgreSQL 数据目录不完整且非空，拒绝覆盖；请先执行数据恢复或人工确认清理");
      }
      const stagingData = path.join(supportDir, `.pgdata-init-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      // 凭据只经 0600 临时文件交给 initdb，不进入 argv；无论成功失败均立即删除。
      const passwordFile = path.join(supportDir, `.initdb-owner-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        fs.writeFileSync(passwordFile, `${adminPassword}\n`, { mode: 0o600, flag: "wx" });
        const r = run(pgBin("initdb"), secureInitdbArgs(stagingData, passwordFile));
        if (r.code !== 0) throw new Error(`initdb 失败：${r.err.slice(-300)}`);
        if (fs.existsSync(PGDATA)) fs.rmdirSync(PGDATA);
        fs.renameSync(stagingData, PGDATA);
      } finally {
        fs.rmSync(passwordFile, { force: true });
        fs.rmSync(stagingData, { recursive: true, force: true });
      }
    }
    status("→ 启动本机数据库服务…", { phase: "database-start", percent: 50, etaSeconds: 60 });
    // pg_ctl 起服（Windows 上由它对管理员会话降权，v2.0.9 实证不能用 postgres.exe 直起；
    // 输出走文件句柄——postmaster 继承管道会假死，v2.1.2 实证）
    const r = runToLog(pgBin("pg_ctl"), pgCtlArgs([
      "-l", path.join(logDir, "pg.log"),
      "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c password_encryption=scram-sha-256`,
      "-w", "-t", "60", "start",
    ]), path.join(logDir, "pgctl.log"));
    if (r.code !== 0) throw new Error(`PostgreSQL 启动失败（详见 logs/pg.log 与 logs/pgctl.log）`);
    throwIfAborted();
    pgStartedByBootstrap = true;
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      throwIfAborted();
      up = pgUp();
      if (!up) await sleep(1000);
    }
    if (!up) throw new Error("PostgreSQL 40s 内未就绪");
  }
  say("✓ PostgreSQL 就绪");

  // 先只读绑定 live cluster 的 system_identifier / active hba_file，再允许任何 SQL 写。
  status("→ 校验本机数据库实例归属…", { phase: "database-inspect", percent: 54, etaSeconds: 56 });
  const inspection = runDatabaseHelper("inspect", databaseState.legacyOwnerPasswords);
  if (inspection.code !== 0) throw new Error(`数据库实例归属探测失败：${inspection.err.slice(-300)}`);
  databaseState = bindDatabaseState(
    databaseStateRecord.file,
    databaseState,
    parseDatabaseIdentity(inspection.out),
  );

  const hardeningPending = databaseState.auth.status === "pending";
  if (hardeningPending) {
    throwIfAborted();
    status("→ 轮换本机数据库角色凭据…", { phase: "database-credentials", percent: 57, etaSeconds: 52 });
    const prepared = runDatabaseHelper("prepare", databaseState.legacyOwnerPasswords);
    if (prepared.code !== 0) throw new Error(`数据库安全引导失败：${prepared.err.slice(-300)}`);
  }

  status("→ 收紧本机数据库认证围栏…", { phase: "database-auth", percent: 60, etaSeconds: 48 });
  enforceStrictPgHba({
    pgData: PGDATA,
    pgCtl: pgBin("pg_ctl"),
    rollbackOnFailure: hardeningPending,
    forceReload: true,
    verifyCommand: () => runDatabaseHelper("verify"),
  });
  if (hardeningPending) {
    databaseState = completeDatabaseHardening(databaseStateRecord.file, databaseState);
    say("✓ PostgreSQL 三角色随机凭据与 SCRAM 认证已固化");
  }

  /* ---------- 1.5 NATS JetStream（内嵌事件总线；缺失降级 memory 不阻断） ---------- */
  // 自包含桌面包按生产信任模型运行：稳定 Bundle 必须使用独立于 Bundle 载荷的公钥环验签。
  // 公钥环是 electron extraResource（可受应用签名保护）；私钥只存在于发布 CI，绝不随客户端分发。
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
    throwIfAborted();
    const listening = await httpOk(`http://127.0.0.1:${NATS_PORT}/`) || run(IS_WIN ? "netstat" : "lsof", IS_WIN ? ["-ano"] : ["-nP", `-iTCP:${NATS_PORT}`, "-sTCP:LISTEN"]).out.includes(String(NATS_PORT));
    if (!listening) {
      status("→ 启动本机事件总线…", { phase: "event-bus", percent: 63, etaSeconds: 45 });
      const natsDir = path.join(supportDir, "nats-data");
      fs.mkdirSync(natsDir, { recursive: true });
      const proc = spawnLogged(NATS_BIN, ["-js", "--store_dir", natsDir, "-a", "127.0.0.1", "-p", String(NATS_PORT)], {}, path.join(logDir, "nats.log"));
      children.push(proc);
      await sleep(3000);
      throwIfAborted();
    }
    serverEnv.EVENT_BUS = "nats";
    serverEnv.EVENT_BUS_URL = `nats://127.0.0.1:${NATS_PORT}`;
    say("✓ 事件总线：nats（JetStream 持久化）");
  } else {
    say("⚠ 内嵌 nats-server 未随包——事件总线降级 memory");
  }

  /* ---------- 3. 首启引导：迁移 + 种子（幂等） ---------- */
  if (!fs.existsSync(bootFlag)) {
    throwIfAborted();
    checkpoint("database", "正在执行数据库迁移与示例装配", { targetVersion: payloadVer, percent: 70, etaSeconds: 38 });
    status("→ 正在升级数据结构…", { phase: "database-migrate", percent: 70, etaSeconds: 38 });
    const mig = run(NODE_BIN, [TSX_CLI, "--env-file=.env", "scripts/migrate.ts"], {
      cwd: RUNTIME, env: serverEnv,
    });
    if (mig.code !== 0) throw new Error(`数据库迁移失败：${(mig.err || mig.out).slice(-400)}`);
    throwIfAborted();
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
      throwIfAborted();
      status("→ 正在装配示例团队与起步数据…", {
        phase: "example-seed",
        percent: 78 + Math.floor((seedIndex / seedScripts.length) * 6),
        etaSeconds: Math.max(18, 30 - seedIndex * 5),
      });
      if (!fs.existsSync(path.join(RUNTIME, seedScript))) {
        throw new Error(`演示数据种子缺失（${seedScript}）`);
      }
      const seed = run(NODE_BIN, [TSX_CLI, "--env-file=.env", seedScript], {
        cwd: RUNTIME, env: serverEnv,
      });
      if (seed.code !== 0) throw new Error(`演示数据种子失败（${seedScript}）：${(seed.err || seed.out).slice(-400)}`);
      throwIfAborted();
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
    { cwd: path.join(RUNTIME, "apps", "web"), env: serverEnv }, path.join(logDir, "web.log"));
  children.push(webProc);

  status("→ 等待工作台与服务就绪…", { phase: "services-health", percent: 90, etaSeconds: 10 });
  let ok = false;
  for (let i = 0; i < 90 && !ok; i++) {
    throwIfAborted();
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
  writeInstallCheckpoint(supportDir, { status: "complete", phase: "ready", detail: "安装与启动检查已完成", recoverable: true, targetVersion: payloadVer, percent: 100, etaSeconds: 0 });

  const webUrl = `http://127.0.0.1:${WEB_PORT}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    say("→ 停止服务…");
    for (const c of children) killTree(c);
    stopDatabaseIfOwned();
    releaseBootstrapLock();
    say("== 已停止 ==");
  };
  return { stop, webUrl };
  } catch (error) {
    const rolledBack = Boolean(payloadTransaction);
    try {
      // 失败重试前必须回收本次派生的服务，避免端口占用导致下一次启动继续失败。
      for (const child of children) killTree(child);
      if (pgStartedByBootstrap) stopDatabaseIfOwned();
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
    } finally {
      releaseBootstrapLock();
    }
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
  const abortController = new AbortController();
  let activeStop = null;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    abortController.abort();
    if (activeStop) {
      await activeStop();
      process.exit(0);
    }
  };
  // Register before bootstrap: closing an emergency shell during init/migration must enter the
  // same cancellation cleanup instead of abandoning PG/state changes and a live lock.
  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    try { process.once(signalName, () => { void shutdown(); }); } catch { /* platform unsupported */ }
  }
  bootstrap({ resourcesDir, supportDir, smoke, signal: abortController.signal })
    .then(async ({ stop, webUrl }) => {
      activeStop = stop;
      if (abortController.signal.aborted) {
        await stop();
        process.exit(0);
      }
      if (smoke) {
        console.log(`== SMOKE 通过：${webUrl} 健康 ==`);
        await stop();
        process.exit(0);
      }
      console.log(`== WorkLoom 已就绪：${webUrl} ==`);
      openExternalUrl(webUrl);
      // 旧 zip 浏览器壳只保留为人工应急回退线；保持父进程存活，直到上方信号处理器
      // 走所有权复验后的统一 stop。
      setInterval(() => {}, 2 ** 30);
    })
    .catch(async (e) => {
      if (activeStop) await activeStop();
      console.error(`❌ 引导失败：${e.message}`);
      process.exit(abortController.signal.aborted ? 130 : 1);
    });
}

module.exports = {
  bootstrap,
  installPayloadAtomically,
  writeInstallCheckpoint,
  parseDesktopPort,
  normalizeDataDirectory,
  readPostmasterIdentity,
  assertPostmasterIdentity,
  ownedPostgresRunning,
  stopOwnedPostgres,
  buildDesktopEnvironment,
  validateDatabaseState,
  ensureDatabaseState,
  bindDatabaseState,
  completeDatabaseHardening,
  parseDatabaseIdentity,
  secureInitdbArgs,
  renderStrictPgHba,
  enforceStrictPgHba,
  validateDatabaseHelper,
  openExternalUrl,
  acquireBootstrapLock,
  tarExtractionPlan,
};
