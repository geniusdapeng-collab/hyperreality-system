/**
 * 织伴数字人 · Live2D 渲染后端（行业标准路线，彻底绕开写实 3D 恐怖谷）
 *
 * 驱动四要素：
 *  - 口型：VoiceEngine.onLipSync（boundary charIndex）→ 中文逐字开口度时间线；
 *          音频文件经 speakWithAudio 振幅+频带驱动。统一进「口型平滑引擎」：
 *          目标值逐帧指数趋近（快开慢收），消灭方波硬切的嘴部跳变
 *  - 表情：mood → Live2D expression（f01 微笑/f02 害羞/f03 认真/f04 惊讶）
 *  - 动作：gesture → Live2D motion（招呼 tap_body；常态 idle 循环呼吸感）
 *  - 情绪表达：mood + 动作 + 口型三线并发
 *
 * 体验升级（v2 驱动自研）：
 *  - 按需渲染：活跃信号（说话/表情/动作/视线）驱动满帧渲染，静止 2.6s 后进
 *    12fps 生态模式——角落挂件常驻桌面的功耗大头就此掐掉
 *  - 视线追随：窗口鼠标 → model.focus（节流+双层惯性）；无操作时注视点自主
 *    游移，"她在照看团队"的拟人感来源。capture 模式禁用（录屏确定性）
 *  - 启动预热：应用空闲 1.5s 后预载 Cubism 双 core，挂件首开不再干等
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
  /** 音频文件驱动口型（RMS 振幅+频带 → 开口度/嘴形，用于录音频演示/验收） */
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

/** 表情映射按模型登记（残留教训：曾硬编码 shizuku 表情 ID，换 Mao 后情绪静默失效）
 *  Mao（Cubism 3.0 官样）：exp_02 眯眼笑 / exp_06 脸红羞涩 / exp_07 睁大吃惊
 *  shizuku（备份模型）：f01 微笑 / f02 羞涩 / f04 吃惊 */
const MODEL_EXPR: Record<string, Record<MateMood, string | null>> = {
  mao:     { neutral: null, happy: "exp_02", love: "exp_06", fear: "exp_07" },
  shizuku: { neutral: null, happy: "f01",    love: "f02",    fear: "f04"    },
};
function moodExprOf(modelUrl: string, mood: MateMood): string | null {
  const key = Object.keys(MODEL_EXPR).find((k) => modelUrl.toLowerCase().includes(k)) ?? "mao";
  return MODEL_EXPR[key]![mood];
}

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

/* 启动预热：应用空闲 1.5s 后预载双 core（不与首屏关键资源争抢），挂件首开即载即演 */
if (typeof window !== "undefined") {
  window.setTimeout(() => { void ensureCore().catch(() => undefined); }, 1500);
}

