/** 后端 API 契约（baseURL=/c）类型定义 */

export interface SessionUser {
  id: string;
  nickname?: string | null;
  memberId?: string | null;
  verified?: boolean;
  /** 当前会话是否来自明确的演示直登；不得把演示身份伪装为渠道认证。 */
  authMode?: "demo" | "channel";
  /** 当前会员身份绑定的核验方式。 */
  identityMode?: "demo" | "verified";
}

export type ActionState = "idle" | "demo" | "pending" | "failed" | "success";

export interface ActionReceipt {
  requestId: string;
  state: "accepted" | "recorded" | "bound";
  resourceId: string;
  eventId?: string;
  idempotentReplay?: boolean;
  demo?: boolean;
  delivery?: {
    state: "demo" | "pending" | "failed" | "sent";
    notificationId?: string;
  };
}

export interface TicketMutationResponse {
  ticket: Ticket;
  receipt: ActionReceipt;
}

export interface IdentityCodeResponse {
  state: "demo" | "pending";
  message: string;
  requestId: string;
  demoCode?: string;
}

export interface IdentityBindResponse {
  user: SessionUser;
  receipt: ActionReceipt;
}

export interface Citation {
  documentTitle: string;
  heading: string;
  content: string;
}

/** 行业适配器已经本地化的字段行；客户端只排版，不解释字段 key。 */
export interface BusinessDisplayField {
  label: string;
  value: string;
}

/** 订单、预约、项目等业务记录的行业无关视图模型。 */
export interface BusinessRecord {
  /** 仅作 React key / 后续交互锚点，不直接展示。 */
  id: string;
  cardTitle: string;
  title: string;
  statusText: string;
  referenceText?: string;
  details: BusinessDisplayField[];
  amountText?: string;
}

/** 会员、客户、伙伴等身份权益的行业无关视图模型。 */
export interface MemberInfo {
  title: string;
  metric?: BusinessDisplayField;
  benefits: string[];
  demo?: boolean;
}

/** 商品、房型、服务或方案目录的行业无关视图模型。 */
export interface CatalogInfo {
  cardTitle: string;
  items: Array<{
    id: string;
    title: string;
    summary?: string;
    priceText?: string;
    details: BusinessDisplayField[];
  }>;
  demo?: boolean;
}

export type BusinessCard =
  | { kind: "order"; data: BusinessRecord }
  | { kind: "member"; data: MemberInfo }
  | { kind: "catalog"; data: CatalogInfo };

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
  receipt?: ActionReceipt;
  /** 低置信诚实拒答/待确认建单草稿（确认后提交） */
  ticketDraft?: { kind: string; title: string; payload: Record<string, unknown> } | null;
  latencyMs: number;
  mock?: boolean;
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
  deliveryState?: "demo" | "pending" | "failed" | "sent";
}
