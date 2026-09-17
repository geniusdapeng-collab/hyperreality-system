/**
 * inspection —— 巡检中心（L2 Base Bundle 六插件之六「感知巡检」，M9）｜ IM 本体：主动消息
 * B10 范围：定时只读巡检（F9.1/L9.1）+ 异常分级推送（F9.2/G3/E9.2）+ 失败必出事件不静默（L9.2/E9.1）
 *        + 一键派单与回链（F9.3/E9.3）+ 巡检状态条纯投影（F9.4）+ 幂等去重（L9.3）
 * 调度挂接：默认每日 07:00（INSPECTION_DEFAULT_TIME），由触发器引擎（B9/F4.7）cron 入口唤起。
 */
export * from "./checks.js";
export * from "./scan.js";
export * from "./dispatch.js";
export * from "./status.js";
