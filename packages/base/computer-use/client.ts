/**
 * computer-use · 底层客户端
 *
 * 统一收口对 toolkit（Python 胶水层 computer_tool.py）的调用：
 * spawn python3 → 传 action JSON → 解析 stdout JSON →  typed ComputerResult。
 * 无第三方依赖（仅 node:child_process），任何 Node≥20 环境可用。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ComputerAction, ComputerResult, LifecycleResult, RunOptions } from "./types.js";

/** toolkit 根目录（本包内 computer-use/toolkit/） */
export const TOOLKIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "toolkit");
export const TOOL_PATH = path.join(TOOLKIT_DIR, "computer_tool.py");

/** toolkit 生命周期脚本路径 */
export const SCRIPTS = {
  install: path.join(TOOLKIT_DIR, "install.sh"),
  preflight: path.join(TOOLKIT_DIR, "preflight_check.sh"),
  start: path.join(TOOLKIT_DIR, "start_desktop.sh"),
  stop: path.join(TOOLKIT_DIR, "stop_desktop.sh"),
  health: path.join(TOOLKIT_DIR, "health_check.sh"),
} as const;

function runProcess(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string>; input?: string },
): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`进程超时（${opts.timeoutMs}ms）：${cmd} ${args.join(" ")}`));
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - t0 });
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/** 执行一个 computer-use 动作（L1/L2/L3 统一入口） */
export async function runAction<T = unknown>(
  action: ComputerAction,
  opts: RunOptions = {},
): Promise<ComputerResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await runProcess(
      "python3",
      [TOOL_PATH, JSON.stringify(action)],
      { timeoutMs, env: opts.env },
    );
    const text = stdout.trim();
    let data: T | string = text;
    try {
      data = JSON.parse(text) as T;
    } catch {
      /* 非 JSON 输出原样返回 */
    }
    // toolkit 约定：返回 JSON 中 status:"error"、ok:false 或顶层 error 字段视为失败
    const failed =
      typeof data === "object" &&
      data !== null &&
      ((data as Record<string, unknown>).status === "error" ||
        (data as Record<string, unknown>).ok === false ||
        typeof (data as Record<string, unknown>).error === "string");
    return {
      ok: !failed,
      action: action.action,
      data,
      ms: Date.now() - t0,
      ...(failed ? { error: String((data as Record<string, unknown>).error ?? stderr.trim() ?? "action failed") } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      action: action.action,
      data: "",
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 跑生命周期脚本（install/preflight/start/stop/health），幂等 */
export async function runLifecycle(
  script: keyof typeof SCRIPTS,
  opts: RunOptions = {},
): Promise<LifecycleResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const t0 = Date.now();
  try {
    const { code, stdout, stderr } = await runProcess("bash", [SCRIPTS[script]], {
      timeoutMs,
      env: opts.env,
    });
    const merged = (stdout + stderr).trim();
    return { ok: code === 0, tail: merged.split("\n").slice(-30).join("\n"), ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, tail: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}
