/**
 * review-console —— 原生审批插件（L2 Base Bundle 六插件之四，M5 IM 原生消息类型）
 * B6 范围：统一队列（F5.1）+ 三手势回写（F5.2/F5.5，权重 1/2/3）+ 批量采纳 +
 *         快照过期检测（E5.3/F5.7）+ 幂等（L5.3）+ 高危不自动放行（L5.4）
 * 决策链路侧栏（F5.3）数据由 workdata 检索/归因服务供给；IM 卡片回调（F5.4）
 * 首版仅 inapp 本地回环（D7），外部 IM 连接器进停车场。
 */
export * from "./approvals.js";
