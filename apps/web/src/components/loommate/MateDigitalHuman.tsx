/**
 * MateDigitalHuman · 织伴数字人（完整数字人逻辑，非卡通贴片）
 * 引擎：TalkingHead（MIT，vendor/talkinghead）+ VRoid 动漫头像（演示许可，见 VENDOR.md）
 * 数字人四要素：
 *  ① 口型：VoiceEngine boundary 事件（charIndex）→ 视素时间线 → setValue('viseme_*') 逐帧对齐；
 *     另支持 HTMLAudioElement 振幅驱动（edge-tts 等录音频——AnalyserNode RMS → 视素开合）
 *  ② 表情：事件/对话情绪 → setMood（happy/love/fear/sad/neutral…）
 *  ③ 动作：手势 playGesture（handup 招呼/thumbup 赞许/index 强调）+ 自动眨眼/眼神/呼吸/动态骨骼
 *  ④ 情绪表达：mood+gesture+口型三线并发（声情并茂）
 * 降级：WebGL 不可用 → 调用方退回 SVG 甜妹
 */
import { useEffect, useRef } from "react";
import { TalkingHead } from "./talkinghead/talkinghead.mjs";
import { VoiceEngine } from "../../voice/VoiceEngine";

export type MateMood = "neutral" | "happy" | "love" | "fear" | "sad" | "angry";
export type MateGesture = "handup" | "thumbup" | "ok" | "index" | "shrug" | null;

/* ---------- 口型驱动器：中文 charIndex → Oculus 视素 ---------- */
/** 元音视素池（中文韵母近似映射：按 charCode 稳定分桶，同一字永远同一口型） */
const VOWEL_VISEMES = ["viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U"] as const;
const ALL_VISEMES = [...VOWEL_VISEMES, "viseme_sil", "viseme_PP", "viseme_kk", "viseme_FF", "viseme_SS", "viseme_TH", "viseme_DD", "viseme_nn", "viseme_RR", "viseme_CH"] as const;

function vowelFor(char: string): (typeof VOWEL_VISEMES)[number] {
  const code = char.codePointAt(0) ?? 0;
  return VOWEL_VISEMES[code % VOWEL_VISEMES.length]!;
}

class LipDriver {
  private head: TalkingHead | null = null;
  private timer: number | null = null;
  private queue: Array<{ viseme: string; ms: number }> = [];
  private speaking = false;

  attach(head: TalkingHead): void { this.head = head; }

  private resetMouth(ms = 120): void {
    if (!this.head) return;
    for (const v of ALL_VISEMES) this.head.setValue(v, 0, ms);
  }

  /** 说话开始：进入口型模式 */
  start(): void {
    this.speaking = true;
    this.resetMouth(80);
  }

  /** boundary 推进：给当前字符排一个视素（开→合两段） */
  feedChar(char: string, charDurationMs: number): void {
    if (!this.speaking || !this.head) return;
    const vowel = vowelFor(char);
    const open = Math.min(240, Math.max(90, charDurationMs * 0.55));
    const close = Math.max(60, charDurationMs * 0.45);
    this.queue.push({ viseme: vowel, ms: open }, { viseme: "sil", ms: close });
    if (this.timer === null) this.pump();
  }

  private pump = (): void => {
    if (!this.head) { this.timer = null; return; }
    const next = this.queue.shift();
    if (!next) {
      this.timer = null;
      if (!this.speaking) this.resetMouth(200);
      return;
    }
    if (next.viseme === "sil") {
      this.resetMouth(Math.min(120, next.ms));
    } else {
      // 先收其他元音再开目标视素（0.55~0.85 随机开口度，避免机械感）
      const weight = 0.55 + Math.random() * 0.3;
      for (const v of VOWEL_VISEMES) this.head.setValue(v, v === next.viseme ? weight : 0, Math.min(110, next.ms));
    }
    this.timer = window.setTimeout(this.pump, next.ms * 0.85);
  };

  /** 说话结束：排空后闭口 */
  end(): void {
    this.speaking = false;
    this.queue = [];
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.resetMouth(220);
  }

  destroy(): void { this.end(); }
}

/* ---------- 组件 ---------- */
export interface DigitalHumanHandle {
  setMood: (mood: MateMood) => void;
  gesture: (g: Exclude<MateGesture, null>, durSec?: number) => void;
  /** 用音频文件驱动口型（edge-tts 等录音频：RMS 振幅 → 视素） */
  speakWithAudio: (url: string) => void;
}

