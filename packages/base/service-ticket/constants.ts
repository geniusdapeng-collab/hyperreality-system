/**
 * service-ticket · 工单预置常量（类型 + 部门路由表，行业中性）
 * 路由表可注入覆盖（assignTicket 参数）；缺省走本表。
 */

export const TICKET_KINDS = ["delivery", "repair", "complaint", "other"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export const TICKET_KIND_LABELS: Record<TicketKind, string> = {
  delivery: "送物",
  repair: "维修",
  complaint: "投诉",
  other: "其他",
};

/** 默认部门路由表（行业中性口径）：delivery→配送组 / repair→工程部 / complaint→值班经理 / other→服务台 */
export const DEFAULT_DEPT_ROUTES: Record<TicketKind, string> = {
  delivery: "配送组",
  repair: "工程部",
  complaint: "值班经理",
  other: "服务台",
};

export const TICKET_PRIORITIES = ["normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** SLA 默认时限（小时，按类型；createTicket 可覆盖） */
export const DEFAULT_SLA_HOURS: Record<TicketKind, number> = {
  complaint: 0.5,
  repair: 2,
  delivery: 1,
  other: 4,
};
