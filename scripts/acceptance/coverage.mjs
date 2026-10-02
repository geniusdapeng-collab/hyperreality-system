#!/usr/bin/env node
/** RDAS fixed 276-item coverage. A file or aggregate success is never an item pass. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cliArgs, findRepoRoot, loadProfile } from "./lib/profile.mjs";
import { acceptanceContext, collectCoverage } from "./lib/evidence.mjs";

const args = cliArgs(); const repoRoot = findRepoRoot();
const value = (flag) => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(value("--root") ?? join(repoRoot, "outputs/acceptance"));
const out = resolve(value("--out") ?? join(root, "coverage.json"));
const context = acceptanceContext(repoRoot, root, value("--checklist"));
let profileWarnings = [];
try { profileWarnings = loadProfile(repoRoot, args.profilePath).warnings; } catch (error) { context.errors.push(`Profile 无法加载：${error.name}`); }
const summary = { ...collectCoverage(context), root, profileWarnings };
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
const md = ["# RDAS v3.1 覆盖率报告", "", `- 固定检查单：276 项；提交：${summary.commit ?? "未知"}；状态：${summary.status}`, `- 状态分布：${JSON.stringify(summary.totals.byStatus)}`, "", "| ID | 检查项 | 状态 | 原因 |", "|---|---|---|---|"];
for (const item of summary.items) md.push(`| ${item.id} | ${item.title.replace(/\|/g, "/")} | ${item.status} | ${item.note.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
if (summary.errors.length) md.push("", "全局证据缺口：", ...summary.errors.map((e) => `- ${e}`));
writeFileSync(join(dirname(out), "coverage.md"), `${md.join("\n")}\n`);
console.log(`[acceptance:coverage] ${summary.totals.items} 项；状态 ${summary.status} ${JSON.stringify(summary.totals.byStatus)}；输出 ${out}`);
process.exitCode = summary.status === "pass" ? 0 : summary.status === "fail" ? 1 : 2;
