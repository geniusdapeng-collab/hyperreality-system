/**
 * 本机克隆音色客户端单测：配置解析、URL 构造、角色规则、以及"任何一环不成立都返回 false 交给系统语音兜底"。
 * 不依赖真实 AudioContext（未注入时直接返回 false，正是浏览器之外的正常路径）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NEURAL_VOICE_ROLES,
  neuralSpeechUrl,
  neuralVoiceAvailable,
  neuralVoiceConfig,
  playNeuralSpeech,
  probeNeuralVoice,
  resetNeuralVoiceProbe,
  wantsNeuralVoice,
} from "./neuralVoice";

describe("配置与 URL", () => {
  it("默认开、默认 profile=zh-myvoice、默认端点 /api/voice/speech", () => {
    const cfg = neuralVoiceConfig({});
    expect(cfg).toEqual({ enabled: true, endpoint: "/api/voice/speech", profile: "zh-myvoice" });
  });

  it("VITE_WORKLOOM_NEURAL_VOICE=0 时整体关闭（回落系统语音）", () => {
    expect(neuralVoiceConfig({ VITE_WORKLOOM_NEURAL_VOICE: "0" }).enabled).toBe(false);
  });

  it("URL 带 text 与 profile，中文正确编码", () => {
    const url = neuralSpeechUrl("你好，小织", neuralVoiceConfig({ VITE_WORKLOOM_VOICE_PROFILE: "zh-boss" }));
    expect(url.startsWith("/api/voice/speech?")).toBe(true);
    expect(url).toContain("profile=zh-boss");
    expect(url).toContain(encodeURIComponent("你好，小织"));
  });
});

describe("角色规则：只有小织/织伴默认走克隆音色", () => {
  it("role=loommate 或人设含「织伴/小织」→ 用克隆音色", () => {
    expect(NEURAL_VOICE_ROLES).toContain("loommate");
    expect(wantsNeuralVoice("loommate", "织伴", {})).toBe(true);
    expect(wantsNeuralVoice("assistant", "小织", {})).toBe(true);
    expect(wantsNeuralVoice("LOOMMATE", "", {})).toBe(true);
  });

  it("其它数字员工保持系统音色（避免全员一个声）", () => {
    expect(wantsNeuralVoice("hotel-manager", "酒店经理", {})).toBe(false);
    expect(wantsNeuralVoice("release-guardian", "发布守护", {})).toBe(false);
  });

  it("显式开关优先：neural=false 关掉、neural=true 强制", () => {
    expect(wantsNeuralVoice("loommate", "织伴", { neural: false })).toBe(false);
    expect(wantsNeuralVoice("hotel-manager", "酒店经理", { neural: true })).toBe(true);
  });
});

describe("播放失败一律回落（返回 false），不抛异常", () => {
  it("关闭开关时不发请求", async () => {
    const fetchImpl = vi.fn();
    const played = await playNeuralSpeech("你好", {}, {
      config: { enabled: false, endpoint: "/api/voice/speech", profile: "zh-myvoice" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(played).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("服务端 503（工位不可达）→ false", async () => {
    const played = await playNeuralSpeech("你好", {}, {
      fetchImpl: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
    });
    expect(played).toBe(false);
  });

  it("网络异常 → false", async () => {
    const played = await playNeuralSpeech("你好", {}, {
      fetchImpl: (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    });
    expect(played).toBe(false);
  });

  it("拿到音频但没有 AudioContext（非浏览器环境）→ false", async () => {
    const played = await playNeuralSpeech("你好", {}, {
      fetchImpl: (async () => new Response(new Uint8Array(2048), { status: 200 })) as unknown as typeof fetch,
      audioContextFactory: () => null,
    });
    expect(played).toBe(false);
  });

  it("空文本直接 false", async () => {
    expect(await playNeuralSpeech("   ")).toBe(false);
  });
});

describe("能力探测：探到了才走克隆音色（避免每句话都等一次失败往返）", () => {
  afterEach(() => resetNeuralVoiceProbe());

  it("status 显示 enabled+configured → 可用", async () => {
    resetNeuralVoiceProbe();
    expect(neuralVoiceAvailable()).toBe(false);
    const ok = await probeNeuralVoice({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ enabled: true, configured: true }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(neuralVoiceAvailable()).toBe(true);
  });

  it("工位未配置（configured=false）→ 不可用，播报回落系统语音", async () => {
    resetNeuralVoiceProbe();
    const ok = await probeNeuralVoice({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ enabled: true, configured: false }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(neuralVoiceAvailable()).toBe(false);
  });

  it("服务端 503 → 不可用", async () => {
    resetNeuralVoiceProbe();
    const ok = await probeNeuralVoice({
      fetchImpl: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  it("探测结果缓存：只探一次（第二次直接用缓存）", async () => {
    resetNeuralVoiceProbe();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ enabled: true, configured: true }), { status: 200 }));
    await probeNeuralVoice({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await probeNeuralVoice({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
