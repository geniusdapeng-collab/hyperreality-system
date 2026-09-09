/**
 * tRPC client（v11，httpBatchLink；类型由 @workloom/server 端到端推导——总纲 §2.4）
 * 轮询口径（F3.4/D6）：线程/夜班 5s，其余 10–15s（P1 接线起生效）
 * 鉴权：演示身份 JWT（B5）——token 存 localStorage；无 token 时 P1 以种子成员自动登录
 * （演示口径；真实登录页/多端登录在后续任务卡落地，JWT_SECRET 由部署方配置）
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@workloom/server/router";

const TOKEN_KEY = "workloom.demo.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(GUEST_KEY);
}

const REFRESH_KEY = "workloom.accounts.refresh";
export function getRefreshToken(): string | null { return localStorage.getItem(REFRESH_KEY); }
export function setRefreshToken(token: string): void { localStorage.setItem(REFRESH_KEY, token); }

/* ================= 游客模式（F-GUEST1 首次装机体验） =================
 * 首次安装后默认游客身份：只读浏览示例工作区（数字人/汇报/页面能力完整体验），
 * 进入配置引导（/onboarding）时才引导正式登录。游客令牌由 accounts.auth.guestEnter
 * 签发（readonly 角色；服务端 writeProcedure 403 一切写操作——体验全程零写入）。 */
const GUEST_KEY = "workloom.guest";
export function isGuest(): boolean { return localStorage.getItem(GUEST_KEY) === "1"; }
export function clearGuestFlag(): void { localStorage.removeItem(GUEST_KEY); }

/** 无令牌时静默进场游客会话（幂等；正式登录后不再触发） */
export async function ensureGuestSession(): Promise<void> {
  if (getToken()) return;
  const r = await (trpc.accounts.auth as unknown as {
    guestEnter: { mutate: (i: Record<string, never>) => Promise<{ token: string }> };
  }).guestEnter.mutate({});
  setToken(r.token);
  localStorage.setItem(GUEST_KEY, "1");
}

export const trpc: ReturnType<typeof createTRPCClient<AppRouter>> = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/trpc",
      headers: () => {
        const token = getToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});

/**
 * 演示身份自动登录（演示/开发便利；生产部署用真实登录替代）。
 * 工作区与成员均可经 VITE_DEMO_WORKSPACE / VITE_DEMO_MEMBER 覆盖——
 * 不写死在调用侧，客户自建工作区（非种子库默认工作区）时演示登录仍可用。
 *
 * F-GUEST1 语义升级：无参调用 = 游客进场（readonly 只读体验，各页面挂载点沿用）；
 * 仅显式传 memberNo 时才走旧的种子成员真身份登录（开发后门专用，生产不出现）。
 */
const DEMO_WORKSPACE = (import.meta.env.VITE_DEMO_WORKSPACE as string | undefined) ?? "yunqi-hotel";
const DEMO_MEMBER = (import.meta.env.VITE_DEMO_MEMBER as string | undefined) ?? "MEM-001";
export const DEV_DEMO_MEMBER = DEMO_MEMBER;
export async function ensureDemoLogin(memberNo?: string): Promise<void> {
  if (memberNo) {
    if (getToken()) return;
    const r = await trpc.auth.loginAs.mutate({ workspaceSlug: DEMO_WORKSPACE, memberNo });
    setToken(r.token);
    return;
  }
  return ensureGuestSession();
}
