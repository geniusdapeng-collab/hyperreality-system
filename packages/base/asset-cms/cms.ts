/**
 * asset-cms · 成片库 + 内容日历（fusion-design §5，video_assets kind='final_cut'）
 *
 *  - 成片元数据：平台/时长/关联 PRD/镜头包版本（meta JSONB，对象枚举由 bundles/ai-video 供给）
 *  - 内容日历：publish_at 排期；状态机 draft → scheduled → published → archived（非法跃迁拒绝）
 *  - 一切写入经 workdata 安全网关落五元事件（D16：业务行与事件同一 COMMIT）
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { register, AssetError, type AssetRow } from "./assets.js";

interface Scope { tenantId: string; workspaceId: string }

export type ContentStatus = "draft" | "scheduled" | "published" | "archived";

/* ---------- 状态机（纯函数：迁移合法性唯一事实源，同 night-shift 口径） ---------- */

const CONTENT_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  draft: ["scheduled", "archived"],
  scheduled: ["published", "draft"], // 回 draft = 取消排期
  published: ["archived"],
  archived: [],
};

export class ContentTransitionError extends Error {
  constructor(from: ContentStatus, to: ContentStatus) {
    super(`成片状态机非法迁移：${from} → ${to}（draft→scheduled→published→archived）`);
    this.name = "ContentTransitionError";
  }
}

export function assertContentTransition(from: ContentStatus, to: ContentStatus): void {
  if (!CONTENT_TRANSITIONS[from]?.includes(to)) throw new ContentTransitionError(from, to);
}

/** 事务内事件留痕（D16：调用方持有事务，与成片行同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  by: string,
  objectId: string,
  decision: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "system" },
  }, {
    who: { type: "system", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "final_cut", id: objectId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

/** 成片入库（kind=final_cut，status=draft；sha256 幂等去重继承 assets.register） */
export async function registerFinalCut(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: {
    id: string;
    projectId?: string;
    sourceUrl: string;
    sha256: string;
    /** 目标平台（platform 枚举对齐 publish-rpa types） */
    platforms: string[];
    durationSeconds: number;
    /** 关联 PRD（G4 确认产物，时长唯一权威） */
    prdId?: string;
    /** 镜头包/提示词包版本（G6 确认产物） */
    shotPackageVersion?: string;
    by: string;
  },
): Promise<{ asset: AssetRow; deduped: boolean }> {
  return register(app, gateway, scope, {
    id: input.id,
    projectId: input.projectId,
    kind: "final_cut",
    sourceUrl: input.sourceUrl,
    sha256: input.sha256,
    status: "draft",
    meta: {
      platforms: input.platforms,
      durationSeconds: input.durationSeconds,
      prdId: input.prdId ?? null,
      shotPackageVersion: input.shotPackageVersion ?? null,
    },
    by: input.by,
  });
}

/**
 * 状态推进（draft→scheduled→published→archived；scheduled 可回 draft 取消排期）
 *  - 排期（→scheduled）必须带 publishAt；取消排期（→draft）清空 publish_at
 *  - 非法跃迁抛 ContentTransitionError，不写库不留痕（状态机为唯一事实源）
 */
export async function transitionFinalCut(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  assetId: string,
  to: ContentStatus,
  input: { by: string; publishAt?: string },
): Promise<AssetRow> {
  if (to === "scheduled" && !input.publishAt) {
    throw new Error("排期（→scheduled）必须携带 publishAt");
  }
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const cur = await client.query<AssetRow>(
      `SELECT * FROM video_assets WHERE workspace_id=$1 AND id=$2 AND kind='final_cut' FOR UPDATE`,
      [scope.workspaceId, assetId],
    );
    const row = cur.rows[0];
    if (!row) throw new AssetError("NOT_FOUND", `成片 ${assetId} 不存在`);
    const from = row.status as ContentStatus;
    assertContentTransition(from, to);
    const publishAt = to === "scheduled" ? input.publishAt! : to === "draft" ? null : row.publish_at;
    const upd = await client.query<AssetRow>(
      `UPDATE video_assets SET status=$3, publish_at=$4 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [scope.workspaceId, assetId, to, publishAt],
    );
    // D16（#1/A）：状态推进与事件同一事务同一 COMMIT
    await emitInTx(client, scope, input.by, assetId, {
      action: "content.transition",
      after: { assetId, from, to, publishAt },
      basis: [`成片状态机 ${from} → ${to}（draft→scheduled→published→archived）`],
    });
    await client.query("COMMIT");
    return upd.rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 内容日历：窗口内已排期成片（publish_at 升序；越权返回空，L7.1 同源 RLS 兜底） */
export async function contentCalendar(
  app: pg.Pool,
  scope: Scope,
  window: { from: string; to: string },
): Promise<AssetRow[]> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<AssetRow>(
      `SELECT * FROM video_assets
       WHERE workspace_id=$1 AND kind='final_cut' AND publish_at >= $2::timestamptz AND publish_at <= $3::timestamptz
       ORDER BY publish_at ASC`,
      [scope.workspaceId, window.from, window.to],
    );
    await client.query("COMMIT");
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
