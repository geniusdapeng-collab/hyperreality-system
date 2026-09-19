/**
 * compose.mjs · 组合编制/围栏的**可移植**读取层（RDAS v1）
 *
 * 两类仓的现实差异：获客仓（workloom / WorkLoom-growth）带 `composeWorkforce` 之类的组合 API；
 * 基座与其他行业仓只有单包装配。验收器必须两种都能跑，否则「同一套标准验 10 个仓」就是空话。
 *
 * 顺序：① 能用组合 API 就用（最权威）→ ② 否则按 bundle.json 的依赖顺序做**本地组合**，
 * 语义与组合 API 对齐：同名 preset 取显式 presetOwners 归属，围栏取并集（只紧不松）。
 * 走兜底路径时返回 viaApi=false，报告里必须写明（证据等级降为 B）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));

function listFiles(dir, filter) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => filter(name) && statSync(join(dir, name)).isFile())
    .map((name) => join(dir, name))
    .sort();
}

/** 单包技能资产：bundles/<id>/skills/<key>/SKILL.md（provides.skills 存在时优先按它读） */
export function readBundleSkillDocs(repoRoot, bundleId, manifestPath) {
  const bundleRoot = join(repoRoot, "bundles", bundleId);
  const paths = [];
  try {
    const manifest = readJson(manifestPath ?? join(bundleRoot, "bundle.json"));
    for (const assetPath of manifest?.workloom?.provides?.skills ?? []) {
      const full = join(bundleRoot, assetPath);
      if (existsSync(full)) paths.push(full);
    }
  } catch { /* 清单不可读时退回目录扫描 */ }
  if (paths.length === 0) {
    const skillsDir = join(bundleRoot, "skills");
    if (existsSync(skillsDir)) {
      for (const key of readdirSync(skillsDir).sort()) {
        const file = join(skillsDir, key, "SKILL.md");
        if (existsSync(file)) paths.push(file);
      }
    }
  }
  return paths;
}

