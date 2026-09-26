// @vitest-environment jsdom
/**
 * 组件契约：一个实例一个 SVG、emotion 切换走 setEmotion、装饰性元素 aria-hidden、
 * 静态缩略图（live=false）不启动动画循环。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomBall } from "./LoomBall";
import { WORKLOOM_EMOTION_IDS } from "./emotions-workloom";

describe("LoomBall 组件", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("挂载后渲染 SVG，并把当前表情写进 data 属性（可被真机走查断言）", async () => {
    await act(async () => root.render(<LoomBall emotion="02" size={44} live={false} />));
    const host = container.querySelector('[data-loomball="on"]');
    expect(host).toBeTruthy();
    expect(host?.getAttribute("data-loomball-emotion")).toBe("02");
    expect(host?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("emotion 变化只切换表情，不重建实例（同一次挂载保持同一 SVG 节点）", async () => {
    await act(async () => root.render(<LoomBall emotion="02" size={44} live={false} />));
    const svgBefore = container.querySelector("svg");
    await act(async () => root.render(<LoomBall emotion={WORKLOOM_EMOTION_IDS.awaitingApproval} size={44} live={false} />));
    expect(container.querySelector("svg")).toBe(svgBefore);
    expect(container.querySelector('[data-loomball="on"]')?.getAttribute("data-loomball-emotion"))
      .toBe(WORKLOOM_EMOTION_IDS.awaitingApproval);
  });

  it("live 属性变化切换 data-loomball-active（名册静态球 hover 才动）", async () => {
    await act(async () => root.render(<LoomBall emotion="32" size={44} live={false} />));
    expect(container.querySelector('[data-loomball="on"]')?.getAttribute("data-loomball-active")).toBe("0");
    await act(async () => root.render(<LoomBall emotion="32" size={44} live />));
    expect(container.querySelector('[data-loomball="on"]')?.getAttribute("data-loomball-active")).toBe("1");
  });
});
