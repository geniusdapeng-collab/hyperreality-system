// desktop-bootstrap-db.mjs —— 桌面自包含包的数据库引导（Node 版，替代 psql/createdb）
// 背景：Windows 内嵌 PG（zonky）只含 initdb/pg_ctl/postgres 三个可执行文件，
//       没有 psql/createdb/pg_isready（v2.0.12 冒烟实证）——角色/建库/扩展全部
//       改由载荷内 node + pg 驱动完成。
// 环境：WORKLOOM_RUNTIME = runtime 载荷根目录（含 node_modules/pg）
// 幂等：ALTER USER 可重放；CREATE DATABASE 前查 pg_database；CREATE EXTENSION IF NOT EXISTS
import { createRequire } from "node:module";

const RUNTIME = process.env.WORKLOOM_RUNTIME;
if (!RUNTIME) { console.error("WORKLOOM_RUNTIME 未设置"); process.exit(1); }
const require = createRequire(`${RUNTIME}/scripts/`);
const { Client } = require("pg");

const PG = { host: "127.0.0.1", port: 5432, user: "postgres" };

async function main() {
  // ① 角色口令 + 建库（admin 连接 postgres 库）
  const admin = new Client({ ...PG, database: "postgres" });
  await admin.connect();
  await admin.query("ALTER USER postgres PASSWORD 'workloom'");
  const r = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'workloom'");
  if (r.rowCount === 0) {
    await admin.query("CREATE DATABASE workloom");
    console.log("✓ database workloom created");
  }
  await admin.end();

  // ② vector 扩展（目标库）
  const db = new Client({ ...PG, password: "workloom", database: "workloom" });
  await db.connect();
  await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  await db.end();
  console.log("✓ vector extension ready");
  console.log("bootstrap-db ok");
}

main().catch((e) => { console.error(`bootstrap-db 失败: ${e.message}`); process.exit(1); });
