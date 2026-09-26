/**
 * 成片混流（可移植版）
 *
 * 上游渲染器产物是**无声片**（cv2.VideoWriter 不写音轨、merge_scenes 只拼视频轨），
 * 所以"配音混进来"必须是显式环节，否则交付的是一条没声音的片子。
 *
 * 三件事：① 两遍 loudnorm（先测量再按测量值归一化）；② 视频轨 `-c:v copy`（不重编码）；
 * ③ 音频 `apad` 补到画面长度 + `-shortest`（配音短于画面时补静音）。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { WhiteboardError, kitEnv } from "./engine.mts";

const execFileAsync = promisify(execFile);

async function ffmpeg(args: string[], timeoutMs: number, bin: string): Promise<string> {
  try {
    return (await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: "SIGKILL" })).stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) throw new WhiteboardError(`ffmpeg 超时：${args.slice(0, 6).join(" ")}`);
    throw new WhiteboardError(`ffmpeg 失败：${args.slice(0, 6).join(" ")}`, `${e.stderr ?? e.stdout ?? e.message ?? ""}`.trim().slice(-1000));
  }
}

function parseLoudnorm(stderr: string): Record<string, string> | null {
  const m = /\{[\s\S]*"input_i"[\s\S]*\}/.exec(stderr);
  return m ? (JSON.parse(m[0]) as Record<string, string>) : null;
}

export interface MuxResult {
  output: string; videoSeconds: number; audioSeconds: number;
  loudnessBefore: number | null; loudnessAfter: number | null; avDriftSec: number;
}

export interface MuxOptions {
  silentVideo: string; narrationWav: string; output: string;
  srtPath?: string; targetLufs?: number; env?: NodeJS.ProcessEnv;
}

export async function muxFilm(opts: MuxOptions): Promise<MuxResult> {
  const env = opts.env ?? process.env;
  const cfg = kitEnv(env);
  const target = opts.targetLufs ?? Number(env.WHITEBOARD_VOICE_LUFS ?? "-16");
  for (const f of [opts.silentVideo, opts.narrationWav]) {
    if (!existsSync(f)) throw new WhiteboardError(`混流输入缺失：${f}`);
  }
  mkdirSync(dirname(opts.output), { recursive: true });
  const measure = async (file: string) => parseLoudnorm(await ffmpeg([
    "-hide_banner", "-nostats", "-i", file,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-",
  ], 10 * 60_000, cfg.ffmpeg));
  const before = await measure(opts.narrationWav);
  if (!before) throw new WhiteboardError("响度测量失败：ffmpeg 没有输出 loudnorm 读数");
  const normalized = join(dirname(opts.output), "narration.norm.wav");
  await ffmpeg(["-y", "-v", "error", "-i", opts.narrationWav,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:linear=true:measured_I=${before.input_i}:measured_TP=${before.input_tp}`
      + `:measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:offset=${before.target_offset}:print_format=summary`,
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", normalized], 10 * 60_000, cfg.ffmpeg);
  const after = await measure(normalized).catch(() => null);
  await ffmpeg([
    "-y", "-v", "error", "-i", opts.silentVideo, "-i", normalized,
    ...(opts.srtPath ? ["-i", opts.srtPath] : []),
    "-filter_complex", "[1:a]apad[a]", "-map", "0:v:0", "-map", "[a]",
    ...(opts.srtPath ? ["-map", "2:0", "-c:s", "mov_text", "-metadata:s:s:0", "language=chi"] : []),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-shortest", "-movflags", "+faststart", opts.output,
  ], 15 * 60_000, cfg.ffmpeg);
  if (!existsSync(opts.output)) throw new WhiteboardError(`混流未产出文件：${opts.output}`);
  const dur = async (f: string) => {
    try {
      return Number((await execFileAsync(cfg.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], { timeout: 60_000 })).stdout.trim()) || 0;
    } catch { return 0; }
  };
  const videoSeconds = await dur(opts.silentVideo);
  const audioSeconds = await dur(normalized);
  return {
    output: opts.output, videoSeconds, audioSeconds,
    loudnessBefore: Number.isFinite(Number(before.input_i)) ? Number(before.input_i) : null,
    loudnessAfter: after && Number.isFinite(Number(after.input_i)) ? Number(after.input_i) : null,
    avDriftSec: Math.round((videoSeconds - audioSeconds) * 1000) / 1000,
  };
}
