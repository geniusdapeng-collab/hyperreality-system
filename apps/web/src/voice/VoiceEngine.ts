/**
 * VoiceEngine · 语音播报（端侧 speechSynthesis，零网络零密钥）
 *
 *  - Bundle 可显式覆盖音色；缺省按角色标识稳定散列到通用中文音色；
 *  - 优先级队列：fuse（熔断，立即打断）> ask（请示）> ceremony（仪式）> ambient；
 *  - 降级：speechSynthesis 不可用/无语音 → available=false，仅走字幕（SubBus）。
 *  - 字幕事件总线（SubBus）：所有播报（含仅字幕模式）同步发字幕，新闻台字幕条消费。
 */
import { AudioEngine } from "../audio/AudioEngine";
import { neuralVoiceAvailable, neuralVoiceConfig, playNeuralSpeech, probeNeuralVoice, wantsNeuralVoice } from "./neuralVoice";

export type VoicePriority = "fuse" | "ask" | "ceremony" | "ambient";
export type VoiceGate = "ritual-only" | "all" | "captions";

export interface Utterance {
  role: string;
  persona: string;
  text: string;
  priority: VoicePriority;
  /** 音色覆盖（织伴等自定义音色场景；缺省走 role 预设） */
  voiceOverride?: VoiceProfile;
}

export interface VoiceProfile {
  pitch: number;
  rate: number;
  female?: boolean;
  /** 按顺序锁定系统音色；用于固定人物声线，禁止段落间换人。 */
  preferredNames?: string[];
  /** 是否使用本机克隆音色：true=强制、false=禁用、undefined=按角色默认（织伴用） */
  neural?: boolean;
  /** 克隆音色档案名（配音工位 profiles/<name>）；缺省用构建期 VITE_WORKLOOM_VOICE_PROFILE */
  neuralProfile?: string;
}

export interface Caption {
  id: number;
  persona: string;
  role: string;
  text: string;
  /** 预计展示毫秒（按 4.5 字/秒估算，下限 2.2s） */
  ttl: number;
  priority: VoicePriority;
}

export type VoicePlaybackResult = "spoken" | "skipped" | "cancelled";

interface QueuedUtterance {
  utterance: Utterance;
  resolve?: (result: VoicePlaybackResult) => void;
  settled?: boolean;
}

const DEFAULT_PRESET: VoiceProfile = { pitch: 1.0, rate: 0.96 };

/** 行业无关的稳定音色 fallback；角色专属音色应由 Bundle 投影显式传入 voiceOverride。 */
export function voiceProfileForRole(role: string): VoiceProfile {
  if (!role.trim()) return DEFAULT_PRESET;
  let hash = 2166136261;
  for (const ch of role) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const n = hash >>> 0;
  return {
    pitch: Number((0.9 + (n % 21) / 100).toFixed(2)),
    rate: Number((0.92 + ((n >>> 5) % 13) / 100).toFixed(2)),
    female: ((n >>> 9) & 1) === 1,
  };
}

// macOS / Windows 常见中文系统音色。这里只用于性别与稳定性排序，不依赖某台机器
// 必须安装其中某一个；匹配不到时仍固定回落到同一个中文 voice。
const FEMALE_VOICE_RE = /female|flo|sandy|shelley|ting[- ]?ting|tingting|mei[- ]?jia|sin[- ]?ji|xiaoxiao|xiaoyi|yunxia|huihui|yaoyao|lily|xiaobei|晓晓|晓伊|婷婷|美佳|善怡/i;
const MALE_VOICE_RE = /male|eddy|reed|rocko|li[- ]?mu|yunxi|yunjian|yunyang|xiaoyu|云希|云健|云扬|晓宇|李沐/i;

