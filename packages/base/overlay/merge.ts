/**
 * overlay/merge.ts —— 租户覆盖层合并引擎（Merge Engine）
 *
 * 纯函数、零 I/O：输入行业包资产（磁盘读取结果）+ 覆盖声明，输出合并后资产。
 * 优先级总规则：租户覆盖 > 行业包 > 基座默认。
 * 安全规则：围栏只收紧（strictness 必须上升，block 不可调）；阈值越界即拒；
 *          不可覆盖路径（红线/账本/考试院/积分底层）命中即拒。
 */
import {
  FENCE_STRICTNESS, OverlayDoc, OverlayError, OverlayItem, assertPathAllowed, validateOverlay,
  type FenceLevel,
} from "./model.js";

/* ================= 合并目标结构（与装配器磁盘资产同构的宽松视图） ================= */
export interface BundleAssetView {
  /** bundle.json 原文对象 */
  bj: Record<string, unknown> & { workloom?: Record<string, unknown> };
  /** presets/*.yml 解析结果（preset_key 标识） */
  presets: Array<Record<string, unknown> & { preset_key?: string }>;
  /** fences/*.yml 解析结果（fences[] 内含 rule_id/level） */
  fencePacks: Array<Record<string, unknown> & {
    fences?: Array<{ rule_id?: string; level?: FenceLevel; [k: string]: unknown }>;
  }>;
  /** 扩展资产集合（persona/kb 等文本与知识内容）：persona/kb 类覆盖的作用对象 */
  extra: Record<string, unknown>;
}

/** 合并结果（含审计留痕：每一项覆盖的裁决记录） */
export interface MergeResult {
  assets: BundleAssetView;
  audit: Array<{ path: string; action: string; detail: string }>;
}

