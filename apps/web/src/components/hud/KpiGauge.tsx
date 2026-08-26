/**
 * KpiGauge KPI 全息仪表卡（设计规范 §5.7）
 * 结构：青描边 + 扫描线纹理 + 指标名 + Orbitron 大数 + ▲▼ 涨跌（绿/红）
 * 铁律：必须显「截至 HH:MM」；数据延迟置灰显最后同步时间，禁止伪装实时（§5.7）
 */
export function KpiGauge({
  name,
  value,
  delta,
  asOf,
  stale = false,
}: {
  name: string;
  value: string;
  /** 涨跌（%）；正绿 ▲ / 负红 ▼ */
  delta?: number;
  /** 截至 HH:MM（必显） */
  asOf: string;
  /** 延迟置灰（显最后同步时间，禁止伪装实时） */
  stale?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-[13px] border px-3.5 py-3 ${
        stale ? "border-line opacity-55 grayscale-[.6]" : "border-holo/28"
      }`}
      style={{ background: "linear-gradient(160deg, rgba(10,18,48,.85), rgba(8,14,34,.9))" }}
    >
      {/* 扫描线纹理（§5.7） */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "repeating-linear-gradient(0deg, transparent 0 3px, rgba(77,150,255,.03) 3px 4px)" }}
      />
      <div className="relative text-micro tracking-[.12em] text-ink2">{name}</div>
      <div className="relative my-1 font-orb text-[22px] font-bold text-ink">{value}</div>
      {delta !== undefined && (
        <div className={`relative text-caption font-bold ${delta >= 0 ? "text-go" : "text-alert"}`}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}%
        </div>
      )}
      <div className="relative mt-1 text-micro text-ink3">
        {stale ? `数据延迟 · 最后同步 ${asOf}` : `截至 ${asOf}`}
      </div>
    </div>
  );
}
