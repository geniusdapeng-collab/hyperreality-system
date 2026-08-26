/**
 * P0 经营主页（默认首页）——数字CEO 与数字团队的主界面
 *
 * 界面三要素：形象（数字CEO全息CEO+员工员工状态）/ 实况（语音气泡+请示卡+实况字幕）/ 聊天框。
 * 设计原则：剧场负责「感觉」，工作台（/p1…）负责「操作」；全部状态来自真实事件（captain.theater 5s 心跳）。
 * 形象纯 SVG+CSS+Canvas 零素材；仪式：每日首访晨间播报（光核→光环→卫星逐亮→报到词）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { actionText } from "../../lib/display";
import { SimBanner } from "../../components/SimBanner";
import { useAskRailPadding } from "../../lib/useAskRail";
import { FloorView, type FloorPayload, type FloorAgent } from "./Floor";

/* ================= 类型 ================= */
interface Satellite { id: string; presetKey: string; name: string; grade: string }
interface TickerItem { event_id: string; action: string; who: string; created_at: string }
interface Theater {
  mode: string; ceoName: string;
  pendingByTier: Record<string, number>;
  latestBriefing: { text: string; at: string } | null;
  satellites: Satellite[];
  ticker: TickerItem[];
  floor?: FloorPayload | null;
}
interface ChairmanItem {
  approval_id: string; event_id: string;
  snapshot: { action?: string; params?: Record<string, unknown>; ceo_rationale?: string; title?: string };
  payload: { decision: { action: string } };
}

/** 数字CEO 模式 → 中文（剧场顶栏 chip；与 P21 MODE_LABEL 同口径） */
const MODE_TEXT: Record<string, string> = {
  disabled: "未授权", shadow: "影子模式", trial: "试用期", suspended: "仅汇报", active: "正式受托",
};

/* ================= 星野画布 ================= */
function Starfield({ density = 110 }: { density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    let w = (cv.width = cv.offsetWidth), h = (cv.height = cv.offsetHeight);
    const stars = Array.from({ length: density }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() * 1.4 + 0.3, s: Math.random() * 0.25 + 0.05, tw: Math.random() * Math.PI * 2,
    }));
    let raf = 0;
    const tick = () => {
      if (cv.offsetWidth !== w || cv.offsetHeight !== h) { w = cv.width = cv.offsetWidth; h = cv.height = cv.offsetHeight; }
      ctx.clearRect(0, 0, w, h);
      for (const st of stars) {
        st.y -= st.s; st.tw += 0.03;
        if (st.y < -4) { st.y = h + 4; st.x = Math.random() * w; }
        const a = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(st.tw));
        ctx.fillStyle = `rgba(255,120,150,${a})`;
        ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [density]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}

/* ================= 数字CEO全息 CEO ================= */
function Hologram({ tone, active }: { tone: "gold" | "holo" | "amber" | "red" | "grey"; active: boolean }) {
  const colors = {
    gold: ["#ffd98a", "#c8a24a"], holo: ["#8ad8ff", "#3a9ec8"],
    amber: ["#ffbe6a", "#c8842a"], red: ["#ff8a8a", "#c84a4a"], grey: ["#9a9aa8", "#5a5a68"],
  }[tone];
  return (
    <div className={`relative mx-auto h-56 w-56 ${active ? "" : "opacity-70"}`}>
      {/* 三层光环 */}
      {[0, 1, 2].map((i) => (
        <div key={i} className="absolute rounded-[50%] border"
          style={{
            inset: `${i * 14}px`, borderColor: `${colors[1]}${i === 0 ? "88" : i === 1 ? "55" : "33"}`,
            transform: `rotateX(68deg)`, animation: `holo-spin ${9 - i * 2}s linear infinite ${i % 2 ? "reverse" : ""}`,
          }} />
      ))}
      {/* 人形光躯 */}
      <svg viewBox="0 0 120 160" className="absolute inset-0 m-auto h-40 w-32">
        <defs>
          <radialGradient id="core" cx="50%" cy="42%" r="55%">
            <stop offset="0%" stopColor={colors[0]} stopOpacity="0.95" />
            <stop offset="60%" stopColor={colors[1]} stopOpacity="0.35" />
            <stop offset="100%" stopColor={colors[1]} stopOpacity="0" />
          </radialGradient>
          <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors[0]} stopOpacity="0.9" />
            <stop offset="100%" stopColor={colors[1]} stopOpacity="0.15" />
          </linearGradient>
        </defs>
        <ellipse cx="60" cy="26" rx="14" ry="16" fill="none" stroke={colors[0]} strokeOpacity="0.85" strokeWidth="1.4" />
        <path d="M42 52 Q60 42 78 52 L86 108 Q60 122 34 108 Z" fill="none" stroke={colors[0]} strokeOpacity="0.7" strokeWidth="1.4" />
        <ellipse cx="60" cy="72" rx="17" ry="22" fill="url(#core)" className="holo-core" />
        <line x1="34" y1="0" x2="86" y2="0" stroke={colors[0]} strokeOpacity="0.5" strokeWidth="2" className="holo-scan" />
      </svg>
      {/* 基座投影 */}
      <div className="absolute -bottom-2 left-1/2 h-3 w-32 -translate-x-1/2 rounded-[50%]"
        style={{ background: `radial-gradient(ellipse, ${colors[1]}55, transparent 70%)` }} />
    </div>
  );
}

