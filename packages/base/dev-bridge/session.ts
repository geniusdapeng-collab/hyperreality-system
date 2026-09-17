/**
 * 会话管理器：受管子进程生命周期（spawn 无 shell / 行缓冲事件流 / 三重熔断 / 取消）
 * 三重熔断：超时 / 连续围栏拦截 / 进程异常退出。
 * 围栏判定针对工具"自报"的命令流；硬约束另有两层：codex --sandbox workspace-write
 * 与 worktree 路径钳制（机床 cwd 即隔离区）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import type { CodingToolAdapter, DevEvent, DevTaskSpec, SessionResult } from "./types.js";
import { judgeCommand } from "./fence.js";

export interface SessionHooks {
  onEvent?: (ev: DevEvent) => void | Promise<void>;
  /** 围栏裁决留痕（deny/escalate 才会回调） */
  onFenceVerdict?: (cmd: string, verdict: "deny" | "escalate", ruleId?: string, note?: string) => void | Promise<void>;
}

export interface RunningSession {
  sessionId: string;
  taskId: string;
  toolKey: string;
  proc: ChildProcess;
  startedAt: Date;
  cancel: () => void;
  result: Promise<SessionResult>;
}

const KILL_GRACE_MS = 5000;

export function startSession(
  adapter: CodingToolAdapter,
  binPath: string,
  task: DevTaskSpec,
  hooks: SessionHooks = {},
): RunningSession {
  const sessionId = `ds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const args = adapter.buildArgs(task);
  const env = { ...process.env, ...task.extraEnv };
  const proc = spawn(binPath, args, {
    cwd: task.worktreePath,
    env,
    shell: false,               // 纪律：无 shell，argv 原样传递，注入面为零
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buf = "";
  let stderrBuf = "";
  let lastMessage = "";
  let threadId: string | undefined = task.resumeId;
  let consecutiveFenceDenials = 0;
  let settled = false;
  let exitReason: SessionResult["exitReason"] = "error";
  let usage: SessionResult["usage"];
  let timedOut = false;
  let fenceBroken = false;
  let canceled = false;

  const emit = async (ev: DevEvent) => { await hooks.onEvent?.(ev); };

  const kill = (signal: NodeJS.Signals) => {
    try { proc.kill(signal); } catch { /* 已退出 */ }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, task.timeoutMs);
  timer.unref();

  const handleLine = async (line: string) => {
    const ev = adapter.parseLine(line);
    if (!ev) return;
    if (ev.type === "started" && ev.threadId) threadId = ev.threadId;
    if (ev.type === "done") { lastMessage = ev.summary || lastMessage; }
    if (ev.type === "progress") lastMessage = ev.text || lastMessage;   // aider 无 done：末条叙述兜底
    if (ev.type === "usage") usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, costUsd: ev.costUsd };
    if (ev.type === "command_run" && ev.status === "in_progress") {
      const v = judgeCommand(ev.cmd);
      if (v.verdict !== "allow") {
        consecutiveFenceDenials += 1;
        await hooks.onFenceVerdict?.(ev.cmd, v.verdict, v.ruleId, v.note);
        if (consecutiveFenceDenials >= task.maxFenceDenials) {
          fenceBroken = true;
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
        }
      } else {
        consecutiveFenceDenials = 0;   // 连续计数：有正常命令即清零
      }
    }
    await emit(ev);
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      void handleLine(line);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-8000);   // 只留尾部，防内存膨胀
  });

  const result = new Promise<SessionResult>((resolve) => {
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 冲刷行缓冲尾巴
      if (buf.trim()) void handleLine(buf);
      // codex 的自总结落盘文件优先（结构化出口）
      const lastMsgFile = `${task.worktreePath}/.workloom-last-message.md`;
      if (existsSync(lastMsgFile)) {
        try { lastMessage = readFileSync(lastMsgFile, "utf8").trim() || lastMessage; } catch { /* 忽略 */ }
      }
      if (canceled) exitReason = "canceled";
      else if (timedOut) exitReason = "timeout";
      else if (fenceBroken) exitReason = "fence_break";
      else if (code === 0) exitReason = "done";
      else exitReason = "error";
      if (exitReason === "error" && !lastMessage && stderrBuf) {
        lastMessage = `（进程退出码 ${code}）${stderrBuf.trim().slice(-500)}`;
      }
      resolve({ exitCode: code, exitReason, lastMessage: lastMessage.slice(0, 4000), threadId, usage });
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, exitReason: "error", lastMessage: `spawn 失败：${err.message}`, threadId });
    });
  });

  return {
    sessionId,
    taskId: task.taskId,
    toolKey: adapter.toolKey,
    proc,
    startedAt: new Date(),
    cancel: () => {
      canceled = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
    },
    result,
  };
}
