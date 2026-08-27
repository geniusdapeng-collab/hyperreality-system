/**
 * computer-use 单元测试（CI 安全：不依赖虚拟桌面，纯逻辑与契约测试）
 * 端到端桌面冒烟见 smoke.mjs（需图形环境，文档说明手动执行）。
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { SCRIPTS, TOOL_PATH, TOOLKIT_DIR } from "./client.js";
import { ToolkitDriver, asPublishRpaDriver, type ComputerDriver } from "./driver.js";
import type { ComputerResult } from "./types.js";

describe("toolkit 完整性（移植资产自检）", () => {
  it("computer_tool.py 在位", () => {
    expect(existsSync(TOOL_PATH)).toBe(true);
  });
  it("五件套生命周期脚本在位", () => {
    for (const p of Object.values(SCRIPTS)) expect(existsSync(p)).toBe(true);
  });
  it("模块目录在位（registry/browser/accessibility/input/screen）", () => {
    for (const m of ["registry", "browser", "accessibility", "input", "screen", "core", "stealth", "recording"]) {
      expect(existsSync(`${TOOLKIT_DIR}/modules/${m}.py`)).toBe(true);
    }
  });
  it("安装路径硬编码已参数化（COMPUTER_USE_INSTALL_DIR）", async () => {
    const { readFileSync } = await import("node:fs");
    const install = readFileSync(SCRIPTS.install, "utf-8");
    expect(install).toContain("COMPUTER_USE_INSTALL_DIR");
    expect(install).not.toMatch(/INSTALL_DIR="\/opt\/computer-use"/);
  });
});

describe("ToolkitDriver 接口面", () => {
  it("实现 ComputerDriver 全部方法", () => {
    const d: ComputerDriver = new ToolkitDriver();
    for (const m of [
      "browserGoto", "browserSnapshot", "browserClick", "browserFill", "browserGetText",
      "browserUrl", "browserEval", "browserWaitResponse", "browserScreenshot",
      "accessibilityTree", "screenshot", "leftClick", "type", "key", "ensureReady",
    ] as const) {
      expect(typeof d[m]).toBe("function");
    }
  });
});

describe("asPublishRpaDriver 适配器", () => {
  const okResult: ComputerResult = { ok: true, action: "browser_eval", data: { result: true }, ms: 1 };
  const fakeDriver: ComputerDriver = {
    browserGoto: async () => okResult,
    browserSnapshot: async () => okResult,
    browserClick: async () => okResult,
    browserFill: async () => okResult,
    browserGetText: async () => okResult,
    browserUrl: async () => okResult,
    browserEval: async () => okResult,
    browserWaitResponse: async () => okResult,
    browserScreenshot: async () => okResult,
    accessibilityTree: async () => okResult,
    screenshot: async () => okResult,
    leftClick: async () => okResult,
    type: async () => okResult,
    key: async () => okResult,
    ensureReady: async () => true,
  };

  it("暴露 publish-rpa BrowserDriver 同形接口", () => {
    const seam = asPublishRpaDriver(fakeDriver);
    for (const m of ["goto", "isLoggedIn", "uploadFile", "typeText", "click", "waitForSelector", "wait"] as const) {
      expect(typeof seam[m]).toBe("function");
    }
  });

  it("isLoggedIn/waitForSelector 经 browser_eval 判定 true", async () => {
    const seam = asPublishRpaDriver(fakeDriver);
    expect(await seam.isLoggedIn("https://example.com", ".avatar")).toBe(true);
    expect(await seam.waitForSelector(".btn", { timeoutMs: 1000 })).toBe(true);
  });

  it("动作失败时抛错（assertOk 语义）", async () => {
    const failDriver: ComputerDriver = { ...fakeDriver, browserGoto: async () => ({ ...okResult, ok: false, error: "boom" }) };
    const seam = asPublishRpaDriver(failDriver);
    await expect(seam.goto("https://example.com")).rejects.toThrow("boom");
  });
});