/* ================= 员工员工状态 ================= */
function Satellites({ agents, onPick }: { agents: Satellite[]; onPick: (a: Satellite) => void }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf = 0; const start = Date.now();
    const loop = () => { setT((Date.now() - start) / 1000); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const colorOf = (g: string) => g === "表扬" ? "#6adf8a" : g === "辅导" ? "#ff8a8a" : g === "关注" ? "#ffbe6a" : "#8ad8ff";
  return (
    <>
      {agents.map((a, i) => {
        const ang = (i / agents.length) * Math.PI * 2 + t * 0.07 * (i % 2 ? 1 : -0.7);
        const rx = 200 + (i % 3) * 34, ry = 74 + (i % 3) * 12;
        const x = Math.cos(ang) * rx, y = Math.sin(ang) * ry;
        return (
          <button key={a.id} onClick={() => onPick(a)}
            className="group absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `calc(50% + ${x}px)`, top: `calc(46% + ${y}px)` }}
            title={`${a.name} · ${a.grade}`}>
            <span className="block h-2.5 w-2.5 rounded-full transition-all group-hover:scale-150"
              style={{ background: colorOf(a.grade), boxShadow: `0 0 10px ${colorOf(a.grade)}, 0 0 22px ${colorOf(a.grade)}66`, animation: `sat-pulse ${2.4 + (i % 4) * 0.5}s ease-in-out infinite` }} />
            <span className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap text-[10px] text-ink3 opacity-0 transition-opacity group-hover:opacity-100">
              {a.name.replace("agt-", "")}
            </span>
          </button>
        );
      })}
    </>
  );
}

/* ================= 打字机气泡 ================= */
function TypeBubble({ text, tone }: { text: string; tone: string }) {
  const [n, setN] = useState(0);
  useEffect(() => { setN(0); }, [text]);
  useEffect(() => {
    if (n >= text.length) return;
    const id = setTimeout(() => setN((x) => x + 1), 18);
    return () => clearTimeout(id);
  }, [n, text]);
  return (
    <div className={`rounded-xl border bg-card/90 p-3 text-sm leading-relaxed backdrop-blur ${tone === "amber" ? "border-amber-400/50" : "border-gline"}`}>
      <span className="text-ink">{text.slice(0, n)}</span>
      {n < text.length && <span className="animate-pulse text-gold">▌</span>}
    </div>
  );
}

/* ================= 主组件 ================= */
export default function P0() {
  const railW = useAskRailPadding();
  const [data, setData] = useState<Theater | null>(null);
  const [queue, setQueue] = useState<ChairmanItem[]>([]);
  const [pick, setPick] = useState<Satellite | null>(null);
  const [input, setInput] = useState("");
  const [chat, setChat] = useState<Array<{ from: "me" | "ceo"; text: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [ceremony, setCeremony] = useState(0); // 0=未演 1-4=晨间播报阶段 5=完成
  const [msg, setMsg] = useState("");
  // D25 视图：floor=数字办公区（默认） / stage=剧场舞台（D23）
  const [view, setView] = useState<"floor" | "stage">(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem("theater-view") === "stage") ? "stage" : "floor");
  const [askPick, setAskPick] = useState<FloorAgent | null>(null); // 职场请示卡弹层
  const switchView = (v: "floor" | "stage") => { setView(v); localStorage.setItem("theater-view", v); };

  const load = async () => {
    await ensureDemoLogin();
    const [t, q] = await Promise.all([
      trpc.captain.theater.query() as Promise<Theater>,
      trpc.captain.chairmanQueue.query() as Promise<ChairmanItem[]>,
    ]);
    setData(t); setQueue(q);
  };
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000); // 5s 心跳
    return () => clearInterval(id);
  }, []);

  // 开门仪式（每日首访）
  useEffect(() => {
    const key = `theater-ceremony-${new Date().toDateString()}`;
    if (localStorage.getItem(key)) { setCeremony(5); return; }
    localStorage.setItem(key, "1");
    setCeremony(1);
    const seq = [900, 1800, 2900, 4200];
    seq.forEach((ms, i) => setTimeout(() => setCeremony(i + 2), ms));
  }, []);

  const l4 = data?.pendingByTier.l4_chairman ?? 0;
  const tone = useMemo(() => {
    if (!data) return "grey" as const;
    if (data.mode === "disabled") return "grey" as const;
    if (l4 > 0) return "amber" as const;
    if (data.mode === "trial" || data.mode === "active") return "gold" as const;
    return "holo" as const;
  }, [data, l4]);

  const speech = useMemo(() => {
    if (!data) return "系统接入中……";
    if (data.latestBriefing?.text) {
      const lines = data.latestBriefing.text.split("\n");
      return lines.slice(0, 3).join(" ");
    }
    if (data.mode === "disabled") return "董事长，我还未获授权。到「董事长视图 P21」完成深度授权后，我就开始为您工作。";
    return "团队待命。您可以直接对我下指令，或等我按节拍向您汇报。";
  }, [data]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setChat((c) => [...c, { from: "me", text }]);
    setInput("");
    try {
      const r = await trpc.threads.dispatch.mutate({ title: text }) as Record<string, unknown>;
      let reply = "";
      if (r.kind === "clarify") reply = String(r.question ?? "能再说得具体一点吗？");
      else if (r.mode === "ask") reply = String(r.answer ?? "（应答生成中）");
      else if (r.mode === "agent") reply = `收到。我会逐步推进，每一步都先请您确认再动手（线程 ${String(r.threadId ?? "")}）。`;
      else reply = `收到，已立项执行（线程 ${String(r.threadId ?? "")}）。进展我会主动汇报。`;
      setChat((c) => [...c, { from: "ceo", text: reply }]);
    } catch (e) {
      setChat((c) => [...c, { from: "ceo", text: `指令通道异常：${(e as Error).message.slice(0, 80)}` }]);
    } finally { setBusy(false); }
  };

  const decide = async (approvalId: string, gesture: "approve" | "reject") => {
    await trpc.approvals.decide.mutate({ approvalId, gesture });
    setMsg(`已${gesture === "approve" ? "批准" : "驳回"}，全链留痕`);
    setAskPick(null);
    setTimeout(() => setMsg(""), 3000);
    await load();
  };

  const showCeremony = ceremony < 5;
  return (
    <div style={{ paddingRight: railW }} className="relative flex h-screen flex-col overflow-hidden bg-bg950">
      <Starfield density={typeof window !== "undefined" && window.innerWidth < 768 ? 60 : 110} />

      {/* 顶栏（极简） */}
      <header className="relative z-20 flex items-center gap-3 px-4 py-2.5">
        <span className="bg-gradient-to-r from-gold to-gold2 bg-clip-text font-bold text-transparent">视频经理</span>
        <span className="text-xs text-ink3">经营主页 · {data?.ceoName ?? "公司CEO"}</span>
        <span className="flex-1" />
        {msg && <span className="text-xs text-go">{msg}</span>}
        {/* D25 视图切换：职场=等距办公区 / 舞台=全息员工状态 */}
        <div className="flex overflow-hidden rounded border border-line text-[11px]">
          <button onClick={() => switchView("floor")} className={`px-2 py-0.5 ${view === "floor" ? "bg-gold/15 text-gold" : "text-ink3 hover:text-ink2"}`}>职场</button>
          <button onClick={() => switchView("stage")} className={`px-2 py-0.5 ${view === "stage" ? "bg-gold/15 text-gold" : "text-ink3 hover:text-ink2"}`}>舞台</button>
        </div>
        <span className={`rounded border px-2 py-0.5 text-[11px] ${tone === "amber" ? "border-amber-500/60 text-amber-600" : tone === "gold" ? "border-gline text-gold" : "border-line text-ink3"}`}>
          {MODE_TEXT[data?.mode ?? ""] ?? "…"}
        </span>
        <a href="/p1" className="rounded border border-line px-2 py-0.5 text-[11px] text-ink2 no-underline hover:border-gline">工作台</a>
        <a href="/p21" className="rounded border border-gline px-2 py-0.5 text-[11px] text-gold no-underline">董事长视图</a>
      </header>

      {/* 模拟数据横幅（D24：引导落地向导接入真实数据与真实大模型） */}
      <SimBanner />

      {/* 舞台 */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-4">
        {view === "floor" && data?.floor ? (
          <div className={`w-full max-w-3xl transition-all duration-1000 ${showCeremony && ceremony < 2 ? "scale-95 opacity-0" : "opacity-100"}`}>
            <div className="mb-1 flex items-center gap-2 px-1 text-[11px] text-ink2">
              <span className="font-semibold text-holo">{data.floor.scene.name}</span>
              <span>·</span><span>{data.floor.agents.filter((a) => a.state === "working").length} 工作中</span>
              <span>·</span><span className={data.floor.agents.some((a) => a.state === "asking") ? "text-amber-600" : ""}>{data.floor.agents.filter((a) => a.state === "asking").length} 请您定</span>
              <span>·</span><span>{data.floor.agents.filter((a) => a.state === "idle").length} 待命</span>
              <span className="flex-1" />
              <span className="text-ink2">点员工看绩效 · 点举手者原地审批</span>
            </div>
            <FloorView
              floor={data.floor}
              ceoName={data.ceoName}
              onPickAgent={(a) => setPick({ id: a.id, presetKey: a.presetKey, name: a.name, grade: data.satellites.find((s) => s.id === a.id)?.grade ?? "正常" })}
              onPickApproval={(a) => setAskPick(a)}
              onDecide={(id, g) => void decide(id, g)}
            />
          </div>
        ) : (
          <div className={`relative transition-all duration-1000 ${showCeremony && ceremony < 2 ? "scale-90 opacity-0" : "opacity-100"}`}>
            <Hologram tone={tone} active={!showCeremony || ceremony >= 3} />
            {data && <Satellites agents={data.satellites} onPick={setPick} />}
          </div>
        )}

        {/* 语音气泡 + 聊天 */}
        <div className="mt-2 w-full max-w-2xl space-y-2">
          <TypeBubble text={speech} tone={tone} />
          {chat.slice(-3).map((m, i) => (
            <div key={i} className={`flex ${m.from === "me" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-xl border px-3 py-2 text-sm ${m.from === "me" ? "border-line bg-panel text-ink2" : "border-gline bg-card text-ink"}`}>
                {m.text}
              </div>
            </div>
          ))}

          {/* L4 请示卡（聚光灯） */}
          {queue.length > 0 && (
            <div className="space-y-2 rounded-xl border border-amber-400/40 bg-amber-400/5 p-3 shadow-[0_0_40px_rgba(255,190,106,.12)]">
              <div className="text-[11px] tracking-[.2em] text-amber-300">请您决策 · {queue.length} 件</div>
              {queue.slice(0, 2).map((q) => (
                <div key={q.approval_id} className="rounded-lg border border-amber-300/30 bg-card p-3">
                  <div className="text-xs text-ink2">
                    <b>{q.snapshot.title ?? actionText(q.snapshot.action ?? q.payload.decision.action)}</b>
                    <span className="ml-2 text-ink3">{JSON.stringify(q.snapshot.params ?? {}).slice(0, 60)}</span>
                  </div>
                  {q.snapshot.ceo_rationale && <div className="mt-1 text-[11px] text-holo">CEO 意见：{q.snapshot.ceo_rationale}</div>}
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => void decide(q.approval_id, "approve")} className="rounded border border-go/50 px-3 py-1 text-xs text-go">✓ 批准</button>
                    <button onClick={() => void decide(q.approval_id, "reject")} className="rounded border border-warn/50 px-3 py-1 text-xs text-warn">✕ 驳回</button>
                  </div>
                </div>
              ))}
              {queue.length > 2 && <a href="/p21" className="text-[11px] text-amber-300">其余 {queue.length - 2} 件 → 董事长视图</a>}
            </div>
          )}
        </div>
      </main>

      {/* 实况字幕条 */}
      <div className="relative z-10 overflow-hidden border-t border-line/60 bg-panel/60 py-1.5 backdrop-blur">
        <div className="flex animate-[ticker_36s_linear_infinite] gap-8 whitespace-nowrap text-[11px] text-ink3">
          {(data?.ticker ?? []).concat(data?.ticker ?? []).map((e, i) => (
            <span key={i}><b className="text-ink2">{actionText(e.action)}</b> · {e.who}</span>
          ))}
          {!data?.ticker.length && <span>实况待命中……</span>}
        </div>
      </div>

      {/* 聊天框 */}
      <div className="relative z-20 border-t border-line bg-panel/80 p-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          {["今日怎么样", "批一下请示", "昨夜夜班汇报"].map((chip) => (
            <button key={chip} onClick={() => void send(chip)} className="hidden rounded-full border border-line px-3 py-1.5 text-[11px] text-ink3 hover:border-gline hover:text-gold sm:block">{chip}</button>
          ))}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(input); }}
            placeholder={`像跟 ${data?.ceoName ?? "CEO"} 说话一样输入……（ask 问询 / 安排任务 / 逐步商量）`}
            className="flex-1 rounded-full border border-line bg-card px-4 py-2.5 text-sm text-ink outline-none placeholder:text-ink3 focus:border-gline"
          />
          <button disabled={busy} onClick={() => void send(input)}
            className="rounded-full border border-gline bg-gold/10 px-5 py-2.5 text-sm text-gold disabled:opacity-40">
            {busy ? "…" : "发送"}
          </button>
        </div>
      </div>

      {/* 员工绩效卡弹层 */}
      {pick && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50" onClick={() => setPick(null)}>
          <div className="w-72 rounded-xl border border-gline bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 text-sm font-bold text-ink">{pick.name}</div>
            <div className="text-xs text-ink3">岗位：{pick.presetKey}</div>
            <div className="mt-2 text-xs">绩效态：<b className={pick.grade === "表扬" ? "text-go" : pick.grade === "辅导" ? "text-warn" : "text-ink2"}>{pick.grade}</b></div>
            <a href="/p8" className="mt-3 block rounded border border-line px-3 py-1.5 text-center text-xs text-holo no-underline hover:border-gline">去团队成员看全部（工作台 P8）</a>
            <button onClick={() => setPick(null)} className="mt-2 w-full rounded border border-line py-1.5 text-xs text-ink3">关闭</button>
          </div>
        </div>
      )}

      {/* 职场请示卡弹层（举手员工 → 原地三手势） */}
      {askPick && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50" onClick={() => setAskPick(null)}>
          <div className="w-80 rounded-xl border border-amber-400/50 bg-card p-4 shadow-[0_0_50px_rgba(255,190,106,.15)]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 text-[11px] tracking-[.2em] text-amber-300">请您决策 · {askPick.pendingTier === "l4_chairman" ? "董事长级" : askPick.pendingTier === "l3_fleet" ? "集团CEO级" : "公司CEO级"}</div>
            <div className="text-sm font-bold text-ink">{askPick.name}</div>
            <div className="mt-1 text-xs text-ink2">{askPick.statusLine}</div>
            <div className="mt-1 font-mono text-[10px] text-ink3">{askPick.approvalId}</div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => void decide(askPick.approvalId!, "approve")} className="flex-1 rounded border border-go/50 px-3 py-1.5 text-xs text-go">✓ 批准</button>
              <button onClick={() => void decide(askPick.approvalId!, "reject")} className="flex-1 rounded border border-warn/50 px-3 py-1.5 text-xs text-warn">✕ 驳回</button>
            </div>
            <button onClick={() => setAskPick(null)} className="mt-2 w-full rounded border border-line py-1.5 text-xs text-ink3">稍后</button>
          </div>
        </div>
      )}

      {/* 开门仪式遮罩 */}
      {showCeremony && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-bg950 transition-opacity duration-700"
          style={{ opacity: ceremony >= 4 ? 0 : 1, pointerEvents: ceremony >= 4 ? "none" : "auto" }}>
          <div className="text-center">
            <div className={`mx-auto mb-4 h-3 w-3 rounded-full bg-gold transition-all duration-700 ${ceremony >= 2 ? "scale-[3] shadow-[0_0_60px_#ffd98a]" : "scale-100"}`} />
            <div className={`text-sm tracking-[.3em] text-gold transition-opacity duration-700 ${ceremony >= 3 ? "opacity-100" : "opacity-0"}`}>
              团队全员就位
            </div>
            <div className={`mt-2 text-xs text-ink3 transition-opacity duration-700 ${ceremony >= 4 ? "opacity-100" : "opacity-0"}`}>
              向您报到，董事长
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
