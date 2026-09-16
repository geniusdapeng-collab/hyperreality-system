import { describe, expect, it } from "vitest";
import { issueH5EntryToken, notificationDeliveryState, verifyH5EntryToken } from "./channels.js";

describe("C 端通知投递状态", () => {
  it("mock、待发送、失败、成功四态互不混淆", () => {
    expect(notificationDeliveryState("mock", "pending")).toBe("demo");
    expect(notificationDeliveryState("wechat-subscribe", "pending")).toBe("pending");
    expect(notificationDeliveryState("mock", "failed")).toBe("failed");
    expect(notificationDeliveryState("wechat-subscribe", "delivered")).toBe("sent");
  });
});

describe("C 端正式网页签名入口", () => {
  const secret = "test-only-h5-entry-secret-at-least-32-characters";

  it("只接受未过期且密钥匹配的工作区与身份声明", async () => {
    const token = await issueH5EntryToken({
      workspaceKey: "brand-a",
      subject: "external-user-42",
      appId: "customer-service",
      secret,
    });
    await expect(verifyH5EntryToken(token, secret)).resolves.toEqual({
      workspaceKey: "brand-a",
      subject: "external-user-42",
      appId: "customer-service",
      scope: "c-entry",
    });
    await expect(verifyH5EntryToken(token, `${secret}-wrong`)).resolves.toBeNull();
  });

  it("拒绝已过期入口，且不会把缺字段声明当作有效身份", async () => {
    const expired = await issueH5EntryToken({
      workspaceKey: "brand-a",
      subject: "external-user-42",
      appId: "customer-service",
      secret,
      expiresIn: 0,
    });
    await expect(verifyH5EntryToken(expired, secret)).resolves.toBeNull();
    await expect(issueH5EntryToken({ workspaceKey: "", subject: "user", appId: "app", secret })).rejects.toThrow("缺少工作区");
  });
});
