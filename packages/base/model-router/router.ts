/**
 * model-router · 模型与资源调度（B7，M6/F6.1–F6.8）
 *
 * 调度伪代码（PRD 图 M6-1 逐字落码）：
 *   hit = 组织记忆.lookup(task)；命中可复用 → 零/低消耗直接复用（F6.1，留痕）
 *   tier = classify(task)（standard|flagship，确定性代码 F6.2）
 *   window = 22:00-08:00 ? off-peak : peak（F6.3/G9：谷时旗舰费率 ≤ 标准 20%）
 *   chain = 策略.chainFor(tier, window)（F6.4 降级链；F6.7 可按工作区配置）
 *   for m in chain：healthy(m) → 调用；否则写 model.degraded 事件（L6.1 禁止静默换模型）
 *   全链不可用 → 排队等谷时 / 转需介入（E6.1）
 *   单任务消耗熔断：超限挂起+告警（F6.5/L6.4）
 *   每次调用（含切换与降级）写事件 model_trace {model_id, tier, window, credits}（F6.5）
 *   账单 = 事件投影，不重算（L6.3）
 */
import { OFF_PEAK_RATE_RATIO, OFF_PEAK_WINDOW } from "@workloom/shared";
import { mockCredits, type ChatMessage, type ChatResult, type ModelProvider } from "./providers.js";
import {
  DEFAULT_MODEL_POLICY, resolveScene, resolveTier, tierUp,
  type ModelPolicy, type PlanId, type Tier3,
} from "./policy.js";
import { chainFor } from "./pool.js";
import { computeCredits } from "./credits.js";

/* ================= 峰谷窗口（F6.3，Asia/Shanghai） ================= */

export type Window = "peak" | "off-peak";

export function currentWindow(now = new Date()): Window {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")!.value);
  const mm = Number(parts.find((p) => p.type === "minute")!.value);
  const [sh, sm] = OFF_PEAK_WINDOW.start.split(":").map(Number);
  const [eh, em] = OFF_PEAK_WINDOW.end.split(":").map(Number);
  const t = hh * 60 + mm;
  const start = sh! * 60 + sm!;
  const end = eh! * 60 + em!;
  // #19 修复：支持跨午夜（start > end，如 22:00-08:00）和非跨午夜（start < end，如 09:00-17:00）两种窗口
  if (start > end) {
    // 跨午夜窗口：t >= start 或 t < end 时为 off-peak
    return t >= start || t < end ? "off-peak" : "peak";
  }
  // 非跨午夜窗口：start <= t < end 时为 off-peak
  return t >= start && t < end ? "off-peak" : "peak";
}

/* ================= 分级路由（F6.2 确定性分类） ================= */

export type Tier = "standard" | "flagship";

/** 任务分类规则表（确定性代码；行业可经 bundle 覆盖，L2.6） */
const TASK_TIER_TABLE: Record<string, Tier> = {
  "price.adjust": "standard",
  "order.reconcile": "standard",
  "review.reply": "standard",
  "inspection.scan": "standard",
  "competitor.fetch": "standard",
  "content.publish": "flagship", // 内容生产上旗舰
  "content.draft": "flagship",
};

export function classify(task: { action: string; depthHint?: "deep" | "normal" }): Tier {
  if (task.depthHint === "deep") return "flagship";
  return TASK_TIER_TABLE[task.action] ?? "standard";
}

/* ================= 降级链（F6.4/F6.7） ================= */

export interface RouterPolicy {
  /** 每档降级链（model_id 有序） */
  chains: Record<Tier, string[]>;
  /** 单任务积分熔断上限（L6.4；默认按工作区套餐配置，此处为机制默认值） */
  taskCreditLimit: number;
}

/** 默认策略（内置演示口径；工作区覆盖经 F6.7 机制位 policy 参数） */
export const DEFAULT_POLICY: RouterPolicy = {
  chains: {
    flagship: ["mock-flagship-a", "mock-flagship-b", "mock-standard-c"],
    standard: ["mock-standard-a", "mock-standard-b"],
  },
  taskCreditLimit: 500,
};

/* ================= 事件汇（计量/降级留痕出口，L6.1/L6.3） ================= */

