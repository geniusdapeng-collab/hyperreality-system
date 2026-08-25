/**
 * NightStatusPill 夜班状态胶囊（设计规范 §5.9；顶栏常驻，等价 IM 在线状态）
 * 四态：cruising 巡航中（青·1.6s 呼吸）/ ready 已就绪（青）/ paused 已制动（琥珀·2s 呼吸）
 *      / unconfigured 未配置（灰）
 * 铁律：点击必达 P9 战队频道；「紧急制动」二次确认（§5.9，交互在 F11/P9 落地）
 * ——顶栏实例由 Bridge 引用本组件（F1 原型 .night-pill 对齐：999px 圆角 + pulse 呼吸灯）
 */
export type NightPillState = "cruising" | "ready" | "paused" | "unconfigured";

const STATE_META: Record<NightPillState, { text: string; dot: string; border: string; bg: string; anim: string; glow: string }> = {
  cruising: { text: "夜班中心 · 巡航中", dot: "bg-holo", border: "border-holo/40", bg: "bg-holo/7", anim: "animate-pulse-hud", glow: "var(--color-holo)" },
  ready: { text: "夜班 · 已就绪 22:00 出征", dot: "bg-holo", border: "border-holo/40", bg: "bg-holo/7", anim: "animate-pulse-hud", glow: "var(--color-holo)" },
  paused: { text: "夜班 · 已制动", dot: "bg-warn", border: "border-warn/45", bg: "bg-warn/7", anim: "animate-pulse-warn", glow: "var(--color-warn)" },
  unconfigured: { text: "夜班 · 未配置", dot: "bg-ink3", border: "border-line", bg: "bg-bg700/50", anim: "", glow: "transparent" },
};

export function NightStatusPill({
  state = "ready",
  window: win,
  parallel,
  onClick,
}: {
  state?: NightPillState;
  /** 时段（如 22:00–08:00） */
  window?: string;
  /** 并行数 */
  parallel?: number;
  onClick?: () => void;
}) {
  const m = STATE_META[state];
  return (
    <button
      type="button"
      onClick={onClick}
      title="进入夜班中心频道（P9）"
      className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11.5px] transition-colors ${m.border} ${m.bg}`}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${m.dot} ${m.anim}`}
        style={{ boxShadow: state === "unconfigured" ? "none" : `0 0 10px ${m.glow}` }}
      />
      <b className={`font-semibold ${state === "paused" ? "text-warn" : state === "unconfigured" ? "text-ink3" : "text-holo"}`}>
        {m.text}
      </b>
      {(win || parallel !== undefined) && (
        <span className="font-mono text-micro text-ink3">
          {win}{parallel !== undefined ? ` · ×${parallel}` : ""}
        </span>
      )}
    </button>
  );
}
