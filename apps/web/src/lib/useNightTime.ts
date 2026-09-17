/**
 * useNightTime · 夜班环境节律（随真实时间切换，评审决策④）
 *
 * 上海墙钟 22:00→08:30 = 夜班态（与 NIGHT_DEFAULTS 夜班窗口同口径）。
 * 每分钟自检一次；返回 night 布尔供 3D 场景调光（灯光变暗、工位台灯亮起）。
 */
import { useEffect, useState } from "react";

export function isNightAt(date: Date): boolean {
  const sh = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const m = sh.getHours() * 60 + sh.getMinutes();
  return m >= 22 * 60 || m < 8 * 60 + 30;
}

export function useNightTime(): boolean {
  const [night, setNight] = useState(() => isNightAt(new Date()));
  useEffect(() => {
    const timer = setInterval(() => setNight(isNightAt(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  return night;
}