/** 事件汇接口：计量与降级事件的唯一出口（测试注入内存汇；生产接安全网关） */
export interface EventSink {
  recordModelTrace(trace: {
    model_id: string; tier: Tier | string; window: Window; credits: number; action: string; reused?: boolean;
    /** v3.0：场景标识 + 计费归属（platform=售前体检等平台成本，不扣客户积分） */
    scene?: string; bill_to?: "tenant" | "platform";
  }): Promise<void>;
  recordDegradation(d: { from: string; to: string | null; reason: string; action: string }): Promise<void>;
  /** 熔断挂起告警（F6.5/L6.4） */
  recordCircuitBreak(d: { action: string; creditsUsed: number; limit: number }): Promise<void>;
  /** v3.0 反馈环：👍/👎 质量信号（model.feedback 事件） */
  recordFeedback?(fb: {
    scene: string; action: string; thumbs: "up" | "down";
    original_tier: string; escalated_tier?: string; adopted?: boolean; signal?: string;
  }): Promise<void>;
}

/* ================= 记忆复用（F6.1） ================= */

export interface MemoryLookupHit {
  reusable: boolean;
  answer?: string;
  memoryId?: string;
}

/* ================= 主调度 ================= */

export interface RouteTask {
  action: string;
  messages: ChatMessage[];
  depthHint?: "deep" | "normal";
  /** 非紧急深度任务可排队等谷时（F6.3；本版只标记不阻塞，调度器在 B9） */
  queueable?: boolean;
  /** 记忆复用查询（F6.1；由 workdata 供给） */
  memoryLookup?: () => Promise<MemoryLookupHit | null>;
  /** 本任务已消耗积分（多步任务累计传入；熔断判定依据，L6.4） */
  creditsUsedSoFar?: number;
}

export interface RouteResult {
  kind: "answered" | "reused" | "queued" | "circuit_broken" | "unavailable";
  text?: string;
  modelTrace?: { model_id: string; tier: Tier; window: Window; credits: number };
  reusedMemoryId?: string;
  degraded?: Array<{ from: string; to: string | null; reason: string }>;
  /** #12 修复：熔断时仍返回已产出的答案，避免白烧 token */
  budgetExceeded?: boolean;
}

export async function route(
  task: RouteTask,
  providers: Map<string, ModelProvider>,
  sink: EventSink,
  policy: RouterPolicy = DEFAULT_POLICY,
  now = new Date(),
): Promise<RouteResult> {
  // F6.1 记忆优先复用：命中可复用结论 → 零消耗直返（留痕经 sink.recordModelTrace reused）
  if (task.memoryLookup) {
    const hit = await task.memoryLookup();
    if (hit?.reusable && hit.answer !== undefined) {
      await sink.recordModelTrace({
        model_id: "memory-reuse", tier: "standard", window: currentWindow(now),
        credits: 0, action: task.action, reused: true,
      });
      return { kind: "reused", text: hit.answer, reusedMemoryId: hit.memoryId };
    }
  }

  // L6.4 单任务熔断：超限挂起+告警
  const used = task.creditsUsedSoFar ?? 0;
  if (used >= policy.taskCreditLimit) {
    await sink.recordCircuitBreak({ action: task.action, creditsUsed: used, limit: policy.taskCreditLimit });
    return { kind: "circuit_broken" };
  }

  const tier = classify(task);
  const window = currentWindow(now);
  const chain = policy.chains[tier];
  const degraded: Array<{ from: string; to: string | null; reason: string }> = [];

  for (let i = 0; i < chain.length; i++) {
    const modelId = chain[i]!;
    const provider = providers.get(modelId);
    if (!provider || !(await provider.healthy())) {
      const to = chain[i + 1] ?? null;
      degraded.push({ from: modelId, to, reason: "unhealthy" });
      await sink.recordDegradation({ from: modelId, to, reason: "unhealthy", action: task.action }); // L6.1
      continue;
    }
    try {
      const result: ChatResult = await provider.chat(task.messages);
      const credits = window === "off-peak" && tier === "flagship"
        ? Math.max(1, Math.round(mockCredits(modelId, result) * OFF_PEAK_RATE_RATIO)) // G9/L6.5
        : mockCredits(modelId, result);
      const trace = { model_id: modelId, tier, window, credits, action: task.action };
      await sink.recordModelTrace(trace); // F6.5 逐事件计量
      // 熔断复检：本次消耗后超限 → 标记熔断但仍返回已产出答案（#12 修复：不丢弃已付费产出）
      if (used + credits >= policy.taskCreditLimit) {
        await sink.recordCircuitBreak({ action: task.action, creditsUsed: used + credits, limit: policy.taskCreditLimit });
        return { kind: "circuit_broken", text: result.text, modelTrace: trace, degraded, budgetExceeded: true };
      }
      return { kind: "answered", text: result.text, modelTrace: trace, degraded };
    } catch (err) {
      const to = chain[i + 1] ?? null;
      const reason = err instanceof Error ? err.message : String(err);
      degraded.push({ from: modelId, to, reason });
      await sink.recordDegradation({ from: modelId, to, reason, action: task.action }); // L6.1
    }
  }

  // E6.1：全链不可用 → 非紧急深度任务排队等谷时；否则转需介入
  if (task.queueable) return { kind: "queued", degraded };
  return { kind: "unavailable", degraded };
}

