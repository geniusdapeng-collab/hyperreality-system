/**
 * 声明式适配器引擎（机床接入标准协议）
 * 命题：新 AI Coding 工具出现时，客户不写代码——放一份 YAML 到
 *   ~/.workloom/devtools/<tool>.yml（或 WORKLOOM_DEV_TOOL_DIRS 指定目录），
 *   刷新探测即接入，只要他电脑上有这个 CLI，系统就能受管调用。
 *
 * 接入标准协议（工具侧只需满足三条）：
 *   ① 非交互执行：一条命令带任务书跑完退出（headless）
 *   ② 输出可解析：stdout 为 JSONL 事件流或文本流（声明 protocol 即归一）
 *   ③ 在指定目录工作：支持 --cd/--cwd 类旗标，或接受进程 cwd（默认注入 worktree）
 *
 * YAML 契约（DeclarativeToolSpec）见下；{{prompt}} {{max_turns}} {{resume_id}} 为模板变量。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import type { CodingToolAdapter, DevEvent, DevTaskSpec, ToolCapabilities, ToolInstall } from "./types.js";
import { probeBin } from "./detect.js";

export interface DeclarativeToolSpec {
  tool_key: string;
  display_name: string;
  bin: string;
  version_args?: string[];                       // 默认 ["--version"]
  capabilities?: Partial<ToolCapabilities>;
  /** argv 模板：{{prompt}} 必填其一；{{max_turns}} {{resume_id}} 可选（无 resume_id 时该行剔除） */
  args: string[];
  /** 续跑 argv 模板（capabilities.sessionResume=true 时使用；缺省与 args 相同仅靠 {{resume_id}} 替换） */
  resume_args?: string[];
  /** 凭据映射：环境变量名 → credentials provider 候选（L4 注入） */
  env?: Record<string, string[]>;
  output: {
    protocol: "claude-stream-json" | "codex-jsonl" | "json-result" | "text";
    /** text 协议的正则映射（第一捕获组为内容） */
    text_map?: { file_edited?: string; command_run?: string };
  };
  install_hint?: string;                         // 未安装时的安装指引（P25 展示）
}

export class DeclarativeAdapter implements CodingToolAdapter {
  readonly toolKey: string;
  readonly displayName: string;
  readonly envMap: Record<string, string[]>;
  readonly installHint?: string;
  private spec: DeclarativeToolSpec;

  constructor(spec: DeclarativeToolSpec) {
    validateSpec(spec);
    this.spec = spec;
    this.toolKey = spec.tool_key;
    this.displayName = spec.display_name;
    this.envMap = spec.env ?? {};
    this.installHint = spec.install_hint;
  }

  binName(): string { return this.spec.bin; }

  capabilities(): ToolCapabilities {
    const c = this.spec.capabilities ?? {};
    return {
      headless: c.headless ?? true,
      streamEvents: this.spec.output.protocol === "text" ? "text" : "jsonl",
      sessionResume: c.sessionResume ?? false,
      sandboxFlag: c.sandboxFlag ?? false,
    };
  }

  async detect(): Promise<ToolInstall | null> {
    return probeBin(this, this.spec.version_args ?? ["--version"]);
  }

  buildArgs(task: DevTaskSpec): string[] {
    const tpl = (task.resumeId && this.spec.resume_args) ? this.spec.resume_args : this.spec.args;
    const replaced = tpl.map((a) => a
      .replaceAll("{{prompt}}", task.prompt)
      .replaceAll("{{max_turns}}", String(task.maxTurns ?? 40))
      .replaceAll("{{resume_id}}", task.resumeId ?? ""));
    // resume_id 缺省时：空值参数连同其前置旗标成对剔除（避免 dangling flag）
    const out: string[] = [];
    for (const a of replaced) {
      if (a === "") {
        if (out.length > 0 && out[out.length - 1]!.startsWith("-")) out.pop();
        continue;
      }
      out.push(a);
    }
    return out;
  }

