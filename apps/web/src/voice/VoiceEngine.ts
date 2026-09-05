/**
 * VoiceEngine · 语音播报（端侧 speechSynthesis，零网络零密钥）
 *
 *  - 角色音色参数表（pitch/rate + 中文 voice 启发式匹配）；
 *  - 优先级队列：fuse（熔断，立即打断）> ask（请示）> ceremony（仪式）> ambient；
 *  - 降级：speechSynthesis 不可用/无语音 → available=false，仅走字幕（SubBus）。
 *  - 字幕事件总线（SubBus）：所有播报（含仅字幕模式）同步发字幕，新闻台字幕条消费。
 */

export type VoicePriority = "fuse" | "ask" | "ceremony" | "ambient";
export type VoiceGate = "ritual-only" | "all" | "captions";

export interface Utterance {
  role: string;
  persona: string;
  text: string;
  priority: VoicePriority;
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

/** 角色音色预设：pitch 0.6~1.4，rate 0.75~1.2 */
export const VOICE_PRESETS: Record<string, { pitch: number; rate: number; female?: boolean }> = {
  "company-ceo": { pitch: 0.75, rate: 0.85 },
  "competitor-agent": { pitch: 1.15, rate: 1.08, female: true },
  "content-agent": { pitch: 1.1, rate: 0.95, female: true },
  "pricing-agent": { pitch: 0.9, rate: 0.98 },
  "reconcile-agent": { pitch: 0.7, rate: 0.88 },
  "inspection-agent": { pitch: 0.85, rate: 0.92 },
  "review-agent": { pitch: 1.2, rate: 1.0, female: true },
  "desktop-agent": { pitch: 1.0, rate: 1.1 },
  // —— AI 产品经理团队 ——
  "pm-staff-officer": { pitch: 0.9, rate: 0.92 },
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
const DEFAULT_PRESET: { pitch: number; rate: number; female?: boolean } = { pitch: 1.0, rate: 1.0 };

type CaptionListener = (c: Caption) => void;

class VoiceEngineImpl {
  private queue: Utterance[] = [];
  private speaking = false;
  private captionListeners = new Set<CaptionListener>();
  private captionSeq = 0;
  gate: VoiceGate = (typeof localStorage !== "undefined" && (localStorage.getItem("wl-voice-gate") as VoiceGate)) || "ritual-only";

  get tts(): SpeechSynthesis | null {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    return window.speechSynthesis;
  }
  get available(): boolean {
    return this.tts !== null && this.gate !== "captions";
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

  private pickVoice(female?: boolean): SpeechSynthesisVoice | null {
    const tts = this.tts;
    if (!tts) return null;
    const voices = tts.getVoices();
    const zh = voices.filter((v) => /zh|cmn|Chinese/i.test(v.lang + v.name));
    if (zh.length === 0) return null;
    // 启发式：名字含 Female/Xiaoxiao/Yun 等判女，否则判男
    const isF = (v: SpeechSynthesisVoice) => /female|xiaoxiao|xiaoyi|yunxia|huihui|yaoyao|ting|mei|lily/i.test(v.name);
    const pool = zh.filter((v) => (female ? isF(v) : !isF(v)));
    return pool[0] ?? zh[0] ?? null;
  }

  /** 播报（同时发字幕；语音按档位决定是否真出声） */
  speak(u: Utterance): void {
    // 字幕永远发（字幕条是降级与可及性保底）
    this.emitCaption(u);
    if (!this.available) return;
    // 档位过滤：ritual-only 只放 fuse/ceremony
    if (this.gate === "ritual-only" && (u.priority === "ask" || u.priority === "ambient")) return;
    if (u.priority === "fuse") {
      this.stopAll();
      this.queue.unshift(u);
    } else {
      this.queue.push(u);
    }
    void this.pump();
  }

  stopAll(): void {
    this.queue = [];
    this.speaking = false;
    try { this.tts?.cancel(); } catch { /* 静默 */ }
  }

  private async pump(): Promise<void> {
    if (this.speaking) return;
    const tts = this.tts;
    if (!tts) return;
    const next = this.queue.shift();
    if (!next) return;
    this.speaking = true;
    try {
      const preset = VOICE_PRESETS[next.role] ?? DEFAULT_PRESET;
      const utt = new SpeechSynthesisUtterance(next.text);
      utt.lang = "zh-CN";
      utt.pitch = preset.pitch;
      utt.rate = preset.rate;
      const v = this.pickVoice(preset.female);
      if (v) utt.voice = v;
      await new Promise<void>((resolve) => {
        utt.onend = () => resolve();
        utt.onerror = () => resolve();
        // 超时兜底（部分平台 onend 不触发）
        window.setTimeout(resolve, Math.max(4000, next.text.length * 350));
        tts.speak(utt);
      });
    } catch { /* 静默 */ }
    this.speaking = false;
    if (this.queue.length > 0) void this.pump();
  }
}

export const VoiceEngine = new VoiceEngineImpl();
