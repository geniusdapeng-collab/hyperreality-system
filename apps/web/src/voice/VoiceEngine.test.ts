import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEGRADED_VOICE_RE, VoiceEngineImpl, rankZhVoices, selectVoice, type Utterance } from "./VoiceEngine";

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

  /**
   * 2026-09-18 实测（macOS + Electron 44）：zh-CN 下 Eddy/Reed/Flo 一族能出声但 **0 次 boundary**，
   * 而 婷婷 15 次 / Li-Mu 13 次。基座口型同步（MateLive2D / onLipSync）依赖 boundary，
   * 因此这组音色必须降级为兜底，不能作为首选。
   */
  describe("中文音色可用性排序（口型同步的前提）", () => {
    const machineVoices = [
      { name: "Eddy (中文（中国大陆）)", lang: "zh-CN" },
      { name: "Reed (中文（中国大陆）)", lang: "zh-CN" },
      { name: "Flo (中文（中国大陆）)", lang: "zh-CN" },
      { name: "Li-Mu", lang: "zh-CN" },
      { name: "婷婷", lang: "zh-CN" },
      { name: "美嘉", lang: "zh-CN" },
      { name: "Eddy (德语（德国）)", lang: "de-DE" },
    ];

    it("新奇音色被识别并垫底，正常中文音色排前", () => {
      expect(DEGRADED_VOICE_RE.test("Eddy (中文（中国大陆）)")).toBe(true);
      expect(DEGRADED_VOICE_RE.test("婷婷")).toBe(false);
      const ranked = rankZhVoices(machineVoices.filter((v) => v.lang === "zh-CN"));
      const firstDegraded = ranked.findIndex((v) => DEGRADED_VOICE_RE.test(v.name));
      const lastUsable = ranked.map((v) => DEGRADED_VOICE_RE.test(v.name)).lastIndexOf(false);
      expect(firstDegraded).toBeGreaterThan(lastUsable);
    });

    it("男声偏好落到可用男声 Li-Mu，而不是无 boundary 的 Eddy", () => {
      const chosen = selectVoice(machineVoices, {
        pitch: 0.92, rate: 0.98,
        preferredNames: ["Eddy", "Reed", "Yunxi", "李沐", "Li-Mu"],
      });
      expect(chosen?.name).toBe("Li-Mu");
      expect(DEGRADED_VOICE_RE.test(chosen?.name ?? "")).toBe(false);
    });

    it("女声偏好落到可用女声，而不是无 boundary 的 Flo", () => {
      const chosen = selectVoice(machineVoices, {
        pitch: 1.04, rate: 0.94, female: true,
        preferredNames: ["Flo", "Tingting", "Meijia", "婷婷", "美嘉"],
      });
      expect(["婷婷", "美嘉"]).toContain(chosen?.name);
      expect(DEGRADED_VOICE_RE.test(chosen?.name ?? "")).toBe(false);
    });

    it("只有新奇音色可用时才兜底使用，且不跨语言误选", () => {
      const only = [{ name: "Eddy (中文（中国大陆）)", lang: "zh-CN" }, { name: "Eddy (德语（德国）)", lang: "de-DE" }];
      expect(selectVoice(only, { pitch: 1, rate: 1 })?.name).toBe("Eddy (中文（中国大陆）)");
      expect(selectVoice([{ name: "Anna", lang: "de-DE" }], { pitch: 1, rate: 1 })).toBeNull();
    });
  });
});
