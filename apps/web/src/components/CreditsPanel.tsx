/**
 * CreditsPanel · 积分三池余额与加油包面板（v3.0 商业化 P1 产品化）
 *
 * 展示：三池余额（赠送/加油包/本金，先扣先到期）+ 累计消耗/平台补贴 + 近 20 条流水；
 * 购买：加油包五档阶梯（450→13,800 元，单积分成本随档递减），余额低于 3 日均耗时顶部提醒。
 */
import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc";

interface LedgerView {
  pools: Array<{ name: "gift" | "pack" | "principal"; amount: number; expiresAt: string | null }>;
  balance: number;
  totals: { granted: number; purchased: number; consumed: number; platformSubsidy: number };
  recent: Array<{ action: string; amount: number; detail: string; time: string }>;
}
interface Pack { id: string; credits: number; priceYuan: number; unitPrice: number }

const POOL_LABEL: Record<string, string> = { gift: "赠送池", pack: "加油包池", principal: "本金池" };
const POOL_TONE: Record<string, string> = {
  gift: "text-emerald-300", pack: "text-holo", principal: "text-gold",
};

export function CreditsPanel() {
  const [view, setView] = useState<LedgerView | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [buying, setBuying] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const [b, p] = await Promise.all([
      trpc.credits.balance.query() as Promise<LedgerView>,
      trpc.credits.packs.query() as Promise<{ packs: Pack[] }>,
    ]);
    setView(b);
    setPacks(p.packs);
  };
  useEffect(() => { void refresh().catch(() => undefined); }, []);

  const buy = async (packId: string) => {
    setBuying(packId);
    setMsg(null);
    try {
      const r = (await trpc.credits.purchase.mutate({ packId })) as { amount: number };
      setMsg(`已入账 ${r.amount.toLocaleString()} 积分（加油包池，6 个月有效）`);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBuying(null);
    }
  };

  if (!view) return <div className="text-caption text-ink3">积分账本加载中…</div>;

  return (
    <div className="space-y-3">
      {/* 三池余额 */}
      <div className="grid grid-cols-3 gap-2">
        {(["gift", "pack", "principal"] as const).map((name) => {
          const pool = view.pools.find((p) => p.name === name);
          return (
            <div key={name} className="rounded-md border border-line/60 bg-white/[0.03] p-2 text-center">
              <div className="text-micro text-ink3">{POOL_LABEL[name]}</div>
              <div className={`text-lg font-semibold ${POOL_TONE[name]}`}>
                {(pool?.amount ?? 0).toLocaleString()}
              </div>
              <div className="text-micro text-ink3">
                {name === "gift" ? "30 天有效" : name === "pack" ? "6 个月有效" : "不过期"}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-caption text-ink3">
        <span>可用余额 <b className="text-ink">{view.balance.toLocaleString()}</b> 积分</span>
        <span>累计消耗 {Math.round(view.totals.consumed).toLocaleString()} · 平台补贴 {Math.round(view.totals.platformSubsidy).toLocaleString()}</span>
      </div>

      {/* 加油包五档 */}
      <div>
        <div className="mb-1 text-caption text-ink3">加油包（用得越爽越划算，大客户 77 折起）</div>
        <div className="grid grid-cols-1 gap-1.5">
          {packs.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={buying !== null}
              onClick={() => void buy(p.id)}
              className="flex cursor-pointer items-center justify-between rounded-md border border-holo/25 bg-holo/5 px-3 py-1.5 text-caption transition-colors hover:border-holo/60 disabled:opacity-50"
            >
              <span className="text-ink">{p.credits.toLocaleString()} 积分</span>
              <span className="text-ink3">{p.unitPrice} 元/积分</span>
              <span className="font-semibold text-gold">¥{p.priceYuan.toLocaleString()}</span>
            </button>
          ))}
        </div>
        {msg && <div className="mt-1 text-micro text-emerald-300">{msg}</div>}
      </div>

      {/* 流水 */}
      {view.recent.length > 0 && (
        <div>
          <div className="mb-1 text-caption text-ink3">近期流水</div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {view.recent.map((r, i) => (
              <div key={i} className="flex justify-between text-micro text-ink3">
                <span>{r.action === "grant" ? "🎁" : "🛒"} {r.detail}</span>
                <span className="text-emerald-300/90">+{r.amount.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
