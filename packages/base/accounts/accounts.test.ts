/**
 * accounts 测试：
 *  ① 纯函数（kdf/token/模板结构）——常跑；
 *  ② PG 集成（RUN_DB_TESTS=1 + DATABASE_URL）——0027 迁移后的业务全链路：
 *     注册→验证码登录→刷新旋转→切店→邀请接受→移除失效→伙伴授权/登录/吊销→API 密钥→审批模板。
 *     该链路包含“身份建立前”和跨工作区聚合，按服务端正式入口使用受控 owner 连接；
 *     workloom_app 的精确权限与 RLS 另由 accounts/role-access.test.ts 独立回归。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { hashPassword, verifyPassword, hashSecret, newId } from "./kdf.js";
import { mintRefreshToken, hashRefreshToken, signAccessToken, signPartnerToken, ACCESS_TTL_SEC } from "./tokens.js";
import { APPROVAL_TEMPLATES } from "./policies.js";
import { createSmsSender, DevEchoSms, UnavailableSms } from "./providers.js";
import { verifyToken } from "../tenancy/auth.js";
import { issueGrant, revokeGrant } from "./partner.js";
import { developmentVerificationCode, suggestedWorkspaceSlug, type AccountsDeps } from "./service.js";

/* ================= ① 纯函数 ================= */

describe("kdf 口令散列", () => {
  it("scrypt 往返：正确口令通过、错误口令拒绝、盐互不相同", () => {
    const h1 = hashPassword("S3cret!"), h2 = hashPassword("S3cret!");
    expect(h1).not.toBe(h2); // 随机盐
    expect(verifyPassword("S3cret!", h1)).toBe(true);
    expect(verifyPassword("S3cret!", h2)).toBe(true);
    expect(verifyPassword("wrong", h1)).toBe(false);
    expect(verifyPassword("S3cret!", "garbage")).toBe(false);
  });

  it("hashSecret 稳定且带盐隔离", () => {
    expect(hashSecret("123456", "13800001111")).toBe(hashSecret("123456", "13800001111"));
    expect(hashSecret("123456", "13800001111")).not.toBe(hashSecret("123456", "13800002222"));
  });
});

describe("工作区地址建议", () => {
  it("中文名称不伪造拼音，使用稳定且合法的手机号尾号建议", () => {
    expect(suggestedWorkspaceSlug("研发中心", "13800001234")).toBe("workspace-1234");
  });

  it("拉丁名称规范化并限制为客户端可接受的安全地址", () => {
    expect(suggestedWorkspaceSlug(" Product  Team ", "13800001234")).toBe("product-team");
    const value = suggestedWorkspaceSlug("A very very very very very long workspace name", "13800001234");
    expect(value).toMatch(/^[a-z0-9][a-z0-9-]{2,31}$/);
    expect(value.length).toBeLessThanOrEqual(32);
  });
});

describe("验证码生产边界", () => {
  it("生产环境永不把本地验证码放入接口响应", () => {
    expect(developmentVerificationCode("123456", "production")).toBeUndefined();
    expect(developmentVerificationCode("123456", "development")).toBe("123456");
  });
});

