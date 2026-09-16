/**
 * 空态 / 骨架屏 / 告警条（设计规范 §5.10）
 * 空态：虚线框 + 星云晕染 + 图标 + 一句话引导 + 主行动按钮；副官语气（§9.1）
 * 骨架屏：分块骨架 + 流光扫过（1.4s），禁止白屏与整页转圈（G10 首屏口径）
 * 告警条由 @workloom/ui 统一提供；PC 端只做重导出，禁止维护第二套响应式实现。
 */
export { EmptyState, Skeleton } from "@workloom/ui";
export { BannerAlert } from "@workloom/ui";
export type { BannerAlertLevel as BannerLevel, BannerAlertProps } from "@workloom/ui";
