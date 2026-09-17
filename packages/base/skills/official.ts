/**
 * skills · 官方套件磁盘加载器（D17）
 *
 * 官方技能存放于仓库顶层 `skills/official/<套件>/<技能>/SKILL.md`（内容资产，非代码包），
 * 本加载器在 seed/初始化时扫描入库：level=official、bundle=null（不依附任何行业 Bundle）。
 * 红线：底座不预置任何行业词汇——本加载器只解析 frontmatter 与正文，不做行业假设。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface OfficialSkillAsset {
  suite: string;        // 如 industry-entry / product-feedback
  name: string;         // frontmatter name
  version: string;      // frontmatter version
  description: string;  // frontmatter description
  body: string;         // SKILL.md 全文
}

/** 解析 SKILL.md frontmatter（--- 包裹的极简 YAML：name/version/description） */
export function parseSkillFrontmatter(md: string): { name: string; version: string; description: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const get = (key: string) => m?.[1]?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  return { name: get("name"), version: get("version") || "1.0", description: get("description") };
}

/** 扫描 skills/official/ 下全部官方技能（rootDir 为仓库根） */
export function loadOfficialSkills(rootDir: string): OfficialSkillAsset[] {
  const base = join(rootDir, "skills", "official");
  if (!existsSync(base)) return [];
  const out: OfficialSkillAsset[] = [];
  for (const suite of readdirSync(base, { withFileTypes: true })) {
    if (!suite.isDirectory()) continue;
    const suiteDir = join(base, suite.name);
    for (const skill of readdirSync(suiteDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const file = join(suiteDir, skill.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const body = readFileSync(file, "utf-8");
      const fm = parseSkillFrontmatter(body);
      if (!fm.name) continue; // 缺 name 的资产不入库（种子纪律：残缺资产不静默放行）
      out.push({ suite: suite.name, name: fm.name, version: fm.version, description: fm.description, body });
    }
  }
  return out;
}
