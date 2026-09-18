/**
 * base/captain · 数字CEO 经营宪章与治理状态机（D21）
 *
 * 行业无关内核：宪章 schema / 默认关闭 / 深度授权 → shadow → trial → suspended → active 状态机 /
 * 试用期降档 overlay / 自治熔断评估 / 授权留痕口径。
 * 状态存于一店一档 archive.charter（投影），状态迁移均为五元事件（captain.* / ceo.*）。
 */
import { z } from "zod";

/** 治理状态（§12.1 状态机） */
export const CEO_MODES = ["disabled", "shadow", "trial", "suspended", "active"] as const;
export type CeoMode = (typeof CEO_MODES)[number];

const autonomyRangeSchema = z.object({
  label: z.string().min(1).max(80),
  lower: z.number(),
  upper: z.number(),
  anchor: z.number().default(1),
}).refine(
  ({ lower, upper, anchor }) => lower <= anchor && anchor <= upper,
  { message: "自治区间必须满足 lower <= anchor <= upper" },
);

const autonomySchema = z.object({
  /** 比例/区间边界由 Bundle 命名，例如某类动作相对基准的允许范围。 */
  ranges: z.record(z.string().min(1), autonomyRangeSchema).default({}),
  /** 金额或计数上限由 Bundle 命名，基座只执行通用比较。 */
  caps: z.record(z.string().min(1), z.object({
    label: z.string().min(1).max(80),
    limit: z.number().nonnegative(),
  })).default({}),
})
  // 自治字段是基座治理契约。未知字段不能被 Zod 静默剥离后继续以
  // trial/active 身份运行，否则会把“旧结构”伪装成“空边界”。
  .strict()
  .default(() => ({ ranges: {}, caps: {} }));

export const charterSchema = z.object({
  version: z.number().int().default(1),
  mode: z.enum(CEO_MODES).default("disabled"),
  identity: z.object({
    name: z.string().default("公司CEO"),
    persona: z.string().default("稳健经营型"),
  }).default(() => ({ name: "公司CEO", persona: "稳健经营型" })),
  autonomy: autonomySchema,
  /** L4 必请示清单（只紧不松：运行期只可加、不可减） */
  escalate: z.array(z.string()).default([
    "围栏规则放宽（任何放宽）",
    "宪章变更",
    "不可逆的对外动作",
    "跨工作区权限变更",
  ]),
  briefing: z.object({
    daily: z.string().default("08:30"),
    weekly: z.string().default("Mon 09:00"),
    monthly: z.string().default("1st 10:00"),
    channel: z.enum(["im", "app", "both"]).default("both"),
  }).default(() => ({ daily: "08:30", weekly: "Mon 09:00", monthly: "1st 10:00", channel: "both" as const })),
  circuit_breaker: z.object({
    window_days: z.number().int().default(14),
    kpi_floor: z.record(z.string(), z.number()).default({}),
    tightened: z.boolean().default(false), // 熔断后=true：自治边界已收紧一档
  }).default(() => ({ window_days: 14, kpi_floor: {}, tightened: false })),
  grant: z.object({
    event_id: z.string(),
    granted_by: z.string(),
    granted_at: z.string(),
    disclosure_version: z.string(),
    clauses: z.array(z.string()),         // 逐项确认快照（六步授权第②步）
    shadow_days: z.number().int().default(3),
    trial_days: z.number().int().default(7),
    trial_ends_at: z.string().nullable().default(null),
    retain_until: z.string().nullable().default(null), // 「保留至指定日期」
  }).nullable().default(null),
  updated_at: z.string().default(() => new Date().toISOString()),
});
export type Charter = z.infer<typeof charterSchema>;

export const defaultCharter = (): Charter => charterSchema.parse({});

export function parseCharter(raw: unknown): Charter {
  const r = charterSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  // 结构不合法时仍然 fail-closed（回落 disabled），但**绝不静默**：
  // 历史事故中旧自治结构（price_band / procurement_cap / quote_cap…）被 strict schema 拒绝，
  // 整片治理能力（晨报/裁决/熔断/绩效/董事会包）无声停摆，只在 E2E 里表现为 21 条互不相干的失败。
  // 这里把根因一句话报到日志，行业仓换种子/换契约时能立刻看见。
  if (raw !== null && typeof raw === "object" && Object.keys(raw as Record<string, unknown>).length > 0) {
    const reason = r.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("；");
    console.warn(`[captain] 宪章结构不合法 → 已按 disabled 兜底（fail-closed）：${reason}`);
  }
  return defaultCharter();
}

/* ================= 治理状态机（纯函数，§12.1） ================= */

export type CeoTransition =
  | { kind: "grant"; grant: NonNullable<Charter["grant"]> }   // disabled → shadow
  | { kind: "advance" }                                        // shadow → trial（用户确认进入试用）
  | { kind: "expire" }                                         // trial/retained → suspended（到期自动）
  | { kind: "keep_long" }                                      // suspended → active（长期保留）
  | { kind: "keep_until"; until: string }                      // suspended → active（保留至指定日期）
  | { kind: "revoke" }                                         // 任意 → suspended（一键撤回）
  | { kind: "close" };                                         // suspended → disabled（关闭）

