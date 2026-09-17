import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { describe, it } from "node:test";
import {
  bootstrapDatabase,
  isDirectExecution,
  readDesktopDatabaseConfig,
} from "./desktop-bootstrap-db.mjs";
import { isStrictPathWithin } from "./path-containment.mjs";

const SYSTEM_IDENTIFIER = "7654321098765432109";
const POSTMASTER_START_TIME = "2026-09-16 16:52:18.418+00";

describe("客户端投影路径围栏", () => {
  it("同时接受 POSIX 与 Windows 的目录分隔符", () => {
    assert.equal(isStrictPathWithin("/repo/bundles/ai-pm", "/repo/bundles/ai-pm/service-front/client.json", posix), true);
    assert.equal(isStrictPathWithin("D:\\repo\\bundles\\ai-pm", "D:\\repo\\bundles\\ai-pm\\service-front\\client.json", win32), true);
  });

  it("拒绝同目录、父目录逃逸和 Windows 跨盘路径", () => {
    assert.equal(isStrictPathWithin("/repo/bundles/ai-pm", "/repo/bundles/ai-pm", posix), false);
    assert.equal(isStrictPathWithin("/repo/bundles/ai-pm", "/repo/bundles/other/client.json", posix), false);
    assert.equal(isStrictPathWithin("D:\\repo\\bundles\\ai-pm", "E:\\outside\\client.json", win32), false);
  });
});

function fixtureEnvironment(expectedDataDirectory, mode = "prepare", port = "55432") {
  return {
    WORKLOOM_PG_PORT: port,
    WORKLOOM_EXPECTED_PGDATA: expectedDataDirectory,
    WORKLOOM_EXPECTED_HBA_FILE: join(expectedDataDirectory, "pg_hba.conf"),
    WORKLOOM_EXPECTED_SYSTEM_IDENTIFIER: SYSTEM_IDENTIFIER,
    WORKLOOM_PG_ADMIN_PASSWORD: "test-only-owner-new",
    WORKLOOM_PG_APP_PASSWORD: "test-only-app-new",
    WORKLOOM_PG_GATEWAY_PASSWORD: "test-only-gateway-new",
    WORKLOOM_PG_BOOTSTRAP_MODE: mode,
    WORKLOOM_PG_LEGACY_PASSWORDS_JSON: "[]",
  };
}

