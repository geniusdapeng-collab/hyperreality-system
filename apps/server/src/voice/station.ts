/** 织伴默认已试听选定的普通话女声 zf_001；工位故障依次回退个人克隆与系统语音。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import voice from "./loommate-voice.json";
import { joinVoiceWavs, parseVoiceWav, splitVoiceText } from "./wav.js";
export interface VoiceStationConfig {
  enabled: boolean;
  bridgeUrl: string;
  token: string;
  profile: string;
  cacheDir: string;
  timeoutMs: number;
  engineUrl: string;
  /** Only an installed local model is used; runtime never downloads weights. */
  sweetModel: string;
  primaryTimeoutMs: number;
}
export type VoiceStationResult =
  | { ok: true; file: string; cached: boolean; profile: string }
  | { ok: false; error: string; message: string; profile: string };
function loopback(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      && !u.username && !u.password && !u.search && !u.hash && ["", "/"].includes(u.pathname);
  } catch { return false; }
}
function timeout(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 900_000 ? n : fallback;
}
function localToken(stationDir: string): string {
  try {
    const file = path.join(stationDir, "bridge-token"), stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) return "";
    return readFileSync(file, "utf8").trim();
  } catch { return ""; } // Missing/unreadable credentials mean unconfigured, never a fabricated token.
}
function installedModel(stationDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(stationDir, "loommate-voice.json"), "utf8")) as {
      revision?: string; model?: string; modelPath?: string; voice?: string; phonemizerVersion?: string;
    };
    if (manifest.model !== voice.model || manifest.revision !== voice.revision || !manifest.modelPath
      || manifest.voice !== voice.voice || manifest.phonemizerVersion !== voice.phonemizerVersion
      || !path.isAbsolute(manifest.modelPath) || !existsSync(path.join(manifest.modelPath, "config.json"))
      || !existsSync(path.join(manifest.modelPath, voice.modelFile))
      || !existsSync(path.join(manifest.modelPath, voice.voiceFile))) return "";
    return manifest.modelPath;
  } catch { return ""; } // Installer reports detailed errors; speech uses the personal-clone fallback.
}
export function voiceStationConfig(env: NodeJS.ProcessEnv = process.env): VoiceStationConfig {
  const stationDir = path.resolve(env.WORKLOOM_VOICE_STATION_DIR || path.join(os.homedir(), ".workloom", "voice-station"));
  const bridgeUrl = String(env.WORKLOOM_VOICE_BRIDGE_URL ?? "http://127.0.0.1:9776").replace(/\/+$/, "");
  return {
    enabled: (env.WORKLOOM_VOICE_ENABLED ?? "1") !== "0", bridgeUrl,
    token: String(env.WORKLOOM_VOICE_BRIDGE_TOKEN ?? (loopback(bridgeUrl) ? localToken(stationDir) : "")).trim(),
    profile: String(env.WORKLOOM_VOICE_PROFILE ?? voice.profile).trim() || voice.profile,
    cacheDir: path.resolve(env.WORKLOOM_VOICE_CACHE_DIR || path.join(stationDir, "deliveries", "voice-cache")),
    timeoutMs: timeout(env.WORKLOOM_VOICE_TIMEOUT_MS, 90_000),
    engineUrl: String(env.WORKLOOM_VOICE_ENGINE_URL ?? `http://127.0.0.1:${voice.enginePort}`).replace(/\/+$/, ""),
    sweetModel: installedModel(stationDir), primaryTimeoutMs: timeout(env.WORKLOOM_VOICE_PRIMARY_TIMEOUT_MS, 60_000),
  };
}
export function voiceCacheKey(profile: string, text: string, identity = "v2"): string {
  return createHash("sha256").update(`${identity}\u0000${profile}\u0000${text}`).digest("hex").slice(0, 32);
}
export function voiceCacheFile(cfg: VoiceStationConfig, profile: string, text: string): string {
  const identity = profile === voice.profile
    ? JSON.stringify(["v3", voice.model, voice.revision, voice.voice, voice.voiceFile, voice.phonemizerVersion,
      voice.pythonDependency, voice.extraDependencies, voice.language, voice.speed, voice.instruction]) : "v2";
  return path.join(cfg.cacheDir, `${voiceCacheKey(profile, text, identity)}.wav`);
}
async function cached(file: string): Promise<boolean> {
  try { parseVoiceWav(await readFile(file)); return true; } catch { return false; }
}
async function saveAudio(file: string, audio: Uint8Array): Promise<void> {
  parseVoiceWav(audio);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, audio, { mode: 0o600, flag: "wx" }); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }); }
}
async function audioBody(response: Response): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`voice_engine_http_${response.status}`);
  const reader = response.body.getReader(), pieces: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 32 * 1024 * 1024) throw new Error("voice_wav_too_large");
      pieces.push(value);
    }
    const audio = Buffer.concat(pieces);
    parseVoiceWav(audio);
    return audio;
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
async function primary(clean: string, cfg: VoiceStationConfig, fetchImpl: typeof fetch): Promise<VoiceStationResult> {
  const file = voiceCacheFile(cfg, voice.profile, clean);
  if (await cached(file)) return { ok: true, file, cached: true, profile: voice.profile };
  if (!cfg.sweetModel) throw new Error("sweet_voice_not_installed");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(cfg.primaryTimeoutMs, cfg.timeoutMs));
  try {
    const chunks: Uint8Array[] = [];
    for (const text of splitVoiceText(clean)) {
      const response = await fetchImpl(`${cfg.engineUrl}/v1/audio/speech`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ model: cfg.sweetModel, input: text, voice: path.join(cfg.sweetModel, voice.voiceFile),
          lang_code: voice.language, gender: "female", pitch: 1, speed: voice.speed,
          response_format: "wav", stream: false, max_tokens: 1200, temperature: 0.7, repetition_penalty: 1.05 }),
      });
      chunks.push(await audioBody(response));
    }
    controller.signal.throwIfAborted();
    await saveAudio(file, joinVoiceWavs(chunks));
    return { ok: true, file, cached: false, profile: voice.profile };
  } finally { clearTimeout(timer); }
}
async function clone(clean: string, profile: string, cfg: VoiceStationConfig, fetchImpl: typeof fetch): Promise<VoiceStationResult> {
  const file = voiceCacheFile(cfg, profile, clean);
  if (await cached(file)) return { ok: true, file, cached: true, profile };
  await mkdir(cfg.cacheDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.wav`, controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetchImpl(`${cfg.bridgeUrl}/action`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ tool: "voicewrite.speak", params: { profile, text: clean, out: tmp, gap_ms: 160, tenant_id: "ws-local-voice" } }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string; message?: string; result?: { out?: string } } | null;
    if (!response.ok || payload?.ok !== true) return { ok: false, error: payload?.error ?? "voice_station_failed",
      message: (payload?.message ?? `工位返回 HTTP ${response.status}`).replaceAll(cfg.token, "[redacted]"), profile };
    // A bridge reply may never select an arbitrary local file for the HTTP route to expose.
    if (payload.result?.out && path.resolve(payload.result.out) !== tmp) throw new Error("unexpected_voice_output_path");
    controller.signal.throwIfAborted();
    await saveAudio(file, await readFile(tmp));
    return { ok: true, file, cached: false, profile };
  } finally { clearTimeout(timer); await rm(tmp, { force: true }); }
}
const inFlight = new Map<string, Promise<VoiceStationResult>>();
export async function synthesizeVoice(text: string,
  options: { config?: VoiceStationConfig; profile?: string; fetchImpl?: typeof fetch } = {},
): Promise<VoiceStationResult> {
  const cfg = options.config ?? voiceStationConfig(), requested = (options.profile ?? cfg.profile).trim() || cfg.profile;
  // Old compiled clients send zh-myvoice. Explicit server WORKLOOM_VOICE_PROFILE=zh-myvoice keeps the owner's voice.
  const profile = requested === voice.fallbackProfile && cfg.profile === voice.profile ? voice.profile : requested;
  const clean = text.trim();
  const fail = (error: string, message: string): VoiceStationResult => ({ ok: false, error, message, profile });
  if (!clean) return fail("text_required", "播报文本为空");
  if (Array.from(clean).length > 2000) return fail("text_too_long", "播报文本最多 2000 字，请分段播报");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) return fail("invalid_voice_profile", "音色档案名无效");
  if (!cfg.enabled) return fail("voice_station_disabled", "本机神经音色已关闭（WORKLOOM_VOICE_ENABLED=0）");
  if (!loopback(cfg.bridgeUrl) || !loopback(cfg.engineUrl)) return fail("voice_station_nonlocal", "语音工位只允许本机回环地址");
  if (!cfg.token) return fail("voice_station_unconfigured", "请配置本机配音工位：bridge-token 必须仅本人可读，或注入 WORKLOOM_VOICE_BRIDGE_TOKEN");
  const key = JSON.stringify([cfg.cacheDir, cfg.bridgeUrl, cfg.engineUrl, cfg.sweetModel, profile, clean]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  if (inFlight.size >= 64) return fail("voice_station_busy", "语音工位请求过多，请稍后重试");
  const fetchImpl = options.fetchImpl ?? fetch;
  const work = (async (): Promise<VoiceStationResult> => {
    let primaryFailed = false;
    const started = Date.now();
    try {
      if (profile === voice.profile) {
        try { return await primary(clean, cfg, fetchImpl); } catch { primaryFailed = true; }
      }
      const result = await clone(clean, profile === voice.profile ? voice.fallbackProfile : profile,
        { ...cfg, timeoutMs: Math.max(1, cfg.timeoutMs - (Date.now() - started)) }, fetchImpl);
      if (!result.ok && primaryFailed) return { ...result, message: `自然女声暂不可用；个人克隆也失败：${result.message}` };
      return result;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return fail(aborted ? "voice_station_timeout" : "voice_station_unavailable",
        primaryFailed ? "自然女声与本机个人克隆均不可用，客户端将使用系统语音" : "本机配音工位不可用，客户端将使用系统语音");
    }
  })();
  inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}
export async function readVoiceFile(file: string): Promise<Uint8Array> {
  const audio = await readFile(file); parseVoiceWav(audio); return audio;
}
