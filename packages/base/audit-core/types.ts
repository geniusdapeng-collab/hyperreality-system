/**
 * @workloom/audit-core · 质检检测引擎通用内核（行业无关）
 *
 * 定位：各行业仓质检模式共享的引擎骨架——
 *   行业包只提供「快照类型 + 分析器」，内核统一承载：
 *   Finding/报告模型、软时间预算、数据源缺源降级、发现编号、TopN 排序、估算口径纪律。
 *
 * 纪律（与各行业 fast-scan SKILL.md 一致）：
 *  - 纯函数确定性：内核与分析器均为纯函数，时钟经 AnalyzerContext 注入，禁读系统时钟（可复算）；
 *  - 估算透明：Finding.impact 必须带 confidence（exact/baseline/estimate）与 basis（计算口径），
 *    禁止把估算说成确定值；
 *  - 降级不阻塞：某数据源缺失 → 该线标 not-covered/partial 出部分报告；
 *  - 时间纪律：软预算（默认 30 分钟）耗尽后，剩余线标 not-covered 出部分报告。
 */

/** 严重度：P0=立即处置（资损/合规/封禁风险） P1=限期整改 P2=优化建议 */
export type Severity = "P0" | "P1" | "P2";

/** 估算置信度：exact=精确值 / baseline=按基准（类目/历史）估算 / estimate=经验估计 */
export type ImpactConfidence = "exact" | "baseline" | "estimate";

/** 估算周期 */
export type ImpactPeriod = "one-off" | "daily" | "monthly" | "yearly";

/** 估算影响（金额/粉丝/线索等，unit 由行业定义：CNY/USD/FANS/LEADS…） */
export interface EstimatedImpact {
  amount: number;
  unit: string;
  period: ImpactPeriod;
  confidence: ImpactConfidence;
  /** 计算口径（必填）：怎么算出来的，如 "(max-min)/max=18% × 近30天该对象该渠道销量" */
  basis: string;
}

/** 证据引用（可回溯到快照中的具体记录） */
export interface EvidenceRef {
  kind: string;
  id: string;
  note?: string;
}

/** 一条体检发现 */
export interface Finding {
  /** 统一编号 FND-<LINE>-<n>（引擎分配，分析器留空由引擎补齐亦可） */
  id: string;
  /** 检线标识（行业自定义，如 price/inventory/ads/geo/funnel…） */
  line: string;
  severity: Severity;
  title: string;
  detail?: string;
  evidence: EvidenceRef[];
  /** 计算过程快照（可复算） */
  calculation?: string;
  impact?: EstimatedImpact;
  suggestion?: string;
  /** 归属店铺/账号（多店快照时必填） */
  shopId?: string;
}

/** 数据源覆盖度 */
export type Coverage = "covered" | "partial" | "not-covered";

/** 单线执行结果 */
export interface LineResult {
  line: string;
  coverage: Coverage;
  note?: string;
  findings: Finding[];
  durationMs: number;
}

/** 分析器上下文（时钟注入，保证可复算） */
export interface AnalyzerContext {
  now: Date;
  line: string;
}

/** 行业分析器签名：纯函数，输入快照输出发现 */
export type Analyzer<S> = (snapshot: S, ctx: AnalyzerContext) => Finding[];

/**
 * 检线定义（行业包提供）：
 *  - precheck：数据源覆盖度预判（全空→not-covered；关键子集缺失→partial，附 note）
 *  - analyze：该线分析器
 */
export interface LineDef<S> {
  line: string;
  precheck: (snapshot: S) => { coverage: Coverage; note?: string };
  analyze: Analyzer<S>;
}

/** 引擎入参 */
export interface FastScanOptions {
  /** 锚定钟（默认真实当前时间；测试/复算时注入固定值） */
  now?: Date;
  /** 软时间预算（毫秒，默认 30 分钟=1_800_000；耗尽后剩余线标 not-covered） */
  softBudgetMs?: number;
  reportId?: string;
  snapshotId?: string;
  /** Top 行动清单条数（默认 10） */
  topN?: number;
}

/** 体检报告 */
export interface AuditReport {
  reportId: string;
  snapshotId: string;
  generatedAt: string;
  durationMs: number;
  /** 各线覆盖度（line → coverage） */
  coverage: Record<string, Coverage>;
  lineResults: LineResult[];
  /** 全部发现（P0→P1→P2，同档按年化挽回降序） */
  findings: Finding[];
  /** Top 行动清单（按年化挽回降序） */
  top: Finding[];
  totals: {
    p0: number;
    p1: number;
    p2: number;
    /** 按单位聚合的挽回空间（年化归一：daily×365、monthly×12、one-off×1、yearly×1） */
    byUnit: Record<string, number>;
  };
}
