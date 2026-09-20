/**
 * budget.mjs · 生产实测（P 域）额度闸与成本台账（RDAS v3.1 §19）
 *
 * 为什么要单独一个闸：
 *   生图/生视频按张、按秒计费，成本比文本 token 高两个数量级（`packages/base/model-router/gen-pool.ts`
 *   的分池分计量口径）。验收器如果只写“少跑几个 case”，没人能证明真的没超。
 *   本模块把「少跑」变成**可审计的硬上限**：超限即中止该任务（fail-closed），并把每次付费调用
 *   写进 `live/budget-ledger.jsonl`（只增不改，随报告归档）。
 *
 * 纪律：
 *   1. 上限只能收紧不能放宽：profile 声明值高于基座下限时按基座下限执行并写告警；
 *   2. 图片按张、视频按秒与段数双计量；LLM 按调用次数与 token 双计量；
 *   3. 任何一次调用前先占额（reserve），调用后回填实际用量（commit）；异常未回填则按预估计入（不释放）；
 *   4. 台账不得记录提示词全文以外的秘密；密钥永不进账。
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 基座硬上限：profile 只能更紧，不能更松（v3.1 默认值 = 产品所有者 2026-09-20 给定配额） */
export const LIVE_BUDGET_CAPS = {
  maxLlmCalls: 40,
  maxLlmTokens: 300_000,
  maxImages: 8,
  maxVideoClips: 3,
  minVideoSeconds: 10,
  maxVideoSeconds: 15,
  maxVideoSecondsTotal: 45,
  maxCostCny: 120,
  maxWallClockMin: 45,
};

export const DEFAULT_LIVE_BUDGETS = { ...LIVE_BUDGET_CAPS };

/** 应用硬上限：max* 取更小者，min* 取更大者；返回告警列表（不静默） */
export function normalizeBudgets(declared = {}) {
  const warnings = [];
  const out = { ...DEFAULT_LIVE_BUDGETS };
  for (const [key, cap] of Object.entries(LIVE_BUDGET_CAPS)) {
    const value = declared[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || Number.isNaN(value)) {
      warnings.push(`live.budgets.${key} 非数字（${JSON.stringify(value)}），已回落基座默认 ${cap}`);
      continue;
    }
    const isMin = key.startsWith("min");
    if (isMin && value < cap) warnings.push(`live.budgets.${key}=${value} 低于基座下限 ${cap}，已抬到下限`);
    else if (!isMin && value > cap) warnings.push(`live.budgets.${key}=${value} 高于基座上限 ${cap}，已收到上限`);
    out[key] = isMin ? Math.max(cap, value) : Math.min(cap, value);
  }
  return { budgets: out, warnings };
}

/**
 * 创建额度闸。
 * @param {object} args
 * @param {object} args.budgets  已归一化的额度（normalizeBudgets().budgets）
 * @param {string} args.outDir  产物目录（写 budget-ledger.jsonl / budget-summary.json）
 * @param {string} [args.environmentKind]
 */