function fakeClientFactory({
  dataDirectory,
  port = "55432",
  hbaFile = join(dataDirectory, "pg_hba.conf"),
  systemIdentifier = SYSTEM_IDENTIFIER,
  databaseExists = true,
  trust = false,
  invalidCredentialCode = "28P01",
  initialCredentials = {},
} = {}) {
  const clients = [];
  const credentials = new Map(Object.entries({
    postgres: "test-only-owner-new",
    workloom_app: "test-only-app-new",
    workloom_gateway: "test-only-gateway-new",
    ...initialCredentials,
  }));
  const roles = new Set(["workloom_app", "workloom_gateway"]);

  class FakeClient {
    constructor(config) {
      this.config = config;
      this.queries = [];
      this.connected = false;
      this.ended = false;
      clients.push(this);
    }

    async connect() {
      if (!trust && credentials.get(this.config.user) !== this.config.password) {
        throw Object.assign(new Error("test-only rejected"), { code: invalidCredentialCode });
      }
      this.connected = true;
    }

    async query(sql, params = []) {
      this.queries.push({ sql, params });
      if (sql.includes("current_setting('data_directory')")) {
        return {
          rows: [{
            data_directory: dataDirectory,
            port,
            ...(sql.includes("pg_control_system") ? {
              hba_file: hbaFile,
              system_identifier: systemIdentifier,
              postmaster_start_time: POSTMASTER_START_TIME,
            } : {}),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("pg_postmaster_start_time()") && sql.includes("current_user")) {
        if (this.config.user !== "postgres" && sql.includes("data_directory")) {
          throw Object.assign(new Error("permission denied to examine data_directory"), { code: "42501" });
        }
        return {
          rows: [{
            current_user: this.config.user,
            database_name: this.config.database,
            server_address: "127.0.0.1/32",
            server_port: port,
            postmaster_start_time: "2026-09-16 17:52:18.418+01",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("current_setting('password_encryption')")) {
        return { rows: [{ password_encryption: "scram-sha-256" }], rowCount: 1 };
      }
      if (sql.includes("FROM pg_authid")) {
        return {
          rows: ["postgres", "workloom_app", "workloom_gateway"].map((rolname) => ({ rolname, is_scram: true })),
          rowCount: 3,
        };
      }
      if (sql.includes("FROM pg_database")) {
        return { rows: databaseExists ? [{ exists: 1 }] : [], rowCount: databaseExists ? 1 : 0 };
      }
      if (sql.includes("FROM pg_roles")) {
        return { rows: roles.has(params[0]) ? [{ exists: 1 }] : [], rowCount: roles.has(params[0]) ? 1 : 0 };
      }
      if (/^ALTER USER postgres PASSWORD/iu.test(sql)) credentials.set("postgres", "test-only-owner-new");
      if (/^(?:ALTER|CREATE) ROLE workloom_app/iu.test(sql)) {
        roles.add("workloom_app");
        credentials.set("workloom_app", "test-only-app-new");
      }
      if (/^(?:ALTER|CREATE) ROLE workloom_gateway/iu.test(sql)) {
        roles.add("workloom_gateway");
        credentials.set("workloom_gateway", "test-only-gateway-new");
      }
      return { rows: [], rowCount: 0 };
    }

    async end() { this.ended = true; }
  }
  return { Client: FakeClient, clients, credentials };
}

function queryTexts(clients) {
  return clients.flatMap((client) => client.queries.map((entry) => entry.sql));
}

function writeQueries(clients) {
  return queryTexts(clients).filter((sql) => /^\s*(?:ALTER|CREATE|SET)\b/iu.test(sql));
}

describe("桌面数据库安全引导", () => {
  it("经符号链接路径执行 helper 时仍识别为 CLI 入口", () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-entry-"));
    try {
      const real = join(root, "desktop-bootstrap-db.mjs");
      const linked = join(root, "helper-link.mjs");
      writeFileSync(real, "// test-only\n");
      symlinkSync(real, linked);
      assert.equal(isDirectExecution(linked, real), true);
      assert.equal(isDirectExecution(join(root, "other.mjs"), real), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("要求三模式、端口、PGDATA、HBA 与三角色凭据全部由启动器显式注入", () => {
    const complete = fixtureEnvironment("/tmp/test-only-pgdata");
    assert.equal(readDesktopDatabaseConfig(complete).port, 55432);
    for (const missing of Object.keys(complete).filter((key) => key !== "WORKLOOM_EXPECTED_SYSTEM_IDENTIFIER")) {
      const env = { ...complete };
      delete env[missing];
      assert.throws(() => readDesktopDatabaseConfig(env), new RegExp(`${missing} 未设置|必须是 JSON 数组`, "u"));
    }
    assert.throws(
      () => readDesktopDatabaseConfig({ ...complete, WORKLOOM_PG_PORT: "5432.5" }),
      /1 到 65535/u,
    );
    assert.throws(
      () => readDesktopDatabaseConfig({ ...complete, WORKLOOM_PG_BOOTSTRAP_MODE: "unsafe" }),
      /inspect、prepare 或 verify/u,
    );
  });

  it("inspect 用旧 owner 候选只读绑定非默认端口、PGDATA、HBA 与 system_identifier", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-inspect-"));
    const pgData = join(root, "pgdata");
    mkdirSync(pgData);
    const fake = fakeClientFactory({
      dataDirectory: pgData,
      initialCredentials: { postgres: "test-only-owner-legacy" },
    });
    const env = {
      ...fixtureEnvironment(pgData, "inspect"),
      WORKLOOM_PG_LEGACY_PASSWORDS_JSON: JSON.stringify(["test-only-owner-legacy"]),
    };
    try {
      const identity = await bootstrapDatabase({ Client: fake.Client, env });
      assert.equal(identity.systemIdentifier, SYSTEM_IDENTIFIER);
      assert.equal(identity.postmasterStartTime, POSTMASTER_START_TIME);
      assert.equal(fake.clients.length, 2);
      assert.equal(fake.clients[0].queries.length, 0);
      assert.match(fake.clients[1].queries[0].sql, /current_setting\('data_directory'\)/u);
      assert.match(fake.clients[1].queries[0].sql, /pg_control_system/u);
      assert.deepEqual(writeQueries(fake.clients), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("legacy prepare 先验归属，再轮换 owner/app/gateway 为 SCRAM 并准备业务库", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-legacy-"));
    const pgData = join(root, "pgdata");
    mkdirSync(pgData);
    const fake = fakeClientFactory({
      dataDirectory: pgData,
      initialCredentials: { postgres: "test-only-owner-legacy" },
    });
    const env = {
      ...fixtureEnvironment(pgData, "prepare"),
      WORKLOOM_PG_LEGACY_PASSWORDS_JSON: JSON.stringify(["test-only-owner-legacy"]),
    };
    try {
      await bootstrapDatabase({ Client: fake.Client, env });
      assert.equal(fake.clients.length, 3);
      assert.equal(fake.clients[0].queries.length, 0);
      for (const client of fake.clients.filter((entry) => entry.connected)) {
        assert.match(client.queries[0].sql, /current_setting\('data_directory'\)/u);
      }
      const writes = writeQueries(fake.clients);
      assert.match(writes.join("\n"), /ALTER SYSTEM SET password_encryption/u);
      assert.match(writes.join("\n"), /ALTER USER postgres PASSWORD/u);
      assert.match(writes.join("\n"), /ALTER ROLE workloom_app LOGIN PASSWORD/u);
      assert.match(writes.join("\n"), /ALTER ROLE workloom_gateway LOGIN PASSWORD/u);
      assert.equal(fake.credentials.get("postgres"), "test-only-owner-new");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verify 对三角色正向连接、错误凭据反向拒绝，且全过程零写", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-verify-"));
    const pgData = join(root, "pgdata");
    mkdirSync(pgData);
    const fake = fakeClientFactory({ dataDirectory: pgData });
    try {
      await bootstrapDatabase({ Client: fake.Client, env: fixtureEnvironment(pgData, "verify") });
      assert.deepEqual(writeQueries(fake.clients), []);
      for (const user of ["postgres", "workloom_app", "workloom_gateway"]) {
        assert.ok(fake.clients.some((client) => client.config.user === user && client.connected));
        assert.ok(fake.clients.some((client) => client.config.user === user && !client.connected));
      }
      for (const role of fake.clients.filter((client) => client.connected && client.config.user !== "postgres")) {
        assert.doesNotMatch(role.queries[0].sql, /data_directory/u);
        assert.match(role.queries[0].sql, /pg_postmaster_start_time/u);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("trust 仍接受错误凭据时 verify 失败，不会误标为 SCRAM 生效", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-trust-"));
    const pgData = join(root, "pgdata");
    mkdirSync(pgData);
    const fake = fakeClientFactory({ dataDirectory: pgData, trust: true });
    try {
      await assert.rejects(
        bootstrapDatabase({ Client: fake.Client, env: fixtureEnvironment(pgData, "verify") }),
        /错误凭据被接受/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("错误凭据探测若得到非认证错误则失败关闭，不把网络故障当成安全证明", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-probe-error-"));
    const pgData = join(root, "pgdata");
    mkdirSync(pgData);
    const fake = fakeClientFactory({ dataDirectory: pgData, invalidCredentialCode: "ECONNREFUSED" });
    try {
      await assert.rejects(
        bootstrapDatabase({ Client: fake.Client, env: fixtureEnvironment(pgData, "verify") }),
        /未返回 invalid_password/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("未知 data_directory、活动 HBA 或 system_identifier 时首条查询后零写失败", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-foreign-"));
    const expected = join(root, "expected");
    const foreign = join(root, "foreign");
    mkdirSync(expected);
    mkdirSync(foreign);
    const cases = [
      { dataDirectory: foreign },
      { dataDirectory: expected, hbaFile: join(foreign, "pg_hba.conf") },
      { dataDirectory: expected, systemIdentifier: "7654321098765432110" },
    ];
    try {
      for (const options of cases) {
        const fake = fakeClientFactory(options);
        await assert.rejects(
          bootstrapDatabase({ Client: fake.Client, env: fixtureEnvironment(expected, "prepare") }),
          /数据库实例归属校验失败/u,
        );
        assert.equal(fake.clients[0].queries.length, 1);
        assert.deepEqual(writeQueries(fake.clients), []);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("实例报告端口不符时失败且零写入", async () => {
    const root = mkdtempSync(join(tmpdir(), "workloom-helper-port-"));
    const pgData = join(root, "pgdata");
    mkdirSync(pgData);
    const fake = fakeClientFactory({ dataDirectory: pgData, port: "55433" });
    try {
      await assert.rejects(
        bootstrapDatabase({ Client: fake.Client, env: fixtureEnvironment(pgData, "prepare") }),
        /实际端口 55433 与期望端口 55432 不一致/u,
      );
      assert.deepEqual(writeQueries(fake.clients), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