  parseLine(line: string): DevEvent | null {
    switch (this.spec.output.protocol) {
      case "claude-stream-json": return parseClaudeStreamJson(line);
      case "codex-jsonl": return parseCodexJsonl(line);
      case "json-result": return parseJsonResult(line);
      case "text": return this.parseText(line);
    }
  }

  private parseText(line: string): DevEvent | null {
    const s = line.trimEnd();
    if (!s.trim()) return null;
    const m = this.spec.output.text_map ?? {};
    if (m.file_edited) {
      const hit = new RegExp(m.file_edited, "i").exec(s);
      if (hit) return { type: "file_edited", path: (hit[1] ?? "").trim() };
    }
    if (m.command_run) {
      const hit = new RegExp(m.command_run).exec(s);
      if (hit) return { type: "command_run", cmd: (hit[1] ?? "").trim(), status: "done" };
    }
    if (/^[.\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏-]+$/.test(s)) return null;
    return { type: "progress", text: s.slice(0, 500) };
  }
}

function validateSpec(spec: DeclarativeToolSpec): void {
  if (!spec.tool_key || !/^[a-z0-9][a-z0-9-]*$/.test(spec.tool_key)) throw new Error(`tool_key 非法：${spec.tool_key}`);
  if (!spec.display_name) throw new Error(`${spec.tool_key}: display_name 必填`);
  if (!spec.bin) throw new Error(`${spec.tool_key}: bin 必填`);
  if (!Array.isArray(spec.args) || spec.args.length === 0) throw new Error(`${spec.tool_key}: args 必填`);
  if (!spec.args.some((a) => a.includes("{{prompt}}"))) throw new Error(`${spec.tool_key}: args 须含 {{prompt}} 模板位`);
  if (!["claude-stream-json", "codex-jsonl", "json-result", "text"].includes(spec.output?.protocol)) {
    throw new Error(`${spec.tool_key}: output.protocol 须为 claude-stream-json / codex-jsonl / json-result / text`);
  }
}

/* ---------- 共享解析器（与内置适配器同口径，供声明式复用） ---------- */

export function parseClaudeStreamJson(line: string): DevEvent | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  let ev: Record<string, unknown>;
  try { ev = JSON.parse(s) as Record<string, unknown>; } catch { return null; }
  const t = ev.type as string | undefined;
  if (t === "system" && ev.subtype === "init") return { type: "started", pid: 0, threadId: ev.session_id as string | undefined };
  if (t === "assistant") {
    const msg = (ev.message ?? ev) as Record<string, unknown>;
    const content = (msg.content ?? []) as Array<Record<string, unknown>>;
    for (const c of content) {
      if (c.type === "tool_use") {
        const name = String(c.name ?? "");
        const input = (c.input ?? {}) as Record<string, unknown>;
        if (name === "Bash") return { type: "command_run", cmd: String(input.command ?? ""), status: "in_progress" };
        if (["Edit", "Write", "NotebookEdit"].includes(name)) {
          return { type: "file_edited", path: String(input.file_path ?? input.notebook_path ?? "") };
        }
        return null;
      }
      if (c.type === "text" && c.text) return { type: "progress", text: String(c.text).slice(0, 2000) };
    }
    return null;
  }
  if (t === "result") {
    if (ev.is_error) return { type: "error", message: String(ev.result ?? "error") };
    return { type: "done", summary: String(ev.result ?? "").slice(0, 4000) };
  }
  // kimi 变体：assistant 消息带 tool_calls（OpenAI 风格）
  if (t === "assistant_with_tools" || (ev.role === "assistant" && ev.tool_calls)) {
    const calls = (ev.tool_calls ?? []) as Array<Record<string, unknown>>;
    const first = calls[0];
    if (first) {
      const fn = (first.function ?? {}) as Record<string, unknown>;
      const args = String(fn.arguments ?? "");
      if (/bash|shell|run/i.test(String(fn.name))) {
        let cmd = args;
        try { cmd = String((JSON.parse(args) as { command?: string }).command ?? args); } catch { /* 原文 */ }
        return { type: "command_run", cmd, status: "in_progress" };
      }
      if (/edit|write/i.test(String(fn.name))) {
        let path = args;
        try { path = String((JSON.parse(args) as { file_path?: string }).file_path ?? args); } catch { /* 原文 */ }
        return { type: "file_edited", path };
      }
    }
    return null;
  }
  return null;
}

