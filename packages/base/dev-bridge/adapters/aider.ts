/**
 * Aider 适配器（最新版脚本化口径）
 * 调用形态：
 *   aider --message "<任务书>" --yes-always --no-git --no-auto-commits --no-auto-lint
 * 纪律：
 *  - git 由我们自管（worktree + 快照 + 合并全在系统侧），故 --no-git；
 *  - lint/test 由 S4 硬门禁统一执行（单一关口），故 --no-auto-lint；
 *  - aider 输出为非结构化文本流：事件归一以 progress 行为主，
 *    文件级回收不依赖其输出，而由 collectChangeset 的 git diff 兜底（更可靠）。
 */
import type { CodingToolAdapter, DevEvent, DevTaskSpec, ToolCapabilities, ToolInstall } from "../types.js";
import { probeBin } from "../detect.js";

/** aider 文本流里的高信号行（编辑/命令），其余降为普通 progress */
const EDITED_RE = /^(?:Applied edit to|Created|Wrote)\s+(.+)$/i;
const CMD_RE = /^\s*[>$#]\s+(.+)$/;

export class AiderAdapter implements CodingToolAdapter {
  readonly toolKey = "aider";
  readonly displayName = "Aider（开源·多模型）";

  binName(): string { return "aider"; }

  capabilities(): ToolCapabilities {
    return { headless: true, streamEvents: "text", sessionResume: false, sandboxFlag: false };
  }

  async detect(): Promise<ToolInstall | null> {
    return probeBin(this, ["--version"]);
  }

  buildArgs(task: DevTaskSpec): string[] {
    return [
      "--message", task.prompt,
      "--yes-always",
      "--no-git",
      "--no-auto-commits",
      "--no-auto-lint",
    ];
  }

  parseLine(line: string): DevEvent | null {
    const s = line.trimEnd();
    if (!s.trim()) return null;
    const edited = EDITED_RE.exec(s);
    if (edited) return { type: "file_edited", path: edited[1]!.trim() };
    const cmd = CMD_RE.exec(s);
    if (cmd) return { type: "command_run", cmd: cmd[1]!.trim(), status: "done" };
    // 过滤 aider 的 UI 装饰行（点阵进度等）
    if (/^[.\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏-]+$/.test(s)) return null;
    return { type: "progress", text: s.slice(0, 500) };
  }
}
