/** 内置演示数据：API 不可达时优雅降级使用（UI 会标注「演示数据」）。品牌文案一律读配置，无硬编码。 */
import { getConfig } from "./config";
import type { MemberInfo, NotificationItem, Order, TimelineItem, Ticket } from "./types";

export const DEMO_FLAG = "演示数据";

export function getDemoOrders(): Order[] {
  const brand = getConfig().brandName;
  return [
    {
      id: "ORD-20260820-001",
      title: `${brand}豪华大床房 · 2 晚`,
      status: "已入住",
      checkIn: "2026-08-22",
      roomType: "豪华大床房",
      amount: 1376,
    },
    {
      id: "ORD-20260815-002",
      title: "云端行政套房 · 1 晚",
      status: "已完成",
      checkIn: "2026-08-15",
      roomType: "行政套房",
      amount: 1288,
    },
  ];
}

export function getDemoMember(): MemberInfo {
  return {
    level: "金卡会员",
    points: 2680,
    benefits: ["免费双人早餐", "延迟退房至 14:00", "客房免费升级（视房态）", "积分 1.2 倍累积"],
    demo: true,
  };
}

export const demoTickets: Ticket[] = [
  {
    id: "TK-20260822-101",
    kind: "delivery",
    title: "送物服务：补充两瓶矿泉水与牙具",
    status: "处理中",
    createdAt: "2026-08-22T19:42:00.000Z",
    slaDueAt: "2026-08-22T20:12:00.000Z",
  },
  {
    id: "TK-20260821-087",
    kind: "repair",
    title: "维修报修：房间空调噪音偏大",
    status: "已完成",
    createdAt: "2026-08-21T14:05:00.000Z",
  },
  {
    id: "TK-20260820-066",
    kind: "complaint",
    title: "投诉建议：早餐高峰等位时间过长",
    status: "已受理",
    createdAt: "2026-08-20T09:18:00.000Z",
  },
];

export function demoTimeline(ticketId: string): TimelineItem[] {
  const base = Date.now() - 1000 * 60 * 42;
  return [
    {
      action: "created",
      actorType: "guest",
      actorId: "me",
      detail: "工单已提交，AI 前台已受理",
      createdAt: new Date(base).toISOString(),
    },
    {
      action: "assigned",
      actorType: "agent",
      actorId: "AI-Concierge",
      detail: "已派单至楼层服务组（演示流转）",
      createdAt: new Date(base + 1000 * 60 * 5).toISOString(),
    },
    {
      action: "progress",
      actorType: "staff",
      actorId: "staff-0312",
      detail: `工单 ${ticketId} 处理中，服务员已出发`,
      createdAt: new Date(base + 1000 * 60 * 18).toISOString(),
    },
  ];
}

export function getDemoNotifications(): NotificationItem[] {
  return [
    {
      kind: "ticket.accepted",
      payload: { ticketId: "TK-20260822-101", title: "送物服务：补充两瓶矿泉水与牙具" },
      createdAt: "2026-08-22T19:42:10.000Z",
      read: false,
    },
    {
      kind: "ticket.completed",
      payload: { ticketId: "TK-20260821-087", title: "维修报修：房间空调噪音偏大" },
      createdAt: "2026-08-21T15:30:00.000Z",
      read: true,
    },
    {
      kind: "member.benefit",
      payload: { title: "会员权益到账", detail: "本月免费延迟退房权益已生效" },
      createdAt: "2026-08-20T08:00:00.000Z",
      read: true,
    },
  ];
}

/** 关键词匹配的演示应答（用于 /c/chat 降级） */
export function demoChatAnswer(text: string): {
  intent: string;
  answer: string;
  confidence: number;
  citations: { documentTitle: string; heading: string; content: string }[];
  cards?: { kind: "order" | "member" | "catalog"; data: Record<string, unknown> }[];
} {
  const brand = getConfig().brandName;
  const t = text.toLowerCase();
  if (/订单|预订|入住/.test(text)) {
    return {
      intent: "order.query",
      answer: "为您查到以下订单，当前入住的是 8 月 22 日的豪华大床房，共 2 晚。如需续住或变更，请告诉我。",
      confidence: 0.92,
      citations: [
        {
          documentTitle: `${brand}预订政策`,
          heading: "订单查询与变更",
          content: "住客可凭手机号或会员号查询全部有效订单；入住当日 18:00 前可免费变更一次。",
        },
      ],
      cards: [{ kind: "order", data: getDemoOrders()[0] as unknown as Record<string, unknown> }],
    };
  }
  if (/会员|积分|权益/.test(text)) {
    return {
      intent: "member.info",
      answer: "您当前是金卡会员，积分 2680。金卡权益包含免费双早、延迟退房至 14:00 等，详情见下方会员卡。",
      confidence: 0.95,
      citations: [
        {
          documentTitle: `${brand}会员手册`,
          heading: "金卡权益",
          content: "金卡会员享免费双人早餐、延迟退房至 14:00、积分 1.2 倍累积。",
        },
      ],
      cards: [{ kind: "member", data: getDemoMember() as unknown as Record<string, unknown> }],
    };
  }
  if (/wifi|wi-fi|早餐|停车|退房/.test(t) || /早餐|停车|退房/.test(text)) {
    return {
      intent: "faq",
      answer:
        "早餐位于 2 层云餐厅，营业时间 6:30–10:30；住客停车免费，出场前在前台扫码登记车牌即可；默认退房时间 12:00，金卡会员可延迟至 14:00。",
      confidence: 0.88,
      citations: [
        {
          documentTitle: `${brand}住客指南`,
          heading: "餐饮 / 停车 / 退房",
          content: "早餐 2 层云餐厅 6:30–10:30；住客免费停车；退房 12:00，会员可延迟。",
        },
      ],
    };
  }
  return {
    intent: "fallback",
    answer: "这个问题我还在学习中，已为您转专人处理，稍后会有服务员与您联系。您也可以直接描述需要的服务。",
    confidence: 0.42,
    citations: [],
  };
}
