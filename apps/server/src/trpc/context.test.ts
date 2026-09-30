import { describe, expect, it, vi } from "vitest";
import { signPartnerToken } from "@workloom/base/accounts";
import type { Identity } from "@workloom/base/tenancy";

const currentMemberAuthorityMock = vi.hoisted(() => vi.fn());
const resolveAuthoritativeClientAccessMock = vi.hoisted(() => vi.fn());

vi.mock("../service/access-authority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../service/access-authority.js")>();
  return {
    ...actual,
    currentMemberAuthority: currentMemberAuthorityMock,
    resolveAuthoritativeClientAccess: resolveAuthoritativeClientAccessMock,
  };
});

import {
  actionProcedure,
  bundleActionWriteProcedure,
  capabilityProcedure,
  createContext,
  navigationPermissionProcedure,
  navigationPermissionWriteProcedure,
  protectedProcedure,
  router,
} from "./context.js";

describe("会话域隔离", () => {
  it("伙伴 JWT 不能调用普通成员 protectedProcedure", async () => {
    const token = await signPartnerToken({
      kind: "partner",
      partnerId: "ptr-1",
      contactAccountId: "acc-1",
      name: "服务伙伴",
      grants: [{ grantId: "grt-1", tenantId: "tenant-1", workspaces: ["ws-1"], capabilities: ["report.view"] }],
    });
    const context = await createContext(new Request("http://local.test", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(context.identity).toBeNull();
    expect(context.partnerIdentity).toMatchObject({ partnerId: "ptr-1" });

    const testRouter = router({ memberOnly: protectedProcedure.query(() => "不应到达") });
    await expect(testRouter.createCaller(context).memberOnly()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("客户端隐藏动作后，同一 member.permissions deny 也拒绝 API 直调", async () => {
    const identity: Identity = {
      kind: "member",
      memberId: "mem-owner",
      memberNo: "MEM-001",
      name: "负责人",
      role: "owner",
      tenantId: "tenant-1",
      workspaceId: "ws-1",
      plan: "pro",
    };
    currentMemberAuthorityMock.mockResolvedValueOnce({
      identity,
      permissions: { deny: ["guardrail.manage"] },
    });
    const context = {
      session: identity,
      identity,
      partnerIdentity: null,
      headers: new Headers(),
    };
    const testRouter = router({
      mutateGuardrail: actionProcedure("guardrail.manage").mutation(() => "不应到达"),
    });
    const promise = testRouter.createCaller(context).mutateGuardrail();
    await expect(promise).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("围栏管理"),
    });
    await expect(promise).rejects.not.toMatchObject({
      message: expect.stringContaining("guardrail.manage"),
    });
  });

  it("越版错误只返回中文业务名，不暴露套餐或能力代码", async () => {
    const identity: Identity = {
      kind: "member",
      memberId: "mem-community",
      memberNo: "MEM-003",
      name: "社区版成员",
      role: "owner",
      tenantId: "tenant-1",
      workspaceId: "ws-1",
      plan: "community",
    };
    currentMemberAuthorityMock.mockResolvedValue({ identity, permissions: {} });
    const context = { session: identity, identity, partnerIdentity: null, headers: new Headers() };
    const testRouter = router({
      manageNight: capabilityProcedure("nightShift").query(() => "不应到达"),
    });
    const promise = testRouter.createCaller(context).manageNight();
    await expect(promise).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("夜班自动运行"),
    });
    await expect(promise).rejects.not.toMatchObject({
      message: expect.stringMatching(/community|nightShift|F7\.2/i),
    });
  });

  it.each([
    ["只读成员", "readonly", "pro", "workspace.write"],
    ["降级社区版负责人", "owner", "community", "night.manage"],
  ] as const)("%s不能绕过客户端直调受限动作", async (_label, role, plan, action) => {
    const identity: Identity = {
      kind: "member",
      memberId: `mem-${role}`,
      memberNo: "MEM-002",
      name: "受限成员",
      role,
      tenantId: "tenant-1",
      workspaceId: "ws-1",
      plan,
    };
    currentMemberAuthorityMock.mockResolvedValueOnce({ identity, permissions: {} });
    const context = {
      session: identity,
      identity,
      partnerIdentity: null,
      headers: new Headers(),
    };
    const testRouter = router({
      mutate: actionProcedure(action).mutation(() => "不应到达"),
    });
    await expect(testRouter.createCaller(context).mutate()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("已隐藏的行业开发能力也不能通过 API 直调", async () => {
    const identity: Identity = {
      kind: "member",
      memberId: "mem-owner",
      memberNo: "MEM-001",
      name: "负责人",
      role: "owner",
      tenantId: "tenant-1",
      workspaceId: "ws-1",
      plan: "pro",
    };
    currentMemberAuthorityMock.mockResolvedValue({ identity, permissions: {} });
    resolveAuthoritativeClientAccessMock.mockResolvedValue({
      navigationPermissions: ["today.read"],
      actionPermissions: ["workspace.write"],
    });
    const context = { session: identity, identity, partnerIdentity: null, headers: new Headers() };
    const testRouter = router({
      readDevelopment: navigationPermissionProcedure("ai-pm.development.read").query(() => "不应到达"),
      writeDevelopment: navigationPermissionWriteProcedure("ai-pm.development.read").mutation(() => "不应到达"),
    });
    const caller = testRouter.createCaller(context);
    await expect(caller.readDevelopment()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.writeDevelopment()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("只有服务端权威载荷明确授予后才开放行业开发能力", async () => {
    const identity: Identity = {
      kind: "member",
      memberId: "mem-owner",
      memberNo: "MEM-001",
      name: "负责人",
      role: "owner",
      tenantId: "tenant-1",
      workspaceId: "ws-1",
      plan: "pro",
    };
    currentMemberAuthorityMock.mockResolvedValue({ identity, permissions: {} });
    resolveAuthoritativeClientAccessMock.mockResolvedValue({
      navigationPermissions: ["ai-pm.development.read"],
      actionPermissions: ["workspace.write"],
    });
    const context = { session: identity, identity, partnerIdentity: null, headers: new Headers() };
    const testRouter = router({
      readDevelopment: navigationPermissionProcedure("ai-pm.development.read").query(() => "已授权"),
    });
    await expect(testRouter.createCaller(context).readDevelopment()).resolves.toBe("已授权");
  });

  it("行业 execute 须独立动作授权，导航 read 与公共写权限不能代替", async () => {
    const identity: Identity = {
      kind: "member", memberId: "mem-owner", memberNo: "MEM-001", name: "负责人",
      role: "owner", tenantId: "tenant-1", workspaceId: "ws-1", plan: "pro",
    };
    currentMemberAuthorityMock.mockResolvedValue({ identity, permissions: {} });
    const context = { session: identity, identity, partnerIdentity: null, headers: new Headers() };
    const testRouter = router({
      executeFastScan: bundleActionWriteProcedure("hotel.fast-scan.execute").mutation(() => "已执行"),
    });
    resolveAuthoritativeClientAccessMock.mockResolvedValueOnce({
      navigationPermissions: ["hotel.fast-scan.read"], actionPermissions: ["workspace.write"],
    });
    await expect(testRouter.createCaller(context).executeFastScan()).rejects.toMatchObject({ code: "FORBIDDEN" });
    resolveAuthoritativeClientAccessMock.mockResolvedValueOnce({
      navigationPermissions: ["hotel.fast-scan.read"],
      actionPermissions: ["workspace.write", "hotel.fast-scan.execute"],
    });
    await expect(testRouter.createCaller(context).executeFastScan()).resolves.toBe("已执行");
  });
});
