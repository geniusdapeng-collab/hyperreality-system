/**
 * 技能更新通栏（技能保鲜环 · 客户侧通知）
 *
 * 数据源 = skills.skillOps.status（recentLoaded 近 24h 装载事件 / pendingCount 待审批数）：
 *  - 有待审批（L2 新工具/权限）→ 琥珀条：引导去 P4 审批中心拍板（永不静默的执行面变化）；
 *  - 近 24h 有静默装载 → 青条：「夜班已自动更新 N 个技能」，可跳 P6 技能中心查看，
 *    当日可关闭（localStorage 按日记忆，次日有新装载再出现）；
 *  - 两者皆无 → 不渲染（不打扰）。
 * 挂载点：与 SimBanner 同位（P0 经营主页 + Bridge 工作台顶栏下方）。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../lib/trpc";

interface LoadedItem { skillId: string; name: string; version: string; tier: string; at: string; auto: boolean }
interface DistStatus {
  recentLoaded: LoadedItem[];
  pendingCount: number;
}

const dismissKey = (day: string) => `skill-dist-banner-dismissed:${day}`;

export function SkillDistBanner() {
  const [st, setSt] = useState<DistStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        await ensureDemoLogin();
        const s = (await trpc.skills.skillOps.status.query()) as DistStatus;
        if (!stop) setSt(s);
      } catch {
        /* 服务未就绪或分发未启用时静默（不阻塞任何页面） */
      }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const day = new Date().toISOString().slice(0, 10);
    setDismissed(localStorage.getItem(dismissKey(day)) === "1");
  }, []);

  if (!st || dismissed) return null;
  const loaded = st.recentLoaded ?? [];
  const pending = st.pendingCount ?? 0;
  if (pending === 0 && loaded.length === 0) return null;

  const onDismiss = () => {
    const day = new Date().toISOString().slice(0, 10);
    localStorage.setItem(dismissKey(day), "1");
    setDismissed(true);
  };

  // 待审批优先（执行面变化永不静默，必须人拍板）
  if (pending > 0) {
    return (
      <div className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/50 bg-amber-100/80 px-4 py-2 text-[12px] text-amber-800 backdrop-blur">
        <span aria-hidden>🔐</span>
        <span className="min-w-0 flex-1">
          官方技能更新有 <b>{pending}</b> 项涉及<b>新工具或新权限</b>，按治理纪律需要你拍板后才生效。
        </span>
        <a
          href="/p4"
          className="shrink-0 rounded border border-amber-500/60 bg-amber-200/60 px-3 py-1 font-bold text-amber-900 no-underline transition-colors hover:bg-amber-300/60"
        >
          去审批 →
        </a>
      </div>
    );
  }

  const names = loaded.slice(0, 2).map((x) => `「${x.name} v${x.version}」`).join("、");
  const more = loaded.length > 2 ? ` 等 ${loaded.length} 个` : "";
  return (
    <div className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-teal-500/40 bg-teal-50/90 px-4 py-2 text-[12px] text-teal-800 backdrop-blur">
      <span aria-hidden>✨</span>
      <span className="min-w-0 flex-1">
        夜班已自动更新 {loaded.length} 个技能：{names}{more}——全程留痕可回溯、可一键回滚。
      </span>
      <a
        href="/p6"
        className="shrink-0 rounded border border-teal-500/50 bg-teal-100/70 px-3 py-1 font-bold text-teal-900 no-underline transition-colors hover:bg-teal-200/70"
      >
        去技能中心 →
      </a>
      <button
        onClick={onDismiss}
        className="shrink-0 cursor-pointer rounded px-2 py-1 text-teal-700 transition-colors hover:bg-teal-100"
        aria-label="今日不再提示"
        title="今日不再提示"
      >
        ✕
      </button>
    </div>
  );
}
