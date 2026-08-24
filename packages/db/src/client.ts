/**
 * 数据库连接与多租户上下文
 * 双连接池纪律（F1.2/L1.2）：
 *   - gateway 池（workloom_gateway）：唯一能 INSERT biz_events 的角色，专供安全网关使用
 *   - app 池（workloom_app）：其余全部读写；对 biz_events 只读（旁路直写被 DB 层拒绝）
 * RLS 口径（F7.1/L7.1）：每次请求在事务内 set_config app.workspace_id / app.tenant_id
 */
import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

let appPool: Pool | null = null;
let gatewayPool: Pool | null = null;
let ownerPool: Pool | null = null;

/**
 * owner 池（postgres/迁移账号，绕过 RLS）——唯一合法用途：登录引导。
 * 身份建立前无法 set_config 工作区上下文（鸡生蛋问题），登录时的 workspace 解析
 * 只能走 owner；除此处外任何业务代码禁用本池（F7.1 例外点，代码走查项）。
 */
export function getOwnerPool(url = process.env.DATABASE_URL): Pool {
  if (!url) throw new Error("缺少 DATABASE_URL（见 .env.example）");
  if (!ownerPool) ownerPool = makePool(url, 5, 30_000);
  return ownerPool;
}

export function getAppPool(url = process.env.DATABASE_APP_URL): Pool {
  if (!url) throw new Error("缺少 DATABASE_APP_URL（见 .env.example）");
  // 架构 L 修复：扩容 app 池（10→30），避免并发请求耗尽连接
  if (!appPool) appPool = makePool(url, 30, 15_000);
  return appPool;
}

export function getGatewayPool(url = process.env.DATABASE_GATEWAY_URL): Pool {
  if (!url) throw new Error("缺少 DATABASE_GATEWAY_URL（见 .env.example）");
  // 架构 L 修复：扩容 gateway 池（4→20），避免 withObjectLock 并发耗尽池阻塞所有事件写入
  if (!gatewayPool) gatewayPool = makePool(url, 20, 15_000);
  return gatewayPool;
}

/**
 * 三池统一加固（审计）：connectionTimeoutMillis 5s 快速失败；
 * statement_timeout 兜底慢查询（owner 池宽松到 30s：迁移/运维语句）；
 * pool.on('error') 只记日志不 crash（空闲连接异常不应打挂进程）。
 */
function makePool(connectionString: string, max: number, statementTimeoutMs: number): Pool {
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeoutMs,
  });
  pool.on("error", (err) => console.error("[db] 连接池空闲连接异常：", err.message));
  return pool;
}

export interface TenantScope {
  tenantId: string;
  workspaceId: string;
}

/**
 * 在工作区上下文内执行：事务内设置 RLS 变量 → 回调 → 提交；异常回滚。
 * 用法：await withWorkspace(appPool, scope, async (db) => db.select()...)
 */
export async function withWorkspace<T>(
  pool: Pool,
  scope: TenantScope,
  fn: (db: Db, client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const db = drizzle(client, { schema });
    const result = await fn(db, client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 优雅关闭（stop.sh / 测试用） */
export async function closeAllPools(): Promise<void> {
  await Promise.all([appPool?.end(), gatewayPool?.end(), ownerPool?.end()]);
  appPool = null;
  gatewayPool = null;
  ownerPool = null;
}
