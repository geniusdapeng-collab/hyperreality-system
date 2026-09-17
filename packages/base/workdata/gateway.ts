/**
 * workdata · 安全网关（B1 核心）：一切事件写入的三段瀑布（F1.2/L1.2）
 *
 *   ① 权限校验   —— Agent 未声明 fence_bindings 且发起写类动作 → 拒（F2.10 复查位）；
 *                   只读 preset 发起写类动作 → 拒（L9.1 复查位）
 *   ② PII 脱敏   —— maskDeep（pii.ts；占位符协议 [PII:KIND:hash8]）
 *   ③ 高风险授权 —— 高危 Agent（meta.high_risk=true，如 desktop-agent）的写类动作
 *                   必须携带 approvalRef（逐次授权，L3.5）；P1-8 起改查 approvals 表验真：
 *                   必须存在 + status='approved' + 未过期 + 与 object/action 匹配，伪造 ref 必拒
 *
 * 三段任一不过 → GatewayReject（不写库、留 reject 原因供调用方写「需介入」事件，L4.2）
 * 全过 → appendEvent（events.ts）落 append-only 事件库
 */
import type pg from "pg";
import { safeParseBusinessEvent, type BusinessEvent } from "@workloom/shared";
import {
  appendEventIdempotent,
  appendEventInTx,
  safeParseReplayAwareEvent,
  type AppendResult,
  type EventDraft,
} from "./events.js";
import { maskDeep } from "./pii.js";

/** 写类动作前缀（判定器完整版在 B4 围栏引擎；此处为网关复查位的最小集合） */
const WRITE_ACTION_PREFIXES = [
  "price.adjust",
  "order.refund",
  "review.reply",
  "content.draft",
  "content.publish",
  "refund.apply",
  "desktop.gui",
  "trigger.",
] as const;

/**
 * #5 修复：运行时可注册额外写类动作前缀（由围栏规则包装载时调用 registerWriteActions）。
 * 这样行业 Bundle 新增写类动作（如 inventory.adjust）后，网关段①权限校验能识别，
 * 不会因硬编码前缀未覆盖而放行未声明 fence_bindings 的 Agent 写动作（F2.10）。
 */
const extraWriteActions: Set<string> = new Set();
const extraWritePrefixes: string[] = [];

export function registerWriteActions(actions: string[]): void {
  for (const a of actions) {
    if (a.endsWith(".")) {
      extraWritePrefixes.push(a);
    } else {
      extraWriteActions.add(a);
    }
  }
}

export function isWriteAction(action: string): boolean {
  if (WRITE_ACTION_PREFIXES.some((p) => action === p || action.startsWith(p))) return true;
  if (extraWriteActions.has(action)) return true;
  if (extraWritePrefixes.some((p) => action.startsWith(p))) return true;
  return false;
}

/**
 * M5-system 白名单：已知系统组件 id。
 * type:'system' 的 actor 只有命中白名单才享有系统通道豁免（段①直接放行）；
 * 不在白名单的「system」按普通身份走全检查（readonly/fence_bindings 一个不少）。
 */
export const SYSTEM_ACTOR_WHITELIST = [
  "system",
  "model-router",
  "im-channels",
  "review-console",
  "night-shift",
  "captain",
  "service-c",
  "trigger-engine",
] as const;

export function isWhitelistedSystemActor(actor: ActorInfo): boolean {
  return actor.type === "system" && (SYSTEM_ACTOR_WHITELIST as readonly string[]).includes(actor.id);
}

export class GatewayReject extends Error {
  constructor(
    public readonly stage: "permission" | "pii" | "authorization",
    message: string,
  ) {
    super(message);
    this.name = "GatewayReject";
  }
}

export interface ActorInfo {
  /** who.id（agent preset_key 或 MEM-xxx 或 system 名） */
  id: string;
  type: "human" | "agent" | "system";
  /** Agent 专有：fence_bindings 声明（F2.10）；readonly preset（L9.1）；high_risk（L3.5） */
  fenceBindings?: string[];
  readonly?: boolean;
  highRisk?: boolean;
}

