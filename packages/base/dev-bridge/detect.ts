/**
 * 设备探测：PATH 查找 + 版本握手（跨平台：posix which / win32 where）
 * 纪律：探测不到就返回 null——UI 给安装指引，绝不假装设备在线。
 * 额外搜索路径：WORKLOOM_DEV_TOOL_PATHS（冒号/分号分隔），
 * 以及常见用户级安装位置（npm global / ~/.local/bin / homebrew）。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir, platform } from "node:os";
import type { CodingToolAdapter, ToolInstall } from "./types.js";

const EXTRA_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".npm-global", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  // Windows 常见位置（git-bash/WSL 之外的独立安装）
  process.env.APPDATA ? join(process.env.APPDATA, "npm") : "",
].filter(Boolean);

function searchPaths(): string[] {
  const envExtra = (process.env.WORKLOOM_DEV_TOOL_PATHS ?? "").split(delimiter).filter(Boolean);
  return [...envExtra, ...EXTRA_DIRS, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
}

/** 在 PATH（含扩展路径）里定位可执行文件绝对路径；找不到返回 null */
export function locateBin(binName: string): string | null {
  const exts = platform() === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of searchPaths()) {
    for (const ext of exts) {
      const p = join(dir, binName + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** 版本握手：执行 <bin> --version，截断取原文（超时 8s） */
export function probeBin(adapter: CodingToolAdapter, versionArgs: string[]): Promise<ToolInstall | null> {
  const binPath = locateBin(adapter.binName());
  if (!binPath) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(binPath, versionArgs, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) { resolve(null); return; }
      const version = (stdout || stderr).trim().split("\n")[0]?.slice(0, 120) ?? "unknown";
      resolve({
        toolKey: adapter.toolKey,
        binPath,
        version,
        capabilities: adapter.capabilities(),
        detectedAt: new Date().toISOString(),
      });
    });
  });
}
