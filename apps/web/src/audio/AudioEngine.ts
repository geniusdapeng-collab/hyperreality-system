/**
 * AudioEngine · 三层混音总线（单例，纯增强层——任何失败静默降级，不影响业务）
 *
 *   master ─┬─ ambienceGain（环境层，约 -28dB）
 *           ├─ sfxGain（反馈层，约 -18dB）
 *           └─ ritualGain（仪式层，约 -14dB）
 *
 * 音量三档：full（全开）/ hints（仅反馈+仪式）/ mute（suspend 零 CPU）。
 * AudioContext 懒启动：首次用户手势（pointerdown/keydown）后 resume（自动播放策略）。
 */
import { ALL_SFX, SFX_FEEDBACK, SFX_RITUAL } from "./sfx";

export type AudioMode = "full" | "hints" | "mute";
const MODE_KEY = "wl-audio-mode";

class AudioEngineImpl {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: Record<"ambience" | "sfx" | "ritual", GainNode | null> = { ambience: null, sfx: null, ritual: null };
  private noiseBuf: AudioBuffer | null = null;
  mode: AudioMode = (typeof localStorage !== "undefined" && (localStorage.getItem(MODE_KEY) as AudioMode)) || "full";
  private gestureBound = false;

  /** 首次用户手势后调用（组件挂载时绑定一次即可） */
  bindGesture(): void {
    if (this.gestureBound || typeof window === "undefined") return;
    this.gestureBound = true;
    const kick = () => { void this.ensureCtx(); window.removeEventListener("pointerdown", kick); window.removeEventListener("keydown", kick); };
    window.addEventListener("pointerdown", kick);
    window.addEventListener("keydown", kick);
  }

  private ensureCtx(): AudioContext | null {
    if (this.mode === "mute") return null;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
        this.buses = {
          ambience: this.ctx.createGain(),
          sfx: this.ctx.createGain(),
          ritual: this.ctx.createGain(),
        };
        this.buses.ambience!.gain.value = 0.35;
        this.buses.sfx!.gain.value = 0.7;
        this.buses.ritual!.gain.value = 0.85;
        for (const b of Object.values(this.buses)) b!.connect(this.master);
        // 共享噪声 buffer（2s 白噪）
        const len = this.ctx.sampleRate * 2;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  setMode(mode: AudioMode): void {
    this.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* 隐私模式静默 */ }
    if (mode === "mute") {
      void this.ctx?.suspend();
    } else {
      this.ensureCtx();
      void this.ctx?.resume();
      // ambience 总线随档位开关
      if (this.buses.ambience) this.buses.ambience.gain.value = mode === "full" ? 0.35 : 0;
    }
  }

  /** 播放音效预设；bus 默认按预设归属（反馈层/仪式层） */
  play(name: keyof typeof ALL_SFX | string): void {
    if (this.mode === "mute") return;
    const ctx = this.ensureCtx();
    const preset = ALL_SFX[name];
    if (!ctx || !preset) return;
    try {
      const busName = name in SFX_RITUAL ? "ritual" : "sfx";
      const bus = this.buses[busName];
      if (!bus) return;
      const t0 = ctx.currentTime;
      for (const tone of preset.tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const at = t0 + (tone.at ?? 0);
        const attack = tone.attack ?? 0.005;
        const decay = tone.decay ?? tone.dur * 0.7;
        osc.type = tone.type;
        osc.frequency.setValueAtTime(tone.freq, at);
        if (tone.freq2) osc.frequency.exponentialRampToValueAtTime(tone.freq2, at + tone.dur);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(Math.max(tone.vol, 0.001), at + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
        osc.connect(gain).connect(bus);
        osc.start(at);
        osc.stop(at + tone.dur + 0.05);
      }
      if (preset.noise && this.noiseBuf) {
        const n = preset.noise;
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        const gain = ctx.createGain();
        const at = t0 + (n.at ?? 0);
        gain.gain.setValueAtTime(n.vol, at);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + n.dur);
        let node: AudioNode = src;
        if (n.lowpass) {
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.value = n.lowpass;
          node.connect(lp);
          node = lp;
        }
        node.connect(gain).connect(bus);
        src.start(at);
        src.stop(at + n.dur + 0.02);
      }
    } catch { /* 合成失败静默 */ }
  }

  /** 供环境层取总线（ambience.ts 专用） */
  get ambienceBus(): GainNode | null {
    if (this.mode !== "full") return null;
    this.ensureCtx();
    return this.buses.ambience;
  }
  get context(): AudioContext | null {
    return this.ctx;
  }
  get sharedNoise(): AudioBuffer | null {
    return this.noiseBuf;
  }
}

export const AudioEngine = new AudioEngineImpl();
export { SFX_FEEDBACK, SFX_RITUAL };
