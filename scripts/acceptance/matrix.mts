#!/usr/bin/env node
/**
 * matrix.mts · L0 契约层 + L1 运行层 验收矩阵（RDAS v1，规范见 docs/REAL-DEVICE-ACCEPTANCE-SPEC.md）
 *
 * 事实源三合一：
 *   ① 组合编制（composeWorkforce / loadComposedAssets：bundle 清单 + preset 文件）
 *   ② 运行态（agents / fence_rules / skills / skill_installs / bundle_installs）
 *   ③ 技能文档（各包 skills/<key>/SKILL.md）
 *
 * 输出：agent-matrix.{json,csv} / skill-matrix.{json,csv} / matrix-summary.{json,md}
 * 用法：pnpm acceptance:matrix [--out <dir>] [--workspace ws-xxx] [--bundle <slug>] [--profile <path>] [--fail-on-error]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import pg from "pg";
import YAML from "yaml";
import { loadComposition } from "./lib/compose.mjs";
// 根级脚本统一走相对路径引行业契约源码（与 bundle-governance.mts 同口径）
import { formatContractError, parseWorkforcePreset, type WorkforcePreset } from "../../packages/industry-contract/src/index.ts";
import { cliArgs, findRepoRoot, loadProfile } from "./lib/profile.mjs";

/* ============================== 参数 ============================== */

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const { profile, warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath);
// 工作区可用三种方式给出：--workspace > profile.workspaceId > profile.identity.workspaceSlug（连库后按 slug 解析）
let WORKSPACE_ID = args.workspaceId ?? process.env.ACCEPTANCE_WORKSPACE_ID ?? profile.workspaceId ?? "";
const WORKSPACE_SLUG = profile.identity?.workspaceSlug ?? null;
const OUT_DIR = resolve(args.outDir ?? join(REPO_ROOT, "outputs", "acceptance", "matrix"));
const FAIL_ON_ERROR = args.has("--fail-on-error");

function loadDefaultPrimaryBundle(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "product.manifest.json"), "utf-8"));
    return manifest.defaultBundle ?? "geo-growth";
  } catch {
    return "geo-growth";
  }
}

/**
 * 组合主包解析顺序：--bundle > ACCEPTANCE_PRIMARY_BUNDLE > profile.primaryBundle > 工作区实际 bundle_id > product.manifest.defaultBundle。
 * 用「工作区实际 bundle_id」兜底很重要：profile 漂移（换了包）时，矩阵会拿错组合口径，把正常的运行态判成全红。
 */
async function resolvePrimaryBundle(): Promise<string> {
  const explicit = args.primaryBundle ?? process.env.ACCEPTANCE_PRIMARY_BUNDLE ?? profile.primaryBundle;
  if (explicit) return explicit;
  const url = process.env.DATABASE_URL;
  if (url && (WORKSPACE_ID || WORKSPACE_SLUG)) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      const row = WORKSPACE_ID
        ? (await client.query<{ id: string; bundle_id: string | null }>(`SELECT id, bundle_id FROM workspaces WHERE id=$1`, [WORKSPACE_ID])).rows[0]
        : (await client.query<{ id: string; bundle_id: string | null }>(`SELECT id, bundle_id FROM workspaces WHERE slug=$1 LIMIT 1`, [WORKSPACE_SLUG])).rows[0];
      if (row) {
        WORKSPACE_ID = row.id;
        if (row.bundle_id) {
          profileWarnings.push(`profile 未声明 primaryBundle，按工作区实际 bundle_id=${row.bundle_id} 组合口径`);
          return row.bundle_id;
        }
      }
    } catch {
      /* 连不上就走 manifest 默认值，后续 loadRuntime 会给出明确错误 */
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  return loadDefaultPrimaryBundle();
}

const PRIMARY_BUNDLE = await resolvePrimaryBundle();

/* ============================== 类型 ============================== */

interface Check { ok: boolean; detail: string }
interface AgentRow {
  preset_key: string; name: string; bundle: string; kind: string;
  readonly: boolean; night_shift: boolean; high_risk: boolean;
  fences: string[]; fences_effective: string[]; skills: string[];
  shadowed_from: string[]; event_prefixes: string[];
  checks: Record<string, Check>; failures: string[]; warnings: string[];
  status: "pass" | "fail";
}
interface SkillRow {
  skill: string; bundle: string; version: string; fences: string[];
  doc_declared_fences: string[]; referenced_by: string[];
  body_chars: number; description_chars: number;
  checks: Record<string, Check>; failures: string[]; warnings: string[];
  status: "pass" | "fail";
}

