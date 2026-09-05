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
 */
const DEMO_WORKSPACE = (import.meta.env.VITE_DEMO_WORKSPACE as string | undefined) ?? "yunqi-hotel";
const DEMO_MEMBER = (import.meta.env.VITE_DEMO_MEMBER as string | undefined) ?? "MEM-001";
export async function ensureDemoLogin(memberNo = DEMO_MEMBER): Promise<void> {
  if (getToken()) return;
  const r = await trpc.auth.loginAs.mutate({ workspaceSlug: DEMO_WORKSPACE, memberNo });
  setToken(r.token);
}
