/**
 * RadarAlertCard 雷达推送卡（设计规范 §5.8；巡检告警 F9.2）
 * 结构：红/琥珀描边 + 雷达扫动动画（4s/圈）+ 严重度 pill（P0/P1/P2）+ #E 编号 + 「一键派单」金按钮
 * 铁律：同事件幂等去重（L9.3，服务端保证）；无异常时该区域显示「昨夜一切正常」，
 *      禁止消失导致布局跳动（§5.8）
 */
import { EventIdChip } from "./EventIdChip";
import { Icon } from "@workloom/ui";

export type RadarSeverity = "p0" | "p1" | "p2" | "attention";

const SEV_META: Record<RadarSeverity, { label: string; pill: string; border: string; bg: string }> = {
  p0: { label: "最高优先级", pill: "bg-alert/15 text-alert border-alert/55", border: "border-alert/40", bg: "rgba(255,77,109,.06)" },
  p1: { label: "高优先级", pill: "bg-warn/15 text-warn border-warn/50", border: "border-warn/40", bg: "rgba(255,170,51,.05)" },
  p2: { label: "关注", pill: "bg-holo/10 text-holo border-holo/40", border: "border-holo/30", bg: "rgba(77,150,255,.04)" },
  attention: { label: "需人工介入", pill: "bg-alert/15 text-alert border-alert/55", border: "border-alert/40", bg: "rgba(255,77,109,.06)" },
};

export function RadarAlertCard({
  severity,
  eventId,
  title,
  source,
  onDispatch,
  busy = false,
}: {
  severity: RadarSeverity;
  eventId: string;
  title: string;
  source: string;
  onDispatch?: () => void;
  busy?: boolean;
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
        <span className={`rounded border px-2 py-0.5 font-orb text-body font-black ${m.pill}`}>
          {m.label}
        </span>
        <EventIdChip id={eventId} />
        <span className="text-body text-ink3">雷达源：{source}</span>
        <span className="flex-1" />
        {onDispatch && (
          <button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onDispatch}
            className="cursor-pointer rounded-md gold-grad px-3 py-1 text-body font-black text-ongold shadow-[0_0_12px_rgba(255,160,60,.35)] disabled:cursor-wait disabled:opacity-50"
          >
            {busy ? "正在派单…" : <>派发处理任务 <Icon name="send" size={13} className="inline" /></>}
          </button>
        )}
      </div>
      <div className="relative mt-1.5 text-body font-semibold text-ink">{title}</div>
    </div>
  );
}

/** 无异常态（§5.8 铁律：显示「昨夜一切正常」，禁止区域消失导致布局跳动） */
export function RadarAllClear() {
  return (
    <div className="rounded-msg border border-go/25 bg-go/4 px-4 py-3.5 text-center">
      <span className="inline-flex items-center gap-1.5 text-body text-go"><Icon name="radar" size={15} />昨夜一切正常，雷达全域清净</span>
    </div>
  );
}
