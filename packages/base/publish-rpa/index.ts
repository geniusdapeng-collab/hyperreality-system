/**
 * publish-rpa —— 全平台 RPA 发布底座包（fusion-design §7，新增底座包，H-15 零改动既有包）
 * 范围：PublishTask/PublishReceipt zod schema + 六平台适配器（douyin/xiaohongshu/bilibili/youtube
 *      参考实现，tiktok/shipinhao 接口占位需真实账号环境联调）+ 执行器（G9 围栏预检、
 *      单账号日上限、失败挂起转人工、回执落五元事件）。
 * 纪律：不 import playwright——适配器只依赖注入的 BrowserDriver 接口。
 */
export * from "./types.js";
export * from "./adapters/base.js";
export * from "./adapters/douyin.js";
export * from "./adapters/xiaohongshu.js";
export * from "./adapters/bilibili.js";
export * from "./adapters/youtube.js";
export * from "./adapters/tiktok.js";
export * from "./adapters/shipinhao.js";
export * from "./runner.js";
