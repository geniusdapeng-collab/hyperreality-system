/**
 * SRT 解析 / 生成 / 分幕（可移植版，纯函数）
 *
 * 与上游 `engine/scripts/parse_srt.py` 的分幕算法同构（累积到 target 断幕；不小于 min；
 * 超过 max 强制断幕）。分幕必须是确定性的：同一份配音不能这次 4 幕、下次 5 幕，
 * 否则"断点续跑"与"只重渲一幕"都失去意义。
 */

export interface SrtCue { index: number; startMs: number; endMs: number; durMs: number; text: string }
export interface SceneGroup {
  sceneIndex: number; startMs: number; endMs: number; sceneDurationMs: number;
  cueRange: [number, number]; text: string;
}

const TIME_RE = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/g;

function toMs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, "0"));
}

/** 解析 SRT（容忍 BOM / CRLF / 多余空行 / 逗号或点毫秒分隔） */
export function parseSrt(text: string): SrtCue[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cues: SrtCue[] = [];
  for (const block of normalized.trim().split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    const timeLineIdx = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIdx < 0) continue;
    const times = [...lines[timeLineIdx]!.matchAll(TIME_RE)];
    if (times.length < 2) continue;
    const start = toMs(...(times[0]!.slice(1, 5) as [string, string, string, string]));
    const end = toMs(...(times[1]!.slice(1, 5) as [string, string, string, string]));
    cues.push({ index: cues.length + 1, startMs: start, endMs: end, durMs: Math.max(0, end - start), text: lines.slice(timeLineIdx + 1).join(" ").trim() });
  }
  return cues;
}

export interface GroupOptions { targetSec?: number; minSec?: number; maxSec?: number }

export function groupScenes(cues: SrtCue[], opts: GroupOptions = {}): SceneGroup[] {
  const targetMs = (opts.targetSec ?? 26) * 1000;
  const minMs = (opts.minSec ?? 18) * 1000;
  const maxMs = (opts.maxSec ?? 34) * 1000;
  const scenes: SceneGroup[] = [];
  let bucket: SrtCue[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    const start = bucket[0]!.startMs;
    const end = bucket[bucket.length - 1]!.endMs;
    scenes.push({
      sceneIndex: scenes.length + 1, startMs: start, endMs: end,
      sceneDurationMs: Math.max(0, end - start),
      cueRange: [bucket[0]!.index, bucket[bucket.length - 1]!.index],
      text: bucket.map((cue) => cue.text).join(" ").trim(),
    });
    bucket = [];
  };
  for (const cue of cues) {
    if (bucket.length > 0 && cue.endMs - bucket[0]!.startMs > maxMs) flush();
    bucket.push(cue);
    const span = bucket[bucket.length - 1]!.endMs - bucket[0]!.startMs;
    if (span >= targetMs && span >= minMs) flush();
  }
  flush();
  return scenes;
}

/**
 * 幕级时间轴铺满：每幕结束推到**下一幕首句开始**，末幕推到音频总长。
 * 于是 Σ 幕长 == 音频总长，混流不需要任何补偿（否则末尾半句会被截）。
 */
export function tileScenes(scenes: SceneGroup[], totalMs: number): SceneGroup[] {
  return scenes.map((scene, i) => {
    const next = scenes[i + 1];
    const endMs = next ? next.startMs : Math.max(totalMs, scene.endMs);
    return { ...scene, endMs, sceneDurationMs: Math.max(0, endMs - scene.startMs) };
  });
}

export function srtTime(seconds: number): string {
  const c = Math.max(0, seconds);
  return `${String(Math.floor(c / 3600)).padStart(2, "0")}:${String(Math.floor((c % 3600) / 60)).padStart(2, "0")}:`
    + `${String(Math.floor(c % 60)).padStart(2, "0")},${String(Math.round((c % 1) * 1000)).padStart(3, "0")}`;
}

export function buildSrt(cues: SrtCue[]): string {
  const lines: string[] = [];
  cues.forEach((cue, i) => {
    lines.push(String(i + 1), `${srtTime(cue.startMs / 1000)} --> ${srtTime(cue.endMs / 1000)}`, cue.text, "");
  });
  return lines.join("\n");
}

/** 幕内字幕段（写进 manifest，供审阅与返修） */
export function buildSceneSrt(cues: SrtCue[]): string {
  return buildSrt(cues);
}
