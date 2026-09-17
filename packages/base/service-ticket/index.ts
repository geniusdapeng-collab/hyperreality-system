/**
 * service-ticket —— AI 服务前台 · 工单
 * 状态机（created→assigned→processing→done→closed）/ 幂等建单 / 部门路由 / 流转留痕 / SLA 升级。
 */
export * from "./constants.js";
export * from "./state.js";
export * from "./tickets.js";
