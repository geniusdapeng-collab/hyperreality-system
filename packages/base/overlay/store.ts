/**
 * overlay/store.ts —— 租户覆盖层 DB 存储（方案 V1.1：DB 为主 + 可导出快照）
 *
 * 纪律：租户隔离走 RLS（workspace_id 上下文由调用方在事务内 set_config）；
 *      overlay_version 单调递增（只增不改，历史版本全部留档）；
 *      进入 active 自动留快照（一键回滚=恢复快照并新版本号激活）；
 *      全部写操作经 parseOverlay 校验（宁拒不错收）。
 */
import type pg from "pg";
import { OverlayDoc, OverlayError, OverlayStatus, parseOverlay } from "./model.js";

export interface OverlayScope { workspaceId: string; tenantId: string }

type Q = Pick<pg.PoolClient, "query"> | Pick<pg.Pool, "query">;

/**
 * 覆盖层事务上下文（HP-01）：
 * RLS 策略读的是**事务级** GUC（app.workspace_id / app.tenant_id，set_config(..., true)），
 * 因此覆盖层的每一次读写都必须在 `BEGIN + set_config` 的显式事务里执行——
 * 直接用连接池查询（autocommit）会因 GUC 为空而恒 0 行 / 插入被拒（fail-closed 但功能不可用），
 * 更要命的是会掩盖"到底有没有租户隔离"的事实。本函数是覆盖层 DB 访问的唯一入口包装。
 */
export async function withOverlayTx<T>(
  pool: Pick<pg.Pool, "connect">,
  scope: OverlayScope,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 同一 (workspace, tenant, base_bundle) 的版本分配与状态流转串行化。
 * 事务级 advisory 锁：同一事务内可重入；非事务调用（autocommit）等价 no-op，
 * 由唯一约束 + 重试兜底（不静默吞错）。
 */
async function lockOverlayKey(q: Q, scope: OverlayScope, baseBundle: string): Promise<void> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
    // \u001f（unit separator）作分隔符：PostgreSQL 文本不允许 \u0000
    `${scope.workspaceId}\u001f${scope.tenantId}\u001f${baseBundle}`,
    "workloom.tenant_overlay",
  ]);
}

interface Row {
  tenant_id: string; base_bundle: string; base_version: string;
  overlay_version: number; status: OverlayStatus; canary_scope: unknown;
  items: unknown; note: string | null;
}

function rowToDoc(r: Row): OverlayDoc {
  return parseOverlay({
    tenant_id: r.tenant_id, base_bundle: r.base_bundle, base_version: r.base_version,
    overlay_version: r.overlay_version, status: r.status,
    canary_scope: r.canary_scope ?? undefined, items: r.items, note: r.note ?? undefined,
  });
}

/** 读取当前生效的覆盖层（active；canary 由调用方按灰度判定另行加载） */
export async function loadActiveOverlay(
  q: Q, scope: OverlayScope, baseBundle: string,
): Promise<OverlayDoc | null> {
  const r = await q.query<Row>(
    `SELECT tenant_id, base_bundle, base_version, overlay_version, status, canary_scope, items, note
       FROM tenant_overlays
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND status='active'
      ORDER BY overlay_version DESC LIMIT 1`,
    [scope.workspaceId, scope.tenantId, baseBundle],
  );
  return r.rows[0] ? rowToDoc(r.rows[0]) : null;
}

/** 读取当前灰度中的覆盖层（canary；无则 null） */
export async function loadCanaryOverlay(
  q: Q, scope: OverlayScope, baseBundle: string,
): Promise<OverlayDoc | null> {
  const r = await q.query<Row>(
    `SELECT tenant_id, base_bundle, base_version, overlay_version, status, canary_scope, items, note
       FROM tenant_overlays
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND status='canary'
      ORDER BY overlay_version DESC LIMIT 1`,
    [scope.workspaceId, scope.tenantId, baseBundle],
  );
  return r.rows[0] ? rowToDoc(r.rows[0]) : null;
}