export function parseCodexJsonl(line: string): DevEvent | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  let ev: Record<string, unknown>;
  try { ev = JSON.parse(s) as Record<string, unknown>; } catch { return null; }
  const t = ev.type as string | undefined;
  switch (t) {
    case "thread.started": return { type: "started", pid: 0, threadId: ev.thread_id as string | undefined };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = ev.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const it = item.type as string;
      if (it === "command_execution") {
        return { type: "command_run", cmd: String(item.command ?? ""), status: t === "item.completed" ? "done" : "in_progress",
          exitCode: typeof item.exit_code === "number" ? item.exit_code : undefined };
      }
      if (it === "agent_message" || it === "assistant_message") {
        if (t !== "item.completed") return null;
        return { type: "progress", text: String(item.text ?? "").slice(0, 2000) };
      }
      if (it === "file_change") {
        const first = ((item.changes ?? []) as Array<{ path?: string }>)[0]?.path;
        return first ? { type: "file_edited", path: first } : null;
      }
      return null;
    }
    case "turn.completed": {
      const u = ev.usage as Record<string, number> | undefined;
      return u ? { type: "usage", inputTokens: u.input_tokens, outputTokens: u.output_tokens } : null;
    }
    case "turn.failed": return { type: "error", message: String((ev.error as Record<string, unknown>)?.message ?? "turn.failed") };
    case "error": return { type: "error", message: String(ev.message ?? "error") };
    default: return null;
  }
}

/** json-result 协议：非结构化过程行=progress；行可解析为 JSON 且含结果字段=done */
export function parseJsonResult(line: string): DevEvent | null {
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      const result = obj.result ?? obj.response ?? obj.message ?? obj.output;
      if (typeof result === "string" && result) {
        if (obj.error || obj.is_error) return { type: "error", message: result.slice(0, 1000) };
        return { type: "done", summary: result.slice(0, 4000) };
      }
    } catch { /* 非 JSON 行按 progress */ }
  }
  return { type: "progress", text: s.slice(0, 500) };
}

/* ---------- 自定义工具目录扫描（热加载：刷新探测即接入） ---------- */

export function customToolDirs(): string[] {
  const dirs = [join(homedir(), ".workloom", "devtools")];
  const extra = (process.env.WORKLOOM_DEV_TOOL_DIRS ?? "").split(delimiter).filter(Boolean);
  return [...extra, ...dirs];
}

/** 扫描自定义工具 YAML，返回适配器（坏文件跳过并记录原因——绝不因一个坏文件拖垮全部） */
export function loadDeclarativeAdapters(): { adapters: DeclarativeAdapter[]; errors: Array<{ file: string; reason: string }> } {
  const adapters: DeclarativeAdapter[] = [];
  const errors: Array<{ file: string; reason: string }> = [];
  for (const dir of customToolDirs()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /\.(ya?ml|json)$/i.test(x))) {
      const path = join(dir, f);
      try {
        const spec = (f.endsWith(".json") ? JSON.parse(readFileSync(path, "utf8")) : YAML.parse(readFileSync(path, "utf8"))) as DeclarativeToolSpec;
        adapters.push(new DeclarativeAdapter(spec));
      } catch (e) {
        errors.push({ file: path, reason: (e as Error).message.slice(0, 200) });
      }
    }
  }
  return { adapters, errors };
}
