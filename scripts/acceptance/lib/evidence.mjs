/** Fixed 276-item coverage and evidence revalidation for RDAS reports. */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashBytes, ITEM_SCHEMA, INDEX_SCHEMA, revisionOf, verifyAcceptanceItem, verifyArtifact, verifyRun } from "../../delivery/evidence.mjs";
import { LIVE_BUDGET_CAPS } from "./live/budget.mjs";
import { verifyRegressionSummary } from "./regression-evidence.mjs";

const EXECUTOR_CHECKLIST = fileURLToPath(new URL("../../../docs/acceptance/checklist.v3.json", import.meta.url));
const EXPECTED_COUNT = 276;
export const INPUT_PATHS = ["matrix/matrix-summary.json", "ui/ui-probe.json", "experience/experience-report.json", "ux/ux-report.json", "outcome/outcome-report.json", "autonomy/autonomy-report.json", "redteam/redteam-report.json", "soak/soak-report.json", "regression/summary.json", "live/live-report.json"];
const array = (value) => Array.isArray(value) ? value : [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function readEvidenceJson(path) {
  if (!existsSync(path)) return { value: null, error: `缺文件：${path}` };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return { value: null, error: `JSON 顶层必须为对象：${path}` };
    return { value, error: null };
  }
  catch (error) { return { value: null, error: `JSON 无法解析：${path}（${error.name}）` }; }
}

export function fixedChecklist(repoRoot, requestedPath = null) {
  const bytes = readFileSync(EXECUTOR_CHECKLIST); const canonical = JSON.parse(bytes);
  if (canonical.schemaVersion !== "workloom.acceptance-checklist/v3" || canonical.specVersion !== "rdas/v3.1" || canonical.items.length !== EXPECTED_COUNT || new Set(canonical.items.map((i) => i.id)).size !== EXPECTED_COUNT) throw new Error("执行器固定检查单损坏（必须为 RDAS v3.1 的 276 个唯一 ID）");
  const errors = []; const path = resolve(requestedPath ?? join(repoRoot, "docs/acceptance/checklist.v3.json"));
  try { if (hashBytes(readFileSync(path)) !== hashBytes(bytes)) errors.push("检查单与执行器固定 276 项清单不同，不能裁剪或降低门禁"); }
  catch { errors.push("被测仓缺固定检查单，无法核验规范基线"); }
  return { checklist: canonical, checklistSha256: hashBytes(bytes), path, errors };
}

export function acceptanceContext(repoRoot, artifactRoot, requestedChecklist = null) {
  const fixed = fixedChecklist(repoRoot, requestedChecklist); const errors = [...fixed.errors];
  let commit = null; let dirty = null;
  try { const revision = revisionOf(repoRoot); commit = revision.commit; dirty = revision.dirty; if (dirty) errors.push("被测源码有未提交改动，完整 commit 不能代表实际执行代码"); }
  catch { errors.push("被测 Git commit 未知：验收未验证"); }
  return { repoRoot, artifactRoot, commit, dirty, checklist: fixed.checklist, checklistSha256: fixed.checklistSha256, checklistPath: fixed.path, errors, cache: new Map() };
}

function itemMetadata(item, definition) {
  const errors = [];
  for (const field of ["layer", "tier", "title", "severity", "automation"]) if (item[field] !== undefined && item[field] !== definition[field]) errors.push(`${definition.id} ${field} 与固定检查单不一致`);
  return errors;
}

