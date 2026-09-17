/**
 * social-listening · 数据归一（U3：多平台口径映射）
 *
 * 各平台指标字段名/口径不一（抖音 plays vs 小红书 views vs B站 play_count），
 * 归一层把平台原始字段映射到统一口径字典（plays/likes/comments/shares/follows），
 * 产出 { raw, normalized, confidence } 三元组；双源比对差异超 ±10% 标记 divergent。
 * 纪律：纯函数、零外部调用；未映射字段不猜测不编造（normalized 记 null，confidence 反映覆盖度）。
 */

/** 统一口径指标键（canonical） */
export const CANONICAL_METRICS = ["plays", "likes", "comments", "shares", "follows"] as const;
export type CanonicalMetric = (typeof CANONICAL_METRICS)[number];

/** 单平台口径映射：canonical → 该平台原始字段别名表（首个为首选字段） */
export type PlatformMapping = Partial<Record<CanonicalMetric, string[]>>;

/** 口径映射注册表：platform → PlatformMapping */
export class MetricMappingRegistry {
  private readonly mappings = new Map<string, PlatformMapping>();

  /** 注册/覆盖某平台口径映射（registerMetricMapping） */
  registerMetricMapping(platform: string, mapping: PlatformMapping): void {
    this.mappings.set(platform, { ...mapping });
  }

  /** 查询平台映射（未注册返回 undefined） */
  mappingOf(platform: string): PlatformMapping | undefined {
    return this.mappings.get(platform);
  }

  /** 已注册平台列表 */
  platforms(): string[] {
    return [...this.mappings.keys()];
  }
}

/** 原始指标输入：平台 + 原始字段键值（来自采集层，键名各平台不一） */
export interface RawMetricInput {
  platform: string;
  /** 原始字段：{ 平台字段名: 数值 } */
  fields: Record<string, number>;
}

/** 归一产出 */
export interface NormalizedMetric {
  raw: RawMetricInput;
  /** canonical → 数值；该平台无此口径/未映射记 null（不编造） */
  normalized: Record<CanonicalMetric, number | null>;
  /** 置信度 0-1：已归一的 canonical 占比（直接命中权重 1，别名命中权重 0.9） */
  confidence: number;
}

/** 归一化（纯函数）：平台未注册 → normalized 全 null、confidence 0 */
export function normalizeMetric(raw: RawMetricInput, registry: MetricMappingRegistry): NormalizedMetric {
  const mapping = registry.mappingOf(raw.platform);
  const normalized = {} as Record<CanonicalMetric, number | null>;
  let weightSum = 0;
  for (const metric of CANONICAL_METRICS) {
    const aliases = mapping?.[metric];
    if (!aliases || aliases.length === 0) {
      normalized[metric] = null;
      continue;
    }
    let hit: number | null = null;
    let weight = 0;
    for (let i = 0; i < aliases.length; i++) {
      const key = aliases[i]!;
      const v = raw.fields[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        hit = v;
        weight = i === 0 ? 1 : 0.9; // 首选字段满权重，别名命中略降
        break;
      }
    }
    normalized[metric] = hit;
    weightSum += weight;
  }
  return { raw, normalized, confidence: weightSum / CANONICAL_METRICS.length };
}

/* ---------- 双源差异比对（±10% divergent 标记） ---------- */

export interface MetricDiff {
  metric: CanonicalMetric;
  a: number | null;
  b: number | null;
  /** |a-b| / max(|a|,|b|)；任一侧为 null 或双零相等时为 null（不可比/无差异） */
  diffRatio: number | null;
  divergent: boolean;
}

export interface DivergenceReport {
  diffs: MetricDiff[];
  /** 任一指标 divergent 即整体 divergent */
  divergent: boolean;
}

/**
 * 双源比对（纯函数）：|a-b| / max(|a|,|b|) > tolerance（默认 0.10）标记 divergent。
 * 任一侧缺失（null）不可比 → divergent=false 且 diffRatio=null（不伪造差异）。
 * 双侧均为 0 视为无差异（防除零）。
 */
export function compareMetrics(
  a: NormalizedMetric["normalized"],
  b: NormalizedMetric["normalized"],
  tolerance = 0.10,
): DivergenceReport {
  const diffs: MetricDiff[] = CANONICAL_METRICS.map((metric) => {
    const va = a[metric];
    const vb = b[metric];
    if (va === null || vb === null) {
      return { metric, a: va, b: vb, diffRatio: null, divergent: false };
    }
    // 口径：差异率以基准侧（a，平台原始口径）为分母；基准为 0 而对比侧非 0 视为 100% 差异
    const denom = Math.abs(va);
    const ratio = denom === 0 ? (vb === 0 ? 0 : 1) : Math.abs(va - vb) / denom;
    return { metric, a: va, b: vb, diffRatio: ratio, divergent: ratio > tolerance };
  });
  return { diffs, divergent: diffs.some((d) => d.divergent) };
}

/* ---------- 内置默认映射（六平台采集口径别名表） ---------- */

/** 默认注册表：六平台常见字段别名（采集层落地前的归一入口） */
export function defaultMetricRegistry(): MetricMappingRegistry {
  const r = new MetricMappingRegistry();
  r.registerMetricMapping("douyin", {
    plays: ["play_count", "plays", "vv"],
    likes: ["digg_count", "likes"],
    comments: ["comment_count", "comments"],
    shares: ["share_count", "shares"],
    follows: ["follower_count", "fans_count", "follows"],
  });
  r.registerMetricMapping("xiaohongshu", {
    plays: ["views", "view_count", "plays"],
    likes: ["liked_count", "likes"],
    comments: ["comment_count", "comments"],
    shares: ["share_count", "shared_count", "shares"],
    follows: ["fans", "follower_count", "follows"],
  });
  r.registerMetricMapping("bilibili", {
    plays: ["play", "view", "plays"],
    likes: ["like", "likes"],
    comments: ["reply", "comment", "comments"],
    shares: ["share", "shares"],
    follows: ["follower", "fans", "follows"],
  });
  r.registerMetricMapping("tiktok", {
    plays: ["playCount", "plays"],
    likes: ["diggCount", "likes"],
    comments: ["commentCount", "comments"],
    shares: ["shareCount", "shares"],
    follows: ["followerCount", "fans", "follows"],
  });
  r.registerMetricMapping("shipinhao", {
    plays: ["play_count", "plays"],
    likes: ["like_num", "likes"],
    comments: ["comment_num", "comments"],
    shares: ["forward_num", "shares"],
    follows: ["fans_num", "follows"],
  });
  r.registerMetricMapping("youtube", {
    plays: ["viewCount", "views", "plays"],
    likes: ["likeCount", "likes"],
    comments: ["commentCount", "comments"],
    shares: ["shareCount", "shares"],
    follows: ["subscriberCount", "follows"],
  });
  return r;
}
