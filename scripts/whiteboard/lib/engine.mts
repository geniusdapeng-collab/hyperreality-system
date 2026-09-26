/**
 * 白板引擎桥（可移植版）
 *
 * 这一份是**零依赖**实现：只用 Node 内置模块 + 仓内 Python 引擎脚本，
 * 因此可以被复制到舰队任何一个仓里独立运行，不要求该仓有视频制作子系统
 * （render_jobs / 媒资库 / gen 接缝）。深度集成版本见 WorkLoom-growth 的
 * `apps/server/src/video/whiteboard/**`（走 Provider 接缝 + 台账 + 媒资库）。
 *
 * 契约（与上游一致）：渲染器末行输出 `OUTPUT=<路径>`，据此判定产物，不看退出码。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** scripts/whiteboard/lib → 仓库根（lib→whiteboard→scripts→root） */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** 随仓分发的引擎目录（补丁后的上游脚本） */
export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class WhiteboardError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = "WhiteboardError";
  }
}

export interface KitEnv {
  engineDir: string;
  python: string;
  outDir: string;
  handImage: string;
  lineartTool: string;
  ffmpeg: string;
  ffprobe: string;
  voiceBridgeUrl: string;
  voiceBridgeToken: string;
  vencArkKey: string;
  lineartModel: string;
  lineartSize: string;
}

export function kitEnv(env: NodeJS.ProcessEnv = process.env): KitEnv {
  const engineDir = resolvePath(env.WHITEBOARD_ENGINE_DIR?.trim() || join(KIT_ROOT, "engine"), env);
  const venvPython = process.platform === "win32"
    ? join(engineDir, ".venv", "Scripts", "python.exe")
    : join(engineDir, ".venv", "bin", "python");
  return {
    engineDir,
    python: env.WHITEBOARD_PYTHON?.trim() || venvPython,
    outDir: resolvePath(env.WHITEBOARD_OUT_DIR?.trim() || join(REPO_ROOT, "var/whiteboard"), env),
    handImage: env.WHITEBOARD_HAND_IMAGE?.trim() || join(KIT_ROOT, "assets/drawing-hand-workloom.png"),
    lineartTool: join(KIT_ROOT, "lineart_tools.py"),
    ffmpeg: env.WHITEBOARD_FFMPEG?.trim() || "ffmpeg",
    ffprobe: env.WHITEBOARD_FFPROBE?.trim() || "ffprobe",
    voiceBridgeUrl: (env.WORKLOOM_VOICE_BRIDGE_URL?.trim() || "http://127.0.0.1:9776").replace(/\/+$/, ""),
    voiceBridgeToken: env.WORKLOOM_VOICE_BRIDGE_TOKEN?.trim() || "",
    vencArkKey: env.VOLCENGINE_ARK_API_KEY?.trim() || env.ARK_API_KEY?.trim() || "",
    lineartModel: env.WHITEBOARD_LINEART_MODEL?.trim() || "doubao-seedream-5-0-pro-260628",
    lineartSize: env.WHITEBOARD_LINEART_SIZE?.trim() || "2K",
  };
}

/** 相对路径按仓库根解析（避免 `file://` 把相对路径当 host 的坑） */
function resolvePath(dir: string, env: NodeJS.ProcessEnv): string {
  if (dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir)) return dir;
  return join(env.WHITEBOARD_REPO_ROOT?.trim() || REPO_ROOT, dir);
}

export function engineReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(kitEnv(env).python);
}

export function engineHint(env: NodeJS.ProcessEnv = process.env): string {
  const cfg = kitEnv(env);
  return existsSync(cfg.python)
    ? "引擎就绪"
    : `渲染环境缺失（${cfg.python}）：执行 \`pnpm exec tsx scripts/whiteboard/engine-install.mts\``;
}

export interface RunResult { stdout: string; stderr: string; durationMs: number }

/** 跑 python（超时 SIGKILL；错误信息带 stdout/stderr 尾部，否则排障只能靠猜） */
export async function runPython(
  scriptPath: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  const cfg = kitEnv(opts.env);
  if (!existsSync(cfg.python)) throw new WhiteboardError(`渲染环境不存在：${cfg.python}`, engineHint(opts.env));
  if (!existsSync(scriptPath)) throw new WhiteboardError(`脚本不存在：${scriptPath}`);
  const timeoutMs = opts.timeoutMs ?? Number(opts.env?.WHITEBOARD_RUN_TIMEOUT_MS ?? 30 * 60_000);
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cfg.python, [scriptPath, ...args], {
      timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, env: childEnv(cfg),
    });
    return { stdout, stderr, durationMs: Date.now() - started };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
    if (e.killed || e.signal === "SIGKILL") {
      throw new WhiteboardError(`脚本超时（${Math.round(timeoutMs / 1000)}s，已 SIGKILL）：${scriptPath}`);
    }
    throw new WhiteboardError(
      `脚本执行失败：${scriptPath}`,
      tail(`${e.stdout ?? ""}\n${e.stderr ?? e.message ?? ""}`, 1200),
    );
  }
}