export interface GatewayContext {
  tenantId: string;
  workspaceId: string;
  actor: ActorInfo;
  /** 高风险授权的审批引用（事件 ID / approval_id），仅高危写动作需要 */
  approvalRef?: string;
  sessionId?: string | null;
}

export type { EventDraft } from "./events.js";

/** 段①：权限校验（纯函数，可单测） */
export function checkPermission(actor: ActorInfo, event: EventDraft): void {
  // #35 身份一致性：操作者声明（actor）与事件归因（who）必须同一主体——
  // 此前仅约定（全仓 26 处调用点人工保持一致），无机制防止分叉伪造留痕
  if (actor.id !== event.who.id || actor.type !== event.who.type) {
    throw new GatewayReject(
      "permission",
      `身份不一致：actor=${actor.type}:${actor.id} vs who=${event.who.type}:${event.who.id}，拒绝（防身份伪造留痕，G8 归因可信前提）`,
    );
  }
  const action = event.decision.action;
  // 人类权限矩阵在 B5（tenancy+鉴权）落地；白名单系统组件走系统通道豁免（M5）
  if (actor.type === "human" || isWhitelistedSystemActor(actor)) return;
  // 其余（agent + 未白名单的 system 伪装身份）走全检查
  if (!isWriteAction(action)) return; // 只读动作放行
  if (actor.readonly) {
    throw new GatewayReject(
      "permission",
      `只读 preset「${actor.id}」发起写类动作 ${action}，拒绝（L9.1）`,
    );
  }
  if (!actor.fenceBindings || actor.fenceBindings.length === 0) {
    throw new GatewayReject(
      "permission",
      `Agent「${actor.id}」未声明 fence_bindings，系统级禁写（F2.10），动作 ${action} 拒绝`,
    );
  }
}

/** 段③查询接口：pg.Pool / pg.PoolClient 均可（调用方须已持有 RLS 上下文事务） */
export type GatewayQueryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

interface ApprovalRow {
  status: string;
  snapshot: {
    expires_at?: string | null;
    object_type?: string;
    object_id?: string;
    action?: string;
    object?: { type?: string; id?: string };
  } | null;
}

/**
 * 段③：高风险授权（P1-8 验真版）
 * approvalRef 必须指向 approvals 表中真实存在的审批行，且：
 *  ① status = 'approved'；② 未过期（snapshot.expires_at 为空或未过）；
 *  ③ 与当前 object/action 匹配（snapshot 内绑定 object_id/action 须全等，
 *     宽松位 object_type 匹配对象类型即可；snapshot 无绑定字段视为通用授权放行）。
 * 伪造 apr-xxx（查无此行 / 状态不符 / 过期 / 对象不符）一律拒绝。
 */
export async function checkHighRiskAuthorization(
  db: GatewayQueryable,
  scope: { tenantId: string; workspaceId: string },
  actor: ActorInfo,
  event: EventDraft,
  approvalRef?: string,
): Promise<void> {
  if (actor.type !== "agent" || !actor.highRisk) return;
  if (!isWriteAction(event.decision.action)) return;
  if (!approvalRef) {
    throw new GatewayReject(
      "authorization",
      `高危 Agent「${actor.id}」的写类动作 ${event.decision.action} 缺少逐次授权引用（L3.5），须先走审批`,
    );
  }
  const r = await db.query<ApprovalRow>(
    `SELECT status, snapshot FROM approvals
     WHERE approval_id = $1 AND tenant_id = $2 AND workspace_id = $3`,
    [approvalRef, scope.tenantId, scope.workspaceId],
  );
  const row = r.rows[0];
  if (!row) {
    throw new GatewayReject(
      "authorization",
      `审批引用「${approvalRef}」在本工作区不存在（伪造引用拒绝，P1-8）`,
    );
  }
  if (row.status !== "approved") {
    throw new GatewayReject(
      "authorization",
      `审批「${approvalRef}」状态为 ${row.status}（非 approved，P1-8），拒绝放行`,
    );
  }
  const snap = row.snapshot ?? {};
  if (snap.expires_at && Date.parse(snap.expires_at) <= Date.now()) {
    throw new GatewayReject(
      "authorization",
      `审批「${approvalRef}」已过期（snapshot.expires_at=${snap.expires_at}，P1-8），须重新审批`,
    );
  }
  const snapObjectType = snap.object_type ?? snap.object?.type;
  const snapObjectId = snap.object_id ?? snap.object?.id;
  if (snapObjectType && snapObjectType !== event.object.type) {
    throw new GatewayReject(
      "authorization",
      `审批「${approvalRef}」绑定对象类型 ${snapObjectType} 与当前 ${event.object.type} 不符（P1-8），拒绝`,
    );
  }
  if (snapObjectId && snapObjectId !== event.object.id) {
    throw new GatewayReject(
      "authorization",
      `审批「${approvalRef}」绑定对象 ${snapObjectId} 与当前 ${event.object.id} 不符（P1-8），拒绝`,
    );
  }
  if (snap.action && snap.action !== event.decision.action) {
    throw new GatewayReject(
      "authorization",
      `审批「${approvalRef}」绑定动作 ${snap.action} 与当前 ${event.decision.action} 不符（P1-8），拒绝`,
    );
  }
}

