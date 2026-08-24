/**
 * 迁移执行器（手写 SQL + tsx；drizzle schema 仅作类型源）
 * 用法：pnpm db:migrate（读取 .env）
 * 步骤：① 确保应用双角色存在（密码取自环境变量，不硬编码入库；已存在则 ALTER ROLE 对齐 env，密码漂移轮换）
 *      ② 建 _migrations 账本（含 sha256 校验列，漂移拒跑）；③ 按文件名顺序执行未应用迁移（单事务）
 * 加固（审计）：
 *  - 生产（NODE_ENV=production）缺 APP_DB_PASSWORD / GATEWAY_DB_PASSWORD 直接拒启（不回落开发默认值）
 *  - 已应用迁移文件内容 sha256 与账本不符 → 拒跑（历史文件首次记录 checksum 不校验）
 *  - main() 全程持 pg_advisory_lock(hashtext('workloom-migrate'))，互斥并发 migrate
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../packages/db/migrations");

const IS_PROD = process.env.NODE_ENV === "production";

function requiredEnv(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (IS_PROD) {
    console.error(`迁移拒启：生产环境（NODE_ENV=production）必须显式配置 ${name}（拒绝回落开发默认密码）`);
    process.exit(1);
  }
  return devDefault;
}

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const APP_DB_PASSWORD = requiredEnv("APP_DB_PASSWORD", "workloom_dev_app");
const GATEWAY_DB_PASSWORD = requiredEnv("GATEWAY_DB_PASSWORD", "workloom_dev_gateway");

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

async function ensureRoles(client: pg.Client): Promise<void> {
  const roles: Array<[string, string]> = [
    ["workloom_app", APP_DB_PASSWORD],
    ["workloom_gateway", GATEWAY_DB_PASSWORD],
  ];
  for (const [role, pwd] of roles) {
    // 角色不存在则创建；已存在则 ALTER ROLE 对齐 env（密码漂移轮换， migrate 即轮换点）
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
           CREATE ROLE ${role} LOGIN PASSWORD '${sqlEscape(pwd)}';
         ELSE
           ALTER ROLE ${role} LOGIN PASSWORD '${sqlEscape(pwd)}';
         END IF;
       END $$;`,
    );
    console.log(`✓ 角色就绪: ${role}`);
  }
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  // 并发 migrate 互斥：会话级 advisory 锁（end 时自动释放，异常路径不残留）
  const lock = await client.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('workloom-migrate')) AS ok",
  );
  if (!lock.rows[0]?.ok) {
    console.error("迁移拒启：另一个 migrate 进程正在执行（advisory lock 未抢到）");
    await client.end();
    process.exit(1);
  }
  try {
    await ensureRoles(client);
    await client.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    // 账本补 sha256 校验列（历史已应用文件首次记录 checksum，不校验——只防此后漂移）
    await client.query("ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
    const applied = new Map(
      (await client.query<{ name: string; checksum: string | null }>("SELECT name, checksum FROM _migrations"))
        .rows.map((r) => [r.name, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    let count = 0;
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      const digest = sha256(sql);
      if (applied.has(file)) {
        const recorded = applied.get(file);
        if (recorded === null || recorded === undefined) {
          // 历史文件（checksum 列引入前应用）：补记 checksum，本次不校验
          await client.query("UPDATE _migrations SET checksum=$2 WHERE name=$1", [file, digest]);
          console.log(`– 跳过（已应用，补记 checksum）: ${file}`);
        } else if (recorded !== digest) {
          console.error(`迁移拒跑：已应用文件 ${file} 内容漂移（sha256 与账本不符）。迁移文件不可改，请新建迁移修复。`);
          process.exit(1);
        } else {
          console.log(`– 跳过（已应用）: ${file}`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [file, digest]);
        await client.query("COMMIT");
        count += 1;
        console.log(`✓ 已应用: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log(count === 0 ? "数据库已是最新。" : `迁移完成，共应用 ${count} 个文件。`);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('workloom-migrate'))").catch(() => undefined);
    await client.end();
  }
}

main().catch((err) => {
  console.error("迁移失败：", err?.message ?? err);
  process.exit(1);
});
