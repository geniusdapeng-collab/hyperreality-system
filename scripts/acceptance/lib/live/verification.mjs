import { LIVE_BUDGET_CAPS } from "./budget.mjs";
import { verifyArtifactReceipts } from "./media.mjs";
import { createHash } from "node:crypto";
import { evaluateEventAssertion, freshReceipt, realExecution } from "./assertions.mjs";

/** Completion, receipt and task assertions must agree. This also rereads local media. */
export async function verifyExpectations(task, out, { artifactsDir } = {}) {
  const problems = [];
  if (out.status !== "ok") problems.push(`适配器状态 ${out.status ?? "unknown"} 不是成功`);
  if (out.receipt?.synced !== true) problems.push("缺少 synced=true 的核验回执");
  if (typeof out.receipt?.verified_at !== "string" || !Number.isFinite(Date.parse(out.receipt.verified_at))) problems.push("回执缺少有效核验时间");
  if (["llm", "image", "video"].includes(task.kind)) {
    if (typeof out.model !== "string" || !out.model.trim() || out.receipt?.model !== out.model) problems.push("供应商实际返回模型缺失或与回执不一致，不能借请求配置补齐");
    const allowed = Array.isArray(task.allowedModels) ? task.allowedModels : [];
    if (task.allowedModels !== undefined && (!Array.isArray(task.allowedModels) || allowed.some((value) => typeof value !== "string" || !value.trim()))) problems.push("allowedModels 必须是非空模型名组成的显式数组");
    if (task.expectedModel !== undefined && (typeof task.expectedModel !== "string" || !task.expectedModel.trim() || out.model !== task.expectedModel && !allowed.includes(out.model))) problems.push("供应商实际返回模型不符合预声明期望或精确 allowedModels");
  }
  let verifiedArtifacts = [];
  if (["image", "video"].includes(task.kind)) {
    if (out.measurementComplete !== true || out.receipt?.measurementComplete !== true) problems.push("媒体实际用量未取得完整计量，不能以 URL 数或声明时长替代");
    const verified = await verifyArtifactReceipts({ artifacts: out.artifacts ?? [], receipt: out.receipt, artifactsDir, kind: task.kind });
    problems.push(...verified.problems);
    verifiedArtifacts = verified.verified;
    const required = task.kind === "image" ? Number(task.images ?? 1) : 1;
    if (!Number.isSafeInteger(required) || required <= 0 || verifiedArtifacts.length !== required) problems.push(`实际可交付产物 ${verifiedArtifacts.length} 个，与请求 ${required} 不一致`);
    if (task.minArtifacts !== undefined && (!Number.isSafeInteger(task.minArtifacts) || task.minArtifacts <= 0 || verifiedArtifacts.length < task.minArtifacts)) problems.push("可交付产物未达 minArtifacts");
    if (task.kind === "image" && (!Number.isSafeInteger(out.produced) || out.produced !== verifiedArtifacts.length || out.receipt?.produced !== out.produced)) problems.push("供应商实际生成张数与可交付产物/回执不一致");
    if (task.kind === "video") {
      for (const artifact of verifiedArtifacts) if (artifact.durationSeconds < LIVE_BUDGET_CAPS.minVideoSeconds || artifact.durationSeconds > LIVE_BUDGET_CAPS.maxVideoSeconds) problems.push("视频真实时长超出配额范围");
      for (const artifact of verifiedArtifacts) if (!Number.isFinite(out.durationSeconds) || Math.abs(out.durationSeconds - artifact.durationSeconds) > 0.01 || out.receipt?.durationSeconds !== out.durationSeconds) problems.push("视频实际计量与重新解码时长/回执不一致");
    }
  }
  if (task.kind === "product") {
    if (out.finalStatus !== "completed" || out.receipt?.finalStatus !== "completed") problems.push("产品线程没有 completed 终态");
    if (!out.threadId || out.receipt?.threadId !== out.threadId) problems.push("产品线程身份与回执不一致");
    const receipts = out.receipt?.realReceipts;
    if (!Array.isArray(receipts) || !receipts.length || receipts.some((r) => r.synced !== true || r.mode !== "real")) problems.push("产品缺少真实执行回执");
    if (!Array.isArray(task.state_asserts) || !task.state_asserts.length || !Array.isArray(out.asserts) || out.asserts.length !== task.state_asserts.length || out.asserts.some((a) => a.ok !== true)) problems.push("产品状态断言未全部执行并通过");
    if (out.falseSuccess) problems.push("产品声明成功与可核验结果矛盾");
    const events = out.eventEvidence?.events;
    if (!Array.isArray(events) || out.eventEvidence.threadId !== out.threadId || out.receipt?.evidenceSha256 !== createHash("sha256").update(JSON.stringify(events)).digest("hex")) problems.push("线程事件回读与回执散列不一致");
    else for (const proof of receipts ?? []) {
      const event = events.find((candidate) => candidate.event_id === proof.eventId);
      if (!event || (proof.type === "api-readback" ? event.decision?.action !== "ask.answer" || event.object?.id !== out.threadId || typeof event.decision?.after?.text !== "string" || !freshReceipt(event.context?.time ?? event.ts, out.receipt.dispatched_at) : proof.type !== "tool-execution" || !realExecution(event, out.receipt.dispatched_at, out.threadId) || event.decision.step_id !== proof.stepId)) problems.push("真实回执缺少对应、当前且有效的原始线程事件");
      if (proof.type === "api-readback" && task.requireModel === true && (event?.decision?.params?.via !== "llm" || /mock|stub|simulat/iu.test(event?.model_trace?.model_id ?? "mock"))) problems.push("ASK requireModel 缺少真实模型事件");
    }
    if (Array.isArray(events)) for (const [index, declaration] of (task.state_asserts ?? []).entries()) if (declaration?.event) {
      const expected = evaluateEventAssertion({ events, threadId: out.threadId, assertion: declaration.event });
      const observed = out.asserts?.[index];
      if (!expected.ok || !observed || ["type", "target", "ok", "actual"].some((key) => JSON.stringify(observed[key]) !== JSON.stringify(expected[key]))) problems.push("事件结果断言与预声明条件/原始最新线程事件不一致");
    }
    if ((receipts ?? []).some((proof) => proof.type === "api-readback") && !out.asserts?.some((assertion) => assertion.type === "event" && assertion.ok === true)) problems.push("ASK 读回没有具体事件结果断言");
  }
  if (task.kind === "llm") {
    if (out.usage?.complete !== true || out.receipt?.usageComplete !== true || !Number.isSafeInteger(out.tokens) || out.tokens < 0 || out.receipt?.tokens !== out.tokens) problems.push("LLM 实际 usage 未取得或与回执不一致，不能视为实际零用量");
    if (typeof out.answer !== "string" || !out.answer.trim()) problems.push("模型没有返回答案");
    if (out.receipt?.kind === "model-gateway" && (!out.receipt.id || !out.receipt.model || !out.receipt.endpoint)) problems.push("模型网关缺少调用身份/模型/端点回执");
    if (out.receipt?.kind === "dsh-harness" && (out.receipt.auditChainOk !== true || !(out.receipt.auditLines > 0) || out.receipt.turnCompleted !== true || out.usage.routesVerified !== true)) problems.push("dsh 审计链、completed 终态或真实模型路由没有通过核验");
  }
  const text = `${out.answer ?? ""} ${verifiedArtifacts.map((a) => a.path).join(" ")}`;
  const matches = (exp) => {
    if (exp === ".") return true;
    try { return new RegExp(exp, "i").test(text); } catch { return text.toLowerCase().includes(String(exp).toLowerCase()); }
  };
  const any = (task.expect ?? []).filter((e) => e !== ".");
  if (any.length && !any.some(matches)) problems.push(`缺少任一期望：/${any.join("/ 或 /")}/`);
  for (const exp of task.expectAll ?? []) if (!matches(exp)) problems.push(`缺少必需期望 /${exp}/`);
  if (task.durationRange) {
    const range = task.durationRange;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1]) problems.push("durationRange 配置无效");
    else if (!verifiedArtifacts.length || verifiedArtifacts.some((a) => !Number.isFinite(a.durationSeconds) || a.durationSeconds < range[0] || a.durationSeconds > range[1])) problems.push(`真实视频时长不在 ${range[0]}–${range[1]}s 内`);
  }
  return { ok: problems.length === 0, detail: problems.join("；"), artifacts: verifiedArtifacts };
}
