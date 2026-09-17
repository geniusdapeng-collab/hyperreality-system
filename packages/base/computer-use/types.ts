/**
 * computer-use · 类型定义
 *
 * 生产级"电脑/浏览器自动操作"能力——与开发沙箱同栈（Xvfb + Chromium CDP + AT-SPI + xdotool），
 * 用于专用工作站/宿主机部署，让数字员工在生产环境拥有"手"。
 *
 * 三层感知架构（与沙箱一致）：L1 Playwright(CDP) DOM 级零 token →
 * L2 AXTree(AT-SPI) 语义级零 token → L3 截图+视觉 像素级兜底（高 token）。
 */

/** 感知层 */
export type PerceptionLayer = "L1" | "L2" | "L3";

/** 动作请求（与 toolkit computer_tool.py 的 JSON 入参一致） */
export interface ComputerAction {
  action: string;
  [key: string]: unknown;
}

/** 动作结果（toolkit 返回的 JSON 原文 + 统一包装） */
export interface ComputerResult<T = unknown> {
  ok: boolean;
  action: string;
  /** toolkit 原始返回（已 JSON.parse；解析失败时为 raw 文本） */
  data: T | string;
  /** 耗时 ms */
  ms: number;
  /** ok=false 时的错误摘要 */
  error?: string;
}

/** toolkit 调用选项 */
export interface RunOptions {
  /** 单次动作超时 ms（默认 60_000） */
  timeoutMs?: number;
  /** 附加环境变量（覆盖 DISPLAY/CDP_PORT 等） */
  env?: Record<string, string>;
}

/** 预检/生命周期脚本结果 */
export interface LifecycleResult {
  ok: boolean;
  /** 脚本标准输出尾部（便于排错） */
  tail: string;
  ms: number;
}

/** 已注册动作描述（来自 toolkit registry） */
export interface ActionSpec {
  name: string;
  layer: PerceptionLayer;
  category: string;
  desc: string;
}
