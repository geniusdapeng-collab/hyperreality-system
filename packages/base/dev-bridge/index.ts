/**
 * dev-bridge —— 开发场域（DevFabric）设备适配层
 * 把本机 AI Coding CLI（Codex/Claude Code/Aider…）当作受管「机床」：
 * 探测台账 / 统一会话协议 / worktree 隔离 / 命令围栏 / 变更回收 / 版本建议。
 */
export * from "./types.js";
export * from "./detect.js";
export * from "./fence.js";
export * from "./worktree.js";
export * from "./session.js";
export * from "./semver.js";
export * from "./prompt.js";
export * from "./declarative.js";
export * from "./adapters/index.js";
