import { useRef, useState, type ReactNode } from "react";
import { Badge, TopContextBar, clientChineseText } from "@workloom/ui";

/** 「演示数据」角标：API 降级时展示（不静默） */
export function DemoBadge() {
  return <Badge tone="warning">演示数据</Badge>;
}

export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  return <TopContextBar className="service-page-header" title={title} actions={right} />;
}

/** 服务端说明只在具有中文业务语义时展示；内部错误码与英文字段统一走安全文案。 */
export function chineseMessage(value: unknown, fallback: string): string {
  return clientChineseText(value, fallback);
}

export function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
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
            className="text-body text-ink3 transition-transform"
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
