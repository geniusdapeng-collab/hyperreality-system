/**
 * SubtitleBar · 新闻台字幕条（语音的字幕等价物 + 降级兜底）
 *
 *  - 底部横条：左侧台标「WL-TV · 云栖晨会」，右侧字幕区逐条播报；
 *  - 消费 VoiceEngine 字幕事件；fuse（熔断）字幕红色高亮并置顶打断；
 *  - 无字幕时自动隐藏（不占视觉）；进出 translateY 动画。
 */
import { useEffect, useRef, useState } from "react";
import { VoiceEngine, type Caption } from "./VoiceEngine";

export function SubtitleBar() {
  const [current, setCurrent] = useState<Caption | null>(null);
  const [visible, setVisible] = useState(false);
  const queueRef = useRef<Caption[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const showNext = () => {
      const next = queueRef.current.shift();
      if (!next) {
        setVisible(false);
        setCurrent(null);
        return;
      }
      setCurrent(next);
      setVisible(true);
      timerRef.current = window.setTimeout(showNext, next.ttl);
    };
    const off = VoiceEngine.onCaption((cap) => {
      if (cap.priority === "fuse") {
        // 熔断打断：清空队列立即显示
        queueRef.current = [cap];
        if (timerRef.current) window.clearTimeout(timerRef.current);
        showNext();
      } else {
        queueRef.current.push(cap);
        if (!current && queueRef.current.length === 1) showNext();
      }
    });
    return () => {
      off();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fuse = current?.priority === "fuse";
  return (
    <div
      style={{
        position: "fixed", left: "50%", bottom: 18, transform: `translateX(-50%) translateY(${visible ? 0 : 76}px)`,
        zIndex: 60, display: "flex", alignItems: "stretch", maxWidth: "min(860px, 86vw)",
        borderRadius: 10, overflow: "hidden",
        border: `1px solid ${fuse ? "rgba(224,90,107,.6)" : "rgba(214,220,228,.22)"}`,
        background: "rgba(14,16,19,.92)", backdropFilter: "blur(8px)",
        boxShadow: fuse ? "0 8px 30px rgba(224,90,107,.25)" : "0 8px 30px rgba(0,0,0,.45)",
        transition: "transform .3s ease",
        pointerEvents: "none",
      }}
      aria-live="polite"
    >
      <div style={{
        flex: "none", display: "flex", alignItems: "center", gap: 6,
        padding: "8px 12px", fontSize: 10, fontWeight: 700, letterSpacing: 1,
        color: fuse ? "#ffdce2" : "#e8edf4",
        background: fuse ? "#a8323f" : "#252a30",
        borderRight: "1px solid rgba(214,220,228,.15)", whiteSpace: "nowrap",
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: fuse ? "#fff" : "#e05a6b", boxShadow: "0 0 6px #e05a6b" }} />
        WL-TV · 云栖晨会
      </div>
      <div style={{ padding: "8px 14px", fontSize: 12, color: "#eef4ff", lineHeight: 1.5, display: "flex", alignItems: "center" }}>
        {current && (
          <>
            <b style={{ color: fuse ? "#ff9fae" : "#b3c6de", marginRight: 8, whiteSpace: "nowrap" }}>{current.persona}</b>
            <span>{current.text}</span>
          </>
        )}
      </div>
    </div>
  );
}
