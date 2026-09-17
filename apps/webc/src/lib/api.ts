/** API 层：baseURL=/c，Bearer token；写操作失败必须把服务端错误/回执交给 UI，不得伪造成功。 */
import { getConfig } from "./config";
import { businessCardsOf, businessRecordOf, memberInfoOf } from "./business-display";
import { storageKey } from "./product";
import type {
  ChatResponse,
  BusinessRecord,
  IdentityBindResponse,
  IdentityCodeResponse,
  NotificationItem,
  SessionUser,
  Ticket,
  TicketMutationResponse,
  TimelineItem,
} from "./types";

const BASE = "/c";
// v2 强制淘汰缺少 authMode/identityMode 的旧会话缓存，避免把历史演示身份显示成真实核验。
const TOKEN_KEY = storageKey("token.v3");
const USER_KEY = storageKey("user.v3");
const OPENID_KEY = storageKey("anonymous-id.v2");
const ENTRY_TOKEN_KEY = storageKey("entry-token.v1");
const WORKSPACE_KEY = storageKey("workspace-key.v2");

/** 演示环境的匿名会话标识仅保存在当前浏览器会话；正式环境不会信任该值。 */
export function getOpenid(): string {
  let openid = sessionStorage.getItem(OPENID_KEY);
  if (!openid) {
    openid = `h5_demo_${crypto.randomUUID()}`;
    sessionStorage.setItem(OPENID_KEY, openid);
  }
  return openid;
}

/**
 * 可信入口凭据只保存在当前会话，并在读取后立即从地址栏移除，避免进入历史、截图或引用来源。
 * 签名和工作区归属由服务端验证；客户端从不解析或相信其中声明。
 */
export function getH5EntryToken(): string | null {
  const params = new URLSearchParams(location.search);
  const incoming = params.get("entry_token")?.trim() ?? "";
  if (incoming) {
    sessionStorage.setItem(ENTRY_TOKEN_KEY, incoming);
    params.delete("entry_token");
    const query = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
    return incoming;
  }
  return sessionStorage.getItem(ENTRY_TOKEN_KEY);
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): SessionUser | null {
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function storeUser(user: SessionUser): void {
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** 退出仅清除本设备当前会话与短期入口凭据，不改动服务端工单、订单或账本。 */
export function clearCSession(): void {
  for (const key of [TOKEN_KEY, USER_KEY, OPENID_KEY, ENTRY_TOKEN_KEY]) sessionStorage.removeItem(key);
  localStorage.removeItem(WORKSPACE_KEY);
  lastSessionError = null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * C 端只展示稳定、可行动的中文错误。服务端原始 message 可能含字段名、异常栈或英文错误码，
 * 因此不得把它作为客户端文案；排障仅使用 requestId 与受控日志。
 */
export function publicApiErrorMessage(status: number, code?: string): string {
  const normalizedCode = code?.toUpperCase() ?? "";
  if (normalizedCode.startsWith("H5_ENTRY_")) return "服务入口无效或已过期，请从服务方提供的入口重新进入。";
  if (status === 401 || normalizedCode === "UNAUTHORIZED") return "登录状态已失效，请重新进入服务后再试。";
  if (status === 403 || normalizedCode === "FORBIDDEN") return "当前身份没有执行此操作的权限。";
  if (status === 404 || normalizedCode === "NOT_FOUND") return "请求的服务记录不存在或已失效。";
  if (status === 409 || normalizedCode === "CONFLICT") return "数据已发生变化，请刷新后重新确认。";
  if (status === 429 || normalizedCode === "TOO_MANY_REQUESTS") return "操作过于频繁，请稍后再试。";
  if (status === 400 || status === 422 || normalizedCode === "BAD_REQUEST") return "提交内容未通过校验，请检查后重试。";
  if (status === 0) return "无法连接服务，请检查网络后重试。";
  return "服务暂时不可用，本次操作尚未确认成功，请稍后重试。";
}

let lastSessionError: ApiError | null = null;

export function getSessionError(): ApiError | null {
  return lastSessionError;
}

/** 首进自动建会话；失败返回 null 并由 UI 显示真实错误，不注入行业演示数据。 */
export async function ensureSession(): Promise<{ token: string; user: SessionUser } | null> {
  const configuredWorkspaceKey = getConfig().workspaceKey ?? "";
  const cached = getToken();
  const user = getStoredUser();
  const cachedWorkspaceKey = localStorage.getItem(WORKSPACE_KEY) ?? "";
  if (cached && user && cachedWorkspaceKey === configuredWorkspaceKey) {
    lastSessionError = null;
    return { token: cached, user };
  }
  if (cachedWorkspaceKey !== configuredWorkspaceKey) {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  }
  try {
    const res = await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "h5",
        openid: getOpenid(),
        entryToken: getH5EntryToken(),
        nickname: `${getConfig().brandName}用户`,
        workspaceKey: getConfig().workspaceKey,
      }),
    });
    if (!res.ok) {
      const failure = (await res.json().catch(() => ({}))) as {
        error?: string; requestId?: string; code?: string;
      };
      lastSessionError = new ApiError(
        publicApiErrorMessage(res.status, failure.code),
        res.status,
        failure.requestId,
        failure.code,
      );
      return null;
    }
    const data = (await res.json()) as { token: string; user: SessionUser };
    sessionStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(WORKSPACE_KEY, configuredWorkspaceKey);
    storeUser(data.user);
    lastSessionError = null;
    return data;
  } catch (err) {
    lastSessionError = err instanceof ApiError
      ? err
      : new ApiError("无法连接服务，请检查网络后重试", 0);
    return null;
  }
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
}