export function transition(charter: Charter, t: CeoTransition): Charter {
  const c = structuredClone(charter);
  const now = new Date().toISOString();
  switch (t.kind) {
    case "grant": {
      if (c.mode !== "disabled") throw new Error(`当前状态 ${c.mode} 不可重复授权`);
      c.mode = "shadow";
      c.grant = t.grant;
      break;
    }
    case "advance": {
      if (c.mode !== "shadow") throw new Error(`仅影子期可进入试用（当前 ${c.mode}）`);
      if (!c.grant) throw new Error("缺少授权记录");
      const ends = new Date(Date.now() + c.grant.trial_days * 86_400_000).toISOString();
      c.mode = "trial";
      c.grant = { ...c.grant, trial_ends_at: ends };
      break;
    }
    case "expire": {
      if (c.mode !== "trial" && c.mode !== "active") throw new Error(`当前状态 ${c.mode} 无需到期处理`);
      c.mode = "suspended"; // 到期降级为仅汇报，绝不自动转正式（§12 铁律）
      break;
    }
    case "keep_long": {
      if (c.mode !== "suspended") throw new Error(`仅 suspended 可决策保留（当前 ${c.mode}）`);
      if (!c.grant) throw new Error("缺少授权记录");
      c.mode = "active";
      c.grant = { ...c.grant, retain_until: null };
      break;
    }
    case "keep_until": {
      if (c.mode !== "suspended") throw new Error(`仅 suspended 可决策保留（当前 ${c.mode}）`);
      if (!c.grant) throw new Error("缺少授权记录");
      c.mode = "active";
      c.grant = { ...c.grant, retain_until: t.until };
      break;
    }
    case "revoke": {
      if (c.mode === "disabled") throw new Error("未启用，无需撤回");
      c.mode = "suspended"; // 一键撤回：即时降级仅汇报
      break;
    }
    case "close": {
      if (c.mode !== "suspended") throw new Error(`仅 suspended 可关闭（当前 ${c.mode}）`);
      c.mode = "disabled";
      break;
    }
  }
  c.updated_at = now;
  return c;
}

/** 执行权判定：触发器消费与调度守卫统一走这里（双保险之一） */
export function canExecute(mode: CeoMode): boolean {
  return mode === "trial" || mode === "active";
}
/** 影子模式：完整推理但不执行（事件标 dry_run） */
export function isShadow(mode: CeoMode): boolean {
  return mode === "shadow";
}
/** 到期检查（试用/指定保留期） */
export function isExpired(c: Charter, now = Date.now()): boolean {
  if (c.mode === "trial" && c.grant?.trial_ends_at) return now >= Date.parse(c.grant.trial_ends_at);
  if (c.mode === "active" && c.grant?.retain_until) return now >= Date.parse(c.grant.retain_until);
  return false;
}

/* ================= 试用期降档 overlay（§12.1：自治边界自动降一档） ================= */

export function effectiveAutonomy(c: Charter): Charter["autonomy"] {
  const a = c.autonomy;
  if (c.mode !== "trial") return a;
  return {
    ranges: Object.fromEntries(Object.entries(a.ranges).map(([key, range]) => [key, {
      ...range,
      lower: Number((range.anchor - (range.anchor - range.lower) / 2).toFixed(4)),
      upper: Number((range.anchor + (range.upper - range.anchor) / 2).toFixed(4)),
    }])),
    caps: Object.fromEntries(Object.entries(a.caps).map(([key, cap]) => [key, {
      ...cap,
      limit: Math.floor(cap.limit / 2),
    }])),
  };
}

/* ================= 自治熔断（§六：KPI 跌破下限 → 收紧一档 + 告警） ================= */

export interface BreakerVerdict {
  tripped: boolean;
  metric?: string;
  actual?: number;
  floor?: number;
  alreadyTightened: boolean;
}

export function evalCircuitBreaker(c: Charter, latestKpi: Record<string, number>): BreakerVerdict {
  for (const [metric, floor] of Object.entries(c.circuit_breaker.kpi_floor)) {
    const actual = latestKpi[metric];
    if (actual !== undefined && actual < floor) {
      return { tripped: true, metric, actual, floor, alreadyTightened: c.circuit_breaker.tightened };
    }
  }
  return { tripped: false, alreadyTightened: c.circuit_breaker.tightened };
}

/** 熔断收紧：所有区间向各自 anchor 收窄一半、所有上限减半。 */
export function tightenAutonomy(c: Charter): Charter {
  const next = structuredClone(c);
  const a = next.autonomy;
  next.autonomy = {
    ranges: Object.fromEntries(Object.entries(a.ranges).map(([key, range]) => [key, {
      ...range,
      lower: range.anchor - (range.anchor - range.lower) / 2,
      upper: range.anchor + (range.upper - range.anchor) / 2,
    }])),
    caps: Object.fromEntries(Object.entries(a.caps).map(([key, cap]) => [key, {
      ...cap,
      limit: Math.floor(cap.limit / 2),
    }])),
  };
  next.circuit_breaker = { ...next.circuit_breaker, tightened: true };
  next.updated_at = new Date().toISOString();
  return next;
}