describe("令牌", () => {
  it("refresh：mint/hash 对称，明文散列不可逆", () => {
    const { plain, hash } = mintRefreshToken();
    expect(hashRefreshToken(plain)).toBe(hash);
    expect(hash).not.toContain(plain);
  });

  it("access JWT：claims 与演示令牌同构（verifyToken 直接还原 Identity）", async () => {
    const identity = {
      memberId: "mem-1", memberNo: "MEM-001", name: "王店长", role: "owner" as const,
      tenantId: "tenant-x", workspaceId: "ws-x", plan: "pro" as const,
    };
    const token = await signAccessToken(identity);
    const back = await verifyToken(token);
    expect(back).toMatchObject(identity);
  });

  it("账号访问令牌与认证校验共用部署签发方", async () => {
    const previous = process.env.JWT_ISSUER;
    try {
      process.env.JWT_ISSUER = "workloom-account-test";
      const identity = {
        memberId: "mem-2", memberNo: "MEM-002", name: "测试成员", role: "staff" as const,
        tenantId: "tenant-x", workspaceId: "ws-x", plan: "pro" as const,
      };
      const token = await signAccessToken(identity);
      expect(await verifyToken(token)).toMatchObject(identity);
      process.env.JWT_ISSUER = "workloom-another-product";
      expect(await verifyToken(token)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.JWT_ISSUER;
      else process.env.JWT_ISSUER = previous;
    }
  });

  it("partner JWT：kind=partner + 授权清单快照可验签", async () => {
    const token = await signPartnerToken({
      kind: "partner", partnerId: "ptr-1", contactAccountId: "acc-1", name: "代运营A",
      grants: [{ grantId: "grt-1", tenantId: "t-1", workspaces: ["ws-1"], capabilities: ["ticket.handle"] }],
    });
    expect(token.split(".").length).toBe(3);
  });

  it("access TTL 常量 = 2 小时（PRD 口径）", () => {
    expect(ACCESS_TTL_SEC).toBe(7200);
  });
});

describe("审批三套业态模板（PRD §5.2 结构校验）", () => {
  it("民宿一人店：经营/资金归 owner，资金二次验证，红线 block", () => {
    const t = APPROVAL_TEMPLATES.single;
    expect(t.find((r) => r.actionClass === "daily")?.fenceLevel).toBe("auto");
    expect(t.find((r) => r.actionClass === "business")?.approverRule.role).toBe("owner");
    expect(t.find((r) => r.actionClass === "finance")?.approverRule.secondFactor).toBe(true);
    expect(t.find((r) => r.actionClass === "redline")?.fenceLevel).toBe("block");
  });

  it("无人酒店：经营敏感委托数字 CEO（授权带），资金远程 owner 必审", () => {
    const t = APPROVAL_TEMPLATES.unmanned;
    expect(t.find((r) => r.actionClass === "business")?.approverRule.digitalCeo).toBeTruthy();
    expect(t.find((r) => r.actionClass === "finance")?.approverRule.remote).toBe(true);
  });

  it("集团门店：店长→区域→品牌分级升级", () => {
    const t = APPROVAL_TEMPLATES["group-store"];
    expect(t.find((r) => r.actionClass === "business")?.approverRule.escalate).toBeTruthy();
    expect(t.find((r) => r.actionClass === "finance")?.approverRule.role).toBe("region-manager");
    expect(t.find((r) => r.actionClass === "redline")?.approverRule.groupVisible).toBe(true);
  });

  it("四套动作类齐全且 fence 档位合法", () => {
    for (const rows of Object.values(APPROVAL_TEMPLATES)) {
      expect(rows.map((r) => r.actionClass).sort()).toEqual(["business", "daily", "finance", "redline"]);
      for (const r of rows) expect(["auto", "review", "block"]).toContain(r.fenceLevel);
    }
  });
});

describe("providers（开发通道）", () => {
  it("DevEchoSms 记录发送内容（不自真发短信）", async () => {
    const sms = new DevEchoSms();
    await sms.send("13800001111", "验证码 123456");
    expect(sms.sent[0]).toMatchObject({ target: "13800001111" });
    expect(sms.sent[0]!.text).toContain("123456");
  });

  it("短信通道默认失败关闭，且生产环境禁止开发回声", async () => {
    await expect(createSmsSender({}).send("13800001111", "验证码 123456"))
      .rejects.toThrow("短信通道未配置");
    await expect(createSmsSender({ driver: "dev", nodeEnv: "production" }).send("13800001111", "验证码 123456"))
      .rejects.toThrow("生产环境禁止");
    expect(createSmsSender({ driver: "dev", nodeEnv: "development" })).toBeInstanceOf(DevEchoSms);
    expect(createSmsSender({ driver: "aliyun", nodeEnv: "production" })).toBeInstanceOf(UnavailableSms);
  });
});

describe("伙伴授权租户边界", () => {
  const grantInput = {
    partnerId: "ptr-1",
    tenantId: "tenant-a",
    workspaces: ["ws-a"],
    capabilities: ["ticket.handle" as const],
    ttlDays: 30,
    issuedBy: "mem-owner",
  };

  it("签发必须明确选择工作区，且所有工作区都属于当前租户", async () => {
    let queryCount = 0;
    const deps: AccountsDeps = {
      sms: new DevEchoSms(),
      q: async (text) => {
        queryCount += 1;
        if (text.includes("SELECT id FROM workspaces")) return { rows: [] };
        return { rows: [] };
      },
    };

    await expect(issueGrant(deps, { ...grantInput, workspaces: [] }))
      .rejects.toThrow("至少一个工作区");
    expect(queryCount).toBe(0);

    await expect(issueGrant(deps, grantInput)).rejects.toThrow("当前租户");
    expect(queryCount).toBe(1);
  });

  it("合法签发只写入已校验的工作区；吊销始终按租户收口", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const deps: AccountsDeps = {
      sms: new DevEchoSms(),
      q: async (text, params) => {
        calls.push({ text, params });
        if (text.includes("SELECT id FROM workspaces")) return { rows: [{ id: "ws-a" }] };
        if (text.includes("UPDATE partner_grants")) {
          return { rows: params?.[2] === "tenant-a" ? [{ id: "grt-1" }] : [] };
        }
        return { rows: [] };
      },
    };

    await expect(issueGrant(deps, grantInput)).resolves.toMatchObject({ grantId: expect.any(String) });
    const insert = calls.find((call) => call.text.includes("INSERT INTO partner_grants"));
    expect(insert?.params?.[3]).toBe('["ws-a"]');

    await expect(revokeGrant(deps, "grt-1", "合作终止", "tenant-b"))
      .rejects.toThrow("当前租户");
    await expect(revokeGrant(deps, "grt-1", "合作终止", "tenant-a")).resolves.toBeUndefined();
    const revokeCalls = calls.filter((call) => call.text.includes("UPDATE partner_grants"));
    expect(revokeCalls.every((call) => call.text.includes("tenant_id=$3"))).toBe(true);
  });
});

