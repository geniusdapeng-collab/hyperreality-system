/**
 * 本机克隆音色 · 客户端播放器（小织/织伴的默认音色）
 *
 * 链路：客户端 → 本机服务端 `/api/voice/speech`（代理配音工位）→ 工位合成/命中缓存 → wav → 这里播放。
 *
 * 三条纪律：
 * 1. **失败即回落，不是静默失败**：任何一步不成立（未配置 / 503 / 解码失败 / 无 AudioContext）都返回 `false`，
 *    调用方（VoiceEngine）继续走系统 speechSynthesis —— 宁可换声线，也不能让播报消失。
 * 2. **口型照样驱动**：系统语音靠 `onboundary` 驱动口型，克隆音色没有这个事件；
 *    这里用 AnalyserNode 的能量包络按时间推进，回调 `onProgress(0–1)`，让 Live2D 有嘴型节奏。
 * 3. **不碰声纹**：客户端只发文本与 profile 名，音频由本机服务端从工位取；参考音频永不出工位。
 */

export interface NeuralVoiceConfig {
  enabled: boolean;
  endpoint: string;
  profile: string;
}

export interface NeuralVoiceCallbacks {
  onStart?: () => void;
  /** 0–1 的播放进度（用于估算口型） */
  onProgress?: (ratio: number) => void;
  onEnd?: () => void;
}

type EnvLike = Record<string, string | boolean | undefined>;

/** 读取构建期配置（Vite 注入 import.meta.env；测试可直接传对象） */
export function neuralVoiceConfig(env: EnvLike = (import.meta as unknown as { env?: EnvLike }).env ?? {}): NeuralVoiceConfig {
  const enabled = String(env.VITE_WORKLOOM_NEURAL_VOICE ?? "1") !== "0";
  const endpoint = String(env.VITE_WORKLOOM_VOICE_ENDPOINT ?? "/api/voice/speech");
  const profile = String(env.VITE_WORKLOOM_VOICE_PROFILE ?? "zh-myvoice").trim() || "zh-myvoice";
  return { enabled, endpoint, profile };
}

export function neuralSpeechUrl(text: string, config: NeuralVoiceConfig = neuralVoiceConfig(), profile?: string): string {
  const params = new URLSearchParams({ text, profile: profile ?? config.profile });
  return `${config.endpoint}?${params.toString()}`;
}

/** 默认走本机克隆音色的角色：织伴（小织）。其它数字员工保持各自的系统音色，避免"全员一个声"。 */
export const NEURAL_VOICE_ROLES: readonly string[] = ["loommate"];
const NEURAL_PERSONA_RE = /织伴|小织/;

/**
 * 这个角色/人设是否该用本机克隆音色。
 * - 角色显式声明 `neural: true` → 用；`neural: false` → 不用（可整角色关掉）；
 * - 缺省规则：织伴（role=loommate，或人设名含「织伴/小织」）用克隆音色，其余角色不变。
 */
export function wantsNeuralVoice(
  role: string,
  persona: string,
  options: { neural?: boolean } = {},
): boolean {
  if (options.neural === false) return false;
  if (options.neural === true) return true;
  const normalized = role.trim().toLowerCase();
  if (NEURAL_VOICE_ROLES.includes(normalized)) return true;
  return NEURAL_PERSONA_RE.test(persona ?? "");
}

/**
 * 能力探测（每页一次）：先问 `/api/voice/status`，把结果缓存在内存里。
 *
 * 为什么必须"先探测再使用"：如果每句话都先去试一次网络，工位没起时每句话都要等一次失败往返，
 * 播报会被推迟（单消费者队列的时序契约也会被打破）。探测成功后走克隆音色；失败/未探测到 → 系统语音。
 */
let availability: "unknown" | "available" | "unavailable" = "unknown";
let probeInFlight: Promise<boolean> | null = null;

export function neuralVoiceAvailable(): boolean {
  return availability === "available";
}

export function resetNeuralVoiceProbe(): void {
  availability = "unknown";
  probeInFlight = null;
}

export async function probeNeuralVoice(deps: { fetchImpl?: typeof fetch; config?: NeuralVoiceConfig } = {}): Promise<boolean> {
  const config = deps.config ?? neuralVoiceConfig();
  if (!config.enabled) {
    availability = "unavailable";
    return false;
  }
  if (availability !== "unknown") return availability === "available";
  if (probeInFlight) return await probeInFlight;
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) {
    availability = "unavailable";
    return false;
  }
  probeInFlight = (async () => {
    try {
      const response = await fetchImpl("/api/voice/status", { headers: { accept: "application/json" } });
      const payload = (await response.json().catch(() => null)) as { enabled?: boolean; configured?: boolean } | null;
      const usable = response.ok && payload?.enabled !== false && payload?.configured === true;
      availability = usable ? "available" : "unavailable";
    } catch {
      availability = "unavailable";
    } finally {
      probeInFlight = null;
    }
    return availability === "available";
  })();
  return await probeInFlight;
}

interface PlayDeps {
  fetchImpl?: typeof fetch;
  audioContextFactory?: () => AudioContext | null;
  config?: NeuralVoiceConfig;
}

function defaultAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/**
 * 播放一段克隆音色播报。
 * @returns true = 已播放（调用方不要再走系统语音）；false = 不可用（调用方回落系统语音）
 */
export async function playNeuralSpeech(
  text: string,
  callbacks: NeuralVoiceCallbacks = {},
  deps: PlayDeps = {},
): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return false;
  const config = deps.config ?? neuralVoiceConfig();
  if (!config.enabled) return false;
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) return false;

  let bytes: ArrayBuffer;
  try {
    const response = await fetchImpl(neuralSpeechUrl(clean, config), { headers: { accept: "audio/wav" } });
    if (!response.ok) return false;
    bytes = await response.arrayBuffer();
    if (bytes.byteLength < 512) return false;
  } catch {
    return false;
  }

  const ctx = (deps.audioContextFactory ?? defaultAudioContext)();
  if (!ctx) return false;

  try {
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(ctx.destination);

    return await new Promise<boolean>((resolve) => {
      let finished = false;
      let raf = 0;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const durationMs = Math.max(300, buffer.duration * 1000);
      const startedAt = performance.now();
      const tick = () => {
        if (finished) return;
        analyser.getByteFrequencyData(data);
        const energy = data.reduce((sum, value) => sum + value, 0) / (data.length * 255);
        const ratio = Math.min(1, (performance.now() - startedAt) / durationMs);
        callbacks.onProgress?.(ratio);
        void energy;
        raf = requestAnimationFrame(tick);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        if (raf) cancelAnimationFrame(raf);
        callbacks.onProgress?.(1);
        callbacks.onEnd?.();
        resolve(true);
      };
      source.onended = finish;
      // 兜底：某些环境下 onended 不触发
      setTimeout(finish, durationMs + 1500);
      callbacks.onStart?.();
      tick();
      try {
        source.start();
      } catch {
        finish();
      }
    });
  } catch {
    // 解码失败/设备异常：回落系统语音
    return false;
  }
}
