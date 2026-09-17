import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@workloom/server/router";
import { DEMO_WORKSPACE, storageKey } from "./product";

const ACCESS_KEY = storageKey("access-token");
const REFRESH_KEY = storageKey("refresh-token");
const WORKSPACE_KEY = storageKey("workspace");
const GUEST_KEY = storageKey("guest");

export const trpc: ReturnType<typeof createTRPCClient<AppRouter>> = createTRPCClient<AppRouter>({
  links: [httpBatchLink({
    url: "/trpc",
    headers: () => {
      const token = sessionStorage.getItem(ACCESS_KEY);
      return token ? { authorization: `Bearer ${token}` } : {};
    },
  })],
});

export function setSession(input: { accessToken: string; refreshToken?: string; workspaceSlug?: string; guest?: boolean }) {
  sessionStorage.setItem(ACCESS_KEY, input.accessToken);
  // 浏览器脚本可读的长期存储不得保存刷新凭据；服务端 HttpOnly Cookie 接线前，
  // 正式会话只在当前浏览器会话内恢复，关闭浏览器后要求重新验证。
  if (input.refreshToken) sessionStorage.setItem(REFRESH_KEY, input.refreshToken);
  if (input.workspaceSlug) localStorage.setItem(WORKSPACE_KEY, input.workspaceSlug);
  if (input.guest) localStorage.setItem(GUEST_KEY, "1");
  else localStorage.removeItem(GUEST_KEY);
}

export function clearSession() {
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(GUEST_KEY);
}

export async function logoutSession(): Promise<void> {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  try {
    if (refreshToken) await trpc.accounts.auth.logout.mutate({ refreshToken });
  } finally {
    clearSession();
  }
}

export function savedWorkspace() {
  return localStorage.getItem(WORKSPACE_KEY) ?? DEMO_WORKSPACE;
}

export async function restoreSession(): Promise<boolean> {
  if (sessionStorage.getItem(ACCESS_KEY)) {
    try { await trpc.access.me.query(); return true; } catch { sessionStorage.removeItem(ACCESS_KEY); }
  }
  if (localStorage.getItem(GUEST_KEY) === "1") {
    try {
      const result = await trpc.accounts.auth.guestEnter.mutate({ device: "B 端移动客户端" });
      setSession({ accessToken: result.token, workspaceSlug: result.workspace.slug, guest: true });
      return true;
    } catch { clearSession(); return false; }
  }
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;
  try {
    const result = await trpc.accounts.auth.refresh.mutate({ refreshToken, workspaceSlug: savedWorkspace(), device: "B 端移动客户端" });
    setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, workspaceSlug: savedWorkspace() });
    return true;
  } catch {
    clearSession();
    return false;
  }
}

export async function enterGuest() {
  const result = await trpc.accounts.auth.guestEnter.mutate({ device: "B 端移动客户端" });
  setSession({ accessToken: result.token, workspaceSlug: result.workspace.slug, guest: true });
  return result;
}
