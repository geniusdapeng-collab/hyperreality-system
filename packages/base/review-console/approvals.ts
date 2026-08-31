/**
 * review-console · 统一审批队列与三手势回写（B6，F5.1–F5.7）
 *
 * 口径（PRD M5 原文锚点）：
 *  - 统一队列：全来源待审（Quest 越围栏挂起/夜班决策包/触发器动作）一处汇聚（F5.1）
 *  - 三手势：采纳(权重1) / 编辑后采纳(权重2，须带 edited_after) / 驳回(权重3，必填原因
 *    枚举+自由文本 ≤200 字，空理由被拒 L5.2)
 *  - 幂等：UNIQUE(event_id,channel)；重复回调只处理首次（L5.3，返回 deduped 不报错）
 *  - 快照过期（F5.7/E5.3）：snapshot.expires_at 过期 → 标 expired 并拒绝手势
 *  - 高危项（block 级）不存在超时自动放行（L5.4）：expireSweep 跳过
 *  - 权限（L5.1/L5.5）：readonly 角色审批 → 403（服务端强制，前端隐藏非置灰）
 *  - 手势回写（F5.5）：手势事件经安全网关落库；驳回原因枚举回流偏好模式（F1.7 校准闭环）
 */
import type pg from "pg";
import {
  APPROVAL_LIMITS,
  GESTURE_WEIGHT,
  type ApprovalStatus,
  type BusinessEvent,
  type Gesture,
  type MemberRole,
} from "@workloom/shared";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { upsertMemory, upsertMemoryInTx, MockEmbedder, type Embedder } from "../workdata/memory.js";
import { assertEditKindValid, assertReasonEnumAllowed, type EditKind } from "../evolve/feedback-enums.js";

/* ================= 类型 ================= */

export interface ApprovalRow {
  approval_id: string;
  event_id: string;
  channel: string;
  status: ApprovalStatus;
  gesture: { type: Gesture; weight: number; reason_enum?: string; reason_text?: string; edited_after?: unknown; edit_kind?: string } | null;
  snapshot: { before?: unknown; after?: unknown; expires_at?: string; high_risk?: boolean };
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  /** 队列投影附带：被审批事件（diff/规则版本/影响面，F5.1/F5.3） */
  event?: BusinessEvent;
}

