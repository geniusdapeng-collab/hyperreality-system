/**
 * asset-cms —— 素材与成片 CMS 底座包（fusion-design §5/§6，新增底座包，H-15 零改动既有包）
 * 范围：素材服务（register/versionChain/search 语义检索预留）+ 渲染脚本管理
 *      （版本链 + G8 审批联动）+ 成片库与内容日历（状态机 draft→scheduled→published→archived）
 * 纪律：一切写入经 workdata 安全网关落五元事件（D16 同一 COMMIT）；DB 访问经注入的 pg Pool。
 */
export * from "./assets.js";
export * from "./render-scripts.js";
export * from "./cms.js";
