/**
 * @workloom/audit-engine · 核心类型（社媒营销版）
 * 质检模式（audit_only）「账号快照快扫」的确定性检测引擎数据模型。
 * 方法论事实源：bundles/ai-video/skills/fast-scan/SKILL.md（四线扫描）。
 *
 * 数据流：连接器只读快照 → AuditSnapshot（归一化数据集）→ 四个分析器 → Finding[] → AuditReport。
 * 全程只读：引擎不触碰任何平台写接口，只读快照进、发现/报告出。
 */

// ---------- 枚举 ----------

/** 四线：账号健康 / 内容健康 / 评论与口碑 / 转化健康（SKILL.md 步骤 2→5） */
export type AuditLine = "account" | "content" | "comments" | "conversion";

/** 严重度：P0=立即止损/合规红线，P1=显著渗漏需本周处理，P2=优化项 */
export type Severity = "P0" | "P1" | "P2";

/** 估算置信度：exact=可逐条勾稽的精确值；baseline=按账号/类目基准估算；estimate=经验估计 */
export type Confidence = "exact" | "baseline" | "estimate";

/** 估算口径周期 */
export type ImpactPeriod = "one-off" | "monthly" | "yearly";

/**
 * 估算计量单位（社媒口径，非 ISO 4217）：
 *  FANS=预估涨粉/粉丝流失；LEADS=预估线索（条）；CNY=可折算金额（极少数子项）。
 * 每条 estimatedImpact 必须在 basis 中写明计算口径（SKILL.md：估算口径透明）。
 */
export type ImpactUnit = "FANS" | "LEADS" | "CNY";

// ---------- 快照数据集（输入） ----------

/** 违规/处罚记录（账号健康线输入） */
export interface ViolationRecord {
  violationId: string;
  /** 违规类型描述（如"搬运判定""导流处罚"） */
  type: string;
  occurredAt: string; // ISO 8601
  level: "warning" | "minor" | "major";
}

/** 主页资料与转化组件核查面（头像/简介归账号线；橱窗/预约/联系方式归转化线，互不双算） */
export interface ProfileComponents {
  avatar: boolean;
  bio: boolean;
  /** 商品橱窗/团购挂载位 */
  showcase: boolean;
  /** 预约组件 */
  booking: boolean;
  /** 联系方式（电话/微信/官网链接任一） */
  contact: boolean;
}

/** 私信自动回复配置状态（转化线输入） */
export interface AutoReplyStatus {
  configured: boolean;
  /** 已配置但失效（如接口掉授权/开关被关） */
  active: boolean;
}

/** 账号档案 + 状态指标（缺省字段表示该指标未采集，对应子项降级） */
export interface AccountInfo {
  accountId: string;
  platformId: string;
  accountName: string;
  /** 内容类目（缺失时基准估算口径标注"按类目基准估算"失败则降级 estimate） */
  category?: string;
  followers: number;
  profile: ProfileComponents;
  violations: ViolationRecord[];
  /** 近 30 天敏感操作次数（频繁改绑/换设备/改实名等，G16 域只读核查输入） */
  sensitiveOps30d?: number;
  autoReply?: AutoReplyStatus;
  /** 自设发布节律（条/周；缺失时节律子项降级） */
  expectedPostsPerWeek?: number;
  /** 粉丝活跃高峰小时（0-23；缺失时时段错配子项降级） */
  trafficPeakHours?: number[];
}

/** 内容（视频/图文）记录（账号线限流判定、内容线全子项、转化线挂载核查输入） */
export interface VideoRecord {
  accountId: string;
  videoId: string;
  title: string;
  publishedAt: string; // ISO 8601
  plays: number;
  /** 完播率 0-1（未采集可省略，完播子项跳过该条） */
  completionRate?: number;
  likes: number;
  comments: number;
  shares: number;
  /** 选题方向（高潜素材复用判定的分组键） */
  topic?: string;
  /** 是否挂载转化组件（橱窗/团购/预约/链接任一） */
  hasConversionComponent: boolean;
  /** 内容指纹（矩阵搬运判定：同 hash 多号发布=重复内容） */
  contentHash?: string;
}

/** 评论记录（评论与口碑线输入） */
export interface CommentRecord {
  accountId: string;
  commentId: string;
  videoId?: string;
  text: string;
  createdAt: string; // ISO 8601
  /** 回复/处置时间；未处理省略 */
  repliedAt?: string;
  sentiment: "positive" | "neutral" | "negative";
  /** 高意向咨询（求购/询价/怎么买类） */
  isInquiry?: boolean;
  /** 命中敏感词（政治/违禁/舆情苗头） */
  hasSensitiveWord?: boolean;
}

