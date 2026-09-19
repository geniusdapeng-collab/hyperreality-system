/**
 * WelcomeCeremony · 首次启动欢迎仪式（方案 V4 §0 + 织伴开场 v1.2）
 * 全屏覆盖层：织伴开场序列（MateWelcome：全身像自我介绍/行业化系统介绍/官方详细介绍/过渡）
 *   → 3D 团队仪式（CeremonyStage）+ 金色横幅 + 彩带 + 剪彩 → 主弹窗。
 * 触发与续播由服务端 onboarding_progress 决定，按账号/角色/工作区/旅程版本隔离。
 * 用户可稍后继续；完成后仍可从工作台主动重播。
 * 文案变体：行业版按 bundle 显示名与团队人数替换（八仓通用）；织伴 S2 话术按 bundle id 切换（缺省回落通用版）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CeremonyStage, type CeremonyActor } from "./CeremonyStage";
import { MateWelcome } from "./MateWelcome";
import type { BundleWelcomeProjection } from "./welcomeScripts";
import { Icon, useManagedSurface } from "@workloom/ui";

const CONFETTI_COLORS = ["#d6dce4", "#f0f4f9", "#ffd98a", "#8fa9c9", "#a8b2be"];

function Confetti({ count, seed }: { count: number; seed: number }) {
  const pieces = useMemo(() => Array.from({ length: count }, (_, i) => ({
    left: (seed * 37 + i * 61) % 100,
    delay: ((seed + i * 13) % 40) / 100,
    dur: 1.6 + ((seed + i * 29) % 160) / 100,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
    round: i % 3 === 0,
  })), [count, seed]);
  return (
    <>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: "absolute", top: -20, left: `${p.left}%`, width: 10, height: 16, zIndex: 8,
          background: p.color, borderRadius: p.round ? "50%" : 0,
          animation: `wl-confetti-fall ${p.dur}s linear ${p.delay}s forwards`,
        }} />
      ))}
      <style>{`@keyframes wl-confetti-fall { to { transform: translateY(1100px) rotate(720deg); opacity: .9; } }`}</style>
    </>
  );
}

type WelcomeStep = "start" | "mate" | "team" | "summary" | "done";

export function WelcomeCeremony({
  actors,
  bundleName,
  welcome = null,
  initialStep = "start",
  role = "staff",
  onProgress,
  onPause,
  onDone,
}: {
  actors: CeremonyActor[];
  bundleName: string;
  /** 已验证的 Bundle 行业介绍投影；缺省回落基座通用版。 */
  welcome?: BundleWelcomeProjection | null;
  initialStep?: WelcomeStep;
  role?: string;
  onProgress?: (step: WelcomeStep) => void;
  onPause: (step: WelcomeStep) => void;
  onDone: () => void;
}) {
  // 阶段：mate(织伴开场 S0-S4) → entrance(0-1.6s) → dance(1.6-7s) → ribbon(7-8.2s) → modal(8.2s+)
  const [phase, setPhase] = useState<"mate" | "entrance" | "dance" | "ribbon" | "modal">(() => {
    if (initialStep === "team") return "entrance";
    if (initialStep === "summary" || initialStep === "done") return "modal";
    return "mate";
  });
  const lastReported = useRef<WelcomeStep | null>(null);
  const currentStep: WelcomeStep = phase === "mate" ? "mate" : phase === "modal" ? "summary" : "team";
  const roleLabel = role === "owner" ? "董事长" : role === "manager" ? "管理员" : role === "readonly" ? "观察成员" : "团队成员";
  const welcomeSurface = useManagedSurface<HTMLDivElement>({
    open: true,
    kind: "welcome",
    onDismiss: () => onPause(currentStep),
    modal: true,
  });

  useEffect(() => {
    if (lastReported.current === currentStep) return;
    lastReported.current = currentStep;
    onProgress?.(currentStep);
  }, [currentStep, onProgress]);

  useEffect(() => {
    queueMicrotask(() => {
      const surface = welcomeSurface.ref.current;
      const target = surface?.querySelector<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])");
      (target ?? surface)?.focus();
    });
  }, [phase, welcomeSurface.ref]);

  // 团队仪式计时：织伴开场演完（team-bridge）进入 entrance 后才启动
  useEffect(() => {
    // 每段只挂“下一跳”：总节奏与原来一致（1.6s → dance / 7.0s → ribbon / 8.4s → modal）。
    // 原实现把三个定时器一次性挂在 entrance 上，phase 一变 dance 就触发 cleanup，
    // 把还没到点的 ribbon/modal 一起清掉 → 仪式永久停在 dance（审计 B1）。
    // 用函数式 setPhase 并校验当前阶段，避免用户点“跳到介绍”后旧定时器把阶段拉回去。
    const advanceTo = (ms: number, next: "dance" | "ribbon" | "modal") =>
      window.setTimeout(() => {
        setPhase((current) => (current === phase ? next : current));
      }, ms);
    const timers =
      phase === "entrance" ? [advanceTo(1600, "dance")]
        : phase === "dance" ? [advanceTo(5400, "ribbon")]
          : phase === "ribbon" ? [advanceTo(1400, "modal")]
            : [];
    return () => timers.forEach(clearTimeout);
  }, [phase]);

  const skip = () => { setPhase("modal"); };

  return (
    <div
      {...welcomeSurface}
      data-welcome-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-label="首次运行介绍"
      style={{
        position: "fixed", inset: 0, zIndex: "var(--wl-z-fullscreen)", background: "#0b0d10",
        fontFamily: "inherit", overflow: "auto",
      }}
    >
      {/* 织伴开场序列（S0-S4：全身像独占舞台；右下角跳过直达首页） */}
      {phase === "mate" && (
        <MateWelcome
          welcome={welcome}
          onBridge={() => setPhase("entrance")}
          onSkipAll={() => onPause("mate")}
        />
      )}

      {/* 3D 仪式舞台（织伴开场谢幕后登场） */}
      {phase !== "mate" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end" }}>
          <div style={{ width: "100%", height: "100%" }}>
            <CeremonyStage actors={actors} occasion="first-install" dancing={phase === "dance"} height="100%" />
          </div>
        </div>
      )}

      {/* 金色横幅 */}
      {phase !== "entrance" && phase !== "modal" && (
        <div style={{
          position: "absolute", top: 90, left: "50%", transform: "translateX(-50%)",
          width: "min(760px, calc(100vw - 32px))", padding: "22px clamp(20px, 6vw, 64px)", borderRadius: 18, zIndex: 10, textAlign: "center",
          background: "linear-gradient(135deg, rgba(28,32,37,.92), rgba(21,24,28,.88))",
          border: "1px solid rgba(255,217,138,.45)",
          boxShadow: "0 0 60px rgba(255,217,138,.18), inset 0 1px 0 rgba(240,244,249,.1)",
          animation: "wl-banner-unfurl .7s cubic-bezier(.2,1.3,.4,1) forwards",
        }}>
          <div style={{
            fontSize: "clamp(24px, 5vw, 34px)", fontWeight: 800, letterSpacing: 3, overflowWrap: "anywhere",
            background: "linear-gradient(135deg, #ffe9b8, #ffd98a 45%, #d9a045)",
            WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          }}>欢迎{roleLabel} · 首次开启</div>
          <div style={{ marginTop: 8, color: "#9aa2ac", fontSize: 15, letterSpacing: 2 }}>
            您的专属 <b style={{ color: "#d6dce4" }}>AI 智能经营系统</b> —— 全体员工列队欢迎
          </div>
          <style>{`@keyframes wl-banner-unfurl { from { transform: translateX(-50%) scaleX(0); } to { transform: translateX(-50%) scaleX(1); } }`}</style>
        </div>
      )}

      {/* 彩带（舞蹈期两波） */}
      {phase === "dance" && <><Confetti count={50} seed={7} /><Confetti count={30} seed={23} /></>}

      {/* 剪彩礼带 */}
      {(phase === "ribbon") && (
        <div style={{
          position: "absolute", top: 460, left: 0, right: 0, height: 14, zIndex: 20,
          background: "linear-gradient(90deg, transparent, #d6dce4 8%, #f0f4f9 50%, #d6dce4 92%, transparent)",
          boxShadow: "0 0 30px rgba(214,220,228,.5)",
          animation: "wl-ribbon-cut .9s ease-in .3s forwards",
        }}>
          <style>{`@keyframes wl-ribbon-cut { 0% { clip-path: inset(0 0 0 0); opacity: 1; } 100% { clip-path: inset(0 50% 0 50%); opacity: 0; transform: translateY(40px); } }`}</style>
        </div>
      )}

      {/* 团队仪式期可稍后继续，也可跳到介绍；织伴开场期由 MateWelcome 按钮接管。 */}
      {phase !== "modal" && phase !== "mate" && (
        <div style={{ position: "absolute", top: 34, right: 40, zIndex: 50, display: "flex", gap: 8 }}>
          <button
            onClick={() => onPause("team")}
            style={{ cursor: "pointer", color: "#9aa2ac", fontSize: 14, background: "rgba(11,13,16,.75)", border: "1px solid rgba(214,220,228,.2)", borderRadius: 8, padding: "8px 14px" }}
          >稍后继续</button>
          <button
            data-welcome-action="skip-team"
            onClick={skip}
            style={{ cursor: "pointer", color: "#9aa2ac", fontSize: 14, background: "rgba(11,13,16,.75)", border: "1px solid rgba(214,220,228,.2)", borderRadius: 8, padding: "8px 14px" }}
          >跳到介绍 <Icon name="chevron" size={13} style={{ display: "inline" }} /></button>
        </div>
      )}

      {/* 主弹窗 */}
      {phase === "modal" && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 40, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "safe center", textAlign: "center", padding: "clamp(24px, 6vw, 80px) clamp(16px, 8vw, 15%)",
          background: "rgba(11,13,16,.55)", backdropFilter: "blur(6px)",
          animation: "wl-modal-in .9s cubic-bezier(.2,1.1,.3,1) forwards", overflowY: "auto",
        }}>
          <style>{`@keyframes wl-modal-in { from { opacity: 0; transform: scale(1.06); } to { opacity: 1; transform: scale(1); } }`}</style>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 44 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center",
              background: "linear-gradient(135deg, #d6dce4, #8fa0b5)", color: "#12151a", fontSize: 22, fontWeight: 800,
              boxShadow: "0 0 32px rgba(214,220,228,.35)",
            }}><Icon name="star" size={22} /></div>
            <div style={{ textAlign: "left" }}>
              <div style={{ color: "#e8ebef", fontSize: 19, fontWeight: 700, letterSpacing: 4 }}>WORKLOOM 织元</div>
              <div style={{ color: "#68707a", fontSize: 14, letterSpacing: 2.5, marginTop: 3 }}>AI 原生智能经营系统</div>
            </div>
          </div>
          <div style={{
            fontSize: "clamp(34px, 7vw, 62px)", fontWeight: 800, letterSpacing: 4, lineHeight: 1.25, marginBottom: 26,
            background: "linear-gradient(135deg, #f0f4f9 20%, #d6dce4 50%, #8fa0b5 90%)",
            WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", overflowWrap: "anywhere",
          }}>您的 AI 公司，已在运转</div>
          <div style={{ color: "#9aa2ac", fontSize: 17, lineHeight: 1.9, maxWidth: 880, marginBottom: 44 }}>
            当前为您预装了 <b style={{ color: "#d6dce4" }}>「{bundleName}」</b>——{actors.length} 位数字员工真实在岗。<br />
            这不是演示视频：<b style={{ color: "#d6dce4" }}>看到的一切都能点开、能派活、能拍板</b>，数据会随您的操作真实流转。
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", width: "min(960px, 100%)", gap: 20, marginBottom: 48 }}>
            {[
              { t: "可操作的演示运行态", d: "晨报、审批、夜班、考试均可体验。示例数据会清楚标识，您的有效操作仍产生事件与留痕。" },
              { t: "隔离定制 · 原子切换", d: "新装配先在隔离草案中预览与考试；通过后才一次性切换，原装配保留快照并可回滚。" },
              { t: "向导定制 · 持证上岗", d: "说出您的行业，落地向导自动生成团队编制、装配技能，考试达标才上岗——10 分钟拥有您的专属版。" },
            ].map((c) => (
              <div key={c.t} style={{
                minWidth: 0, padding: "22px 20px", borderRadius: 18, textAlign: "left",
                background: "linear-gradient(165deg, rgba(28,32,37,.85), rgba(21,24,28,.75))",
                border: "1px solid rgba(214,220,228,.14)",
                boxShadow: "0 24px 60px rgba(0,0,0,.45), inset 0 1px 0 rgba(240,244,249,.07)",
              }}>
                <div style={{ color: "#e8ebef", fontSize: 16, fontWeight: 700, marginBottom: 8, letterSpacing: 1 }}>{c.t}</div>
                <div style={{ color: "#8a939e", fontSize: 14, lineHeight: 1.8 }}>{c.d}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 18, alignItems: "center", marginBottom: 30 }}>
            <button data-welcome-action="enter-system" onClick={onDone} style={{
              padding: "18px 50px", borderRadius: 14, border: "none", cursor: "pointer",
              fontSize: 17, fontWeight: 700, letterSpacing: 2, color: "#12151a",
              background: "linear-gradient(135deg, #f0f4f9, #c3ccd8)",
              boxShadow: "0 12px 44px rgba(214,220,228,.3), inset 0 1px 0 #ffffff",
            }}>进入系统，先逛逛 →</button>
            <a href="/onboarding?mode=customize" style={{
              padding: "17px 38px", borderRadius: 14, textDecoration: "none",
              fontSize: 15.5, fontWeight: 600, letterSpacing: 1.5, color: "#c3ccd8",
              background: "transparent", border: "1px solid rgba(214,220,228,.35)",
            }}>定制我的行业版</a>
          </div>
          <div style={{ color: "#8a939e", fontSize: 14, letterSpacing: .5, overflowWrap: "anywhere" }}>
            切换前自动快照备份 <span style={{ color: "#a8b2be", margin: "0 10px" }}>·</span> 事件哈希链存证永不删除 <span style={{ color: "#a8b2be", margin: "0 10px" }}>·</span> 基座能力不受行业装配影响
          </div>
        </div>
      )}
    </div>
  );
}
