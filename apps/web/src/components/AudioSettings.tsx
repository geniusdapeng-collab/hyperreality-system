/**
 * AudioSettings · 视听设置弹层（音量三档 / 语音档位 / 导演模式开关）
 *
 * 全部 localStorage 持久化、跨会话记忆；齿轮按钮挂在 P0 顶栏。
 */
import { useState } from "react";
import { AudioEngine, type AudioMode } from "../audio/AudioEngine";
import { VoiceEngine, type VoiceGate } from "../voice/VoiceEngine";

export function AudioSettings() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AudioMode>(AudioEngine.mode);
  const [gate, setGate] = useState<VoiceGate>(VoiceEngine.gate);
  const [director, setDirector] = useState(() => {
    try { return localStorage.getItem("wl-director-on") !== "0"; } catch { return true; }
  });

  const btn = (active: boolean) =>
    `rounded border px-2 py-0.5 text-[11px] ${active ? "border-gline bg-gold/15 text-gold" : "border-line text-ink3 hover:text-ink2"}`;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-line px-2 py-0.5 text-[11px] text-ink3 hover:border-gline hover:text-ink2"
        title="视听设置"
      >
        ⚙ 视听
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-50 w-60 rounded-lg border border-line bg-bg900 p-3 shadow-[0_12px_40px_rgba(0,0,0,.5)]">
          <div className="mb-2 text-[11px] font-bold text-ink">视听设置</div>

          <div className="mb-1 text-[10px] text-ink3">音量（音效与环境声）</div>
          <div className="mb-2.5 flex gap-1">
            <button className={btn(mode === "full")} onClick={() => { setMode("full"); AudioEngine.setMode("full"); }}>完整</button>
            <button className={btn(mode === "hints")} onClick={() => { setMode("hints"); AudioEngine.setMode("hints"); }}>仅提示音</button>
            <button className={btn(mode === "mute")} onClick={() => { setMode("mute"); AudioEngine.setMode("mute"); }}>静音</button>
          </div>

          <div className="mb-1 text-[10px] text-ink3">语音播报（TTS）</div>
          <div className="mb-2.5 flex gap-1">
            <button className={btn(gate === "ritual-only")} onClick={() => { setGate("ritual-only"); VoiceEngine.setGate("ritual-only"); }}>仪式与熔断</button>
            <button className={btn(gate === "all")} onClick={() => { setGate("all"); VoiceEngine.setGate("all"); }}>全语音</button>
            <button className={btn(gate === "captions")} onClick={() => { setGate("captions"); VoiceEngine.setGate("captions"); }}>仅字幕</button>
          </div>

          <div className="mb-1 text-[10px] text-ink3">导演运镜（事件镜头，每天 ≤6 次）</div>
          <div className="flex gap-1">
            <button className={btn(director)} onClick={() => { setDirector(true); try { localStorage.setItem("wl-director-on", "1"); } catch { /* 静默 */ } }}>开</button>
            <button className={btn(!director)} onClick={() => { setDirector(false); try { localStorage.setItem("wl-director-on", "0"); } catch { /* 静默 */ } }}>关</button>
          </div>

          <div className="mt-2 border-t border-line pt-2 text-[9.5px] leading-relaxed text-ink3">
            语音为端侧合成（不联网）；字幕条始终可用。音频故障不影响任何业务功能。
          </div>
        </div>
      )}
    </div>
  );
}