/* ============================== 事实源装配 ============================== */

const composition = await loadComposition(REPO_ROOT, PRIMARY_BUNDLE);
const composed = { bundleIds: composition.bundleIds, shadowed: composition.shadowed };
const mergedRules = [...composition.fenceRules.values()];
const ruleIds = new Set(mergedRules.map((m) => m.ruleId));
const ruleLevel = new Map(mergedRules.map((m) => [m.ruleId, m.level ?? "review"]));

const authoritative = new Map<string, { preset: WorkforcePreset; bundleId: string; fences: string[]; shadowed: string[] }>();
for (const [key, entry] of composition.presets) {
  authoritative.set(key, {
    preset: entry.preset as WorkforcePreset,
    bundleId: entry.bundleId,
    fences: entry.fenceBindings,
    shadowed: entry.shadowedBundleIds,
  });
}

interface SkillAsset {
  bundle: string; key: string; description: string; body: string;
  file: string; docDeclaredFences: string[];
}

function assertInsideBundle(bundleRoot: string, assetPath: string): string {
  const full = resolve(bundleRoot, assetPath);
  const rel = relative(bundleRoot, full);
  if (rel.startsWith("..") || rel.startsWith(sep) || rel === "") {
    throw new Error(`技能资产越出 bundle 目录：${assetPath}`);
  }
  return full;
}

/** 抽取正文里“提到”的围栏编号（信息项，用于报告参考） */
function mentionedFences(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\bG-?[A-Z]{0,4}\d{0,3}[a-z]?\b/g)) found.add(m[0]);
  for (const m of text.matchAll(/\bR\d{1,2}\b/g)) found.add(m[0]);
  return [...found].sort();
}

/** 抽取“显式绑定声明”（…绑定围栏 G2，卸载即撤销 / 绑定围栏：R1/R2） */
function declaredBindings(description: string): string[] {
  const clause = description.match(/绑定围栏[:：]?\s*([^。；;\n]+)/)?.[1];
  if (!clause) return [];
  const found = new Set<string>();
  for (const m of clause.matchAll(/G-?[A-Z]{0,4}\d{0,3}[a-z]?|\bR\d{1,2}\b/g)) found.add(m[0]);
  return [...found].sort();
}

/** 声明「G10」视为被绑定「G10a/G10b…」覆盖（父子编号同源） */
function fenceCoveredBy(declared: string, bindings: string[]): boolean {
  return bindings.some((bound) => bound === declared || bound.startsWith(declared));
}

const skillAssets: SkillAsset[] = composition.skillDocs
  .map((doc) => {
    const root = process.env.BUNDLES_ROOT ?? join(REPO_ROOT, "bundles");
    assertInsideBundle(join(root, doc.bundle), relative(join(root, doc.bundle), doc.file)); // 路径包含校验（越界即抛）
    return {
      bundle: doc.bundle, key: doc.key, description: doc.description, body: doc.body,
      file: relative(REPO_ROOT, doc.file),
      docDeclaredFences: mentionedFences(`${doc.description}\n${doc.body}`),
    };
  })
  .sort((a, b) => (a.bundle + a.key).localeCompare(b.bundle + b.key));
const skillKeys = new Set(skillAssets.map((s) => s.key));

/** 包外技能资产：底座官方技能（bundle=null）与注册表技能 —— 与仓库自带测试 skillAssetExists 同口径 */
function listAssetSkillNames(root: string): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      const file = join(full, "SKILL.md");
      if (existsSync(file)) {
        const fm = readFileSync(file, "utf-8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
        const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        names.add(name || entry.name);
      } else {
        walk(full);
      }
    }
  };
  const officialRoot = join(root, "official");
  if (existsSync(officialRoot)) walk(officialRoot);
  const registryRoot = join(root, "registry");
  if (existsSync(registryRoot)) {
    for (const entry of readdirSync(registryRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(registryRoot, entry.name, "SKILL.md"))) names.add(entry.name);
    }
  }
  return names;
}

const packageExternalSkillNames = listAssetSkillNames(join(REPO_ROOT, "skills"));

const skillRefs = new Map<string, string[]>();
for (const [key, entry] of authoritative) {
  for (const skill of entry.preset.skills ?? []) {
    skillRefs.set(skill, [...(skillRefs.get(skill) ?? []), key]);
  }
}

