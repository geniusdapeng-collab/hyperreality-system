/**
 * 口播稿 → 配音 → SRT（可移植版）
 *
 * 三个来源，按优先级自动选择（不猜、显式失败）：
 *   ① `voice-station`：本机配音工位 HTTP（`POST /action {tool:"voicewrite.speak"}`）——
 *      支持克隆音色，声纹不出域；**直接走 HTTP，不依赖任何仓内连接器文件**（关键：这让本能力
 *      可以在没有 ai-video 包（因而已无 voice-bridge 连接器）的仓里照常工作）；
 *   ② `srt`：外部已有 SRT（.srt 文件）——只做分幕，不合成；
 *   ③ `audio+srt`：外部已有配音 + 对应 SRT——跳过合成，直接进渲染。
 *
 * 逐句合成的理由：上游 `sceneDurationMs` / `reveal.startMs` 是毫秒级契约，
 * 整段合成只能拿到一个总时长，句边界得靠 ASR 反推（额外模型、额外误差）；
 * 逐句合成天然给出句边界 —— SRT 与音频**构造即一致**。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WhiteboardError, kitEnv } from "./engine.mts";
import { buildSrt, type SrtCue } from "./srt.mts";

const execFileAsync = promisify(execFile);

export interface NarrationConfig {
  profile: string; lufs: number; gapMs: number; concurrency: number; timeoutMs: number;
  ffmpeg: string; ffprobe: string; bridgeUrl: string; bridgeToken: string;
}

export function narrationConfig(env: NodeJS.ProcessEnv = process.env): NarrationConfig {
  const cfg = kitEnv(env);
  return {
    profile: env.WHITEBOARD_NARRATION_PROFILE?.trim() || env.WORKLOOM_VOICE_PROFILE?.trim() || "zh-myvoice",
    lufs: Number(env.WHITEBOARD_NARRATION_LUFS ?? "-16"),
    gapMs: Number(env.WHITEBOARD_NARRATION_GAP_MS ?? "240"),
    concurrency: Math.max(1, Math.min(6, Number(env.WHITEBOARD_NARRATION_CONCURRENCY ?? "3"))),
    timeoutMs: Number(env.WHITEBOARD_NARRATION_TIMEOUT_MS ?? 900_000),
    ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe,
    bridgeUrl: cfg.voiceBridgeUrl, bridgeToken: cfg.voiceBridgeToken,
  };
}

/**
 * 口播稿分句（确定性，纯函数）。
 * 文档脚手架行（标题 / 引用 / 表格 / 分隔线 / 注释）整行丢弃——它们是脚本的元数据，不是要朗读的内容；
 * 列表符号只剥符号；行内 Markdown（加粗、代码、链接）只留文字。
 */
export function splitSentences(script: string, minChars = 6): string[] {
  const cleaned = script
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s{0,4}(#{1,6}\s+|>\s?|\||-{3,}|<!--)/.test(line))
    .map((line) => line
      .replace(/^\s{0,4}([-*+]\s+|\d+[.、)]\s+)/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim())
    .filter((line) => line.length > 0)
    .join("\n");
  const raw = cleaned.split(/(?<=[。！？!?；;])|\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  for (const piece of raw) {
    const prev = out[out.length - 1];
    if (prev !== undefined && piece.replace(/[。！？!?；;，,、]/g, "").length < minChars) out[out.length - 1] = `${prev}${piece}`;
    else out.push(piece);
  }
  return out;
}

async function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    return (await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: "SIGKILL" })).stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) throw new WhiteboardError(`命令超时：${cmd}`);
    throw new WhiteboardError(`命令失败：${cmd}`, `${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`.trim().slice(-1000));
  }
}

export async function probeSeconds(file: string, ffprobe = "ffprobe"): Promise<number> {
  const out = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], 60_000);
  const value = Number(out.trim());
  if (!Number.isFinite(value) || value <= 0) throw new WhiteboardError(`ffprobe 读不到时长：${file}`);
  return value;
}

