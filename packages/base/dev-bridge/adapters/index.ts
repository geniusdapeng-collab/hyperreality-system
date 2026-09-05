/**
 * 适配器注册表：Codex 优先（首选机床），claude-code / aider 随后。
 * 顺序即默认选派优先级（能力匹配同分时，排前者上）。
 */
import type { CodingToolAdapter } from "../types.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { AiderAdapter } from "./aider.js";

export function defaultAdapters(): CodingToolAdapter[] {
  return [new CodexAdapter(), new ClaudeCodeAdapter(), new AiderAdapter()];
}

export { CodexAdapter, ClaudeCodeAdapter, AiderAdapter };
