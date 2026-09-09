/**
 * trpc/accounts-router —— 账号体系端点（PRD §4 登录模块 / §6 我的体系 / §5 审批 / 伙伴域 / API 密钥）
 *
 * 命名空间：
 *  - accounts.auth.*      公开：验证码/密码登录、注册开通、激活、邀请接受、refresh、伙伴登录
 *  - accounts.my.*        登录态：资料/成员关系/会话/登录日志/快切 PIN/登出
 *  - accounts.admin.*     owner/manager：成员邀请/移除/改角色、审批模板查看与应用、API 密钥管理、伙伴授权管理
 *  - accounts.inbox.*     统一待办（跨 membership 聚合）
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getAppPool, getOwnerPool } from "@workloom/db";
import {
  requestCode, consumeCode, loginWithCode, loginWithPassword, refreshSession, logout,
  listMemberships, listSessions, revokeSession, revokeAllSessions, registerTenantOwner,
  inviteMember, acceptInvite, removeMember, updateMemberRole, setQuickPin, myLoginEvents,
  loginEvent, DevEchoSms, type AccountsDeps,
} from "@workloom/base/accounts";
import {
  ensurePartner, issueGrant, revokeGrant, listGrantsForTenant, listGrantsForPartner,
  partnerLogin, partnerRefresh, issueWorkorderPass, PARTNER_CAPABILITIES,
} from "@workloom/base/accounts";
import {
  applyApprovalTemplate, listApprovalPolicies, createApiKey, listApiKeys, revokeApiKey,
  linkTenant, childTenants, type Archetype,
} from "@workloom/base/accounts";
import { router, publicProcedure, protectedProcedure, writeProcedure, scopeOf } from "./context.js";
import { signDemoToken, type Identity } from "@workloom/base/tenancy";

const sms = new DevEchoSms(); // seam：生产经环境注入真实短信通道（PRD §4.1 微信/短信）
const deps = (): AccountsDeps => ({ q: (t: string, p?: unknown[]) => getAppPool().query(t, p as never[]) as Promise<{ rows: Record<string, unknown>[] }>, sms });
// 登录引导例外点（F7.1 同 loginAs）：身份未建立前的工作区解析走 owner 池
const ownerDeps = (): AccountsDeps => ({ q: (t: string, p?: unknown[]) => getOwnerPool().query(t, p as never[]) as Promise<{ rows: Record<string, unknown>[] }>, sms });

const device = z.string().max(200).optional();
const ip = z.string().max(64).optional();

export const accountsRouter = router({
  auth: router({
    /** 发送验证码（login/activate/invite/danger-confirm） */
    requestCode: publicProcedure
      .input(z.object({
        channel: z.enum(["phone", "email"]).default("phone"),
        target: z.string().min(5).max(64),
        purpose: z.enum(["login", "activate", "invite", "danger-confirm"]),
      }))
      .mutation(async ({ input }) => {
        const r = await requestCode(deps(), input);
        return { sent: r.sent, devCode: r.devCode };
      }),

    loginWithCode: publicProcedure
      .input(z.object({ phone: z.string().min(6).max(20), code: z.string().length(6), workspaceSlug: z.string(), device, ip }))
      .mutation(async ({ input }) => loginWithCode(ownerDeps(), input)),

    loginWithPassword: publicProcedure
      .input(z.object({ email: z.string().email(), password: z.string().min(6).max(128), workspaceSlug: z.string(), device, ip }))
      .mutation(async ({ input }) => loginWithPassword(ownerDeps(), input)),

    /** 自助注册开通（老板首店） */
    register: publicProcedure
      .input(z.object({
        phone: z.string().min(6).max(20), code: z.string().length(6), displayName: z.string().min(1).max(50),
        tenantName: z.string().min(1).max(100), workspaceName: z.string().min(1).max(100),
        workspaceSlug: z.string().regex(/^[a-z0-9-]{3,40}$/), industry: z.string().min(1).max(40),
        password: z.string().min(8).max(128).optional(), ip,
      }))
      .mutation(async ({ input }) => registerTenantOwner(ownerDeps(), input)),

    acceptInvite: publicProcedure
      .input(z.object({ phone: z.string().min(6).max(20), code: z.string().length(6), workspaceSlug: z.string(), displayName: z.string().max(50).optional(), ip }))
      .mutation(async ({ input }) => acceptInvite(ownerDeps(), input)),

    refresh: publicProcedure
      .input(z.object({ refreshToken: z.string().min(20), workspaceSlug: z.string(), device, ip }))
      .mutation(async ({ input }) => refreshSession(ownerDeps(), input)),

    logout: publicProcedure
      .input(z.object({ refreshToken: z.string().min(20) }))
      .mutation(async ({ input }) => { await logout(deps(), input.refreshToken); return { ok: true }; }),

    partnerLogin: publicProcedure
      .input(z.object({ phone: z.string().min(6).max(20), code: z.string().length(6), device, ip }))
      .mutation(async ({ input }) => partnerLogin(ownerDeps(), input)),

    partnerRefresh: publicProcedure
      .input(z.object({ refreshToken: z.string().min(20) }))
      .mutation(async ({ input }) => partnerRefresh(ownerDeps(), input)),

    /**
     * 游客进场（F-GUEST1 首次装机体验口径）：
     * 默认游客身份直接进系统——可完整浏览示例工作区（数字人/汇报/页面能力），
     * 直至进入配置引导（/onboarding）才要求正式登录。
     * 纪律：① 不写死工作区 slug——自动发现 is_example 工作区（各行业包种子均建一个）；
     *      ② 游客=readonly 角色——writeProcedure 服务端 403 一切写操作（E2.6 已有守卫），
     *         体验全程零写入、零审批、零扣费；
     *      ③ 24h 令牌与演示 JWT 同构（Identity），前端以 GUEST memberNo 识别并展示「游客体验中」。
     */
    guestEnter: publicProcedure
      .input(z.object({ device, ip }))
      .mutation(async () => {
        // 登录引导例外点（F7.1 同 loginAs）：身份未建立前的示例工作区发现走 owner 池
        const ws = await getOwnerPool().query<{ id: string; tenant_id: string; slug: string; name: string }>(
          `SELECT id, tenant_id, slug, name FROM workspaces WHERE is_example=true ORDER BY id LIMIT 1`);
        const row = ws.rows[0];
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "示例工作区未就绪（首启种子未完成）" });
        const t = await getOwnerPool().query<{ plan: Identity["plan"] }>(`SELECT plan FROM tenants WHERE id=$1`, [row.tenant_id]);
        const identity: Identity = {
          memberId: "guest",
          memberNo: "GUEST",
          name: "游客",
          role: "readonly",
          tenantId: row.tenant_id,
          workspaceId: row.id,
          plan: t.rows[0]?.plan ?? "pro",
        };
        return { token: await signDemoToken(identity), identity, workspace: { slug: row.slug, name: row.name } };
      }),
  }),

  my: router({
    /** 我的成员关系（统一待办与切店数据源） */
    memberships: protectedProcedure.query(async ({ ctx }) => {
      const r = await getAppPool().query(
        `SELECT account_id FROM members WHERE id=$1`, [ctx.identity!.memberId]);
      const accId = r.rows[0]?.account_id as string | undefined;
      if (!accId) return [];
      return listMemberships(getAppPool().query.bind(getAppPool()), accId);
    }),

    sessions: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!.memberId);
      return accId ? listSessions(getAppPool().query.bind(getAppPool()), accId) : [];
    }),

    revokeSession: writeProcedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const accId = await accountIdOf(ctx.identity!.memberId);
        if (accId) await revokeSession(getAppPool().query.bind(getAppPool()), accId, input.sessionId);
        return { ok: true };
      }),

    revokeAllSessions: writeProcedure.mutation(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!.memberId);
      if (accId) await revokeAllSessions(getAppPool().query.bind(getAppPool()), accId);
      return { ok: true };
    }),

    loginEvents: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!.memberId);
      return accId ? myLoginEvents(getAppPool().query.bind(getAppPool()), accId) : [];
    }),

    setQuickPin: writeProcedure
      .input(z.object({ pin: z.string().regex(/^\d{4,6}$/) }))
      .mutation(async ({ ctx, input }) => {
        await setQuickPin(deps(), { memberId: ctx.identity!.memberId, pin: input.pin });
        return { ok: true };
      }),

    /** 伙伴域：我的授权（伙伴联系人视角） */
    myPartnerGrants: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!.memberId);
      if (!accId) return [];
      const p = await getAppPool().query(`SELECT id FROM partners WHERE contact_account_id=$1 AND status='active'`, [accId]);
      if (!p.rows[0]) return [];
      return listGrantsForPartner(getAppPool().query.bind(getAppPool()), p.rows[0].id as string);
    }),
  }),

  admin: router({
    invite: writeProcedure
      .input(z.object({
        phone: z.string().min(6).max(20), name: z.string().min(1).max(50),
        role: z.enum(["owner", "manager", "staff", "readonly"]),
      }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        const r = await inviteMember(deps(), {
          workspaceId: ctx.identity!.workspaceId, phone: input.phone, name: input.name,
          role: input.role, invitedBy: ctx.identity!.memberId,
        });
        return r;
      }),

    remove: writeProcedure
      .input(z.object({ memberId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        if (input.memberId === ctx.identity!.memberId) throw new TRPCError({ code: "BAD_REQUEST", message: "不能移除自己" });
        await removeMember(deps(), { workspaceId: ctx.identity!.workspaceId, memberId: input.memberId });
        await loginEvent(getAppPool().query.bind(getAppPool()), { kind: "member.removed", workspaceId: ctx.identity!.workspaceId, detail: { memberId: input.memberId, by: ctx.identity!.memberNo } });
        return { ok: true };
      }),

    updateRole: writeProcedure
      .input(z.object({
        memberId: z.string(), role: z.enum(["owner", "manager", "staff", "readonly"]),
        permissions: z.record(z.string(), z.unknown()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        await updateMemberRole(deps(), { workspaceId: ctx.identity!.workspaceId, ...input });
        return { ok: true };
      }),

    approvalPolicies: protectedProcedure.query(async ({ ctx }) =>
      listApprovalPolicies(getAppPool().query.bind(getAppPool()), ctx.identity!.workspaceId)),

    applyApprovalTemplate: writeProcedure
      .input(z.object({ archetype: z.enum(["single", "unmanned", "group-store"]) }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        return applyApprovalTemplate(deps(), {
          workspaceId: ctx.identity!.workspaceId,
          archetype: input.archetype as Archetype, updatedBy: ctx.identity!.memberId,
        });
      }),

    createApiKey: writeProcedure
      .input(z.object({
        name: z.string().min(1).max(60), capabilities: z.array(z.string()).min(1),
        rateLimit: z.number().int().min(1).max(6000).optional(), ttlDays: z.number().int().min(1).max(365).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        return createApiKey(deps(), {
          workspaceId: ctx.identity!.workspaceId, name: input.name, capabilities: input.capabilities,
          rateLimit: input.rateLimit, ttlDays: input.ttlDays, createdBy: ctx.identity!.memberId,
        });
      }),

    apiKeys: protectedProcedure.query(async ({ ctx }) =>
      listApiKeys(getAppPool().query.bind(getAppPool()), ctx.identity!.workspaceId)),

    revokeApiKey: writeProcedure
      .input(z.object({ keyId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        await revokeApiKey(getAppPool().query.bind(getAppPool()), ctx.identity!.workspaceId, input.keyId);
        return { ok: true };
      }),

    registerPartner: writeProcedure
      .input(z.object({ name: z.string().min(1).max(100), type: z.enum(["agency", "contractor", "observer"]), contactPhone: z.string().min(6).max(20) }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        return ensurePartner(deps(), input);
      }),

    issueGrant: writeProcedure
      .input(z.object({
        partnerId: z.string(), workspaces: z.array(z.string()).default([]),
        capabilities: z.array(z.enum(PARTNER_CAPABILITIES)).min(1),
        ttlDays: z.number().int().min(1).max(730),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.identity!.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "伙伴授权仅 owner 可签发" });
        return issueGrant(deps(), {
          partnerId: input.partnerId, tenantId: ctx.identity!.tenantId,
          workspaces: input.workspaces, capabilities: input.capabilities,
          ttlDays: input.ttlDays, issuedBy: ctx.identity!.memberId,
        });
      }),

    grants: protectedProcedure.query(async ({ ctx }) =>
      listGrantsForTenant(getAppPool().query.bind(getAppPool()), ctx.identity!.tenantId)),

    revokeGrant: writeProcedure
      .input(z.object({ grantId: z.string(), reason: z.string().max(200) }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.identity!.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "吊销仅 owner 可操作" });
        await revokeGrant(deps(), input.grantId, input.reason);
        return { ok: true };
      }),

    issueWorkorderPass: writeProcedure
      .input(z.object({
        phone: z.string().min(6).max(20), name: z.string().min(1).max(50),
        ticketId: z.string(), ttlHours: z.number().int().min(1).max(168).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        return issueWorkorderPass(deps(), {
          phone: input.phone, name: input.name, tenantId: ctx.identity!.tenantId,
          workspaceId: ctx.identity!.workspaceId, ticketId: input.ticketId,
          ttlHours: input.ttlHours, issuedBy: ctx.identity!.memberId,
        });
      }),

    linkTenant: writeProcedure
      .input(z.object({
        childTenantId: z.string(),
        relation: z.enum(["direct", "franchise"]),
        settlement: z.enum(["group_pool", "self_pay"]),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.identity!.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "集团层级仅集团 owner 可维护" });
        await linkTenant(deps(), { parentTenantId: ctx.identity!.tenantId, ...input });
        return { ok: true };
      }),

    childTenants: protectedProcedure.query(async ({ ctx }) =>
      childTenants(getAppPool().query.bind(getAppPool()), ctx.identity!.tenantId)),
  }),

  inbox: router({
    /** 统一待办：跨 membership 聚合（审批/告警/工单占位——按店分组返回工作区清单与各自待办计数） */
    unified: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!.memberId);
      if (!accId) return { groups: [] };
      const ships = await listMemberships(getAppPool().query.bind(getAppPool()), accId);
      const groups = [];
      for (const m of ships) {
        // 各工作区待办计数（审批卡 pending；告警/工单由行业包数据面补充，结构先行）
        const approvals = await getAppPool().query(
          `SELECT count(*)::int AS c FROM approvals WHERE workspace_id=$1 AND status='pending'`,
          [m.workspace_id]).catch(() => ({ rows: [{ c: 0 }] }));
        groups.push({
          workspaceId: m.workspace_id, slug: m.slug, workspaceName: m.workspace_name,
          tenantName: m.tenant_name, role: m.role, industry: m.industry,
          pendingApprovals: (approvals.rows[0] as { c: number }).c,
        });
      }
      return { groups };
    }),
  }),
});

function assertOwnerOrManager(role: string): void {
  if (role !== "owner" && role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "仅 owner/manager 可管理成员与授权" });
  }
}

async function accountIdOf(memberId: string): Promise<string | undefined> {
  const r = await getAppPool().query(`SELECT account_id FROM members WHERE id=$1`, [memberId]);
  return r.rows[0]?.account_id as string | undefined;
}
