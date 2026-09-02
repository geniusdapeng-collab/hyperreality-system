/**
 * skill-ops · 签名验签（staging 预检①）
 *
 * 官方签名 = HMAC-SHA256(key, payload)，payload = canonical(skillId+version+body+meta)。
 * D12 同款思路：vendor 锁版 + integrity 核验——分发包完整性不可信源即拒。
 * key 经 env SKILL_DIST_SIGNING_KEY 注入；未配置 = 分发功能整体禁用（不降级为跳过验签）。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SkillPackage } from "./types.js";

/** 规范化签名载荷：字段定序拼接，防 JSON 键序差异导致验签抖动 */
export function canonicalPayload(pkg: Pick<SkillPackage, "skillId" | "version" | "body" | "meta">): string {
  return JSON.stringify({
    skillId: pkg.skillId,
    version: pkg.version,
    body: pkg.body,
    meta: {
      category: pkg.meta.category,
      origin: pkg.meta.origin,
      deps: [...pkg.meta.deps].sort(),
      toolWhitelist: [...pkg.meta.toolWhitelist].sort(),
      egressDomains: [...pkg.meta.egressDomains].sort(),
      fenceParams: Object.fromEntries(Object.entries(pkg.meta.fenceParams).sort(([a], [b]) => a.localeCompare(b))),
      license: pkg.meta.license,
      sourceRepo: pkg.meta.sourceRepo,
    },
  });
}

export function signPackage(key: string, pkg: Pick<SkillPackage, "skillId" | "version" | "body" | "meta">): string {
  return createHmac("sha256", key).update(canonicalPayload(pkg)).digest("hex");
}

/** 验签（时序安全比较）；key 为空返回 false——调用方负责"未配置即禁用"的上层判定 */
export function verifySignature(key: string, pkg: SkillPackage): boolean {
  if (!key) return false;
  const expect = signPackage(key, pkg);
  const a = Buffer.from(expect, "utf-8");
  const b = Buffer.from(pkg.signature, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}
