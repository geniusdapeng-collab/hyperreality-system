/** P-domain observations are evaluated separately; aggregate success never fans out to all items. */
import { LIVE_BUDGET_CAPS } from "./budget.mjs";

export function buildLiveChecks(report, { reportPath, outputPaths = [], secretScan, requestedTaskIds = [] }) {
  const checks = [];
  const real = report.selftest === false && ["client-runtime", "deployed"].includes(report.environment.kind);
  const tasks = report.tasks ?? [];
  const productionReady = real && report.fingerprint.targetProbe?.ok === true && report.environment.declaredTarget === true;
  const observe = (id, ok, expected, actual, { evidencePaths = [reportPath], unverified = false, note = "" } = {}) => {
    const status = !real || unverified ? "unverified" : ok ? "pass" : "fail";
    checks.push({ id, status, pass: status === "pass" ? true : status === "fail" ? false : null, expected, actual, evidencePaths, note: !real ? "本机预览/自检不构成生产实测证据" : note });
  };
  const taskEvidence = (set) => [reportPath, ...set.flatMap((task) => [task.receiptPath, task.transcriptPath]).filter(Boolean)];
  const completed = (task) => task.status === "ok" && task.receipt?.synced === true && task.selftest === false && task.verification?.ok === true
    && (task.kind !== "llm" || (task.usage?.complete === true && task.receipt.usageComplete === true))
    && (!["image", "video"].includes(task.kind) || (task.measurementComplete === true && task.receipt.measurementComplete === true));
  const group = (id, selected, predicate, expected) => observe(id, selected.length > 0 && selected.every((task) => completed(task) && predicate(task)), expected,
    selected.map((task) => ({ id: task.id, status: task.status, verified: task.verification?.ok === true, observation: predicate(task) })), { evidencePaths: taskEvidence(selected), unverified: !productionReady || selected.length === 0 || selected.some((task) => ["blocked", "skipped"].includes(task.status)) });

  observe("P0-01", report.environment.targetDeclaredExplicitly === true && /^[0-9a-f]{40}$/i.test(report.fingerprint.repo.commit ?? "") && report.fingerprint.repo.dirty === false,
    "真实环境、显式目标及干净被测完整 commit", { environment: report.environment, repo: report.fingerprint.repo }, { unverified: report.fingerprint.repo.dirty !== false || report.environment.targetDeclaredExplicitly !== true });
  const identity = report.environment.kind !== "client-runtime" || Boolean(report.fingerprint.clientRuntimeVersion && report.fingerprint.clientInstallState?.status);
  observe("P0-02", report.fingerprint.targetProbe?.ok === true && identity, "目标健康检查与客户端 VERSION/install-state 身份均可回读", report.fingerprint.targetProbe, { unverified: !productionReady || !identity });
  const writes = tasks.filter((task) => task.kind === "product" && !["blocked", "skipped"].includes(task.status));
  observe("P0-03", writes.length === 0 || (report.environment.allowWrites === true && writes.every((task) => task.fixtureMarker && task.residualDisclosure)),
    "只读执行；派单写入具显式授权、夹具标记和残留披露", writes.map((task) => ({ id: task.id, fixtureMarker: task.fixtureMarker, residualDisclosure: task.residualDisclosure })), { unverified: !productionReady });
  observe("P0-04", secretScan?.passed === true, "本次输出不含继承模型凭据值，来源仅记键名", secretScan ?? { passed: false }, { unverified: !secretScan });

  const modelKinds = ["llm", "image", "video"];
  const modelObservations = modelKinds.map((kind) => ({ kind, declared: (report.models ?? []).filter((model) => model.kind === kind), calls: tasks.filter((task) => task.kind === kind && task.called === true).map((task) => ({ id: task.id, model: task.modelResolved, receiptModel: task.receipt?.model })) }));
  observe("P1-01", modelObservations.every((observation) => observation.declared.length > 0 && observation.calls.length > 0 && observation.calls.every((call) => call.model && call.receiptModel)),
    "三类模型均有声明端点、凭据来源及真实返回模型", modelObservations, { unverified: !productionReady || modelObservations.some((observation) => observation.calls.length === 0 || observation.calls.some((call) => !call.model || !call.receiptModel)) });
  const dsh = tasks.filter((task) => task.chain === "dsh-harness" && task.called === true);
  observe("P1-02", Boolean(report.fingerprint.dsh?.version && !/[~^*]|latest|workspace:/u.test(report.fingerprint.dsh.version)) && dsh.length > 0 && dsh.every((task) => task.modelResolved && task.receipt?.auditChainOk === true) && outputPaths.some((path) => path.endsWith("cordis.patch.yml")),
    "dsh 锁版、实际路由 patch 及回执可回读", { fingerprint: report.fingerprint.dsh, taskIds: dsh.map((task) => task.id), patches: outputPaths.filter((path) => path.endsWith("cordis.patch.yml")) }, { unverified: !productionReady || dsh.length === 0 || dsh.some((task) => ["blocked", "skipped"].includes(task.status) || !task.modelResolved) });
  const modelCalls = tasks.filter((task) => modelKinds.includes(task.kind) && task.called === true);
  observe("P1-03", modelCalls.length > 0 && modelCalls.every((task) => task.modelResolved && task.modelExpected && (task.modelResolved === task.modelExpected || Array.isArray(task.allowedModels) && task.allowedModels.includes(task.modelResolved))),
    "每次实际调用记录期望/返回模型；换模须预声明精确 allowedModels", modelCalls.map((task) => ({ id: task.id, expected: task.modelExpected, actual: task.modelResolved, status: task.status, reason: task.reason })), { unverified: !productionReady || modelCalls.length === 0 || modelCalls.some((task) => ["blocked", "skipped"].includes(task.status) || !task.modelResolved) });
  observe("P1-04", Boolean(report.budget.pricing && report.budget.costBasis?.invoiced === null) && Object.values(report.budget.pricing).every((price) => Number.isFinite(price) && price >= 0),
    "冻结单价与已回填/预占用量分列，未取得账单不宣称实付成本", { pricing: report.budget.pricing, used: report.budget.used, actual: report.budget.actual, pending: report.budget.pending, costBasis: report.budget.costBasis });

  group("P2-01", tasks.filter((task) => task.kind === "llm" && (task.purpose === "reasoning" || /^LLM-R/u.test(task.id))), (task) => Boolean(task.answer?.trim()), "预声明推理任务真实完成且答案满足期望");
  group("P2-02", tasks.filter((task) => task.kind === "llm" && (task.purpose === "multimodal" || /^LLM-M/u.test(task.id))), (task) => Boolean(task.multimodal?.expectedToken && task.answer?.includes(task.multimodal.expectedToken) && task.multimodal.sha256), "图片输入散列已留档，真实答案包含图内核验字");
  group("P2-03", tasks.filter((task) => task.kind === "llm" && (task.purpose === "tool-loop" || /^LLM-T/u.test(task.id))), (task) => task.audit?.chain?.ok === true && task.audit?.lines > 0 && task.fenceHits?.length > 0, "工具调用有围栏判定、真实事件及哈希链通过");
  group("P2-04", tasks.filter((task) => task.kind === "image"), (task) => task.artifacts?.length > 0 && task.receipt.requested === task.artifacts.length && task.receipt.produced === task.artifacts.length && task.artifacts.every((artifact) => artifact.decoded === true && artifact.bytes > 0 && /^[0-9a-f]{64}$/u.test(artifact.sha256)), "请求张数等于可回读、可解码产物及回执数量");
  group("P2-05", tasks.filter((task) => task.kind === "video"), (task) => Boolean(task.receipt?.taskId && task.receipt?.videoUrl && task.artifacts?.length === 1 && task.artifacts.every((artifact) => artifact.decodedFrames > 0 && artifact.durationSeconds >= 10 && artifact.durationSeconds <= 15)), "视频真实解码帧、10–15 秒时长及 task id/URL/散列齐备");
  group("P2-06", tasks.filter((task) => task.kind === "product"), (task) => task.finalStatus === "completed" && task.receipt.finalStatus === "completed" && task.receipt.threadId === task.threadId && task.asserts?.length > 0 && task.asserts.every((assertion) => assertion.ok === true) && task.receipt.realReceipts?.length > 0 && task.falseSuccess === false, "产品 completed、真实执行回执、所有状态断言同时成立");

  const usage = report.budget.used;
  const caps = report.budget.budgets;
  const limits = [["llmCalls", "maxLlmCalls"], ["llmTokens", "maxLlmTokens"], ["images", "maxImages"], ["videoClips", "maxVideoClips"], ["videoSeconds", "maxVideoSecondsTotal"], ["costCny", "maxCostCny"]];
  observe("P3-01", limits.every(([quantity, cap]) => Number.isFinite(usage[quantity]) && usage[quantity] <= caps[cap] && caps[cap] <= LIVE_BUDGET_CAPS[cap]) && report.budget.exceeded.length === 0 && report.budget.measurementComplete === true,
    "冻结上限不放宽；实际与未结算占额累计均在配额内且用量完整", { used: usage, caps, exceeded: report.budget.exceeded, denied: report.budget.blocked, measurementComplete: report.budget.measurementComplete, unmeasured: report.budget.unmeasured, frozenBy: report.budget.frozenBy }, { unverified: report.budget.measurementComplete !== true });
  observe("P3-02", tasks.length > 0 && tasks.every((task) => task.receiptPath && task.transcriptPath) && outputPaths.some((path) => path.endsWith("budget-ledger.jsonl")) && outputPaths.some((path) => path.endsWith("budget-summary.json")),
    "每项回执/transcript、媒体、预算账本绑定到同一次运行索引", { files: outputPaths, taskIds: tasks.map((task) => task.id) });
  observe("P3-03", report.verdict !== "pass" || (productionReady && tasks.length > 0 && tasks.every(completed)), "缺凭据/目标/真实回执不得写 pass", { verdict: report.verdict, selftest: report.selftest, productionReady, statuses: tasks.map((task) => [task.id, task.status]) });
  const expectedIds = [...requestedTaskIds].sort(); const actualIds = tasks.map((task) => task.id).sort();
  observe("P3-04", JSON.stringify(expectedIds) === JSON.stringify(actualIds) && tasks.filter((task) => task.status === "failed").every((task) => report.summary.failedIds.includes(task.id)) && tasks.filter((task) => task.status === "blocked").every((task) => report.summary.blockedIds.includes(task.id)),
    "所有选定任务、失败/配额拦下均逐项披露", { requestedTaskIds, actualIds, summary: report.summary, denied: report.budget.blocked });
  return checks;
}
