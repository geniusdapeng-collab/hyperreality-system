/**
 * 多桥执行器注册表回归（GR-15）。
 * 重点守一条真机缺陷（2026-09-28 生产态验收）：桥缓存必须**按作用域分桶**——
 * 否则第二个工作区会复用第一个工作区的 tenantId 绑定，被工位以 tenant_mismatch 拒绝。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeToolCoverage, loadDeploymentToolExecutor, parseBridgeSpecs, resetToolExecutorCache, toolMatchesPattern } from "./tool-executor.js";

function writeBridgeModule(): string {
  const dir = mkdtempSync(join(tmpdir(), "wl-bridge-"));
  const file = join(dir, "executor.mjs");
  writeFileSync(file, `
export const TOOL_PATTERNS = ["demo.*"];
export function createDemoExecutor(cfg) {
  return async (name, params) => ({
    result: { state: "ok", tenant: cfg.tenantId, name, params },
    receipt: { synced: true },
  });
}
`);
  return file;
}

afterEach(() => {
  delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
  resetToolExecutorCache();
});

describe("多桥执行器注册表（GR-15）", () => {
  it("规格解析支持 :: 分隔（Node --env-file 会把 # 当注释截断）", () => {
    const specs = parseBridgeSpecs("/tmp/a.ts::createA::visualwrite.*|visualread.*::http://127.0.0.1:9773");
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      modulePath: "/tmp/a.ts", factoryName: "createA",
      patterns: ["visualwrite.*", "visualread.*"], baseUrlOverride: "http://127.0.0.1:9773",
    });
  });

  it("工具名模式匹配：精确名 / 前缀通配", () => {
    expect(toolMatchesPattern("visualwrite.generate", "visualwrite.*")).toBe(true);
    expect(toolMatchesPattern("visualwrite.generate", "visualread.*")).toBe(false);
    expect(toolMatchesPattern("pms.price.write", "pms.price.write")).toBe(true);
  });

  it("桥缓存按作用域分桶：两个工作区各自绑定自己的 tenantId", async () => {
    const file = writeBridgeModule();
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `${file}::createDemoExecutor::demo.*`;
    const wsA = { tenantId: "tenant-a", workspaceId: "ws-a" };
    const wsB = { tenantId: "tenant-b", workspaceId: "ws-b" };
    const execA = await loadDeploymentToolExecutor(wsA);
    const execB = await loadDeploymentToolExecutor(wsB);
    expect(execA).toBeTruthy();
    expect(execB).toBeTruthy();
    const [outA, outB] = await Promise.all([execA!("demo.run", {}), execB!("demo.run", {})]);
    expect((outA.result as { tenant: string }).tenant).toBe("ws-a");
    expect((outB.result as { tenant: string }).tenant).toBe("ws-b");
  });

  it("无桥覆盖的工具 → connector-required（未核实语义，不伪造回执）", async () => {
    const file = writeBridgeModule();
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = `${file}::createDemoExecutor::demo.*`;
    const executor = await loadDeploymentToolExecutor({ tenantId: "t", workspaceId: "ws" });
    const out = await executor!("other.tool", {});
    expect(out.receipt.synced).toBe(false);
    expect(out.result).toMatchObject({ state: "connector-required", reason: "no-connector-for-tool" });
    const coverage = await describeToolCoverage({ tenantId: "t", workspaceId: "ws" }, ["demo.run", "other.tool"]);
    expect(coverage.covered).toEqual(["demo.run"]);
    expect(coverage.uncovered).toEqual(["other.tool"]);
  });

  it("未配置桥 → undefined（调用方保持底座兜底语义）", async () => {
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
    resetToolExecutorCache();
    expect(await loadDeploymentToolExecutor({ tenantId: "t", workspaceId: "ws" })).toBeUndefined();
  });
});
