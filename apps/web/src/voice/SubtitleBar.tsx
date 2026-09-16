/**
 * SubtitleBar · 新闻台字幕条（语音的字幕等价物 + 降级兜底）
 *
 *  - 底部横条：左侧显示当前工作区晨会台标，右侧字幕区逐条播报；
 *  - 消费 VoiceEngine 字幕事件；fuse（熔断）字幕红色高亮并置顶打断；
 *  - 无字幕时原位隐藏（不占视觉、不移出视口，避免制造页面滚动范围）。
 */
import { useEffect, useRef, useState } from "react";
import { VoiceEngine, type Caption } from "./VoiceEngine";

export function SubtitleBar({ channelName = "经营晨会" }: { channelName?: string }) {
  const [current, setCurrent] = useState<Caption | null>(null);
  const [visible, setVisible] = useState(false);
  const queueRef = useRef<Caption[]>([]);
  const timerRef = useRef<number | null>(null);
  const playingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    const showNext = () => {
      if (disposed) return;
      timerRef.current = null;
      const next = queueRef.current.shift();
      if (!next) {
        playingRef.current = false;
        setVisible(false);
        setCurrent(null);
        return;
      }
      playingRef.current = true;
      setCurrent(next);
      setVisible(true);
      timerRef.current = window.setTimeout(showNext, next.ttl);
    };
    const off = VoiceEngine.onCaption((cap) => {
      if (cap.priority === "fuse") {
        // 熔断打断：清空队列立即显示
        queueRef.current = [cap];
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = null;
        playingRef.current = false;
        showNext();
      } else {
        queueRef.current.push(cap);
        if (!playingRef.current) showNext();
      }
    });
    return () => {
      disposed = true;
      off();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      playingRef.current = false;
      queueRef.current = [];
    };
  }, []);

  const fuse = current?.priority === "fuse";
  return (
    <div
      style={{
        position: "fixed", left: "50%", bottom: 18, transform: "translateX(-50%)",
        zIndex: 60, display: "flex", alignItems: "stretch", width: "min(860px, calc(100vw - 24px))", maxWidth: "100%",
        borderRadius: 10, overflow: "hidden",
        border: `1px solid ${fuse ? "rgba(224,90,107,.6)" : "rgba(214,220,228,.22)"}`,
        background: "rgba(14,16,19,.92)", backdropFilter: "blur(8px)",
        boxShadow: fuse ? "0 8px 30px rgba(224,90,107,.25)" : "0 8px 30px rgba(0,0,0,.45)",
        opacity: visible ? 1 : 0,
        visibility: visible ? "visible" : "hidden",
        transition: "opacity .3s ease",
        pointerEvents: "none",
      }}
      aria-live="polite"
      aria-hidden={!visible}
    >
      <div style={{
        flex: "0 1 42%", minWidth: 0, display: "flex", alignItems: "center", gap: 6,
        padding: "8px 12px", fontSize: 14, fontWeight: 700, letterSpacing: 1,
        color: fuse ? "#ffdce2" : "#e8edf4",
        background: fuse ? "#a8323f" : "#252a30",
        borderRight: "1px solid rgba(214,220,228,.15)", overflowWrap: "anywhere",
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: fuse ? "#fff" : "#e05a6b", boxShadow: "0 0 6px #e05a6b" }} />
        播报台 · {channelName}
      </div>
      <div style={{ minWidth: 0, padding: "8px 14px", fontSize: 14, color: "#eef4ff", lineHeight: 1.5, display: "flex", flexWrap: "wrap", alignItems: "center" }}>
        {current && (
          <>
            <b style={{ minWidth: 0, maxWidth: "100%", color: fuse ? "#ff9fae" : "#b3c6de", marginRight: 8, overflowWrap: "anywhere", wordBreak: "break-word" }}>{current.persona}</b>
            <span style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere", wordBreak: "break-word" }}>{current.text}</span>
          </>
        )}
      </div>
    </div>
  );
}