/**
 * macOS「新奇音色」一族（Eddy/Reed/Flo/Sandy/Shelley/Rocko/Grandma/Grandpa）。
 *
 * 实测（2026-09-18，macOS + Electron 44 真实壳）：这组音色在 zh-CN 下**能出声但不发
 * `onboundary` 事件**（同一句中文：它们 0 次 boundary，而 婷婷 15 次 / Li-Mu 13 次）。
 * 基座的口型同步链路正是靠 boundary 的 charIndex 驱动（MateLive2D / VoiceEngine.onLipSync），
 * 于是“看起来在说话、嘴却不动”。因此把它们降级为最后兜底：只有在没有任何正常中文音色时才用。
 */
export const DEGRADED_VOICE_RE = /^(eddy|reed|flo|sandy|shelley|rocko|grandma|grandpa)\b/i;

/** 把中文音色按“可用性”重排：正常音色在前，新奇音色垫底（保持原有 zh-CN 优先次序，稳定排序）。 */
export function rankZhVoices<T extends { name: string }>(zh: readonly T[]): T[] {
  return [...zh].sort((a, b) => Number(DEGRADED_VOICE_RE.test(a.name)) - Number(DEGRADED_VOICE_RE.test(b.name)));
}

export interface VoiceLike { name: string; lang: string }

/**
 * 纯函数：从系统音色列表里为某个角色挑音色（无缓存、无副作用，可单测）。
 * 规则：中文优先（zh-CN 在前）→ 只要存在正常中文音色就不用新奇音色 → 首选名 → 性别 → 兜底第一个。
 */
export function selectVoice<T extends VoiceLike>(voices: readonly T[], profile: VoiceProfile): T | null {
  const zh = voices
    .filter((v) => /zh|cmn|chinese/i.test(`${v.lang} ${v.name}`))
    .sort((a, b) => Number(!/^zh[-_]cn/i.test(a.lang)) - Number(!/^zh[-_]cn/i.test(b.lang)) || a.name.localeCompare(b.name));
  if (zh.length === 0) return null;
  const ranked = rankZhVoices(zh);
  const usable = ranked.filter((v) => !DEGRADED_VOICE_RE.test(v.name));
  const pool = usable.length > 0 ? usable : ranked;
  const preferred = profile.preferredNames
    ?.map((name) => pool.find((v) => v.name.toLowerCase().includes(name.toLowerCase())))
    .find(Boolean);
  const gendered = profile.female
    ? pool.find((v) => FEMALE_VOICE_RE.test(v.name))
    : pool.find((v) => MALE_VOICE_RE.test(v.name));
  return preferred ?? gendered ?? pool[0] ?? null;
}

type CaptionListener = (c: Caption) => void;

export class VoiceEngineImpl {
  private queue: QueuedUtterance[] = [];
  private speaking = false;

  constructor() {
    // 每页探测一次本机工位能力：探到了走克隆音色，探不到就走系统语音（探测本身不阻塞播报）
    void probeNeuralVoice();
  }
  private active: QueuedUtterance | null = null;
  private activeFinish: (() => void) | null = null;
  private generation = 0;
  private captionListeners = new Set<CaptionListener>();
  private captionSeq = 0;
  private exclusiveRole: string | null = null;
  private voiceCache = new Map<string, SpeechSynthesisVoice | null>();
  gate: VoiceGate = (typeof localStorage !== "undefined" && (localStorage.getItem("wl-voice-gate") as VoiceGate)) || "ritual-only";

  get tts(): SpeechSynthesis | null {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    return window.speechSynthesis;
  }
  get available(): boolean {
    return this.tts !== null && this.gate !== "captions";
  }

  get voiceDiagnostics(): Record<string, string> {
    return Object.fromEntries([...this.voiceCache].map(([role, voice]) => [role, voice ? `${voice.name} (${voice.lang})` : "system-default-locked"]));
  }

  setGate(gate: VoiceGate): void {
    this.gate = gate;
    try { localStorage.setItem("wl-voice-gate", gate); } catch { /* 静默 */ }
    if (gate === "captions") this.stopAll();
  }

  onCaption(fn: CaptionListener): () => void {
    this.captionListeners.add(fn);
    return () => this.captionListeners.delete(fn);
  }

