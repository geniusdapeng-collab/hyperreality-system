/**
 * 行业「页内插槽」唯一契约（与 `IndustryRoutes` 同族，2026-09-19 随 fox 基座通道迁移引入）。
 *
 * 背景：行业仓若直接改写受管页面（例如把首日引导挂进 P0/App），基座稳定通道就再也无法升级
 * （受管文件被改 → fail-close）。插槽把「页面上的挂载点」变成受管页面的一部分：
 *   - 受管页面只渲染白名单插槽（如 `home.overlay`）；
 *   - 行业仓在 `extensions/**` 任意层级放 `slots.ts(x)` 声明 `industrySlots`；
 *   - 插槽内容不得声明路由或权限（那属于 routes 契约），只在当前页面内渲染。
 *
 * 与 routes 相同的纪律：受管 App/页面不得被复制修改；客户端声明不授予任何权限。
 */
import { isValidElement, type ReactElement } from "react";

/** 插槽白名单：新增插槽 = 修改受管页面，属于基座变更。 */
export const INDUSTRY_SLOTS = ["home.overlay"] as const;
export type IndustrySlotName = (typeof INDUSTRY_SLOTS)[number];

export interface IndustrySlotDefinition {
  slot: IndustrySlotName;
  element: ReactElement;
}

interface IndustrySlotModule {
  industrySlots?: unknown;
}

export interface IndustrySlotRegistry {
  /** 按模块路径稳定排序；同一插槽可挂多个元素（例如 HUD + 遮罩层）。 */
  slots: ReadonlyMap<IndustrySlotName, readonly ReactElement[]>;
  error: Error | null;
}

export function isIndustrySlotName(value: unknown): value is IndustrySlotName {
  return typeof value === "string" && (INDUSTRY_SLOTS as readonly string[]).includes(value);
}

/**
 * 收集并校验全部行业插槽声明。任何一条声明非法即整体 fail-closed（error 非空 → 不渲染任何插槽），
 * 避免「半套 UI」比「没有 UI」更糟。
 */
export function buildIndustrySlotRegistry(modules: Record<string, IndustrySlotModule>): IndustrySlotRegistry {
  const collected = new Map<IndustrySlotName, ReactElement[]>();
  const errors: string[] = [];
  for (const [modulePath, module] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    const declared = module?.industrySlots;
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      errors.push(`${modulePath}: industrySlots 必须是数组`);
      continue;
    }
    for (const [index, entry] of declared.entries()) {
      if (!entry || typeof entry !== "object") {
        errors.push(`${modulePath}[${index}]: 插槽声明必须是对象`);
        continue;
      }
      const { slot, element } = entry as { slot?: unknown; element?: unknown };
      if (!isIndustrySlotName(slot)) {
        errors.push(`${modulePath}[${index}]: 未知插槽 ${String(slot)}（白名单：${INDUSTRY_SLOTS.join(", ")}）`);
        continue;
      }
      if (!isValidElement(element)) {
        errors.push(`${modulePath}[${index}]: element 必须是 React 元素`);
        continue;
      }
      collected.set(slot, [...(collected.get(slot) ?? []), element]);
    }
  }
  if (errors.length > 0) return { slots: new Map(), error: new Error(errors.join("; ")) };
  return { slots: collected, error: null };
}

const discoveredModules = import.meta.glob("../extensions/**/slots.{ts,tsx}", { eager: true }) as Record<string, IndustrySlotModule>;

/** 受管页面只读这一个注册表（与 INDUSTRY_ROUTE_REGISTRY 同构造口径）。 */
export const INDUSTRY_SLOT_REGISTRY = buildIndustrySlotRegistry(discoveredModules);

/** 受管页面用它挂载插槽；未声明或声明非法时该插槽为空。 */
export function IndustrySlot({ name }: { name: IndustrySlotName }) {
  const elements = INDUSTRY_SLOT_REGISTRY.slots.get(name) ?? [];
  if (elements.length === 0) return null;
  return <>{elements}</>;
}
