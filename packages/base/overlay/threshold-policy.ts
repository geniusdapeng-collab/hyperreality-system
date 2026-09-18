/**
 * overlay/threshold-policy.ts —— 基座阈值红线目录（HP-01 加固）
 *
 * 背景（审计发现）：原实现的阈值区间来自覆盖层文档自带的 `bounds` 字段，
 * 等于「租户自己声明自己能改多大」——判定自指，越界校验形同虚设；
 * 且行业包清单契约（workloom.bundle/v1，`.strict()`）不含阈值字段，
 * 真实行业包无法声明允许区间，rebase 因此会把全部阈值定制判为「引用消失」。
 *
 * 纪律（与「租户覆盖层只能收紧，不能放宽平台不可变红线」一致）：
 *  1. 阈值**存在性与允许区间由基座目录决定**，覆盖层只能在其内收窄（`min` 上抬 / `max` 下调）；
 *  2. 目录未登记的阈值路径一律拒绝（fail-closed，宁拒不错收）；
 *  3. 目录只增不改口径：新增键必须经基座评审；行业包若在视图里显式声明
 *     `workloom.threshold_bounds`（前向兼容位），与基座目录取**交集**后生效——
 *     行业包只能进一步收紧，不能放宽。
 */

export interface ThresholdBound {
  min: number;
  max: number;
}

/** 精确键：平台红线区间（示例口径，用于基座演示包与考试题） */
export const PLATFORM_THRESHOLD_BOUNDS: Readonly<Record<string, ThresholdBound>> = Object.freeze({
  /** 单笔退款积木上限（示例口径：超出必须人工审批） */
  "approval/refund-credits": { min: 0, max: 2000 },
  /** 首次响应 SLA（分钟）：最短 1 分钟、最长 60 分钟 */
  "sla/first-response-min": { min: 1, max: 60 },
});

/** 前缀键：租户营业参数（L1 文档/对话录入高频落点），数值必须非负且有明确上限 */
export const PLATFORM_THRESHOLD_PREFIX_BOUNDS: ReadonlyArray<{
  prefix: string;
  bounds: ThresholdBound;
  note: string;
}> = Object.freeze([
  {
    prefix: "biz/",
    bounds: { min: 0, max: 100_000 },
    note: "租户营业参数：非负、上限 10 万（金额/数量/次数同口径）；越界需走行业包或基座评审",
  },
]);

/** 交集：收紧两侧（取更严的 min/max）；任一为空集即为非法区间 */
export function intersectBounds(a: ThresholdBound, b: ThresholdBound): ThresholdBound {
  return { min: Math.max(a.min, b.min), max: Math.min(a.max, b.max) };
}

/**
 * 解析路径的基座允许区间（精确键优先，其次前缀键；未登记返回 null = 该阈值不可被覆盖）。
 */
export function platformBoundsFor(path: string): ThresholdBound | null {
  const exact = PLATFORM_THRESHOLD_BOUNDS[path];
  if (exact) return { ...exact };
  let matched: ThresholdBound | null = null;
  let matchedLength = -1;
  for (const rule of PLATFORM_THRESHOLD_PREFIX_BOUNDS) {
    if (path.startsWith(rule.prefix) && rule.prefix.length > matchedLength) {
      matched = { ...rule.bounds };
      matchedLength = rule.prefix.length;
    }
  }
  return matched;
}

/** 覆盖层候选区间是否落在基座允许区间内（相等视为合法：不得放宽、允许持平） */
export function boundsWithin(candidate: ThresholdBound, platform: ThresholdBound): boolean {
  return candidate.min >= platform.min
    && candidate.max <= platform.max
    && candidate.min <= candidate.max;
}
