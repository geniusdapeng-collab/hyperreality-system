import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceEngineImpl, type Utterance } from "./VoiceEngine";

class FakeUtterance {
  lang = "";
  pitch = 1;
  rate = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onboundary: ((event: { charIndex: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const line = (text: string, role = "loommate"): Utterance => ({
  role, persona: role, text, priority: "ceremony",
});

describe("VoiceEngine single-consumer orchestration", () => {
  let active = 0;
  let maxActive = 0;
  let starts: string[] = [];
  let usedVoices: unknown[] = [];
  let voiceList: Array<{ name: string; lang: string }> = [];
  const synth = {
    getVoices: () => voiceList,
    cancel: vi.fn(),
    speak: (utterance: FakeUtterance) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(utterance.text);
      usedVoices.push(utterance.voice);
      utterance.onstart?.();
      setTimeout(() => {
        active -= 1;
        utterance.onend?.();
      }, 100);
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    active = 0; maxActive = 0; starts = []; usedVoices = []; voiceList = [];
    synth.cancel.mockClear();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { speechSynthesis: synth, setTimeout, clearTimeout },
    });
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeUtterance,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "SpeechSynthesisUtterance");
  });

  it("does not start the next sentence before the previous onend", async () => {
    const engine = new VoiceEngineImpl();
    const first = engine.speakAndWait(line("第一句完整说完"));
    const second = engine.speakAndWait(line("第二句随后开始"));
    expect(starts).toEqual(["第一句完整说完"]);
    await vi.advanceTimersByTimeAsync(99);
    expect(starts).toEqual(["第一句完整说完"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual(["第一句完整说完", "第二句随后开始"]);
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBe("spoken");
    await expect(second).resolves.toBe("spoken");
    expect(maxActive).toBe(1);
  });

  it("keeps background ceremony out of an exclusive welcome session", async () => {
    const engine = new VoiceEngineImpl();
    const release = engine.acquireExclusive("loommate");
    const background = engine.speakAndWait(line("后台晨报", "company-ceo"));
    await expect(background).resolves.toBe("skipped");
    expect(starts).toEqual([]);
    release();
    const welcome = engine.speakAndWait(line("织伴开场"));
    await vi.advanceTimersByTimeAsync(100);
    await expect(welcome).resolves.toBe("spoken");
  });

  it("pins loomMate to the same preferred Chinese female voice for every segment", async () => {
    const male = { name: "Li-mu", lang: "zh-CN" };
    const female = { name: "Ting-Ting", lang: "zh-CN" };
    voiceList = [male, female];
    const engine = new VoiceEngineImpl();
    const voiceOverride = { pitch: 1.04, rate: .94, female: true, preferredNames: ["Ting-Ting"] };
    const one = engine.speakAndWait({ ...line("第一段"), voiceOverride });
    const two = engine.speakAndWait({ ...line("第二段"), voiceOverride });
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([one, two]);
    expect(usedVoices).toEqual([female, female]);
  });

  it("does not change speaker mid-session when the browser voice list arrives late", async () => {
    const engine = new VoiceEngineImpl();
    const one = engine.speakAndWait(line("列表未就绪"));
    await vi.advanceTimersByTimeAsync(100);
    await one;
    voiceList = [{ name: "Tingting", lang: "zh-CN" }];
    const two = engine.speakAndWait(line("列表已就绪"));
    await vi.advanceTimersByTimeAsync(100);
    await two;
    expect(usedVoices).toEqual([null, null]);
    expect(engine.voiceDiagnostics.loommate).toBe("system-default-locked");
  });
});
