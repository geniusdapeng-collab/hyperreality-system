import { createElement } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INDUSTRY_SLOTS, buildIndustrySlotRegistry, isIndustrySlotName } from "./IndustrySlots";

const element = createElement("div", null, "行业插槽内容");

describe("B 端 PC 行业插槽契约", () => {
  it("只有白名单插槽被接受", () => {
    expect(INDUSTRY_SLOTS).toContain("home.overlay");
    expect(isIndustrySlotName("home.overlay")).toBe(true);
    expect(isIndustrySlotName("home.secret")).toBe(false);
  });

  it("合法声明按模块路径稳定排序收集，同插槽可挂多个元素", () => {
    const registry = buildIndustrySlotRegistry({
      "../extensions/fox/slots.tsx": { industrySlots: [{ slot: "home.overlay", element }] },
      "../extensions/acme/slots.tsx": { industrySlots: [{ slot: "home.overlay", element }, { slot: "home.overlay", element }] },
    });
    expect(registry.error).toBeNull();
    expect(registry.slots.get("home.overlay")).toHaveLength(3);
  });

  it("未知插槽 / 非元素声明一律 fail-closed（不渲染半套 UI）", () => {
    const unknownSlot = buildIndustrySlotRegistry({
      "../extensions/fox/slots.tsx": { industrySlots: [{ slot: "home.other", element }] },
    });
    expect(unknownSlot.error?.message).toContain("未知插槽");
    expect(unknownSlot.slots.size).toBe(0);

    const badElement = buildIndustrySlotRegistry({
      "../extensions/fox/slots.tsx": { industrySlots: [{ slot: "home.overlay", element: "不是元素" }] },
    });
    expect(badElement.error?.message).toContain("必须是 React 元素");
    expect(badElement.slots.size).toBe(0);

    const notArray = buildIndustrySlotRegistry({ "../extensions/fox/slots.tsx": { industrySlots: { slot: "home.overlay" } } });
    expect(notArray.error?.message).toContain("必须是数组");
  });

  it("受管首页只渲染注册表插槽，不直接导入行业目录", () => {
    const home = readFileSync(new URL("../pages/p0/P0.tsx", import.meta.url), "utf8");
    expect(home).toContain('<IndustrySlot name="home.overlay" />');
    expect(home).not.toMatch(/from\s+["'][^"']*\/extensions\//);
  });
});
