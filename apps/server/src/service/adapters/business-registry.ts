/**
 * 已验证活动 Bundle → C 端行业适配器注册表。
 *
 * 数据库只决定“当前哪套装配 active”；磁盘 Bundle 清单经契约、兼容范围和
 * 完整性摘要校验后，才允许其中的 serviceFront.adapterId 选择实现。任一环节
 * 缺失、冲突或未知均失败关闭，绝不回退到示例行业。
 */
import type { BundleUiProjection } from "@workloom/base/bundles";
import { BUNDLED_BUSINESS_ADAPTERS } from "../../industry/business-adapter-catalog.js";
import {
  bindVerifiedActiveBundle,
  resolveWorkspaceActiveBundle,
  type WorkspaceBundleFacts,
} from "../active-bundle.js";
import type {
  BusinessAdapterRegistration,
  ServiceFrontBusinessAdapter,
} from "./business.js";

function buildAdapterRegistry(registrations: readonly BusinessAdapterRegistration[]) {
  const registry = new Map<string, BusinessAdapterRegistration>();
  for (const registration of registrations) {
    if (!registration.bundleIds.length) throw new Error(`行业适配器 ${registration.adapter.id} 未声明允许的 Bundle`);
    if (registry.has(registration.adapter.id)) throw new Error(`行业适配器重复登记：${registration.adapter.id}`);
    registry.set(registration.adapter.id, registration);
  }
  return registry;
}

const ADAPTERS = buildAdapterRegistry(BUNDLED_BUSINESS_ADAPTERS);

export type BusinessBindingState =
  | "ready"
  | "not-installed"
  | "bundle-mismatch"
  | "projection-invalid"
  | "front-disabled"
  | "adapter-not-declared"
  | "adapter-unknown"
  | "adapter-untrusted";

export interface BusinessAdapterBinding {
  state: BusinessBindingState;
  adapter: ServiceFrontBusinessAdapter | null;
  bundleId: string | null;
  installId: string | null;
  /** 仅写服务端诊断日志，禁止原样返回给 C 端。 */
  reason: string;
}

type ProjectionLoader = (bundleId: string) => BundleUiProjection;

/** 纯函数决策缝：单测可注入投影，不接触数据库或真实行业数据。 */
export function bindBusinessAdapter(
  binding: WorkspaceBundleFacts,
  loadProjection?: ProjectionLoader,
): BusinessAdapterBinding {
  const activeResolution = bindVerifiedActiveBundle(binding, loadProjection);
  if (activeResolution.state !== "ready" || !activeResolution.projection) {
    return {
      state: activeResolution.state,
      adapter: null,
      bundleId: activeResolution.bundleId,
      installId: activeResolution.installId,
      reason: activeResolution.reason,
    };
  }
  const projection = activeResolution.projection;
  const active = {
    bundleId: activeResolution.bundleId!,
    id: activeResolution.installId!,
  };
  const front = projection.ui.serviceFront;
  if (!front.enabled) {
    return {
      state: "front-disabled", adapter: null, bundleId: active.bundleId, installId: active.id,
      reason: "当前行业包未启用服务前台",
    };
  }
  if (!front.adapterId) {
    return {
      state: "adapter-not-declared", adapter: null, bundleId: active.bundleId, installId: active.id,
      reason: "当前服务前台没有声明行业业务适配器",
    };
  }
  const registration = ADAPTERS.get(front.adapterId) ?? null;
  if (!registration) {
    return {
      state: "adapter-unknown", adapter: null, bundleId: active.bundleId, installId: active.id,
      reason: "行业业务适配器未在受控注册表登记",
    };
  }
  if (!registration.bundleIds.includes(active.bundleId)) {
    return {
      state: "adapter-untrusted", adapter: null, bundleId: active.bundleId, installId: active.id,
      reason: "活动行业包无权选择该行业业务适配器",
    };
  }
  if (registration.trustedSignerKeyIds?.length
    && (!projection.signatureKeyId || !registration.trustedSignerKeyIds.includes(projection.signatureKeyId))) {
    return {
      state: "adapter-untrusted", adapter: null, bundleId: active.bundleId, installId: active.id,
      reason: "行业包签名方无权选择该行业业务适配器",
    };
  }
  return {
    state: "ready", adapter: registration.adapter, bundleId: active.bundleId, installId: active.id,
    reason: "活动行业包与服务前台投影已验证",
  };
}

/** 生产解析：装配事实只经带工作区 GUC 的 RLS 事务读取。 */
export async function resolveWorkspaceBusinessAdapter(workspaceId: string): Promise<BusinessAdapterBinding> {
  const active = await resolveWorkspaceActiveBundle(workspaceId);
  const result = active.state === "ready" && active.projection
    ? bindBusinessAdapter({
      workspaceBundleId: active.bundleId,
      activeInstalls: [{ id: active.installId!, bundleId: active.bundleId! }],
    }, () => active.projection!)
    : {
      state: active.state,
      adapter: null,
      bundleId: active.bundleId,
      installId: active.installId,
      reason: active.reason,
    } satisfies BusinessAdapterBinding;
  if (result.state !== "ready" && result.state !== "adapter-not-declared" && result.state !== "front-disabled") {
    console.warn(`[service-c] 行业业务适配器失败关闭：${result.reason}`);
  }
  return result;
}

export function registeredBusinessAdapterIds(): string[] {
  return [...ADAPTERS.keys()].sort();
}
