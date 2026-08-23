/**
 * P6 技能广场 · 共享类型与展示助手（供 P6 页与四环子组件复用）
 */

export interface SkillRow {
  id: string; level: "official" | "team" | "industry"; bundle: string | null;
  name: string; version: string; description: string;
  fence_bindings: string[]; desensitized: boolean;
}
export interface SkillUsage {
  calls30: number; adopted30: number; rejected30: number; adoptionRate: number | null;
  rejectReasons: Array<{ reason: string; count: number }>;
  boundAgents: Array<{ id: string; presetKey: string; name: string }>;
}

/** 稀有度视觉口径（§6 设计规范：官方=金 / 团队=银 / 行业共享=铜） */
export const RARITY = {
  official: { border: "border-gold/60", tag: "传说 · 官方", cls: "text-gold", icon: "✦" },
  team: { border: "border-[#C0C8E8]/50", tag: "精良 · 团队", cls: "text-[#C0C8E8]", icon: "✧" },
  industry: { border: "border-[#CD8B5A]/50", tag: "共享 · 行业", cls: "text-[#CD8B5A]", icon: "❖" },
} as const;

/** 展示名（官方套件 description 首句为中文名，如「收益管理专家。…」；团队/行业直接用 name） */
export function displayName(s: SkillRow): string {
  const m = /^([^。]{2,12})。/.exec(s.description);
  return m?.[1] ?? s.name;
}
/** 展示描述（去掉首句中文名部分） */
export function displayDesc(s: SkillRow): string {
  const m = /^[^。]{2,12}。(.+)$/.exec(s.description);
  return m?.[1] ?? s.description;
}

/** 技能图标（按名称语义映射，视频创作语境，演示口径） */
export function skillIcon(s: Pick<SkillRow, "id" | "name">): string {
  if (/脚本|script|brief|shot-prompt/i.test(s.id + s.name)) return "📝";
  if (/渲染|render/i.test(s.id + s.name)) return "🎬";
  if (/发布|publish/i.test(s.id + s.name)) return "🚀";
  if (/评论|comment/i.test(s.id + s.name)) return "💬";
  if (/素材|material|asset/i.test(s.id + s.name)) return "🗂";
  if (/选题|情报|research|trend|jenny/i.test(s.id + s.name)) return "🎯";
  if (/定妆|portrait/i.test(s.id + s.name)) return "🎭";
  if (/复盘|weekly|review/i.test(s.id + s.name)) return "📊";
  return "🛠";
}

/** 技能短名（注册表主键可带 skill- 前缀，preset/技能链声明为短名） */
export function shortSkillId(id: string): string {
  return id.replace(/^skill-[ti]?-?/, "");
}

/** 按短名/全 id 双形态在技能列表中查找 */
export function findSkill(skills: SkillRow[], ref: string): SkillRow | undefined {
  return skills.find((s) => s.id === ref || shortSkillId(s.id) === ref);
}
