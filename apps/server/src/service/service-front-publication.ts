/** C 端发布事实：真实 URL、工作区路由与各渠道能力必须分别核验，不能用占位二维码冒充上线。 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectServiceWorkspaceId } from "./workspace-routing.js";

export type ChannelReadiness = "ready" | "preview" | "partial" | "blocked" | "unavailable";

export interface ServiceFrontPublication {
  url: string | null;
  urlSource: "workspace-map" | "deployment" | "bundled-preview" | "none";
  publicReachable: boolean;
  qrAvailable: boolean;
  workspaceRoutingReady: boolean;
  overall: "published" | "preview" | "blocked";
  channels: Array<{ key: "h5" | "wechat-mini" | "alipay"; label: string; status: ChannelReadiness; detail: string }>;
}

export interface ServiceFrontPublicationInput {
  workspaceId: string;
  env?: Record<string, string | undefined>;
  bundledClientAvailable?: boolean;
}

interface PublicUrlEntry { url: string; workspaceKey?: string }

function parsePublicUrlMap(raw: string | undefined): Record<string, PublicUrlEntry> {
  if (!raw?.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const entries: Array<[string, PublicUrlEntry]> = [];
    for (const [workspaceId, rawEntry] of Object.entries(value as Record<string, unknown>)) {
      // 字符串形式兼容单工作区固定路由；多站点要用对象形式显式绑定 workspaceKey。
      if (typeof rawEntry === "string" && rawEntry.trim()) {
        entries.push([workspaceId, { url: rawEntry.trim() }]);
        continue;
      }
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
      const candidate = rawEntry as Record<string, unknown>;
      if (typeof candidate.url !== "string" || !candidate.url.trim()) continue;
      entries.push([workspaceId, {
        url: candidate.url.trim(),
        ...(typeof candidate.workspaceKey === "string" && candidate.workspaceKey.trim()
          ? { workspaceKey: candidate.workspaceKey.trim() }
          : {}),
      }]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function normalizedHttpUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isLoopback(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function workspaceMapped(
  env: Record<string, string | undefined>,
  workspaceId: string,
  workspaceKey: string | undefined,
): boolean {
  try {
    return selectServiceWorkspaceId({
      fixedWorkspaceId: env.SERVICE_C_WORKSPACE_ID,
      workspaceMap: env.SERVICE_C_WORKSPACE_MAP,
      workspaceKey,
    }) === workspaceId;
  } catch {
    return false;
  }
}

export function resolveServiceFrontPublication(input: ServiceFrontPublicationInput): ServiceFrontPublication {
  const env = input.env ?? process.env;
  const urlMap = parsePublicUrlMap(env.SERVICE_C_PUBLIC_URL_MAP);
  const mappedEntry = urlMap[input.workspaceId];
  const mappedUrl = normalizedHttpUrl(mappedEntry?.url);
  const deploymentUrl = normalizedHttpUrl(env.SERVICE_C_PUBLIC_URL);
  const bundledUrl = input.bundledClientAvailable
    ? normalizedHttpUrl(`${env.SERVER_PUBLIC_ORIGIN?.trim() || `http://127.0.0.1:${env.SERVER_PORT ?? "8787"}`}/app/c/`)
    : null;
  const url = mappedUrl ?? deploymentUrl ?? bundledUrl;
  const urlSource: ServiceFrontPublication["urlSource"] = mappedUrl
    ? "workspace-map"
    : deploymentUrl ? "deployment" : bundledUrl ? "bundled-preview" : "none";
  const routeKey = mappedUrl ? mappedEntry?.workspaceKey : env.SERVICE_C_PUBLIC_WORKSPACE_KEY?.trim() || undefined;
  const routingReady = workspaceMapped(env, input.workspaceId, routeKey);
  const publicReachable = Boolean(url && !isLoopback(url));
  const demoAuth = (env.SERVICE_C_DEMO_AUTH ?? (env.NODE_ENV === "production" ? "false" : "true")) === "true";
  const h5EntrySigningReady = (env.SERVICE_C_H5_ENTRY_SECRET?.trim().length ?? 0) >= 32;
  const h5IdentityProviderReady = Boolean(
    env.SERVICE_C_H5_IDENTITY_PROVIDER?.trim()
    && env.SERVICE_C_H5_IDENTITY_PROVIDER_READY === "true",
  );

  const h5: ServiceFrontPublication["channels"][number] = !url
    ? { key: "h5", label: "移动网页", status: "unavailable", detail: "尚未配置可访问地址" }
    : !routingReady
      ? { key: "h5", label: "移动网页", status: "blocked", detail: "地址已配置，但未绑定当前工作区" }
      : demoAuth
        ? { key: "h5", label: "移动网页", status: "preview", detail: publicReachable ? "地址可访问，但仍使用演示身份，不能按正式发布验收" : "仅本机预览，尚未发布到客户可访问地址" }
        : !h5EntrySigningReady
          ? { key: "h5", label: "移动网页", status: "blocked", detail: "演示直登已关闭，但可信入口签名尚未配置" }
          : !h5IdentityProviderReady
            ? { key: "h5", label: "移动网页", status: "partial", detail: "入口签名验证已配置，但身份提供方尚未声明验收通过" }
            : { key: "h5", label: "移动网页", status: "ready", detail: "公开地址、工作区映射、短期签名入口与身份提供方均已就绪" };

  const wechatCredentials = Boolean(env.SERVICE_C_WECHAT_APPID?.trim() && env.SERVICE_C_WECHAT_SECRET?.trim());
  const wechat: ServiceFrontPublication["channels"][number] = !wechatCredentials
    ? { key: "wechat-mini", label: "微信小程序", status: "unavailable", detail: "登录凭据未配置" }
    : { key: "wechat-mini", label: "微信小程序", status: "partial", detail: "登录换取已配置；订阅消息真实发送器尚未接入" };

  // 当前代码仅保留支付宝签名 SDK seam，凭据存在也不能宣告就绪。
  const alipayCredentials = Boolean(env.SERVICE_C_ALIPAY_APPID?.trim() && env.SERVICE_C_ALIPAY_KEY?.trim());
  const alipay: ServiceFrontPublication["channels"][number] = {
    key: "alipay",
    label: "支付宝小程序",
    status: alipayCredentials ? "partial" : "unavailable",
    detail: alipayCredentials ? "凭据已配置；签名换登与服务通知发送器尚未接入" : "凭据与签名换登尚未配置",
  };

  const channels = [h5, wechat, alipay];
  const published = h5.status === "ready" && publicReachable;
  const preview = h5.status === "preview";
  const qrEncodable = Boolean(url && Buffer.byteLength(url, "utf8") <= 106);
  return {
    url,
    urlSource,
    publicReachable,
    // 回环地址生成二维码会让手机扫描后必然指向手机自身，属于“看起来可扫、实际不可达”。
    qrAvailable: Boolean(
      url
      && publicReachable
      && routingReady
      && qrEncodable
      && (h5.status === "ready" || h5.status === "preview")
    ),
    workspaceRoutingReady: routingReady,
    overall: published ? "published" : preview ? "preview" : "blocked",
    channels,
  };
}

export function bundledServiceFrontAvailable(): boolean {
  return existsSync(fileURLToPath(new URL("../../../webc/dist/index.html", import.meta.url)));
}
