/**
 * overlay/assembly-hook.ts —— 装配器接入点：L0→L1→L2 三层合并
 *
 * 在 computeAssembly 的 RLS 事务内被调用：读取租户活跃覆盖层（无则原样返回），
 * 用 merge-engine 合并后写回磁盘资产对象，并附带合并审计（留痕进装配档案）。
 * 设计：无覆盖层 = 零开销零行为变化（对存量工作区完全透明）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { mergeOverlay, type BundleAssetView, type MergeResult } from "./merge.js";
import { loadActiveOverlay, type OverlayScope } from "./store.js";
import type { OverlayDoc } from "./model.js";

/** 与装配器 BundleDiskAssets 结构保持松散兼容（只依赖我们消费的字段） */
export interface AssemblyAssetsLike {
  dir: string;
  /** bundle.json 原文（各装配器 BundleJson 变体宽松兼容，toView 内归一） */
  bj: unknown;
  /** presets/*.yml 解析结果（PresetYml 等变体宽松兼容，toView 内归一） */
  presets: unknown[];
  fencePacks: unknown[];
  /** 覆盖层写回的扩展资产（persona/kb 等）与审计——装配档案可消费 */
  extra?: Record<string, unknown>;
  overlayApplied?: { tenantId: string; overlayVersion: number; audit: MergeResult["audit"] } | null;
}

function toView(assets: AssemblyAssetsLike): BundleAssetView {
  const extra: Record<string, unknown> = { ...(assets.extra ?? {}) };
  // 知识类覆盖的作用对象：service-front/faq.json（存在则载入，供 kb 三路合并）
  const faqPath = join(assets.dir, "service-front", "faq.json");
  if (extra.faq === undefined && existsSync(faqPath)) {
    try {
      const raw = JSON.parse(readFileSync(faqPath, "utf-8")) as { faqs?: Array<{ id?: string; q: string; a: string }> };
      extra.faq = Array.isArray(raw?.faqs) ? raw.faqs : [];
    } catch { extra.faq = []; }
  }
  return {
    bj: assets.bj as BundleAssetView["bj"],
    presets: assets.presets as BundleAssetView["presets"],
    fencePacks: assets.fencePacks as BundleAssetView["fencePacks"],
    extra,
  };
}

/**
 * 装配钩子：读取租户活跃覆盖层并合并（在 RLS 事务内调用，client 已带 workspace 上下文）。
 * @returns 覆盖层文档（无覆盖层时为 null；assets 已被原地合并更新）
 */
export async function maybeApplyOverlay(
  client: Pick<pg.PoolClient, "query">,
  scope: OverlayScope,
  slug: string,
  assets: AssemblyAssetsLike,
): Promise<OverlayDoc | null> {
  const doc = await loadActiveOverlay(client, scope, slug);
  if (!doc || doc.items.length === 0) {
    assets.overlayApplied = null;
    return null;
  }
  const merged = mergeOverlay(toView(assets), doc);
  assets.bj = merged.assets.bj;
  assets.presets = merged.assets.presets;
  assets.fencePacks = merged.assets.fencePacks;
  assets.extra = merged.assets.extra;
  assets.overlayApplied = {
    tenantId: scope.tenantId,
    overlayVersion: doc.overlay_version,
    audit: merged.audit,
  };
  return doc;
}