export function summarizeItems(context, inputItems = [], inputErrors = []) {
  const errors = [...context.errors, ...inputErrors]; const byId = new Map(); const known = new Set(context.checklist.items.map((i) => i.id));
  if (!Array.isArray(inputItems)) { errors.push("coverage.items 必须是数组"); inputItems = []; }
  for (const item of inputItems) {
    if (!known.has(item?.id)) { errors.push(`清单外的未知条目：${item?.id ?? "(missing id)"}`); continue; }
    if (byId.has(item.id)) errors.push(`重复条目：${item.id}`);
    else byId.set(item.id, item);
  }
  const items = context.checklist.items.map((definition) => {
    const raw = byId.get(definition.id);
    const proof = !raw ? { ok: false, errors: [`${definition.id} 未执行/缺条目级证据`] } : verifyAcceptanceItem(raw, { ...context, label: definition.id });
    const itemErrors = raw ? [...itemMetadata(raw, definition), ...proof.errors] : proof.errors;
    return { ...(raw ?? {}), ...definition, status: itemErrors.length ? "unverified" : raw.status, note: [raw?.note, ...itemErrors].filter(Boolean).join("；"), evidence: raw?.evidence ?? [], evidenceErrors: itemErrors };
  });
  if (inputItems.length !== EXPECTED_COUNT) errors.push(`完整清单要求 ${EXPECTED_COUNT} 项，输入只有 ${inputItems.length} 项`);
  const totals = { items: EXPECTED_COUNT, byStatus: {}, byTier: {} };
  for (const item of items) {
    totals.byStatus[item.status] = (totals.byStatus[item.status] ?? 0) + 1;
    const tier = totals.byTier[item.tier] ??= { total: 0, pass: 0, fail: 0, notRun: 0, manualMissing: 0, unverified: 0, notApplicable: 0 };
    tier.total += 1;
    if (item.status === "pass") tier.pass += 1;
    else if (item.status === "fail") tier.fail += 1;
    else if (item.status === "not-applicable") tier.notApplicable += 1;
    else { tier.unverified += 1; tier.notRun += 1; }
  }
  const status = totals.byStatus.fail ? "fail" : errors.length || totals.byStatus.unverified ? "unverified" : "pass";
  return { schemaVersion: "workloom.acceptance-coverage/v2", at: new Date().toISOString(), specVersion: context.checklist.specVersion, checklist: context.checklistPath, checklistSha256: context.checklistSha256, commit: context.commit, status, errors, totals, notRunT1: items.filter((i) => i.tier === "T1" && !["pass", "not-applicable"].includes(i.status)), items };
}

function indexedObservation(context, definition, index) {
  if (index?.schema !== INDEX_SCHEMA || index?.commit !== context.commit || !Array.isArray(index.artifacts) || !Array.isArray(index.runs)) return null;
  for (const path of INPUT_PATHS) {
    const source = readEvidenceJson(join(context.artifactRoot, path)).value;
    if (!source) continue;
    const checks = [...(Array.isArray(source.checks) ? source.checks : []), ...(Array.isArray(source.items) ? source.items : [])].filter((c) => c?.id === definition.id);
    if (!checks.length) continue;
    const ref = (index.artifacts ?? []).find((r) => r?.path === path);
    const runRef = (index.runs ?? []).find((r) => {
      const run = verifyRun(r, { ...context, requirePass: false });
      return run.ok && (run.data.outputs ?? []).some((output) => JSON.stringify(output) === JSON.stringify(ref));
    });
    if (!ref || !runRef) return { id: definition.id, status: "unverified", note: "该项观测存在，但没有实际执行记录及完整文件绑定" };
    const run = verifyRun(runRef, { ...context, requirePass: false }).data;
    const pass = checks.every((c) => c.pass === true || (c.pass !== false && c.status === "pass"));
    const fail = checks.some((c) => c.pass === false || c.status === "fail");
    const observations = [...new Map(checks.map((check) => { const value = { expected: check.expected ?? check.name ?? "", actual: check.actual }; return [JSON.stringify(value), value]; })).values()];
    return { schema: ITEM_SCHEMA, id: definition.id, commit: context.commit, status: pass ? "pass" : fail ? "fail" : "unverified", command: run.command, actor: run.actor, observed_at: run.finished_at, expected: observations.map((c) => c.expected).join("；"), actual: observations.length === 1 ? observations[0].actual : observations.map((c) => c.actual), evidence: [ref], run: runRef, note: "从实际运行文件按相同 ID 回读；不扩展聚合成功" };
  }
  return null;
}

export function collectCoverage(context) {
  const index = readEvidenceJson(join(context.artifactRoot, "evidence-index.json")).value;
  const items = context.checklist.items.map((definition) => {
    for (const dir of ["items", "manual"]) {
      const path = join(context.artifactRoot, dir, `${definition.id}.json`);
      if (existsSync(path)) {
        const parsed = readEvidenceJson(path);
        if (parsed.error) return { id: definition.id, status: "unverified", note: parsed.error };
        if (parsed.value?.id !== definition.id || parsed.value?.schema !== ITEM_SCHEMA) return { id: definition.id, status: "unverified", note: "条目文件缺有效 schema/同 ID，旧 pass 声明不是运行证据" };
        return parsed.value;
      }
    }
    return indexedObservation(context, definition, index) ?? { id: definition.id, status: "unverified", note: "该固定检查项未执行或没有条目级运行证据" };
  });
  return summarizeItems(context, items);
}

