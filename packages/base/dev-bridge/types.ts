/**
 * dev-bridge · 类型契约（开发场域 DevFabric 设备适配层）
 * 分层纪律：AI Coding CLI 是「机床」（设备层），不是数字员工——
 * 适配器只负责"说同一种语言"，权责在岗位层（开发总指挥/发布守护）。
 */

/** 已探测到的本机设备安装台账条目 */
export interface ToolInstall {
  toolKey: string;                 // "codex" | "claude-code" | "aider"
  binPath: string;                 // 可执行文件绝对路径
  version: string;                 // --version 握手结果原文（截断）
  capabilities: ToolCapabilities;
  detectedAt: string;              // ISO 时间
}

export interface ToolCapabilities {
  headless: boolean;               // 支持非交互一次性执行
  streamEvents: "jsonl" | "text";  // 事件流形态
  sessionResume: boolean;          // 支持会话续跑（返修回路用）
  sandboxFlag: boolean;            // 自带沙箱旗标（如 codex --sandbox）
}

/** 开发任务单（S2 产物，传给机床的全部输入） */
export interface DevTaskSpec {
  taskId: string;
  prompt: string;                  // 任务书（buildTaskPrompt 生成）
  worktreePath: string;            // 隔离工作区（机床 cwd，路径钳制）
  maxTurns?: number;               // 轮次上限（aider 不适用）
  timeoutMs: number;               // 熔断：超时
  maxFenceDenials: number;         // 熔断：连续围栏拦截上限
  resumeId?: string;               // 续跑会话 ID（返修第 2 轮起）
  extraEnv?: Record<string, string>; // 凭据注入（L4：由服务端组装，适配器原样透传）
}

/** 归一化会话事件（三家工具的事件流统一成这一种语言） */
export type DevEvent =
  | { type: "started"; pid: number; threadId?: string }
  | { type: "progress"; text: string }
  | { type: "file_edited"; path: string }
  | { type: "command_run"; cmd: string; status: "in_progress" | "done"; exitCode?: number }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "done"; summary: string }
  | { type: "error"; message: string };

/** 会话终态 */
export interface SessionResult {
  exitCode: number | null;
  exitReason: "done" | "error" | "timeout" | "fence_break" | "canceled";
  lastMessage: string;             // 机床自总结（-o 文件或末条 agent_message）
  threadId?: string;               // 供续跑
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/** 变更回收（S4 输入） */
export interface Changeset {
  diffStat: string;                // git diff --stat 原文
  files: Array<{ path: string; added: number; deleted: number }>;
  untracked: string[];
  selfSummary: string;
}

/** 设备适配器协议 */
export interface CodingToolAdapter {
  readonly toolKey: string;
  readonly displayName: string;
  /** PATH 探测 + 版本握手；未安装返回 null（绝不假装） */
  detect(): Promise<ToolInstall | null>;
  capabilities(): ToolCapabilities;
  /** 组装 argv（纯函数，可测）；prompt 走最后一个位置参数 */
  buildArgs(task: DevTaskSpec): string[];
  /** 单行 stdout → 归一化事件（null=忽略该行） */
  parseLine(line: string): DevEvent | null;
  /** 可执行文件名（PATH 查找用） */
  binName(): string;
}
