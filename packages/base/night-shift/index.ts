/**
 * night-shift —— AI 夜班班组与自动化引擎（L2 Base Bundle 六插件之三，M4）
 * B9 范围：18:00 候选清单（F4.1）+ 状态机（F4.8 含围栏快照 F2.6）+ 一键暂停（F4.3/G5/E4.1）
 *        + 08:30 决策包三段投影（F4.4/H-7 纯日志视图）+ 触发器引擎（F4.7/L4.4）
 * 手势回流校准（F4.5）复用 B6 decide 的记忆校准链路；峰谷联动（F4.6）复用 B7 计量口径。
 */
export * from "./candidates.js";
export * from "./scheduler.js";
export * from "./package.js";
export * from "./triggers.js";
