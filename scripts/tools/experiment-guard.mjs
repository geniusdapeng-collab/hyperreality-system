#!/usr/bin/env node
/**
 * 实验车道护栏：确保实验仓（fox / growth 等）的深度定制不会被同步覆盖、也不会卡死 UI 升级。
 * 用法：
 *   node scripts/tools/experiment-guard.mjs            # 人读报告
 *   node scripts/tools/experiment-guard.mjs --json      # 机器可读
 *   node scripts/tools/experiment-guard.mjs --check     # 有违规则退出码 1（每日 cron 用）
 *   node scripts/tools/experiment-guard.mjs --self-test
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditExperimentLane } from "./experiment-rules.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

function selfTest() {
  const children = [{
    repo: "org/fox",
    lane: "experiment",
    experimentNote: "试验田",
    experimentPaths: ["apps/web/src/campaign/**"],
    industryExtensionPaths: ["apps/*/src/campaign/**"],
  }];
  const scope = (overrides = {}) => ({ include: ["packages/base/**"], clientFoundationCapability: { industryExtensionPaths: [] }, ...overrides });
  const safe = auditExperimentLane({ children, baseScope: scope() });
  const unsafeSync = auditExperimentLane({ children, baseScope: scope({ include: ["apps/web/**"] }) });
  const noExtension = [{ ...children[0], industryExtensionPaths: [] }];
  const unsafeUi = auditExperimentLane({ children: noExtension, baseScope: scope() });
  const ok = safe.length === 0
    && unsafeSync.some((item) => item.code === "SYNC_WOULD_OVERWRITE")
    && unsafeUi.some((item) => item.code === "UI_UPGRADE_WOULD_FAIL");
  if (!ok) {
    console.error("✗ self-test 失败", JSON.stringify({ safe, unsafeSync, unsafeUi }, null, 2));
    process.exit(1);
  }
  console.log("✓ experiment-guard self-test 通过（合规 1 例 + 违规 2 例）");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const baseScope = read("sync/base-scope.json");
  const childRepos = read("sync/child-repos.json");
  const findings = auditExperimentLane({ children: childRepos.children ?? [], baseScope });
  const experiments = (childRepos.children ?? []).filter((child) => child.lane === "experiment");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ experiments: experiments.map((child) => child.repo), findings }, null, 2));
  } else {
    console.log(`实验车道仓：${experiments.map((child) => child.repo).join(", ") || "（无）"}`);
    if (!findings.length) console.log("✓ 实验路径全部安全：既不会被 base-sync 覆盖，也在 UI 升级白名单内");
    for (const item of findings) console.error(`✗ [${item.code}] ${item.repo} ${item.path} :: ${item.message}`);
  }
  if (process.argv.includes("--check") && findings.length) process.exit(1);
}

main();