const prefixOwners = new Map<string, string[]>();
for (const [key, entry] of authoritative) {
  for (const coverage of entry.preset.coverage ?? []) {
    prefixOwners.set(coverage.eventPrefix, [...(prefixOwners.get(coverage.eventPrefix) ?? []), key]);
  }
}

/* ============================== A 契约层 ============================== */

function checkPresetContract(
  key: string,
  entry: { preset: WorkforcePreset; bundleId: string; fences: string[]; shadowed: string[] },
): { checks: Record<string, Check>; warnings: string[] } {
  const preset = entry.preset;
  const checks: Record<string, Check> = {};
  const warnings: string[] = [];

  // A1 契约字段完整
  try {
    parseWorkforcePreset(preset);
    checks.A1_contract = { ok: true, detail: "字段完整（industry-contract schema 通过）" };
  } catch (err) {
    checks.A1_contract = { ok: false, detail: formatContractError(err).join("；") || String(err) };
  }

  // A2 组合唯一性与遮蔽归属
  checks.A2_unique = {
    ok: true,
    detail: entry.shadowed.length === 0
      ? "组合内唯一权威定义"
      : `权威=${entry.bundleId}，遮蔽=${entry.shadowed.join("/")}（已声明 presetOwners）`,
  };

  // A3 事件域前缀（跨包重复 → 警告 + 产品裁决）
  const conflicts = (preset.coverage ?? []).flatMap((coverage) => {
    const owners = (prefixOwners.get(coverage.eventPrefix) ?? []).filter((owner) => owner !== key);
    return owners.length ? [`${coverage.eventPrefix}←${owners.join("/")}`] : [];
  });
  if (conflicts.length) warnings.push(`事件域前缀跨包重复：${conflicts.join("；")}（需产品裁决归口）`);
  checks.A3_event_prefix = {
    ok: true,
    detail: conflicts.length === 0
      ? `事件前缀 ${(preset.coverage ?? []).map((c) => c.eventPrefix).join(",") || "无（只读岗位）"} 组合层唯一`
      : `事件前缀与其他包岗位重复（已记警告）：${conflicts.join("；")}`,
  };

  // A4 围栏绑定存在
  const missingFences = entry.fences.filter((fence) => !ruleIds.has(fence));
  checks.A4_fences_exist = {
    ok: missingFences.length === 0,
    detail: missingFences.length === 0
      ? `${entry.fences.length} 条绑定全部存在于组合围栏并集（${entry.fences.map((f) => `${f}:${ruleLevel.get(f)}`).join(" ") || "无"}）`
      : `围栏不存在：${missingFences.join(",")}`,
  };

  // A5 技能资产可解析
  const missingSkills = (preset.skills ?? []).filter((s) => !skillKeys.has(s) && !packageExternalSkillNames.has(s));
  const externalSkills = (preset.skills ?? []).filter((s) => !skillKeys.has(s) && packageExternalSkillNames.has(s));
  checks.A5_skills_exist = {
    ok: missingSkills.length === 0,
    detail: missingSkills.length === 0
      ? `${(preset.skills ?? []).length} 个技能资产可解析（包外官方：${externalSkills.join(",") || "无"}）`
      : `技能资产缺失：${missingSkills.join(",")}`,
  };

  // A6 写读一致性 + write_back 落点
  const writeTools = new Set((preset.tools ?? []).filter((t) => t.access === "write").map((t) => t.name));
  const allTools = new Set((preset.tools ?? []).map((t) => t.name));
  const writeBackOrphans = (preset.write_back ?? []).filter((name) => !allTools.has(name));
  const readOnlyWriteBack = (preset.write_back ?? []).filter((name) => allTools.has(name) && !writeTools.has(name));
  if (readOnlyWriteBack.length) warnings.push(`write_back 落在只读动作上：${readOnlyWriteBack.join(",")}（读回执再写回，提示项）`);
  const a6Ok = preset.readonly
    ? writeTools.size === 0
    : writeTools.size > 0 && (preset.coverage ?? []).length > 0 && entry.fences.length > 0 && writeBackOrphans.length === 0;
  checks.A6_write_read = {
    ok: a6Ok,
    detail: preset.readonly
      ? `只读岗位，写工具 ${writeTools.size} 个`
      : `写工具 ${writeTools.size} / write_back ${(preset.write_back ?? []).length}（未声明动作 ${writeBackOrphans.join(",") || "无"}）`,
  };

  // A7 治理声明
  const governOk = typeof preset.night_shift === "boolean" && typeof preset.high_risk === "boolean"
    && (!preset.high_risk || entry.fences.length > 0);
  checks.A7_governance = {
    ok: governOk,
    detail: `night_shift=${preset.night_shift} high_risk=${preset.high_risk} 围栏=${entry.fences.length}`,
  };

  // A8 组合围栏并集单调（被遮蔽定义声明的围栏不丢）
  const rootDir = process.env.BUNDLES_ROOT ?? join(REPO_ROOT, "bundles");
  const dropped: string[] = [];
  for (const loserBundle of entry.shadowed) {
    const loserPath = join(rootDir, loserBundle, "presets", `${key}.yml`);
    if (!existsSync(loserPath)) continue;
    const loser = YAML.parse(readFileSync(loserPath, "utf-8")) as { fence_bindings?: string[] };
    for (const fence of loser.fence_bindings ?? []) {
      if (!entry.fences.includes(fence)) dropped.push(`${loserBundle}:${fence}`);
    }
  }
  checks.A8_union_monotonic = {
    ok: dropped.length === 0,
    detail: dropped.length === 0
      ? (entry.shadowed.length ? `被遮蔽包围栏已并入（${entry.fences.join(",")}）` : "无遮蔽定义，单包围栏即组合围栏")
      : `融合丢失围栏：${dropped.join(",")}`,
  };

  return { checks, warnings };
}

