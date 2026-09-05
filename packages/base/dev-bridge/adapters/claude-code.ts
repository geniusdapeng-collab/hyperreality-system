/**
 * Claude Code 适配器（最新版 headless 口径）
 * 调用形态：
 *   claude -p "<任务书>" --output-format stream-json --verbose \
 *     --permission-mode acceptEdits --allowedTools "Bash,Read,Edit,Write,Glob,Grep" \
 *     --max-turns <N>
 * 纪律：
 *  - 绝不使用 --dangerously-skip-permissions（围栏纪律：权限收束而非放行）；
 *  - acceptEdits 模式：文件编辑自动接受，越权动作仍然中止而非挂起；
 *  - 事件流为 stream-json：system(init) / assistant / user(工具结果) / result(统计)；
 *  - 续跑：--resume <session_id> -p "<prompt>"。
 */
import type { CodingToolAdapter, DevEvent, DevTaskSpec, ToolCapabilities, ToolInstall } from "../types.js";
import { probeBin } from "../detect.js";

export class ClaudeCodeAdapter implements CodingToolAdapter {
  readonly toolKey = "claude-code";
  readonly displayName = "Claude Code（Anthropic）";

  binName(): string { return "claude"; }

  capabilities(): ToolCapabilities {
    return { headless: true, streamEvents: "jsonl", sessionResume: true, sandboxFlag: false };
  }

  async detect(): Promise<ToolInstall | null> {
    return probeBin(this, ["--version"]);
  }

  buildArgs(task: DevTaskSpec): string[] {
    const args = [
      "-p", task.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep",
      "--max-turns", String(task.maxTurns ?? 40),
    ];
    if (task.resumeId) args.push("--resume", task.resumeId);
    return args;
  }

  parseLine(line: string): DevEvent | null {
    const s = line.trim();
    if (!s.startsWith("{")) return null;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(s) as Record<string, unknown>; } catch { return null; }
    const t = ev.type as string | undefined;
    if (t === "system" && ev.subtype === "init") {
      return { type: "started", pid: 0, threadId: ev.session_id as string | undefined };
    }
    if (t === "assistant") {
      const msg = ev.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
      for (const c of content) {
        if (c.type === "tool_use") {
          const name = String(c.name ?? "");
          const input = (c.input ?? {}) as Record<string, unknown>;
          if (name === "Bash") return { type: "command_run", cmd: String(input.command ?? ""), status: "in_progress" };
          if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
            return { type: "file_edited", path: String(input.file_path ?? input.notebook_path ?? "") };
          }
          return null;
        }
        if (c.type === "text" && c.text) return { type: "progress", text: String(c.text).slice(0, 2000) };
      }
      return null;
    }
    if (t === "result") {
      if (ev.is_error) return { type: "error", message: String(ev.result ?? "claude error") };
      return {
        type: "done",
        summary: String(ev.result ?? "").slice(0, 4000),
      };
    }
    return null;  // user(工具回执) 等不落事件
  }
}
