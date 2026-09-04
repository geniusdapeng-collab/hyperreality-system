/**
 * ambience · 环境声层（程序化循环，无音频资产）
 *
 * 三种声景：
 *  - office：低通滤噪（空调/机房底噪）+ 泊松间隔随机键盘"嗒"
 *  - rain：带通棕噪（雨声）+ 偶发远雷低频轰
 *  - morning：高通风声 + 随机鸟鸣啁啾（FM 滑音）
 *
 * 按真实时间自动选景（useAmbienceScene：清晨鸟鸣/白天办公/夜班雨声），
 * 切换时 2s 交叉淡化；仅在音量档位 full 下出声。
 */
import { useEffect, useRef } from "react";
import { AudioEngine } from "./AudioEngine";
import { isNightAt } from "../lib/useNightTime";

export type AmbienceScene = "morning" | "office" | "rain";

/** 当前应播声景：05:30-09:00 清晨 / 夜班雨声 / 其余办公 */
export function sceneOf(date: Date): AmbienceScene {
  const sh = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const m = sh.getHours() * 60 + sh.getMinutes();
  if (isNightAt(date)) return "rain";
  if (m >= 5 * 60 + 30 && m < 9 * 60) return "morning";
  return "office";
}

class AmbiencePlayer {
  private nodes: AudioNode[] = [];
  private timers: number[] = [];
  private current: AmbienceScene | null = null;

  stop(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    for (const n of this.nodes) { try { (n as AudioBufferSourceNode).stop?.(); } catch { /* 已停 */ } try { n.disconnect(); } catch { /* 已断 */ } }
    this.nodes = [];
    this.current = null;
  }

  start(scene: AmbienceScene): void {
    if (this.current === scene) return;
    this.stop();
    const ctx = AudioEngine.context;
    const bus = AudioEngine.ambienceBus;
    const noiseBuf = AudioEngine.sharedNoise;
    if (!ctx || !bus || !noiseBuf) return;
    this.current = scene;

    // —— 底噪层 ——
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    if (scene === "office") {
      filter.type = "lowpass"; filter.frequency.value = 380; gain.gain.value = 0.5;
    } else if (scene === "rain") {
      filter.type = "bandpass"; filter.frequency.value = 1400; filter.Q.value = 0.6; gain.gain.value = 0.65;
    } else {
      filter.type = "highpass"; filter.frequency.value = 1800; gain.gain.value = 0.12;
    }
    src.connect(filter).connect(gain).connect(bus);
    src.start();
    this.nodes.push(src, filter, gain);

    // —— 随机点缀层 ——
    const sprinkle = () => {
      if (this.current !== scene) return;
      if (scene === "office") {
        AudioEngine.play("key");
        this.timers.push(window.setTimeout(sprinkle, 3000 + Math.random() * 6000));
      } else if (scene === "rain") {
        // 远雷：低频正弦轰
        this.thunder(ctx, bus);
        this.timers.push(window.setTimeout(sprinkle, 20000 + Math.random() * 30000));
      } else {
        this.bird(ctx, bus);
        this.timers.push(window.setTimeout(sprinkle, 4000 + Math.random() * 8000));
      }
    };
    this.timers.push(window.setTimeout(sprinkle, 1500 + Math.random() * 2500));
  }

  private thunder(ctx: AudioContext, bus: AudioNode): void {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      osc.type = "sine";
      osc.frequency.setValueAtTime(55, t);
      osc.frequency.exponentialRampToValueAtTime(30, t + 1.8);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.4, t + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 2);
      osc.connect(gain).connect(bus);
      osc.start(t); osc.stop(t + 2.1);
    } catch { /* 静默 */ }
  }

  private bird(ctx: AudioContext, bus: AudioNode): void {
    try {
      const t = ctx.currentTime;
      const notes = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < notes; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const at = t + i * (0.12 + Math.random() * 0.1);
        const f = 2400 + Math.random() * 1600;
        osc.type = "sine";
        osc.frequency.setValueAtTime(f, at);
        osc.frequency.exponentialRampToValueAtTime(f * (1.2 + Math.random() * 0.3), at + 0.08);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.06, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
        osc.connect(gain).connect(bus);
        osc.start(at); osc.stop(at + 0.14);
      }
    } catch { /* 静默 */ }
  }
}

const player = new AmbiencePlayer();

/** React hook：按时间自动切换声景（每分钟自检；音量非 full 时静默） */
export function useAmbience(): void {
  const sceneRef = useRef<AmbienceScene | null>(null);
  useEffect(() => {
    AudioEngine.bindGesture();
    const apply = () => {
      const scene = sceneOf(new Date());
      if (AudioEngine.mode !== "full") { player.stop(); sceneRef.current = null; return; }
      if (sceneRef.current !== scene) {
        sceneRef.current = scene;
        // 等 AudioContext 就绪（首次手势后）
        const tryStart = () => {
          if (AudioEngine.ambienceBus) player.start(scene);
          else window.setTimeout(tryStart, 1200);
        };
        tryStart();
      }
    };
    apply();
    const timer = window.setInterval(apply, 60_000);
    return () => { window.clearInterval(timer); player.stop(); };
  }, []);
}
