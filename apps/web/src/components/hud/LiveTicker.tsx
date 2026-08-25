/**
 * LiveTicker 实时动态（顶栏 · NightStatusPill 旁）
 *  - 数据源：captain.theater.ticker（biz_events 最近 14 条投影），10s 轮询（D6「其余」口径）
 *  - 取数失败/为空 → Mock 兜底 3 条（D24 模拟态常显纪律，不伪造为真实）
 *  - 滚动字幕复用 tokens.css 全局 @keyframes ticker；reduced-motion 由全局降级纪律覆盖
 *  - 点击下钻 → /p0 经营主页（实时动态完整版）
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { actionLabel } from "./gateAgentMap";

/** Mock 兜底（模拟态口径，仅在线路断开/无事件时展示） */
const MOCK_ITEMS = [
  "评论区运营 回复 3 条夸赞",
  "渲染师 S01 提交成功",
  "看板官 日报已生成",
];

interface TickerRow {
  event_id: string;
  action: string;
  who: string;
  created_at: string;
}

export function LiveTicker() {
  const nav = useNavigate();
  const [items, setItems] = useState<string[]>(MOCK_ITEMS);
  const [mock, setMock] = useState(true);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const r = await trpc.captain.theater.query();
      const rows = (r.ticker ?? []) as TickerRow[];
      if (rows.length > 0) {
        setItems(rows.map((t) => `${t.who} · ${actionLabel(t.action)}`));
        setMock(false);
      }
    } catch {
      // 断线兜底：保留 Mock，不伪造实时（F3.4 同口径）
      setItems(MOCK_ITEMS);
      setMock(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <button
      type="button"
      onClick={() => nav("/p0")}
      title="实时动态 · 点击下钻经营主页（P0）"
      className="flex h-7 max-w-[320px] cursor-pointer items-center gap-2 overflow-hidden rounded-full border border-line bg-card px-3 text-micro text-ink2 transition-colors hover:border-gline"
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-go animate-pulse-hud" />
      <span className="shrink-0 font-bold text-holo">实时动态</span>
      <span className="relative min-w-0 flex-1 overflow-hidden">
        <span
          className="inline-flex whitespace-nowrap"
          style={{ animation: "ticker 26s linear infinite" }}
        >
          {[...items, ...items].map((it, i) => (
            <span key={i} className="mr-6 inline-flex items-center gap-1.5">
              <span className="text-ink3">◆</span>
              {it}
            </span>
          ))}
        </span>
      </span>
      {mock && <span className="shrink-0 text-ink3">mock</span>}
    </button>
  );
}
