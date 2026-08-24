/**
 * tRPC 上下文（B5 中间件栈落地）：Bearer JWT → Identity；无令牌 = 未认证（null）
 * 纪律：
 *  - 未认证调受保护过程 → UNAUTHORIZED（401）
 *  - 越版调用 → FORBIDDEN（403）+ 升级提示（H-10），且留痕事件（G8）
 *  - 越权查询返回空而非 403（L7.1）：RLS + 过程内强制 identity scope
 */
import { initTRPC, TRPCError } from "@trpc/server";
import {
  hasCapability,
  verifyToken,
  type CapabilityKey,
  type Identity,
} from "@workloom/base/tenancy";

export interface TrpcContext {
  identity: Identity | null;
  /** 原始请求头（P0-1 通道验签 x-channel-* / 服务间密钥 x-workloom-key 读取面） */
  headers: Headers;
}

export async function createContext(req: Request): Promise<TrpcContext> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return { identity: null, headers: req.headers };
  const identity = await verifyToken(auth.slice(7));
  return { identity, headers: req.headers };
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** 401 守卫 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.identity) throw new TRPCError({ code: "UNAUTHORIZED", message: "未认证（缺少有效 JWT）" });
  return next({ ctx: { ...ctx, identity: ctx.identity } });
});

/** 403 越版守卫（H-10：403 + 升级提示） */
export const capabilityProcedure = (cap: CapabilityKey) =>
  protectedProcedure.use(({ ctx, next }) => {
    const plan = ctx.identity.plan;
    if (!hasCapability(plan, cap)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `当前版本「${plan}」不含能力「${cap}」，请升级（F7.2）`,
      });
    }
    return next();
  });

/**
 * #33 写操作角色守卫（E2.6/L5.1：readonly 一切写操作服务端 403，前端隐藏非置灰）
 * 背景：此前权限校验靠各 router 自觉（skills/nightShift.start/bundles/decide 有，
 * 但 threads.dispatch、inspection.*、nightShift.pause/resume/note/deliver、
 * fence.dryRun/confirmDryRun、approvals.sweep、im.sendApprovalCard 等 12+ 写操作
 * 裸奔——readonly 成员可直接调 API 派遣 Quest，前端隐藏被绕过）。
 */
export const writeProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.identity.role === "readonly") {
    throw new TRPCError({ code: "FORBIDDEN", message: "readonly 角色无写操作权限（E2.6/L5.1，服务端 403）" });
  }
  return next();
});

/** 越版（plan 能力）+ 写操作（role）双守卫 */
export const capabilityWriteProcedure = (cap: CapabilityKey) =>
  writeProcedure.use(({ ctx, next }) => {
    const plan = ctx.identity.plan;
    if (!hasCapability(plan, cap)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `当前版本「${plan}」不含能力「${cap}」，请升级（F7.2）`,
      });
    }
    return next();
  });

/** 身份 scope 快捷访问（过程内强制使用，杜绝跨工作区读取） */
export function scopeOf(identity: Identity): { tenantId: string; workspaceId: string } {
  return { tenantId: identity.tenantId, workspaceId: identity.workspaceId };
}
