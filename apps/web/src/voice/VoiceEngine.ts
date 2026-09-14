/**
 * VoiceEngine · 语音播报（端侧 speechSynthesis，零网络零密钥）
 *
 *  - 角色音色参数表（确定性中文 voice + 温和 pitch/rate）；
 *  - 优先级队列：fuse（熔断，立即打断）> ask（请示）> ceremony（仪式）> ambient；
 *  - 降级：speechSynthesis 不可用/无语音 → available=false，仅走字幕（SubBus）。
 *  - 字幕事件总线（SubBus）：所有播报（含仅字幕模式）同步发字幕，新闻台字幕条消费。
 */
import { AudioEngine } from "../audio/AudioEngine";

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

/** 角色音色预设：pitch 0.6~1.4，rate 0.75~1.2 */
export const VOICE_PRESETS: Record<string, VoiceProfile> = {
  "company-ceo": { pitch: 0.75, rate: 0.85 },
  "competitor-agent": { pitch: 1.15, rate: 1.08, female: true },
  "content-agent": { pitch: 1.1, rate: 0.95, female: true },
  "pricing-agent": { pitch: 0.9, rate: 0.98 },
  "reconcile-agent": { pitch: 0.7, rate: 0.88 },
  "inspection-agent": { pitch: 0.85, rate: 0.92 },
  "review-agent": { pitch: 1.2, rate: 1.0, female: true },
  "desktop-agent": { pitch: 1.0, rate: 1.1 },
  // —— AI 产品经理团队 ——
  "chief-pm": { pitch: 0.9, rate: 0.92 },
  "model-scout": { pitch: 1.0, rate: 1.0 },
  "eval-master": { pitch: 0.95, rate: 0.95 },
  "prompt-curator": { pitch: 1.0, rate: 1.0 },
  "red-teamer": { pitch: 0.9, rate: 1.0 },
  "knowledge-curator": { pitch: 1.05, rate: 0.95, female: true },
  "requirement-analyst": { pitch: 1.0, rate: 1.0 },
  "competitor-scout": { pitch: 1.1, rate: 1.05 },
  "data-insight": { pitch: 0.95, rate: 0.95 },
  "user-listener": { pitch: 1.1, rate: 1.0, female: true },
  "doc-writer": { pitch: 1.0, rate: 0.98 },
  "industry-radar": { pitch: 1.05, rate: 1.02 },
  "release-guardian": { pitch: 0.9, rate: 0.9 },
  "frontdesk-agent": { pitch: 1.12, rate: 1.02, female: true },
  "housekeeper-agent": { pitch: 1.05, rate: 0.96, female: true },
  "phone-agent": { pitch: 1.15, rate: 1.05, female: true },
  "owner-cockpit": { pitch: 0.8, rate: 0.9 },
};
const DEFAULT_PRESET: VoiceProfile = { pitch: 1.0, rate: 0.96 };

// macOS / Windows 常见中文系统音色。这里只用于性别与稳定性排序，不依赖某台机器
// 必须安装其中某一个；匹配不到时仍固定回落到同一个中文 voice。
const FEMALE_VOICE_RE = /female|flo|sandy|shelley|ting[- ]?ting|tingting|mei[- ]?jia|sin[- ]?ji|xiaoxiao|xiaoyi|yunxia|huihui|yaoyao|lily|xiaobei|晓晓|晓伊|婷婷|美佳|善怡/i;
const MALE_VOICE_RE = /male|eddy|reed|rocko|li[- ]?mu|yunxi|yunjian|yunyang|xiaoyu|云希|云健|云扬|晓宇|李沐/i;

type CaptionListener = (c: Caption) => void;

export class VoiceEngineImpl {
  private queue: QueuedUtterance[] = [];
  private speaking = false;
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
    const preferred = profile.preferredNames
      ?.map((name) => zh.find((v) => v.name.toLowerCase().includes(name.toLowerCase())))
      .find(Boolean);
    const gendered = profile.female
      ? zh.find((v) => FEMALE_VOICE_RE.test(v.name))
      : zh.find((v) => MALE_VOICE_RE.test(v.name));
    const chosen = preferred ?? gendered ?? zh[0] ?? null;
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
      const preset = next.voiceOverride ?? VOICE_PRESETS[next.role] ?? DEFAULT_PRESET;
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
}

export const VoiceEngine = new VoiceEngineImpl();
