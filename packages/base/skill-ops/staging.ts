/**
 * skill-ops · staging 五道预检（方案 v0.2 §3.3）
 *
 * ① 签名核验（官方签名 + integrity，D12 同款）
 * ② schema + 依赖预检（zod 校验 + deps 可达性声明检查）
 * ③ 脱敏扫描（D15-①：maskText PII + 敏感凭据词清单）
 * ④ 注入对抗（D15-③：提示词注入模式扫描）
 * ⑤ 工具白名单/出站域 diff 定级（L0/L1/L2，权限面变化永不静默）
 * 任一门不过 = 整体不过（rejected），不降级、不跳过。
 */
import { scanSkillForInjection, scanSkillForPublish } from "../skills/publish.js";
import { verifySignature } from "./signature.js";
import { classifyTier, type CurrentState } from "./tier.js";
import { DistMeta, SkillPackage, type DistTier, type StagingCheck } from "./types.js";

export interface StagingResult {
  pass: boolean;
  tier: DistTier;
  checks: StagingCheck[];
  diff: ReturnType<typeof classifyTier>["diff"];
}

export function runStagingChecks(opts: {
  pkg: SkillPackage;
  signingKey: string;            // 空串 = 未配置（①直接不过，上层应已禁用分发）
  current: CurrentState | null;  // 本机已装现状（首装 null）
  depsAvailable?: (dep: string) => boolean; // 依赖可达性探测（默认仅形态校验）
}): StagingResult {
  const { pkg, signingKey, current } = opts;
  const checks: StagingCheck[] = [];

  // ① 签名核验
  const sigOk = verifySignature(signingKey, pkg);
  checks.push({
    gate: "signature",
    pass: sigOk,
    detail: sigOk ? "官方签名核验通过（HMAC-SHA256）" : "签名核验失败：分发包不完整或来源不可信，拒装",
  });

  // ② schema + 依赖预检（SkillPackage 入口已 zod 解析；此处复核 meta 与 deps 形态/可达性）
  const metaParse = DistMeta.safeParse(pkg.meta);
  let depsDetail = "schema 校验通过";
  let depsOk = metaParse.success;
  if (!metaParse.success) {
    depsDetail = `schema 校验失败：${metaParse.error.issues.map((i) => i.message).join("；")}`;
  } else if (pkg.meta.deps.length > 0) {
    const bad = pkg.meta.deps.filter((d) => !/^[a-z0-9@/_.-]+$/i.test(d));
    if (bad.length > 0) {
      depsOk = false;
      depsDetail = `依赖声明形态非法：${bad.join("、")}`;
    } else if (opts.depsAvailable) {
      const missing = pkg.meta.deps.filter((d) => !opts.depsAvailable!(d));
      if (missing.length > 0) {
        depsOk = false;
        depsDetail = `依赖不可达：${missing.join("、")}（技能级依赖须先安装，gate=smoke）`;
      } else {
        depsDetail = `schema 通过；依赖 ${pkg.meta.deps.length} 项可达`;
      }
    } else {
      depsDetail = `schema 通过；依赖 ${pkg.meta.deps.length} 项已声明（未做可达性探测）`;
    }
  }
  checks.push({ gate: "schema_deps", pass: depsOk, detail: depsDetail });

  // ③ 脱敏扫描（复用 D15-① 上架门禁同款扫描器）
  const piiHits = scanSkillForPublish(pkg.body, pkg.description);
  checks.push({
    gate: "pii",
    pass: piiHits.length === 0,
    detail: piiHits.length === 0 ? "脱敏扫描通过（无 PII/敏感凭据词）" : `脱敏扫描命中：${piiHits.map((h) => h.detail).join("；")}`,
  });

  // ④ 注入对抗（复用 D15-③ 注入模式扫描器）
  const injHits = scanSkillForInjection(pkg.body);
  checks.push({
    gate: "injection",
    pass: injHits.length === 0,
    detail: injHits.length === 0 ? "注入对抗扫描通过" : `注入对抗命中：${injHits.map((h) => h.detail).join("；")}`,
  });

  // ⑤ 白名单/出站/围栏 diff 定级
  const { tier, diff } = classifyTier(pkg, current);
  checks.push({
    gate: "tier_diff",
    pass: true, // 定级不是否决项，是决定静默/审批的分流器
    detail: `定级 ${tier}（category=${pkg.meta.category}；新增工具 ${diff.addedTools.length}、新增出站域 ${diff.addedEgress.length}、新增围栏绑定 ${diff.addedFence.length}）`,
  });

  const pass = checks.every((c) => c.pass);
  return { pass, tier, checks, diff };
}
