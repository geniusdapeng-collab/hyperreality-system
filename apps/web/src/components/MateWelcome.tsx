/**
 * MateWelcome · 首装欢迎仪式 · 织伴开场序列（S0–S4，方案 v1.2）
 *
 * 流程：S0 全身像登场 → S1 简短自我介绍 → S2 行业化系统介绍（按 bundle 切换话术）
 *      → S3 官方详细自我介绍（通用） → S4 过渡引出团队（鞠躬缩小飞入右下角常驻位）。
 *
 * 硬性要求：织伴全程「全身像」完整入镜（MateLive2D frame="full"），舞台独占全屏。
 * 语音：VoiceEngine（ceremony 优先级，甜妹音色）+ 逐行字幕；口型由 MateLive2D 全局订阅自动驱动。
 * 交互：单击舞台快进下一段；右下角「跳过开场，直接进入 ›」直达系统首页（onSkipAll）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MateLive2D, type MateMood, type MateGesture } from "./loommate/MateLive2D";
import { VoiceEngine } from "../voice/VoiceEngine";
import { mateScriptOf, type MateScript } from "./welcomeScripts";

/** 织伴仪式音色（甜妹，略快于日常挂件以契合仪式节奏） */
const CEREMONY_VOICE = { pitch: 1.25, rate: 1.15, female: true };
/** 字幕/语音节奏：约 5.8 字/秒 + 段尾缓冲 */
const segDuration = (text: string) =>
  Math.max(3600, Math.min(40000, Math.round((text.length / 5.8) * 1000) + 900));

type SegKey = "enter" | "intro" | "system" | "detail" | "bridge" | "exiting";
interface Seg {
  key: SegKey;
  lines: string[];
  mood: MateMood;
  gesture?: Exclude<MateGesture, null>;
  dur: number;
}

function buildSegs(script: MateScript): Seg[] {
  const talk = (key: SegKey, lines: string[], mood: MateMood, gesture?: Seg["gesture"]): Seg => ({
    key, lines, mood, gesture, dur: segDuration(lines.join("")),
  });
  return [
    { key: "enter", lines: [], mood: "happy", gesture: "handup", dur: 2400 },
    talk("intro", [script.intro], "happy"),
    talk("system", script.system, "happy"),
    talk("detail", script.detail, "love"),
    talk("bridge", script.bridge, "happy", "thumbup"),
  ];
}

/** S2 背景行业关键词的散布位（避开中央舞台人物） */
const KW_POS = [
  { left: "9%", top: "18%" }, { left: "80%", top: "16%" }, { left: "6%", top: "44%" },
  { left: "84%", top: "42%" }, { left: "11%", top: "66%" }, { left: "79%", top: "64%" },
];

