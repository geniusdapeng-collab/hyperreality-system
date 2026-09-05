/**
 * WelcomeCeremony · 首次启动欢迎仪式（方案 V4 §0）
 * 全屏覆盖层：3D 团队仪式（CeremonyStage）+ 金色横幅 + 彩带 + 剪彩 → 主弹窗。
 * 触发：is_example 工作区 + 首次启动（localStorage + 仅一次）；右上角「跳过仪式」。
 * 文案变体：行业版按 bundle 显示名与团队人数替换（八仓通用）。
 */
import { useEffect, useMemo, useState } from "react";
import { CeremonyStage, type CeremonyActor } from "./CeremonyStage";

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

export function WelcomeCeremony({ actors, bundleName, onDone }: {
  actors: CeremonyActor[];
  bundleName: string;
  onDone: () => void;
}) {
  // 阶段：entrance(0-1.6s) → dance(1.6-7s) → ribbon(7-8.2s) → modal(8.2s+)
  const [phase, setPhase] = useState<"entrance" | "dance" | "ribbon" | "modal">("entrance");

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase("dance"), 1600),
      setTimeout(() => setPhase("ribbon"), 7000),
      setTimeout(() => setPhase("modal"), 8400),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  const skip = () => { setPhase("modal"); };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100, background: "#0b0d10",
      fontFamily: "inherit",
    }}>
      {/* 3D 仪式舞台 */}
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end" }}>
        <div style={{ width: "100%", height: "100%" }}>
          <CeremonyStage actors={actors} occasion="first-install" dancing={phase === "dance"} height={1000} />
        </div>
      </div>

      {/* 金色横幅 */}
      {phase !== "entrance" && phase !== "modal" && (
        <div style={{
          position: "absolute", top: 90, left: "50%", transform: "translateX(-50%)",
          padding: "22px 64px", borderRadius: 18, zIndex: 10, textAlign: "center",
          background: "linear-gradient(135deg, rgba(28,32,37,.92), rgba(21,24,28,.88))",
          border: "1px solid rgba(255,217,138,.45)",
          boxShadow: "0 0 60px rgba(255,217,138,.18), inset 0 1px 0 rgba(240,244,249,.1)",
          animation: "wl-banner-unfurl .7s cubic-bezier(.2,1.3,.4,1) forwards",
        }}>
          <div style={{
            fontSize: 34, fontWeight: 800, letterSpacing: 3,
            background: "linear-gradient(135deg, #ffe9b8, #ffd98a 45%, #d9a045)",
            WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          }}>欢迎董事长 · 首次开启</div>
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

      {/* 跳过仪式 */}
      {phase !== "modal" && (
        <button
          onClick={skip}
          style={{
            position: "absolute", top: 34, right: 40, zIndex: 50, cursor: "pointer",
            color: "#68707a", fontSize: 12, letterSpacing: 2, background: "none",
            border: "1px solid rgba(214,220,228,.2)", borderRadius: 8, padding: "6px 14px",
          }}
        >跳过仪式 ›</button>
      )}

      {/* 主弹窗 */}
      {phase === "modal" && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 40, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 15%",
          background: "rgba(11,13,16,.55)", backdropFilter: "blur(6px)",
          animation: "wl-modal-in .9s cubic-bezier(.2,1.1,.3,1) forwards",
        }}>
          <style>{`@keyframes wl-modal-in { from { opacity: 0; transform: scale(1.06); } to { opacity: 1; transform: scale(1); } }`}</style>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 44 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center",
              background: "linear-gradient(135deg, #d6dce4, #8fa0b5)", color: "#12151a", fontSize: 22, fontWeight: 800,
              boxShadow: "0 0 32px rgba(214,220,228,.35)",
            }}>◈</div>
            <div style={{ textAlign: "left" }}>
              <div style={{ color: "#e8ebef", fontSize: 19, fontWeight: 700, letterSpacing: 4 }}>WORKLOOM 织元</div>
              <div style={{ color: "#68707a", fontSize: 11, letterSpacing: 2.5, marginTop: 3 }}>AI NATIVE 智能经营系统</div>
            </div>
          </div>
          <div style={{
            fontSize: 62, fontWeight: 800, letterSpacing: 4, lineHeight: 1.25, marginBottom: 26,
            background: "linear-gradient(135deg, #f0f4f9 20%, #d6dce4 50%, #8fa0b5 90%)",
            WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          }}>您的 AI 公司，已在运转</div>
          <div style={{ color: "#9aa2ac", fontSize: 17, lineHeight: 1.9, maxWidth: 880, marginBottom: 44 }}>
            当前为您预装了 <b style={{ color: "#d6dce4" }}>「{bundleName}」</b>——{actors.length} 位数字员工真实在岗。<br />
            这不是演示视频：<b style={{ color: "#d6dce4" }}>看到的一切都能点开、能派活、能拍板</b>，数据会随您的操作真实流转。
          </div>
          <div style={{ display: "flex", gap: 20, marginBottom: 48 }}>
            {[
              { t: "真实运行态", d: "晨报、审批、夜班、考试——全部机制真实在岗。示例数据只是起点，您的每个操作都产生真实事件与留痕。" },
              { t: "一键清空 · 可回滚", d: "随时清空示例装配。清空前自动快照备份，30 天内一键回滚；事件存证永不删除，放心动手。" },
              { t: "向导定制 · 持证上岗", d: "说出您的行业，落地向导自动生成团队编制、装配技能，考试达标才上岗——10 分钟拥有您的专属版。" },
            ].map((c) => (
              <div key={c.t} style={{
                width: 280, padding: "22px 20px", borderRadius: 18, textAlign: "left",
                background: "linear-gradient(165deg, rgba(28,32,37,.85), rgba(21,24,28,.75))",
                border: "1px solid rgba(214,220,228,.14)",
                boxShadow: "0 24px 60px rgba(0,0,0,.45), inset 0 1px 0 rgba(240,244,249,.07)",
              }}>
                <div style={{ color: "#e8ebef", fontSize: 16, fontWeight: 700, marginBottom: 8, letterSpacing: 1 }}>{c.t}</div>
                <div style={{ color: "#8a939e", fontSize: 12.6, lineHeight: 1.8 }}>{c.d}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 18, alignItems: "center", marginBottom: 30 }}>
            <button onClick={onDone} style={{
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
          <div style={{ color: "#8a939e", fontSize: 12.5, letterSpacing: .5 }}>
            清空将自动快照备份，30 天可回滚 <span style={{ color: "#a8b2be", margin: "0 10px" }}>·</span> 事件哈希链存证永不删除 <span style={{ color: "#a8b2be", margin: "0 10px" }}>·</span> 基座能力不受清空影响
          </div>
        </div>
      )}
    </div>
  );
}

/** 首次启动判定（localStorage 标记 + 仅一次） */
export function shouldShowWelcome(workspaceId: string | null): boolean {
  if (!workspaceId) return false;
  try {
    return !localStorage.getItem(`wl-welcomed-${workspaceId}`);
  } catch { return false; }
}
export function markWelcomed(workspaceId: string): void {
  try { localStorage.setItem(`wl-welcomed-${workspaceId}`, "1"); } catch { /* 隐私模式静默 */ }
}
