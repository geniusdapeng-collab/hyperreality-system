import { useEffect, useState } from "react";

/**
 * AskRail 布局协作 hook：右侧通栏 Ask 对话框常驻时，主区容器预留其宽度。
 * AI 助手组件经 window 自定义事件 askrail-width 广播当前栏宽（320 展开 / 56 收起 / 0 卸载）。
 * Bridge 与 P0（不走 Bridge 的全页剧场）共用。
 */
export function useAskRailPadding(): number {
  const [railW, setRailW] = useState(320);
  useEffect(() => {
    const onRail = (e: Event) => setRailW((e as CustomEvent<{ width: number }>).detail.width);
    window.addEventListener("askrail-width", onRail);
    return () => window.removeEventListener("askrail-width", onRail);
  }, []);
  return railW;
}