/* ================= 账单投影（L6.3：只从事件投影，不重算） ================= */

export interface BillRow {
  model_id: string;
  tier: string;
  window: string;
  calls: number;
  credits: number;
}

/** 从事件 payloads 的 model_trace 聚合账单（纯函数；数据源=事件库投影） */
export function projectBill(events: Array<{ model_trace?: { model_id: string; tier?: string; window?: string; credits?: number } }>): BillRow[] {
  const acc = new Map<string, BillRow>();
  for (const e of events) {
    const mt = e.model_trace;
    if (!mt) continue;
    const key = `${mt.model_id}|${mt.tier ?? ""}|${mt.window ?? ""}`;
    const row = acc.get(key) ?? { model_id: mt.model_id, tier: mt.tier ?? "", window: mt.window ?? "", calls: 0, credits: 0 };
    row.calls += 1;
    row.credits += mt.credits ?? 0;
    acc.set(key, row);
  }
  return [...acc.values()].sort((a, b) => b.credits - a.credits);
}

/* ================= v3.0 通用调度：routeSmart（场景 × 套餐 × 复杂度 × 真实计量） ================= */

/** 长文路由条件：输入字符超阈值 → 档内长文款前置（≈32K tokens 粗估） */
export const LONG_CONTEXT_CHARS = 24_000;
/** 档内 token 天花板：估算超限 → 自动升一档（复杂度信号，规则引擎零成本） */
export const TIER_TOKEN_CEILING: Record<Tier3, number> = { L1: 4000, L2: 24_000, L3: Number.POSITIVE_INFINITY };

export interface SmartTask extends RouteTask {
  /** 场景标识（model-policy.yml 的 scenes key；缺省 generic） */
  scene?: string;
  /** 租户套餐（缺省 standard） */
  plan?: PlanId;
  /** 强制档位（升级重答用；跳过场景表与套餐映射） */
  forceTier?: Tier3;
}

export interface SmartModelTrace {
  model_id: string; tier: Tier3; window: Window; credits: number;
  action?: string; scene?: string; bill_to?: "tenant" | "platform";
}

export interface SmartRouteResult extends Omit<RouteResult, "modelTrace"> {
  modelTrace?: SmartModelTrace;
  tier?: Tier3;
  scene?: string;
  billTo?: "tenant" | "platform";
  /** 金融口径：LLM 不可用 → 透传披露（禁止降档重答） */
  passthrough?: boolean;
}

/**
 * 通用路由主入口（v3.0）：
 *   场景表（bundle 第⑦槽）→ 套餐默认映射 → 复杂度信号（长文/超天花板升档）→
 *   降级链（noDowngrade 截断跨档段）→ 真实计量（computeCredits，谷时 ×0.2）→ 事件留痕。
 * 旧 route()（两档）保留向后兼容；新链路一律走本函数。
 */
