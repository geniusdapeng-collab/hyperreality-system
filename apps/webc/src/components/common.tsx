import type { ReactNode } from "react";

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
