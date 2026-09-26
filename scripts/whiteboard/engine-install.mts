#!/usr/bin/env tsx
/**
 * 白板渲染环境安装器（可移植版）
 *
 * 引擎脚本（上游 MIT，已打 4 处本地补丁）随仓分发在 `scripts/whiteboard/engine/`——
 * 因此本安装器**不需要联网拉源码**，只做一件事：在引擎目录建隔离 venv 并补齐 Python 依赖。
 *
 * 幂等：重复执行只补缺失项；`--check` 只探测（缺即非 0 退出，可做门禁）。
 *
 * 用法：
 *   pnpm exec tsx scripts/whiteboard/engine-install.mts [--check] [--python /path/to/python3.12]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { kitEnv } from "./lib/engine.mts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const checkOnly = process.argv.includes("--check");

/** 候选解释器（依赖闭包要求 >= 3.10：PyAV / numpy 2.x 无 cp39 macOS arm64 wheel） */
function pickPython(): string {
  const explicit = arg("--python") || process.env.WHITEBOARD_PYTHON_BOOTSTRAP || "";
  const candidates = [
    ...(explicit ? [explicit] : []),
    "python3.12", "python3.13", "python3.11", "python3.10", "python3", "python",
    "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3",
  ];
  const tried: string[] = [];
  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate, ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
        { encoding: "utf8", timeout: 20_000 }).trim();
      const [maj, min] = out.split(".").map(Number);
      if ((maj ?? 0) > 3 || ((maj ?? 0) === 3 && (min ?? 0) >= 10)) return candidate;
      tried.push(`${candidate} → ${out}`);
    } catch { /* 继续下一个 */ }
  }
  throw new Error(`找不到 >= 3.10 的 Python（依赖闭包硬约束）。已探测：${tried.join("；") || "无"}\n`
    + "  修复：装 python3.12，或用 --python <路径> 指定。");
}

function main(): void {
  const cfg = kitEnv();
  const prepare = join(cfg.engineDir, "scripts/prepare_env.py");
  if (!existsSync(prepare)) {
    console.error(`引擎脚本缺失：${prepare}\n  （scripts/whiteboard/engine/ 应随仓分发；见 scripts/whiteboard/PINNED.md）`);
    process.exit(1);
  }
  const python = pickPython();
  console.log(`[..] 引导解释器：${python}`);
  try {
    process.stdout.write(execFileSync(python, [prepare, ...(checkOnly ? ["--check"] : [])],
      { encoding: "utf8", timeout: 30 * 60_000 }));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    process.stdout.write(e.stdout ?? "");
    process.stderr.write(e.stderr ?? e.message ?? "");
    process.exit(1);
  }
  if (!existsSync(cfg.python)) {
    console.error(`venv 解释器仍未就绪：${cfg.python}`);
    process.exit(1);
  }
  console.log(`\nENV_PY=${cfg.python}`);
  console.log("下一步：pnpm exec tsx scripts/whiteboard/film.mts --script <口播稿.md> --title <标题>");
}

try {
  main();
} catch (err) {
  console.error(`[失败] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
