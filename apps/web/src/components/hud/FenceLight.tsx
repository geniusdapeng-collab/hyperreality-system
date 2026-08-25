/**
 * FenceLight 围栏状态灯（设计规范 §5.5；围栏三级 + 需介入）
 * 结构：圆灯 + 名称 + 说明
 * 状态：auto 绿（常亮）/ review 琥珀（2s 呼吸）/ block 红（0.8s 急促）/ need 紫（需介入）
 * 铁律：基线规则带 🔒 金锁标（集团强制，只可加严——单调守卫 F2.3）
 * 双通道：灯 + 文字，不只依赖颜色（§10 可访问性）
 */
import { FENCE_LEVEL_TEXT } from "../../lib/display";

export type FenceLevel4 = "auto" | "review" | "block" | "need";

const META: Record<FenceLevel4, { label: string; color: string; anim?: string; glow: string }> = {
  auto: { label: FENCE_LEVEL_TEXT.auto!, color: "bg-go", glow: "rgba(61,255,178,.6)" },
  review: { label: FENCE_LEVEL_TEXT.review!, color: "bg-warn", anim: "animate-pulse-warn", glow: "rgba(255,194,77,.6)" },
  block: { label: FENCE_LEVEL_TEXT.block!, color: "bg-alert", anim: "animate-pulse-alert", glow: "rgba(255,84,112,.6)" },
  need: { label: "需介入", color: "bg-need", anim: "animate-pulse-warn", glow: "rgba(180,92,255,.6)" },
};

export function FenceLight({
  level,
  name,
  desc,
  baseline = false,
}: {
  level: FenceLevel4;
  name: string;
  desc?: string;
  /** 基线规则（🔒 金锁：集团强制只可加严） */
  baseline?: boolean;
}) {
  const m = META[level];
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
      <span
        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${m.color} ${m.anim ?? ""}`}
        style={{ boxShadow: `0 0 10px ${m.glow}` }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-body font-bold text-ink">
          {name}
          {baseline && <span title="基线围栏：集团强制，只可加严（F2.3 单调守卫）">🔒</span>}
        </div>
        {desc && <div className="truncate text-caption text-ink3">{desc}</div>}
      </div>
      <span className={`shrink-0 font-mono text-micro ${m.color.replace("bg-", "text-")}`}>{m.label}</span>
    </div>
  );
}
