/**
 * computer-use · ComputerDriver seam（驱动接口缝）
 *
 * 与 publish-rpa 的 BrowserDriver 同一架构思想：上层业务只依赖接口，
 * 驱动实现按环境注入——工作站注入本实现（ToolkitDriver），测试注入内存 fake。
 *
 * 能力分层（对齐沙箱）：
 *   L1 browser.*  —— DOM 级精确操作（零 token，首选）
 *   L2 desktop.*  —— AT-SPI 语义树（所有 GUI 应用）
 *   L3 pixel.*    —— 截图 + 像素级键鼠（兜底，高 token）
 * 增强项（超出沙箱）：
 *   browser.waitResponse —— 等待指定接口返回（对账式断言）
 *   session 持久化       —— 浏览器 profile 落盘（工作站常驻登录态）
 */
import { runAction } from "./client.js";
import type { ComputerResult, RunOptions } from "./types.js";

export interface ComputerDriver {
  // ---- L1 浏览器域 ----
  browserGoto(url: string): Promise<ComputerResult>;
  browserSnapshot(rootSelector?: string): Promise<ComputerResult>;
  browserClick(selector: string, opts?: { button?: "left" | "right" | "middle"; force?: boolean }): Promise<ComputerResult>;
  browserFill(selector: string, value: string): Promise<ComputerResult>;
  browserGetText(selector: string): Promise<ComputerResult>;
  browserUrl(): Promise<ComputerResult>;
  browserEval(expression: string): Promise<ComputerResult>;
  browserWaitResponse(urlPattern: string, timeoutMs?: number): Promise<ComputerResult>;
  browserScreenshot(opts?: { format?: "png" | "jpeg"; quality?: number }): Promise<ComputerResult>;
  // ---- L2 语义域 ----
  accessibilityTree(appName?: string): Promise<ComputerResult>;
  // ---- L3 像素域 ----
  screenshot(): Promise<ComputerResult>;
  leftClick(x: number, y: number): Promise<ComputerResult>;
  type(text: string): Promise<ComputerResult>;
  key(keys: string): Promise<ComputerResult>;
  // ---- 生命周期 ----
  ensureReady(): Promise<boolean>;
}

/** 基于包内 toolkit 的生产驱动实现 */
export class ToolkitDriver implements ComputerDriver {
  constructor(private readonly opts: RunOptions = {}) {}

  private run<T = unknown>(action: string, params: Record<string, unknown> = {}) {
    return runAction<T>({ action, ...params }, this.opts);
  }

  browserGoto(url: string) {
    return this.run("browser_goto", { url });
  }
  browserSnapshot(rootSelector?: string) {
    return this.run("browser_snapshot", rootSelector ? { root_selector: rootSelector } : {});
  }
  browserClick(selector: string, opts: { button?: "left" | "right" | "middle"; force?: boolean } = {}) {
    return this.run("browser_click", { selector, ...opts });
  }
  browserFill(selector: string, value: string) {
    return this.run("browser_fill", { selector, value });
  }
  browserGetText(selector: string) {
    return this.run("browser_get_text", { selector });
  }
  browserUrl() {
    return this.run("browser_url");
  }
  browserEval(expression: string) {
    return this.run("browser_eval", { expression });
  }
  browserWaitResponse(urlPattern: string, timeoutMs = 10) {
    return this.run("browser_wait_response", { url_pattern: urlPattern, timeout: timeoutMs });
  }
  browserScreenshot(opts: { format?: "png" | "jpeg"; quality?: number } = {}) {
    return this.run("browser_screenshot", opts);
  }
  accessibilityTree(appName?: string) {
    return this.run("accessibility_tree", appName ? { app_name: appName } : {});
  }
  screenshot() {
    return this.run("screenshot");
  }
  leftClick(x: number, y: number) {
    return this.run("left_click", { x, y });
  }
  type(text: string) {
    return this.run("type", { text });
  }
  key(keys: string) {
    return this.run("key", { keys });
  }
  /** 确认浏览器通道可用（CDP 接管成功即视为就绪） */
  async ensureReady(): Promise<boolean> {
    const r = await this.run("browser_connect");
    return r.ok;
  }
}

/**
 * publish-rpa BrowserDriver 兼容适配器（预览）。
 * hyperreality-system 的 publish-rpa/adapters/base.ts 定义了 BrowserDriver seam，
 * 本方法把 ToolkitDriver 包装成同形接口，供生产 RPA 链路直接注入——
 * 使"沙箱里验证过的发布剧本"与"工作站上的真机发布"共用同一套驱动。
 */
export function asPublishRpaDriver(driver: ComputerDriver) {
  return {
    goto: (url: string) => driver.browserGoto(url).then((r) => void assertOk(r)),
    isLoggedIn: async (pageUrl: string, loginIndicatorSelector: string) => {
      await driver.browserGoto(pageUrl);
      const r = await driver.browserEval(
        `!!document.querySelector(${JSON.stringify(loginIndicatorSelector)})`,
      );
      return r.ok && String((r.data as Record<string, unknown>)?.result ?? r.data).includes("true");
    },
    uploadFile: async (_selector: string, _path: string) => {
      throw new Error("uploadFile 需走 CDP setFileInputFiles，由工作站侧扩展实现（见 README §工作站扩展点）");
    },
    typeText: (selector: string, text: string, _opts?: { delayMs?: number }) =>
      driver.browserFill(selector, text).then((r) => void assertOk(r)),
    click: (selector: string) => driver.browserClick(selector).then((r) => void assertOk(r)),
    waitForSelector: async (selector: string, opts?: { timeoutMs?: number }) => {
      const r = await driver.browserEval(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );
      void opts;
      return r.ok && String((r.data as Record<string, unknown>)?.result ?? r.data).includes("true");
    },
    wait: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
  };
}

function assertOk(r: ComputerResult): void {
  if (!r.ok) throw new Error(`computer-use 动作失败：${r.action} —— ${r.error ?? "unknown"}`);
}