function childEnv(cfg: KitEnv): NodeJS.ProcessEnv {
  const key = process.platform === "win32" ? "Path" : "PATH";
  const dirs = [dirname(cfg.ffmpeg), join(process.env.HOME ?? "", ".local/bin"), process.env[key] ?? ""]
    .filter((d) => d && d !== ".");
  return { ...process.env, [key]: dirs.join(process.platform === "win32" ? ";" : ":") };
}

function tail(text: string, n: number): string {
  const t = text.trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}

/** 解析上游末行契约 `OUTPUT=<路径>` */
export function parseOutputLine(stdout: string): string | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^OUTPUT=(.+)$/.exec(lines[i]!.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

export interface RenderSceneInput {
  imagePath: string; annotationPath: string; outputPath: string;
  fps?: number; capLongEdge?: number; totalMs?: number;
  inkPath?: "grid" | "skeleton"; colorFill?: "contour-wipe" | "brush";
  env?: NodeJS.ProcessEnv; timeoutMs?: number;
}

/** 单幕渲染 */
export async function renderScene(input: RenderSceneInput): Promise<{ outputPath: string; durationMs: number }> {
  const cfg = kitEnv(input.env);
  const run = await runPython(join(cfg.engineDir, "scripts/render_stream_whiteboard.py"), [
    input.imagePath, input.annotationPath, input.outputPath, cfg.handImage,
    "--ink-path", input.inkPath ?? "grid",
    "--color-fill", input.colorFill ?? "contour-wipe",
    "--fps", String(input.fps ?? 30),
    "--cap-long-edge", String(input.capLongEdge ?? 1280),
    ...(input.totalMs ? ["--total-ms", String(input.totalMs)] : []),
  ], { env: input.env, timeoutMs: input.timeoutMs });
  const out = parseOutputLine(run.stdout);
  if (!out || !existsSync(out)) {
    throw new WhiteboardError(`渲染未产出可读文件：${input.outputPath}`, tail(run.stdout, 600));
  }
  return { outputPath: out, durationMs: run.durationMs };
}

/** 多幕合并 */
export async function mergeScenes(inputs: string[], output: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const cfg = kitEnv(env);
  if (inputs.length === 0) throw new WhiteboardError("合并失败：没有输入分幕");
  const run = await runPython(join(cfg.engineDir, "scripts/merge_scenes.py"),
    ["--inputs", ...inputs, "--output", output], { env, timeoutMs: 10 * 60_000 });
  const out = parseOutputLine(run.stdout);
  if (!out || !existsSync(out)) throw new WhiteboardError(`合并未产出可读文件：${output}`, tail(run.stdout, 600));
  return out;
}

/** 标注编号检查图（确认关） */
export async function renderAnnotationPreview(
  imagePath: string, annotationPath: string, outputPath: string, env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  await runPython(join(kitEnv(env).engineDir, "scripts/render_annotation_preview.py"),
    [imagePath, annotationPath, outputPath], { env, timeoutMs: 120_000 });
  if (!existsSync(outputPath)) throw new WhiteboardError(`标注检查图未产出：${outputPath}`);
  return outputPath;
}

export type ToolResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** 调 `lineart_tools.py` 子命令（stdout 一行 JSON；`check` 用非 0 退出码表达"不过"） */
export async function runLineartTool<T>(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; allowNonZero?: boolean } = {},
): Promise<ToolResult<T>> {
  const cfg = kitEnv(opts.env);
  let stdout = "";
  try {
    stdout = (await runPython(cfg.lineartTool, args, { env: opts.env, timeoutMs: opts.timeoutMs ?? 10 * 60_000 })).stdout;
  } catch (err) {
    const detail = (err as WhiteboardError).detail ?? (err as Error).message;
    const line = detail.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
    if (!opts.allowNonZero || !line) throw err;
    stdout = line;
  }
  const line = stdout.trim().split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
  if (!line) throw new WhiteboardError(`线稿工具未输出 JSON：${args.join(" ")}`);
  return JSON.parse(line) as ToolResult<T>;
}

/** PNG/JPEG 像素尺寸（annotation.canvas 必须与之相等；不依赖第三方库） */
export function readImageSize(absPath: string): { width: number; height: number } | null {
  if (!existsSync(absPath)) return null;
  const buf = readFileSync(absPath);
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const size = buf.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      offset += 2 + size;
    }
  }
  return null;
}
