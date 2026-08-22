import { describe, expect, it } from "vitest";
import { resolveGate } from "./gates.js";
import { autoApproveHandler, installConfirmationHandler } from "./confirmation.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { buildRenderScript, loadPromptLengthSpec } from "./render-scripts.js";

describe("gates 映射", () => {
  it("vendor 确认门 type 映射到业务门", () => {
    expect(resolveGate("creative-theme")).toBe("G2_THEME");
    expect(resolveGate("prd")).toBe("G4_PRD");
    expect(resolveGate("portraits")).toBe("G5_PORTRAIT");
    expect(resolveGate("prompt")).toBe("G6_PROMPT");
    expect(resolveGate("dossier")).toBe("G1_DOSSIER");
    expect(resolveGate("nonexistent")).toBe("UNKNOWN");
  });
});

describe("确认门桥", () => {
  it("注入处理器后可被 vendor 桥读取，摘除后还原", async () => {
    const handler = autoApproveHandler();
    const uninstall = installConfirmationHandler(handler);
    expect(globalThis.__HR_CONFIRMATION_HANDLER__).toBe(handler);
    const verdict = await handler({ type: "prd", content: "# PRD", runId: "r1" });
    expect(verdict.approved).toBe(true);
    uninstall();
    expect(globalThis.__HR_CONFIRMATION_HANDLER__).toBeUndefined();
  });
});

describe("LLM 适配器", () => {
  it("从环境变量构建：缺变量返回 null", () => {
    expect(WorkloomLLMEngine.fromEnv({})).toBeNull();
    const engine = WorkloomLLMEngine.fromEnv({
      LLM_BASE_URL: "https://example.invalid/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "m"
    });
    expect(engine).not.toBeNull();
    expect(engine?.model).toBe("m");
  });

  it("JSON 提取容错：围栏/前后噪声", () => {
    const extract = (WorkloomLLMEngine as unknown as { extractJson(t: string): unknown })
      .extractJson;
    expect(extract('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extract('前言{"b":2}')).toEqual({ b: 2 });
  });
});

describe("渲染脚本", () => {
  it("从 vendor 读取长度口径（唯一真源）", () => {
    const spec = loadPromptLengthSpec();
    expect(spec.hardMax).toBeGreaterThanOrEqual(3000);
    expect(spec.idealMin).toBeGreaterThan(0);
  });

  it("生成 MD 脚本：序号+独立行排版 + 口径校验", () => {
    const script = buildRenderScript(
      "p1",
      {
        shotId: "S01",
        sceneType: "establishing",
        durationSec: 8,
        promptText: "x".repeat(100),
        fields: { 语言约束: "中文", 台词: "[00:00] 主角 说:\"你好\"" },
        bindings: { heroImageId: "BRAND-HERO-001" }
      },
      1
    );
    expect(script.version).toBe(1);
    expect(script.markdown).toContain("01.【语言约束】");
    expect(script.markdown).toContain("BRAND-HERO-001");
    expect(script.charCount).toBe(100);
    expect(script.withinSpec).toBe(true);
  });
});

describe("vendor 核心可加载", () => {
  it("HyperrealitySystem 在真实 node 进程内可加载", () => {
    // vitest 的 ESM 转换会误处理 vendor 的 CJS，改用子进程验证真实运行环境
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const path = require("node:path") as typeof import("node:path");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(
      here,
      "../../../vendor/supermickey/hyperreality-system/index.js"
    );
    const out = execFileSync(
      process.execPath,
      ["-e", `const m=require(${JSON.stringify(entry)});console.log(typeof m.HyperrealitySystem)`],
      { encoding: "utf8", timeout: 30_000 }
    );
    // vendor 加载时会打印日志噪声，断言最后一行输出
    expect(out.trim().split("\n").pop()).toBe("function");
  }, 35_000);
});
