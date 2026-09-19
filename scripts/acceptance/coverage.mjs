#!/usr/bin/env node
/**
 * coverage.mjs · 检查单覆盖率与证据映射（RDAS v3.0）
 *
 * 读取 checklist.v3.json 与 outputs/acceptance/** 产物，给出逐条状态：
 *   pass / fail / evidence-present / not-run / manual-missing
 * 注意：这是**覆盖率跟踪器**，不是判定权威；最终判定以 report-v3.mjs + 人工复核为准。
 *
 * 人工项证据约定：outputs/acceptance/manual/<ID>.json（含 {pass, note, evidence[]}）。
 *
 * 用法：node scripts/acceptance/coverage.mjs [--checklist <path>] [--root <dir>] [--out <file>]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cliArgs, findRepoRoot, loadProfile } from "./lib/profile.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const ROOT = resolve(args.has("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(REPO_ROOT, "outputs", "acceptance"));
const CHECKLIST = resolve(args.has("--checklist") ? process.argv[process.argv.indexOf("--checklist") + 1] : join(REPO_ROOT, "docs", "acceptance", "checklist.v3.json"));
const OUT = resolve(args.outDir ?? join(ROOT, "coverage.json"));
const { warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath);

if (!existsSync(CHECKLIST)) throw new Error(`缺少检查单：${CHECKLIST}`);
const checklist = JSON.parse(readFileSync(CHECKLIST, "utf-8"));
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null);
const matrix = readJson(join(ROOT, "matrix", "matrix-summary.json"));
const ui = readJson(join(ROOT, "ui", "ui-probe.json"));
const experience = readJson(join(ROOT, "experience", "experience-report.json"));
const ux = readJson(join(ROOT, "ux", "ux-report.json"));
const outcome = readJson(join(ROOT, "outcome", "outcome-report.json"));
const autonomy = readJson(join(ROOT, "autonomy", "autonomy-report.json"));
const redteam = readJson(join(ROOT, "redteam", "redteam-report.json"));
const soak = readJson(join(ROOT, "soak", "soak-report.json"));
const regression = readJson(join(ROOT, "regression", "summary.json"));

const manual = (id, pass, note, evidence) => ({ id, status: pass === true ? "pass" : pass === false ? "fail" : "evidence-present", note: note ?? "人工证据", evidence: evidence ?? [] });
const expCheck = (id) => (experience?.checks ?? []).find((c) => c.id === id);
const uxCheck = (id) => (ux?.checks ?? []).find((c) => c.id === id);
const regOk = (name) => {
  const v = regression?.commands?.[name];
  return typeof v === "string" && v.startsWith("通过");
};
const hasArtifact = (x) => Boolean(x);

function statusOf(item) {
  const id = item.id;
  const manualPath = join(ROOT, "manual", `${id}.json`);
  if (existsSync(manualPath)) {
    try {
      const m = JSON.parse(readFileSync(manualPath, "utf-8"));
      return { id, status: m.pass === true ? "pass" : m.pass === false ? "fail" : "evidence-present", note: m.note ?? "人工证据", evidence: m.evidence ?? [] };
    } catch { return { id, status: "manual-missing", note: "manual 证据 JSON 解析失败", evidence: [] }; }
  }
  const layer = item.layer;
  // L0/L1
  if (layer === "L0" || layer === "L1") {
    if (!matrix) return { id, status: "not-run", note: "缺 matrix-summary.json", evidence: [] };
    const ok = matrix.counts?.agentsPass === matrix.counts?.agents && matrix.counts?.skillsPass === matrix.counts?.skills;
    return { id, status: ok ? "pass" : "fail", note: `matrix agents ${matrix.counts?.agentsPass}/${matrix.counts?.agents}；skills ${matrix.counts?.skillsPass}/${matrix.counts?.skills}`, evidence: ["matrix/matrix-summary.json"] };
  }
  // L3
  if (layer === "L3" && ui?.totals) {
    const ok = ui.totals.routesOk === ui.totals.routesChecked && (ui.totals.agentsChecked === 0 || ui.totals.agentsOk === ui.totals.agentsChecked) && (ui.totals.skillsChecked === 0 || ui.totals.skillsOk === ui.totals.skillsChecked);
    return { id, status: ok ? "pass" : "fail", note: `ui routes ${ui.totals.routesOk}/${ui.totals.routesChecked}；agents ${ui.totals.agentsOk}/${ui.totals.agentsChecked}；skills ${ui.totals.skillsOk}/${ui.totals.skillsChecked}`, evidence: ["ui/ui-probe.json"] };
  }
  // L4/L5 experience 映射
  const expMap = { "L4-01": "EXP-05", "L4-02": "EXP-02", "L4-03": "EXP-03", "L4-05": "EXP-09", "L4-06": "EXP-06", "L4-07": "EXP-07", "L5-01": "EXP-01", "L5-04": "DIM-interruption", "L5-05": "UX-U5-02" };
  if (expMap[id]) {
    const key = expMap[id];
    if (key.startsWith("UX-")) {
      const c = uxCheck(key.slice(3));
      if (c) return { id, status: c.pass ? "pass" : "fail", note: c.name, evidence: ["ux/ux-report.json"] };
    } else if (key.startsWith("DIM-")) {
      const dim = key === "DIM-interruption" ? experience?.dimensions?.interruption : null;
      if (dim) return { id, status: (dim.delta ?? 1) === 0 ? "pass" : "fail", note: `静置打扰 delta=${dim.delta}`, evidence: ["experience/experience-report.json"] };
    } else {
      const c = expCheck(key);
      if (c) return { id, status: c.pass ? "pass" : "fail", note: `${key} ${c.name}`, evidence: ["experience/experience-report.json"] };
    }
  }
  if (layer === "L5" && id === "L5-02" && experience?.dimensions?.terminology) {
    const t = experience.dimensions.terminology;
    return { id, status: (t.uiDefectHits ?? 1) === 0 ? "pass" : "fail", note: `术语 UI 缺陷 ${t.uiDefectHits}；数据污染 ${t.dataHygieneHits}`, evidence: ["experience/experience-report.json"] };
  }
  if (layer === "L5" && id === "L5-03" && experience?.dimensions?.contrast) {
    const c = experience.dimensions.contrast;
    return { id, status: (c.violationCount ?? 1) === 0 ? "pass" : "fail", note: `对比度违规 ${c.violationCount}`, evidence: ["experience/experience-report.json"] };
  }
  // U 域自动化
  const uxDirect = uxCheck(id);
  if (uxDirect) return { id, status: uxDirect.pass ? "pass" : "fail", note: uxDirect.name, evidence: ["ux/ux-report.json"] };
  // O / ADR 映射
  if (["O2-01", "O2-02", "O2-05", "O2-06", "O2-07"].includes(id)) return outcome ? { id, status: "evidence-present", note: `outcome configured=${outcome.configured ?? "?"}`, evidence: ["outcome/outcome-report.json"] } : { id, status: "not-run", note: "缺 outcome-report.json", evidence: [] };
  if (["O7-03", "O7-06", "O7-07", "ADR-03", "ADR-04", "ADR-05", "ADR-06", "ADR-07", "ADR-08", "ADR-10", "ADR-11", "ADR-12", "ADR-14"].includes(id)) return autonomy ? { id, status: "evidence-present", note: `autonomy N=${autonomy.overall?.delivered?.n ?? "?"}`, evidence: ["autonomy/autonomy-report.json"] } : { id, status: "not-run", note: "缺 autonomy-report.json", evidence: [] };
  if (id === "O6-06") return redteam ? { id, status: redteam.findings?.length ? "fail" : "evidence-present", note: `redteam cases=${redteam.cases?.length ?? "?"}`, evidence: ["redteam/redteam-report.json"] } : { id, status: "not-run", note: "缺 redteam-report.json", evidence: [] };
  if (layer === "O5") return soak ? { id, status: "evidence-present", note: `soak samples=${soak.samples?.length ?? "?"}`, evidence: ["soak/soak-report.json"] } : { id, status: "not-run", note: "缺 soak-report.json", evidence: [] };
  // L6–L16 script 项：用回归命令存在性做弱映射
  if ((layer.startsWith("L") || layer === "L16") && item.automation === "script") {
    if (regOk("db:verify-chain") || regOk("suite") || regOk("typecheck") || regOk("release:gate")) return { id, status: "evidence-present", note: "回归命令存在（未逐项判定）", evidence: ["regression/summary.json"] };
    return { id, status: "not-run", note: "无回归证据或未运行", evidence: [] };
  }
  return { id, status: "manual-missing", note: item.automation === "manual" ? "人工项未提交 manual/<ID>.json" : "未映射到产物", evidence: [] };
}

const items = checklist.items.map((i) => ({ ...statusOf(i), layer: i.layer, tier: i.tier, title: i.title, severity: i.severity, automation: i.automation }));
const summary = {
  at: new Date().toISOString(),
  specVersion: checklist.specVersion,
  checklist: CHECKLIST.replace(REPO_ROOT, "."),
  root: ROOT.replace(REPO_ROOT, "."),
  profileWarnings,
  totals: {
    items: items.length,
    byStatus: items.reduce((a, i) => { a[i.status] = (a[i.status] ?? 0) + 1; return a; }, {}),
    byTier: items.reduce((a, i) => { a[i.tier] = a[i.tier] ?? { total: 0, pass: 0, fail: 0, notRun: 0, manualMissing: 0 }; a[i.tier].total += 1; if (i.status === "pass") a[i.tier].pass += 1; else if (i.status === "fail") a[i.tier].fail += 1; else if (i.status === "not-run") a[i.tier].notRun += 1; else if (i.status === "manual-missing") a[i.tier].manualMissing += 1; return a; }, {}),
  },
  notRunT1: items.filter((i) => i.tier === "T1" && !["pass", "evidence-present"].includes(i.status)).map((i) => ({ id: i.id, layer: i.layer, title: i.title, status: i.status, note: i.note })),
  items,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(summary, null, 1));

const md = ["# RDAS v3.0 覆盖率报告", "", `- 检查单：${summary.checklist}｜产物根：${summary.root}｜生成：${summary.at}`, `- 状态分布：${JSON.stringify(summary.totals.byStatus)}`, "", "| Tier | 总数 | pass | fail | not-run | manual-missing |", "|---|---:|---:|---:|---:|---:|"];
for (const [t, v] of Object.entries(summary.totals.byTier).sort()) md.push(`| ${t} | ${v.total} | ${v.pass} | ${v.fail} | ${v.notRun} | ${v.manualMissing} |`);
md.push("", "## T1 未通过/未执行（冒烟阻断候选）", "");
if (!summary.notRunT1.length) md.push("无。");
else for (const i of summary.notRunT1.slice(0, 60)) md.push(`- ${i.id} ${i.title} —— ${i.status}（${i.note}）`);
writeFileSync(join(dirname(OUT), "coverage.md"), `${md.join("\n")}\n`);
console.log(`[acceptance:coverage] ${items.length} 项；状态 ${JSON.stringify(summary.totals.byStatus)}；T1 未完成 ${summary.notRunT1.length}；输出 ${OUT}`);
