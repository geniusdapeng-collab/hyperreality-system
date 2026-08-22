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

export const trpc = createTRPCClient<AppRouter>({
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

/** 演示身份自动登录（种子成员；演示工作区 video-studio） */
export async function ensureDemoLogin(memberNo = "MEM-V01"): Promise<void> {
  if (getToken()) return;
  const r = await trpc.auth.loginAs.mutate({ workspaceSlug: "video-studio", memberNo });
  setToken(r.token);
}
