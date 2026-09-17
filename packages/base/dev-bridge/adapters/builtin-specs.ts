/**
 * 内置声明式机床：Kimi Code / Qoder / ZAI（GLM 生态）
 * 三家 CLI 形态均按 2026 现行官方文档核实：
 *  - Kimi Code（月之暗面）：kimi -p "<任务书>" --output-format stream-json
 *    （非交互固定 auto 权限；stream-json 为 JSONL，assistant 消息可带 OpenAI 风格 tool_calls；
 *      续跑 --session <id>）
 *  - Qoder CLI（阿里巴巴）：qoder -p "<任务书>" --output-format stream-json
 *    --permission-mode accept_edits --max-turns N（续跑 --session-id <id>；
 *    凭据 env QODER_PERSONAL_ACCESS_TOKEN）
 *  - ZAI CLI（GLM 生态）：zai -p "<任务书>"（headless 自动批准；stdout 末尾输出 JSON 结果对象；
 *    凭据 env ZAI_API_KEY）——官方 GLM Coding Plan 亦可经 Claude Code/Codex 端点接入，
 *    本适配器覆盖 z.ai 生态 CLI 形态。
 * 内置即声明式：与客户自定义工具走同一套标准协议（狗食纪律）。
 */
import { DeclarativeAdapter, type DeclarativeToolSpec } from "../declarative.js";

export const KIMI_SPEC: DeclarativeToolSpec = {
  tool_key: "kimi-code",
  display_name: "Kimi Code（月之暗面）",
  bin: "kimi",
  capabilities: { sessionResume: true },
  args: ["-p", "{{prompt}}", "--output-format", "stream-json"],
  resume_args: ["--session", "{{resume_id}}", "-p", "{{prompt}}", "--output-format", "stream-json"],
  env: { MOONSHOT_API_KEY: ["moonshot", "kimi"], KIMI_API_KEY: ["kimi", "moonshot"] },
  output: { protocol: "claude-stream-json" },   // kimi 变体（assistant+tool_calls）已在共享解析器兼容
  install_hint: "npm i -g @moonshot-ai/kimi-code（装后 kimi login 登录）",
};

export const QODER_SPEC: DeclarativeToolSpec = {
  tool_key: "qoder",
  display_name: "Qoder CLI（阿里巴巴）",
  bin: "qoder",
  capabilities: { sessionResume: true },
  args: ["-p", "{{prompt}}", "--output-format", "stream-json", "--permission-mode", "accept_edits", "--max-turns", "{{max_turns}}"],
  resume_args: ["-p", "{{prompt}}", "--output-format", "stream-json", "--permission-mode", "accept_edits", "--max-turns", "{{max_turns}}", "--session-id", "{{resume_id}}"],
  env: { QODER_PERSONAL_ACCESS_TOKEN: ["qoder", "alibaba"] },
  output: { protocol: "claude-stream-json" },
  install_hint: "npm i -g @qoder-ai/qodercli（装后 qoder 登录或配 QODER_PERSONAL_ACCESS_TOKEN）",
};

export const ZAI_SPEC: DeclarativeToolSpec = {
  tool_key: "zai",
  display_name: "ZAI CLI（GLM 生态）",
  bin: "zai",
  version_args: ["-V"],
  capabilities: { sessionResume: false },
  args: ["-p", "{{prompt}}"],
  env: { ZAI_API_KEY: ["zai", "zhipu", "glm"] },
  output: { protocol: "json-result" },
  install_hint: "npm i -g @guizmo-ai/zai-cli（配 ZAI_API_KEY；或用 GLM Coding Plan 接 Claude Code/Codex）",
};

export function builtinSpecAdapters(): DeclarativeAdapter[] {
  return [new DeclarativeAdapter(QODER_SPEC), new DeclarativeAdapter(KIMI_SPEC), new DeclarativeAdapter(ZAI_SPEC)];
}