/* ================= 小工具 ================= */
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** 深路径设置（a/b/c → obj.a.b.c = value），中间层不存在则创建 */
function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split("/");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function deepGet(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split("/")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/* ================= ① 话术与人格 / ⑦ 品牌外观（override） ================= */
function applyOverride(
  container: Record<string, unknown>, item: Extract<OverlayItem, { type: "persona" | "brand" }>,
  audit: MergeResult["audit"], label: string,
): void {
  deepSet(container, item.path, item.value);
  audit.push({ path: item.path, action: "override", detail: `${label}覆盖为「${String(item.value).slice(0, 40)}」` });
}

/* ================= ② 知识（append / override / tombstone） ================= */
interface KbEntry { id?: string; q: string; a: string; [k: string]: unknown }

function kbCollection(view: BundleAssetView, collPath: string): KbEntry[] {
  const existing = view.extra[collPath];
  if (Array.isArray(existing)) return existing as KbEntry[];
  const created: KbEntry[] = [];
  view.extra[collPath] = created;
  return created;
}

function applyKb(view: BundleAssetView, item: Extract<OverlayItem, { type: "kb" }>, audit: MergeResult["audit"]): void {
  if (item.op === "append") {
    const coll = kbCollection(view, item.path);
    const entry = { id: `tenant-${coll.length + 1}-${Date.now().toString(36)}`, ...item.value } as KbEntry;
    coll.push(entry);
    audit.push({ path: item.path, action: "kb.append", detail: `新增知识「${item.value.q.slice(0, 30)}」` });
    return;
  }
  // override / tombstone：path = <collPath>/<id>
  const slash = item.path.lastIndexOf("/");
  const collPath = item.path.slice(0, slash);
  const id = item.path.slice(slash + 1);
  const coll = kbCollection(view, collPath);
  const idx = coll.findIndex((e) => e.id === id);
  if (item.op === "tombstone") {
    if (idx >= 0) coll.splice(idx, 1);
    // 墓碑留痕：即使行业包后续再版该条目，也不再并入（由调用方在合并时先应用 tombstone 集合）
    const tombs = (view.extra.__kb_tombstones__ as string[] | undefined) ?? [];
    if (!tombs.includes(item.path)) tombs.push(item.path);
    view.extra.__kb_tombstones__ = tombs;
    audit.push({ path: item.path, action: "kb.tombstone", detail: `删除知识条目 ${id}（墓碑留痕）` });
    return;
  }
  if (idx < 0) throw new OverlayError("KB_ITEM_NOT_FOUND", `知识条目 ${item.path} 不存在，无法覆盖`);
  coll[idx] = { ...coll[idx], ...item.value, id } as KbEntry;
  audit.push({ path: item.path, action: "kb.override", detail: `覆盖知识条目 ${id}` });
}

/* ================= ③ 编制（disable / params） ================= */
function applyCrew(view: BundleAssetView, item: Extract<OverlayItem, { type: "crew" }>, audit: MergeResult["audit"]): void {
  const key = item.path.replace(/^presets\//, "");
  const preset = view.presets.find((p) => p.preset_key === key);
  if (!preset) throw new OverlayError("PRESET_NOT_FOUND", `编制 ${item.path} 不存在于行业包（新增员工请走 L3 生成层）`);
  if (item.op === "disable") {
    preset.disabled = true;
    audit.push({ path: item.path, action: "crew.disable", detail: `停用数字员工 ${key}` });
  } else {
    preset.params = { ...(preset.params as Record<string, unknown> | undefined), ...item.value };
    audit.push({ path: item.path, action: "crew.params", detail: `调整 ${key} 参数（${Object.keys(item.value).join("/")}）` });
  }
}

/* ================= ④ 阈值（override + 边界校验） ================= */
function applyThreshold(view: BundleAssetView, item: Extract<OverlayItem, { type: "threshold" }>, audit: MergeResult["audit"]): void {
  if (item.value < item.bounds.min || item.value > item.bounds.max) {
    throw new OverlayError("THRESHOLD_OUT_OF_BOUNDS",
      `阈值 ${item.path}=${item.value} 超出基座允许区间 [${item.bounds.min}, ${item.bounds.max}]`);
  }
  const wl = (view.bj.workloom ??= {});
  const thresholds = (wl.thresholds ??= {}) as Record<string, unknown>;
  deepSet(thresholds, item.path, item.value);
  audit.push({ path: item.path, action: "threshold.override", detail: `阈值 ${item.path} = ${item.value}（区间 [${item.bounds.min}, ${item.bounds.max}]）` });
}

/* ================= ⑤ 技能（disable / params） ================= */
function applySkill(view: BundleAssetView, item: Extract<OverlayItem, { type: "skill" }>, audit: MergeResult["audit"]): void {
  const name = item.path.replace(/^skills\//, "");
  const wl = (view.bj.workloom ??= {});
  const provides = (wl.provides ??= {}) as Record<string, unknown>;
  const skills = (provides.skills as string[] | undefined) ?? [];
  if (skills.length > 0 && !skills.some((s) => s.includes(`/${name}/`) || s === name)) {
    throw new OverlayError("SKILL_NOT_FOUND", `技能 ${item.path} 不存在于行业包 provides.skills`);
  }
  if (item.op === "disable") {
    const disabled = (wl.disabled_skills ??= []) as string[];
    if (!disabled.includes(name)) disabled.push(name);
    audit.push({ path: item.path, action: "skill.disable", detail: `停用技能 ${name}` });
  } else {
    const params = (wl.skill_params ??= {}) as Record<string, unknown>;
    params[name] = { ...(params[name] as Record<string, unknown> | undefined), ...item.value };
    audit.push({ path: item.path, action: "skill.params", detail: `调整技能 ${name} 默认参数` });
  }
}

/* ================= ⑥ 围栏（只收紧，block 不可调） ================= */
function applyFence(view: BundleAssetView, item: Extract<OverlayItem, { type: "fence" }>, audit: MergeResult["audit"]): void {
  const ruleId = item.path.replace(/^fences\//, "");
  const pack = view.fencePacks.find((p) => p.fences?.some((r) => r.rule_id === ruleId));
  const rule = pack?.fences?.find((r) => r.rule_id === ruleId);
  if (!rule) throw new OverlayError("PATH_NOT_FOUND", `围栏规则 ${item.path} 不存在于行业包`);
  const current = (rule.level ?? "review") as FenceLevel;
  if (current === "block") {
    throw new OverlayError("FENCE_BLOCK_IMMUTABLE", `围栏 ${ruleId} 为 block 红线级——不可调`);
  }
  if (current !== item.from) {
    throw new OverlayError("FENCE_FROM_MISMATCH",
      `围栏 ${ruleId} 当前级别为 ${current}，与覆盖声明的 from=${item.from} 不一致（行业包可能已升级，请重新确认后再收紧）`);
  }
  if (FENCE_STRICTNESS[item.to] <= FENCE_STRICTNESS[current]) {
    throw new OverlayError("FENCE_LOOSEN", `围栏 ${ruleId} 只允许收紧（${current}→更严），拒绝 ${item.to}`);
  }
  rule.level = item.to;
  audit.push({ path: item.path, action: "fence.tighten", detail: `围栏 ${ruleId} 收紧 ${current}→${item.to}` });
}

/* ================= 主入口 ================= */
/**
 * 合并：行业包资产 + 覆盖声明 → 合并后资产（不改动入参，返回新对象）
 * 调用前会先跑完整校验（validateOverlay + 路径保护），任一覆盖项非法即整体拒绝（宁拒不错合）。
 */
export function mergeOverlay(view: BundleAssetView, doc: OverlayDoc): MergeResult {
  validateOverlay(doc);
  for (const it of doc.items) assertPathAllowed(it.path);

  const out: BundleAssetView = clone(view);
  const audit: MergeResult["audit"] = [];
  for (const it of doc.items) {
    switch (it.type) {
      case "persona": applyOverride(out.extra, it, audit, "话术人格"); break;
      case "brand": {
        const wl = (out.bj.workloom ??= {});
        const brand = (wl.brand ??= {}) as Record<string, unknown>;
        applyOverride(brand, it, audit, "品牌");
        break;
      }
      case "kb": applyKb(out, it, audit); break;
      case "crew": applyCrew(out, it, audit); break;
      case "threshold": applyThreshold(out, it, audit); break;
      case "skill": applySkill(out, it, audit); break;
      case "fence": applyFence(out, it, audit); break;
    }
  }
  return { assets: out, audit };
}

/** 便捷查询：合并后的知识集合（过滤墓碑） */
export function kbEntriesOf(view: BundleAssetView, collPath: string): KbEntry[] {
  const tombs = (view.extra.__kb_tombstones__ as string[] | undefined) ?? [];
  const coll = (view.extra[collPath] as KbEntry[] | undefined) ?? [];
  return coll.filter((e) => !tombs.includes(`${collPath}/${e.id}`));
}

/** 便捷查询：合并后某 preset 是否被停用 */
export function isPresetDisabled(view: BundleAssetView, presetKey: string): boolean {
  return view.presets.some((p) => p.preset_key === presetKey && p.disabled === true);
}

/** 便捷查询：合并后阈值（含行业包默认与租户覆盖） */
export function thresholdOf(view: BundleAssetView, path: string): number | undefined {
  const v = deepGet((view.bj.workloom?.thresholds ?? {}) as Record<string, unknown>, path);
  return typeof v === "number" ? v : undefined;
}
