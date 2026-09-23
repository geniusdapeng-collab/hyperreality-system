/**
 * 本机克隆音色服务端适配单测（不连真工位：用假 fetch + 临时目录）。
 * 关注三件事：配置口径（默认 profile / 关闭开关 / 缺 token）、幂等缓存、失败一律结构化不假装成功。
 */
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { synthesizeVoice, voiceCacheFile, voiceCacheKey, voiceStationConfig } from "./station.js";

function tempConfig(overrides: Partial<ReturnType<typeof voiceStationConfig>> = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "voice-station-"));
  return { ...voiceStationConfig({} as NodeJS.ProcessEnv), token: "test-token", cacheDir, ...overrides };
}

describe("工位配置口径", () => {
  it("默认音色是 zh-myvoice，桥地址默认本机 9776，启用开关默认开", () => {
    const cfg = voiceStationConfig({} as NodeJS.ProcessEnv);
    expect(cfg.profile).toBe("zh-myvoice");
    expect(cfg.bridgeUrl).toBe("http://127.0.0.1:9776");
    expect(cfg.enabled).toBe(true);
    expect(cfg.cacheDir.endsWith(join("deliveries", "voice-cache"))).toBe(true);
  });

  it("环境变量可覆盖：profile / 关闭开关 / 桥地址去尾斜杠", () => {
    const cfg = voiceStationConfig({
      WORKLOOM_VOICE_PROFILE: "zh-hotel-boss",
      WORKLOOM_VOICE_ENABLED: "0",
      WORKLOOM_VOICE_BRIDGE_URL: "http://127.0.0.1:9877/",
    } as NodeJS.ProcessEnv);
    expect(cfg.profile).toBe("zh-hotel-boss");
    expect(cfg.enabled).toBe(false);
    expect(cfg.bridgeUrl).toBe("http://127.0.0.1:9877");
  });

  it("缓存键只由 profile+文本决定（同输入同文件，可幂等复用）", () => {
    expect(voiceCacheKey("zh-myvoice", "你好")).toBe(voiceCacheKey("zh-myvoice", "你好"));
    expect(voiceCacheKey("zh-myvoice", "你好")).not.toBe(voiceCacheKey("zh-myvoice", "你好呀"));
    expect(voiceCacheKey("zh-myvoice", "你好")).not.toBe(voiceCacheKey("zh-other", "你好"));
  });
});

describe("合成路径", () => {
  it("文本为空 → text_required（不发请求）", async () => {
    const fetchImpl = vi.fn();
    const result = await synthesizeVoice("   ", { config: tempConfig(), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "text_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("缺 token → 明确要求配置（不静默回落）", async () => {
    const result = await synthesizeVoice("你好", { config: tempConfig({ token: "" }) });
    expect(result).toMatchObject({ ok: false, error: "voice_station_unconfigured" });
  });

  it("已缓存 → 直接命中，不再调用工位", async () => {
    const cfg = tempConfig();
    const file = voiceCacheFile(cfg, cfg.profile, "早安播报");
    writeFileSync(file, "RIFF-fake");
    const fetchImpl = vi.fn();
    const result = await synthesizeVoice("早安播报", { config: cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, file, cached: true, profile: cfg.profile });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("工位成功 → 返回产物路径（并透传 profile / token）", async () => {
    const cfg = tempConfig();
    const produced = voiceCacheFile(cfg, cfg.profile, "今日战报");
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>).authorization ?? null,
      });
      // 模拟工位把产物写到请求里的 out 路径（真实工位就是这样落盘的）
      const requestedOut = (JSON.parse(String(init.body)).params as { out?: string }).out;
      if (requestedOut) writeFileSync(requestedOut, "RIFF-real");
      return new Response(JSON.stringify({ ok: true, result: { out: produced }, receipt: { synced: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await synthesizeVoice("今日战报", { config: cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, file: produced, cached: false, profile: "zh-myvoice" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:9776/action");
    expect(calls[0]!.auth).toBe("Bearer test-token");
    const params = calls[0]!.body.params as Record<string, unknown>;
    expect(calls[0]!.body.tool).toBe("voicewrite.speak");
    expect(params.profile).toBe("zh-myvoice");
    // 产物路径来自配置的缓存目录（同 profile+文本 → 同文件，可幂等复用）
    expect(params.out).toBe(voiceCacheFile(cfg, cfg.profile, "今日战报"));
  });

  it("工位报错 → 透传错误码（不伪造产物）", async () => {
    const cfg = tempConfig();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ ok: false, error: "consent_required", message: "缺授权" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const result = await synthesizeVoice("你好", { config: cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: false, error: "consent_required", message: "缺授权" });
  });

  it("工位回执成功但产物不在 → 判失败（无回执不算完成）", async () => {
    const cfg = tempConfig();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true, result: { out: join(cfg.cacheDir, "missing.wav") } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const result = await synthesizeVoice("你好", { config: cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: false, error: "voice_station_failed" });
    expect(existsSync(join(cfg.cacheDir, "missing.wav"))).toBe(false);
  });

  it("工位不可达 → voice_station_unavailable（客户端据此回落系统语音）", async () => {
    const cfg = tempConfig();
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await synthesizeVoice("你好", { config: cfg, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: false, error: "voice_station_unavailable" });
  });

  it("关闭开关 → voice_station_disabled", async () => {
    const result = await synthesizeVoice("你好", { config: tempConfig({ enabled: false }) });
    expect(result).toMatchObject({ ok: false, error: "voice_station_disabled" });
  });
});