export function revalidateCoverage(context, input) {
  const errors = [];
  if (!input) errors.push("缺 coverage.json，276 项验收未验证");
  else {
    if (input.schemaVersion !== "workloom.acceptance-coverage/v2" || input.specVersion !== context.checklist.specVersion) errors.push("coverage schema/spec 不是当前证据契约");
    if (input.checklistSha256 !== context.checklistSha256) errors.push("coverage 检查单散列与固定 276 项清单不一致");
    if (input.commit !== context.commit) errors.push("coverage commit 未知或与当前 HEAD 不一致");
  }
  return summarizeItems(context, input?.items ?? [], errors);
}

/** Report summaries need a real stage run, independent of item receipts. */
export function validateReportInputs(context) {
  const index = readEvidenceJson(join(context.artifactRoot, "evidence-index.json")).value; const errors = []; const inputs = {}; const verifications = {};
  if (!index || index.schema !== INDEX_SCHEMA || index.commit !== context.commit || !Array.isArray(index.runs) || !index.runs.length || !Array.isArray(index.artifacts)) errors.push("缺有效 evidence-index（完整 commit + 实际运行记录）");
  for (const path of INPUT_PATHS) {
    const localErrors = [];
    const parsed = readEvidenceJson(join(context.artifactRoot, path)); inputs[path] = parsed.value;
    if (parsed.error) { errors.push(parsed.error); verifications[path] = { ok: false, errors: [parsed.error] }; continue; }
    const ref = array(index?.artifacts).find((r) => r?.path === path);
    const bound = verifyArtifact(ref, { ...context, label: path }); localErrors.push(...bound.errors);
    const matching = array(index?.runs).find((r) => {
      const run = verifyRun(r, { ...context, requirePass: false });
      return run.ok && (path !== "regression/summary.json" || run.data.subject?.step === "regression-summary") && run.data.outputs.some((output) => same(output, ref));
    });
    const run = matching ? verifyRun(matching, { ...context, requirePass: false }).data : null;
    if (!matching) localErrors.push(`${path} 不属于任何实际执行输出`);
    if (parsed.value.commit && parsed.value.commit !== context.commit) localErrors.push(`${path} 自述 commit 与执行基线不同`);
    const proofBound = localErrors.length === 0 && Boolean(run);
    if (path === "regression/summary.json" && proofBound) localErrors.push(...verifyRegressionSummary(parsed.value, { ...context, aggregateRun: run }));
    if (run && run.result !== "pass") localErrors.push(`${path} 实际阶段命令未通过（exit ${run.exit_code}）`);
    verifications[path] = { ok: localErrors.length === 0, proofBound, errors: localErrors, run };
    errors.push(...localErrors);
  }
  return { errors, inputs, verifications };
}

