/**
 * service · 业务查询适配器（酒店示例，packages 无关的服务端侧实现）
 * 契约：query_order / query_member / query_catalog / query_ticket 四个工具的统一适配口；
 * 本实现读本库 demo_orders / demo_members 演示数据（c_users.member_id 已绑定则按会员过滤）。
 * S4 PII 纪律：memberId 为空时 queryOrders/queryMember 一律返回空集 + bindRequired:true +
 * 绑定引导文案，禁止回退全量演示集（他人 PII 不得回灌给未绑定访客）；demo 标注保留。
 * 全部读写经 svcQuery（RLS 事务上下文）。
 */
import { ensureServiceSchema } from "../store.js";
import { svcQuery } from "../events.js";

export interface BizCtx { workspaceId: string; cUserId: string; memberId?: string | null }

export interface DemoOrder {
  orderId: string; roomType: string; checkIn: string; checkOut: string;
  amountYuan: number; status: string;
}
export interface DemoMember { memberId: string; name: string; tier: string; points: number }

/** pg date 列可能是 Date 或字符串，统一输出 YYYY-MM-DD */
function dateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export interface BizAdapter {
  queryOrder(ctx: BizCtx): Promise<{ orders: DemoOrder[]; demo: boolean; bindRequired?: boolean; hint?: string }>;
  queryMember(ctx: BizCtx): Promise<{ member: DemoMember | null; demo: boolean; bindRequired?: boolean; hint?: string }>;
  queryCatalog(ctx: BizCtx): Promise<{ items: Array<{ sku: string; name: string; priceYuan: number }>; demo: boolean }>;
  queryTicket(ctx: BizCtx, params: { ticketId?: string }): Promise<{ ticket: Record<string, unknown> | null; demo: boolean }>;
}

/** S4 未绑定统一应答：空集 + bindRequired:true + 绑定引导文案（不回退全量演示集） */
const BIND_HINT = "您还未绑定会员身份，完成手机号验证绑定后即可查询本人订单与会员信息。";

export const hotelBizAdapter: BizAdapter = {
  async queryOrder(ctx) {
    await ensureServiceSchema();
    if (!ctx.memberId) {
      return { orders: [], demo: true, bindRequired: true, hint: BIND_HINT };
    }
    const rows = await svcQuery(
      ctx.workspaceId,
      `SELECT order_id, room_type, check_in, check_out, amount_fen, status FROM demo_orders
       WHERE workspace_id=$1 AND member_id=$2 ORDER BY check_in DESC LIMIT 10`,
      [ctx.workspaceId, ctx.memberId],
    );
    return {
      orders: rows.map((x) => ({
        orderId: String(x.order_id), roomType: String(x.room_type),
        checkIn: dateStr(x.check_in), checkOut: dateStr(x.check_out),
        amountYuan: Number(x.amount_fen) / 100, status: String(x.status),
      })),
      demo: true,
    };
  },

  async queryMember(ctx) {
    await ensureServiceSchema();
    if (!ctx.memberId) {
      return { member: null, demo: true, bindRequired: true, hint: BIND_HINT };
    }
    const rows = await svcQuery(
      ctx.workspaceId,
      `SELECT member_id, name, tier, points FROM demo_members WHERE workspace_id=$1 AND member_id=$2`,
      [ctx.workspaceId, ctx.memberId],
    );
    const x = rows[0];
    return {
      member: x ? { memberId: String(x.member_id), name: String(x.name), tier: String(x.tier), points: Number(x.points) } : null,
      demo: true,
    };
  },

  async queryCatalog(ctx) {
    await ensureServiceSchema();
    void ctx;
    return {
      items: [
        { sku: "RM-DLX-KING", name: "豪华大床房", priceYuan: 588 },
        { sku: "RM-EXE-TWIN", name: "行政双床房", priceYuan: 688 },
        { sku: "RM-VIEW-KING", name: "山景大床房", priceYuan: 528 },
      ],
      demo: true,
    };
  },

  async queryTicket(ctx, params) {
    await ensureServiceSchema();
    if (!params.ticketId) return { ticket: null, demo: true };
    const rows = await svcQuery(
      ctx.workspaceId,
      `SELECT id, kind, title, status, dept, assignee, created_at FROM c_tickets WHERE workspace_id=$1 AND id=$2 AND c_user_id=$3`,
      [ctx.workspaceId, params.ticketId, ctx.cUserId],
    );
    return { ticket: rows[0] ?? null, demo: true };
  },
};

export type BizTool = "query_order" | "query_member" | "query_catalog" | "query_ticket";

export async function runBizTool(
  tool: BizTool,
  ctx: BizCtx,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (tool) {
    case "query_order": return hotelBizAdapter.queryOrder(ctx);
    case "query_member": return hotelBizAdapter.queryMember(ctx);
    case "query_catalog": return hotelBizAdapter.queryCatalog(ctx);
    case "query_ticket": return hotelBizAdapter.queryTicket(ctx, params as { ticketId?: string });
  }
}