export function createBudget({ budgets, outDir, environmentKind = "local-preview" }) {
  mkdirSync(outDir, { recursive: true });
  const ledgerPath = join(outDir, "budget-ledger.jsonl");
  writeFileSync(ledgerPath, "");
  const state = {
    llmCalls: 0,
    llmTokens: 0,
    images: 0,
    videoClips: 0,
    videoSeconds: 0,
    costCny: 0,
    startedAt: Date.now(),
    blocked: [],
  };

  const record = (entry) => {
    appendFileSync(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), environmentKind, ...entry })}\n`);
  };

  /** 预估成本（人民币）：文本按 token、图片按张、视频按秒；单价可由 profile 覆盖（live.pricing） */
  const pricing = {
    llmCnyPer1kTokens: 0.002,
    imageCny: 0.35,
    videoCnyPerSecond: 1.2,
    ...(budgets.pricing ?? {}),
  };

  const estimate = ({ kind, units = 0, tokens = 0 }) => {
    if (kind === "llm") return (tokens / 1000) * pricing.llmCnyPer1kTokens;
    if (kind === "image") return units * pricing.imageCny;
    if (kind === "video") return units * pricing.videoCnyPerSecond;
    return 0;
  };

  const limits = {
    llm: () => state.llmCalls >= budgets.maxLlmCalls,
    llmTokens: () => state.llmTokens >= budgets.maxLlmTokens,
    image: (units) => state.images + units > budgets.maxImages,
    video: (units) => state.videoClips + 1 > budgets.maxVideoClips || state.videoSeconds + units > budgets.maxVideoSecondsTotal,
    wallClock: () => (Date.now() - state.startedAt) / 60000 > budgets.maxWallClockMin,
  };

  /**
   * 占额：超限返回 {allowed:false, reason}，调用方必须把任务标为 blocked（不得静默跳过）。
   * @returns {{allowed:boolean, reason?:string, estimateCny:number}}
   */
  function reserve({ taskId, kind, units = 0, tokens = 0, detail = "" }) {
    if (limits.wallClock()) {
      const reason = `实测墙钟超过 ${budgets.maxWallClockMin} 分钟上限`;
      state.blocked.push({ taskId, reason });
      record({ event: "reserve-denied", taskId, kind, units, reason });
      return { allowed: false, reason, estimateCny: 0 };
    }
    const est = estimate({ kind, units, tokens });
    if (state.costCny + est > budgets.maxCostCny) {
      const reason = `成本上限 ${budgets.maxCostCny} 元将被超过（已用 ${state.costCny.toFixed(2)}，本次预估 ${est.toFixed(2)}）`;
      state.blocked.push({ taskId, reason });
      record({ event: "reserve-denied", taskId, kind, units, reason });
      return { allowed: false, reason, estimateCny: est };
    }
    if (kind === "llm") {
      if (limits.llm()) {
        const reason = `LLM 调用次数上限 ${budgets.maxLlmCalls} 已达`;
        state.blocked.push({ taskId, reason });
        record({ event: "reserve-denied", taskId, kind, reason });
        return { allowed: false, reason, estimateCny: est };
      }
      if (limits.llmTokens()) {
        const reason = `LLM token 上限 ${budgets.maxLlmTokens} 已达`;
        state.blocked.push({ taskId, reason });
        record({ event: "reserve-denied", taskId, kind, reason });
        return { allowed: false, reason, estimateCny: est };
      }
      state.llmCalls += 1;
    } else if (kind === "image") {
      if (limits.image(units)) {
        const reason = `图片张数上限 ${budgets.maxImages} 将被超过（已用 ${state.images}，本次 ${units}）`;
        state.blocked.push({ taskId, reason });
        record({ event: "reserve-denied", taskId, kind, units, reason });
        return { allowed: false, reason, estimateCny: est };
      }
      state.images += units;
    } else if (kind === "video") {
      if (units < budgets.minVideoSeconds || units > budgets.maxVideoSeconds) {
        const reason = `视频时长 ${units}s 超出允许区间 ${budgets.minVideoSeconds}–${budgets.maxVideoSeconds}s`;
        state.blocked.push({ taskId, reason });
        record({ event: "reserve-denied", taskId, kind, units, reason });
        return { allowed: false, reason, estimateCny: est };
      }
      if (limits.video(units)) {
        const reason = `视频段数/总秒数上限将被超过（段 ${state.videoClips + 1}/${budgets.maxVideoClips}，累计秒 ${state.videoSeconds + units}/${budgets.maxVideoSecondsTotal}）`;
        state.blocked.push({ taskId, reason });
        record({ event: "reserve-denied", taskId, kind, units, reason });
        return { allowed: false, reason, estimateCny: est };
      }
      state.videoClips += 1;
      state.videoSeconds += units;
    }
    state.costCny += est;
    record({ event: "reserve", taskId, kind, units, tokens, detail, estimateCny: Number(est.toFixed(4)) });
    return { allowed: true, estimateCny: est };
  }

  /** 回填实际用量：实际超过预估的部分补记；实际少于预估**不退还**（保守口径，防超支） */
  function commit({ taskId, kind, units = 0, tokens = 0, costCny = null, detail = "" }) {
    if (kind === "llm") {
      const delta = Math.max(0, tokens - state.llmTokens);
      state.llmTokens += delta;
      if (costCny != null) state.costCny += Math.max(0, costCny - estimate({ kind, tokens }));
    }
    record({ event: "commit", taskId, kind, units, tokens, costCny, detail });
  }

  function summary() {
    return {
      budgets,
      used: {
        llmCalls: state.llmCalls,
        llmTokens: state.llmTokens,
        images: state.images,
        videoClips: state.videoClips,
        videoSeconds: state.videoSeconds,
        costCny: Number(state.costCny.toFixed(4)),
        wallClockMin: Number(((Date.now() - state.startedAt) / 60000).toFixed(2)),
      },
      blocked: state.blocked,
      ledger: ledgerPath,
    };
  }

  function persist() {
    const s = summary();
    writeFileSync(join(outDir, "budget-summary.json"), JSON.stringify(s, null, 1));
    return s;
  }

  return { reserve, commit, summary, persist, ledgerPath, pricing };
}
