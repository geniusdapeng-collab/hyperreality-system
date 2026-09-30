import { describe, expect, it } from "vitest";
import { resolveServiceFrontPublication } from "./service-front-publication.js";

describe("C 端发布事实", () => {
  it("本机内置客户端只标为预览，且不生成会误导手机的回环地址二维码", () => {
    const result = resolveServiceFrontPublication({
      workspaceId: "ws-1",
      bundledClientAvailable: true,
      env: { NODE_ENV: "development", SERVER_PORT: "8787", SERVICE_C_WORKSPACE_ID: "ws-1" },
    });
    expect(result).toMatchObject({
      url: "http://127.0.0.1:8787/app/c/",
      urlSource: "bundled-preview",
      overall: "preview",
      publicReachable: false,
      workspaceRoutingReady: true,
      qrAvailable: false,
    });
    expect(result.channels.find((channel) => channel.key === "h5")?.status).toBe("preview");
  });

  it("按工作区选择公开地址，但未绑定工作区时保持阻断且不出二维码", () => {
    const result = resolveServiceFrontPublication({
      workspaceId: "ws-a",
      env: {
        NODE_ENV: "production",
        SERVICE_C_PUBLIC_URL_MAP: JSON.stringify({ "ws-a": "https://service.example.com/a" }),
        SERVICE_C_WORKSPACE_ID: "ws-b",
      },
    });
    expect(result.url).toBe("https://service.example.com/a");
    expect(result).toMatchObject({ publicReachable: true, workspaceRoutingReady: false, qrAvailable: false, overall: "blocked" });
    expect(result.channels[0]?.detail).toMatch(/未绑定当前工作区/);
  });

  it("多站点必须让公开地址的站点标识精确命中同一工作区", () => {
    const env = {
      // 演示档（开发）——本用例验证的是多站点路由精度，不是生产档开关语义
      NODE_ENV: "development",
      SERVICE_C_DEMO_AUTH: "true",
      SERVICE_C_PUBLIC_URL_MAP: JSON.stringify({
        "ws-a": { url: "https://a.example.com/", workspaceKey: "site-a" },
      }),
      SERVICE_C_WORKSPACE_MAP: JSON.stringify({ "site-a": "ws-a", "site-b": "ws-b" }),
    };
    expect(resolveServiceFrontPublication({ workspaceId: "ws-a", env })).toMatchObject({
      url: "https://a.example.com/",
      workspaceRoutingReady: true,
      qrAvailable: true,
      overall: "preview",
    });

    const mismatched = resolveServiceFrontPublication({
      workspaceId: "ws-a",
      env: {
        ...env,
        SERVICE_C_PUBLIC_URL_MAP: JSON.stringify({
          "ws-a": { url: "https://a.example.com/", workspaceKey: "site-b" },
        }),
      },
    });
    expect(mismatched).toMatchObject({ workspaceRoutingReady: false, qrAvailable: false, overall: "blocked" });
  });

  it("公开地址、工作区路由与演示身份齐备时只标预览，不冒充正式发布", () => {
    const result = resolveServiceFrontPublication({
      workspaceId: "ws-a",
      env: {
        // 演示身份只能在开发/本机预览档成立；生产档由下面的 MC-207 用例锁定为忽略
        NODE_ENV: "development",
        SERVICE_C_PUBLIC_URL: "https://service.example.com/entry",
        SERVICE_C_WORKSPACE_ID: "ws-a",
        SERVICE_C_DEMO_AUTH: "true",
        SERVICE_C_WECHAT_APPID: "configured",
        SERVICE_C_WECHAT_SECRET: "configured",
      },
    });
    expect(result).toMatchObject({ overall: "preview", qrAvailable: true });
    expect(result.channels.find((channel) => channel.key === "wechat-mini")?.status).toBe("partial");
    expect(result.channels.every((channel) => channel.status !== "ready")).toBe(true);
  });

  it("生产档忽略出厂演示开关：地址与路由齐备也不标成演示可登录（MC-207）", () => {
    const result = resolveServiceFrontPublication({
      workspaceId: "ws-a",
      env: {
        NODE_ENV: "production",
        SERVICE_C_PUBLIC_URL: "https://service.example.com/entry",
        SERVICE_C_WORKSPACE_ID: "ws-a",
        // 出厂 .env.example 历史值与客户升级遗留值：生产档必须忽略
        SERVICE_C_DEMO_AUTH: "true",
      },
    });
    expect(result).toMatchObject({ publicReachable: true, workspaceRoutingReady: true, overall: "blocked", qrAvailable: false });
    expect(result.channels.find((channel) => channel.key === "h5")?.status).toBe("blocked");
    expect(result.channels.find((channel) => channel.key === "h5")?.detail).toMatch(/可信入口签名尚未配置/);
  });

  it("正式身份链路缺失时即使地址公开也不生成可用服务二维码", () => {
    const result = resolveServiceFrontPublication({
      workspaceId: "ws-a",
      env: {
        NODE_ENV: "production",
        SERVICE_C_PUBLIC_URL: "https://service.example.com/entry",
        SERVICE_C_WORKSPACE_ID: "ws-a",
        SERVICE_C_DEMO_AUTH: "false",
      },
    });
    expect(result).toMatchObject({ publicReachable: true, workspaceRoutingReady: true, overall: "blocked", qrAvailable: false });
    expect(result.channels.find((channel) => channel.key === "h5")?.status).toBe("blocked");
  });

  it("只配置入口签名仍是部分就绪，身份提供方通过验收后才标记正式发布", () => {
    const baseEnv = {
      NODE_ENV: "production",
      SERVICE_C_PUBLIC_URL: "https://service.example.com/entry",
      SERVICE_C_WORKSPACE_ID: "ws-a",
      SERVICE_C_DEMO_AUTH: "false",
      SERVICE_C_H5_ENTRY_SECRET: "production-h5-entry-secret-at-least-32-characters",
    };
    const partial = resolveServiceFrontPublication({ workspaceId: "ws-a", env: baseEnv });
    expect(partial).toMatchObject({ overall: "blocked", qrAvailable: false });
    expect(partial.channels.find((channel) => channel.key === "h5")?.status).toBe("partial");

    const ready = resolveServiceFrontPublication({
      workspaceId: "ws-a",
      env: {
        ...baseEnv,
        SERVICE_C_H5_IDENTITY_PROVIDER: "enterprise-identity-gateway",
        SERVICE_C_H5_IDENTITY_PROVIDER_READY: "true",
      },
    });
    expect(ready).toMatchObject({ overall: "published", qrAvailable: true });
    expect(ready.channels.find((channel) => channel.key === "h5")?.status).toBe("ready");
  });

  it("拒绝危险协议、无效映射和超过内置二维码容量的地址", () => {
    const invalid = resolveServiceFrontPublication({
      workspaceId: "ws-a",
      env: { SERVICE_C_PUBLIC_URL: "javascript:alert(1)", SERVICE_C_PUBLIC_URL_MAP: "not-json" },
    });
    expect(invalid).toMatchObject({ url: null, qrAvailable: false, overall: "blocked" });

    const long = resolveServiceFrontPublication({
      workspaceId: "ws-a",
      env: {
        SERVICE_C_PUBLIC_URL: `https://service.example.com/${"x".repeat(100)}`,
        SERVICE_C_WORKSPACE_ID: "ws-a",
        SERVICE_C_DEMO_AUTH: "true",
      },
    });
    expect(long.publicReachable).toBe(true);
    expect(long.qrAvailable).toBe(false);
  });
});