export async function routeSmart(
  task: SmartTask,
  providers: Map<string, ModelProvider>,
  sink: EventSink,
  opts: { policy?: ModelPolicy; taskCreditLimit?: number } = {},
  now = new Date(),
): Promise<SmartRouteResult> {
  const policy = opts.policy ?? DEFAULT_MODEL_POLICY;
  const limit = opts.taskCreditLimit ?? 500;
  const scene = task.scene ?? "generic";
  const plan = task.plan ?? "standard";
  const sp = resolveScene(policy, scene);
  let tier = task.forceTier ?? resolveTier(policy, scene, plan);

  // 复杂度信号（确定性规则，零模型成本）：输入超档内天花板 → 升一档
  const inputChars = task.messages.reduce((n, m) => n + m.content.length, 0);
  if (inputChars > TIER_TOKEN_CEILING[tier]) tier = tierUp(tier) ?? tier;
  const longContext = inputChars > LONG_CONTEXT_CHARS;

  // F6.1 记忆复用：命中零消耗直返（留痕）
  if (task.memoryLookup) {
    const hit = await task.memoryLookup();
    if (hit?.reusable && hit.answer !== undefined) {
      await sink.recordModelTrace({
        model_id: "memory-reuse", tier, window: currentWindow(now),
        credits: 0, action: task.action, reused: true, scene, bill_to: sp.billTo ?? "tenant",
      });
      return { kind: "reused", text: hit.answer, reusedMemoryId: hit.memoryId, tier, scene, billTo: sp.billTo ?? "tenant" };
    }
  }

  // L6.4 单任务熔断
  const used = task.creditsUsedSoFar ?? 0;
  if (used >= limit) {
    await sink.recordCircuitBreak({ action: task.action, creditsUsed: used, limit });
    return { kind: "circuit_broken", tier, scene };
  }

  const window = currentWindow(now);
  // 降级链：noDowngrade（金融/体检等质量红线）截断跨档段，只允许同档互备
  const chain = chainFor(tier, { longContext, allowCrossTier: !sp.noDowngrade });
  const degraded: Array<{ from: string; to: string | null; reason: string }> = [];

  for (let i = 0; i < chain.length; i++) {
    const modelId = chain[i]!;
    const provider = providers.get(modelId);
    if (!provider || !(await provider.healthy())) {
      const to = chain[i + 1] ?? null;
      degraded.push({ from: modelId, to, reason: "unhealthy" });
      await sink.recordDegradation({ from: modelId, to, reason: "unhealthy", action: task.action }); // L6.1
      continue;
    }
    try {
      const result: ChatResult = await provider.chat(task.messages);
      const credits = computeCredits({
        tier, promptTokens: result.promptTokens, completionTokens: result.completionTokens, window,
      });
      const trace = {
        model_id: modelId, tier, window, credits, action: task.action,
        scene, bill_to: sp.billTo ?? "tenant" as "tenant" | "platform",
      };
      await sink.recordModelTrace(trace); // F6.5 逐事件真实计量
      if (used + credits >= limit) {
        await sink.recordCircuitBreak({ action: task.action, creditsUsed: used + credits, limit });
        return { kind: "circuit_broken", text: result.text, modelTrace: trace, degraded, budgetExceeded: true, tier, scene, billTo: sp.billTo ?? "tenant" };
      }
      return { kind: "answered", text: result.text, modelTrace: trace, degraded, tier, scene, billTo: sp.billTo ?? "tenant" };
    } catch (err) {
      const to = chain[i + 1] ?? null;
      const reason = err instanceof Error ? err.message : String(err);
      degraded.push({ from: modelId, to, reason });
      await sink.recordDegradation({ from: modelId, to, reason, action: task.action }); // L6.1
    }
  }

  // 全链不可用：按行业降级语义收口
  if (sp.fallback === "passthrough-disclose") {
    // 金融铁律：宁可不答不可错答——透传披露，不降档、不猜测
    return { kind: "unavailable", degraded, tier, scene, passthrough: true };
  }
  if (sp.fallback === "queue" || sp.window === "off-peak-only" || task.queueable) {
    return { kind: "queued", degraded, tier, scene };
  }
  return { kind: "unavailable", degraded, tier, scene };
}
