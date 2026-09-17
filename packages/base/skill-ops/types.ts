/**
 * skill-ops · 类型与 zod schema（技能分发的事实源）
 *
 * 方案 v0.2 §3.5：技能在 D17「内容资产」之上扩展分发元数据——
 * 类别 / 来源 / 依赖 / 工具白名单 / 出站域 / 围栏参数 / License / 签名。
 * 红线：credentials 字段永不出现——凭据只存客户本机，技能正文零凭据。
 */
import { z } from "zod";

/** 静默分级（§3.3）：L0 知识型 / L1 内容增强（零 diff）/ L2 工具型·权限面变化 */
export type DistTier = "L0" | "L1" | "L2";

/** 技能类别：knowledge=纯内容；tool-execution=执行面（带工具/依赖/出站） */
export const SkillCategory = z.enum(["knowledge", "tool-execution"]);
export type SkillCategory = z.infer<typeof SkillCategory>;

/** 来源：官方自研 / 开源收录 / 客户回流官方化 */
export const SkillOrigin = z.enum(["official-authored", "oss-curated", "customer-reflux"]);
export type SkillOrigin = z.infer<typeof SkillOrigin>;

/** 分发元数据（存 skills.dist_meta JSONB 列；本 schema 为类型事实源） */
export const DistMeta = z.object({
  category: SkillCategory.default("knowledge"),
  origin: SkillOrigin.default("official-authored"),
  /** 技能级依赖（CLI/python 包等），安装预检用；登记为技能级而非基座依赖（gate=smoke） */
  deps: z.array(z.string()).default([]),
  /** 工具白名单：技能可调用的命令/端点前缀 → 进围栏判定（B9 白名单校验先例扩展） */
  toolWhitelist: z.array(z.string()).default([]),
  /** 出站域清单 → WorkData 三段瀑布出站审计（D20 模型出站脱敏先例扩展） */
  egressDomains: z.array(z.string()).default([]),
  /** 建议围栏参数（账号日上限、时段窗口等），装配时参考 */
  fenceParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  license: z.string().default(""),
  sourceRepo: z.string().default(""),
});
export type DistMeta = z.infer<typeof DistMeta>;

/** 分发包：官方 registry 下发的单个技能版本（signature 覆盖 body+version+meta 的 HMAC-SHA256） */
export const SkillPackage = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  body: z.string().min(1),
  fenceBindings: z.array(z.string()).default([]),
  meta: DistMeta,
  /** HMAC-SHA256 签名（hex）：signing key 由官方持有，客户实例经 SKILL_DIST_SIGNING_KEY 验签 */
  signature: z.string().regex(/^[0-9a-f]{64}$/, "签名须为 64 位 hex（HMAC-SHA256）"),
});
export type SkillPackage = z.infer<typeof SkillPackage>;

/** 定向投放标签：命中的实例才接收（官方只按标签定向，不读客户库） */
export const DistTargets = z.object({
  bundles: z.array(z.string()).optional(),   // 行业 Bundle（hotel 等）；缺省=全部
  editions: z.array(z.string()).optional(),  // 版本档（community/pro）；缺省=全部
});
export type DistTargets = z.infer<typeof DistTargets>;

/** Manifest：官方 registry 目录（客户端夜班窗口拉取比对） */
export const DistManifest = z.object({
  registryVersion: z.string().min(1),
  publishedAt: z.string().min(1),
  entries: z.array(z.object({
    targets: DistTargets.default({}),
    package: SkillPackage,
  })),
});
export type DistManifest = z.infer<typeof DistManifest>;

/** 预检结果明细（存 skill_dist_staging.checks） */
export interface StagingCheck {
  gate: "signature" | "schema_deps" | "pii" | "injection" | "tier_diff";
  pass: boolean;
  detail: string;
}

/** 本实例标签（定向匹配的匹配面） */
export interface InstanceProfile {
  bundles: string[];   // 已装配的行业 Bundle
  edition: string;     // 版本档（env SKILL_DIST_EDITION，默认 community）
}

/** 静默策略（skill_dist_policy） */
export type SilentMode = "silent" | "prompt";