/** 配音工位健康检查（不装连接器也能查：直接打 HTTP） */
export async function voiceStationHealth(env: NodeJS.ProcessEnv = process.env): Promise<{ reachable: boolean; detail: string }> {
  const cfg = narrationConfig(env);
  try {
    const res = await fetch(`${cfg.bridgeUrl}/health`, { headers: cfg.bridgeToken ? { authorization: `Bearer ${cfg.bridgeToken}` } : {} });
    if (!res.ok) return { reachable: false, detail: `工位 HTTP ${res.status}` };
    const body = (await res.json()) as { profiles?: { ids?: string[] } };
    const ids = body?.profiles?.ids ?? [];
    return { reachable: true, detail: `工位可用，音色档案：${ids.join(", ") || "（无）"}` };
  } catch (err) {
    return { reachable: false, detail: `工位不可达（${cfg.bridgeUrl}）：${(err as Error).message}` };
  }
}

async function synthOne(text: string, outPath: string, cfg: NarrationConfig): Promise<void> {
  const res = await fetch(`${cfg.bridgeUrl}/action`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.bridgeToken ? { authorization: `Bearer ${cfg.bridgeToken}` } : {}) },
    body: JSON.stringify({ tool: "voicewrite.speak", params: { text, profile: cfg.profile, out: outPath, lufs: cfg.lufs } }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
  if (!res.ok || body.ok === false) {
    throw new WhiteboardError(
      `配音失败：${body.message ?? body.error ?? `HTTP ${res.status}`}`,
      `工位 ${cfg.bridgeUrl}；音色档案 ${cfg.profile}；文本前 30 字「${text.slice(0, 30)}」`,
    );
  }
}

export interface NarrationResult {
  wavPath: string; srt: string; cues: SrtCue[]; totalMs: number; profile: string; reused: number;
}

export interface SegmentManifest {
  schema: "workloom.whiteboard-narration/v1";
  scriptSha256: string; profile: string;
  segments: Array<{ index: number; sha256: string; profile: string; file: string; seconds: number }>;
}

function textSha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 单句是否可复用（纯函数，可单测）：
 * 文件存在 + 清单里该句文本哈希一致 + 音色一致，三者齐全才复用——
 * 只看"文件在不在"会导致改稿子后静默复用旧音频（字幕写 B、耳朵听 A）。
 */
export function reusableSegment(args: {
  manifest: SegmentManifest | null; index: number; text: string; profile: string; fileExists: boolean;
}): boolean {
  if (!args.fileExists || !args.manifest) return false;
  const entry = args.manifest.segments.find((s) => s.index === args.index);
  return entry ? entry.sha256 === textSha(args.text) && entry.profile === args.profile : false;
}

export interface SynthesizeOptions {
  script: string; outDir: string; env?: NodeJS.ProcessEnv;
  onProgress?: (done: number, total: number, current: string) => void;
}

