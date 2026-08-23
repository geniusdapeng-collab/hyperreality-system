/** API 层：baseURL=/c，Bearer token；失败时抛错由调用方降级为演示数据 */
import { getConfig } from "./config";
import type {
  ChatResponse,
  MemberInfo,
  NotificationItem,
  Order,
  SessionUser,
  Ticket,
  TimelineItem,
} from "./types";

const BASE = "/c";
const TOKEN_KEY = "webc.token";
const USER_KEY = "webc.user";
const OPENID_KEY = "webc.openid";

/** 设备指纹演示值：localStorage 持久化一个随机 openid */
export function getOpenid(): string {
  let openid = localStorage.getItem(OPENID_KEY);
  if (!openid) {
    openid = `h5_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem(OPENID_KEY, openid);
  }
  return openid;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): SessionUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

/** 首进自动建会话；失败（后端未就绪）时返回 null，由 UI 走演示态 */
export async function ensureSession(): Promise<{ token: string; user: SessionUser } | null> {
  const cached = getToken();
  const user = getStoredUser();
  if (cached && user) return { token: cached, user };
  try {
    const res = await fetch(`${BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "h5",
        openid: getOpenid(),
        nickname: `${getConfig().brandName}宾客`,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token: string; user: SessionUser };
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    return data;
  } catch {
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

/** L7：401 → 清本地 token → ensureSession 重建会话 → 原样重试一次（再失败才抛错降级） */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await rawRequest(path, init);
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    const s = await ensureSession();
    if (s) res = await rawRequest(path, init);
  }
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  chat: (body: { conversationId?: string; text: string; confirmTicket?: string }) =>
    request<ChatResponse>("/chat", { method: "POST", body: JSON.stringify(body) }),
  orders: () => request<{ orders: Order[]; demo?: boolean }>("/orders"),
  member: () => request<MemberInfo>("/member"),
  createTicket: (body: {
    kind: string;
    title: string;
    payload: Record<string, unknown>;
  }) => request<Ticket>("/tickets", { method: "POST", body: JSON.stringify(body) }),
  tickets: () => request<{ tickets: Ticket[] }>("/tickets"),
  ticketDetail: (id: string) =>
    request<{ ticket: Ticket; timeline: TimelineItem[] }>(`/tickets/${encodeURIComponent(id)}`),
  notifications: () => request<{ notifications: NotificationItem[] }>("/notifications"),
  rateTicket: (id: string, body: { score: number; comment?: string }) =>
    request<unknown>(`/tickets/${encodeURIComponent(id)}/rate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
