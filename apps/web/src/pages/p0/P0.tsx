/**
 * P0 经营主页（默认首页）——数字CEO 与数字团队的主界面
 *
 * 界面三要素：形象（数字CEO全息CEO+员工员工状态）/ 实况（语音气泡+请示卡+实况字幕）/ 聊天框。
 * 设计原则：剧场负责「感觉」，工作台（/p1…）负责「操作」；全部状态来自真实事件（captain.theater 5s 心跳）。
 * 形象纯 SVG+CSS+Canvas 零素材；仪式：每日首访晨间播报（光核→光环→卫星逐亮→报到词）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { RejectDialog } from "../../components/RejectDialog";
import { CommandCard } from "../../components/CommandCard";
import { actionText, actorText , payloadText } from "../../lib/display";
import { SimBanner } from "../../components/SimBanner";
import { SkillDistBanner } from "../../components/SkillDistBanner";
import { FloorView, type FloorPayload, type FloorAgent } from "./Floor";
import { Stage3D } from "../../components/Stage3D";
import { Floor3D } from "../../components/Floor3D";
import { SubtitleBar } from "../../voice/SubtitleBar";
import { WelcomeCeremony } from "../../components/WelcomeCeremony";
import type { CeremonyActor } from "../../components/CeremonyStage";
import { VoiceEngine } from "../../voice/VoiceEngine";
import { AudioEngine } from "../../audio/AudioEngine";
import { useAmbience } from "../../audio/ambience";
import { AudioSettings } from "../../components/AudioSettings";
import { ValueCounters } from "../../components/ValueCounters";
import { useTheaterDiff } from "../../lib/theaterDiff";
import { displayNameOf, hydrateAliases, reportTitleOf, selectReporters } from "../../lib/naming";
import { Link } from "react-router";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import { IndustrySlot } from "../../shell/IndustrySlots";
import { Button, Icon, Overlay, clientChineseText } from "@workloom/ui";

/* ================= 类型 ================= */
interface Satellite { id: string; presetKey: string; name: string; alias?: string | null; grade: string }
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
interface WelcomeState {
  status: "not_started" | "in_progress" | "paused" | "completed";
  currentStep: "start" | "mate" | "team" | "summary" | "done";
  journeyVersion: number;
  replayCount: number;
  shouldShow: boolean;
  persisted: boolean;
  role: string;
}

function safeInteractionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("未认证")) return "登录状态已失效，请重新登录后继续。";
  if (message.includes("权限") || message.includes("FORBIDDEN")) return "当前角色没有执行该操作的权限。";
  if (message.includes("过期")) return "当前内容已更新，请刷新后再试。";
  return fallback;
}

/** 数字CEO 模式 → 中文（剧场顶栏 chip；与 P21 MODE_LABEL 同口径） */
const MODE_TEXT: Record<string, string> = {
  disabled: "未授权", shadow: "影子模式", trial: "试用期", suspended: "仅汇报", active: "正式受托",
};