export class ApprovalError extends Error {
  constructor(
    public readonly code: "FORBIDDEN_ROLE" | "EMPTY_REASON" | "REASON_TOO_LONG" | "EDIT_REQUIRES_AFTER" | "EXPIRED" | "NOT_FOUND" | "INVALID_GESTURE",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
  get statusCode(): number {
    return this.code === "FORBIDDEN_ROLE" ? 403 : 400;
  }
}

/* ================= 手势校验（纯函数） ================= */

export interface GestureInput {
  type: Gesture;
  reasonEnum?: string;
  reasonText?: string;
  editedAfter?: unknown;
  /** M1.3 归因分流（D24 修订 3）：纠错→缺陷池 / 口味→偏好池；仅 edit 手势有意义 */
  editKind?: EditKind;
}

export function validateGesture(g: GestureInput): void {
  // #41 修复：手势类型白名单——此前不校验 type 本身，非法手势（通道侧异常/伪造
  // 回调传来 "bogus" 等）会穿透到 decide 的状态映射（approve/edit 之外一律落 rejected），
  // 被静默当作「驳回」写库，且绕过 L5.2 驳回原因必填校验
  if (g.type !== "approve" && g.type !== "edit" && g.type !== "reject") {
    throw new ApprovalError("INVALID_GESTURE", `非法手势类型「${String(g.type)}」（仅 approve/edit/reject，L5.2）`);
  }
  if (g.type === "reject") {
    // L5.2：驳回必填原因（枚举+自由文本 ≤200 字），空理由被拒
    if (!g.reasonEnum || g.reasonEnum.trim() === "") {
      throw new ApprovalError("EMPTY_REASON", "驳回必须选择原因枚举（L5.2）");
    }
    const text = g.reasonText ?? "";
    if (text.length > APPROVAL_LIMITS.rejectReasonMaxChars) {
      throw new ApprovalError("REASON_TOO_LONG", `驳回原因自由文本 ≤${APPROVAL_LIMITS.rejectReasonMaxChars} 字（L5.2）`);
    }
  }
  if (g.type === "edit" && g.editedAfter === undefined) {
    throw new ApprovalError("EDIT_REQUIRES_AFTER", "编辑后采纳必须携带 edited_after 新值（F5.2）");
  }
  // M1.3（D24）：editKind 白名单校验（纠错/口味二分，非法值拒绝）
  assertEditKindValid(g.editKind);
}

/** 审批人角色校验（L5.1/L5.5：服务端强制 403） */
export function assertApproverRole(role: MemberRole): void {
  if (role === "readonly") {
    throw new ApprovalError("FORBIDDEN_ROLE", "readonly 角色无审批权限（L5.1/L5.5，服务端 403）");
  }
}

/* ================= 队列查询（F5.1） ================= */

async function scoped<T>(
  pool: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function listQueue(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  opts: { status?: ApprovalStatus; limit?: number } = {},
): Promise<ApprovalRow[]> {
  return scoped(app, scope, async (c) => {
    const r = await c.query<ApprovalRow & { payload?: BusinessEvent }>(
      `SELECT a.*, e.payload
       FROM approvals a
       LEFT JOIN biz_events e ON e.tenant_id = a.tenant_id AND e.event_id = a.event_id
       WHERE a.workspace_id = $1 ${opts.status ? "AND a.status = $2" : ""}
       ORDER BY a.created_at DESC
       LIMIT ${Math.min(opts.limit ?? 50, 200)}`,
      opts.status ? [scope.workspaceId, opts.status] : [scope.workspaceId],
    );
    return r.rows.map((row) => ({ ...row, event: row.payload }));
  });
}

/* ================= 三手势回写（F5.2/F5.5，L5.3 幂等） ================= */

export interface DecideResult {
  approvalId: string;
  status: ApprovalStatus;
  /** true = 重复回调，只处理首次（L5.3） */
  deduped: boolean;
  gestureEventId?: string;
}

export async function decide(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  actor: { memberNo: string; role: MemberRole },
  approvalId: string,
  gesture: GestureInput,
  embedder: Embedder = new MockEmbedder(),
): Promise<DecideResult> {
  // L5.1/L5.5 角色校验 + L5.2 手势校验（先校验，不碰库）
  assertApproverRole(actor.role);
  validateGesture(gesture);
  // M1.2（D24 修订 3）：工作区已装配行业反馈枚举表（Bundle 第⑧槽）时，
  // 驳回原因必须命中受控词表——自由文本无法聚类，校准信号的可信度前提是受控枚举
  if (gesture.type === "reject" && gesture.reasonEnum) {
    assertReasonEnumAllowed(scope.workspaceId, gesture.reasonEnum);
  }

  // scoped 已包裹显式事务（BEGIN→set_config→COMMIT/ROLLBACK），本函数内不再自行开关事务；
  // 过期分支需要「标 expired 落库 + 抛 EXPIRED」——先提交事务再抛，避免 catch 回滚掉过期标记
  const txResult = await scoped(app, scope, async (c) => {
    const cur = await c.query<ApprovalRow>(
      `SELECT * FROM approvals WHERE approval_id=$1 AND workspace_id=$2 FOR UPDATE`,
      [approvalId, scope.workspaceId],
    );
    const row = cur.rows[0];
    if (!row) throw new ApprovalError("NOT_FOUND", `审批 ${approvalId} 不存在`);

    // L5.3：非 pending 一律视为重复回调，只处理首次
    if (row.status !== "pending") {
      return { kind: "deduped" as const, row };
    }

    // #43 修复：同事件跨通道幂等——UNIQUE(event_id,channel) 允许 inapp/dingtalk 各一行，
    // 此前两通道可各批一次（同一动作双批双留痕）。锁同事件全部审批行（FOR UPDATE
    // 阻塞并发他通道 decide 至本事务提交），任一他行已终态即按重复回调处理
    const siblings = await c.query<{ approval_id: string; status: ApprovalStatus }>(
      `SELECT approval_id, status FROM approvals WHERE event_id=$1 AND workspace_id=$2 AND approval_id<>$3 FOR UPDATE`,
      [row.event_id, scope.workspaceId, approvalId],
    );
    const decidedElsewhere = siblings.rows.find((x) => x.status !== "pending");
    if (decidedElsewhere) {
      return { kind: "deduped" as const, row: { ...row, status: decidedElsewhere.status } };
    }

    // F5.7/E5.3：快照过期检测（高危项不存在超时自动放行，L5.4）
    const expiresAt = row.snapshot?.expires_at ? new Date(row.snapshot.expires_at) : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      await c.query(
        `UPDATE approvals SET status='expired' WHERE approval_id=$1`,
        [approvalId],
      );
      return { kind: "expired" as const, row, expiresAt };
    }

    const status: ApprovalStatus =
      gesture.type === "approve" ? "approved" : gesture.type === "edit" ? "edited" : "rejected";
    await c.query(
      `UPDATE approvals
       SET status=$2, gesture=$3, decided_by=$4, decided_at=now()
       WHERE approval_id=$1 AND status='pending'`,
      [
        approvalId,
        status,
        JSON.stringify({
          type: gesture.type,
          weight: GESTURE_WEIGHT[gesture.type],
          reason_enum: gesture.reasonEnum,
          reason_text: gesture.reasonText,
          edited_after: gesture.editedAfter,
          edit_kind: gesture.editKind,
        }),
        actor.memberNo,
      ],
    );

    // D16（#1/A）：状态变更、手势事件、校准记忆全部在同一事务同一 COMMIT——
    // 不再存在「状态已改、事件/记忆未落」的崩溃孤儿窗口
    // F5.5 手势回写：事件库（经安全网关；人类手势动作）
    const gres = await gatewayAppendOnClient(c, {
      ...scope,
      actor: { id: actor.memberNo, type: "human" },
    }, {
      who: { type: "human", id: actor.memberNo },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "review", id: row.event_id },
      decision: {
        action: "approval.gesture",
        after: {
          approvalId,
          gesture: gesture.type,
          weight: GESTURE_WEIGHT[gesture.type],
          reason_enum: gesture.reasonEnum,
          edited_after: gesture.editedAfter,
          edit_kind: gesture.editKind,
        },
        basis: gesture.reasonText ? [gesture.reasonText] : undefined,
      },
      rule_impact: [],
      links: [row.event_id],
    });

    // F1.7 校准闭环：驳回原因枚举 → 偏好模式记忆（机制位；权重衰减在数据大脑侧）
    if (gesture.type === "reject" && gesture.reasonEnum) {
      await upsertMemoryInTx(c, scope, {
        memoryId: `mem-reject-${gesture.reasonEnum}`,
        scope: "workspace",
        kind: "preference",
        content: `驳回偏好模式：原因枚举「${gesture.reasonEnum}」被采纳为校准信号（最新来源 ${gres.eventId}）`,
        sourceEvents: [gres.eventId],
        confidence: 0.6,
      }, embedder);
      // M3/M4：memory_usage 已入 RLS（workspace_id 列），必须带本工作区键落库——
      // 缺列时 workspace_id 为 NULL，WITH CHECK 不通过（RLS 42501）
      await c.query(
        `INSERT INTO memory_usage (memory_id, event_id, workspace_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [`mem-reject-${gesture.reasonEnum}`, gres.eventId, scope.workspaceId],
      );
    }
    return { kind: "decided" as const, row, status, gestureEventId: gres.eventId };
  });

  if (txResult.kind === "deduped") {
    return { approvalId, status: txResult.row.status, deduped: true };
  }
  if (txResult.kind === "expired") {
    throw new ApprovalError("EXPIRED", `快照已过期（${txResult.expiresAt.toISOString()}），审批标记 expired（E5.3/F5.7）`);
  }
  return { approvalId, status: txResult.status, deduped: false, gestureEventId: txResult.gestureEventId };
}

/* ================= 批量采纳（F5.2；仅非高危，P4 原型口径） ================= */

export async function batchApprove(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  actor: { memberNo: string; role: MemberRole },
  approvalIds: string[],
): Promise<{ approved: string[]; skipped: Array<{ id: string; reason: string }> }> {
  assertApproverRole(actor.role);
  const approved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of approvalIds) {
    const rows = await scoped(app, scope, (c) =>
      c.query<ApprovalRow>(`SELECT * FROM approvals WHERE approval_id=$1 AND workspace_id=$2`, [id, scope.workspaceId]),
    );
    const row = rows.rows[0];
    if (!row) { skipped.push({ id, reason: "不存在" }); continue; }
    if (row.status !== "pending") { skipped.push({ id, reason: `已处理（${row.status}）` }); continue; }
    if (row.snapshot?.high_risk) { skipped.push({ id, reason: "高危项不可批量采纳（须逐条）" }); continue; }
    try {
      await decide(app, gateway, scope, actor, id, { type: "approve" });
      approved.push(id);
    } catch (err) {
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { approved, skipped };
}

/* ================= 超时升级（F5.7；高危项不自动放行 L5.4） ================= */

export async function expireSweep(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
): Promise<{ expired: string[]; keptHighRisk: string[] }> {
  const pend = await scoped(app, scope, async (c) => {
    const r = await c.query<ApprovalRow>(
      `SELECT * FROM approvals WHERE workspace_id=$1 AND status='pending'`,
      [scope.workspaceId],
    );
    return r.rows;
  });
  const expired: string[] = [];
  const keptHighRisk: string[] = [];
  for (const row of pend) {
    const exp = row.snapshot?.expires_at ? new Date(row.snapshot.expires_at) : null;
    if (!exp || exp.getTime() >= Date.now()) continue;
    if (row.snapshot?.high_risk) {
      keptHighRisk.push(row.approval_id); // L5.4：高危项超时标提醒但不放行不expired跳过
      continue;
    }
    // 铁律 1：状态变更必经网关写事件（#10 修复；此前 expireSweep 只改表不写事件，违反 F1.2）
    // D16（#1/A）：expired 状态与过期事件同一事务提交——不再存在状态已变、事件未落的孤儿窗口
    await scoped(app, scope, async (c) => {
      await c.query(`UPDATE approvals SET status='expired' WHERE approval_id=$1`, [row.approval_id]);
      await gatewayAppendOnClient(c, {
        tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        actor: { id: "review-console", type: "system" },
      }, {
        who: { type: "system", id: "review-console" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "approval", id: row.approval_id },
        decision: {
          action: "approval.expired",
          after: { approval_id: row.approval_id, event_id: row.event_id, expires_at: row.snapshot?.expires_at },
          basis: ["超时未审批，系统标记 expired（F5.7/E5.3；高危项不自动放行 L5.4）"],
        },
        rule_impact: [],
      });
    });
    expired.push(row.approval_id);
  }
  return { expired, keptHighRisk };
}
