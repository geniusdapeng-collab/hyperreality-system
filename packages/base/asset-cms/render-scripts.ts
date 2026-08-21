/**
 * asset-cms · 渲染脚本管理（fusion-design §6，render_scripts 表）
 *
 * 口径：
 *  - 提示词工程师交付后逐镜生成渲染脚本（MD + 25/30 字段 JSON + 字符数校验快照）入 v1
 *  - 每次人工/Agent 修改产生新版本（parent_version 链 + diff 摘要），版本即审批对象
 *  - approve 联动 G8 审批记录（approvals 行，渲染提交烧额度门，fusion-design §3 G8）
 *  - 一切写入经 workdata 安全网关落五元事件（D16：业务行与事件同一 COMMIT）
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

interface Scope { tenantId: string; workspaceId: string }

export const RENDER_SCRIPT_STATUSES = ["draft", "approved", "submitted", "rendering", "done", "failed"] as const;
export type RenderScriptStatus = (typeof RENDER_SCRIPT_STATUSES)[number];

export interface RenderScriptRow {
  id: string;
  workspace_id: string;
  project_id: string;
  shot_id: string;
  script_key: string;
  version: number;
  parent_version: number | null;
  status: RenderScriptStatus;
  md: string;
  fields: Record<string, unknown>;
  char_check: Record<string, unknown>;
  diff_summary: string | null;
  approved_event_id: string | null;
  created_by: string;
  created_at: string;
}

export class RenderScriptError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "NOT_DRAFT",
    message: string,
  ) {
    super(message);
    this.name = "RenderScriptError";
  }
}

/** 事务内事件留痕（D16：调用方持有事务，与脚本行同一 COMMIT） */
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
    object: { type: "render_script", id: objectId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

/** 创建初版（v1）：id = <scriptKey>-v1，status=draft */
export async function create(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: {
    scriptKey: string;
    projectId: string;
    shotId: string;
    md: string;
    /** 25/30 字段 JSON（规范唯一真源在 vendor，TS 层不复制字面值，红线 2） */
    fields?: Record<string, unknown>;
    /** 字符数校验快照（2470-3000/≤3000，由 PromptDeliveryGuard 产出） */
    charCheck?: Record<string, unknown>;
    by: string;
  },
): Promise<RenderScriptRow> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const id = `${input.scriptKey}-v1`;
    const ins = await client.query<RenderScriptRow>(
      `INSERT INTO render_scripts
         (id, workspace_id, project_id, shot_id, script_key, version, parent_version,
          status, md, fields, char_check, created_by)
       VALUES ($1,$2,$3,$4,$5,1,NULL,'draft',$6,$7,$8,$9)
       RETURNING *`,
      [
        id, scope.workspaceId, input.projectId, input.shotId, input.scriptKey,
        input.md, JSON.stringify(input.fields ?? {}), JSON.stringify(input.charCheck ?? {}), input.by,
      ],
    );
    // D16（#1/A）：脚本行与事件同一事务同一 COMMIT
    await emitInTx(client, scope, input.by, id, {
      action: "render_script.create",
      after: { scriptKey: input.scriptKey, projectId: input.projectId, shotId: input.shotId, version: 1 },
      basis: ["渲染脚本初版入库（§6：MD + 字段 JSON + 字符数校验快照）"],
    });
    await client.query("COMMIT");
    return ins.rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 新版本（parent_version 链 + diff 摘要）：保存即新版本（§6 本地编辑纪律）
 * 新版本回到 draft——上一版本的 approved 不继承，须重新过 G8（版本即审批对象）
 */
export async function newVersion(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  scriptKey: string,
  input: {
    md: string;
    fields?: Record<string, unknown>;
    charCheck?: Record<string, unknown>;
    /** 与 parent_version 的 diff 摘要（工作台展示用） */
    diffSummary: string;
    by: string;
  },
): Promise<RenderScriptRow> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const cur = await client.query<RenderScriptRow>(
      `SELECT * FROM render_scripts WHERE workspace_id=$1 AND script_key=$2 ORDER BY version DESC LIMIT 1`,
      [scope.workspaceId, scriptKey],
    );
    const head = cur.rows[0];
    if (!head) throw new RenderScriptError("NOT_FOUND", `渲染脚本 ${scriptKey} 不存在，须先 create`);
    const version = head.version + 1;
    const id = `${scriptKey}-v${version}`;
    const ins = await client.query<RenderScriptRow>(
      `INSERT INTO render_scripts
         (id, workspace_id, project_id, shot_id, script_key, version, parent_version,
          status, md, fields, char_check, diff_summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        id, scope.workspaceId, head.project_id, head.shot_id, scriptKey, version, head.version,
        input.md, JSON.stringify(input.fields ?? head.fields), JSON.stringify(input.charCheck ?? {}),
        input.diffSummary, input.by,
      ],
    );
    // D16（#1/A）：新版本行与事件同一事务同一 COMMIT
    await emitInTx(client, scope, input.by, id, {
      action: "render_script.new_version",
      after: { scriptKey, version, parentVersion: head.version, diffSummary: input.diffSummary },
      basis: [`版本链推进 v${head.version} → v${version}（§6：保存即新版本，版本即审批对象，approved 不继承）`],
    });
    await client.query("COMMIT");
    return ins.rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 审批通过（G8 联动）：draft → approved + approvals 行（版本快照即审批对象）
 * 渲染提交（render.submit）由 video-studio 适配层消费 approved 版本 + 围栏 G8 判定
 */
export async function approve(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  scriptKey: string,
  version: number,
  input: { by: string },
): Promise<{ script: RenderScriptRow; approvalId: string }> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const cur = await client.query<RenderScriptRow>(
      `SELECT * FROM render_scripts WHERE workspace_id=$1 AND script_key=$2 AND version=$3 FOR UPDATE`,
      [scope.workspaceId, scriptKey, version],
    );
    const row = cur.rows[0];
    if (!row) throw new RenderScriptError("NOT_FOUND", `渲染脚本 ${scriptKey} v${version} 不存在`);
    if (row.status !== "draft") {
      throw new RenderScriptError("NOT_DRAFT", `仅 draft 可审批（当前 ${row.status}）；版本即审批对象，须对新版本重新过 G8`);
    }
    // 先留痕拿事件 ID，再以事件 ID 派生审批单号（apr-e-<n>，同 skills registry 口径 #28）
    const eventId = await emitInTx(client, scope, input.by, row.id, {
      action: "render_script.approve",
      after: { scriptKey, version, projectId: row.project_id, shotId: row.shot_id },
      basis: ["G8 渲染脚本审批通过（§3 门矩阵：渲染提交烧额度前置门）"],
    });
    const approvalId = `apr-${eventId.toLowerCase()}`;
    await client.query(
      `UPDATE render_scripts SET status='approved', approved_event_id=$4
       WHERE workspace_id=$1 AND script_key=$2 AND version=$3`,
      [scope.workspaceId, scriptKey, version, eventId],
    );
    // G8 联动审批记录（approvals 原生消息类型，M5；快照=被审批版本）
    await client.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,'inapp','approved',$5,$6,now())`,
      [
        approvalId, scope.tenantId, scope.workspaceId, eventId,
        JSON.stringify({ kind: "render_script", scriptKey, version, scriptId: row.id, after: { md: row.md, fields: row.fields } }),
        input.by,
      ],
    );
    await client.query("COMMIT");
    return { script: { ...row, status: "approved", approved_event_id: eventId }, approvalId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 按项目列出全部脚本版本（工作台「片库·脚本」页数据源） */
export async function listByProject(app: pg.Pool, scope: Scope, projectId: string): Promise<RenderScriptRow[]> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<RenderScriptRow>(
      `SELECT * FROM render_scripts WHERE workspace_id=$1 AND project_id=$2 ORDER BY script_key, version`,
      [scope.workspaceId, projectId],
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
