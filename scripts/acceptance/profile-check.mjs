#!/usr/bin/env node
/**
 * profile-check.mjs · 校验本仓 acceptance/profile.json（RDAS v1）
 * 退出码：0 = 可用（可能有告警）；1 = 不可用（缺关键字段）。
 * 用法：pnpm acceptance:profile:check
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THRESHOLD_FLOORS, cliArgs, findRepoRoot, loadProfile } from "./lib/profile.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const path = join(REPO_ROOT, "acceptance", "profile.json");
const { isDefault, warnings, profile } = loadProfile(REPO_ROOT, args.profilePath);

const errors = [];
if (!existsSync(path) && !args.profilePath) errors.push(`缺少 ${path}（可复制 docs/acceptance/profile.example.json 起步）`);
if (!profile.primaryBundle) errors.push("缺少 primaryBundle（组合主包目录名）");
// 工作区二选一：显式 id，或 identity.workspaceSlug（执行器会连库解析 id）
if (!profile.workspaceId && !profile.identity?.workspaceSlug) errors.push("缺少 workspaceId，也没有 identity.workspaceSlug（执行器需要其中一个才能定位演示工作区）");
if (!profile.identity?.human) errors.push("缺少 identity.human（演示成员号）");
if (!Array.isArray(profile.surfaces?.pcRoutes) || profile.surfaces.pcRoutes.length === 0) errors.push("surfaces.pcRoutes 不能为空");
if (!Array.isArray(profile.journeys) || profile.journeys.length === 0) errors.push("journeys 不能为空（可用内置 builtin:* 清单）");

const manifest = (() => {
  try { return JSON.parse(readFileSync(join(REPO_ROOT, "product.manifest.json"), "utf-8")); } catch { return null; }
})();
if (manifest && profile.repo && manifest.repository && profile.repo !== manifest.repository) {
  warnings.push(`profile.repo=${profile.repo} 与 product.manifest.repository=${manifest.repository} 不一致`);
}

console.log(`[acceptance:profile] ${profile.productName ?? "(未命名)"} @ ${profile.repo ?? "(未命名)"} · lane=${profile.lane ?? "?"}`);
console.log(`  主包 ${profile.primaryBundle ?? "?"} · 工作区 ${profile.workspaceId ?? "?"} · 走查 ${profile.journeys.length} 条 · 路由 PC ${profile.surfaces.pcRoutes.length} / B ${profile.surfaces.bMobileRoutes.length} / C ${profile.surfaces.cRoutes.length}`);
console.log(`  阈值：${Object.entries(profile.thresholds).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`  基座下限：${Object.entries(THRESHOLD_FLOORS).map(([k, v]) => `${k}=${v}`).join(" ")}`);
for (const warning of warnings) console.log(`  ⚠ ${warning}`);
for (const error of errors) console.log(`  ✗ ${error}`);
if (isDefault) console.log("  ⚠ 当前使用基座默认 profile：角色/旅程/阈值可能不反映本仓业务");
console.log(errors.length ? "[acceptance:profile] 不可用：请补齐上述字段" : "[acceptance:profile] 可用");
if (errors.length) process.exitCode = 1;
