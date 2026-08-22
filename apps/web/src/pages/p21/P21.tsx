/**
 * P21 董事长视图（数字CEO · D21）
 * 治理状态 / 简报流 / 待审分层 / 成绩单 / 节拍手动触发 / 深度授权六步向导 / 一键撤回
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { Bridge } from "../../shell/Bridge";

const StatusPill = ({ tone, children }: { tone: "ok" | "warn" | "info"; children: React.ReactNode }) => (
  <span className={`inline-block rounded border px-2 py-0.5 text-[11px] ${tone === "ok" ? "border-go/50 text-go" : tone === "warn" ? "border-warn/50 text-warn" : "border-line text-ink3"}`}>{children}</span>
);
const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-4 rounded-xl border border-line bg-card p-4">
    <div className="mb-3 text-[12px] tracking-[.18em] text-ink3">{title}</div>
    {children}
  </section>
);
const PageHeader = ({ tag, title, desc }: { tag: string; title: string; desc: string }) => (
  <header className="mb-4">
    <div className="font-mono text-[11px] text-holo">{tag}</div>
    <h1 className="text-xl font-bold text-ink">{title}</h1>
    <p className="mt-1 text-xs text-ink3">{desc}</p>
  </header>
);

type CeoMode = "disabled" | "shadow" | "trial" | "suspended" | "active";

interface Charter {
  mode: CeoMode;
  identity: { name: string };
  autonomy: { price_band: [number, number]; procurement_cap: number; campaign_cap: number };
  circuit_breaker: { tightened: boolean };
  grant: { granted_by: string; granted_at: string; trial_ends_at: string | null; retain_until: string | null; disclosure_version: string } | null;
}

interface StateResp {
  charter: Charter;
  pendingByTier: Record<string, number>;
  disclosureVersion: string;
  requiredClauses: string[];
}

interface BriefRow { event_id: string; created_at: string; payload: { decision: { action: string; params?: Record<string, unknown>; after?: Record<string, unknown> } } }

interface Scorecard {
  decisions: number; briefings: number; initiatives: number;
  escalatedToChairman: number; breakerTrips: number; shadowDecisions: number;
}

const MODE_LABEL: Record<CeoMode, string> = {
  disabled: "未启用（默认关闭）", shadow: "影子模式（模拟决策不执行）", trial: "试用期（边界降一档）",
  suspended: "仅汇报（已暂停/到期）", active: "正式受托",
};
const MODE_TONE: Record<CeoMode, "ok" | "warn" | "info"> = {
  disabled: "info", shadow: "info", trial: "warn", suspended: "warn", active: "ok",
};

export default function P21() {
  const [state, setState] = useState<StateResp | null>(null);
  const [briefs, setBriefs] = useState<BriefRow[]>([]);
  const [score, setScore] = useState<Scorecard | null>(null);
  const [msg, setMsg] = useState("");
  // 授权向导
  const [clauses, setClauses] = useState<Record<string, boolean>>({});
  const [identityOk, setIdentityOk] = useState(false);
  const [priceBand, setPriceBand] = useState<[number, number]>([0.85, 1.15]);
  const [procCap, setProcCap] = useState(5000);
  const [campCap, setCampCap] = useState(2000);

  const load = async () => {
    await ensureDemoLogin();
    setState(await trpc.captain.state.query() as unknown as StateResp);
    setBriefs(await trpc.captain.briefings.query({ limit: 8 }) as unknown as BriefRow[]);
    setScore(await trpc.captain.scorecard.query() as unknown as Scorecard);
  };
  useEffect(() => { void load(); }, []);

  const beat = async (b: string) => {
    setMsg("节拍执行中…");
    const r = await trpc.captain.runBeat.mutate({ beat: b as "daily" }) as Record<string, unknown>;
    setMsg(`节拍 ${b} 完成：${JSON.stringify(r).slice(0, 120)}`);
    await load();
  };
  const transit = async (kind: string) => {
    const r = await trpc.captain.transit.mutate({ kind: kind as "advance" }) as { mode: CeoMode };
    setMsg(`状态迁移 → ${MODE_LABEL[r.mode]}`);
    await load();
  };
  const grant = async () => {
    try {
      const r = await trpc.captain.grant.mutate({
        clauses: Object.keys(clauses).filter((k) => clauses[k]),
        autonomy: { price_band: priceBand, procurement_cap: procCap, campaign_cap: campCap },
        shadowDays: 3, trialDays: 7, identityConfirmed: identityOk,
      }) as { mode: CeoMode };
      setMsg(`授权签署完成 → ${MODE_LABEL[r.mode]}（已留痕，不可篡改）`);
      await load();
    } catch (e) {
      setMsg(`授权被拒：${(e as Error).message}`);
    }
  };

  const mode = state?.charter.mode ?? "disabled";
  const allClauses = state?.requiredClauses ?? [];
  const allChecked = allClauses.length > 0 && allClauses.every((c) => clauses[c]);

  return (
    <Bridge
      left={
        <div className="space-y-2">
          <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">治理状态</div>
          <div className="rounded-lg border border-line bg-card p-3">
            <StatusPill tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</StatusPill>
            {state?.charter.grant && (
              <div className="mt-2 text-[11px] leading-relaxed text-ink3">
                授权人 {state.charter.grant.granted_by}<br />
                {new Date(state.charter.grant.granted_at).toLocaleDateString()} 签署（{state.charter.grant.disclosure_version}）<br />
                {state.charter.grant.trial_ends_at && <>试用截止 {new Date(state.charter.grant.trial_ends_at).toLocaleDateString()}<br /></>}
                {state.charter.circuit_breaker.tightened && <span className="text-warn">自治已熔断收紧一档</span>}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-line bg-card p-3 text-xs text-ink2">
            <div className="mb-1 text-[11px] tracking-[.2em] text-ink3">待审分层</div>
            L2 公司CEO 裁决 {state?.pendingByTier.l2_captain ?? 0} 件<br />
            L3 集团CEO {state?.pendingByTier.l3_fleet ?? 0} 件<br />
            <b className="text-gold">L4 请示董事长 {state?.pendingByTier.l4_chairman ?? 0} 件</b>
          </div>
          {score && (
            <div className="rounded-lg border border-line bg-card p-3 text-xs text-ink2">
              <div className="mb-1 text-[11px] tracking-[.2em] text-ink3">成绩单（30 天）</div>
              裁决 {score.decisions} · 简报 {score.briefings} · 立项 {score.initiatives}<br />
              谨慎上浮 {score.escalatedToChairman} · 熔断 {score.breakerTrips} · 影子决策 {score.shadowDecisions}
            </div>
          )}
        </div>
      }
      right={
        <div className="space-y-2">
          <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">节拍控制台</div>
          <div className="rounded-lg border border-line bg-card p-3 text-xs">
            {["daily|晨报", "queue|L2 裁决", "deviation|偏差扫描", "breaker|熔断巡检", "weekly|周经营会"].map((x) => {
              const [k, label] = x.split("|") as [string, string];
              return (
                <button key={k} onClick={() => void beat(k)}
                  className="mb-1.5 block w-full rounded border border-line bg-panel px-3 py-2 text-left text-ink2 hover:border-gline">
                  {label}
                </button>
              );
            })}
          </div>
          {mode !== "disabled" && (
            <div className="rounded-lg border border-warn/40 bg-card p-3 text-xs">
              <div className="mb-2 text-[11px] tracking-[.2em] text-warn">治理操作</div>
              {mode === "shadow" && <button onClick={() => void transit("advance")} className="mb-1.5 block w-full rounded border border-gline px-3 py-2 text-gold">影子期合格 → 进入试用</button>}
              {mode === "suspended" && (<>
                <button onClick={() => void transit("keep_long")} className="mb-1.5 block w-full rounded border border-gline px-3 py-2 text-gold">长期保留 → 正式受托</button>
                <button onClick={() => void transit("close")} className="mb-1.5 block w-full rounded border border-line px-3 py-2 text-ink3">关闭数字CEO</button>
              </>)}
              {(mode === "trial" || mode === "active") && (
                <button onClick={() => void transit("revoke")} className="mb-1.5 block w-full rounded border border-warn px-3 py-2 text-warn">一键撤回（即时仅汇报）</button>
              )}
            </div>
          )}
        </div>
      }
    >
      <PageHeader tag="P21" title="董事长视图 · 数字CEO" desc="您只做两件事：听汇报、批少数关键决策。其余一切由公司CEO带领数字团队完成。" />

      {msg && <div className="mb-3 rounded border border-holo/40 bg-panel px-3 py-2 text-xs text-holo">{msg}</div>}

      {mode === "disabled" && (
        <Panel title="深度授权（六步 · 缺一不可）" >
          <div className="space-y-3 text-xs text-ink2">
            <div className="rounded border border-warn/40 bg-warn/5 p-3 leading-relaxed">
              <b>① 风险揭示（risk-v1）</b>：数字CEO 将在您划定的边界内自主执行真实经营决策。AI 可能误判行情、误读数据、在极端场景失当。
              <b className="text-warn">数字CEO 不是法律责任主体，授权范围内的经营决策责任由您（授权人）承担。</b>
              全部决策与授权记录不可篡改地留痕。完整文本见 docs/CEO-RISK-DISCLOSURE.md。
            </div>
            <div>
              <div className="mb-1 text-[11px] text-ink3">② 逐项确认（必须全部勾选）</div>
              {allClauses.map((c) => (
                <label key={c} className="mb-1 flex items-center gap-2">
                  <input type="checkbox" checked={!!clauses[c]} onChange={(e) => setClauses({ ...clauses, [c]: e.target.checked })} />
                  <span>{c}</span>
                </label>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>③ 价格带<br />
                <input className="w-16 rounded border border-line bg-panel px-1" value={priceBand[0]} onChange={(e) => setPriceBand([Number(e.target.value), priceBand[1]])} />～
                <input className="w-16 rounded border border-line bg-panel px-1" value={priceBand[1]} onChange={(e) => setPriceBand([priceBand[0], Number(e.target.value)])} />
              </div>
              <div>采购上限<br /><input className="w-20 rounded border border-line bg-panel px-1" value={procCap} onChange={(e) => setProcCap(Number(e.target.value))} /></div>
              <div>营销上限<br /><input className="w-20 rounded border border-line bg-panel px-1" value={campCap} onChange={(e) => setCampCap(Number(e.target.value))} /></div>
            </div>
            <div className="text-ink3">④ 试用计划：影子 3 天 → 试用 7 天（边界自动降一档）→ 到期降级仅汇报（绝不自动续期）</div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={identityOk} onChange={(e) => setIdentityOk(e.target.checked)} />
              <span>⑤ 身份核验：我确认是本人在操作</span>
            </label>
            <button disabled={!allChecked || !identityOk} onClick={() => void grant()}
              className="rounded border border-gline px-4 py-2 text-gold disabled:opacity-40">
              ⑥ 签署授权（留痕不可篡改）
            </button>
          </div>
        </Panel>
      )}

      <Panel title="简报与决策流">
        {briefs.length === 0 && <div className="text-xs text-ink3">暂无简报——触发一次「晨报」节拍试试</div>}
        <div className="space-y-2">
          {briefs.map((b) => {
            const action = b.payload.decision.action;
            const after = (b.payload.decision.after ?? {}) as Record<string, unknown>;
            const params = (b.payload.decision.params ?? {}) as Record<string, unknown>;
            const text = String(after.text ?? "");
            const dry = params.dry_run === true;
            return (
              <div key={b.event_id} className="rounded-lg border border-line bg-card p-3">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-ink3">
                  <span className="font-mono">{b.event_id}</span>
                  <span>{action}</span>
                  {dry && <StatusPill tone="info">影子·未执行</StatusPill>}
                  <span className="flex-1" />
                  <span>{new Date(b.created_at).toLocaleString()}</span>
                </div>
                {text && <pre className="whitespace-pre-wrap text-xs leading-relaxed text-ink2">{text}</pre>}
                {action === "ceo.decision" && (
                  <div className="text-xs text-ink2">{JSON.stringify(after.memo ?? after, null, 1).slice(0, 300)}</div>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </Bridge>
  );
}