/** 线索记录（询盘→跟进链路，转化线断点判定输入） */
export interface LeadRecord {
  accountId: string;
  leadId: string;
  /** 询盘时间（私信/表单/评论转化而来） */
  inquiryAt: string; // ISO 8601
  /** 首次跟进时间；未跟进省略 */
  followedUpAt?: string;
  sourceVideoId?: string;
}

/**
 * 快照数据集：一次体检的全部输入。
 * 各字段可为空数组——对应数据源缺失时该线标注「未覆盖」，引擎降级出部分报告（SKILL.md 四）。
 */
export interface AuditSnapshot {
  snapshotId: string;
  /** 快照生成时间（断更天数、未回复时长、近 30 天窗口等均以 now 为锚） */
  generatedAt: string; // ISO 8601
  accounts: AccountInfo[];
  videos: VideoRecord[];
  comments: CommentRecord[];
  leads: LeadRecord[];
  /** 客户自带敏感词（与内置词库并集扫描） */
  sensitiveWords: string[];
}

// ---------- 发现（输出） ----------

/** 证据记录引用：指向快照中的具体单据 */
export interface EvidenceRef {
  /** 证据类别：account/video/comment/lead/violation */
  kind: string;
  id: string;
  /** 关键字段快照（审计留痕，原样透传） */
  fields?: Record<string, string | number>;
}

/** 计算过程快照：公式 + 输入 + 结果，报告可复算（SKILL.md 回执=计算过程快照） */
export interface CalculationSnapshot {
  formula: string;
  inputs: Record<string, number | string>;
  result: number | string;
}

/** 估算挽回/涨粉量（禁止把估算说成确定值——confidence 必填，社媒口径 unit 见 ImpactUnit） */
export interface EstimatedImpact {
  amount: number;
  /** 计量单位：FANS/LEADS/CNY（字段名与电商版一致，社媒版语义为计量单位） */
  currency: ImpactUnit;
  period: ImpactPeriod;
  confidence: Confidence;
  /** 计算口径说明（如"按基准播放量×涨粉转化率0.3%"） */
  basis: string;
}

export interface Finding {
  /** 引擎内唯一编号：FND-<线>-<序号> */
  id: string;
  line: AuditLine;
  severity: Severity;
  accountId: string;
  title: string;
  /** 问题描述 + 建议动作 */
  description: string;
  suggestion: string;
  evidence: EvidenceRef[];
  calculation: CalculationSnapshot;
  estimatedImpact?: EstimatedImpact;
}

// ---------- 报告（输出） ----------

/** 单条线的覆盖度：covered=已扫描；partial=部分子项因数据缺失降级；not-covered=数据源缺失/超时未扫 */
export type LineCoverage = "covered" | "partial" | "not-covered";

/** 一账号一份 */
export interface AccountReport {
  accountId: string;
  accountName: string;
  platformId: string;
  followers: number;
  findings: Finding[];
  /** 按严重度计数 */
  counts: Record<Severity, number>;
  /** 该号估算挽回合计（按计量单位分桶，不跨单位相加） */
  totalRecoverableByUnit: Record<string, number>;
}

/** 矩阵总览 */
export interface MatrixOverview {
  accountCount: number;
  findingCount: number;
  counts: Record<Severity, number>;
  /** 按计量单位分桶的估算挽回合计（FANS/LEADS 不互相折算） */
  totalRecoverableByUnit: Record<string, number>;
}

export interface AuditReport {
  reportId: string;
  generatedAt: string;
  /** 快照引用（审计留痕） */
  snapshotId: string;
  /** 各线覆盖度（未覆盖的线在此标注，报告仍为有效部分报告） */
  coverage: Record<AuditLine, LineCoverage>;
  /** 覆盖度备注（如"评论源缺失，口碑线降级"） */
  coverageNotes: string[];
  accounts: AccountReport[];
  overview: MatrixOverview;
  /** 按估算挽回降序的 Top10 行动清单（矩阵视角） */
  top10: Finding[];
  /** 实际耗时（毫秒）与软预算（分钟），时间纪律留痕 */
  elapsedMs: number;
  timeBudgetMinutes: number;
}

/** runFastScan 选项 */
export interface FastScanOptions {
  /** 软时间预算（分钟），默认 30；超时后剩余线标注 not-covered 出部分报告 */
  timeBudgetMinutes?: number;
  /** 报告锚定时间（默认取 snapshot.generatedAt；测试可注入固定钟） */
  now?: Date;
}