/* ============================== B 运行层（DB） ============================== */

interface DbAgent {
  id: string; preset_key: string; name: string; version: string; kind: string;
  readonly: boolean; status: string; invalid_reason: string | null;
  fence_bindings: string[]; skills: string[]; meta: Record<string, unknown>;
}
interface DbSkill {
  id: string; level: string; bundle: string | null; name: string; version: string;
  description: string; fence_bindings: string[];
}

const sorted = (values: string[]) => [...values].sort().join("\u0001");
const sameSet = (a: string[], b: string[]) => sorted(a) === sorted(b);

async function loadRuntime() {
  const empty = () => ({
    connected: false,
    agents: new Map<string, DbAgent>(),
    skills: new Map<string, DbSkill>(),
    installs: new Map<string, { snapshot: string[]; version: string }>(),
    activeFences: new Map<string, string>(),
  });
  const url = process.env.DATABASE_URL;
  if (!url) return { ...empty(), error: "DATABASE_URL 未设置" };
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    if (!WORKSPACE_ID && WORKSPACE_SLUG) {
      const found = await client.query<{ id: string }>(`SELECT id FROM workspaces WHERE slug=$1 LIMIT 1`, [WORKSPACE_SLUG]);
      WORKSPACE_ID = found.rows[0]?.id ?? "";
      if (!WORKSPACE_ID) return { ...empty(), error: `按 slug=${WORKSPACE_SLUG} 找不到工作区（请检查 profile.identity.workspaceSlug 或先跑种子）` };
    }
    if (!WORKSPACE_ID) return { ...empty(), error: "未指定工作区（--workspace / profile.workspaceId / profile.identity.workspaceSlug 三选一）" };
    const agents = await client.query<DbAgent>(
      /**
       * 同名多行取「优先 ready 的权威实例」（2026-09-24 B-47 复核）：
       * ip-curator 等下沉岗位历史上会留下 disabled 的退场行，`ORDER BY preset_key` 下
       * 后者覆盖前者 → B1_roster 误判"岗位不在编"（与账本 H-15 工具探针同类假失败）。
       * 注意：下面是 `new Map(rows.map(...))`（后写覆盖先写），所以 ready 必须排在**最后**——
       * 用 `(status='ready') ASC` 让退场行先出、在编行后出，Map 里留下的才是在编实例。
       */
      `SELECT id, preset_key, name, version, kind, readonly, status, invalid_reason, fence_bindings, skills, meta
       FROM agents WHERE workspace_id=$1
       ORDER BY preset_key, (status='ready') ASC, created_at ASC`, [WORKSPACE_ID]);
    const skills = await client.query<DbSkill>(
      `SELECT s.id, s.level, s.bundle, s.name, s.version, s.description, s.fence_bindings
       FROM skills s JOIN skill_installs si ON si.skill_id = s.id
       WHERE si.workspace_id=$1`, [WORKSPACE_ID]);
    const installs = await client.query<{ skill_id: string; fence_bindings_snapshot: string[]; installed_version: string }>(
      `SELECT skill_id, fence_bindings_snapshot, installed_version FROM skill_installs WHERE workspace_id=$1`, [WORKSPACE_ID]);
    const fences = await client.query<{ rule_id: string; level: string }>(
      `SELECT DISTINCT ON (rule_id) rule_id, level FROM fence_rules
       WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'
       ORDER BY rule_id, CASE level WHEN 'block' THEN 2 WHEN 'review' THEN 1 ELSE 0 END DESC`, [WORKSPACE_ID]);
    return {
      connected: true,
      agents: new Map(agents.rows.map((row) => [row.preset_key, row])),
      skills: new Map(skills.rows.map((row) => [row.name, row])),
      installs: new Map(installs.rows.map((row) => [row.skill_id, { snapshot: row.fence_bindings_snapshot, version: row.installed_version }])),
      activeFences: new Map(fences.rows.map((row) => [row.rule_id, row.level])),
    };
  } catch (err) {
    return { ...empty(), error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

const runtime = await loadRuntime();

function checkAgentRuntime(
  key: string,
  entry: { preset: WorkforcePreset; bundleId: string; fences: string[]; shadowed: string[] },
): Record<string, Check> {
  const preset = entry.preset;
  const checks: Record<string, Check> = {};
  const ids = ["B1_roster", "B2_identity", "B3_fences", "B4_skills", "B5_source", "B6_fence_live", "B7_skill_installed", "B8_night"];
  if (!runtime.connected) {
    for (const id of ids) checks[id] = { ok: false, detail: `未连接数据库（${runtime.error ?? "unknown"}）：运行层未判定` };
    return checks;
  }
  const row = runtime.agents.get(key);
  if (!row) {
    for (const id of ids) checks[id] = { ok: false, detail: `工作区 ${WORKSPACE_ID} 名册中不存在该岗位` };
    return checks;
  }
  checks.B1_roster = {
    ok: row.status === "ready" && !row.invalid_reason,
    detail: row.status === "ready" ? `status=ready（${row.id}）` : `status=${row.status}：${row.invalid_reason ?? ""}`,
  };
  const identityOk = row.name === preset.name && row.version === preset.version && row.kind === preset.kind && row.readonly === preset.readonly;
  checks.B2_identity = {
    ok: identityOk,
    detail: identityOk ? `${row.name} ${row.version} ${row.kind}${row.readonly ? "（只读）" : ""} 与 preset 一致`
      : `preset=${preset.name}/${preset.version}/${preset.kind}/${preset.readonly} vs DB=${row.name}/${row.version}/${row.kind}/${row.readonly}`,
  };
  checks.B3_fences = {
    ok: sameSet(row.fence_bindings ?? [], entry.fences),
    detail: sameSet(row.fence_bindings ?? [], entry.fences)
      ? `组合有效围栏 ${entry.fences.length} 条与 DB 一致`
      : `DB=${(row.fence_bindings ?? []).join(",")} vs 组合=${entry.fences.join(",")}`,
  };
  checks.B4_skills = {
    ok: sameSet(row.skills ?? [], preset.skills ?? []),
    detail: sameSet(row.skills ?? [], preset.skills ?? [])
      ? `技能 ${(preset.skills ?? []).length} 项与 DB 一致`
      : `DB=${(row.skills ?? []).join(",")} vs preset=${(preset.skills ?? []).join(",")}`,
  };
  const meta = row.meta ?? {};
  const shadowedInMeta = (meta.shadowedBundleIds as string[] | undefined) ?? [];
  const sourceOk = (meta.sourceBundleId === entry.bundleId) && sameSet(shadowedInMeta, entry.shadowed);
  /**
   * 单包装配（无组合 API 的仓）不会写 meta.sourceBundleId / shadowedBundleIds——那是组合装配器
   * 才有的留痕字段。此时“没有留痕”不是缺陷（不存在跨包归属歧义），按通过处理并在 detail 说明；
   * 组合仓（viaApi=true）仍然严格要求留痕，缺了就失败。
   */
  const singleBundleNoMeta = !composition.viaApi && meta.sourceBundleId === undefined && shadowedInMeta.length === 0;
  checks.B5_source = {
    ok: sourceOk || singleBundleNoMeta,
    detail: sourceOk
      ? `来源包=${entry.bundleId}${entry.shadowed.length ? `，遮蔽留痕=${entry.shadowed.join("/")}` : ""}`
      : singleBundleNoMeta
        ? `单包装配仓无来源包留痕字段（非缺陷）：bundle=${entry.bundleId}`
        : `meta.sourceBundleId=${String(meta.sourceBundleId)}（期望 ${entry.bundleId}）shadowed=${shadowedInMeta.join(",")}`,
  };
  const dangling = (row.fence_bindings ?? []).filter((fence) => !runtime.activeFences.has(fence));
  checks.B6_fence_live = {
    ok: dangling.length === 0,
    detail: dangling.length === 0
      ? `DB 围栏绑定全部有 active 规则（${(row.fence_bindings ?? []).map((f) => `${f}:${runtime.activeFences.get(f)}`).join(" ") || "无"}）`
      : `悬空围栏：${dangling.join(",")}`,
  };
  const notInstalled = (preset.skills ?? []).filter((skill) => !runtime.installs.has(`skill-${skill}`) && !runtime.installs.has(skill));
  checks.B7_skill_installed = {
    ok: notInstalled.length === 0,
    detail: notInstalled.length === 0 ? "声明技能均在本工作区安装" : `未安装：${notInstalled.join(",")}`,
  };
  const nightOk = (meta.night_shift === true) === (preset.night_shift === true);
  checks.B8_night = {
    ok: nightOk,
    detail: nightOk ? `夜班声明一致（night_shift=${preset.night_shift}）` : `夜班漂移：preset=${preset.night_shift} vs DB=${String(meta.night_shift)}`,
  };
  return checks;
}

/* ============================== 技能矩阵 ============================== */

function checkSkill(asset: SkillAsset): { checks: Record<string, Check>; warnings: string[]; version: string; dbFences: string[] } {
  const checks: Record<string, Check> = {};
  const warnings: string[] = [];
  const db = runtime.skills.get(asset.key);

  checks.SA1_doc = {
    ok: asset.description.length > 0 && asset.body.length >= 80,
    detail: `description ${asset.description.length} 字 / 正文 ${asset.body.length} 字${asset.body.length < 80 ? "（正文过短，疑似空壳技能）" : ""}`,
  };
  checks.SA2_bundle = {
    ok: db ? db.bundle === asset.bundle : true,
    detail: db ? `目录包=${asset.bundle} / 注册表包=${db.bundle ?? "null"}` : "未装载到注册表（无法对账）",
  };
  const dbFences = db?.fence_bindings ?? [];
  const undeclaredInRegistry = dbFences.filter((fence) => !ruleIds.has(fence));
  const declared = declaredBindings(asset.description);
  const declaredNotBound = declared.filter((fence) => !fenceCoveredBy(fence, dbFences));
  checks.SA3_fences = {
    ok: undeclaredInRegistry.length === 0 && declaredNotBound.length === 0,
    detail: [
      `绑定=${dbFences.join(",") || "无"}`,
      `显式声明=${declared.join(",") || "无"}`,
      `正文提及=${asset.docDeclaredFences.join(",") || "无"}`,
      undeclaredInRegistry.length ? `绑定不在组合围栏内：${undeclaredInRegistry.join(",")}` : "",
      declaredNotBound.length ? `声明未进绑定：${declaredNotBound.join(",")}` : "",
    ].filter(Boolean).join("；"),
  };
  checks.SA4_registry = {
    ok: !!db && db.description.trim().length > 0 && db.version.trim().length > 0,
    detail: db ? `注册表 id=${db.id} level=${db.level} version=${db.version}` : "注册表无此行",
  };
  const install = db ? runtime.installs.get(db.id) : undefined;
  const snapshotOk = !!install && !!db && sameSet(install.snapshot, db.fence_bindings ?? []) && install.version === db.version;
  checks.SA5_install = {
    ok: snapshotOk,
    detail: install && db
      ? `安装快照=${install.snapshot.join(",") || "无"} / 版本 ${install.version}${snapshotOk ? "（与注册表一致）" : "（与注册表不一致）"}`
      : "无安装行",
  };
  const refs = skillRefs.get(asset.key) ?? [];
  if (refs.length === 0) warnings.push("装备库预留：当前组合编制内没有岗位引用它");
  checks.SA6_referenced = {
    ok: true,
    detail: refs.length ? `被 ${refs.length} 个岗位引用：${refs.slice(0, 6).join(",")}` : "未被本组合编制引用（已记警告）",
  };
  return { checks, warnings, version: db?.version ?? "", dbFences };
}

/* ============================== 组装与输出 ============================== */

const agentRows: AgentRow[] = [];
for (const [key, entry] of [...authoritative].sort((a, b) => a[0].localeCompare(b[0]))) {
  const contract = checkPresetContract(key, entry);
  const checks = { ...contract.checks, ...checkAgentRuntime(key, entry) };
  const failures = Object.entries(checks).filter(([, c]) => !c.ok).map(([id]) => id);
  agentRows.push({
    preset_key: key, name: entry.preset.name, bundle: entry.bundleId, kind: entry.preset.kind,
    readonly: entry.preset.readonly, night_shift: entry.preset.night_shift, high_risk: entry.preset.high_risk,
    fences: entry.preset.fence_bindings ?? [], fences_effective: entry.fences, skills: entry.preset.skills ?? [],
    shadowed_from: entry.shadowed, event_prefixes: (entry.preset.coverage ?? []).map((c) => c.eventPrefix),
    checks, failures, warnings: contract.warnings, status: failures.length === 0 ? "pass" : "fail",
  });
}

const skillRows: SkillRow[] = skillAssets.map((asset) => {
  const { checks, warnings, version, dbFences } = checkSkill(asset);
  const failures = Object.entries(checks).filter(([, c]) => !c.ok).map(([id]) => id);
  return {
    skill: asset.key, bundle: asset.bundle, version, fences: dbFences,
    doc_declared_fences: asset.docDeclaredFences, referenced_by: skillRefs.get(asset.key) ?? [],
    body_chars: asset.body.length, description_chars: asset.description.length,
    checks, failures, warnings, status: failures.length === 0 ? "pass" : "fail",
  };
});

const agentFails = agentRows.filter((r) => r.status === "fail");
const skillFails = skillRows.filter((r) => r.status === "fail");
const agentWarns = agentRows.filter((r) => r.warnings.length > 0);
const skillWarns = skillRows.filter((r) => r.warnings.length > 0);
const perBundle = agentRows.reduce<Record<string, number>>((acc, row) => {
  acc[row.bundle] = (acc[row.bundle] ?? 0) + 1;
  return acc;
}, {});

const summary = {
  generatedAt: new Date().toISOString(),
  spec: "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v1",
  primaryBundle: PRIMARY_BUNDLE,
  bundles: composed.bundleIds,
  compositionSource: composition.viaApi ? "compose-api" : "local-fallback（该仓无组合 API，按依赖顺序本地组合；证据等级 B）",
  compositionWarnings: composition.warnings,
  workspaceId: WORKSPACE_ID,
  profileWarnings,
  runtimeConnected: runtime.connected,
  runtimeError: runtime.error ?? null,
  counts: {
    agents: agentRows.length, agentsPass: agentRows.length - agentFails.length,
    skills: skillRows.length, skillsPass: skillRows.length - skillFails.length,
    warnings: agentWarns.length + skillWarns.length,
    fenceRulesMerged: mergedRules.length,
    fenceRulesActiveInWorkspace: runtime.activeFences.size,
    shadowedPresets: composed.shadowed.length,
    perBundle,
  },
  capabilityLayer: {
    status: "not-run",
    reason: "L8 能力层需要真实模型 + 专业场景评分卡；本脚本只覆盖 L0 契约层与 L1 运行层。",
  },
  failures: {
    agents: agentFails.map((row) => ({ preset_key: row.preset_key, failures: row.failures, detail: row.failures.map((id) => `${id}: ${row.checks[id]?.detail}`) })),
    skills: skillFails.map((row) => ({ skill: row.skill, failures: row.failures, detail: row.failures.map((id) => `${id}: ${row.checks[id]?.detail}`) })),
  },
  warnings: {
    agents: agentWarns.map((row) => ({ preset_key: row.preset_key, warnings: row.warnings })),
    skills: skillWarns.map((row) => ({ skill: row.skill, warnings: row.warnings })),
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "agent-matrix.json"), JSON.stringify({ summary, rows: agentRows }, null, 1));
writeFileSync(join(OUT_DIR, "skill-matrix.json"), JSON.stringify({ summary, rows: skillRows }, null, 1));
writeFileSync(join(OUT_DIR, "matrix-summary.json"), JSON.stringify(summary, null, 1));

const agentChecks = [...new Set(agentRows.flatMap((row) => Object.keys(row.checks)))];
const skillChecks = [...new Set(skillRows.flatMap((row) => Object.keys(row.checks)))];
const csv = (header: string[], rows: Array<Array<string | number>>) =>
  [header, ...rows].map((line) => line.map((cell) => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell))).join(",")).join("\n") + "\n";