export function MateWelcome({ industry, onBridge, onSkipAll }: {
  /** bundle id（如 hotel / ai-pm），用于切换 S2 行业话术；未知行业自动回落通用版 */
  industry: string | null;
  /** S4 演完（织伴飞入右下角）→ 接入现有团队仪式 */
  onBridge: () => void;
  /** 右下角「跳过开场，直接进入」→ 直达系统首页 */
  onSkipAll: () => void;
}) {
  const script = useMemo(() => mateScriptOf(industry), [industry]);
  const segs = useMemo(() => buildSegs(script), [script]);
  const [idx, setIdx] = useState(0);
  const [shown, setShown] = useState(0);          // 当前段已揭示字幕行数
  const [exiting, setExiting] = useState(false);  // S4 结束：缩小飞入右下角
  const timers = useRef<number[]>([]);
  const seg = segs[Math.min(idx, segs.length - 1)]!;

  /* 舞台尺寸：全身像占视口高 ~76%，宽度不超车（正方形画布，模型 92% 适配） */
  const computeSize = () =>
    Math.round(Math.min(window.innerHeight * 0.76, window.innerWidth * 0.52));
  const [mateSize, setMateSize] = useState(computeSize);
  useEffect(() => {
    const onResize = () => setMateSize(computeSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  /** 段推进：截断当前语音 → 下一段；末段进入退场动画 → onBridge */
  const advance = useCallback(() => {
    VoiceEngine.stopAll();
    clearTimers();
    setIdx((i) => {
      if (i >= segs.length - 1) {
        setExiting(true);
        timers.current.push(window.setTimeout(onBridge, 1150));
        return i;
      }
      return i + 1;
    });
  }, [segs.length, onBridge]);

  /* 分段驱动：语音播报（整段一次，口型全局同步）+ 字幕按行比例逐行揭示 + 定时推进 */
  useEffect(() => {
    if (exiting) return;
    setShown(seg.lines.length === 0 ? 0 : 1);
    if (seg.lines.length > 0) {
      VoiceEngine.speak({
        role: "loommate", persona: "织伴", text: seg.lines.join(""),
        priority: "ceremony", voiceOverride: CEREMONY_VOICE,
      });
    }
    // 逐行揭示：按行字数占比分布在本段时长内（首行立即）
    const total = seg.lines.join("").length || 1;
    let cum = 0;
    seg.lines.forEach((line, i) => {
      if (i === 0) { cum += line.length; return; }
      const at = Math.round((cum / total) * seg.dur * 0.92);
      cum += line.length;
      timers.current.push(window.setTimeout(() => setShown(i + 1), at));
    });
    timers.current.push(window.setTimeout(advance, seg.dur));
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, exiting]);

  /* 卸载兜底：停语音清计时 */
  useEffect(() => () => { VoiceEngine.stopAll(); clearTimers(); }, []);

  const talkSegIdx = segs.findIndex((s) => s.key === "intro"); // 进度点从 S1 起计
  const progressIdx = Math.max(0, idx - talkSegIdx);

  return (
    <div
      onClick={exiting ? undefined : advance}
      style={{
        position: "absolute", inset: 0, zIndex: 30, overflow: "hidden",
        background: "radial-gradient(ellipse 75% 60% at 50% 32%, rgba(60,68,80,.55), rgba(11,13,16,0) 70%), #0b0d10",
        cursor: exiting ? "default" : "pointer", userSelect: "none",
      }}
      aria-label="织伴开场介绍（单击快进）"
    >
      {/* 顶部聚光 */}
      <div style={{
        position: "absolute", left: "50%", top: -80, width: mateSize * 1.5, height: mateSize * 0.9,
        transform: "translateX(-50%)",
        background: "radial-gradient(ellipse at 50% 0%, rgba(255,233,184,.14), transparent 65%)",
        pointerEvents: "none",
      }} />

      {/* S2 行业关键词散布（淡入） */}
      {seg.key === "system" && !exiting && script.keywords.map((kw, i) => (
        <div key={kw} style={{
          position: "absolute", ...(KW_POS[i % KW_POS.length] ?? { left: "8%", top: "30%" }),
          padding: "8px 18px", borderRadius: 999, zIndex: 5,
          color: "rgba(214,220,228,.5)", fontSize: 14, letterSpacing: 2,
          border: "1px solid rgba(214,220,228,.16)", background: "rgba(21,24,28,.5)",
          animation: `mw-kw-in .8s ease ${i * 0.45}s both`,
        }}>{kw}</div>
      ))}
      <style>{`
        @keyframes mw-kw-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        @keyframes mw-line-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes mw-enter { from { opacity: 0; transform: translateY(36px) scale(.96); } to { opacity: 1; transform: none; } }
      `}</style>

      {/* 织伴全身像舞台位（退场：缩小飞入右下角常驻位，叙事闭环） */}
      <div style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", justifyContent: "center",
        paddingBottom: 168, transition: "all 1.1s cubic-bezier(.5,0,.8,.4)",
        transform: exiting ? "translate(38vw, 26vh) scale(.14)" : "none",
        opacity: exiting ? 0 : 1,
        animation: exiting ? undefined : "mw-enter .9s cubic-bezier(.2,1,.3,1) both",
      }}>
        <div style={{ position: "relative" }}>
          <MateLive2D
            size={mateSize}
            frame="full"
            mood={seg.mood}
            gesture={seg.gesture ?? null}
          />
          {/* 脚下舞台地面光晕（脚底位置） */}
          <div style={{
            position: "absolute", left: "50%", bottom: -6, width: mateSize * 0.86, height: 74,
            transform: "translateX(-50%)", borderRadius: "50%",
            background: "radial-gradient(ellipse, rgba(214,220,228,.20), rgba(255,217,138,.06) 55%, transparent 75%)",
            pointerEvents: "none",
          }} />
        </div>
      </div>

      {/* 进度点（S1–S4） */}
      {!exiting && (
        <div style={{ position: "absolute", left: 40, bottom: 44, display: "flex", gap: 8, zIndex: 40 }}>
          {["intro", "system", "detail", "bridge"].map((k, i) => (
            <div key={k} style={{
              width: i === progressIdx ? 22 : 7, height: 7, borderRadius: 99, transition: "all .35s",
              background: i <= progressIdx ? "#ffd98a" : "rgba(214,220,228,.25)",
            }} />
          ))}
        </div>
      )}

      {/* 字幕区（底部居中，最近 4 行，最新行高亮） */}
      {!exiting && seg.lines.length > 0 && (
        <div style={{
          position: "absolute", left: "50%", bottom: 34, transform: "translateX(-50%)",
          width: "min(880px, 86vw)", zIndex: 40, textAlign: "center", cursor: "default",
        }} onClick={(e) => e.stopPropagation()}>
          <div style={{ color: "#8a939e", fontSize: 12, letterSpacing: 3, marginBottom: 10 }}>
            织伴 · {seg.key === "system" ? "系统介绍" : seg.key === "detail" ? "正式自我介绍" : seg.key === "bridge" ? "引出团队" : "开场"}
          </div>
          {seg.lines.slice(Math.max(0, shown - 4), shown).map((line, i, arr) => (
            <div key={`${seg.key}-${i}`} style={{
              color: i === arr.length - 1 ? "#e8ebef" : "rgba(154,162,172,.55)",
              fontSize: i === arr.length - 1 ? 19 : 14.5,
              lineHeight: 1.85, letterSpacing: .6,
              textShadow: "0 2px 14px rgba(0,0,0,.6)",
              animation: "mw-line-in .5s ease both",
            }}>{line}</div>
          ))}
          <div style={{ marginTop: 12, color: "#68707a", fontSize: 11, letterSpacing: 2 }}>单击画面快进 ›</div>
        </div>
      )}

      {/* 右下角：跳过开场，直接进入系统首页 */}
      {!exiting && (
        <button
          onClick={(e) => { e.stopPropagation(); VoiceEngine.stopAll(); onSkipAll(); }}
          style={{
            position: "absolute", right: 40, bottom: 38, zIndex: 50, cursor: "pointer",
            color: "#c3ccd8", fontSize: 13, letterSpacing: 2,
            background: "rgba(21,24,28,.72)", border: "1px solid rgba(214,220,228,.28)",
            borderRadius: 10, padding: "10px 20px",
          }}
        >跳过开场，直接进入 ›</button>
      )}
    </div>
  );
}
