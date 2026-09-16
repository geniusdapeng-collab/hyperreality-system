import { beforeAll, describe, expect, it } from "vitest";
import { issueH5EntryToken } from "./channels.js";

const secret = "test-only-h5-entry-production-secret-at-least-32-characters";
let request: (body: Record<string, unknown>) => Promise<Response>;

beforeAll(async () => {
  process.env.SERVICE_C_DEMO_AUTH = "false";
  process.env.SERVICE_C_H5_ENTRY_SECRET = secret;
  // 动态导入保证网关在正式认证配置下初始化；这些用例均在访问数据库前完成拒绝。
  const { serviceGateway } = await import("./gateway.js");
  request = (body) => Promise.resolve(serviceGateway.request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "h5", ...body }),
  }));
});

describe("正式 H5 会话入口", () => {
  it("不接受客户端自报身份绕过签名", async () => {
    const response = await request({ openid: "forged-user", workspaceKey: "brand-a" });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "H5_ENTRY_REQUIRED" });
  });

  it("拒绝伪造或被篡改的入口凭据", async () => {
    const response = await request({ entryToken: "not.a.valid-token", workspaceKey: "brand-a" });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "H5_ENTRY_INVALID" });
  });

  it("签名工作区与页面配置不一致时在查库前失败关闭", async () => {
    const entryToken = await issueH5EntryToken({
      workspaceKey: "brand-a",
      subject: "user-1",
      appId: "service-front",
      secret,
    });
    const response = await request({ entryToken, workspaceKey: "brand-b" });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "H5_ENTRY_SCOPE_MISMATCH" });
  });
});
