/**
 * B5 测试：版本能力矩阵（F7.2 口径）+ 越版守卫（H-10）+ JWT 往返 + 成员读服务（PG 集成 H-9）
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCapabilities,
  hasCapability,
  PLAN_CAPABILITIES,
  PlanForbidden,
  requireCapability,
} from "./capabilities.js";
import { sessionTokenIssuer, signDemoToken, verifySessionToken, verifyToken, type Identity } from "./auth.js";

describe("版本能力矩阵（F7.2 唯一口径）", () => {
  it("社区版：无 Quest preset / 无夜班 / 无巡检，事件保留 7 天", () => {
    const c = PLAN_CAPABILITIES.community;
    expect(c.quest).toBe(false);
    expect(c.nightShift).toBe(false);
    expect(c.inspection).toBe(false);
    expect(c.eventRetentionDays).toBe(7);
  });

  it("Pro：完整夜班+巡检；Teams：+共享记忆/审计；VPC：+内网 seam/本地模型", () => {
    expect(hasCapability("pro", "nightShift")).toBe(true);
    expect(hasCapability("pro", "sharedMemory")).toBe(false);
    expect(hasCapability("teams", "sharedMemory")).toBe(true);
    expect(hasCapability("teams", "auditReport")).toBe(true);
    expect(hasCapability("teams", "vpcSeam")).toBe(false);
    expect(hasCapability("vpc", "vpcSeam")).toBe(true);
    expect(hasCapability("vpc", "localModel")).toBe(true);
  });

  it("矩阵逐级包含（community ⊂ pro ⊂ teams ⊂ vpc）", () => {
    for (const cap of ["quest", "nightShift", "inspection"] as const) {
      expect(getCapabilities("community")[cap]).toBe(false);
      expect(getCapabilities("pro")[cap]).toBe(true);
    }
  });
});

describe("越版守卫（H-10：403 + 升级提示）", () => {
  it("社区版调 Quest → PlanForbidden（403 语义 + 升级提示）", () => {
    try {
      requireCapability("community", "quest");
      expect.unreachable();
    } catch (e) {
      const err = e as PlanForbidden;
      expect(err).toBeInstanceOf(PlanForbidden);
      expect(err.statusCode).toBe(403);
      expect(err.upgradeHint).toContain("专业版");
      expect(err.message).not.toMatch(/community|quest|F7\.2/i);
    }
  });

  it("VPC 专属能力的升级提示指向 vpc", () => {
    try {
      requireCapability("teams", "localModel");
      expect.unreachable();
    } catch (e) {
      expect((e as PlanForbidden).upgradeHint).toContain("私有部署版");
    }
  });

  it("具备能力放行", () => {
    expect(() => requireCapability("pro", "quest")).not.toThrow();
  });
});

describe("演示身份 JWT", () => {
  it("未显式覆盖时从受保护产品清单派生签发方", () => {
    const previous = process.env.JWT_ISSUER;
    try {
      delete process.env.JWT_ISSUER;
      const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
      const product = JSON.parse(readFileSync(join(repositoryRoot, "product.manifest.json"), "utf8")) as {
        productId: string;
      };
      expect(sessionTokenIssuer()).toBe(product.productId);
    } finally {
      if (previous === undefined) delete process.env.JWT_ISSUER;
      else process.env.JWT_ISSUER = previous;
    }
  });

  const identity: Identity = {
    memberId: "mem-001-id", memberNo: "MEM-001", name: "王店长", role: "owner",
    tenantId: "tenant-demo", workspaceId: "ws-yunqi", plan: "pro",
  };

  it("签发→校验往返一致", async () => {
    const token = await signDemoToken(identity);
    const back = await verifyToken(token);
    expect(back).toMatchObject(identity);
  });

  it("篡改令牌验签失败（返回 null）", async () => {
    const token = await signDemoToken(identity);
    const tampered = token.slice(0, -4) + "AAAA";
    expect(await verifyToken(tampered)).toBeNull();
    expect(await verifyToken("not-a-jwt")).toBeNull();
  });

  it("伙伴令牌不能混入成员保护过程", async () => {
    const { signPartnerToken } = await import("../accounts/tokens.js");
    const token = await signPartnerToken({
      kind: "partner",
      partnerId: "ptr-1",
      contactAccountId: "acc-1",
      name: "交付伙伴",
      grants: [{ grantId: "grt-1", tenantId: "tenant-demo", workspaces: ["ws-yunqi"], capabilities: ["report.view"] }],
    });
    expect(await verifyToken(token)).toBeNull();
    expect(await verifySessionToken(token)).toMatchObject({ kind: "partner", partnerId: "ptr-1" });
  });

  it("行业部署可配置独立签发方，其他签发方的令牌失败关闭", async () => {
    const previous = process.env.JWT_ISSUER;
    try {
      process.env.JWT_ISSUER = "workloom-industry-test";
      const token = await signDemoToken(identity);
      expect(await verifyToken(token)).toMatchObject(identity);
      process.env.JWT_ISSUER = "workloom-other-product";
      expect(await verifyToken(token)).toBeNull();
      process.env.JWT_ISSUER = "INVALID ISSUER";
      await expect(signDemoToken(identity)).rejects.toThrow("JWT_ISSUER");
    } finally {
      if (previous === undefined) delete process.env.JWT_ISSUER;
      else process.env.JWT_ISSUER = previous;
    }
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成成员读（H-9 跨工作区返回空）", async () => {
  const pg = (await import("pg")).default;
  const { getMember, listMembers } = await import("./members.js");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });

  it("种子工作区读到 3 成员（王店长 owner）", async () => {
    const ms = await listMembers(pool, { tenantId: "tenant-demo", workspaceId: "ws-yunqi" });
    expect(ms.length).toBe(3);
    expect(ms[0]).toMatchObject({ memberNo: "MEM-001", name: "王店长", role: "owner" });
  });

  it("跨工作区查询返回空（H-9/L7.1，非 403）", async () => {
    const m = await getMember(pool, { tenantId: "tenant-demo", workspaceId: "ws-other" }, "MEM-001");
    expect(m).toBeNull();
    const ms = await listMembers(pool, { tenantId: "tenant-demo", workspaceId: "ws-other" });
    expect(ms).toEqual([]);
  });
});
