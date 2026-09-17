/**
 * 适配器注册表：Codex 优先（首选机床），其后 Qoder / Kimi / Claude Code / ZAI / Aider，
 * 末尾追加客户自定义声明式工具（~/.workloom/devtools/*.yml 热加载）。
 * 顺序即默认选派优先级（能力匹配同分时，排前者上）。
 */
import type { CodingToolAdapter } from "../types.js";
import { loadDeclarativeAdapters } from "../declarative.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { AiderAdapter } from "./aider.js";
import { builtinSpecAdapters } from "./builtin-specs.js";

export { builtinSpecAdapters } from "./builtin-specs.js";

/** 内置机床（不含自定义） */
export function builtinAdapters(): CodingToolAdapter[] {
  return [new CodexAdapter(), ...builtinSpecAdapters(), new ClaudeCodeAdapter(), new AiderAdapter()];
}

/** 全量机床 = 内置 + 客户自定义（声明式标准协议；坏文件跳过不影响整体） */
export function defaultAdapters(): CodingToolAdapter[] {
  const builtin = builtinAdapters();
  const { adapters } = loadDeclarativeAdapters();
  const builtinKeys = new Set(builtin.map((a) => a.toolKey));
  const custom = adapters.filter((a) => !builtinKeys.has(a.toolKey));   // 同名内置优先，防覆盖内置纪律
  return [...builtin, ...custom];
}

export { CodexAdapter, ClaudeCodeAdapter, AiderAdapter };
