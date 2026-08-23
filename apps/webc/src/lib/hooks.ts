/** 通用运行态 hooks：在线状态 / 移动端键盘适配 */
import { useEffect, useState } from "react";

/** 在线状态：online/offline 事件驱动 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * 移动端键盘适配：visualViewport 变化时把可视高度写入 --app-height，
 * .phone-shell 据此收缩，避免输入栏被虚拟键盘顶出可视区。
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
      // 键盘弹出时保持滚动位置贴底（输入框可见）
      window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, []);
}
