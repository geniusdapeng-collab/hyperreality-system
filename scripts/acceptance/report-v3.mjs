#!/usr/bin/env node
/**
 * report-v3.mjs · 把 RDAS v3.1 各类产物汇总成 REPORT.md（L/U/O/P 四层判定 + U/O/P 记分卡 + ADR/HIR 表）。
 *
 * 输入：outputs/acceptance/{matrix,ui,experience,ux,outcome,autonomy,redteam,soak,regression,coverage.json}
 * 输出：outputs/acceptance/REPORT.md + report-summary.json
 *
 * 判定纪律：红线一票否决；mock/缺真实模型时 O 域只能“结构合规/能力未验证”；LLM 评审不得单独判红线。
 * 用法：node scripts/acceptance/report-v3.mjs [--root <dir>] [--out <file>]
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cliArgs, findRepoRoot, loadProfile } from "./lib/profile.mjs";
import { acceptanceContext, readEvidenceJson, revalidateCoverage, validateReportInputs, validateProductionFiles } from "./lib/evidence.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
let profile = {}; let profileWarnings = [];
try { ({ profile, warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath)); }
catch (error) { profileWarnings.push(`profile 无法解析（${error.name}）：验收未验证`); }
const ROOT = resolve(args.has("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(REPO_ROOT, "outputs", "acceptance"));
const OUT = resolve(args.outDir ?? (args.has("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join(ROOT, "REPORT.md")));
const array = (value) => Array.isArray(value) ? value : [];
const rows = (value) => array(value).filter((item) => item && typeof item === "object" && !Array.isArray(item));
const parseErrors = [];
const readJson = (p) => { const parsed = readEvidenceJson(p); if (parsed.error) parseErrors.push(parsed.error); return parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? parsed.value : null; };
const matrix = readJson(join(ROOT, "matrix", "matrix-summary.json"));
const ui = readJson(join(ROOT, "ui", "ui-probe.json"));
const experience = readJson(join(ROOT, "experience", "experience-report.json"));
const ux = readJson(join(ROOT, "ux", "ux-report.json"));
const outcome = readJson(join(ROOT, "outcome", "outcome-report.json"));
const autonomy = readJson(join(ROOT, "autonomy", "autonomy-report.json"));
const redteam = readJson(join(ROOT, "redteam", "redteam-report.json"));
const soak = readJson(join(ROOT, "soak", "soak-report.json"));
const regression = readJson(join(ROOT, "regression", "summary.json"));
const context = acceptanceContext(REPO_ROOT, ROOT);
const coverage = revalidateCoverage(context, readJson(join(ROOT, "coverage.json")));
const live = readJson(join(ROOT, "live", "live-report.json"));
const evidenceInputs = validateReportInputs(context);
const trusted = (path) => evidenceInputs.verifications[path]?.ok === true;
const captured = (path) => evidenceInputs.verifications[path]?.proofBound === true;
const stageFailed = (path) => captured(path) && evidenceInputs.verifications[path].run?.result === "fail" && evidenceInputs.verifications[path].run?.exit_code !== 2;
const validationErrors = [...parseErrors, ...evidenceInputs.errors, ...coverage.errors];
if (!profile.repo) validationErrors.push("缺可核验 profile.repo");
if (!Number.isInteger(matrix?.counts?.agents) || matrix.counts.agents <= 0 || !Number.isInteger(matrix?.counts?.skills) || matrix.counts.skills <= 0) validationErrors.push("L 矩阵缺非零岗位/技能样本（0/0 不能通过）");
if (!Number.isInteger(ui?.totals?.routesChecked) || ui.totals.routesChecked <= 0) validationErrors.push("L 页面域缺非零路由样本");
if (!Array.isArray(experience?.checks) || experience.checks.length === 0) validationErrors.push("缺体验走查检查结果");
if (!Array.isArray(ux?.checks) || ux.checks.length === 0) validationErrors.push("U 域缺检查结果，空 checks 不能通过");
if (outcome?.configured !== true || !rows(outcome?.trials ?? outcome?.tasks).length || rows(outcome?.trials ?? outcome?.tasks).length !== array(outcome?.trials ?? outcome?.tasks).length) validationErrors.push("O 域缺真实任务尝试样本");
if (!(autonomy?.overall?.delivered?.n > 0)) validationErrors.push("ADR 缺非零交付样本");
if (!rows(redteam?.cases).length || rows(redteam?.cases).length !== array(redteam?.cases).length) validationErrors.push("红队缺实际用例");
if (!rows(soak?.samples).length || rows(soak?.samples).length !== array(soak?.samples).length) validationErrors.push("长跑缺实际采样");
if (!regression?.commands || typeof regression.commands !== "object" || Array.isArray(regression.commands) || !Object.keys(regression.commands).length) validationErrors.push("回归域缺实际命令结果");
const productionErrors = validateProductionFiles(context, live);
if (!live || live.selftest !== false || !["client-runtime", "deployed"].includes(live.environment?.kind)) productionErrors.push("P 域没有真实客户端/部署环境实测（缺输入/预览/自检均未验证）");
if (live?.fingerprint?.repo?.commit !== context.commit) productionErrors.push("P 域 fingerprint commit 未知或与验收 HEAD 不同");
if (live?.fingerprint?.targetProbe?.ok !== true || !rows(live?.fingerprint?.targetProbe?.checks).length || rows(live?.fingerprint?.targetProbe?.checks).some((check) => check.ok !== true)) productionErrors.push("P 域缺通过的实际目标探测");
if (!rows(live?.models).length || rows(live?.models).length !== array(live?.models).length || rows(live?.models).some((m) => m.ready !== true || !m.id || !m.model || /mock|stub|fake/i.test(`${m.model} ${m.adapter ?? ""}`))) productionErrors.push("P 域未有就绪真实模型清单");
if (!Array.isArray(live?.tasks) || !live.tasks.length) productionErrors.push("P 域零任务：生产能力未验证");
else {
  if (live.summary?.total !== live.tasks.length || live.summary?.byStatus?.ok !== live.tasks.filter((task) => task?.status === "ok").length) productionErrors.push("P 域任务摘要数量与实际清单不一致");
  for (const task of live.tasks) {
    if (!task || !["llm", "image", "video", "product"].includes(task.kind) || task.status !== "ok" || task.selftest !== false || task.receipt?.synced !== true || task.falseSuccess || (task.kind === "product" && task.finalStatus !== "completed")) productionErrors.push(`${task?.id ?? "unknown"} 生产任务非成功终态或无真实同步回执`);
    if (task?.kind !== "product" && !rows(live.models).some((model) => model.id === task?.model && model.ready === true)) productionErrors.push(`${task?.id ?? "unknown"} 任务模型不属于已就绪模型清单`);
  }
}
validationErrors.push(...productionErrors);
const matrixSample = Number.isInteger(matrix?.counts?.agents) && matrix.counts.agents > 0 && Number.isInteger(matrix?.counts?.skills) && matrix.counts.skills > 0;
const uiSample = Number.isInteger(ui?.totals?.routesChecked) && ui.totals.routesChecked > 0;
const realChecks = (checks) => Array.isArray(checks) && checks.length > 0 && rows(checks).length === checks.length && checks.every((check) => typeof check.pass === "boolean" && (check.id || check.name));
if (!realChecks(experience?.checks) || !realChecks(ux?.checks)) validationErrors.push("U/体验检查必须逐项有 ID/name 和实际 pass 布尔值");

const envValue = (key) => {
  const p = join(REPO_ROOT, ".env");
  if (!existsSync(p)) return process.env[key] ?? null;
  const line = readFileSync(p, "utf-8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : process.env[key] ?? null;
};
const git = (cmd) => { try { return execSync(cmd, { cwd: REPO_ROOT }).toString().trim(); } catch { return "unknown"; } };
const dataMode = profile.dataMode ?? envValue("DATA_MODE") ?? "unknown";
const llmProvider = envValue("LLM_PROVIDER") ?? "unknown";
const providerIsMock = /mock|stub|fake/i.test(llmProvider);
const providerUnverified = providerIsMock || llmProvider === "unknown";
if (providerUnverified) validationErrors.push("O 域 LLM provider 为替身/未知：真实业务能力未验证");

const redLines = [];
const addRed = (n, detail) => redLines.push({ id: n, detail });

if (captured("matrix/matrix-summary.json") && matrix && (matrix.counts?.agentsPass !== matrix.counts?.agents || matrix.counts?.skillsPass !== matrix.counts?.skills)) addRed(2, `L1 运行层存在失败：agents ${matrix.counts?.agentsPass}/${matrix.counts?.agents}，skills ${matrix.counts?.skillsPass}/${matrix.counts?.skills}`);
if (captured("ui/ui-probe.json") && rows(ui?.issues).some((i) => /裸奔技术 id|未见展示名/.test(String(i.detail)))) addRed(1, "客户端出现技术串（裸露 id）");
if (captured("experience/experience-report.json") && rows(experience?.checks).some((c) => c.pass === false && /审批|派活|dry-run/.test(c.name))) addRed(2, "关键任务不可完成（审批写回/派活/围栏 dry-run）");
if (captured("redteam/redteam-report.json") && rows(redteam?.findings).length) addRed(1, `红队发现可利用用例 ${rows(redteam.findings).length} 条`);
if (captured("ux/ux-report.json") && rows(ux?.checks).some((c) => c.pass === false && c.id === "U5-02")) addRed(10, "键盘可达性机检未通过（需人工复核确认是否阻断 P0）");
if (captured("outcome/outcome-report.json") && (outcome?.falseSuccess ?? 0) > 0) addRed(7, `检测到假成功 ${outcome.falseSuccess} 例`);
if (captured("autonomy/autonomy-report.json") && autonomy?.anomalies?.externalWithoutReceipt > 0) addRed(5, `外部动作无回执：${autonomy.anomalies.externalWithoutReceipt} 条交付链`);
if (captured("live/live-report.json") && rows(live?.tasks).some((t) => t.falseSuccess)) addRed(7, `生产实测检测到假成功：${rows(live.tasks).filter((t) => t.falseSuccess).map((t) => t.id).join(",")}`);
if (captured("live/live-report.json") && live && live.environment?.kind === "local-preview" && live?.summary?.byStatus?.ok > 0 && !live.selftest) {
  // 本机预览跑出的“真实模型”结果不构成生产实测证据（防止把 localhost 当生产）
  addRed(3, "本机预览档位下的实测结果被当作生产验收证据（演示与真实混淆）");
}
for (const [name, v] of Object.entries(regression?.commands ?? {})) {
  if (captured("regression/summary.json") && /release|gate/i.test(name) && typeof v === "string" && v.startsWith("失败")) addRed(6, `发布门禁未全绿：${name}`);
}

const coverageOf = (prefixes) => {
  const list = (coverage?.items ?? []).filter((i) => prefixes.some((p) => i.layer?.startsWith(p)));
  const total = list.length;
  const done = list.filter((i) => ["pass", "not-applicable"].includes(i.status)).length;
  const failed = list.filter((i) => i.status === "fail").length;
  const passed = list.filter((i) => i.status === "pass").length;
  const notApplicable = list.filter((i) => i.status === "not-applicable").length;
  return { total, done, failed, passed, notApplicable, rate: total ? done / total : null };
};
const Lcov = coverageOf(["L"]);
const Ucov = coverageOf(["U"]);
const Ocov = coverageOf(["O", "ADR"]);
const Pcov = coverageOf(["P"]);
const verdictOf = (cov, { fail = false, unverified = false } = {}) => {
  if (fail || cov?.failed > 0) return "不通过";
  if (unverified) return "未验证";
  if (!cov || cov.total === 0) return "未验证";
  if (cov.rate === 1 && cov.failed === 0) return "通过";
  return "未验证";
};
const Lverdict = verdictOf(Lcov, { fail: redLines.some((r) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12].includes(r.id)) || ["matrix/matrix-summary.json", "ui/ui-probe.json", "regression/summary.json"].some(stageFailed), unverified: !matrixSample || !uiSample || ["matrix/matrix-summary.json", "ui/ui-probe.json", "regression/summary.json"].some((path) => !trusted(path)) });
const Uverdict = verdictOf(Ucov, { fail: redLines.some((r) => r.id === 10) || ["ux/ux-report.json", "experience/experience-report.json"].some(stageFailed), unverified: !trusted("ux/ux-report.json") || !trusted("experience/experience-report.json") || !realChecks(ux?.checks) || !realChecks(experience?.checks) });
const Overdict = verdictOf(Ocov, { fail: redLines.some((r) => r.id === 7) || ["outcome/outcome-report.json", "autonomy/autonomy-report.json", "redteam/redteam-report.json", "soak/soak-report.json"].some(stageFailed), unverified: providerUnverified || ["outcome/outcome-report.json", "autonomy/autonomy-report.json", "redteam/redteam-report.json", "soak/soak-report.json"].some((path) => !trusted(path)) });
const Pverdict = verdictOf(Pcov, { unverified: productionErrors.length > 0 || !trusted("live/live-report.json"), fail: stageFailed("live/live-report.json") || rows(live?.tasks).some((t) => t.status === "failed" || t.falseSuccess) });
const failedStages = Object.keys(evidenceInputs.verifications).filter(stageFailed);
if (failedStages.length) validationErrors.push(`实际阶段命令失败：${failedStages.join("、")}`);
const status = redLines.length || failedStages.length || coverage.status === "fail" || Pverdict === "不通过" ? "fail" : validationErrors.length || coverage.status !== "pass" || [Lverdict, Uverdict, Overdict, Pverdict].some((v) => v !== "通过") ? "unverified" : "pass";
const overall = status === "fail" ? "不通过" : status === "pass" ? "通过" : `未验证（L=${Lverdict} / U=${Uverdict} / O=${Overdict} / P=${Pverdict}；证据不完整）`;

const fmtRate = (r) => (!r || ![r.p, r.lo, r.hi, r.n].every(Number.isFinite) || r.n <= 0 ? "未验证（缺非零统计样本/区间）" : `${(r.p * 100).toFixed(1)}%（CI ${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)}%，n=${r.n}）`);
const esc = (s) => String(s ?? "").replace(/\|/g, "/").slice(0, 240);
const checkVerdict = (checks, verified = true) => !verified || !checks.length || checks.some((check) => typeof check?.pass !== "boolean") ? "未验证" : checks.some((check) => !check.pass) ? "**未通过**" : "通过";
const notVerified = coverage.items.filter((item) => item.status === "unverified");
const manualMissing = coverage.items.filter((item) => item.automation.includes("manual") && item.status === "unverified");
const md = [];
md.push(`# ${profile.productName ?? "WorkLoom 产品"} 真机验收报告（RDAS v3.1 · ${new Date().toISOString().slice(0, 10)}）`);
md.push("");
md.push(`> 规范：\`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md\`（rdas/v3.1）｜检查单：\`docs/acceptance/checklist.v3.json\`｜profile：\`acceptance/profile.json\`（${profile.schemaVersion ?? "?"}）`);
md.push(`> 被测版本：\`${profile.repo ?? "(unknown)"}@${git("git rev-parse --short HEAD")}\`（分支 \`${git("git rev-parse --abbrev-ref HEAD")}\`）｜工作区：\`${profile.workspaceId ?? profile.identity?.workspaceSlug ?? "?"}\`｜主包：\`${matrix?.primaryBundle ?? profile.primaryBundle ?? "?"}\`｜生成：${new Date().toISOString()}`);
md.push("");
md.push(`**结论：${overall}**`);
if (validationErrors.length) md.push("", "证据校验缺口（生成报告不等于验收通过）：", ...[...new Set(validationErrors)].map((e) => `- ${e}`));
if (redLines.length) { md.push(""); md.push("红线命中："); for (const r of redLines) md.push(`- [#${r.id}] ${r.detail}`); }
md.push("");
md.push("## 一、环境与资产指纹（缺一报告无效）");
md.push("");
md.push("```");
md.push(`commit=${git("git rev-parse HEAD")} branch=${git("git rev-parse --abbrev-ref HEAD")}`);
md.push(`dataMode=${dataMode} llmProvider=${llmProvider} checklist=${coverage?.specVersion ?? "?"} profile=${profile.schemaVersion ?? "?"}`);
md.push(`workspace=${profile.workspaceId ?? profile.identity?.workspaceSlug ?? "?"} bundle=${matrix?.primaryBundle ?? profile.primaryBundle ?? "?"}`);
md.push(`seed=${envValue("ACCEPTANCE_SEED") ?? "未声明"} model=${envValue("LLM_MODEL") ?? "未声明"} promptHash=${envValue("PROMPT_HASH") ?? "未声明"}`);
md.push(`environment=${live?.environment?.kind ?? profile.environment?.kind ?? "local-preview"} production=${live?.environment?.isProduction ?? false} target=${live?.fingerprint?.urls?.api ?? "(本机预览)"}`);
if (live?.fingerprint) md.push(`dsh=${live.fingerprint.dsh?.package ?? "?"}@${live.fingerprint.dsh?.version ?? "?"} clientRuntime=${live.fingerprint.clientRuntimeVersion ?? "未接入"}`);
md.push(`generatedAt=${new Date().toISOString()}`);
md.push("```");
if (profileWarnings.length) { md.push(""); md.push("Profile 告警："); for (const w of profileWarnings) md.push(`- ${w}`); }
md.push("");
md.push("## 二、覆盖率声明（硬性）");
md.push("");
md.push("```");
if (coverage) {
  md.push(`检查单条目：${coverage.totals.items}；状态分布：${JSON.stringify(coverage.totals.byStatus)}`);
  for (const [t, v] of Object.entries(coverage.totals.byTier ?? {}).sort()) md.push(`${t}: 总数 ${v.total}；pass ${v.pass}；fail ${v.fail}；not-run ${v.notRun}；manual-missing ${v.manualMissing}`);
  md.push(`T1 未完成：${coverage.notRunT1.length} 项`);
} else md.push("缺 coverage.json：覆盖率未知（报告无效）");
md.push("未执行/抽样清单及原因：见第十一节；人工项证据约定 outputs/acceptance/manual/<ID>.json。");
md.push("```");
md.push("");
md.push("## 三、结果总览（L / U / O / P 四层判定）");
md.push("");
md.push("| 层 | 通过 / 固定条目（批准不适用） | 失败项 | 判定 | 主要证据 |");
md.push("|---|---:|---:|---|---|");
md.push(`| L 基础（L0–L16） | ${Lcov.passed}/${Lcov.total}（${Lcov.notApplicable}） | ${Lcov.failed} | ${Lverdict} | matrix/ui/regression |`);
md.push(`| U 体验（U0–U8） | ${Ucov.passed}/${Ucov.total}（${Ucov.notApplicable}） | ${Ucov.failed} | ${Uverdict} | ux/experience/研究记录 |`);
md.push(`| O 交付（O0–O9 + ADR） | ${Ocov.passed}/${Ocov.total}（${Ocov.notApplicable}） | ${Ocov.failed} | ${Overdict} | outcome/autonomy/redteam/soak |`);
md.push(`| P 生产实测（P0–P3） | ${Pcov.passed}/${Pcov.total}（${Pcov.notApplicable}） | ${Pcov.failed} | ${Pverdict} | live/{transcripts,artifacts,budget} |`);
md.push("");
md.push("## 四、U 域记分卡");
md.push("");
md.push("| 指标 | 实测 | 阈值/预期 | 结论 |");
md.push("|---|---|---|---|");
if (ux) {
  const byId = (id) => rows(ux.checks).filter((c) => c.id === id);
  const sum = (id, key) => byId(id).length && byId(id).every((c) => Number.isFinite(c.actual?.[key])) ? byId(id).reduce((a, c) => a + c.actual[key], 0) : "缺实际数值";
  const verdict = (id) => checkVerdict(byId(id), trusted("ux/ux-report.json"));
  md.push(`| axe critical/serious | ${sum("U5-01", "criticalSerious")} | 0 | ${verdict("U5-01")} |`);
  md.push(`| 键盘可达（机检近似） | 遮挡 ${sum("U5-02", "obscured")} / 无指示 ${sum("U5-02", "noIndicator")} | 0 / ≈0 | ${verdict("U5-02")} |`);
  md.push(`| 点击目标 <24px（间距例外后） | ${sum("U5-05", "spacingFail")} | 0 | ${verdict("U5-05")} |`);
  md.push(`| 缩放/重排溢出 | ${byId("U5-04").length ? byId("U5-04").filter((c) => c.pass === false).length : "缺样本"} 路由 | 0 | ${verdict("U5-04")} |`);
} else md.push("| U 自动化 | 未执行 | — | 未验证 |");
if (experience) md.push(`| v2 走查 | ${experience.totals?.passed ?? "?"}/${experience.totals?.checks ?? "?"} | — | ${checkVerdict(rows(experience.checks), trusted("experience/experience-report.json"))} |`);
if (coverage) {
  const uManual = manualMissing.filter((i) => i.layer.startsWith("U")).length;
  md.push(`| U 人工研究项未提交证据 | ${uManual} | 0 | ${uManual === 0 ? "通过" : "未验证"} |`);
}
md.push("");
md.push("## 四·一、P 域记分卡（生产环境实测 · v3.1）");
md.push("");
md.push("| 指标 | 实测 | 阈值/预期 | 结论 |");
md.push("|---|---|---|---|");
if (live) {
  const b = live.budget?.used ?? {};
  const lim = live.budget?.budgets ?? {};
  md.push(`| 环境档位 | ${live.environment?.kind ?? "未知"}${live.selftest ? "（自检替身）" : ""} | client-runtime / deployed | ${live.selftest === false && ["client-runtime", "deployed"].includes(live.environment?.kind) && trusted("live/live-report.json") ? "生产档位（证据已回读）" : "未验证"} |`);
  md.push(`| 内置模型就绪 | ${rows(live.models).filter((m) => m.ready === true).length}/${rows(live.models).length} | 全部就绪且有样本 | ${rows(live.models).length > 0 && rows(live.models).every((m) => m.ready === true) && trusted("live/live-report.json") ? "通过" : "未验证"} |`);
  md.push(`| 任务通过 | ${live.summary?.byStatus?.ok ?? 0}/${live.summary?.total ?? 0} | 全部通过且有任务 | ${Pverdict} |`);
  md.push(`| 生图张数 | ${b.images ?? "未知"} | ≤${lim.maxImages ?? "未知"} | ${Pverdict === "通过" && Number.isFinite(b.images) ? "通过（账本已回放）" : "未验证"} |`);
  md.push(`| 视频段数/秒数 | ${b.videoClips ?? "未知"} 段 / ${b.videoSeconds ?? "未知"}s | ≤${lim.maxVideoClips ?? "未知"} 段、各 ${lim.minVideoSeconds ?? "未知"}–${lim.maxVideoSeconds ?? "未知"}s、总 ≤${lim.maxVideoSecondsTotal ?? "未知"}s | ${Pverdict === "通过" && Number.isFinite(b.videoClips) && Number.isFinite(b.videoSeconds) ? "通过（账本已回放）" : "未验证"} |`);
  md.push(`| 预估成本 | ¥${b.costCny ?? "未知"} | ≤¥${lim.maxCostCny ?? "未知"}（冻结单价估算，实际账单另对账） | ${Pverdict === "通过" && Number.isFinite(b.costCny) ? "通过（账本已回放）" : "未验证"} |`);
  const chainTask = rows(live.tasks).find((t) => t.status === "ok" && t.audit?.chain?.ok && t.receipt?.synced === true);
  md.push(`| 工具循环/账本链 | ${chainTask ? `${chainTask.id}（${array(chainTask.fenceHits).length} 次围栏判定）` : "未执行"} | ≥1 条 | ${chainTask && Pverdict === "通过" ? "通过" : "未验证"} |`);
  const blockedIds = array(live.summary?.blockedIds);
  if (blockedIds.length) md.push(`| 被凭据/目标拦下 | ${blockedIds.join("、")} | 0 | 未验证（不得写通过） |`);
} else {
  md.push("| P 域 | 未执行（缺 live/live-report.json） | — | 未验证 |");
}
md.push("");
md.push("## 五、O 域记分卡（自主经营交付结果）");
md.push("");
md.push("| 指标 | 实测 | 阈值/预期 | 结论 |");
md.push("|---|---|---|---|");
if (outcome?.configured) {
  md.push(`| 任务 pass@1 | ${outcome.stats?.passAt1 ?? "n/a"} | — | 报告 |`);
  md.push(`| 任务 pass^${outcome.stats?.k ?? "?"} | ${outcome.stats?.passAtK ?? "n/a"} | P0 ≥${(profile.thresholds?.p0PassKTarget ?? 0.8) * 100}% | ${Overdict === "未验证" || !Number.isFinite(outcome.stats?.passAtK) ? "未验证" : outcome.stats.passAtK >= (profile.thresholds?.p0PassKTarget ?? 0.8) ? "通过" : "**未通过**"} |`);
  md.push(`| 假成功 | ${outcome.falseSuccess ?? "n/a"} | 0 | ${!trusted("outcome/outcome-report.json") || !Number.isInteger(outcome.falseSuccess) ? "未验证" : outcome.falseSuccess === 0 ? "通过" : "**红线**"} |`);
} else md.push(`| O 任务套件 | 未配置/未执行 | — | 未验证（${providerIsMock ? "LLM_PROVIDER=mock" : "缺 suite"}） |`);
if (autonomy) {
  md.push(`| 业务结果前提 | ${autonomy.overall?.delivered?.n ? "有交付样本" : "无样本"} | KPI 达标才判价值 | ${autonomy.overall?.delivered?.n ? "见 ADR 表" : "未验证"} |`);
  md.push(`| 假成功/无回执（外部动作） | ${autonomy.anomalies?.externalWithoutReceipt ?? "n/a"} | 0 | ${!trusted("autonomy/autonomy-report.json") || !Number.isInteger(autonomy.anomalies?.externalWithoutReceipt) ? "未验证" : autonomy.anomalies.externalWithoutReceipt === 0 ? "通过" : "**红线候选**"} |`);
  md.push(`| 红队可利用 | ${Array.isArray(redteam?.findings) ? redteam.findings.length : "未执行"} | 0 | ${!trusted("redteam/redteam-report.json") || !rows(redteam?.cases).length || !Array.isArray(redteam?.findings) ? "未验证" : rows(redteam.findings).length ? "**未通过**" : "通过"} |`);
  md.push(`| 长跑 | ${rows(soak?.samples).length ? `${rows(soak.samples).length} 样本` : "未执行"} | 24h/7d/28d | ${trusted("soak/soak-report.json") && rows(soak?.samples).length ? "见 soak 报告（按实际时长）" : "未验证"} |`);
} else md.push("| ADR/可靠性 | 未执行 | — | 未验证 |");
md.push("");
md.push("## 六、ADR / HIR 自主交付表");
md.push("");
if (autonomy?.overall?.delivered && typeof autonomy.overall.delivered === "object") {
  const d = autonomy.overall.delivered;
  md.push("| 角色 | AL(声明/实测) | N | ADR-0 | ADR-1 | HIR | HIR-NI | H3+H4 | HMPO | 回执覆盖 |");
  md.push("|---|---|---:|---|---|---|---|---|---|---|");
  for (const [role, m] of Object.entries(autonomy.byRole ?? {}).filter(([, metric]) => metric && typeof metric === "object").sort((a, b) => (b[1].n ?? 0) - (a[1].n ?? 0))) {
    md.push(`| ${esc(role)} | ${rows(profile.outcome?.roles).find((r) => r.agentPreset === role)?.al ?? "未声明"} / 待对账 | ${m.n ?? "?"} | ${fmtRate(m.adr0)} | ${fmtRate(m.adr1)} | ${fmtRate(m.hir)} | ${fmtRate(m.hirNi)} | ${fmtRate(m.h34)} | ${m.hmpoEstimateMs ?? "n/a"} ms | ${Number.isFinite(m.receiptCoverage) ? `${(m.receiptCoverage * 100).toFixed(0)}%` : "未验证"} |`);
  }
  md.push("");
  md.push(`- 总计：交付件 ${d.n}；ADR-1 ${fmtRate(d.adr1)}；HIR ${fmtRate(d.hir)}；HIR-NI ${fmtRate(d.hirNi)}；H3+H4 ${fmtRate(d.h34)}；H1/H2/H3/H4=${d.h1Count}/${d.h2Count}/${d.h3Count}/${d.h4Count}`);
  md.push(`- 方法：${Object.values(autonomy.method ?? {}).join("；")}`);
  md.push(`- 夹具过滤：${JSON.stringify(autonomy.filters)}`);
  md.push(`- 数据质量：${array(autonomy.dataQuality).join("；") || "未提供"}`);
  md.push("- AVR 判据：业务 KPI 达标 + ADR↑ + HIR-NI↓ + HMPO↓ + 质量/护栏不劣化（五条同时成立才可称“AI 自主价值提升”）。");
} else md.push("未执行 autonomy.mjs：ADR/HIR 未验证。");
md.push("");
md.push("## 七、红线检查（12 条）");
md.push("");
md.push("| # | 红线 | 结果 |");
md.push("|---|---|---|");
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
  const hit = redLines.find((r) => r.id === n);
  md.push(`| ${n} | ${["治理被绕过","关键任务不可完成","演示与真实混淆","秘密与客户数据","无回执宣告完成","发布门禁未全绿","假成功","越权自主","结果不可对账/造假","体验/无障碍阻断","AI 未披露/合成内容未标注","红线判定依赖 LLM 评审"][n - 1]} | ${hit ? `**命中**：${hit.detail}` : "未命中（或未执行）"} |`);
}
md.push("");
md.push("## 八、统计与校准");
md.push("");
md.push("| 项 | 值 |");
md.push("|---|---|");
md.push(`| 样本量（ADR 交付件） | ${autonomy?.overall?.delivered?.n ?? "n/a"} |`);
md.push(`| 比例型区间 | Wilson（autonomy-report.json） |`);
md.push(`| pass^k | ${outcome?.stats ? `pass@1=${outcome.stats.passAt1}；pass^${outcome.stats.k}=${outcome.stats.passAtK}` : "未执行"} |`);
md.push(`| LLM judge 校准 | ${existsSync(join(ROOT, "eval", "judge-calibration.json")) ? "见 eval/judge-calibration.json" : "未执行（红线不得用 LLM judge 单独判定）"} |`);
md.push(`| 版本/成本冻结 | model=${envValue("LLM_MODEL") ?? "未声明"}；promptHash=${envValue("PROMPT_HASH") ?? "未声明"} |`);
md.push("");
md.push("## 九、失败与修复清单");
md.push("");
let issueCount = 0;
for (const i of rows(matrix?.failures?.agents)) { md.push(`- [L1/P0候选] 岗位 ${i.preset_key}：${array(i.failures).join(",")}`); issueCount += 1; }
for (const i of rows(matrix?.failures?.skills)) { md.push(`- [L1/P0候选] 技能 ${i.skill}：${array(i.failures).join(",")}`); issueCount += 1; }
for (const i of rows(ui?.issues)) { md.push(`- [L3] ${i.where}：${esc(i.detail)}`); issueCount += 1; }
for (const i of rows(experience?.issues)) { md.push(`- [L4/L5] ${i.id} ${i.name}：${esc(i.actual)}`); issueCount += 1; }
for (const i of rows(ux?.issues)) { md.push(`- [U] ${i.id} ${i.route}：${esc(i.detail)}`); issueCount += 1; }
for (const f of rows(redteam?.findings)) { md.push(`- [O6/红线] ${f.id} ${f.title}：${esc(f.detail)}`); issueCount += 1; }
if (!issueCount) md.push("无（不代表未执行项已通过；未执行见下节）。");
md.push("");
md.push("## 十、验收债与豁免");
md.push("");
if (coverage) {
  const missingT1 = coverage.notRunT1 ?? [];
  md.push(`- T1 未完成 ${missingT1.length} 项；T2/T3 未完成见 coverage.json。`);
  for (const i of missingT1.slice(0, 20)) md.push(`  - ${i.id} ${i.title}（${i.status}）`);
} else md.push("- coverage.json 缺失，验收债无法量化。");
md.push("- 豁免/裁剪必须写明：裁了什么/为什么/影响哪条结论/何时补/谁批准；未验证不得写成通过。");
md.push("");
md.push("## 十一、未覆盖与遗留（诚实清单）");
md.push("");
md.push(`- LLM provider=${llmProvider}${providerUnverified ? "：O 域真实能力与业务结果未验证" : ""}`);
md.push(`- 人工研究与人工项证据目录 manual/<ID>.json：未验证 ${manualMissing.length} 项；详情见 coverage.json 的 evidenceErrors。`);
md.push("- 真手机/读屏/弱网等人工环境项：仅逐项验真后计 pass；文件存在不代表检查通过。");
md.push(`- 长跑（O5）：${trusted("soak/soak-report.json") && rows(soak?.samples).length ? `已回读 ${rows(soak.samples).length} 个样本，24h/7d/28d完成情况需按实际采样时间复核` : "未验证"}。`);
md.push("");
md.push("## 十二、证据分级与索引");
md.push("");
md.push("- **A**＝代码精读得出；**B**＝全量机检/脚本/元数据解析得出；**C**＝抽样得出；**D**＝推断/未验证。真机和业务实测另注明环境、步骤及原始证据；脚本结果不会自动升级为 A。");
md.push(`- 本报告的 276 项复核为脚本证据（B）；其中 ${coverage.totals.byStatus.pass ?? 0} 项通过、${coverage.totals.byStatus.fail ?? 0} 项失败、${coverage.totals.byStatus["not-applicable"] ?? 0} 项有批准的不适用、${notVerified.length} 项未验证（D）。脚本不把配置、文件存在或聚合摘要升级为 A 级证据。`);
md.push("- A/C 级代码精读、人工环境或研究结论必须由验收者提供逐项原始材料与阅读/实测范围；本生成器不推定这些工作已完成。");
md.push(`- 证据索引：${esc(join(ROOT, "evidence-index.json"))}；缺索引或回读失败时报告保持未验证。`);
md.push("");
md.push("## 收尾报告（硬性）");
md.push("");
md.push(`- 已完成：报告生成与固定 276 项证据复核（B）；已绑定实际执行并回读的阶段输入：${Object.keys(evidenceInputs.verifications).filter(trusted).join("、") || "无"}。验收是否通过以结论 ${overall} 为准。`);
md.push(`- 未完成/未覆盖：${notVerified.length} 项未验证；T1 未完成 ${coverage.notRunT1.length} 项；全局证据缺口 ${new Set(validationErrors).size} 项，见正文。`);
md.push("- 自主追加事项及理由：无（报告生成器仅复核已执行的证据）。");
md.push("- 采用的假设：profile 的角色/旅程/阈值/结果契约为本仓权威；未声明处以基座默认值与下限执行。");
md.push(`- 置信度：${status === "pass" ? "高（固定条目及输入回执已按提交/散列/执行状态复核；A/C级人工结论仍以原始材料为准）" : "低（存在失败或未验证，不构成验收通过结论）"}`);
md.push("- 建议复核：1) 红线检查表；2) ADR/HIR 的夹具过滤与 HMPO 估算方法；3) T1 未完成清单。");
md.push("");
md.push("## 自检表（硬性）");
md.push("");
md.push(`- [${status === "pass" ? "是" : "否"}] 覆盖了任务全部范围，而非挑了容易的部分？（固定 276 项，缺口保留为未验证）`);
md.push("- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？");
md.push("- [是] 每个结论有依据、可验证、证据等级标注准确？（仅声明脚本复核范围，未验证不计通过）");
md.push(`- [${status === "pass" ? "是" : "否"}] 经得起资深工程师逐项审查？（回读缺口均已列出，生成报告与验收通过分列）`);

mkdirSync(dirname(OUT), { recursive: true });
mkdirSync(ROOT, { recursive: true });
writeFileSync(OUT, `${md.join("\n")}\n`);
const summary = {
  at: new Date().toISOString(),
  repo: profile.repo,
  productName: profile.productName,
  head: git("git rev-parse HEAD"),
  branch: git("git rev-parse --abbrev-ref HEAD"),
  dataMode, llmProvider,
  verdict: overall,
  status,
  reportGenerated: true,
  acceptancePassed: status === "pass",
  validationErrors: [...new Set(validationErrors)],
  failedStages,
  layers: { L: Lverdict, U: Uverdict, O: Overdict, P: Pverdict },
  redLines,
  coverage: coverage?.totals ?? null,
  adr: autonomy ? { n: autonomy.overall?.delivered?.n, adr1: autonomy.overall?.delivered?.adr1, hirNi: autonomy.overall?.delivered?.hirNi, h34: autonomy.overall?.delivered?.h34, receipts: autonomy.overall?.delivered?.receiptCoverage } : null,
  live: live ? { verdict: live.verdict, selftest: live.selftest, environment: live.environment?.kind, models: rows(live.models).length, tasks: live.summary?.byStatus ?? null, budget: live.budget?.used ?? null } : null,
  report: OUT.replace(REPO_ROOT, "."),
};
writeFileSync(join(ROOT, "report-summary.json"), JSON.stringify(summary, null, 1));
console.log(`[acceptance:report:v3] 结论：${overall}；L=${Lverdict} U=${Uverdict} O=${Overdict} P=${Pverdict}；红线 ${redLines.length}；输出 ${OUT}`);
process.exitCode = status === "pass" ? 0 : status === "fail" ? 1 : 2;
