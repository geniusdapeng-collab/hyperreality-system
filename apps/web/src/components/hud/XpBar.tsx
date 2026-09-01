/**
 * XpBar XP 进度条（游戏规则组件，设计规范 §6）
 * 结构：金色渐变（#FF8A3D→#FFB545→#FFE0A3）+ 斜纹流光（1.2s 循环）+ 右端 Orbitron 数值（x/y · +N XP）
 * 铁律：仅用于任务进度与主理人等级；禁止用作普通百分比条（§6）
 */
export function XpBar({
  done,
  total,
  gain,
}: {
  done: number;
  total: number;
  gain?: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-[9px] flex-1 overflow-hidden rounded-full bg-[rgba(77,150,255,.14)]">
        <div
          className="relative h-full rounded-full shadow-[0_0_12px_rgba(255,36,66,.55)]"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, var(--color-gold2), var(--color-gold), var(--color-goldhi))",
          }}
        >
          {/* 斜纹流光（1.2s；reduced-motion 已由 tokens.css 全局降级） */}
          <div
            className="absolute inset-0 animate-xpflow rounded-full"
            style={{
              background:
                "repeating-linear-gradient(115deg, transparent 0 8px, rgba(255,255,255,.28) 8px 14px)",
              backgroundSize: "28px 100%",
            }}
          />
        </div>
      </div>
      <span className="font-orb text-caption font-bold tracking-wider text-goldhi">
        {done}/{total}
        {gain ? <span className="ml-1 text-gold">+{gain} XP</span> : null}
      </span>
    </div>
  );
}
