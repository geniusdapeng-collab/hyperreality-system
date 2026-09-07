/**
 * 租户覆盖层 · Rebase 检测器（M3-1）
 * 行业包升级时逐条检查覆盖层兼容性——「升级永远丢不了你的定制」的工程兑现：
 *  - compatible：该项在新行业包上仍成立，原样保留；
 *  - auto_fallback：该项引用的对象在新行业包已不存在 → 自动落回行业默认
 *    （从覆盖层摘除该项，报告留痕，宁缺毋滥）；
 *  - needs_decision：语义冲突（行业包围栏级别已变化、阈值默认已改）
 *    → 保留现状但挂「待裁决」，晨报/健康分可见，人裁决前不静默改动。
 * 输出《Rebase 报告》：谁兼容、谁落回、谁待裁决——升级影响一纸看清（DoD ②）。
 */
import { kbEntriesOf, thresholdOf, type BundleAssetView } from "./merge.js";
import type { OverlayDoc, OverlayItem } from "./model.js";

export type RebaseVerdict = "compatible" | "auto_fallback" | "needs_decision";

export interface RebaseItemReport {
  index: number;
  type: OverlayItem["type"];
  path: string;
  verdict: RebaseVerdict;
  reason: string;
}

export interface RebaseReport {
  base_bundle: string;
  from_version: string;
  to_version: string;
  overlay_version: number;
  compatible: number;
  autoFallback: number;
  needsDecision: number;
  items: RebaseItemReport[];
  /** 落回后的新覆盖项集（auto_fallback 摘除 + 其余保留），可直接存为新草稿 */
  rebasedItems: OverlayItem[];
}

function presetKeys(view: BundleAssetView): Set<string> {
  return new Set((view.presets ?? []).map((p) => String(p.preset_key)));
}
function fenceRule(view: BundleAssetView, ruleId: string): { level?: string } | null {
  for (const p of view.fencePacks ?? []) {
    for (const f of p.fences ?? []) {
      if (String(f.rule_id) === ruleId) return f as { level?: string };
    }
  }
  return null;
}
/** 技能存在性：presets[].skills 引用与 provides.skills 双源核对 */
function skillExists(view: BundleAssetView, name: string): boolean {
  const provides = (view.bj.workloom?.provides as Record<string, unknown> | undefined)?.skills;
  if (Array.isArray(provides) && provides.some((s) => String(s).includes(`/${name}/`))) return true;
  return (view.presets ?? []).some((p) =>
    Array.isArray(p.skills) && (p.skills as unknown[]).map(String).includes(name));
}
/** 知识条目存在性：按常见集合路径扫描（faq/kb/service-catalog 等） */
function kbEntryExists(view: BundleAssetView, entryPath: string): boolean {
  const [coll, id] = entryPath.split("/");
  if (!coll || !id) return false;
  return kbEntriesOf(view, coll).some((e) => String(e.id) === id);
}

/** 单条覆盖项兼容判定 */
export function checkItem(item: OverlayItem, index: number, newView: BundleAssetView): RebaseItemReport {
  const base = { index, type: item.type, path: item.path };
  switch (item.type) {
    case "persona":
    case "brand":
      return { ...base, verdict: "compatible", reason: "话术/品牌为纯覆盖，与行业包升级无关" };
    case "kb": {
      if (item.op === "append") return { ...base, verdict: "compatible", reason: "新增条目无依赖" };
      if (!kbEntryExists(newView, item.path)) {
        return { ...base, verdict: "auto_fallback", reason: `行业包已删除知识条目 ${item.path}（${item.op} 失去目标）→ 落回默认` };
      }
      return { ...base, verdict: "compatible", reason: "目标条目仍存在于新行业包" };
    }
    case "crew": {
      const key = item.path.replace(/^presets\//, "");
      if (!presetKeys(newView).has(key)) {
        return { ...base, verdict: "auto_fallback", reason: `新行业包已移除员工 ${key} → 编制调整落回默认` };
      }
      return { ...base, verdict: "compatible", reason: "员工仍存在" };
    }
    case "threshold": {
      if (thresholdOf(newView, item.path) === undefined) {
        return { ...base, verdict: "auto_fallback", reason: `新行业包已移除阈值 ${item.path} → 落回默认` };
      }
      const newDefault = thresholdOf(newView, item.path);
      return { ...base, verdict: "compatible", reason: `阈值仍存在（新行业包默认 ${newDefault}，租户 ${item.value}）` };
    }
    case "skill": {
      const name = item.path.replace(/^skills\//, "");
      if (!skillExists(newView, name)) {
        return { ...base, verdict: "auto_fallback", reason: `新行业包已移除技能 ${name} → 落回默认` };
      }
      return { ...base, verdict: "compatible", reason: "技能仍存在" };
    }
    case "fence": {
      const ruleId = item.path.replace(/^fences\//, "");
      const rule = fenceRule(newView, ruleId);
      if (!rule) {
        return { ...base, verdict: "auto_fallback", reason: `新行业包已移除围栏 ${ruleId} → 收紧项落回默认` };
      }
      if (String(rule.level) !== item.from) {
        return { ...base, verdict: "needs_decision", reason: `新行业包围栏 ${ruleId} 级别已从 ${item.from} 变为 ${rule.level}（租户收紧基线失效）→ 待裁决` };
      }
      return { ...base, verdict: "compatible", reason: "围栏规则与级别未变" };
    }
  }
}

/** 全量检测：行业包 from→to 升级时，对当前覆盖层逐条判定并生成报告 */
export function detectRebase(doc: OverlayDoc, newView: BundleAssetView, toVersion: string): RebaseReport {
  const items = doc.items.map((item, i) => checkItem(item, i, newView));
  const rebasedItems = doc.items.filter((_, i) => items[i]!.verdict !== "auto_fallback");
  return {
    base_bundle: doc.base_bundle,
    from_version: doc.base_version,
    to_version: toVersion,
    overlay_version: doc.overlay_version,
    compatible: items.filter((r) => r.verdict === "compatible").length,
    autoFallback: items.filter((r) => r.verdict === "auto_fallback").length,
    needsDecision: items.filter((r) => r.verdict === "needs_decision").length,
    items,
    rebasedItems,
  };
}

/** 报告一行话摘要（晨报/通知卡片用） */
export function rebaseSummary(r: RebaseReport): string {
  if (r.autoFallback === 0 && r.needsDecision === 0) {
    return `行业包升级 ${r.from_version}→${r.to_version}：您的 ${r.compatible} 项定制全部兼容，无需处理`;
  }
  const parts: string[] = [];
  if (r.compatible > 0) parts.push(`${r.compatible} 项兼容`);
  if (r.autoFallback > 0) parts.push(`${r.autoFallback} 项已自动落回行业默认`);
  if (r.needsDecision > 0) parts.push(`${r.needsDecision} 项待您裁决`);
  return `行业包升级 ${r.from_version}→${r.to_version}：${parts.join("，")}`;
}
