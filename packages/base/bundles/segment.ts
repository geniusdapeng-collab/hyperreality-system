// vendored from workloom-im/packages/base/bundles/segment.ts（逐字节复制，本地勿改；改动请回上游后重新 vendor）
/**
 * bundles/segment —— 客群装配加载器（「先体检，再托管」客户旅程的运行时消费方）
 *
 * 背景：bundles/<industry>/segment-defaults.yml 声明了各客群的默认装配
 * （presets / skills_ordered / fence_patch），但此前只有文档生成器读它——
 * 运行时 onboarding 的「选择起步方式」步骤需要一个通用 loader 把声明变成可执行的装配清单。
 *
 * 纪律：
 *  - 行业无关：只规定 segment-defaults.yml 的契约与解析，客群语义由行业包定义
 *  - 严格校验：客群不存在 / 引用缺失（preset yml、skill 目录、patch 文件）一律抛错并列出缺失项——
 *    宁可向导报错，不可装出半个班子（L9.2 不静默）
 *  - 只读磁盘，不写库：写库装配（agents/skill_installs/fence_rules）由调用方在事务内执行
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/** segment-defaults.yml 中一个客群的声明 */
export interface SegmentDef {
  key: string;
  label: string;
  pitch: string;
  /** 围栏 patch 相对 bundle 根的路径（如 fences/patches/audit-only-patch.yml），可空 */
  fencePatch: string | null;
  /** 默认上岗的数字员工 preset_key 列表 */
  presets: string[];
  /** 预装技能（首屏展示顺序 = 销售叙事顺序） */
  skillsOrdered: string[];
}

/** 经存在性校验后的可执行装配清单 */
export interface SegmentAssembly extends SegmentDef {
  /** 校验通过：presets/<key>.yml 的绝对路径列表（与 presets 同序） */
  presetFiles: string[];
  /** 校验通过：skills/<key>/ 的绝对路径列表（与 skillsOrdered 同序） */
  skillDirs: string[];
  /** 校验通过：fence patch 绝对路径（fencePatch 为 null 时同 null） */
  fencePatchFile: string | null;
}

interface RawSegmentDoc {
  version?: string;
  segments?: Record<string, {
    label?: string;
    pitch?: string;
    fence_patch?: string;
    presets?: string[];
    skills_ordered?: string[];
  }>;
}

/** 读取并解析 segment-defaults.yml（文件不存在 → 抛错） */
export function loadSegmentDefaults(bundleDir: string): { version: string; segments: SegmentDef[] } {
  const file = join(bundleDir, "segment-defaults.yml");
  if (!existsSync(file)) {
    throw new Error(`segment-defaults.yml 不存在：${file}（该行业包未提供客群装配）`);
  }
  const doc = YAML.parse(readFileSync(file, "utf8")) as RawSegmentDoc;
  const segments = Object.entries(doc.segments ?? {}).map(([key, s]) => ({
    key,
    label: s.label ?? key,
    pitch: s.pitch ?? "",
    fencePatch: s.fence_patch ?? null,
    presets: s.presets ?? [],
    skillsOrdered: s.skills_ordered ?? [],
  }));
  if (segments.length === 0) throw new Error(`segment-defaults.yml 无任何客群定义：${file}`);
  return { version: doc.version ?? "unknown", segments };
}

/** 列出可选客群（向导「起步方式」步骤的选项源） */
export function listSegments(bundleDir: string): SegmentDef[] {
  return loadSegmentDefaults(bundleDir).segments;
}

/**
 * 解析指定客群为可执行装配清单（严格校验引用存在性）。
 * @throws 客群不存在 / preset、skill、patch 引用缺失（错误信息列出全部缺失项）
 */
export function resolveSegment(bundleDir: string, key: string): SegmentAssembly {
  const { segments } = loadSegmentDefaults(bundleDir);
  const seg = segments.find((s) => s.key === key);
  if (!seg) {
    throw new Error(`未知客群 "${key}"（可选：${segments.map((s) => s.key).join(" / ")}）`);
  }
  const missing: string[] = [];
  const presetFiles = seg.presets.map((k) => {
    const f = join(bundleDir, "presets", `${k}.yml`);
    if (!existsSync(f)) missing.push(`presets/${k}.yml`);
    return f;
  });
  const skillDirs = seg.skillsOrdered.map((k) => {
    const d = join(bundleDir, "skills", k);
    if (!existsSync(d)) missing.push(`skills/${k}/`);
    return d;
  });
  let fencePatchFile: string | null = null;
  if (seg.fencePatch) {
    fencePatchFile = join(bundleDir, seg.fencePatch);
    if (!existsSync(fencePatchFile)) missing.push(seg.fencePatch);
  }
  if (missing.length > 0) {
    throw new Error(`客群 "${key}" 装配清单存在 ${missing.length} 处断链：${missing.join("、")}`);
  }
  return { ...seg, presetFiles, skillDirs, fencePatchFile };
}
