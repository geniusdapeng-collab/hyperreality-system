/**
 * Codex CLI 适配器（首选机床·最新版 Rust CLI）
 * 调用形态（2026 现行版，官方 non-interactive 文档口径）：
 *   codex exec --json --sandbox workspace-write --skip-git-repo-check \
 *     --cd <worktree> -o <lastmsg文件> "<任务书>"
 * 纪律：
 *  - --full-auto 已废弃（官方告警），用显式 --sandbox workspace-write；
 *  - exec 非交互默认审批策略 never，不会挂起等人——天然适配无人值守；
 *  - 事件流为 JSONL：thread.started / turn.* / item.*(command_execution,
 *    agent_message, file_change, reasoning) / error；
 *  - 续跑（返修第 2 轮起）：codex exec resume <thread_id> "<任务书>"。
 */
import type { CodingToolAdapter, DevEvent, DevTaskSpec, ToolCapabilities, ToolInstall } from "../types.js";
import { probeBin } from "../detect.js";

export class CodexAdapter implements CodingToolAdapter {
  readonly toolKey = "codex";
  readonly displayName = "Codex CLI（OpenAI）";

  binName(): string { return "codex"; }

  capabilities(): ToolCapabilities {
    return { headless: true, streamEvents: "jsonl", sessionResume: true, sandboxFlag: true };
  }

  async detect(): Promise<ToolInstall | null> {
    return probeBin(this, ["--version"]);
  }

  buildArgs(task: DevTaskSpec): string[] {
    const common = [
      "--json",
      "--sandbox", "workspace-write",
      "--skip-git-repo-check",          // worktree 由我们自管，跳过前置检查
      "--cd", task.worktreePath,
      "-o", `${task.worktreePath}/.workloom-last-message.md`,
    ];
    if (task.resumeId) {
      // 返修续跑：codex exec resume <thread_id> [flags] "<prompt>"
      return ["exec", "resume", task.resumeId, ...common, task.prompt];
    }
    return ["exec", ...common, task.prompt];
  }

  parseLine(line: string): DevEvent | null {
    const s = line.trim();
    if (!s.startsWith("{")) return null;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(s) as Record<string, unknown>; } catch { return null; }
    const t = ev.type as string | undefined;
    switch (t) {
      case "thread.started":
        return { type: "started", pid: 0, threadId: ev.thread_id as string | undefined };
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = ev.item as Record<string, unknown> | undefined;
        if (!item) return null;
        const it = item.type as string;
        if (it === "command_execution") {
          return {
            type: "command_run",
            cmd: String(item.command ?? ""),
            status: t === "item.completed" ? "done" : "in_progress",
            exitCode: typeof item.exit_code === "number" ? item.exit_code : undefined,
          };
        }
        if (it === "agent_message" || it === "assistant_message") {
          if (t !== "item.completed") return null;   // 流式分片只在完成时落一条，避免刷屏
          return { type: "progress", text: String(item.text ?? "").slice(0, 2000) };
        }
        if (it === "reasoning") return null;         // 思考过程不进事件流（噪音）
        if (it === "file_change") {
          const changes = (item.changes ?? []) as Array<{ path?: string }>;
          const first = changes[0]?.path;
          return first ? { type: "file_edited", path: first } : null;
        }
        return null;
      }
      case "turn.completed": {
        const u = ev.usage as Record<string, number> | undefined;
        return u ? { type: "usage", inputTokens: u.input_tokens, outputTokens: u.output_tokens } : null;
      }
      case "turn.failed":
        return { type: "error", message: String((ev.error as Record<string, unknown>)?.message ?? "turn.failed") };
      case "error":
        return { type: "error", message: String(ev.message ?? "codex error") };
      default:
        return null;  // turn.started 等仅作心跳，不落事件
    }
  }
}
