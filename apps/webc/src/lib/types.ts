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

export interface Ticket {
  id: string;
  kind: "delivery" | "repair" | "complaint" | "other";
  title: string;
  status: string;
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
  ticket?: { id: string; kind: string; title: string; status: string };
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
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}
