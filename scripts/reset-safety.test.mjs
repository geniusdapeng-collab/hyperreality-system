import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceScript = new URL("./reset.sh", import.meta.url);

function databaseLocation(host = "127.0.0.1", database = "workloom") {
  return `postgres://demo@${host}:5432/${database}`;
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-reset-safety-"));
  const bin = join(root, "bin");
  const scripts = join(root, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts);
  copyFileSync(sourceScript, join(scripts, "reset.sh"));
  const log = join(root, "calls.log");

  writeExecutable(join(bin, "psql"), `#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  *"to_regclass('public.workspaces')"*) printf '%s\\n' "\${STUB_TABLE_STATE:-present}" ;;
  *"information_schema.columns"*) printf '%s\\n' "\${STUB_EXAMPLE_COLUMN:-1}" ;;
  *"is_example IS NOT TRUE"*) printf '%s\\n' "\${STUB_NON_EXAMPLE:-0}" ;;
  *"DROP SCHEMA public CASCADE"*) printf '%s\\n' drop >>"$STUB_LOG" ;;
  *) printf '%s\\n' unexpected-psql >>"$STUB_LOG" ;;
esac
`);
  writeExecutable(join(bin, "pg_dump"), `#!/usr/bin/env bash
set -euo pipefail
printf 'synthetic-backup-for-test\\n'
printf '%s\\n' backup >>"$STUB_LOG"
`);
  writeExecutable(join(bin, "pnpm"), `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >>"$STUB_LOG"
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_LOG: log,
    DATABASE_URL: databaseLocation(),
    NODE_ENV: "test",
  };
  const run = (args = [], overrides = {}) => spawnSync("bash", [join(scripts, "reset.sh"), ...args], {
    cwd: root,
    env: { ...env, ...overrides },
    encoding: "utf8",
    input: "",
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  return { root, run, calls };
}

test("非交互调用没有 --yes 时 fail closed，且不访问数据库", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 64);
  assert.match(result.stderr, /非交互环境必须显式传入 --yes/);
  assert.equal(f.calls(), "");
});

test("远端、生产和数据库名不匹配目标始终拒绝", () => {
  for (const overrides of [
    { DATABASE_URL: databaseLocation("db.example.invalid") },
    { NODE_ENV: "production" },
    { DATABASE_URL: databaseLocation("127.0.0.1", "customer_prod") },
  ]) {
    const f = fixture();
    const result = f.run(["--yes"], overrides);
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), "");
  }
});

test("检测到非演示工作区时拒绝删除", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_NON_EXAMPLE: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /非演示工作区/);
  assert.doesNotMatch(f.calls(), /drop|backup|pnpm/);
});

test("本机 workloom 纯演示库先备份，再事务重建并执行迁移种子", () => {
  const f = fixture();
  const result = f.run(["--yes"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(f.calls(), /backup/);
  assert.match(f.calls(), /drop/);
  assert.match(f.calls(), /pnpm db:migrate/);
  assert.match(f.calls(), /pnpm db:seed/);
  assert.match(result.stdout, /已生成重置前备份/);
});

test("未知参数 fail closed", () => {
  const f = fixture();
  const result = f.run(["--force"]);
  assert.equal(result.status, 64);
  assert.equal(f.calls(), "");
});
