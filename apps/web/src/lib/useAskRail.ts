import { useEffect, useState } from "react";

export function sharedLayoutPixels(variable: string): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(variable));
  return Number.isFinite(value) ? value : 0;
}

/**
 * AskRail 布局协作 hook：右侧通栏 Ask 对话框常驻时，主区容器预留其宽度。
 * AI 助手组件经 window 自定义事件 askrail-width 广播当前栏宽（320 展开 / 56 收起 / 0 卸载），
 * 并把当前值落在 window.__askRailW 上——后挂载的消费方以此为初始值，
 * 避免 StrictMode 双挂载 / 挂载时序导致事件错过、主区被通栏覆盖。
 * Bridge 与 P0（不走 Bridge 的全页剧场）共用。
 */
export function useAskRailPadding(): number {
  const [railW, setRailW] = useState(
    () => (window as unknown as { __askRailW?: number }).__askRailW
      ?? sharedLayoutPixels(window.matchMedia("(max-width: 820px)").matches
        ? "--wl-assistant-compact"
        : "--wl-assistant-expanded"),
  );
  useEffect(() => {
    const onRail = (e: Event) => setRailW((e as CustomEvent<{ width: number }>).detail.width);
    window.addEventListener("askrail-width", onRail);
    // 挂载即对齐一次当前栏宽——StrictMode 双挂载 / 挂载时序下事件可能错过，以此为准
    const cur = (window as unknown as { __askRailW?: number }).__askRailW;
    if (typeof cur === "number") setRailW(cur);
    return () => window.removeEventListener("askrail-width", onRail);
  }, []);
  return railW;
}

/** 左侧导航当前实际占位；供可拖拽浮层避让，不用于复制导航布局。 */
export function useSideNavWidth(): number {
  const [width, setWidth] = useState(
    () => (window as unknown as { __sideNavW?: number }).__sideNavW
      ?? (window.matchMedia("(max-width: 820px)").matches
        ? 0
        : sharedLayoutPixels("--wl-sidebar-expanded")),
  );
  useEffect(() => {
    const onWidth = (event: Event) => setWidth((event as CustomEvent<{ width: number }>).detail.width);
    window.addEventListener("sidenav-width", onWidth);
    const current = (window as unknown as { __sideNavW?: number }).__sideNavW;
    if (typeof current === "number") setWidth(current);
    return () => window.removeEventListener("sidenav-width", onWidth);
  }, []);
  return width;
}
