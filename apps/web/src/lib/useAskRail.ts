import { useEffect, useState } from "react";

/**
 * AskRail 布局协作 hook：右侧通栏 Ask 对话框常驻时，主区容器预留其宽度。
 * AI 助手组件经 window 自定义事件 askrail-width 广播当前栏宽（320 展开 / 56 收起 / 0 卸载），
 * 并把当前值落在 window.__askRailW 上——后挂载的消费方以此为初始值，
 * 避免 StrictMode 双挂载 / 挂载时序导致事件错过、主区被通栏覆盖。
 * Bridge 与 P0（不走 Bridge 的全页剧场）共用。
 */
export function useAskRailPadding(): number {
  const [railW, setRailW] = useState(
    () => (window as unknown as { __askRailW?: number }).__askRailW ?? 320,
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