/** 口播稿 → 配音整轨 + SRT（逐句合成；已合成的句子按文本哈希复用，可断点续跑） */
export async function synthesizeNarration(opts: SynthesizeOptions): Promise<NarrationResult> {
  const env = opts.env ?? process.env;
  const cfg = narrationConfig(env);
  const sentences = splitSentences(opts.script);
  if (sentences.length === 0) throw new WhiteboardError("口播稿为空：分句后没有任何句子");
  const health = await voiceStationHealth(env);
  if (!health.reachable) throw new WhiteboardError(`配音工位不可达：${health.detail}`, "设置 WORKLOOM_VOICE_BRIDGE_URL/TOKEN，或改用 --srt / --audio 走外部配音");
  mkdirSync(opts.outDir, { recursive: true });

  /**
   * 工位有"路径监狱"：只允许写 工位目录 / ~/Movies / ~/Desktop / os.tmpdir()。
   * 因此先写系统临时目录、再复制进任务目录（不放宽全局安全边界）。
   */
  const staging = mkdtempSync(join(tmpdir(), "workloom-whiteboard-voice-"));
  const files = sentences.map((_, i) => join(opts.outDir, `seg-${String(i + 1).padStart(2, "0")}.wav`));
  const manifestPath = join(opts.outDir, "segments.manifest.json");
  const scriptSha = createHash("sha256").update(sentences.join("\u0000")).digest("hex");
  let manifest: SegmentManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as SegmentManifest;
      if (parsed.schema === "workloom.whiteboard-narration/v1" && parsed.scriptSha256 === scriptSha) manifest = parsed;
    } catch { manifest = null; }
  }
  if (!manifest) manifest = { schema: "workloom.whiteboard-narration/v1", scriptSha256: scriptSha, profile: cfg.profile, segments: [] };

  const durations: number[] = [];
  const failures: Array<{ index: number; reason: string }> = [];
  let done = 0;
  let reused = 0;
  const queue = sentences.map((text, i) => ({ text, i }));

  const one = async (i: number, text: string): Promise<void> => {
    const file = files[i]!;
    if (reusableSegment({ manifest, index: i, text, profile: cfg.profile, fileExists: existsSync(file) })) {
      durations[i] = await probeSeconds(file, cfg.ffprobe);
      reused += 1; done += 1; opts.onProgress?.(done, sentences.length, text);
      return;
    }
    const staged = join(staging, `seg-${String(i + 1).padStart(2, "0")}.wav`);
    await synthOne(text, staged, cfg);
    if (!existsSync(staged)) throw new WhiteboardError(`配音工位未产出音频：${staged}`);
    copyFileSync(staged, file);
    durations[i] = await probeSeconds(file, cfg.ffprobe);
    manifest!.segments = [...manifest!.segments.filter((s) => s.index !== i),
      { index: i, sha256: textSha(text), profile: cfg.profile, file, seconds: durations[i]! }].sort((a, b) => a.index - b.index);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    done += 1;
    opts.onProgress?.(done, sentences.length, text);
  };

  try {
    const workers = Array.from({ length: Math.min(cfg.concurrency, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        try {
          await one(next.i, next.text);
        } catch (err) {
          failures.push({ index: next.i, reason: (err as Error).message.slice(0, 200) });
        }
      }
    });
    await Promise.all(workers);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    throw new WhiteboardError(
      `${failures.length} 句配音失败（本批成功 ${done} 句，产物保留可直接续跑）：`
      + failures.slice(0, 4).map((f) => `第 ${f.index + 1} 句`).join("、"),
      failures.map((f) => `#${f.index + 1}: ${f.reason}`).join("\n").slice(0, 800),
    );
  }

  // 句间静音 + 时间轴（毫秒取整，严格由真实时长累加）
  const gapSec = Math.max(0, cfg.gapMs) / 1000;
  const silence = join(opts.outDir, "silence.wav");
  await run(cfg.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-t", gapSec.toFixed(3), "-c:a", "pcm_s16le", silence], 60_000);
  const cues: SrtCue[] = [];
  let cursorMs = 0;
  sentences.forEach((text, i) => {
    const durMs = Math.round((durations[i] ?? 0) * 1000);
    cues.push({ index: i + 1, startMs: cursorMs, endMs: cursorMs + durMs, durMs, text });
    cursorMs += durMs + (i === sentences.length - 1 ? 0 : Math.round(gapSec * 1000));
  });
  const normDir = join(opts.outDir, "norm");
  mkdirSync(normDir, { recursive: true });
  const listLines: string[] = [];
  const quote = (p: string) => `file '${p.replace(/'/g, "'\\''")}'`;
  for (const [i, file] of files.entries()) {
    const norm = join(normDir, `n-${String(i + 1).padStart(2, "0")}.wav`);
    await run(cfg.ffmpeg, ["-y", "-v", "error", "-i", file, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", norm], 120_000);
    listLines.push(quote(norm));
    if (i < files.length - 1 && gapSec > 0) listLines.push(quote(silence));
  }
  const listPath = join(opts.outDir, "concat.txt");
  writeFileSync(listPath, `${listLines.join("\n")}\n`, "utf8");
  const wavPath = join(opts.outDir, "narration.wav");
  await run(cfg.ffmpeg, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", wavPath], 300_000);
  const totalMs = Math.round((await probeSeconds(wavPath, cfg.ffprobe)) * 1000);
  if (Math.abs(totalMs - cursorMs) > 50) {
    throw new WhiteboardError(`配音轨时长与逐句累加不一致：实测 ${totalMs}ms vs 计划 ${cursorMs}ms`,
      "常见原因：工位输出采样率/声道与拼接参数不一致");
  }
  rmSync(normDir, { recursive: true, force: true });
  rmSync(listPath, { force: true });
  rmSync(silence, { force: true });
  const srt = buildSrt(cues);
  writeFileSync(join(opts.outDir, "narration.srt"), srt, "utf8");
  return { wavPath, srt, cues, totalMs, profile: cfg.profile, reused };
}