/* ================= ② PG 集成（RUN_DB_TESTS=1） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成 · 账号全链路（0027 迁移后）", () => {
  let pool: import("pg").Pool;
  let svc: typeof import("./service.js");
  let prt: typeof import("./partner.js");
  let pol: typeof import("./policies.js");
  let deps: import("./service.js").AccountsDeps;
  const phone = `139${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  let devCode = "";
  let session: { accessToken: string; refreshToken: string };
  let wsSlug: string;
  let accountId = "";
  let tenantId = "";

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    // 与 accountsRouter 的公开登录/激活例外保持一致：身份建立前无法设置 RLS scope。
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    svc = await import("./service.js");
    prt = await import("./partner.js");
    pol = await import("./policies.js");
    deps = { q: (t, p) => pool.query(t, p as never[]), sms: new DevEchoSms() };
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("自助开通：注册→建租户→首店→owner 身份→签发双令牌", async () => {
    const c = await svc.requestCode(deps, { channel: "phone", target: phone, purpose: "activate" });
    devCode = c.devCode!;
    expect(devCode).toMatch(/^\d{6}$/);
    wsSlug = `shop-${Math.random().toString(36).slice(2, 8)}`;
    const r = await svc.registerTenantOwner(deps, {
      phone, code: devCode, displayName: "老板甲",
      tenantName: "测试民宿集团", workspaceName: "云栖一号店", workspaceSlug: wsSlug, industry: "hotel",
    });
    expect(r.identity.role).toBe("owner");
    expect(r.accessToken.split(".").length).toBe(3);
    expect(r.refreshToken.length).toBeGreaterThan(20);
    session = r;
    tenantId = r.tenantId;
    const acc = await pool.query(`SELECT id FROM accounts WHERE phone=$1`, [phone]);
    accountId = acc.rows[0].id;
  });

  it("验证码一次性：重用被拒", async () => {
    const ok = await svc.consumeCode(deps, { channel: "phone", target: phone, purpose: "activate", code: devCode });
    expect(ok).toBe(false);
  });

  it("高风险验证码绑定具体动作，且消费后不能重放", async () => {
    const challenge = await svc.requestCode(deps, {
      channel: "phone", target: phone, purpose: "danger-confirm:member.remove",
    });
    expect(await svc.consumeCode(deps, {
      channel: "phone", target: phone, purpose: "danger-confirm:api-key.revoke", code: challenge.devCode!,
    })).toBe(false);
    expect(await svc.consumeCode(deps, {
      channel: "phone", target: phone, purpose: "danger-confirm:member.remove", code: challenge.devCode!,
    })).toBe(true);
    expect(await svc.consumeCode(deps, {
      channel: "phone", target: phone, purpose: "danger-confirm:member.remove", code: challenge.devCode!,
    })).toBe(false);
  });

  it("验证码登录 + 每日限发 5 次", async () => {
    for (let i = 0; i < 5; i++) await svc.requestCode(deps, { channel: "phone", target: phone, purpose: "login" });
    await expect(svc.requestCode(deps, { channel: "phone", target: phone, purpose: "login" }))
      .rejects.toThrow("上限"); // 第 6 次超限
    // 用最后一枚验证码登录（dev 通道最后一发）
    const sms = deps.sms as DevEchoSms;
    const code = sms.sent[sms.sent.length - 1]!.text.match(/(\d{6})/)![1]!;
    const r = await svc.loginWithCode(deps, { phone, code, workspaceSlug: wsSlug });
    expect(r.identity.role).toBe("owner");
    session = r;
  });

  it("错误密码登录累计 5 次锁定 15 分钟", async () => {
    const email = `boss${Math.random().toString(36).slice(2, 6)}@t.cn`;
    await pool.query(`INSERT INTO accounts (id, email, display_name, password_hash) VALUES ($1,$2,$3,$4)`,
      [newId("acc"), email, "锁测试", hashPassword("Right#1")]);
    for (let i = 0; i < 5; i++) {
      await svc.loginWithPassword(deps, { email, password: "wrong", workspaceSlug: wsSlug }).catch((e) => e);
    }
    await expect(svc.loginWithPassword(deps, { email, password: "Right#1", workspaceSlug: wsSlug }))
      .rejects.toThrow(/锁定|锁/);
  });

  it("refresh 旋转：旧串作废、新串可用；切店到第二家工作区", async () => {
    // 第二家店 + 本账号 membership
    const ws2 = `ws-${Math.random().toString(36).slice(2, 8)}`;
    const ws2Slug = `shop2-${Math.random().toString(36).slice(2, 6)}`;
    await pool.query(`INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config) VALUES ($1,$2,$3,$4,'hotel','stable','{}')`,
      [ws2, tenantId, "云栖二号店", ws2Slug]);
    await pool.query(`INSERT INTO members (id, workspace_id, member_no, name, role, account_id, status) VALUES ($1,$2,'MEM-002','老板甲','owner',$3,'active')`,
      [newId("mem"), ws2, accountId]);
    const r1 = await svc.refreshSession(deps, { refreshToken: session.refreshToken, workspaceSlug: ws2Slug });
    expect(r1.identity.workspaceId).toBe(ws2);
    await expect(svc.refreshSession(deps, { refreshToken: session.refreshToken, workspaceSlug: ws2Slug }))
      .rejects.toThrow("失效");
    session = r1;
    // 统一待办数据源：一人两店
    const ships = await svc.listMemberships(deps.q, accountId);
    expect(ships.length).toBe(2);
  });

  it("邀请→接受→成员生效；移除后立即失去身份", async () => {
    const staff = `138${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const { inviteCode } = await svc.inviteMember(deps, {
      workspaceId: (await pool.query(`SELECT id FROM workspaces WHERE slug=$1`, [wsSlug])).rows[0].id,
      phone: staff, role: "staff", name: "前台乙", invitedBy: "mem-test",
    });
    const r = await svc.acceptInvite(deps, { phone: staff, code: inviteCode, workspaceSlug: wsSlug, displayName: "前台乙" });
    expect(r.identity.role).toBe("staff");
    // 移除 → identityFor 返 null → refresh 拒绝
    await svc.removeMember(deps, {
      workspaceId: r.identity.workspaceId, memberId: r.identity.memberId,
    });
    await expect(svc.refreshSession(deps, { refreshToken: r.refreshToken, workspaceSlug: wsSlug }))
      .rejects.toThrow("没有成员身份");
  });

  it("伙伴域：登记→授权→伙伴登录→能力校验→吊销即时生效", async () => {
    const agencyPhone = `137${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const { partnerId } = await prt.ensurePartner(deps, { name: "安心代运营", type: "agency", contactPhone: agencyPhone });
    const wsId = (await pool.query(`SELECT id FROM workspaces WHERE slug=$1`, [wsSlug])).rows[0].id;
    await expect(prt.issueGrant(deps, {
      partnerId, tenantId, workspaces: [], capabilities: ["ticket.handle"], ttlDays: 90, issuedBy: "mem-test",
    })).rejects.toThrow("至少一个工作区");
    await expect(prt.issueGrant(deps, {
      partnerId, tenantId, workspaces: ["ws-outside-current-tenant"], capabilities: ["ticket.handle"], ttlDays: 90, issuedBy: "mem-test",
    })).rejects.toThrow("当前租户");
    const { grantId } = await prt.issueGrant(deps, {
      partnerId, tenantId, workspaces: [wsId], capabilities: ["ticket.handle", "report.view"], ttlDays: 90, issuedBy: "mem-test",
    });
    // 伙伴登录
    await svc.requestCode(deps, { channel: "phone", target: agencyPhone, purpose: "login" });
    const sms = deps.sms as DevEchoSms;
    const code = sms.sent[sms.sent.length - 1]!.text.match(/(\d{6})/)![1]!;
    const login = await prt.partnerLogin(deps, { phone: agencyPhone, code });
    expect(login.identity.kind).toBe("partner");
    expect(login.identity.grants[0]).toMatchObject({ grantId, tenantId });
    // 能力校验：白名单内通过、名单外拒绝、别家租户拒绝
    expect((await prt.checkPartnerCapability(deps.q, { partnerId, tenantId, workspaceId: wsId, capability: "ticket.handle" })).ok).toBe(true);
    expect((await prt.checkPartnerCapability(deps.q, { partnerId, tenantId, workspaceId: wsId, capability: "credit.adjust" })).ok).toBe(false);
    expect((await prt.checkPartnerCapability(deps.q, { partnerId, tenantId: "tenant-other", capability: "ticket.handle" })).ok).toBe(false);
    // 吊销 → 即时失效
    await expect(prt.revokeGrant(deps, grantId, "越权吊销", "tenant-other")).rejects.toThrow("当前租户");
    expect((await prt.checkPartnerCapability(deps.q, { partnerId, tenantId, workspaceId: wsId, capability: "ticket.handle" })).ok).toBe(true);
    await prt.revokeGrant(deps, grantId, "合作终止", tenantId);
    expect((await prt.checkPartnerCapability(deps.q, { partnerId, tenantId, workspaceId: wsId, capability: "ticket.handle" })).ok).toBe(false);
  });

  it("一次性工单通行证：单工单+短时效+仅 workorder.self", async () => {
    const wsId = (await pool.query(`SELECT id FROM workspaces WHERE slug=$1`, [wsSlug])).rows[0].id;
    const r = await prt.issueWorkorderPass(deps, {
      phone: `136${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      name: "保洁王姐", tenantId, workspaceId: wsId, ticketId: "tkt-001", issuedBy: "mem-test",
    });
    expect(r.passCode).toMatch(/^\d{6}$/);
  });

  it("API 密钥：签发→双密钥轮换→确认切换→吊销", async () => {
    const wsId = (await pool.query(`SELECT id FROM workspaces WHERE slug=$1`, [wsSlug])).rows[0].id;
    const { keyId, plainKey } = await pol.createApiKey(deps, {
      workspaceId: wsId, name: "PMS 对接", capabilities: ["read:orders"], createdBy: "mem-test",
    });
    expect(plainKey.startsWith("wlk_")).toBe(true);
    const id1 = await pol.verifyApiKey(deps.q, plainKey);
    expect(id1).toMatchObject({ workspaceId: wsId, capabilities: ["read:orders"] });
    const rotated = await pol.rotateApiKey(deps, {
      workspaceId: wsId, keyId, overlapMinutes: 5, createdBy: "mem-test",
    });
    expect(rotated.plainKey.startsWith("wlk_")).toBe(true);
    expect(rotated.plainKey).not.toBe(plainKey);
    expect(await pol.verifyApiKey(deps.q, plainKey)).toMatchObject({ keyId });
    expect(await pol.verifyApiKey(deps.q, rotated.plainKey)).toMatchObject({ keyId: rotated.keyId });

    const duringRotation = await pol.listApiKeys(deps.q, wsId);
    expect(duringRotation.find((row) => row.id === keyId)).toMatchObject({ replaced_by: rotated.keyId });
    expect(duringRotation.find((row) => row.id === rotated.keyId)).toMatchObject({ rotation_of: keyId });

    await pol.completeApiKeyRotation(deps.q, wsId, keyId);
    expect(await pol.verifyApiKey(deps.q, plainKey)).toBeNull();
    expect(await pol.verifyApiKey(deps.q, rotated.plainKey)).toMatchObject({ keyId: rotated.keyId });
    await pol.revokeApiKey(deps.q, wsId, rotated.keyId);
    expect(await pol.verifyApiKey(deps.q, rotated.plainKey)).toBeNull();
  });

  it("API 密钥：并存窗口到期自动落成失效状态", async () => {
    const wsId = (await pool.query(`SELECT id FROM workspaces WHERE slug=$1`, [wsSlug])).rows[0].id;
    const source = await pol.createApiKey(deps, {
      workspaceId: wsId, name: "自动到期回归", capabilities: ["read:events"], createdBy: "mem-test",
    });
    const rotated = await pol.rotateApiKey(deps, {
      workspaceId: wsId, keyId: source.keyId, overlapMinutes: 5, createdBy: "mem-test",
    });
    await pool.query(`UPDATE api_keys SET overlap_expires_at=now()-interval '1 second' WHERE id=$1`, [source.keyId]);
    expect(await pol.verifyApiKey(deps.q, source.plainKey)).toBeNull();
    expect(await pol.verifyApiKey(deps.q, rotated.plainKey)).toMatchObject({ keyId: rotated.keyId });
    const rows = await pol.listApiKeys(deps.q, wsId);
    expect(rows.find((row) => row.id === source.keyId)?.revoked_at).toBeTruthy();
  });

  it("审批模板应用：预填四行且幂等", async () => {
    const wsId = (await pool.query(`SELECT id FROM workspaces WHERE slug=$1`, [wsSlug])).rows[0].id;
    const r1 = await pol.applyApprovalTemplate(deps, { workspaceId: wsId, archetype: "unmanned", updatedBy: "mem-test" });
    expect(r1.applied).toBe(4);
    const rows = await pol.listApprovalPolicies(deps.q, wsId);
    expect(rows.length).toBe(4);
    expect(rows.find((r) => r.action_class === "finance")!.fence_level).toBe("review");
  });

  it("集团租户层级：挂接+门店清单", async () => {
    const childId = newId("tenant");
    await pool.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,'加盟一店','pro')`, [childId]);
    await pol.linkTenant(deps, { parentTenantId: tenantId, childTenantId: childId, relation: "franchise", settlement: "self_pay" });
    const kids = await pol.childTenants(deps.q, tenantId);
    expect(kids[0]).toMatchObject({ child_tenant_id: childId, relation: "franchise" });
  });
});
