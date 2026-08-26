/**
 * 空态 / 骨架屏 / 告警条（设计规范 §5.10）
 * 空态：虚线框 + 星云晕染 + 图标 + 一句话引导 + 主行动按钮；副官语气（§9.1）
 * 骨架屏：分块骨架 + 流光扫过（1.4s），禁止白屏与整页转圈（G10 首屏口径）
 * 告警条：红（危险/熔断）/ 琥珀（提醒/降级）/ 青（信息）三级横幅，左图标右文字，可附行动按钮
 */
import type { ReactNode } from "react";

export function EmptyState({
  icon = "✨",
  title,
  hint,
  actionLabel,
  onAction,
}: {
  icon?: string;
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-msg border border-dashed border-line p-10 text-center">
      {/* 星云晕染（星云紫仅背景晕染与空态插画——§2.2） */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{ background: "radial-gradient(55% 65% at 50% 0%, rgb(36 27 77 / .55), transparent 70%)" }}
      />
      <div className="relative mb-2 text-3xl">{icon}</div>
      <div className="relative text-body text-ink2">{title}</div>
      {hint && <div className="relative mt-1 text-caption text-ink3">{hint}</div>}
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="relative mt-3 cursor-pointer rounded-md gold-grad px-3.5 py-1.5 text-caption font-black text-ongold"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** 分块骨架屏（流光 1.4s 扫过；禁止白屏与整页转圈） */
export function SkeletonBlock({ lines = 3, h = 14 }: { lines?: number; h?: number }) {
  return (
    <div className="space-y-2.5 rounded-msg border border-line bg-card p-4" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="relative overflow-hidden rounded-md bg-bg700/70"
          style={{ height: h, width: i === lines - 1 ? "62%" : "100%" }}
        >
          <div
            className="absolute inset-y-0 w-1/3 animate-skflow"
            style={{ background: "linear-gradient(100deg, transparent, rgba(255,255,255,.10), transparent)" }}
          />
        </div>
      ))}
    </div>
  );
}

export type BannerLevel = "alert" | "warn" | "info";

const BANNER_META: Record<BannerLevel, { icon: string; cls: string }> = {
  alert: { icon: "⛔", cls: "border-alert/50 bg-alert/8 text-alert" },
  warn: { icon: "⚠", cls: "border-warn/45 bg-warn/8 text-warn" },
  info: { icon: "🛰", cls: "border-holo/40 bg-holo/6 text-holo" },
};

export function BannerAlert({
  level,
  children,
  actionLabel,
  onAction,
}: {
  level: BannerLevel;
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const m = BANNER_META[level];
  return (
    <div className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-body ${m.cls}`}>
      <span>{m.icon}</span>
      <span className="flex-1">{children}</span>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="cursor-pointer rounded-md border border-current px-2.5 py-0.5 text-caption font-bold"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
