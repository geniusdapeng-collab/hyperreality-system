import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@workloom/server/router";
import { registerClientSafeTerms } from "@workloom/ui";
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
  // 退出即清空行业术语白名单，避免下一位登录者继承上一工作区的放行词表。
  registerClientSafeTerms([]);
}

interface AccessBundlePayload {
  bundle?: { configured?: boolean; ui?: { safeTerms?: string[] } };
}

/**
 * 装配投影就绪后登记行业术语白名单（`ui.safeTerms`）。
 * 移动端只消费服务端已验签的投影；缺省为空集，旧工作区行为不变。
 * 已拿到 access.me 结果的调用方直接传入，避免重复请求。
 */
export async function hydrateIndustryTerms(payload?: AccessBundlePayload): Promise<void> {
  try {
    const access = payload ?? await trpc.access.me.query() as AccessBundlePayload;
    registerClientSafeTerms(access.bundle?.configured ? access.bundle.ui?.safeTerms : []);
  } catch {
    // 装配读取失败时回退基座默认边界；权限/装配错误态由页面各自呈现。
    registerClientSafeTerms([]);
  }
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
    try { await hydrateIndustryTerms(await trpc.access.me.query() as AccessBundlePayload); return true; } catch { sessionStorage.removeItem(ACCESS_KEY); }
  }
  if (localStorage.getItem(GUEST_KEY) === "1") {
    try {
      const result = await trpc.accounts.auth.guestEnter.mutate({ device: "B 端移动客户端" });
      setSession({ accessToken: result.token, workspaceSlug: result.workspace.slug, guest: true });
      await hydrateIndustryTerms();
      return true;
    } catch { clearSession(); return false; }
  }
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;
  try {
    const result = await trpc.accounts.auth.refresh.mutate({ refreshToken, workspaceSlug: savedWorkspace(), device: "B 端移动客户端" });
    setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, workspaceSlug: savedWorkspace() });
    await hydrateIndustryTerms();
    return true;
  } catch {
    clearSession();
    return false;
  }
}

export async function enterGuest() {
  const result = await trpc.accounts.auth.guestEnter.mutate({ device: "B 端移动客户端" });
  setSession({ accessToken: result.token, workspaceSlug: result.workspace.slug, guest: true });
  await hydrateIndustryTerms();
  return result;
}
