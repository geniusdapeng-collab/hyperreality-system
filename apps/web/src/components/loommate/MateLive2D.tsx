/**
 * 织伴数字人 · Live2D 渲染后端（行业标准路线，彻底绕开写实 3D 恐怖谷）
 *
 * 驱动四要素：
 *  - 口型：VoiceEngine.onLipSync（boundary charIndex）→ 中文逐字开口度时间线
 *          → PARAM_MOUTH_OPEN_Y 直写（逐帧包络，自动闭口）；音频文件可经 speakWithAudio 振幅驱动
 *  - 表情：mood → Live2D expression（f01 微笑/f02 害羞/f03 认真/f04 惊讶）
 *  - 动作：gesture → Live2D motion（招呼 tap_body；常态 idle 循环呼吸感）
 *  - 情绪表达：mood + 动作 + 口型三线并发
 *
 * 虚拟时钟契约（录屏技能路线 B）：
 *  capture 模式挂 window.__loommateStep(dt)：model.update(dt*1000) + render，
 *  与墙钟解耦，逐帧 30fps 丝滑捕获。window.__loommateLive2DReady() 标记就绪。
 */
import { useEffect, useRef } from "react";
import * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display";
import { VoiceEngine } from "../../voice/VoiceEngine";

export type MateMood = "neutral" | "happy" | "fear" | "love";
export type MateGesture = "handup" | "thumbup" | null;

export interface Live2DHandle {
  setMood: (m: MateMood) => void;
  gesture: (g: Exclude<MateGesture, null>) => void;
  /** 音频文件驱动口型（RMS 振幅 → 开口度，用于录音频演示/验收） */
  speakWithAudio: (url: string) => void;
}

declare global {
  interface Window {
    Live2D?: unknown;
    PIXI?: typeof PIXI;
    __loommateLive2D?: Live2DHandle;
    __loommateLive2DReady?: () => boolean;
    __loommateStep?: (dt: number) => void;
  }
}

/** shizuku 表情映射（f01 微笑/f02 羞涩/f03 认真/f04 吃惊） */
const MOOD_EXPR: Record<MateMood, string | null> = {
  neutral: null,
  happy: "f01",
  love: "f02",
  fear: "f04",
};

/** 中文开口度：按常见韵母映射（与 TalkingHead 版同口径） */
const OPEN_OF_CHAR = (ch: string): number => {
  if (/[啊阿啊吗吧哪那大打发拉马]/.test(ch)) return 0.85;   // a 大开
  if (/[哦喔波破佛摸我多说做]/.test(ch)) return 0.65;        // o 圆唇中开
  if (/[一七希溪衣机记起提你]/.test(ch)) return 0.25;        // i 小开
  if (/[呜五不读出路古书]/.test(ch)) return 0.35;            // u 撮口
  if (/[诶诶黑给类被北]/.test(ch)) return 0.5;               // e 中开
  return 0.45;
};

let corePromise: Promise<void> | null = null;
/** 加载 Cubism 2.1 + 4 双 core（插件两个 factory 都检查 runtime），幂等 */
function ensureCore(): Promise<void> {
  if (window.Live2D) return Promise.resolve();
  const inject = (src: string) => new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(src + " 加载失败"));
    document.head.appendChild(s);
  });
  corePromise ??= Promise.all([
    inject("/live2d/live2d.min.js"),
    inject("/live2d/live2dcubismcore.min.js"),
  ]).then(() => undefined);
  return corePromise;
}

