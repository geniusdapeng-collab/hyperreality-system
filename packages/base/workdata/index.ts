/**
 * WorkData（workdata）—— 数据总线核心插件（核心底座）（L2 Base Bundle 六插件之一，纯服务层不碰 HTTP）
 * B1 范围：安全网关三段瀑布 + 事件 append + 哈希链 + 幂等（F1.1/F1.2/L1.4）
 * B2 范围：事件检索——结构化过滤 + NL 入口薄自译 + 超时降级（F1.3/E1.6）
 * B3 范围：组织记忆——三级作用域 + 归因 + pgvector 检索 + 使用记录（F1.4/F6.1）
 */
export * from "./gateway.js";
export * from "./events.js";
export * from "./event-sequence.js";
export * from "./pii.js";
export * from "./recall.js";
export * from "./memory.js";