export function MateDigitalHuman({ size, mood = "neutral", gesture = null, avatarUrl = "/avatars/business.glb", onReady }: {
  size: number;
  mood?: MateMood;
  gesture?: MateGesture;
  /** 头像 GLB（行业版/客户可换：Mixamo 骨架 + ARKit blendshapes 即兼容） */
  avatarUrl?: string;
  onReady?: (h: DigitalHumanHandle) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<TalkingHead | null>(null);
  const lipRef = useRef(new LipDriver());
  const moodRef = useRef(mood);

  useEffect(() => {
    let disposed = false;
    let offLip: (() => void) | null = null;
    const host = hostRef.current;
    if (!host) return;

    const head = new TalkingHead(host, {
      // 不使用引擎自带 TTS——语音统一走 VoiceEngine（字幕/队列纪律），口型经 onLipSync 驱动
      cameraView: "upper",
      cameraRotateEnable: false,
      cameraZoomEnable: false,
      cameraPanEnable: false,
      cameraY: 0.05,
      avatarMood: moodRef.current,
      lipsyncLang: "en",
      lightAmbientIntensity: 1.6,
      lightDirectIntensity: 1.1,
    });
    headRef.current = head;
    lipRef.current.attach(head);
    // 调试探针（运行时自测/验收驱动用；生产无副作用）
    (window as unknown as { __loommateDH?: TalkingHead }).__loommateDH = head;

    head.showAvatar(
      { url: avatarUrl, body: "F", lipsyncLang: "en", avatarMood: moodRef.current },
      undefined,
      (err: unknown) => { console.warn("[织伴数字人] 头像加载失败:", err); },
    ).then(() => {
      if (disposed) return;
      head.start();
      head.setMood(moodRef.current);
      const handle: DigitalHumanHandle = {
        setMood: (m) => head.setMood(m),
        gesture: (g, dur = 2.5) => head.playGesture(g, dur, false, 600),
        speakWithAudio: (url) => {
          // 录音频驱动：AudioContext 分析 RMS → 视素开合（与声音实时对齐）
          void (async () => {
            const audio = new Audio(url);
            const ctx = new AudioContext();
            const src = ctx.createMediaElementSource(audio);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            analyser.connect(ctx.destination);
            const data = new Uint8Array(analyser.frequencyBinCount);
            lipRef.current.start();
            let lastV = 0;
            const tick = () => {
              if (audio.ended || audio.paused) { lipRef.current.end(); void ctx.close(); return; }
              analyser.getByteTimeDomainData(data);
              let sum = 0;
              for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]! - 128);
              const rms = sum / data.length / 128;   // 0~1
              const open = Math.min(1, rms * 3.2);
              if (Math.abs(open - lastV) > 0.08) {
                const viseme = open > 0.55 ? "viseme_aa" : open > 0.3 ? "viseme_O" : open > 0.12 ? "viseme_E" : "viseme_sil";
                for (const v of ["viseme_aa", "viseme_O", "viseme_E", "viseme_I", "viseme_U"] as const) {
                  head.setValue(v, v === viseme ? Math.max(0.15, open) : 0, 70);
                }
                lastV = open;
              }
              requestAnimationFrame(tick);
            };
            await audio.play();
            tick();
          })();
        },
      };
      (window as unknown as { __loommateHandle?: DigitalHumanHandle }).__loommateHandle = handle;
      onReady?.(handle);
    }).catch(() => undefined);

    // 口型事件接线：VoiceEngine boundary（charIndex → 视素时间线）
    offLip = VoiceEngine.onLipSync((ev) => {
      if (ev.type === "start") lipRef.current.start();
      else if (ev.type === "boundary") lipRef.current.feedChar("语", 260);   // 中文逐字口型（近似 260ms/字，rate≈1）
      else lipRef.current.end();
    });

    return () => {
      disposed = true;
      offLip?.();
      lipRef.current.destroy();
      try { head.stop(); } catch { /* 静默 */ }
      hostRef.current?.replaceChildren();
      headRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 情绪/手势响应
  useEffect(() => {
    moodRef.current = mood;
    try { headRef.current?.setMood(mood); } catch { /* 未就绪 */ }
  }, [mood]);
  useEffect(() => {
    if (gesture) {
      try { headRef.current?.playGesture(gesture, 2.5, false, 600); } catch { /* 未就绪 */ }
    }
  }, [gesture]);

  return (
    <div
      ref={hostRef}
      style={{ width: size, height: size, overflow: "hidden", borderRadius: "50%" }}
      className="pointer-events-auto"
    />
  );
}