/**
 * 网关主入口：三段瀑布 → 落库
 * @returns AppendResult（含 piiHits 留痕）
 * @throws GatewayReject（任一瀑布段拒绝；调用方可选择把拒绝写成「需介入」系统事件）
 */
export async function gatewayAppend(
  gateway: pg.Pool,
  ctx: GatewayContext,
  draft: EventDraft,
): Promise<AppendResult> {
  // 段① 权限
  checkPermission(ctx.actor, draft);
  // 段② 脱敏
  const masked = maskDeep(draft);
  const scope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId };
  // 段③ 高风险授权（P1-8 查 approvals 表）与事件落库并入同一事务：
  // 审批验真须在同一 RLS 上下文内完成，且与事件写同一 COMMIT 原子提交
  const client = await gateway.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await checkHighRiskAuthorization(client, scope, ctx.actor, masked.value, ctx.approvalRef);
    const result = await appendEventInTx(client, scope, { event: masked.value, sessionId: ctx.sessionId });
    await client.query("COMMIT");
    return { ...result, piiHits: masked.hits };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 事务内经三段瀑布追加事件（D16 核心入口）
 * 调用方必须已持有事务（BEGIN + set_config 双 GUC）——与业务状态写同一 COMMIT 原子提交（#1/A）。
 * 纯事件写场景请用 gatewayAppend（自带事务包装）。
 */
export async function gatewayAppendOnClient(
  client: pg.PoolClient,
  ctx: GatewayContext,
  draft: EventDraft,
): Promise<AppendResult> {
  // 段① 权限
  checkPermission(ctx.actor, draft);
  // 段② 脱敏
  const masked = maskDeep(draft);
  // 段③ 高风险授权（P1-8：复用调用方事务的 RLS 上下文查 approvals 验真）
  await checkHighRiskAuthorization(client, { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId }, ctx.actor, masked.value, ctx.approvalRef);
  // 事务内落库（append_event_insert 特权函数；append-only + 哈希链 + 幂等）
  const result = await appendEventInTx(
    client,
    { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId },
    { event: masked.value, sessionId: ctx.sessionId },
  );
  return { ...result, piiHits: masked.hits };
}

/** 回放/补偿场景的显式幂等写入（E3.3）：同样过三段瀑布（L6：段序统一先 zod 后权限） */
export async function gatewayAppendIdempotent(
  gateway: pg.Pool,
  ctx: GatewayContext,
  event: BusinessEvent,
): Promise<AppendResult> {
  const checked = safeParseReplayAwareEvent(event); // L6：先 zod 后权限（回放前缀 ID 走校验缝）
  if (!checked.success) throw new Error("事件未过附录 E 校验");
  checkPermission(ctx.actor, checked.data);
  const scope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId };
  // 段③（P1-8）需要 RLS 上下文事务查 approvals；仅在确需验真时开启（agent + highRisk + 写动作）
  if (ctx.actor.type === "agent" && ctx.actor.highRisk && isWriteAction(checked.data.decision.action)) {
    const client = await gateway.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await checkHighRiskAuthorization(client, scope, ctx.actor, checked.data, ctx.approvalRef);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return appendEventIdempotent(gateway, scope, checked.data, ctx.sessionId);
}
