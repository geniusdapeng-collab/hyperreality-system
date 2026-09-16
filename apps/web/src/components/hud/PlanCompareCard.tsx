/**
 * PlanCompareCard 多方案对比卡（设计规范 P2-④；F3.7）
 * 结构：2–4 套候选并列（方案摘要 / 影响面 / 预估积分 / 命中围栏）
 * 铁律：采用动作写事件（F3.7）；越围栏方案强制双人确认（转 P4，不就地放行）
 */
import { Icon, clientValueText } from "@workloom/ui";

export interface PlanOption {
  id: string;
  summary: string;
  impact: string;
  estCredits: number;
  fences: string[];
  /** 越围栏方案：采用须转 P4 双人确认（F3.7） */
  overFence?: boolean;
}

export function PlanCompareCard({
  plans,
  adoptedId,
  onAdopt,
}: {
  plans: PlanOption[];
  adoptedId?: string;
  onAdopt?: (p: PlanOption) => void;
}) {
  return (
    <div className="rounded-msg border border-line bg-card p-4">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="text-h2 font-bold text-ink">方案对比</span>
        <span className="text-body text-ink3">{plans.length} 套候选</span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((p) => (
          <div
            key={p.id}
            className={`rounded-lg border p-3 ${
              adoptedId === p.id ? "border-gold/70 bg-gold/8" : p.overFence ? "border-warn/40" : "border-line bg-bg800/50"
            }`}
          >
            <div className="mb-1 break-words text-body font-bold text-ink">{clientValueText(p.summary)}</div>
            <div className="break-words text-body text-ink2">影响面：{clientValueText(p.impact)}</div>
            <div className="mt-1 text-body text-ink3">
              预估 <b className="font-orb text-gold">{p.estCredits}</b> 积分 · 命中 {p.fences.length} 条围栏
            </div>
            {p.overFence && <div className="mt-1 text-body text-warn">超出围栏 · 采用前须前往审批中心双人确认</div>}
            <div className="mt-2">
              {adoptedId === p.id ? (
                <span className="inline-flex items-center gap-1 text-body font-bold text-go"><Icon name="check" size={14} />已采用（已写事件）</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onAdopt?.(p)}
                  className="cursor-pointer rounded-md border border-gline bg-gold/8 px-2.5 py-1 text-body font-bold text-gold hover:bg-gold/15"
                >
                  采用 →
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