  private emitCaption(u: Utterance): void {
    const ttl = Math.max(2200, Math.round((u.text.length / 4.5) * 1000));
    const cap: Caption = { id: ++this.captionSeq, persona: u.persona, role: u.role, text: u.text, ttl, priority: u.priority };
    for (const fn of this.captionListeners) { try { fn(cap); } catch { /* 静默 */ } }
  }

  private pickVoice(profile: VoiceProfile, role: string): SpeechSynthesisVoice | null {
    if (this.voiceCache.has(role)) return this.voiceCache.get(role) ?? null;
    const voices = this.tts?.getVoices() ?? [];
    const zh = voices
      .filter((v) => /zh|cmn|chinese/i.test(`${v.lang} ${v.name}`))
      .sort((a, b) => Number(!/^zh[-_]cn/i.test(a.lang)) - Number(!/^zh[-_]cn/i.test(b.lang)) || a.name.localeCompare(b.name));
    // 首次 voice 列表未就绪时也缓存 null：同一人物整场都使用系统默认声，
    // 不允许第二段突然换成另一位说话人。织伴在 2.4s 入场后才开口，正常机器
    // 此时列表已经可用；极端情况下宁可全程同一默认声，也不段落间变声。
    if (zh.length === 0) { this.voiceCache.set(role, null); return null; }
    const chosen = selectVoice(voices, profile) as SpeechSynthesisVoice | null;
    if (chosen) this.voiceCache.set(role, chosen);
    return chosen;
  }

  private settle(item: QueuedUtterance, result: VoicePlaybackResult): void {
    if (item.settled) return;
    item.settled = true;
    item.resolve?.(result);
  }

  private enqueue(u: Utterance, resolve?: QueuedUtterance["resolve"]): void {
    // 字幕永远发（字幕条是降级与可及性保底）
    this.emitCaption(u);
    const item: QueuedUtterance = { utterance: u, resolve };
    // 首装开场等独占叙事期间，后台晨报/环境事件只保留字幕，不能进入音频队列抢话。
    // fuse 仍保留安全语义，可明确中断任何播报。
    if (this.exclusiveRole && u.role !== this.exclusiveRole && u.priority !== "fuse") {
      this.settle(item, "skipped");
      return;
    }
    if (!this.available) { this.settle(item, "skipped"); return; }
    // 档位过滤：ritual-only 只放 fuse/ceremony
    if (this.gate === "ritual-only" && (u.priority === "ask" || u.priority === "ambient")) {
      this.settle(item, "skipped");
      return;
    }
    if (u.priority === "fuse") {
      this.stopAll();
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }
    void this.pump();
  }

  /** 播报（同时发字幕；语音按档位决定是否真出声） */
  speak(u: Utterance): void {
    this.enqueue(u);
  }

  /** 播报并等待真实结束；仪式编排用它避免按估算时长切段而抢话。 */
  speakAndWait(u: Utterance): Promise<VoicePlaybackResult> {
    return new Promise((resolve) => this.enqueue(u, resolve));
  }

