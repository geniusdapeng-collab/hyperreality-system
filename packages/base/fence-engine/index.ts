/**
 * fence-engine —— 行动权限插件（L2 Base Bundle 六插件之二，纯服务层）
 * B4 范围：YAML DSL 装载（L2.5）+ 纯函数判定器（F2.1/E2.1/E2.2）+ 单调守卫（F2.3）
 *        + 版本化与 dry-run 回放（F2.4/F2.5/L2.4）+ 对象写锁（E2.5）
 * B8 起经 dsh tools/pre-execute 瀑布挂载
 */
export * from "./expr.js";
export * from "./judge.js";
export * from "./dsl.js";
export * from "./lifecycle.js";
