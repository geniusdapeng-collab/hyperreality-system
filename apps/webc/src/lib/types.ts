/** 后端 API 契约（baseURL=/c）类型定义 */

export interface SessionUser {
  id: string;
  nickname: string;
  memberId?: string;
}

export interface Citation {
  documentTitle: string;
  heading: string;
  content: string;
}

export interface BusinessCard {
  kind: "order" | "member" | "catalog";
  data: Record<string, unknown>;
}

export type TicketKind = "delivery" | "repair" | "complaint" | "other" | "service_request" | "consult";

export interface Ticket {
  id: string;
  kind: TicketKind | (string & {});
  title: string;
  /** 英文机读态（created/assigned/processing/done/closed） */
  status: string;
  /** 中文展示态（已受理/处理中/已完成/已关闭）——网关契约字段，UI 一律用它渲染 */
  statusText?: string;
  createdAt?: string;
  slaDueAt?: string;
}

export interface ChatResponse {
  conversationId: string;
  intent: string;
  answer: string;
  confidence: number;
  citations: Citation[];
  cards?: BusinessCard[];
  ticket?: { id: string; kind: string; title: string; status: string; statusText?: string };
  /** 低置信诚实拒答/待确认建单草稿（确认后提交） */
  ticketDraft?: { kind: string; title: string; payload: Record<string, unknown> } | null;
  latencyMs: number;
  mock?: boolean;
}

export interface Order {
  id: string;
  title: string;
  status: string;
  checkIn?: string;
  roomType?: string;
  amount?: number;
}

export interface MemberInfo {
  level: string;
  points: number;
  benefits: string[];
  demo?: boolean;
}

export interface TimelineItem {
  action: string;
  actorType: string;
  actorId: string;
  detail: string;
  createdAt: string;
}

export interface NotificationItem {
  id?: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}