  /** 获取独占播报会话；返回幂等释放函数。 */
  acquireExclusive(role: string): () => void {
    this.exclusiveRole = role;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.exclusiveRole === role) this.exclusiveRole = null;
    };
  }

  /* ---- 口型同步钩子（数字人驱动）：boundary/start/end 三事件 ---- */
  private lipListeners = new Set<(ev: { type: "start" | "boundary" | "end"; charIndex?: number; role?: string; text?: string }) => void>();
  onLipSync(cb: (ev: { type: "start" | "boundary" | "end"; charIndex?: number; role?: string; text?: string }) => void): () => void {
    this.lipListeners.add(cb);
    return () => this.lipListeners.delete(cb);
  }
  private emitLip(ev: { type: "start" | "boundary" | "end"; charIndex?: number; role?: string; text?: string }): void {
    for (const cb of this.lipListeners) { try { cb(ev); } catch { /* 静默 */ } }
  }

  stopAll(): void {
    this.generation += 1;
    const queued = this.queue.splice(0);
    for (const item of queued) this.settle(item, "cancelled");
    if (this.active) this.settle(this.active, "cancelled");
    this.active = null;
    this.speaking = false;
    const finish = this.activeFinish;
    this.activeFinish = null;
    try { this.tts?.cancel(); } catch { /* 静默 */ }
    AudioEngine.setSpeechActive(false);
    finish?.();
  }

  private async pump(): Promise<void> {
    if (this.speaking) return;
    const tts = this.tts;
    if (!tts) return;
    const item = this.queue.shift();
    if (!item) return;
    const next = item.utterance;
    const generation = this.generation;
    this.speaking = true;
    this.active = item;
    try {
      const preset = next.voiceOverride ?? voiceProfileForRole(next.role);
      // 小织/织伴：优先本机克隆音色（音色档案在工位本机，声纹不出域）；
      // 工位未配置/不可达/解码失败 → 返回 false，继续走下面的系统语音（宁可换声线，不让播报消失）。
      if (neuralVoiceAvailable() && wantsNeuralVoice(next.role, next.persona, { neural: preset.neural })) {
        const played = await this.speakNeural(next, preset);
        if (played) {
          this.settle(item, "spoken");
          this.active = null;
          this.speaking = false;
          if (this.queue.length > 0) void this.pump();
          return;
        }
      }
      const utt = new SpeechSynthesisUtterance(next.text);
      utt.lang = "zh-CN";
      utt.pitch = preset.pitch;
      utt.rate = preset.rate;
      const v = this.pickVoice(preset, next.role);
      if (v) utt.voice = v;
      await new Promise<void>((resolve) => {
        let done = false;
        let timeout = 0;
        const finish = () => {
          if (done) return;
          done = true;
          if (timeout) window.clearTimeout(timeout);
          if (this.activeFinish === finish) this.activeFinish = null;
          AudioEngine.setSpeechActive(false);
          resolve();
        };
        this.activeFinish = finish;
        utt.onstart = () => this.emitLip({ type: "start", role: next.role, text: next.text });
        utt.onboundary = (e: SpeechSynthesisEvent) => {
          this.emitLip({ type: "boundary", charIndex: e.charIndex ?? 0, role: next.role, text: next.text });
        };
        utt.onend = () => { this.emitLip({ type: "end", role: next.role }); finish(); };
        utt.onerror = () => { this.emitLip({ type: "end", role: next.role }); finish(); };
        // 超时兜底（部分平台 onend 不触发）
        timeout = window.setTimeout(() => { this.emitLip({ type: "end", role: next.role }); finish(); },
          Math.max(8000, next.text.length * 650));
        AudioEngine.setSpeechActive(true);
        tts.speak(utt);
      });
    } catch { /* 静默 */ }
    if (generation !== this.generation) return;
    this.settle(item, "spoken");
    this.active = null;
    this.speaking = false;
    if (this.queue.length > 0) void this.pump();
  }

  /** 播放本机克隆音色；口型由播放进度驱动（克隆音频没有 onboundary 事件）。 */
  private async speakNeural(u: Utterance, preset: VoiceProfile): Promise<boolean> {
    return await playNeuralSpeech(
      u.text,
      {
        onStart: () => {
          AudioEngine.setSpeechActive(true);
          this.emitLip({ type: "start", role: u.role, text: u.text });
        },
        onProgress: (ratio) => {
          this.emitLip({
            type: "boundary",
            charIndex: Math.max(0, Math.min(u.text.length, Math.floor(ratio * u.text.length))),
            role: u.role,
            text: u.text,
          });
        },
        onEnd: () => {
          AudioEngine.setSpeechActive(false);
          this.emitLip({ type: "end", role: u.role });
        },
      },
      preset.neuralProfile ? { config: { ...neuralVoiceConfig(), profile: preset.neuralProfile } } : {},
    );
  }
}

export const VoiceEngine = new VoiceEngineImpl();
