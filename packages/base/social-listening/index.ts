/**
 * social-listening —— 监控与评论底座包（fusion-design §2.2 经营班组 / §3 G10 / §4 account-ops）
 * 范围：账号/视频指标采集落账（account_metrics 时序）+ 阈值告警 + 早八点战报
 *      （night-shift 调度对接预留）+ 评论采集 → 意图分类（LLM 注入 + 规则兜底）
 *      → G10 三级分流 → 候选回复 → 外发回执。
 * 纪律：一切写入经 workdata 安全网关落五元事件（D16 同一 COMMIT）。
 */
export * from "./metrics.js";
export * from "./comments.js";