/** 新版本落草稿（overlay_version 自动 +1；返回落库后的文档） */
export async function saveDraft(
  q: Q, scope: OverlayScope,
  input: Omit<OverlayDoc, "overlay_version" | "status"> & { createdBy?: string },
): Promise<OverlayDoc> {
  // 版本号外的字段先全量校验（宁拒不错收）；版本号由下面的原子语句分配
  parseOverlay({ ...input, overlay_version: 1, status: "draft" });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await lockOverlayKey(q, scope, input.base_bundle);
    try {
      // 单语句完成 MAX+1 与插入：并发下要么拿到不同版本号，要么唯一约束（23505）后重试，
      // 不再出现"两个请求读到同一个 MAX → 一个用户操作直接报错"的竞态。
      const r = await q.query<{ overlay_version: number }>(
        `INSERT INTO tenant_overlays
           (workspace_id, tenant_id, base_bundle, base_version, overlay_version, status, canary_scope, items, note, created_by)
         SELECT $1,$2,$3,$4, COALESCE(MAX(overlay_version),0)+1, 'draft', $5,$6,$7,$8
           FROM tenant_overlays
          WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3
         RETURNING overlay_version`,
        [scope.workspaceId, scope.tenantId, input.base_bundle, input.base_version,
         input.canary_scope ? JSON.stringify(input.canary_scope) : null,
         JSON.stringify(input.items), input.note ?? null, input.createdBy ?? null],
      );
      const version = Number(r.rows[0]?.overlay_version);
      if (!Number.isInteger(version) || version < 1) {
        throw new OverlayError("STATUS_ILLEGAL", "覆盖层版本号分配失败（未返回版本号）");
      }
      return parseOverlay({ ...input, overlay_version: version, status: "draft" });
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new OverlayError("STATUS_ILLEGAL", "覆盖层版本号分配并发冲突");
}

/** 状态流转（完整流水线：draft→canary→active，不可跳级；*→rolled_back）
 *  注：回滚是唯一的直激活例外（见 rollbackToLatestSnapshot——回滚不停灰度，避免二次事故窗） */
const TRANSITIONS: Record<OverlayStatus, OverlayStatus[]> = {
  draft: ["canary", "rolled_back"],
  canary: ["active", "rolled_back"],
  active: ["rolled_back"],
  rolled_back: [],
};

export async function transition(
  q: Q, scope: OverlayScope, baseBundle: string, version: number, to: OverlayStatus,
): Promise<OverlayDoc> {
  await lockOverlayKey(q, scope, baseBundle);
  const cur = await q.query<Row & { status: OverlayStatus }>(
    `SELECT tenant_id, base_bundle, base_version, overlay_version, status, canary_scope, items, note
       FROM tenant_overlays
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND overlay_version=$4`,
    [scope.workspaceId, scope.tenantId, baseBundle, version],
  );
  const row = cur.rows[0];
  if (!row) throw new OverlayError("STATUS_ILLEGAL", `覆盖层 v${version} 不存在（${scope.tenantId}/${baseBundle}）`);
  if (!TRANSITIONS[row.status].includes(to)) {
    throw new OverlayError("STATUS_ILLEGAL", `非法状态流转：${row.status} → ${to}`);
  }
  const doc = rowToDoc({ ...row });
  // canary 校验（必须带灰度范围）
  const next = parseOverlay({ ...doc, status: to });
  // 进入 active：先作废旧 active，再激活目标——顺序固定，
  // 配合 0035 的"每 (tenant, bundle) 最多一个 active"部分唯一索引，双 active 无法旁路产生。
  if (to === "active") {
    await q.query(
      `UPDATE tenant_overlays SET status='rolled_back', updated_at=now()
        WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND status='active' AND overlay_version<>$4`,
      [scope.workspaceId, scope.tenantId, baseBundle, version],
    );
  }
  // 状态比较交换（CAS）：并发双击/并发流转只有一个能把行从 row.status 推到目标态
  const upd = await q.query(
    `UPDATE tenant_overlays SET status=$5, updated_at=now()
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND overlay_version=$4 AND status=$6`,
    [scope.workspaceId, scope.tenantId, baseBundle, version, to, row.status],
  );
  if (upd.rowCount === 0) {
    throw new OverlayError("STATUS_ILLEGAL",
      `并发状态流转冲突：覆盖层 v${version} 已不在 ${row.status}（其他操作已改变其状态）`);
  }
  // 进入 active：留快照
  if (to === "active") {
    await q.query(
      `INSERT INTO tenant_overlay_snapshots (workspace_id, tenant_id, base_bundle, overlay_version, doc)
       VALUES ($1,$2,$3,$4,$5)`,
      [scope.workspaceId, scope.tenantId, baseBundle, version, JSON.stringify(next)],
    );
  }
  return next;
}

/** 一键回滚：恢复最近快照并以新版本号直接置 active（回滚本身留审计） */
export async function rollbackToLatestSnapshot(
  q: Q, scope: OverlayScope, baseBundle: string, actor?: string,
): Promise<OverlayDoc> {
  await lockOverlayKey(q, scope, baseBundle);
  const snap = await q.query<{ overlay_version: number; doc: unknown }>(
    `SELECT overlay_version, doc FROM tenant_overlay_snapshots
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3
      ORDER BY overlay_version DESC LIMIT 1`,
    [scope.workspaceId, scope.tenantId, baseBundle],
  );
  const row = snap.rows[0];
  if (!row) throw new OverlayError("STATUS_ILLEGAL", `无可回滚快照（${scope.tenantId}/${baseBundle}）`);
  const snapDoc = row.doc as Omit<OverlayDoc, "overlay_version" | "status">;
  const draft = await saveDraft(q, scope, { ...snapDoc, note: `回滚自 v${row.overlay_version} 快照`, createdBy: actor });
  // 回滚直激活（唯一跳级例外：回滚本身就是止血动作，不应在灰度里再泡一轮）
  // 先清退旧 active，再以 CAS 激活本次回滚版本（并发回滚只有一个赢家）
  await q.query(
    `UPDATE tenant_overlays SET status='rolled_back', updated_at=now()
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND status='active'`,
    [scope.workspaceId, scope.tenantId, baseBundle],
  );
  const activated = await q.query(
    `UPDATE tenant_overlays SET status='active', updated_at=now()
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND overlay_version=$4 AND status='draft'`,
    [scope.workspaceId, scope.tenantId, baseBundle, draft.overlay_version],
  );
  if (activated.rowCount === 0) {
    throw new OverlayError("STATUS_ILLEGAL",
      `回滚激活失败：v${draft.overlay_version} 未停留在 draft（并发状态流转冲突）`);
  }
  await q.query(
    `INSERT INTO tenant_overlay_snapshots (workspace_id, tenant_id, base_bundle, overlay_version, doc)
     VALUES ($1,$2,$3,$4,$5)`,
    [scope.workspaceId, scope.tenantId, baseBundle, draft.overlay_version,
     JSON.stringify({ ...draft, status: "active" })],
  );
  return { ...draft, status: "active" };
}

/** 导出快照（客户资产归属叙事：一键导出完整 JSON） */
export async function exportSnapshot(
  q: Q, scope: OverlayScope, baseBundle: string,
): Promise<{ exported_at: string; doc: OverlayDoc } | null> {
  const doc = await loadActiveOverlay(q, scope, baseBundle);
  return doc ? { exported_at: new Date().toISOString(), doc } : null;
}

/** 版本历史（管理台用） */
export async function listVersions(
  q: Q, scope: OverlayScope, baseBundle: string, limit = 20,
): Promise<Array<{ overlay_version: number; status: OverlayStatus; updated_at: string }>> {
  const r = await q.query<{ overlay_version: number; status: OverlayStatus; updated_at: string }>(
    `SELECT overlay_version, status, updated_at FROM tenant_overlays
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3
      ORDER BY overlay_version DESC LIMIT $4`,
    [scope.workspaceId, scope.tenantId, baseBundle, limit],
  );
  return r.rows;
}
/** 健康汇总（晨报/健康分数据源）：覆盖层滞留与状态一目了然
 *  - staleDraft：草稿超 3 天未进灰度（定制需求被搁置）
 *  - staleCanary：灰度超 7 天未转全量（灰度泡太久，要么放行要么回滚） */
export async function healthSummary(
  q: Q, scope: OverlayScope,
): Promise<Array<{ base_bundle: string; active: number; canary: number; draft: number; staleDraft: number; staleCanary: number }>> {
  const r = await q.query<{ base_bundle: string; status: OverlayStatus; updated_at: string }>(
    `SELECT base_bundle, status, updated_at FROM tenant_overlays
      WHERE workspace_id=$1 AND tenant_id=$2`,
    [scope.workspaceId, scope.tenantId],
  );
  const now = Date.now();
  const byBundle = new Map<string, { active: number; canary: number; draft: number; staleDraft: number; staleCanary: number }>();
  for (const row of r.rows) {
    const b = byBundle.get(row.base_bundle) ?? { active: 0, canary: 0, draft: 0, staleDraft: 0, staleCanary: 0 };
    const ageDays = (now - new Date(row.updated_at).getTime()) / 86_400_000;
    if (row.status === "active") b.active++;
    if (row.status === "canary") { b.canary++; if (ageDays > 7) b.staleCanary++; }
    if (row.status === "draft") { b.draft++; if (ageDays > 3) b.staleDraft++; }
    byBundle.set(row.base_bundle, b);
  }
  return [...byBundle.entries()].map(([base_bundle, v]) => ({ base_bundle, ...v }));
}