/** A summary's synced=true is insufficient: read the actual per-task receipt/transcript and artifacts. */
export function validateProductionFiles(context, live) {
  const errors = []; const index = readEvidenceJson(join(context.artifactRoot, "evidence-index.json")).value;
  const fileOf = (path, label) => {
    const rel = isAbsolute(String(path)) ? relative(context.artifactRoot, path).split(sep).join("/") : path;
    const ref = array(index?.artifacts).find((r) => r?.path === rel);
    const proof = verifyArtifact(ref, { ...context, label }); errors.push(...proof.errors);
    const runRef = array(index?.runs).find((r) => {
      const run = verifyRun(r, { ...context, requirePass: true });
      return run.ok && run.data.outputs.some((o) => same(o, ref));
    });
    if (!runRef) errors.push(`${label} 文件未绑定到通过的实际生产执行`);
    if (proof.ok && runRef) return { ref, bytes: proof.bytes, run: verifyRun(runRef, { ...context }).data, runRef };
    return null;
  };
  const budgetFile = fileOf("live/budget-summary.json", "P.budget-summary");
  const ledgerFile = fileOf("live/budget-ledger.jsonl", "P.budget-ledger");
  if (budgetFile && ledgerFile) {
    try {
      const budget = JSON.parse(budgetFile.bytes); const entries = ledgerFile.bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.runId === budget.runId);
      if (budget.schema !== "workloom.live-budget/v2" || typeof budget.runId !== "string" || !budget.runId || !same(budget, live?.budget) || !same(budgetFile.runRef, ledgerFile.runRef)) errors.push("P 实际预算文件与任务报告/运行记录不一致");
      for (const [key, cap] of Object.entries(LIVE_BUDGET_CAPS)) {
        const value = budget.budgets?.[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key.startsWith("min") ? value < cap : value > cap)) errors.push(`P 预算 ${key} 缺失/非法/放宽硬闸`);
      }
      if (!["llmCnyPer1kTokens", "imageCny", "videoCnyPerSecond"].every((key) => Number.isFinite(budget.pricing?.[key]) && budget.pricing[key] >= 0)) errors.push("P 配额缺有限非负冻结单价");
      if (!Number.isFinite(budget.used?.wallClockMin) || budget.used.wallClockMin < 0 || budget.used.wallClockMin > budget.budgets?.maxWallClockMin) errors.push("P 实际墙钟缺失/非法/超限");
      const init = entries.filter((entry) => entry.event === "budget-init");
      if (init.length !== 1 || !same(init[0]?.budgets, budget.budgets) || !same(init[0]?.pricing, budget.pricing)) errors.push("P 预算账本缺唯一初始化或冻结额度/单价不同");
      const runStart = Date.parse(budgetFile.run.started_at); const runEnd = Date.parse(budgetFile.run.finished_at);
      if (!Number.isSafeInteger(init[0]?.startedAt) || init[0].startedAt < runStart || init[0].startedAt > runEnd || Math.abs(budget.used.wallClockMin - (runEnd - init[0].startedAt) / 60000) > 0.1) errors.push("P 预算墙钟与实际运行/初始化时间不一致");
      const reservations = new Map();
      const frozen = [];
      let previousAt = runStart;
      const estimate = (kind, units, tokens) => kind === "llm" ? tokens / 1000 * budget.pricing?.llmCnyPer1kTokens : kind === "image" ? units * budget.pricing?.imageCny : units * budget.pricing?.videoCnyPerSecond;
      for (const entry of entries) {
        const at = Date.parse(entry.at);
        if (entry.schema !== "workloom.live-budget/v2" || entry.environmentKind !== live.environment?.kind || !Number.isFinite(at) || at < previousAt || at > runEnd) throw new Error("budget event identity/time invalid");
        previousAt = at;
        if (entry.event === "reserve") {
          if (reservations.has(entry.reservationId) || typeof entry.reservationId !== "string" || !entry.reservationId.trim() || typeof entry.taskId !== "string" || !entry.taskId.trim() || !["llm", "image", "video"].includes(entry.kind) || ![entry.units, entry.tokens, entry.estimateCny].every((n) => Number.isFinite(n) && n >= 0) || !Number.isSafeInteger(entry.tokens) || (entry.kind === "llm" && entry.tokens === 0) || (entry.kind === "image" && (!Number.isSafeInteger(entry.units) || entry.units === 0)) || (entry.kind === "video" && (entry.units < budget.budgets.minVideoSeconds || entry.units > budget.budgets.maxVideoSeconds)) || Math.abs(entry.estimateCny - estimate(entry.kind, entry.units, entry.tokens)) > 0.00000001) throw new Error("budget reservation invalid");
          reservations.set(entry.reservationId, { ...entry, settlement: null });
        } else if (entry.event === "commit") {
          const reservation = reservations.get(entry.reservationId);
          if (!reservation || reservation.settlement || reservation.taskId !== entry.taskId || reservation.kind !== entry.kind || ![entry.units, entry.tokens].every((n) => Number.isFinite(n) && n >= 0) || !Number.isSafeInteger(entry.tokens) || !Number.isSafeInteger(entry.calls) || entry.calls < 0 || (entry.kind !== "llm" && entry.calls !== 0) || typeof entry.measured !== "boolean" || !["ok", "failed", "blocked"].includes(entry.status) || (entry.costCny !== null && (!Number.isFinite(entry.costCny) || entry.costCny < 0))) throw new Error("budget settlement invalid");
          reservation.settlement = entry;
        } else if (entry.event === "usage-unverified") {
          if (typeof entry.taskId !== "string" || !entry.taskId.trim() || typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error("budget freeze identity invalid");
          frozen.push({ taskId: entry.taskId, reason: entry.reason });
        } else if (entry.event !== "budget-init" && !(typeof entry.event === "string" && entry.event.endsWith("-denied"))) throw new Error("budget event invalid");
      }
      const usage = { llmCalls: 0, llmTokens: 0, images: 0, videoClips: 0, videoSeconds: 0, costCny: 0 };
      const actual = { ...usage };
      const unmeasured = { ...usage };
      const add = (to, kind, units, tokens, cost, calls = 1) => {
        if (kind === "llm") { to.llmCalls += calls; to.llmTokens += tokens; }
        if (kind === "image") to.images += units;
        if (kind === "video") { to.videoClips += units > 0 ? 1 : 0; to.videoSeconds += units; }
        to.costCny += cost;
      };
      for (const reservation of reservations.values()) {
        const settlement = reservation.settlement;
        if (!settlement) errors.push(`P 任务 ${reservation.taskId} 配额仍 pending`);
        const units = Math.max(reservation.units, settlement?.units ?? 0); const tokens = Math.max(reservation.tokens, settlement?.tokens ?? 0);
        const cost = Math.max(reservation.estimateCny, estimate(reservation.kind, units, tokens), settlement?.costCny ?? 0);
        add(usage, reservation.kind, units, tokens, cost, Math.max(1, settlement?.calls ?? 0));
        if (settlement?.measured === true) add(actual, reservation.kind, settlement.units, settlement.tokens, settlement.costCny ?? estimate(reservation.kind, settlement.units, settlement.tokens), settlement.calls);
        else if (settlement) { add(unmeasured, reservation.kind, units, tokens, cost); frozen.push({ taskId: reservation.taskId, reservationId: reservation.reservationId, reason: settlement.detail || "实际用量没有取得供应商计量，后续付费调用冻结" }); }
      }
      for (const key of Object.keys(usage)) if (![usage[key], actual[key], budget.used?.[key], budget.actual?.[key]].every(Number.isFinite) || Math.abs(budget.used[key] - usage[key]) > 0.0001 || Math.abs(budget.actual[key] - actual[key]) > 0.0001 || budget.pending?.[key] !== 0) errors.push(`P 配额 ${key} 摘要与真实账本不一致或仍 pending`);
      for (const key of Object.keys(unmeasured)) if (!Number.isFinite(budget.unmeasured?.[key]) || Math.abs(budget.unmeasured[key] - unmeasured[key]) > 0.0001 || unmeasured[key] !== 0) errors.push(`P 配额 ${key} 实际计量缺失，预占不能表述为实际零用量`);
      if (budget.measurementComplete !== true || !same(budget.frozenBy, frozen) || frozen.length) errors.push("P 预算实际计量未完成/被冻结或摘要与真实账本不同");
      const declaredReservations = [...reservations.values()].map((r) => ({ reservationId: r.reservationId, taskId: r.taskId, kind: r.kind, units: r.units, tokens: r.tokens, status: r.settlement?.status ?? "pending", settlement: r.settlement }));
      if (!same(declaredReservations, budget.reservations)) errors.push("P 配额 reservation 摘要与真实账本不同");
      for (const [key, limit] of [["llmCalls", "maxLlmCalls"], ["llmTokens", "maxLlmTokens"], ["images", "maxImages"], ["videoClips", "maxVideoClips"], ["videoSeconds", "maxVideoSecondsTotal"], ["costCny", "maxCostCny"]]) if (usage[key] > budget.budgets?.[limit]) errors.push(`P 实际用量 ${key} 超限`);
      if (!Array.isArray(budget.exceeded) || budget.exceeded.length) errors.push("P 配额没有明确的空 exceeded 清单");
      for (const task of array(live?.tasks).filter((task) => task && ["llm", "image", "video"].includes(task.kind))) if (![...reservations.values()].some((reservation) => reservation.taskId === task.id && reservation.kind === task.kind && reservation.settlement?.status === "ok" && reservation.settlement.measured === true && (task.kind !== "llm" || reservation.settlement.calls > 0))) errors.push(`${task.id} 没有真实 reserve→commit(ok/measured) 配额链`);
    } catch { errors.push("P 预算摘要/账本不可解析或占额结算链断裂"); }
  }
  const seen = new Set();
  for (const task of array(live?.tasks)) {
    if (!task || !/^[A-Za-z0-9_-]+$/.test(String(task.id))) { errors.push("P 任务 id 不是安全文件名"); continue; }
    if (seen.has(task.id)) errors.push(`${task.id} P 任务重复`);
    seen.add(task.id);
    const receipt = fileOf(task.receiptPath ?? `live/receipts/${task.id}.json`, `${task.id}.receipt`);
    const transcript = fileOf(task.transcriptPath ?? `live/transcripts/${task.id}.json`, `${task.id}.transcript`);
    if (receipt && transcript && (receipt.ref.path === transcript.ref.path || !same(receipt.runRef, transcript.runRef))) errors.push(`${task.id} 回执和 transcript 必须是同一次执行的两个独立文件`);
    if (receipt) {
      try {
        const body = JSON.parse(receipt.bytes);
        if (body.task !== task.id || body.status !== task.status || body.receipt?.synced !== true || !same(body.receipt, task.receipt) || !same(body.artifacts ?? [], task.artifacts ?? [])) errors.push(`${task.id} 实际回执与摘要任务不一致或未同步`);
        const verifiedAt = Date.parse(body.receipt?.verified_at);
        if (!Number.isFinite(verifiedAt) || verifiedAt < Date.parse(receipt.run.started_at) || verifiedAt > Date.parse(receipt.run.finished_at)) errors.push(`${task.id} 回执核验时间不在本次执行区间`);
      } catch { errors.push(`${task.id} 实际回执不是 JSON`); }
    }
    if (transcript) {
      try {
        const body = JSON.parse(transcript.bytes);
        if (body.id !== task.id || body.kind !== task.kind || body.status !== task.status || body.selftest !== false || body.receipt?.synced !== true || body.falseSuccess === true || !same(body.receipt, task.receipt) || !same(body.artifacts ?? [], task.artifacts ?? [])) errors.push(`${task.id} 实际 transcript 与成功摘要不一致`);
        if (task.kind === "llm") {
          if (typeof body.answer !== "string" || !body.answer.trim()) errors.push(`${task.id} transcript 没有真实模型答案`);
          if (!["model-gateway", "dsh-harness"].includes(body.receipt?.kind)) errors.push(`${task.id} 模型回执缺真实调用链身份`);
          if (body.receipt?.kind === "model-gateway" && (!body.receipt.id || !body.receipt.model || !body.receipt.endpoint)) errors.push(`${task.id} 网关回执缺调用 id/model/endpoint`);
          if (body.receipt?.kind === "dsh-harness" && (body.receipt.auditChainOk !== true || !(body.receipt.auditLines > 0))) errors.push(`${task.id} dsh 回执没有真实审计链`);
        }
        if (task.kind === "product" && (body.finalStatus !== "completed" || body.receipt?.finalStatus !== "completed" || !body.threadId || body.receipt?.threadId !== body.threadId || !array(body.asserts).length || array(body.asserts).some((assertion) => assertion?.ok !== true) || !array(body.receipt?.realReceipts).length || array(body.receipt?.realReceipts).some((r) => r?.synced !== true || r?.mode !== "real"))) errors.push(`${task.id} 产品 transcript 缺 completed 终态、状态断言或真实执行回执`);
        if (task.kind === "product") {
          const eventEvidence = body.eventEvidence;
          if (!eventEvidence || eventEvidence.threadId !== body.threadId || !same(eventEvidence, task.eventEvidence) || !array(eventEvidence.events).length || eventEvidence.events.length >= 200 || new Set(eventEvidence.events.map((event) => event?.event_id)).size !== eventEvidence.events.length || body.receipt?.evidenceSha256 !== hashBytes(JSON.stringify(eventEvidence.events))) errors.push(`${task.id} 产品事件身份/完整清单/散列与回执不一致`);
          const observedAt = Date.parse(eventEvidence?.observedAt);
          if (typeof eventEvidence?.source !== "string" || !/^https?:\/\//i.test(eventEvidence.source) || body.receipt?.source !== eventEvidence.source || !Number.isFinite(observedAt) || observedAt < Date.parse(transcript.run.started_at) || observedAt > Date.parse(transcript.run.finished_at)) errors.push(`${task.id} 产品事件来源/回读时间不属于本次执行`);
          for (const assertion of array(body.asserts).filter((item) => item?.type === "event")) {
            const match = /^(.+)#([A-Za-z_][A-Za-z0-9_.]*)$/.exec(String(assertion.target ?? ""));
            const parts = match?.[2]?.split(".") ?? [];
            const event = match ? array(eventEvidence?.events).filter((item) => item?.decision?.action === match[1] && item?.object?.id === body.threadId).at(-1) : null;
            const actual = event && parts.length && !parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part)) ? parts.reduce((value, part) => value && typeof value === "object" && Object.hasOwn(value, part) ? value[part] : undefined, event) : undefined;
            if (!event || actual === undefined || !same(assertion.actual, [actual])) errors.push(`${task.id} event 状态断言 actual/target 与同线程最新原始事件不一致`);
          }
          for (const proof of array(body.receipt?.realReceipts)) {
            const event = array(eventEvidence?.events).find((candidate) => candidate?.event_id === proof?.eventId);
            const proofAt = Date.parse(proof?.verified_at);
            if (!event || !/^E-\d+$/.test(proof?.eventId ?? "") || !Number.isFinite(proofAt) || proofAt < Date.parse(transcript.run.started_at) - 300000 || proofAt > Date.parse(transcript.run.finished_at) + 300000) { errors.push(`${task.id} 真实回执没有对应事件/本次执行核验时间`); continue; }
            if (proof.type === "tool-execution") {
              let snapshot = null;
              try { const url = new URL(event.receipt?.snapshot_uri); url.search = ""; url.hash = ""; url.username = ""; url.password = ""; snapshot = url.toString(); } catch { /* Invalid URI is a failed receipt check below. */ }
              if (event.object?.id !== body.threadId || event.decision?.kind !== "execute" || event.decision?.step_id !== proof.stepId || event.receipt?.synced !== true || event.receipt?.mode !== "real" || event.receipt?.error || snapshot === null || /^(workloom-sim|mock|stub):/i.test(snapshot) || snapshot !== proof.snapshot_uri || event.receipt?.verified_at !== proof.verified_at) errors.push(`${task.id} tool-execution 回执与同线程实际 execute 事件不同`);
            } else if (proof.type === "api-readback") {
              const text = event.decision?.after?.text;
              if (proof.threadId !== body.threadId || event.object?.id !== body.threadId || event.decision?.action !== "ask.answer" || typeof text !== "string" || !text.trim() || body.answer !== text || proof.source !== eventEvidence?.source || proof.snapshot_uri !== eventEvidence?.source || proof.via !== (event.decision?.params?.via ?? null) || proof.model !== (event.model_trace?.model_id ?? null) || !array(body.asserts).some((assertion) => assertion?.type === "event" && assertion.ok === true)) errors.push(`${task.id} ASK 回读缺匹配线程/来源/真实答案/具体事件断言`);
            } else errors.push(`${task.id} 真实回执没有 tool-execution/api-readback 来源类型`);
          }
        }
      } catch { errors.push(`${task.id} transcript 不是 JSON`); }
    }
    for (const [i, artifact] of array(task.artifacts).entries()) {
      const observed = fileOf(artifact?.path, `${task.id}.artifacts[${i}]`);
      if (observed && (artifact.sha256 !== observed.ref.sha256 || artifact.bytes !== observed.bytes.length)) errors.push(`${task.id} 产物 bytes/sha256 与可回读文件不同`);
      if (["image", "video"].includes(task.kind) && (artifact?.decoded !== true || artifact?.decoder !== "browser" || !(artifact?.width > 0) || !(artifact?.height > 0))) errors.push(`${task.id} 媒体产物缺实际浏览器解码记录`);
      if (task.kind === "video" && (!(artifact?.durationSeconds >= 10 && artifact.durationSeconds <= 15) || !(artifact.decodedFrames > 0))) errors.push(`${task.id} 视频产物缺 10–15 秒真实时长或可解码帧`);
    }
    if (["image", "video"].includes(task.kind) && !(task.artifacts?.length > 0)) errors.push(`${task.id} 媒体任务没有真实落盘产物`);
    if (task.kind === "image" && (task.receipt?.requested !== task.artifacts?.length || task.receipt?.produced !== task.artifacts?.length || task.receipt?.delivered !== task.artifacts?.length)) errors.push(`${task.id} 生图请求/产出/交付数量与真实产物不同`);
  }
  return errors;
}