/** 未安装行业投影时只展示中性的基座动作，不猜测任何行业。 */
const BASE_TASK_CARDS = ["查看今日待办", "查看任务进度", "处理待审批事项", "查看运行报告"];
const BRIEFING_FALLBACK = "昨夜班组运行正常，今日请指示。";

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
    gold: ["#e8edf4", "#a8b2be"], holo: ["#b3c6de", "#7f97b8"],
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
      <svg data-wl-custom-graphic="hologram-figure" viewBox="0 0 120 160" aria-hidden="true" className="absolute inset-0 m-auto h-40 w-32">
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
        const agentName = clientChineseText(a.name, actorText(a.presetKey));
        const ang = (i / agents.length) * Math.PI * 2 + t * 0.07 * (i % 2 ? 1 : -0.7);
        const rx = 200 + (i % 3) * 34, ry = 74 + (i % 3) * 12;
        const x = Math.cos(ang) * rx, y = Math.sin(ang) * ry;
        return (
          <button key={a.id} onClick={() => onPick(a)}
            className="group absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `calc(50% + ${x}px)`, top: `calc(46% + ${y}px)` }}
            title={`${agentName} · ${clientChineseText(a.grade, "状态待确认")}`}>
            <span className="block h-2.5 w-2.5 rounded-full transition-all group-hover:scale-150"
              style={{ background: colorOf(a.grade), boxShadow: `0 0 10px ${colorOf(a.grade)}, 0 0 22px ${colorOf(a.grade)}66`, animation: `sat-pulse ${2.4 + (i % 4) * 0.5}s ease-in-out infinite` }} />
            <span className="pointer-events-none absolute left-1/2 top-3 w-max max-w-48 -translate-x-1/2 break-words text-center text-body text-ink3 opacity-0 transition-opacity group-hover:opacity-100">
              {agentName}
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
  const { bundle, entries, canAction } = useNavigationAccess();
  const canDispatch = canAction("task.dispatch");
  const canApprove = canAction("approval.decide");
  const canReadApprovals = entries.some((entry) => entry.route === "/approvals");
  const [wsName, setWsName] = useState("WorkLoom");
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcome, setWelcome] = useState<WelcomeState | null>(null);
  const bundleId = bundle?.bundleId ?? null;
  const setWelcomeVisible = (visible: boolean) => {
    window.dispatchEvent(new CustomEvent<boolean>("workloom:welcome", { detail: visible }));
    setShowWelcome(visible);
  };
  const taskCards = useMemo(() => {
    const widget = bundle?.ui.home.widgets.find((candidate) => (
      candidate.component === "QuickTaskList" && candidate.clients.includes("pc")
    ));
    const configured = Array.isArray(widget?.props.tasks)
      ? widget.props.tasks
        .map((task) => clientChineseText(task, ""))
        .filter((task) => task.length > 0)
        .slice(0, 8)
      : [];
    return configured.length ? configured : BASE_TASK_CARDS;
  }, [bundle]);
  useEffect(() => {
    void ensureDemoLogin().then(async () => {
      await Promise.all([
        trpc.onboarding.status.query().then((r) => {
          const rr = r as { workspace?: { name?: string }; bundle?: { id?: string | null; isExample?: boolean }; workspaceId?: string };
          const n = rr.workspace?.name;
          if (n) setWsName(n);
        }).catch(() => undefined),
        trpc.onboarding.welcomeStatus.query().then((result) => {
          const progress = result as WelcomeState;
          setWelcome(progress);
          if (progress.shouldShow) setWelcomeVisible(true);
        }).catch(() => undefined),
      ]);
    });
  }, []);
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
  // WebGL 可用性探测：不可用（远程桌面/老驱动/虚拟机）时 3D 舞台自动降级为 SVG 卫星视图
  const webglOk = useMemo(() => {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
    } catch { return false; }
  }, []);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null); // M1.2 驳回弹窗目标
  const switchView = (v: "floor" | "stage") => { setView(v); localStorage.setItem("theater-view", v); };
  // —— M1 视听觉醒：事件源 / 环境声 / 手势启动 ——
  const directorEvent = useTheaterDiff(data);
  useAmbience();
  useEffect(() => { AudioEngine.bindGesture(); }, []);
  // 调试探针（运行时自测用；生产无副作用）
  useEffect(() => { (window as unknown as { __wlVoice?: typeof VoiceEngine }).__wlVoice = VoiceEngine; }, []);
  // 熔断事件 → 语音强制打断（运镜与警报声由 CineDirector 处理）
  useEffect(() => {
    if (showWelcome) return;
    if (directorEvent?.kind === "fuse") {
      VoiceEngine.speak({ role: "company-ceo", persona: "顾云峥", text: directorEvent.text, priority: "fuse" });
    }
  }, [directorEvent, showWelcome]);
  // 晨间仪式语音播报（F-REPORT1）：CEO 先晨报 → 有事汇报/关键岗位依次报到
  // 遴选纪律：七八十名员工不全上——有事的（评级异常）+ 部门经理级必报，上限 8 名；
  // 命名纪律：设了别名报「岗位名·别名」，未设只报岗位名，绝不报系统默认人名。
  const ceremonyVoiced = useRef(false);
  useEffect(() => {
    if (showWelcome || ceremony >= 5 || ceremony < 2 || ceremonyVoiced.current || !data) return;
    ceremonyVoiced.current = true;
    AudioEngine.play("fanfare");
    // ① CEO 先汇报（晨报主体）
    window.setTimeout(() => {
      const text = clientChineseText(data.latestBriefing?.text, BRIEFING_FALLBACK);
      VoiceEngine.speak({ role: "company-ceo", persona: "数字总经理", text, priority: "ceremony" });
    }, 400);
    // ② 遴选汇报人依次报到
    const reporters = selectReporters(data.satellites);
    reporters.forEach((a, i) => {
      window.setTimeout(() => {
        const title = reportTitleOf(a.name, a.presetKey);
        const abnormal = (a.grade ?? "正常") !== "正常";
        VoiceEngine.speak({
          role: a.presetKey, persona: title,
          text: abnormal ? `${title}，有情况向您汇报` : `${title}，向您报到`,
          priority: "ceremony",
        });
      }, 2400 + i * 1600);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceremony, data, showWelcome]);

  const load = async () => {
    await ensureDemoLogin();
    const [t, q] = await Promise.all([
      trpc.captain.theater.query() as Promise<Theater>,
      canReadApprovals ? trpc.captain.chairmanQueue.query() as Promise<ChairmanItem[]> : Promise.resolve([]),
    ]);
    setData({
      ...t,
      latestBriefing: t.latestBriefing
        ? { ...t.latestBriefing, text: clientChineseText(t.latestBriefing.text, BRIEFING_FALLBACK) }
        : null,
    });
    setQueue(q.map((item) => ({
      ...item,
      snapshot: {
        ...item.snapshot,
        title: clientChineseText(
          item.snapshot.title,
          actionText(item.snapshot.action ?? item.payload.decision.action),
        ),
        ceo_rationale: item.snapshot.ceo_rationale === undefined
          ? undefined
          : clientChineseText(item.snapshot.ceo_rationale, "负责人意见待确认"),
      },
    })));
    hydrateAliases(t.satellites.map((a) => ({ presetKey: a.presetKey, alias: a.alias })));
  };
  const saveWelcome = async (
    status: "in_progress" | "paused" | "completed",
    currentStep: WelcomeState["currentStep"],
  ) => {
    try {
      const result = await trpc.onboarding.saveWelcomeProgress.mutate({ status, currentStep }) as Omit<WelcomeState, "role">;
      setWelcome((current) => current ? { ...result, role: current.role } : null);
    } catch {
      setMsg("欢迎引导进度暂时无法保存，请稍后重试。");
      setTimeout(() => setMsg(""), 3500);
    } finally {
      if (status === "paused" || status === "completed") setWelcomeVisible(false);
    }
  };
  const replayWelcome = async () => {
    try {
      const result = await trpc.onboarding.replayWelcome.mutate() as Omit<WelcomeState, "role">;
      setWelcome((current) => ({ ...result, role: current?.role ?? "staff" }));
      setWelcomeVisible(true);
    } catch {
      setMsg("欢迎引导暂时无法重播，请稍后重试。");
      setTimeout(() => setMsg(""), 3500);
    }
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
      const lines = clientChineseText(data.latestBriefing.text, BRIEFING_FALLBACK).split("\n");
      return lines.slice(0, 3).join(" ");
    }
    if (data.mode === "disabled") return "董事长，我还未获授权。到「董事长视图」完成深度授权后，我就开始为您工作。";
    return "团队待命。您可以直接对我下指令，或等我按节拍向您汇报。";
  }, [data]);

  const send = async (text: string) => {
    if (!canDispatch || !text.trim() || busy) return;
    setBusy(true);
    setChat((c) => [...c, { from: "me", text }]);
    setInput("");
    try {
      const r = await trpc.threads.dispatch.mutate({ title: text }) as Record<string, unknown>;
      let reply = "";
      if (r.kind === "clarify") reply = clientChineseText(r.question, "能再说得具体一点吗？");
      else if (r.mode === "ask") reply = clientChineseText(r.answer, "应答内容暂时无法显示，请稍后再试。");
      else if (r.mode === "agent") reply = "收到。我会逐步推进，每一步都先请您确认再动手。";
      else reply = "收到，已立项执行。进展我会主动汇报。";
      setChat((c) => [...c, { from: "ceo", text: reply }]);
    } catch (e) {
      setChat((c) => [...c, { from: "ceo", text: safeInteractionError(e, "指令暂时未送达，请稍后重试。") }]);
    } finally { setBusy(false); }
  };

  const decide = async (approvalId: string, gesture: "approve" | "reject") => {
    if (!canApprove) return;
    AudioEngine.play(gesture === "approve" ? "approve" : "reject");
    if (gesture === "reject") {
      // M1.2（D24）：驳回必须选择行业受控枚举（弹窗），原「无原因驳回」已被服务端 L5.2 拒绝
      setRejectTarget(approvalId);
      return;
    }
    await trpc.approvals.decide.mutate({ approvalId, gesture });
    setMsg(`已批准，全链留痕`);
    setAskPick(null);
    setTimeout(() => setMsg(""), 3000);
    await load();
  };
  /** 拖拽任务卡到员工身上（派活闭环·拖拽形态：落点即下达，与指挥卡同通道） */
  const dropTaskOn = async (a: FloorAgent, task: string) => {
    if (!canDispatch) return;
    AudioEngine.play("assign");
    try {
      const r = await trpc.threads.dispatch.mutate({ title: task, presetKey: a.presetKey, runImmediately: true }) as Record<string, unknown>;
      if (r.kind === "clarify") setMsg(clientChineseText(r.question, "指令需要更具体"));
      else setMsg(`已把「${task.slice(0, 18)}」派给 ${clientChineseText(a.name, actorText(a.presetKey))}`);
    } catch (err) {
      setMsg(safeInteractionError(err, "派活暂时未完成，请稍后重试。"));
    }
    setTimeout(() => setMsg(""), 3500);
    await load();
  };

  /** 驳回弹窗提交（M1.2 受控枚举 + L5.2 留痕） */
  const submitReject = async (r: { reasonEnum: string; reasonLabel?: string; reasonText?: string }) => {
    if (!rejectTarget) return;
    await trpc.approvals.decide.mutate({
      approvalId: rejectTarget,
      gesture: "reject",
      reasonEnum: r.reasonEnum,
      reasonText: r.reasonText,
    });
    setRejectTarget(null);
    setMsg(`已驳回（${clientChineseText(r.reasonLabel, "其他原因")}），全链留痕`);
    setAskPick(null);
    setTimeout(() => setMsg(""), 3000);
    await load();
  };

  const showCeremony = ceremony < 5;
  return (
    <div
      data-product-ready={data ? "true" : "false"}
      data-product-bundle={bundleId ?? ""}
      data-product-actors={data ? String(data.satellites.length) : "0"}
      className="relative flex min-h-screen flex-col overflow-x-hidden bg-bg950"
    >
      <Starfield density={typeof window !== "undefined" && window.innerWidth < 768 ? 60 : 110} />

      {/* 顶栏（极简） */}
      <header className="relative z-20 flex min-w-0 flex-wrap items-center gap-3 px-4 py-2.5">
        <span className="bg-gradient-to-r from-gold to-gold2 bg-clip-text font-bold text-transparent">{wsName}</span>
        <span className="break-words text-body text-ink3">经营主页 · {clientChineseText(data?.ceoName, "公司负责人")}</span>
        <span className="flex-1" />
        {msg && <span className="break-words text-body text-go">{msg}</span>}
        {/* D25 视图切换：职场=等距办公区 / 舞台=全息员工状态 */}
        <div className="flex overflow-hidden rounded border border-line text-body">
          <button onClick={() => switchView("floor")} className={`px-2 py-0.5 ${view === "floor" ? "bg-gold/15 text-gold" : "text-ink3 hover:text-ink2"}`}>职场</button>
          <button onClick={() => switchView("stage")} className={`px-2 py-0.5 ${view === "stage" ? "bg-gold/15 text-gold" : "text-ink3 hover:text-ink2"}`}>舞台</button>
        </div>
        <span className={`rounded border px-2 py-0.5 text-body ${tone === "amber" ? "border-amber-500/60 text-amber-600" : tone === "gold" ? "border-gline text-gold" : "border-line text-ink3"}`}>
          {MODE_TEXT[data?.mode ?? ""] ?? "…"}
        </span>
        <ValueCounters />
        <AudioSettings />
        {welcome && !showWelcome && (
          <button
            type="button"
            onClick={() => void replayWelcome()}
            className="min-h-10 max-w-full whitespace-normal break-words rounded border border-line px-2 py-1 text-body text-ink3 hover:border-gline hover:text-gold"
          >重播欢迎</button>
        )}
      </header>

      {/* 模拟数据横幅（D24：引导落地向导接入真实数据与真实大模型） */}
      <SimBanner />
      {/* 技能更新通栏（技能保鲜环：夜班自动更新提示 / L2 待审批引导） */}
      <SkillDistBanner />

      {/* 舞台 */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-4">
        {view === "floor" && data?.floor ? (
          <div className={`w-full max-w-3xl transition-all duration-1000 ${showCeremony && ceremony < 2 ? "scale-95 opacity-0" : "opacity-100"}`}>
            <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2 px-1 text-body text-ink2">
              <span className="font-semibold text-holo">{clientChineseText(data.floor.scene.name, "数字职场")}</span>
              <span>·</span><span>{data.floor.agents.filter((a) => a.state === "working").length} 工作中</span>
              <span>·</span><span className={data.floor.agents.some((a) => a.state === "asking") ? "text-amber-600" : ""}>{data.floor.agents.filter((a) => a.state === "asking").length} 请您定</span>
              <span>·</span><span>{data.floor.agents.filter((a) => a.state === "idle").length} 待命</span>
              <span className="flex-1" />
              <span className="text-ink2">悬停看岗位 · 点员工派活 · 点举手者审批 · 拖任务卡到员工身上</span>
            </div>
            {/* 可拖任务卡（拖拽派活：拖到 3D 员工身上即下达） */}
            <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5 px-1">
              <span className="text-body text-ink3">任务卡 →</span>
              {taskCards.map((task) => (
                <div
                  key={task}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/workloom-task", task);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  className="max-w-full cursor-grab break-words rounded-full border border-gline bg-card px-2.5 py-1 text-body text-gold shadow-sm transition-transform hover:scale-105 active:cursor-grabbing"
                  title="拖到职场里的员工身上"
                >
                  {task}
                </div>
              ))}
            </div>
            {!showWelcome && webglOk ? (
              <Floor3D
                directorEvent={directorEvent}
                floor={data.floor}
                ceoName={clientChineseText(data.ceoName, "公司负责人")}
                onPickAgent={(a) => { if (canDispatch) setPick({ id: a.id, presetKey: a.presetKey, name: a.name, grade: data.satellites.find((s) => s.id === a.id)?.grade ?? "正常" }); }}
                onPickApproval={(a) => { if (canApprove) setAskPick(a); }}
                onDecide={(id, g) => { if (canApprove) void decide(id, g); }}
                onDropTask={canDispatch ? (a, task) => void dropTaskOn(a, task) : undefined}
              />
            ) : (
              <FloorView
                floor={data.floor}
                ceoName={clientChineseText(data.ceoName, "公司负责人")}
                onPickAgent={(a) => { if (canDispatch) setPick({ id: a.id, presetKey: a.presetKey, name: a.name, grade: data.satellites.find((s) => s.id === a.id)?.grade ?? "正常" }); }}
                onPickApproval={(a) => { if (canApprove) setAskPick(a); }}
                onDecide={(id, g) => { if (canApprove) void decide(id, g); }}
              />
            )}
          </div>
        ) : (
          <div className={`w-full max-w-3xl transition-all duration-1000 ${showCeremony && ceremony < 2 ? "scale-90 opacity-0" : "opacity-100"}`}>
            {data && (!showWelcome && webglOk ? (
              <Stage3D
                agents={data.satellites}
                active={!showCeremony || ceremony >= 3}
                onPick={(a) => setPick(a as Satellite)}
                ceremony={showCeremony && ceremony >= 2}
              />
            ) : (
              <div data-product-scene="report-stage-2d" data-product-scene-actors={String(data.satellites.length + 1)}>
                <Hologram tone={tone} active={!showCeremony || ceremony >= 3} />
                <Satellites agents={data.satellites} onPick={setPick} />
              </div>
            ))}
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
          {canApprove && queue.length > 0 && (
            <div className="space-y-2 rounded-xl border border-amber-400/40 bg-amber-400/5 p-3 shadow-[0_0_40px_rgba(255,190,106,.12)]">
              <div className="text-body tracking-[.2em] text-amber-300">请您决策 · {queue.length} 件</div>
              {queue.slice(0, 2).map((q) => (
                <div key={q.approval_id} className="rounded-lg border border-amber-300/30 bg-card p-3">
                  <div className="break-words text-body text-ink2">
                    <b>{clientChineseText(q.snapshot.title, actionText(q.snapshot.action ?? q.payload.decision.action))}</b>
                    <span className="ml-2 text-ink3">{payloadText(q.snapshot.params ?? {}, 80)}</span>
                  </div>
                  {q.snapshot.ceo_rationale && <div className="mt-1 break-words text-body text-holo">公司负责人意见：{clientChineseText(q.snapshot.ceo_rationale, "负责人意见待确认")}</div>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => void decide(q.approval_id, "approve")} className="inline-flex items-center gap-1 rounded border border-go/50 px-3 py-1 text-body text-go"><Icon name="check" size={14} />批准</button>
                    <button onClick={() => void decide(q.approval_id, "reject")} className="inline-flex items-center gap-1 rounded border border-warn/50 px-3 py-1 text-body text-warn"><Icon name="error" size={14} />驳回</button>
                  </div>
                </div>
              ))}
              {queue.length > 2 && <Link to="/executive" className="break-words text-body text-amber-300">其余 {queue.length - 2} 件 → 经营驾驶舱</Link>}
            </div>
          )}
        </div>
      </main>

      {/* 实况字幕条 */}
      <div className="relative z-10 overflow-hidden border-t border-line/60 bg-panel/60 py-1.5 backdrop-blur">
        <div className="flex min-w-0 flex-wrap gap-x-8 gap-y-1 px-4 text-body text-ink3">
          {(data?.ticker ?? []).concat(data?.ticker ?? []).map((e, i) => (
            <span key={i}><b className="text-ink2">{actionText(e.action)}</b> · {actorText(e.who)}</span>
          ))}
          {!data?.ticker.length && <span>实况待命中……</span>}
        </div>
      </div>

      {/* 聊天框 */}
      {canDispatch && <div className="relative z-20 border-t border-line bg-panel/80 p-3 backdrop-blur">
        <div className="mx-auto flex min-w-0 max-w-2xl flex-wrap items-center gap-2">
          {["今日怎么样", "批一下请示", "昨夜夜班汇报"].map((chip) => (
            <button key={chip} onClick={() => void send(chip)} className="hidden max-w-full break-words rounded-full border border-line px-3 py-1.5 text-body text-ink3 hover:border-gline hover:text-gold sm:block">{chip}</button>
          ))}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(input); }}
            placeholder={`像跟 ${clientChineseText(data?.ceoName, "数字负责人")} 说话一样输入……（提问 / 安排任务 / 逐步商量）`}
            className="min-w-0 flex-1 basis-64 rounded-full border border-line bg-card px-4 py-2.5 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
          />
          <button disabled={busy} onClick={() => void send(input)}
            className="rounded-full border border-gline bg-gold/10 px-5 py-2.5 text-body text-gold disabled:opacity-40">
            {busy ? "…" : "发送"}
          </button>
        </div>
      </div>}

      {/* 员工指挥卡弹层（派活闭环：绩效速览 + 派活输入 + 岗位快捷任务） */}
      {canDispatch && pick && (
        <CommandCard
          target={pick}
          onClose={() => setPick(null)}
          onDispatched={(m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); void load(); }}
        />
      )}

      {/* 职场请示卡：统一 Overlay 负责焦点圈定、Esc、背景关闭与焦点恢复。 */}
      <Overlay
        open={canApprove && askPick !== null}
        title="请您决策"
        description={askPick ? `${askPick.pendingTier === "l4_chairman" ? "董事长级" : askPick.pendingTier === "l3_fleet" ? "集团负责人级" : "公司负责人级"}事项` : undefined}
        onClose={() => setAskPick(null)}
        footer={askPick && (
          <>
            <Button variant="quiet" onClick={() => setAskPick(null)}>稍后处理</Button>
            <Button variant="danger" onClick={() => void decide(askPick.approvalId!, "reject")}>驳回</Button>
            <Button variant="primary" onClick={() => void decide(askPick.approvalId!, "approve")}>批准</Button>
          </>
        )}
      >
        {askPick && (
          <div className="min-w-0 space-y-2">
            <div className="break-words text-sm font-bold text-ink">{clientChineseText(askPick.name, actorText(askPick.presetKey))}</div>
            <div className="break-words text-body leading-relaxed text-ink2">{clientChineseText(askPick.statusLine, "当前事项需要您确认")}</div>
          </div>
        )}
      </Overlay>

      {/* 开门仪式遮罩 */}
      {showCeremony && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-bg950 transition-opacity duration-700"
          role="status" aria-live="polite"
          style={{ opacity: ceremony >= 4 ? 0 : 1, pointerEvents: ceremony >= 4 ? "none" : "auto" }}>
          <div className="text-center">
            <div className={`mx-auto mb-4 h-3 w-3 rounded-full bg-gold transition-all duration-700 ${ceremony >= 2 ? "scale-[3] shadow-[0_0_60px_#e8edf4]" : "scale-100"}`} />
            <div className={`text-sm tracking-[.3em] text-gold transition-opacity duration-700 ${ceremony >= 3 ? "opacity-100" : "opacity-0"}`}>
              团队全员就位
            </div>
            <div className={`mt-2 text-body text-ink3 transition-opacity duration-700 ${ceremony >= 4 ? "opacity-100" : "opacity-0"}`}>
              向您报到，董事长
            </div>
          </div>
        </div>
      )}
      {/* 首次启动欢迎仪式（V4 §0：is_example 工作区 + 仅一次；团队编制驱动布阵） */}
      {showWelcome && data && (
        <WelcomeCeremony
          actors={[
            { presetKey: "company-ceo", name: displayNameOf({ presetKey: "company-ceo", roleName: data.ceoName }) } satisfies CeremonyActor,
            ...data.satellites.map((a): CeremonyActor => ({ presetKey: a.presetKey, name: displayNameOf({ presetKey: a.presetKey, roleName: a.name }) })),
          ]}
          bundleName={wsName}
          welcome={bundle?.ui.welcome}
          initialStep={welcome?.currentStep ?? "start"}
          role={welcome?.role ?? "staff"}
          onProgress={(currentStep) => void saveWelcome("in_progress", currentStep)}
          onPause={(currentStep) => void saveWelcome("paused", currentStep)}
          onDone={() => void saveWelcome("completed", "done")}
        />
      )}
      {/* 新闻台字幕条（语音字幕等价物 + 降级兜底） */}
      <SubtitleBar channelName={`${wsName} · 晨会`} />
      {/* 行业页内插槽（首页浮层）：行业仓只能在 extensions/** 声明，受管页面不做行业分支判断 */}
      <IndustrySlot name="home.overlay" />
      <RejectDialog
        open={canApprove && rejectTarget !== null}
        mode="reject"
        onCancel={() => setRejectTarget(null)}
        onSubmit={(r) => void submitReject(r)}
      />
    </div>
  );
}
