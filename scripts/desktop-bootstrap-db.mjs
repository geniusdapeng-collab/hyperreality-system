// desktop-bootstrap-db.mjs —— 桌面自包含包的数据库引导（Node 版，替代 psql/createdb）
// Windows 内嵌 PostgreSQL 不保证携带 psql/createdb/pg_isready，因此角色、建库和
// 扩展由载荷内 node + pg 驱动完成。连接目标必须由 Electron 引导器显式注入，且任何
// 写操作前必须证明端口上的实例确实使用当前产品的 PGDATA。
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} 未设置`);
  return value;
}

function parsePort(raw) {
  if (!/^\d{1,5}$/u.test(raw)) throw new Error("WORKLOOM_PG_PORT 必须是 1 到 65535 的十进制整数");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WORKLOOM_PG_PORT 必须是 1 到 65535 的十进制整数");
  }
  return port;
}

export function normalizeDataDirectory(directory, platform = process.platform) {
  let normalized;
  try { normalized = realpathSync.native(directory); } catch { normalized = resolve(directory); }
  normalized = normalized.normalize("NFC").replace(/[\\/]+$/u, "");
  return platform === "win32" ? normalized.replaceAll("\\", "/").toLowerCase() : normalized;
}

export function readDesktopDatabaseConfig(env = process.env) {
  const mode = requiredEnv(env, "WORKLOOM_PG_BOOTSTRAP_MODE");
  if (!new Set(["inspect", "prepare", "verify"]).has(mode)) {
    throw new Error("WORKLOOM_PG_BOOTSTRAP_MODE 必须是 inspect、prepare 或 verify");
  }
  let legacyPasswords;
  try {
    legacyPasswords = JSON.parse(requiredEnv(env, "WORKLOOM_PG_LEGACY_PASSWORDS_JSON"));
  } catch {
    throw new Error("WORKLOOM_PG_LEGACY_PASSWORDS_JSON 必须是 JSON 数组");
  }
  if (!Array.isArray(legacyPasswords)
      || legacyPasswords.some((value) => typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value))) {
    throw new Error("WORKLOOM_PG_LEGACY_PASSWORDS_JSON 必须是无换行非空字符串数组");
  }
  const adminPassword = requiredEnv(env, "WORKLOOM_PG_ADMIN_PASSWORD");
  return {
    host: "127.0.0.1",
    port: parsePort(requiredEnv(env, "WORKLOOM_PG_PORT")),
    user: "postgres",
    mode,
    adminPassword,
    appPassword: requiredEnv(env, "WORKLOOM_PG_APP_PASSWORD"),
    gatewayPassword: requiredEnv(env, "WORKLOOM_PG_GATEWAY_PASSWORD"),
    legacyPasswords: [...new Set(legacyPasswords)].filter((value) => value !== adminPassword),
    expectedDataDirectory: requiredEnv(env, "WORKLOOM_EXPECTED_PGDATA"),
    expectedHbaFile: requiredEnv(env, "WORKLOOM_EXPECTED_HBA_FILE"),
    expectedSystemIdentifier: env.WORKLOOM_EXPECTED_SYSTEM_IDENTIFIER || null,
  };
}

function absoluteServerPath(serverPath, dataDirectory) {
  return isAbsolute(serverPath) ? serverPath : resolve(dataDirectory, serverPath);
}

export async function assertOwnedDatabase(client, config, { includeClusterIdentity = false } = {}) {
  const result = await client.query(
    includeClusterIdentity
      ? `SELECT current_setting('data_directory') AS data_directory,
                current_setting('port') AS port,
                current_setting('hba_file') AS hba_file,
                (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`
      : "SELECT current_setting('data_directory') AS data_directory, current_setting('port') AS port",
  );
  const row = result.rows?.[0];
  if (!row || normalizeDataDirectory(String(row.data_directory ?? ""))
      !== normalizeDataDirectory(config.expectedDataDirectory)) {
    throw new Error("数据库实例归属校验失败：data_directory 与当前产品 PGDATA 不一致");
  }
  if (Number(row.port) !== config.port) {
    throw new Error(`数据库实例归属校验失败：实际端口 ${String(row.port)} 与期望端口 ${config.port} 不一致`);
  }
  if (!includeClusterIdentity) return { dataDirectory: row.data_directory, port: Number(row.port) };
  const hbaFile = absoluteServerPath(String(row.hba_file ?? ""), String(row.data_directory ?? ""));
  if (normalizeDataDirectory(hbaFile) !== normalizeDataDirectory(config.expectedHbaFile)) {
    throw new Error("数据库实例归属校验失败：活动 hba_file 不属于当前产品 PGDATA");
  }
  const systemIdentifier = String(row.system_identifier ?? "");
  if (!/^\d{10,30}$/u.test(systemIdentifier)) {
    throw new Error("数据库实例归属校验失败：system_identifier 无效");
  }
  if (config.expectedSystemIdentifier && systemIdentifier !== config.expectedSystemIdentifier) {
    throw new Error("数据库实例归属校验失败：system_identifier 与持久状态不一致");
  }
  return {
    dataDirectory: normalizeDataDirectory(String(row.data_directory)),
    port: Number(row.port),
    hbaFile: normalizeDataDirectory(hbaFile),
    systemIdentifier,
  };
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function connectOwnedClient({ Client, config, database, passwords, includeClusterIdentity = false, user = config.user }) {
  for (const password of passwords) {
    const client = new Client({
      host: config.host,
      port: config.port,
      user,
      password,
      database,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await client.connect();
    } catch {
      await client.end().catch(() => undefined);
      continue;
    }
    try {
      // A successful TCP login is not ownership proof: trust may accept any password and a
      // foreign PostgreSQL may be listening on the requested port. This must remain query #1.
      const identity = await assertOwnedDatabase(client, config, { includeClusterIdentity });
      return { client, identity };
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }
  throw new Error(`数据库认证失败：无法连接本机 ${database} 数据库`);
}

async function assertScramVerifier(client) {
  const result = await client.query(
    `SELECT rolname, rolpassword LIKE 'SCRAM-SHA-256$%' AS is_scram
       FROM pg_authid
      WHERE rolname IN ('postgres', 'workloom_app', 'workloom_gateway')`,
  );
  const roles = new Map((result.rows ?? []).map((row) => [row.rolname, row.is_scram]));
  if (["postgres", "workloom_app", "workloom_gateway"].some((role) => roles.get(role) !== true)) {
    throw new Error("数据库角色凭据未全部使用 SCRAM-SHA-256 存储");
  }
}

async function assertScramConfiguration(client) {
  const result = await client.query("SELECT current_setting('password_encryption') AS password_encryption");
  if (result.rows?.[0]?.password_encryption !== "scram-sha-256") {
    throw new Error("数据库 password_encryption 未固定为 scram-sha-256");
  }
}

async function ensureLoginRole(client, role, password) {
  const result = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  const statement = result.rowCount === 0 ? "CREATE ROLE" : "ALTER ROLE";
  await client.query(`${statement} ${role} LOGIN PASSWORD ${sqlLiteral(password)}`);
}

async function assertInvalidPasswordRejected({ Client, config, user, database }) {
  const probe = new Client({
    host: config.host,
    port: config.port,
    user,
    password: randomBytes(32).toString("base64url"),
    database,
    connectionTimeoutMillis: 10_000,
  });
  let accepted = false;
  try {
    await probe.connect();
    accepted = true;
  } catch (error) {
    if (error && error.code === "28P01") return;
    throw new Error(`数据库认证负向探测异常：${user} 未返回 invalid_password`);
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (accepted) throw new Error(`数据库认证围栏未生效：${user} 的错误凭据被接受`);
}

export async function bootstrapDatabase({ Client, env = process.env }) {
  if (typeof Client !== "function") throw new Error("pg Client 不可用");
  const config = readDesktopDatabaseConfig(env);
  const candidatePasswords = config.mode !== "verify"
    ? [config.adminPassword, ...config.legacyPasswords]
    : [config.adminPassword];
  const adminConnection = await connectOwnedClient({
    Client,
    config,
    database: "postgres",
    passwords: candidatePasswords,
    includeClusterIdentity: true,
  });
  const { client: admin, identity } = adminConnection;
  if (config.mode === "inspect") {
    await admin.end().catch(() => undefined);
    console.log(`workloom-db-identity ${JSON.stringify(identity)}`);
    return identity;
  }
  try {
    if (config.mode === "prepare") {
      // Session-local setting guarantees ALTER USER emits a SCRAM verifier even when a
      // legacy cluster still has password_encryption=md5 in postgresql.conf.
      await admin.query("SET password_encryption = 'scram-sha-256'");
      await admin.query("ALTER SYSTEM SET password_encryption = 'scram-sha-256'");
      await admin.query(`ALTER USER postgres PASSWORD ${sqlLiteral(config.adminPassword)}`);
      const result = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'workloom'");
      if (result.rowCount === 0) {
        await admin.query("CREATE DATABASE workloom");
        console.log("✓ database workloom created");
      }
    } else {
      await assertScramConfiguration(admin);
      await assertScramVerifier(admin);
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  const databaseConnection = await connectOwnedClient({
    Client,
    config,
    database: "workloom",
    passwords: [config.adminPassword],
    includeClusterIdentity: true,
  });
  const database = databaseConnection.client;
  try {
    if (config.mode === "prepare") {
      await database.query("SET password_encryption = 'scram-sha-256'");
      await ensureLoginRole(database, "workloom_app", config.appPassword);
      await ensureLoginRole(database, "workloom_gateway", config.gatewayPassword);
      await assertScramVerifier(database);
      await database.query("CREATE EXTENSION IF NOT EXISTS vector");
    }
  } finally {
    await database.end().catch(() => undefined);
  }
  if (config.mode === "verify") {
    for (const [user, password] of [
      ["workloom_app", config.appPassword],
      ["workloom_gateway", config.gatewayPassword],
    ]) {
      const roleConnection = await connectOwnedClient({
        Client, config, database: "workloom", passwords: [password], user,
      });
      await roleConnection.client.end().catch(() => undefined);
    }
    await assertInvalidPasswordRejected({ Client, config, user: "postgres", database: "postgres" });
    await assertInvalidPasswordRejected({ Client, config, user: "workloom_app", database: "workloom" });
    await assertInvalidPasswordRejected({ Client, config, user: "workloom_gateway", database: "workloom" });
  }
  console.log(config.mode === "prepare" ? "bootstrap-db prepare ok" : "bootstrap-db verify ok");
  return identity;
}

async function main() {
  const runtime = requiredEnv(process.env, "WORKLOOM_RUNTIME");
  const require = createRequire(`${runtime}/scripts/`);
  const { Client } = require("pg");
  await bootstrapDatabase({ Client });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`bootstrap-db 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