export function MateLive2D({ size, mood = "neutral", gesture = null, modelUrl = "/live2d/mao/Mao.model3.json", frame = "bust", onReady }: {
  size: number;
  mood?: MateMood;
  gesture?: MateGesture;
  /** 模型 .model.json 路径（客户/行业版可换自制模型） */
  modelUrl?: string;
  /** 取景：bust 头肩胸（挂件默认）；full 全身像完整入镜（首装欢迎仪式舞台位） */
  frame?: "bust" | "full";
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
    let offMouse: (() => void) | null = null;
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
      // 构图：bust=头肩胸取景——模型向下多探，让脸部占据视窗上中部（shizuku 为带课桌全身模型）；
      //      full=全身像——整体缩放至视口 ~92%，脚底贴视口底部（首装仪式舞台位，完整入镜不裁切）
      if (frame === "full") {
        const s = (size / Math.max(model.width, model.height)) * 0.92;
        model.scale.set(s);
        model.x = size / 2;
        model.y = size * 0.985;
        model.anchor.set(0.5, 1);
      } else {
        const s = size / Math.max(model.width, model.height) * 2.0;
        model.scale.set(s);
        model.x = size / 2;
        model.y = size * 1.72;
        model.anchor.set(0.5, 1);
      }
      app.stage.addChild(model);

      // 常态 idle 呼吸循环 + 初始表情
      void model.motion("idle");
      const expr = moodExprOf(modelUrl, moodRef.current);
      if (expr) await model.expression(expr).catch(() => undefined);

      /* ================= 口型平滑引擎 =================
       * 驱动方只设「目标值」，引擎在 tick 内指数趋近：开口快（k=0.55）闭口慢（k=0.18），
       * 逐帧包络连续无跳变；说话结束回落 0.06 微张底噪（自然唇齿），end 归零。 */
      let mouthTarget = 0;
      let mouthCur = 0;
      let openUntil = 0;              // 开口保持截止（按字时值自动回落）
      let lastBoundaryAt = 0;
      let boundaryGap = 140;          // 逐字间隔估计（随 boundary 流自适应）
      const setParam = (k: string, v: number) => {
        try {
          (model.internalModel.coreModel as unknown as { setParamFloat: (p: string, x: number) => void })
            .setParamFloat(k, v);
        } catch { /* 静默 */ }
      };
      const setMouth = (v: number) => setParam("PARAM_MOUTH_OPEN_Y", v);
      // 嘴形参数探测（Cubism 3+ 才有 PARAM_MOUTH_FORM；shizuku 这类老模型没有则自动弃用）
      let formOK: boolean | null = null;
      const setMouthForm = (v: number) => {
        if (formOK === false) return;
        setParam("PARAM_MOUTH_FORM", v);
        if (formOK === null) {
          try {
            const got = (model.internalModel.coreModel as unknown as { getParamFloat?: (p: string) => number })
              .getParamFloat?.("PARAM_MOUTH_FORM");
            formOK = typeof got === "number" && Math.abs(got - v) < 0.02;
          } catch { formOK = false; }
        }
      };

      /* ================= 活跃信号 → 按需渲染 =================
       * 满帧条件：任一驱动事件近 2.6s 内发生；否则降 12fps 生态模式（角落常驻功耗） */
      let lastActive = performance.now();
      let ecoDiv = 0;
      const poke = () => { lastActive = performance.now(); };
      const isEco = (now: number) => now - lastActive > 2600;

      /* ================= 视线追随 + 自主游移 =================
       * 鼠标：window mousemove 节流 90ms → 归一化注视点；无鼠标 4s 后每 3.5~7s 随机游移。
       * tick 内 focusCur 以 0.06 惯性趋近目标（叠模型内部惯性，双层平滑）。capture 禁用。 */
      let focusTX = 0, focusTY = 0, focusCX = 0, focusCY = 0;
      let lastMouse = 0, nextWander = 0;
      if (!capture && typeof window !== "undefined") {
        let mThrottle = 0;
        const onMove = (e: MouseEvent) => {
          const now = performance.now();
          if (now - mThrottle < 90) return;
          mThrottle = now;
          lastMouse = now;
          const r = (app.view as HTMLCanvasElement).getBoundingClientRect();
          if (r.width === 0) return;
          focusTX = Math.max(-1, Math.min(1, ((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * 0.8));
          focusTY = Math.max(-1, Math.min(1, ((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * 0.8));
          poke();
        };
        window.addEventListener("mousemove", onMove, { passive: true });
        offMouse = () => window.removeEventListener("mousemove", onMove);
      }
      const applyFocus = (now: number) => {
        if (capture) return;
        if (now - lastMouse > 4000 && now > nextWander) {
          // 自主游移：小幅度随机注视点（垂直偏小，像偶尔走神/扫视）。
          // 注意：游移是「空闲装饰行为」，刻意不 poke()——否则它自己阻止 eco 降帧（已踩过）
          focusTX = (Math.random() * 2 - 1) * 0.45;
          focusTY = (Math.random() * 2 - 1) * 0.22;
          nextWander = now + 3500 + Math.random() * 3500;
        }
        const dx = focusTX - focusCX, dy = focusTY - focusCY;
        if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) {
          focusCX += dx * 0.06;
          focusCY += dy * 0.06;
          const r = (app.view as HTMLCanvasElement).getBoundingClientRect();
          if (r.width > 0) {
            try { model.focus(r.left + r.width / 2 + focusCX * r.width * 0.45, r.top + r.height / 2 + focusCY * r.height * 0.45); } catch { /* 静默 */ }
          }
        }
      };

      /* ---------- 口型驱动①：VoiceEngine 逐字 boundary → 开口度目标 ---------- */
      offLip = VoiceEngine.onLipSync((ev) => {
        if (ev.type === "start") {
          if (lipTimer.current) window.clearInterval(lipTimer.current);
          lastBoundaryAt = 0;
          poke();
        } else if (ev.type === "boundary") {
          const now = performance.now();
          if (lastBoundaryAt) boundaryGap = Math.max(70, Math.min(320, now - lastBoundaryAt));
          lastBoundaryAt = now;
          const ch = ev.text && typeof ev.charIndex === "number" ? ev.text.charAt(ev.charIndex) : "";
          mouthTarget = ch ? OPEN_OF_CHAR(ch) : 0.3 + Math.random() * 0.5;
          openUntil = now + boundaryGap * 0.85;   // 字时值 85% 后向底噪回落（连贯语流感）
          poke();
        } else {
          mouthTarget = 0;
          openUntil = 0;
          if (lipTimer.current) { window.clearInterval(lipTimer.current); lipTimer.current = null; }
          poke();
        }
      });

      /* ---------- 对外句柄（调试探针 + 验收驱动） ---------- */
      const handle: Live2DHandle = {
        setMood: (m) => {
          moodRef.current = m;
          const e = moodExprOf(modelUrl, m);
          if (e) void model.expression(e).catch(() => undefined);
          else void model.expression(null as unknown as string).catch(() => undefined);
          poke();
        },
        gesture: (g) => {
          if (g === "handup" || g === "thumbup") void model.motion("tap_body").catch(() => undefined);
          poke();
        },
        speakWithAudio: (url) => {
          /* 口型驱动②：音频文件 —— RMS 振幅 → 开口度目标；频带能量比 → 嘴形（若模型支持）。
           * 低频占比高偏圆唇(o/u)，中高频占比高偏展唇(a/i)。 */
          void (async () => {
            try {
              const audio = new Audio(url);
              const ctx = new AudioContext();
              const src = ctx.createMediaElementSource(audio);
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 512;
              analyser.smoothingTimeConstant = 0.45;
              src.connect(analyser);
              analyser.connect(ctx.destination);
              const tbuf = new Uint8Array(analyser.frequencyBinCount);
              const fbuf = new Uint8Array(analyser.frequencyBinCount);
              const binHz = (ctx.sampleRate / 2) / analyser.frequencyBinCount;
              let alive = true;
              audio.onended = () => { alive = false; mouthTarget = 0; openUntil = 0; void ctx.close(); };
              const loop = () => {
                if (!alive) return;
                analyser.getByteTimeDomainData(tbuf);
                let sum = 0;
                for (const v of tbuf) sum += (v - 128) * (v - 128);
                const rms = Math.sqrt(sum / tbuf.length) / 128;
                mouthTarget = Math.min(1, rms * 3.2);
                openUntil = performance.now() + 120;   // 振幅流持续刷新开口窗口
                if (formOK !== false) {
                  analyser.getByteFrequencyData(fbuf);
                  let lo = 0, hi = 0, ln = 0, hn = 0;
                  for (let i = 1; i < fbuf.length; i++) {
                    const hz = i * binHz;
                    const fv = fbuf[i] ?? 0;
                    if (hz < 850) { lo += fv; ln++; }
                    else if (hz < 4200) { hi += fv; hn++; }
                  }
                  const tot = lo / Math.max(1, ln) + hi / Math.max(1, hn);
                  if (tot > 26) {  // 有语音能量才调嘴形，静音不漂
                    const ratio = (lo / Math.max(1, ln)) / tot;   // 低频占比 0~1
                    setMouthForm(Math.max(-1, Math.min(1, ratio * 2 - 0.85)));
                  }
                }
                poke();
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

      /* ---------- 时钟：capture=虚拟步进；常态=rAF（按需渲染+生态降帧） ---------- */
      if (capture) {
        // 路线 B：虚拟时钟——口型/动作/物理全部按 dt 推进，与墙钟解耦（契约不动）
        let virtualT = 0;
        let speakUntil = -1;
        (window as unknown as { __loommateSay?: (sec: number) => void }).__loommateSay = (sec: number) => {
          speakUntil = virtualT + sec;
        };
        window.__loommateStep = (dt: number) => {
          virtualT += dt;
          if (virtualT < speakUntil) {
            // 说话节律：双频叠加近似自然开合（非机械正弦）
            const v = Math.abs(Math.sin(virtualT * 8.3)) * 0.45 + Math.abs(Math.sin(virtualT * 13.7)) * 0.2 + 0.1;
            setMouth(Math.min(1, v));
          } else {
            setMouth(0);
          }
          model.update(dt * 1000);
          app.render();
        };
        app.render();
      } else {
        const tick = (now: number) => {
          if (disposed) return;
          const dt = Math.min(100, now - last);
          last = now;
          // 口型平滑：快开慢收指数趋近
          if (now > openUntil && mouthTarget > 0.06) mouthTarget = 0.06;
          const k = mouthTarget > mouthCur ? 0.55 : 0.18;
          mouthCur += (mouthTarget - mouthCur) * k;
          if (Math.abs(mouthCur - mouthTarget) < 0.004) mouthCur = mouthTarget;
          setMouth(mouthCur);
          // 视线（含自主游移）
          applyFocus(now);
          // 按需渲染：活跃满帧；生态模式 5 帧走 1 帧（≈12fps）
          if (isEco(now)) {
            if (++ecoDiv % 5 !== 0) { raf = requestAnimationFrame(tick); return; }
          } else {
            ecoDiv = 0;
          }
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
      offMouse?.();
      if (lipTimer.current) window.clearInterval(lipTimer.current);
      window.__loommateLive2DReady = undefined;
      window.__loommateStep = undefined;
      try { appRef.current?.destroy(true, { children: true }); } catch { /* 静默 */ }
      appRef.current = null;
      modelRef.current = null;
    };
  }, [size, modelUrl, frame, onReady]);

  // mood 联动
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    const e = moodExprOf(modelUrl, mood);
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
