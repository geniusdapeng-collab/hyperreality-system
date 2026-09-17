/**
 * model-router · 反馈环（v3.0 · 兜底与反馈策略落码）
 *
 * ① 👍/👎 model.feedback 事件——每条生成卡片的质量信号入事件库（路由质量周报数据源）；
 * ② 一键升级重答 escalate()——点踩即升一档重新生成，同问题 24h 限免 1 次（防刷）；
 * ③ autoTuneScenes()——场景升级率 >15% 自动建议上调默认档（用数据调路由表，不拍脑袋）。
 */
import { tierUp, type EscalateSignal, type Tier3 } from "./policy.js";
import { routeSmart, type EventSink, type SmartRouteResult, type SmartTask } from "./router.js";
import type { ModelProvider } from "./providers.js";

/* ================= ① 反馈事件 ================= */

export interface ModelFeedback {
  scene: string;
  action: string;
  thumbs: "up" | "down";
  originalTier: Tier3;
  /** 升级重答后的档位（仅 thumbs=down 且触发重答时） */
  escalatedTier?: Tier3;
  /** 升级后是否被采纳（飞轮核心指标） */
  adopted?: boolean;
  /** 触发信号（自动升级为对应信号；人工点踩=thumbs-down） */
  signal?: EscalateSignal;
}

/* ================= ② 一键升级重答 ================= */

/** 升级配额：首次免费，同问题 24h 限免 1 次（防刷）；超限按倍率实扣（仍允许，商业上乐见） */
export interface EscalationQuotaStore {
  /** key = 租户+场景+问题指纹 */
  freeRemaining(key: string, now: Date): Promise<number>;
  consume(key: string, now: Date): Promise<void>;
}

/** 内存配额实现（单测/默认；生产可换 Redis/PG 实现，接口不变） */
export class MemoryQuotaStore implements EscalationQuotaStore {
  private used = new Map<string, number>();
  constructor(private readonly freePerDay = 1) {}
  private dayKey(key: string, now: Date): string {
    return `${key}@${now.toISOString().slice(0, 10)}`;
  }
  async freeRemaining(key: string, now: Date): Promise<number> {
    return Math.max(0, this.freePerDay - (this.used.get(this.dayKey(key, now)) ?? 0));
  }
  async consume(key: string, now: Date): Promise<void> {
    const k = this.dayKey(key, now);
    this.used.set(k, (this.used.get(k) ?? 0) + 1);
  }
}

/** 点踩后的目标档：升一档；已是 L3 → null（转人工/工单，沿用三级兜底） */
export function tierAfterEscalation(current: Tier3): Tier3 | null {
  return tierUp(current);
}

/* ================= ②·执行器：一键升级重答 ================= */

export interface EscalateResult extends SmartRouteResult {
  escalated: boolean;
  fromTier: Tier3;
  toTier: Tier3 | null;
  /** 本次是否占用免费配额（否则按倍率实扣——商业上乐见，不做硬阻断） */
  freeEscalation: boolean;
}

/**
 * 一键升级重答：👎（或自动信号）→ 升一档重新生成。
 *   - 已是 L3 → escalated=false（调用方转人工/工单，沿用现有三级兜底）；
 *   - 配额内免费重答（同问题 24h 限免 1 次）；超限仍允许但 freeEscalation=false（按倍率实扣）；
 *   - 全程 model.feedback 事件留痕（含升级前后档位），反馈数据回流驱动路由调表。
 */
export async function escalate(args: {
  task: SmartTask;
  fromTier: Tier3;
  providers: Map<string, ModelProvider>;
  sink: EventSink;
  quota?: EscalationQuotaStore;
  /** 问题指纹（配额 key 组成部分；缺省取 action+首条消息前 40 字） */
  fingerprint?: string;
  opts?: Parameters<typeof routeSmart>[3];
  now?: Date;
}): Promise<EscalateResult> {
  const now = args.now ?? new Date();
  const toTier = tierAfterEscalation(args.fromTier);
  if (!toTier) {
    return { kind: "unavailable", escalated: false, fromTier: args.fromTier, toTier: null, freeEscalation: false };
  }
  const fp = args.fingerprint
    ?? `${args.task.scene ?? "generic"}:${args.task.action}:${args.task.messages[0]?.content.slice(0, 40) ?? ""}`;
  let free = false;
  if (args.quota) {
    free = (await args.quota.freeRemaining(fp, now)) > 0;
    if (free) await args.quota.consume(fp, now);
  }
  // 升级重答 = 同任务强制走目标档（覆盖场景表与套餐默认映射）
  const r = await routeSmart(
    { ...args.task, forceTier: toTier },
    args.providers,
    args.sink,
    { ...(args.opts ?? {}), policy: args.opts?.policy },
    now,
  );
  await args.sink.recordFeedback?.({
    scene: args.task.scene ?? "generic", action: args.task.action, thumbs: "down",
    original_tier: args.fromTier, escalated_tier: toTier, signal: "thumbs-down",
  });
  return { ...r, tier: toTier, escalated: true, fromTier: args.fromTier, toTier, freeEscalation: free };
}

/* ================= ③ 场景升级率自动调表 ================= */

export interface SceneStat {
  scene: string;
  generations: number;
  escalations: number;
}

export interface TuneRecommendation {
  scene: string;
  rate: number;
  recommendation: "raise-tier" | "keep";
}

/** 路由质量周报核心算法：升级率 > 阈值（默认 15%）→ 建议该场景默认档上调一级 */
export function autoTuneScenes(stats: SceneStat[], threshold = 0.15): TuneRecommendation[] {
  return stats
    .map((s) => ({
      scene: s.scene,
      rate: s.generations > 0 ? s.escalations / s.generations : 0,
      recommendation: (s.generations > 0 && s.escalations / s.generations > threshold ? "raise-tier" : "keep") as TuneRecommendation["recommendation"],
    }))
    .sort((a, b) => b.rate - a.rate);
}
