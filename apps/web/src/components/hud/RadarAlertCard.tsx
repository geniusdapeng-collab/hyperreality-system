/**
 * RadarAlertCard 雷达推送卡（设计规范 §5.8；巡检告警 F9.2）
 * 结构：红/琥珀描边 + 雷达扫动动画（4s/圈）+ 严重度 pill（P0/P1/P2）+ #E 编号 + 「一键派单」金按钮
 * 铁律：同事件幂等去重（L9.3，服务端保证）；无异常时该区域显示「昨夜一切正常」，
 *      禁止消失导致布局跳动（§5.8）
 */
import { EventIdChip } from "./EventIdChip";

export type RadarSeverity = "p0" | "p1" | "p2";

const SEV_META: Record<RadarSeverity, { pill: string; border: string; bg: string }> = {
  p0: { pill: "bg-alert/15 text-alert border-alert/55", border: "border-alert/40", bg: "rgba(255,77,109,.06)" },
  p1: { pill: "bg-warn/15 text-warn border-warn/50", border: "border-warn/40", bg: "rgba(255,170,51,.05)" },
  p2: { pill: "bg-holo/10 text-holo border-holo/40", border: "border-holo/30", bg: "rgba(77,150,255,.04)" },
};

export function RadarAlertCard({
  severity,
  eventId,
  title,
  source,
  onDispatch,
}: {
  severity: RadarSeverity;
  eventId: string;
  title: string;
  source: string;
  onDispatch?: () => void;
}) {
  const m = SEV_META[severity];
  return (
    <div
      className={`relative overflow-hidden rounded-msg border ${m.border} px-4 py-3.5`}
      style={{ background: `linear-gradient(150deg, ${m.bg}, rgba(13,22,52,.7))` }}
    >
      {/* 雷达扫动（4s/圈；reduced-motion 降级静态——tokens.css 全局纪律） */}
      <div
        className="pointer-events-none absolute -top-8 -right-8 h-[150px] w-[150px] animate-sweep rounded-full"
        style={{ background: "conic-gradient(from 0deg, rgba(77,150,255,.16), transparent 60deg)" }}
      />
      <div className="relative flex items-center gap-2.5">
        <span className={`rounded border px-2 py-0.5 font-orb text-caption font-black ${m.pill}`}>
          {severity.toUpperCase()}
        </span>
        <EventIdChip id={eventId} />
        <span className="text-caption text-ink3">雷达源：{source}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onDispatch}
          className="cursor-pointer rounded-md gold-grad px-3 py-1 text-caption font-black text-ongold shadow-[0_0_12px_rgba(255,160,60,.35)]"
        >
          一键派单 ▶
        </button>
      </div>
      <div className="relative mt-1.5 text-body font-semibold text-ink">{title}</div>
    </div>
  );
}

/** 无异常态（§5.8 铁律：显示「昨夜一切正常」，禁止区域消失导致布局跳动） */
export function RadarAllClear() {
  return (
    <div className="rounded-msg border border-go/25 bg-go/4 px-4 py-3.5 text-center">
      <span className="text-body text-go">🛰 昨夜一切正常，雷达全域清净</span>
    </div>
  );
}