function parseSkillDoc(file) {
  const raw = readFileSync(file, "utf-8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const parsed = (YAML.parse(fm?.[1] ?? "{}") ?? {});
  return {
    key: String(parsed.name ?? file.split("/").at(-2)),
    description: String(parsed.description ?? ""),
    body: (fm?.[2] ?? "").trim(),
  };
}

/** 本地组合（兜底路径）：依赖在前、主包在后；同名取 presetOwners 归属；围栏取并集 */
function fallbackComposition(repoRoot, slug) {
  const bundlesRoot = process.env.BUNDLES_ROOT ?? join(repoRoot, "bundles");
  const primaryManifestPath = join(bundlesRoot, slug, "bundle.json");
  const primary = readJson(primaryManifestPath);
  const dependencyIds = (primary?.workloom?.dependencies ?? []).map((d) => d.bundleId).filter(Boolean);
  const bundleIds = [...dependencyIds, slug];
  const owners = primary?.workloom?.composition?.presetOwners ?? {};

  const warnings = [];
  const byKey = new Map();
  const fenceRules = new Map();
  const skillDocs = [];
  for (const bundleId of bundleIds) {
    const bundleRoot = join(bundlesRoot, bundleId);
    // presets
    for (const file of listFiles(join(bundleRoot, "presets"), (n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
      const preset = YAML.parse(readFileSync(file, "utf-8")) ?? {};
      const key = String(preset.preset_key ?? "");
      if (!key) { warnings.push(`${bundleId}/${file.split("/").pop()} 缺 preset_key，已跳过`); continue; }
      byKey.set(key, [...(byKey.get(key) ?? []), { bundleId, preset }]);
    }
    // fences（基线：不含 patches/ 客户级收紧包）
    for (const file of listFiles(join(bundleRoot, "fences"), (n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
      const doc = YAML.parse(readFileSync(file, "utf-8")) ?? {};
      const rules = doc.rules ?? doc.fences ?? [];
      for (const rule of rules) {
        if (!rule?.rule_id) continue;
        const level = rule.level ?? "review";
        const prev = fenceRules.get(rule.rule_id);
        const rank = { auto: 0, review: 1, block: 2 };
        if (!prev || (rank[level] ?? 1) > (rank[prev.level] ?? 1)) fenceRules.set(rule.rule_id, { ruleId: rule.rule_id, level, bundleId });
      }
    }
    // skills
    for (const file of readBundleSkillDocs(repoRoot, bundleId)) {
      const doc = parseSkillDoc(file);
      skillDocs.push({ bundle: bundleId, ...doc, file });
    }
  }

  const presets = new Map();
  const shadowed = [];
  for (const [key, definitions] of byKey) {
    if (definitions.length === 1) {
      const only = definitions[0];
      presets.set(key, {
        preset: only.preset,
        bundleId: only.bundleId,
        fenceBindings: [...(only.preset.fence_bindings ?? [])].sort(),
        shadowedBundleIds: [],
      });
      continue;
    }
    const involved = definitions.map((d) => d.bundleId).sort();
    const owner = owners[key];
    const winner = owner ? definitions.find((d) => d.bundleId === owner) : definitions.at(-1);
    if (!owner) warnings.push(`岗位「${key}」在 ${involved.join("/")} 重复定义且未声明 presetOwners，已按「主包优先」裁决（需人工确认）`);
    const losers = definitions.filter((d) => d !== winner);
    if (winner && losers.length) {
      shadowed.push(...losers.map((l) => ({ presetKey: key, bundleId: l.bundleId, winnerBundleId: winner.bundleId })));
      presets.set(key, {
        preset: winner.preset,
        bundleId: winner.bundleId,
        fenceBindings: [...new Set([
          ...(winner.preset.fence_bindings ?? []),
          ...losers.flatMap((l) => l.preset.fence_bindings ?? []),
        ])].sort(),
        shadowedBundleIds: losers.map((l) => l.bundleId).sort(),
      });
    }
  }

  return {
    viaApi: false,
    bundleIds,
    presets,
    shadowed,
    fenceRules,
    skillDocs,
    warnings,
  };
}

/**
 * 读取组合编制：优先组合 API（获客仓），否则本地组合（基座/其他行业仓）。
 * @returns {Promise<{viaApi:boolean,bundleIds:string[],presets:Map<string,{preset:object,bundleId:string,fenceBindings:string[],shadowedBundleIds:string[]}>,shadowed:Array<object>,fenceRules:Map<string,{ruleId:string,level:string,bundleId?:string}>,skillDocs:Array<object>,warnings:string[]}>}
 */
export async function loadComposition(repoRoot, slug) {
  try {
    const mod = await import("@workloom/base/bundles");
    if (typeof mod.composeWorkforce === "function" && typeof mod.loadComposedAssets === "function") {
      const composed = mod.loadComposedAssets(slug);
      const workforce = mod.composeWorkforce(slug);
      const mergedRules = typeof mod.mergeComposedFenceRules === "function" ? mod.mergeComposedFenceRules(composed.fencePacks) : [];
      const presets = new Map();
      for (const [key, entry] of workforce.presets) {
        presets.set(key, {
          preset: entry.preset,
          bundleId: entry.bundleId,
          fenceBindings: entry.effectiveFenceBindings ?? [],
          shadowedBundleIds: entry.shadowedBundleIds ?? [],
        });
      }
      const fenceRules = new Map();
      for (const item of mergedRules) {
        const rule = item.rule ?? item;
        if (rule?.rule_id) fenceRules.set(rule.rule_id, { ruleId: rule.rule_id, level: rule.level ?? "review", bundleId: item.bundleId });
      }
      const skillDocs = [];
      for (const bundleId of composed.bundleIds) {
        for (const file of readBundleSkillDocs(repoRoot, bundleId)) skillDocs.push({ bundle: bundleId, ...parseSkillDoc(file), file });
      }
      return {
        viaApi: true,
        bundleIds: composed.bundleIds,
        presets,
        shadowed: composed.shadowed ?? [],
        fenceRules,
        skillDocs,
        warnings: [],
      };
    }
  } catch {
    /* 该仓没有组合 API：走本地组合 */
  }
  return fallbackComposition(repoRoot, slug);
}
