/**
 * HandoffCard 昨夜日报卡（设计规范 §5.3；交接班消息卡，08:30 决策包送达 F4.4）
 * 结构：卡头（✦ 昨夜日报 · 夜班中心 + 送达时间 + 围栏快照版本）
 *      + 三栏大数字：战果绿 / 待审批琥珀 / 求援红（Orbitron 发光）
 *      + 卡尾（积分消耗 + 打开入口）
 * 铁律：三计数与 P3 逐条强一致（F4.4）；未启用夜班时整卡转空态，禁止显 0（§5.3）
 */

export interface HandoffData {
  deliveredAt: string; // HH:MM
  fenceSnapshot: string;
  done: number;
  pending: number;
  needHuman: number;
  credits: number;
}

export function HandoffCard({
  data,
  nightEnabled = true,
  onOpen,
}: {
  data?: HandoffData;
  nightEnabled?: boolean;
  onOpen?: () => void;
}) {
  // 铁律：未启用夜班 → 整卡空态，禁止显 0
  if (!nightEnabled || !data) {
    return (
      <div className="rounded-msg border border-dashed border-line p-8 text-center">
        <div
          className="pointer-events-none absolute inset-0 rounded-msg opacity-40"
          style={{ background: "radial-gradient(50% 60% at 50% 0%, rgb(36 27 77 / .5), transparent 70%)" }}
        />
        <div className="relative mb-1.5 text-2xl">🌙</div>
        <div className="relative text-body text-ink2">夜班中心尚未开工</div>
        <div className="relative mt-0.5 text-caption text-ink3">开启夜班后，明早 08:30 日报送达（F4.1）</div>
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-msg border border-line bg-card p-4">
      {/* 卡头 */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-h2 font-black tracking-wide text-goldhi">✦ 昨夜日报 · 夜班中心</span>
        <span className="text-caption text-ink3">{data.deliveredAt} 送达</span>
        <span className="flex-1" />
        <span className="font-mono text-micro text-holo">围栏快照 {data.fenceSnapshot}</span>
      </div>
      {/* 三栏大数字（Orbitron 发光；战果✓绿 / 待审批◆琥珀 / 求援▲红——固定语义 §6） */}
      <div className="grid grid-cols-3 gap-2.5">
        {[
          { n: data.done, label: "战果 ✓", cls: "text-go", glow: "0_0_18px_rgba(61,255,178,.45)" },
          { n: data.pending, label: "待审批 ◆", cls: "text-warn", glow: "0_0_18px_rgba(255,194,77,.45)" },
          { n: data.needHuman, label: "求援 ▲", cls: "text-alert", glow: "0_0_18px_rgba(255,84,112,.45)" },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-line bg-bg800/60 px-3 py-2.5 text-center">
            <div
              className={`font-orb text-kpi font-bold ${c.cls}`}
              style={{ textShadow: c.glow.replaceAll("_", " ") }}
            >
              {c.n}
            </div>
            <div className="mt-0.5 text-caption text-ink2">{c.label}</div>
          </div>
        ))}
      </div>
      {/* 卡尾 */}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-caption text-ink3">
          积分消耗 <b className="font-orb text-gold">{data.credits}</b> 积分
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="cursor-pointer rounded-md border border-gline bg-gold/8 px-3 py-1 text-caption font-bold text-gold transition-colors hover:bg-gold/15"
        >
          打开日报详情 →
        </button>
      </div>
    </div>
  );
}
