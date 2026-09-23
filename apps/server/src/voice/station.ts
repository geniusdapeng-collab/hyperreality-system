/**
 * 本机配音工位（voice-bridge）服务端适配
 *
 * 目标：让「小织 / 织伴」的播报默认用**本机克隆音色**（配音工位的音色档案），
 * 而不是系统 TTS 的通用女声。产品里的每一处播报都经这一层取音频，客户端只负责播放。
 *
 * 纪律（与《语音与数字员工交付契约》一致）：
 * 1. **声纹不出域**：音色档案（参考音频 + 授权回执）只留在**本机工位**
 *    `~/.workloom/voice-station/profiles/<profile>/`；服务端只按 profile 名请求，
 *    不搬运、不落库、不回传参考音频。
 * 2. **降级不静默**：工位未配置 / 不可达 / 合成失败 → 抛 `voice_station_unavailable`（HTTP 503），
 *    由客户端回落到系统女声并**锁定同一音色**（宁可换声线，也不让播报消失）。
 * 3. **幂等缓存**：同一 (profile, text) 只合成一次，落工位 `deliveries/voice-cache/<hash>.wav`；
 *    重复的早安播报、欢迎词不会每次都跑模型。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface VoiceStationConfig {
  /** 是否启用本机克隆音色（`WORKLOOM_VOICE_ENABLED=0` 可整仓关掉，回落系统语音） */
  enabled: boolean;
  /** 配音工位桥地址（voice-bridge HTTP，默认本机 9776） */
  bridgeUrl: string;
  /** 工位 token（工位本机文件或受控秘密存储；不进代码、不进日志） */
  token: string;
  /** 默认音色档案名（配音工位 profiles/<name>） */
  profile: string;
  /** 合成缓存目录（默认落工位 deliveries/voice-cache） */
  cacheDir: string;
  timeoutMs: number;
}

export type VoiceStationResult =
  | { ok: true; file: string; cached: boolean; profile: string }
  | { ok: false; error: string; message: string; profile: string };

export function voiceStationConfig(env: NodeJS.ProcessEnv = process.env): VoiceStationConfig {
  const stationDir = env.WORKLOOM_VOICE_STATION_DIR
    ? path.resolve(env.WORKLOOM_VOICE_STATION_DIR)
    : path.join(os.homedir(), ".workloom", "voice-station");
  return {
    enabled: (env.WORKLOOM_VOICE_ENABLED ?? "1") !== "0",
    bridgeUrl: String(env.WORKLOOM_VOICE_BRIDGE_URL ?? "http://127.0.0.1:9776").replace(/\/+$/, ""),
    token: String(env.WORKLOOM_VOICE_BRIDGE_TOKEN ?? "").trim(),
    profile: String(env.WORKLOOM_VOICE_PROFILE ?? "zh-myvoice").trim() || "zh-myvoice",
    cacheDir: String(env.WORKLOOM_VOICE_CACHE_DIR ?? path.join(stationDir, "deliveries", "voice-cache")),
    timeoutMs: Number(env.WORKLOOM_VOICE_TIMEOUT_MS ?? 600_000),
  };
}

/** 缓存键：同一 profile + 同一段文字 → 同一个文件（不掺时间戳，保证可复用） */
export function voiceCacheKey(profile: string, text: string): string {
  return createHash("sha256").update(`${profile}\u0000${text}`).digest("hex").slice(0, 32);
}

export function voiceCacheFile(cfg: VoiceStationConfig, profile: string, text: string): string {
  return path.join(cfg.cacheDir, `${voiceCacheKey(profile, text)}.wav`);
}

/**
 * 合成（或命中缓存）一段播报，返回工位上的 wav 路径。
 * 调用方负责读取文件并回给客户端；失败一律返回结构化原因，不抛异常（便于上层转 503）。
 */
export async function synthesizeVoice(
  text: string,
  options: { config?: VoiceStationConfig; profile?: string; fetchImpl?: typeof fetch } = {},
): Promise<VoiceStationResult> {
  const cfg = options.config ?? voiceStationConfig();
  const profile = (options.profile ?? cfg.profile).trim() || cfg.profile;
  const clean = text.trim();
  if (!clean) return { ok: false, error: "text_required", message: "播报文本为空", profile };
  if (!cfg.enabled) return { ok: false, error: "voice_station_disabled", message: "本机克隆音色已关闭（WORKLOOM_VOICE_ENABLED=0）", profile };
  if (!cfg.token) {
    return {
      ok: false,
      error: "voice_station_unconfigured",
      message: "缺少 WORKLOOM_VOICE_BRIDGE_TOKEN：请在工位本机配置后重试（客户端会回落系统语音）",
      profile,
    };
  }

  const cacheFile = voiceCacheFile(cfg, profile, clean);
  if (existsSync(cacheFile)) return { ok: true, file: cacheFile, cached: true, profile };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetchImpl(`${cfg.bridgeUrl}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({
        tool: "voicewrite.speak",
        params: { profile, text: clean, out: cacheFile, gap_ms: 160, tenant_id: "ws-local-voice" },
      }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; message?: string; result?: { out?: string } }
      | null;
    if (!response.ok || payload?.ok !== true) {
      return {
        ok: false,
        error: payload?.error ?? "voice_station_failed",
        message: payload?.message ?? `工位返回 HTTP ${response.status}`,
        profile,
      };
    }
    const out = payload.result?.out ?? cacheFile;
    if (!existsSync(out)) {
      return { ok: false, error: "voice_station_failed", message: "工位回执成功但产物不存在（不伪造完成）", profile };
    }
    return { ok: true, file: out, cached: false, profile };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "voice_station_timeout" : "voice_station_unavailable",
      message: aborted
        ? `配音工位超时（${Math.round(cfg.timeoutMs / 1000)}s）`
        : `配音工位不可达：${error instanceof Error ? error.message : String(error)}`,
      profile,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function readVoiceFile(file: string): Promise<Uint8Array> {
  return await readFile(file);
}