async function safeRawRequest(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await rawRequest(path, init);
  } catch {
    throw new ApiError(publicApiErrorMessage(0), 0);
  }
}

/** L7：401 → 清本地 token → ensureSession 重建会话 → 原样重试一次（再失败才抛错降级） */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await safeRawRequest(path, init);
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    const s = await ensureSession();
    if (s) res = await safeRawRequest(path, init);
    else if (lastSessionError) throw lastSessionError;
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      requestId?: string;
      code?: string;
    };
    throw new ApiError(publicApiErrorMessage(res.status, payload.code), res.status, payload.requestId, payload.code);
  }
  return (await res.json()) as T;
}

export const api = {
  chat: async (body: { conversationId?: string; text: string; confirmTicket?: string }) => {
    const response = await request<ChatResponse>("/chat", { method: "POST", body: JSON.stringify(body) });
    const rawCards = response.cards ?? [];
    const cards = businessCardsOf(rawCards);
    if (!Array.isArray(rawCards) || cards.length !== rawCards.length) {
      throw new ApiError("业务卡片暂时无法安全展示，请稍后重试", 502, undefined, "BUSINESS_PROJECTION_INVALID");
    }
    return { ...response, cards };
  },
  orders: async () => {
    const response = await request<{ orders: unknown[]; demo?: boolean; available?: boolean }>("/orders");
    if (response.available === false) {
      throw new ApiError("当前行业未提供可用的业务记录查询，请联系服务方", 503, undefined, "BUSINESS_ADAPTER_UNAVAILABLE");
    }
    const orders = Array.isArray(response.orders) ? response.orders.map(businessRecordOf) : [];
    if (orders.some((item) => item === null)) {
      throw new ApiError("业务记录暂时无法安全展示，请稍后重试", 502, undefined, "BUSINESS_PROJECTION_INVALID");
    }
    return { ...response, orders: orders as BusinessRecord[] };
  },
  member: async () => {
    const response = await request<Record<string, unknown>>("/member");
    if (response.available === false) {
      throw new ApiError("当前行业未提供可用的权益查询，请联系服务方", 503, undefined, "BUSINESS_ADAPTER_UNAVAILABLE");
    }
    const member = memberInfoOf(response);
    if (!member) {
      throw new ApiError("权益信息暂时无法安全展示，请稍后重试", 502, undefined, "BUSINESS_PROJECTION_INVALID");
    }
    return member;
  },
  createTicket: (body: {
    kind: string;
    title: string;
    payload: Record<string, unknown>;
  }) => request<TicketMutationResponse>("/tickets", { method: "POST", body: JSON.stringify(body) }),
  tickets: () => request<{ tickets: Ticket[] }>("/tickets"),
  ticketDetail: (id: string) =>
    request<{ ticket: Ticket; timeline: TimelineItem[] }>(`/tickets/${encodeURIComponent(id)}`),
  notifications: () => request<{ notifications: NotificationItem[] }>("/notifications"),
  rateTicket: (id: string, body: { score: number; comment?: string }) =>
    request<TicketMutationResponse>(`/tickets/${encodeURIComponent(id)}/rate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  requestIdentityCode: (body: { phone: string }) =>
    request<IdentityCodeResponse>("/identity/code", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  bindIdentity: (body: { phone: string; code: string }) =>
    request<IdentityBindResponse>("/identity/bind", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
