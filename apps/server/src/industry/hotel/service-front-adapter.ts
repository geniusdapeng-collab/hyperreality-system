/**
 * 酒店服务前台行业适配器。
 *
 * 本文件可以理解酒店的房型、入住、会员和客房部门；基座网关与通用对话层
 * 不得理解这些词。只有活动 Bundle 的完整性校验投影显式声明本适配器 id，
 * 注册表才会把请求路由到这里。全部业务读取仍经工作区 RLS 上下文。
 */
import { ensureServiceSchema } from "../../service/store.js";
import { svcQuery } from "../../service/events.js";
import {
  BusinessAdapterError,
  type BusinessContext,
  type ServiceFrontBusinessAdapter,
} from "../../service/adapters/business.js";

/** pg date 列可能是 Date 或字符串，统一输出 YYYY-MM-DD。 */
function dateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function moneyText(amountFen: unknown): string {
  const yuan = Number(amountFen) / 100;
  return `¥${new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(yuan)}`;
}

function statusText(value: unknown): string {
  const status = String(value).trim();
  if (/\p{Script=Han}/u.test(status)) return status;
  const labels: Record<string, string> = {
    created: "待确认",
    pending: "待确认",
    confirmed: "已确认",
    processing: "办理中",
    completed: "已完成",
    done: "已完成",
    cancelled: "已取消",
    canceled: "已取消",
  };
  return labels[status.toLowerCase()] ?? "状态待确认";
}

const BIND_HINT = "您还未绑定会员身份，完成手机号验证绑定后即可查询本人订单与会员信息。";
const DEMO_IDENTITY_CODE = "123456";

function benefitsOf(tier: string): string[] {
  if (tier.includes("白金")) return ["免费双人早餐", "延迟退房至 16:00", "行政酒廊礼遇", "积分 2 倍累积"];
  if (tier.includes("金")) return ["免费双人早餐", "延迟退房至 14:00", "积分 1.5 倍累积"];
  if (tier.includes("银")) return ["免费早餐", "积分 1.2 倍累积"];
  return ["积分累积"];
}

const RE_ORDER = /订单|预订|订房|入住记录|房费|账单/;
const RE_MEMBER = /会员|积分|等级|权益|余额/;
const RE_ROOM_RATE = /房价|房型|大床房|双床房|单人房|标准间|套房|海景房|钟点房/;

const HOTEL_DEPARTMENTS: Record<string, string> = {
  complaint: "客服部",
  repair: "工程部",
  delivery: "客房部",
  service_request: "客房部",
  consult: "前厅部",
  other: "前厅部",
};

export const hotelBizAdapter: ServiceFrontBusinessAdapter = {
  id: "hotel.service-front-v1",

  // 业务同义词与弱词归行业适配器所有；只有已验证活动 Bundle 选中本适配器后才生效。
  kbLexicon: {
    synonyms: [
      ["会员", "会员卡"], ["优惠", "折扣"], ["配送", "送货"], ["开票", "发票"], ["退换", "售后"],
    ],
    weakTokens: [
      "时间", "免费", "收费", "可以", "服务", "商品", "店铺", "半天", "一份", "一瓶", "东西", "地方",
      "怎么", "如何", "一下", "价格", "多少钱", "订单", "买家", "顾客", "客服", "工作", "两张", "一张", "几位", "一些",
    ],
  },

  classify(text) {
    if (RE_ROOM_RATE.test(text)) {
      return { tool: "query_catalog", answer: "为您查询到以下房型价格：" };
    }
    if (RE_MEMBER.test(text)) {
      return { tool: "query_member", answer: "为您查询到以下会员信息：" };
    }
    if (RE_ORDER.test(text)) {
      return { tool: "query_order", answer: "为您查询到以下订单：" };
    }
    return null;
  },

  ticketKind(text) {
    if (/维修|修|坏|故障|漏水|不制冷|不制热|空调|热水|马桶/.test(text)) return "repair";
    if (/送|拿|打扫|换床单|加一|多要|再来/.test(text)) return "delivery";
    return null;
  },

  departmentForTicket(kind) {
    return HOTEL_DEPARTMENTS[kind] ?? HOTEL_DEPARTMENTS.other!;
  },

  async queryOrder(ctx: BusinessContext) {
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
      orders: rows.map((row) => {
        const checkIn = dateStr(row.check_in);
        const checkOut = dateStr(row.check_out);
        const roomType = String(row.room_type);
        return {
          id: String(row.order_id),
          cardTitle: "我的住宿订单",
          title: `${roomType}住宿订单`,
          statusText: statusText(row.status),
          referenceText: `订单编号 ${String(row.order_id)}`,
          details: [
            { label: "房型", value: roomType },
            { label: "入住日期", value: checkIn },
            { label: "离店日期", value: checkOut },
          ],
          amountText: moneyText(row.amount_fen),
        };
      }),
      demo: true,
    };
  },

  async queryMember(ctx: BusinessContext) {
    await ensureServiceSchema();
    if (!ctx.memberId) {
      return { member: null, demo: true, bindRequired: true, hint: BIND_HINT };
    }
    const rows = await svcQuery(
      ctx.workspaceId,
      `SELECT member_id, name, tier, points FROM demo_members WHERE workspace_id=$1 AND member_id=$2`,
      [ctx.workspaceId, ctx.memberId],
    );
    const row = rows[0];
    return {
      member: row ? {
        title: `${String(row.tier)}会员`,
        metric: {
          label: "当前积分",
          value: new Intl.NumberFormat("zh-CN").format(Number(row.points)),
        },
        benefits: benefitsOf(String(row.tier)),
        demo: true,
      } : null,
      demo: true,
    };
  },

  async queryCatalog(ctx: BusinessContext) {
    await ensureServiceSchema();
    void ctx;
    return {
      cardTitle: "可订房型与价格",
      items: [
        { id: "RM-DLX-KING", title: "豪华大床房", priceText: "¥588 / 晚", details: [] },
        { id: "RM-EXE-TWIN", title: "行政双床房", priceText: "¥688 / 晚", details: [] },
        { id: "RM-VIEW-KING", title: "山景大床房", priceText: "¥528 / 晚", details: [] },
      ],
      demo: true,
    };
  },

  identity: {
    async requestCode() {
      return {
        state: "demo",
        message: `演示环境不会发送短信，请输入演示验证码 ${DEMO_IDENTITY_CODE}`,
        demoCode: DEMO_IDENTITY_CODE,
      };
    },

    async verifyCode(client, ctx, input) {
      if (input.code !== DEMO_IDENTITY_CODE) {
        throw new BusinessAdapterError("验证码不正确", 400, "INVALID_IDENTITY_CODE");
      }
      const matches = await client.query<{ member_id: string }>(
        `SELECT member_id FROM demo_members WHERE workspace_id=$1 AND phone=$2 ORDER BY member_id LIMIT 2`,
        [ctx.workspaceId, input.phone],
      );
      if (matches.rows.length === 0) {
        throw new BusinessAdapterError("未找到与该手机号匹配的业务身份", 404, "IDENTITY_NOT_FOUND");
      }
      if (matches.rows.length > 1) {
        throw new BusinessAdapterError("手机号对应多个业务身份，请联系服务方人工处理", 409, "IDENTITY_AMBIGUOUS");
      }
      return { subjectId: matches.rows[0]!.member_id, demo: true };
    },
  },
};
