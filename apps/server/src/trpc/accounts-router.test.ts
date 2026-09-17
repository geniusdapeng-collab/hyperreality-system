import { describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";

const currentMemberAuthorityMock = vi.hoisted(() => vi.fn());

vi.mock("../service/access-authority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../service/access-authority.js")>();
  return { ...actual, currentMemberAuthority: currentMemberAuthorityMock };
});

import { accountsRouter } from "./accounts-router.js";

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

const context = {
  session: identity,
  identity,
  partnerIdentity: null,
  headers: new Headers(),
};

describe("账号高风险操作输入边界", () => {
  it("公开验证码端点拒绝高风险操作用途", async () => {
    const caller = accountsRouter.createCaller({ session: null, identity: null, partnerIdentity: null, headers: new Headers() });
    await expect(caller.auth.requestCode({
      channel: "phone",
      target: "13800001111",
      purpose: "danger-confirm",
    } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it.each([
    ["移除成员", () => accountsRouter.createCaller(context).admin.remove({ memberId: "mem-other" } as never)],
    ["修改角色", () => accountsRouter.createCaller(context).admin.updateRole({ memberId: "mem-other", role: "staff" } as never)],
    ["签发密钥", () => accountsRouter.createCaller(context).admin.createApiKey({ name: "只读对接", capabilities: ["read:*"] } as never)],
    ["轮换密钥", () => accountsRouter.createCaller(context).admin.rotateApiKey({ keyId: "key-1", overlapMinutes: 60 } as never)],
    ["吊销密钥", () => accountsRouter.createCaller(context).admin.revokeApiKey({ keyId: "key-1" } as never)],
    ["签发伙伴授权", () => accountsRouter.createCaller(context).admin.issueGrant({ partnerId: "ptr-1", workspaces: ["ws-1"], capabilities: ["report.view"], ttlDays: 30 } as never)],
  ])("%s缺少一次性身份验证码时在业务执行前拒绝", async (_label, call) => {
    currentMemberAuthorityMock.mockResolvedValueOnce({ identity, permissions: {} });
    await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