writeFileSync(join(OUT_DIR, "agent-matrix.csv"), csv(
  ["preset_key", "name", "bundle", "kind", "readonly", "night_shift", "high_risk", "fences", "skills", "status", ...agentChecks],
  agentRows.map((row) => [row.preset_key, row.name, row.bundle, row.kind, String(row.readonly), String(row.night_shift), String(row.high_risk),
    row.fences_effective.length, row.skills.length, row.status, ...agentChecks.map((id) => (row.checks[id]?.ok ? "pass" : "FAIL"))]),
));
writeFileSync(join(OUT_DIR, "skill-matrix.csv"), csv(
  ["skill", "bundle", "version", "fences", "referenced_by", "body_chars", "status", ...skillChecks],
  skillRows.map((row) => [row.skill, row.bundle, row.version, row.fences.join(" "), row.referenced_by.length, row.body_chars, row.status,
    ...skillChecks.map((id) => (row.checks[id]?.ok ? "pass" : "FAIL"))]),
));

const md: string[] = [];
md.push("# 员工/技能验收矩阵（L0 契约层 + L1 运行层）");
md.push("");
md.push(`- 规范：docs/REAL-DEVICE-ACCEPTANCE-SPEC.md（rdas/v1）；生成时间：${summary.generatedAt}`);
md.push(`- 组合主包：${PRIMARY_BUNDLE}（并集 ${composed.bundleIds.join(" + ")}）；工作区：${WORKSPACE_ID}；DB：${runtime.connected ? "正常" : `失败（${runtime.error}）`}`);
md.push(`- 员工：${summary.counts.agents} 岗，通过 ${summary.counts.agentsPass}（${Object.entries(perBundle).map(([b, n]) => `${b} ${n}`).join(" / ")}）`);
md.push(`- 技能：${summary.counts.skills} 个，通过 ${summary.counts.skillsPass}；围栏：合并 ${summary.counts.fenceRulesMerged} 条 / active ${summary.counts.fenceRulesActiveInWorkspace} 条`);
md.push(`- 遮蔽岗位留痕：${summary.counts.shadowedPresets} 条；警告 ${summary.counts.warnings} 条`);
if (profileWarnings.length) md.push(`- profile 告警：${profileWarnings.join("；")}`);
md.push("");
md.push("## 失败清单");
md.push("");
if (!agentFails.length && !skillFails.length) md.push("无：L0/L1 全部通过。");
for (const row of agentFails) md.push(`- 岗位 \`${row.preset_key}\`（${row.name}）：${row.failures.map((id) => `${id} ${row.checks[id]?.detail}`).join(" | ")}`);
for (const row of skillFails) md.push(`- 技能 \`${row.skill}\`（${row.bundle}）：${row.failures.map((id) => `${id} ${row.checks[id]?.detail}`).join(" | ")}`);
md.push("");
md.push("## 警告清单（不判失败，需产品裁决/后续跟进）");
md.push("");
if (!agentWarns.length && !skillWarns.length) md.push("无。");
for (const row of agentWarns) md.push(`- 岗位 \`${row.preset_key}\`（${row.name}）：${row.warnings.join(" | ")}`);
for (const row of skillWarns) md.push(`- 技能 \`${row.skill}\`（${row.bundle}）：${row.warnings.join(" | ")}`);
md.push("");
md.push("## L8 能力层");
md.push("");
md.push(`未在本脚本内执行：${summary.capabilityLayer.reason}`);
writeFileSync(join(OUT_DIR, "matrix-summary.md"), `${md.join("\n")}\n`);

console.log(`[acceptance:matrix] 员工 ${summary.counts.agentsPass}/${summary.counts.agents}；技能 ${summary.counts.skillsPass}/${summary.counts.skills}；警告 ${summary.counts.warnings}`);
for (const warning of profileWarnings) console.log(`  ⚠ profile：${warning}`);
for (const row of agentFails.slice(0, 12)) console.log(`  ✗ ${row.preset_key}：${row.failures.join(",")}`);
for (const row of skillFails.slice(0, 12)) console.log(`  ✗ ${row.skill}：${row.failures.join(",")}`);
console.log(`[acceptance:matrix] 输出：${OUT_DIR}`);
if (FAIL_ON_ERROR && (agentFails.length || skillFails.length || !runtime.connected)) process.exit(1);
