// @vitest-environment jsdom
/**
 * 回退开关：`VITE_LOOMBALL=0` 时必须渲染等尺寸空盒（布局不跳、零引擎副作用、零监听）。
 * 单测里通过 stubEnv + 重新加载模块模拟"构建期关闭"，与真机 `VITE_LOOMBALL=0 pnpm -C apps/web build` 同源。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("LoomBall 回退开关", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("VITE_LOOMBALL=0 → 等尺寸空盒，不挂引擎、不留全局", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubEnv("VITE_LOOMBALL", "0");
    vi.resetModules();
    const { LoomBall } = await import("./LoomBall");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<LoomBall emotion="32" size={44} live />));
    const off = container.querySelector('[data-loomball="off"]');
    expect(off).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect((off as HTMLElement).style.width).toBe("44px");
    expect((window as { GrokBall?: unknown }).GrokBall).toBeUndefined();
    await act(async () => root.unmount());
  });
});