export function MateLive2D({ size, mood = "neutral", gesture = null, modelUrl = "/live2d/shizuku/shizuku.model.json", onReady }: {
  size: number;
  mood?: MateMood;
  gesture?: MateGesture;
  /** 模型 .model.json 路径（客户/行业版可换自制模型） */
  modelUrl?: string;
  onReady?: (h: Live2DHandle) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<Live2DModel | null>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const moodRef = useRef<MateMood>(mood);
  moodRef.current = mood;
  const lipTimer = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let offLip: (() => void) | null = null;
    let raf = 0;
    let last = performance.now();

    (async () => {
      await ensureCore();
      if (disposed || !hostRef.current) return;
      window.PIXI = PIXI;
      // 动态 import：该插件在模块求值时即检查 window.Live2D（Cubism 2 runtime），
      // 必须等 core 注入后再加载（静态 import 会整包报错白屏——已踩过）
      const { Live2DModel } = await import("pixi-live2d-display");

      const capture = new URLSearchParams(location.search).has("capture");
      const app = new PIXI.Application({
        width: size,
        height: size,
        backgroundAlpha: 0,
        antialias: true,
        preserveDrawingBuffer: capture,   // 路线 B 截图保真
        autoStart: false,                 // 自控时钟（虚拟时钟契约前提）
      });
      appRef.current = app;
      hostRef.current.appendChild(app.view as HTMLCanvasElement);
      (app.view as HTMLCanvasElement).style.width = "100%";
      (app.view as HTMLCanvasElement).style.height = "100%";

      const model = await Live2DModel.from(modelUrl, { autoUpdate: false });
      if (disposed) return;
      modelRef.current = model;
      // 构图：头肩胸取景——模型向下多探，让脸部占据视窗上中部（shizuku 为带课桌全身模型）
      const s = size / Math.max(model.width, model.height) * 2.0;
      model.scale.set(s);
      model.x = size / 2;
      model.y = size * 1.72;
      model.anchor.set(0.5, 1);
      app.stage.addChild(model);

      // 常态 idle 呼吸循环 + 初始表情
      void model.motion("idle");
      const expr = MOOD_EXPR[moodRef.current];
      if (expr) await model.expression(expr).catch(() => undefined);

      /* ---------- 口型驱动：文本逐字开口度 → PARAM_MOUTH_OPEN_Y ---------- */
      const setMouth = (v: number) => {
        try {
          (model.internalModel.coreModel as unknown as { setParamFloat: (k: string, v: number) => void })
            .setParamFloat("PARAM_MOUTH_OPEN_Y", v);
        } catch { /* 静默 */ }
      };
      offLip = VoiceEngine.onLipSync((ev) => {
        if (ev.type === "start") {
          if (lipTimer.current) window.clearInterval(lipTimer.current);
        } else if (ev.type === "boundary") {
          // 逐字开口度（按原文取字映射韵母；取不到字时随机包络兜底）
          const ch = ev.text && typeof ev.charIndex === "number" ? ev.text.charAt(ev.charIndex) : "";
          const open = ch ? OPEN_OF_CHAR(ch) : 0.3 + Math.random() * 0.5;
          setMouth(open);
          window.setTimeout(() => setMouth(0.1), 130);
        } else {
          setMouth(0);
          if (lipTimer.current) { window.clearInterval(lipTimer.current); lipTimer.current = null; }
        }
      });

      /* ---------- 对外句柄（调试探针 + 验收驱动） ---------- */
      const handle: Live2DHandle = {
        setMood: (m) => {
          moodRef.current = m;
          const e = MOOD_EXPR[m];
          if (e) void model.expression(e).catch(() => undefined);
          else void model.expression(null as unknown as string).catch(() => undefined);
        },
        gesture: (g) => {
          if (g === "handup" || g === "thumbup") void model.motion("tap_body").catch(() => undefined);
        },
        speakWithAudio: (url) => {
          // 振幅口型（AnalyserNode RMS → PARAM_MOUTH_OPEN_Y；录音频演示/验收用）
          void (async () => {
            try {
              const audio = new Audio(url);
              const ctx = new AudioContext();
              const src = ctx.createMediaElementSource(audio);
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 256;
              src.connect(analyser);
              analyser.connect(ctx.destination);
              const buf = new Uint8Array(analyser.frequencyBinCount);
              let alive = true;
              audio.onended = () => { alive = false; setMouth(0); void ctx.close(); };
              const loop = () => {
                if (!alive) return;
                analyser.getByteTimeDomainData(buf);
                let sum = 0;
                for (const v of buf) sum += (v - 128) * (v - 128);
                const rms = Math.sqrt(sum / buf.length) / 128;
                setMouth(Math.min(1, rms * 3.2));
                requestAnimationFrame(loop);
              };
              await audio.play();
              loop();
            } catch { /* 静默 */ }
          })();
        },
      };
      window.__loommateLive2D = handle;
      window.__loommateLive2DReady = () => true;
      onReady?.(handle);

      /* ---------- 时钟：capture=虚拟步进；常态=rAF ---------- */
      if (capture) {
        window.__loommateStep = (dt: number) => {
          model.update(dt * 1000);
          app.render();
        };
        app.render();
      } else {
        const tick = (now: number) => {
          if (disposed) return;
          const dt = Math.min(100, now - last);
          last = now;
          model.update(dt);
          app.render();
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      }
    })().catch((e) => {
      // 加载失败留证（SVG 兜底由 LoomMate 侧接管）
      (window as unknown as { __loommateL2DErr?: string }).__loommateL2DErr = String(e?.stack ?? e).slice(0, 500);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      offLip?.();
      if (lipTimer.current) window.clearInterval(lipTimer.current);
      window.__loommateLive2DReady = undefined;
      window.__loommateStep = undefined;
      try { appRef.current?.destroy(true, { children: true }); } catch { /* 静默 */ }
      appRef.current = null;
      modelRef.current = null;
    };
  }, [size, modelUrl, onReady]);

  // mood 联动
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    const e = MOOD_EXPR[mood];
    if (e) void model.expression(e).catch(() => undefined);
  }, [mood]);

  // 手势联动
  useEffect(() => {
    if (!gesture || !modelRef.current) return;
    void modelRef.current.motion("tap_body").catch(() => undefined);
  }, [gesture]);

  return (
    <div
      ref={hostRef}
      style={{ width: size, height: size, borderRadius: 16, overflow: "hidden", pointerEvents: "none" }}
      aria-label="织伴数字人（Live2D）"
    />
  );
}
