/**
 * ValueCounters · 累计价值计数器（方案 V4 §6.2「数得清的战果」）
 * 三枚呼吸计数器：已自主完成 N 项作业 / 待您拍板 N 项 / 团队成员 N 人。
 * 数据全部来自真实事件库（onboarding.status 工作区计数 + captain.theater 审批数），
 * 首次启动即非零——"系统在替我干活"一眼可证。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../lib/trpc";

interface Counts { events: number; agents: number; pending: number }

export function ValueCounters() {
  const [c, setC] = useState<Counts | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        await ensureDemoLogin();
        const [st, th] = await Promise.all([
          trpc.onboarding.status.query() as Promise<{ workspace?: { events?: number; agents?: number } }>,
          trpc.captain.theater.query() as Promise<{ pendingByTier?: Record<string, number> }>,
        ]);
        const pending = Object.values(th.pendingByTier ?? {}).reduce((s, n) => s + n, 0);
        if (!stop) setC({ events: st.workspace?.events ?? 0, agents: st.workspace?.agents ?? 0, pending });
      } catch { /* 静默 */ }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  if (!c) return null;

  const items = [
    { label: "已自主完成", value: c.events, unit: "项作业", tone: "text-holo" },
    { label: "待您拍板", value: c.pending, unit: "项", tone: c.pending > 0 ? "text-gold" : "text-ink3" },
    { label: "团队在岗", value: c.agents, unit: "人", tone: "text-go" },
  ];
  return (
    <div className="flex items-center gap-4 rounded-lg border border-line bg-card px-3 py-1.5">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5 text-[11px] text-ink3">
          <span>{it.label}</span>
          <span className={`font-orb text-[15px] font-bold tracking-wider ${it.tone}`}
            style={{ animation: it.value > 0 ? "wl-counter-breathe 2.4s ease-in-out infinite" : undefined }}>
            {it.value.toLocaleString()}
          </span>
          <span>{it.unit}</span>
        </div>
      ))}
      <style>{`@keyframes wl-counter-breathe { 0%,100% { opacity: 1; } 50% { opacity: .62; } }`}</style>
    </div>
  );
}
