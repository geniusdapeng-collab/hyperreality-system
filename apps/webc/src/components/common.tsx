import { useRef, useState, type ReactNode } from "react";

/** 「演示数据」角标：API 降级时展示（不静默） */
export function DemoBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-[10px] text-warn">
      <span className="h-1.5 w-1.5 rounded-full bg-warn" />
      演示数据
    </span>
  );
}

export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-bg800/90 px-4 backdrop-blur">
      <h1 className="text-[17px] font-semibold text-ink">{title}</h1>
      <div className="flex items-center gap-2">{right}</div>
    </header>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone =
    status === "已完成"
      ? "border-go/50 bg-go/10 text-go"
      : status === "处理中"
        ? "border-gold/50 bg-gold/10 text-gold"
        : "border-holo/50 bg-holo/10 text-holo";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone}`}>{status}</span>
  );
}

export function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** 骨架屏：列表加载占位 */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-2xl border border-line bg-card p-3.5">
          <div className="flex items-center justify-between">
            <div className="skeleton h-3 w-16" />
            <div className="skeleton h-4 w-12 rounded-full" />
          </div>
          <div className="skeleton mt-2.5 h-4 w-4/5" />
          <div className="mt-2.5 flex items-center justify-between">
            <div className="skeleton h-2.5 w-24" />
            <div className="skeleton h-2.5 w-12" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 空状态：纯 SVG 插画 + 文案 */
export function EmptyState({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-8 pt-20 text-center">
      <svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden>
        <circle cx="48" cy="48" r="40" stroke="var(--color-line)" strokeWidth="1.5" strokeDasharray="4 5" />
        <path
          d="M30 40h36v22a4 4 0 0 1-4 4H34a4 4 0 0 1-4-4V40z"
          stroke="var(--color-gold)"
          strokeWidth="1.8"
          fill="rgb(233 181 88 / 0.08)"
        />
        <path d="M30 40l18 12 18-12" stroke="var(--color-gold)" strokeWidth="1.8" strokeLinejoin="round" />
        <circle cx="48" cy="30" r="2.5" fill="var(--color-holo)" opacity="0.8" />
        <circle cx="66" cy="26" r="1.5" fill="var(--color-ink3)" />
        <circle cx="28" cy="28" r="1.5" fill="var(--color-ink3)" />
      </svg>
      <p className="mt-4 text-[13.5px] font-medium text-ink2">{title}</p>
      {desc && <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink3">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * 下拉刷新容器：顶部下拉超过阈值触发 onRefresh。
 * 仅在滚动到顶时响应下拉，带金点指示与释放动画。
 */
export function PullToRefresh({
  onRefresh,
  children,
  className = "",
}: {
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  className?: string;
}) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const THRESHOLD = 56;

  return (
    <div
      ref={boxRef}
      className={`overflow-y-auto ${className}`}
      onTouchStart={(e) => {
        if (boxRef.current && boxRef.current.scrollTop <= 0 && !refreshing) {
          startY.current = e.touches[0]?.clientY ?? null;
        }
      }}
      onTouchMove={(e) => {
        if (startY.current == null) return;
        const y = e.touches[0]?.clientY ?? 0;
        const delta = y - startY.current;
        if (delta > 0 && boxRef.current && boxRef.current.scrollTop <= 0) {
          setPull(Math.min(delta * 0.45, 80));
        }
      }}
      onTouchEnd={() => {
        if (startY.current == null) return;
        startY.current = null;
        if (pull >= THRESHOLD && !refreshing) {
          setRefreshing(true);
          setPull(THRESHOLD * 0.7);
          void Promise.resolve(onRefresh()).finally(() => {
            setRefreshing(false);
            setPull(0);
          });
        } else {
          setPull(0);
        }
      }}
    >
      <div className="pull-indicator" style={{ height: pull }}>
        {refreshing ? (
          <span className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 animate-typing rounded-full bg-gold"
                style={{ animationDelay: `${i * 0.18}s` }}
              />
            ))}
          </span>
        ) : (
          <span
            className="text-[10px] text-ink3 transition-transform"
            style={{ transform: `rotate(${Math.min(pull / THRESHOLD, 1) * 180}deg)` }}
          >
            {pull >= THRESHOLD ? "释放刷新" : "↓ 下拉刷新"}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
