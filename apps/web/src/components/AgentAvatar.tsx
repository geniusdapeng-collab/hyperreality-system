/**
 * AgentAvatar · 数字人统一形象资产（2D SVG 版）
 *
 * 与 3D 角色（Avatar3D / KayKit）同源设计语义：同一套岗位→形象映射，
 * 让"世界里的他"在产品任何角落都被认出来——审批卡、成员页、Ask 栏、通栏、空状态。
 *
 * 五角色剪影特征：Knight=金盔面甲（CEO）/ Mage=尖帽（内容·调价）/
 * Rogue=圆兜帽（评价·前台）/ Rogue_Hooded=尖兜帽露目缝（竞对）/ Barbarian=角盔壮汉（对账·巡检）。
 */

export type AvatarKind = "Knight" | "Mage" | "Rogue" | "Rogue_Hooded" | "Barbarian";

/** 与 Avatar3D.roleSkinOf 同规则的岗位→角色（2D 版只取角色种类） */
export function avatarKindOf(name: string, presetKey = ""): AvatarKind {
  const k = `${name}${presetKey}`.toLowerCase();
  if (k.includes("ceo")) return "Knight";
  if (k.includes("竞对") || k.includes("scout") || k.includes("competitor")) return "Rogue_Hooded";
  if (k.includes("内容") || k.includes("content") || k.includes("调价") || k.includes("pricing") || k.includes("收益")) return "Mage";
  if (k.includes("对账") || k.includes("账") || k.includes("finance") || k.includes("巡检") || k.includes("inspect")) return "Barbarian";
  return "Rogue";
}

const KIND_COLOR: Record<AvatarKind, { main: string; accent: string }> = {
  Knight: { main: "#c8a24a", accent: "#ffd98a" },
  Mage: { main: "#7a5fc0", accent: "#b9a2f0" },
  Rogue: { main: "#6b7a90", accent: "#a8bcd8" },
  Rogue_Hooded: { main: "#4a5a70", accent: "#8ad8ff" },
  Barbarian: { main: "#8a6a50", accent: "#e0b890" },
};

/** 角色剪影路径（48×48 viewBox，头+肩） */
function KindFigure({ kind, accent }: { kind: AvatarKind; accent: string }) {
  switch (kind) {
    case "Knight":
      return (<>
        {/* 金盔：圆顶 + 面甲横缝 + 盔缨 */}
        <path d="M14 22 a10 10 0 0 1 20 0 v6 h-20 z" fill="currentColor" />
        <rect x="14" y="26" width="20" height="4" rx="1.5" fill="currentColor" />
        <rect x="17" y="27.4" width="14" height="1.4" rx="0.7" fill="#0d1526" />
        <path d="M24 8 q3 3 0 7" stroke={accent} strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <path d="M12 34 q12 -5 24 0 v10 h-24 z" fill="currentColor" opacity="0.85" />
      </>);
    case "Mage":
      return (<>
        {/* 尖帽法师：尖顶帽 + 帽檐 + 肩 */}
        <path d="M24 4 l8 16 h-16 z" fill="currentColor" />
        <ellipse cx="24" cy="21" rx="13" ry="3.4" fill="currentColor" />
        <circle cx="24" cy="26" r="7" fill={accent} opacity="0.9" />
        <rect x="20" y="26" width="8" height="1.6" rx="0.8" fill="#0d1526" />
        <path d="M12 36 q12 -5 24 0 v8 h-24 z" fill="currentColor" opacity="0.85" />
      </>);
    case "Rogue_Hooded":
      return (<>
        {/* 尖兜帽：深罩 + 目缝发光 */}
        <path d="M24 6 q12 6 10 22 h-20 q-2 -16 10 -22 z" fill="currentColor" />
        <rect x="18" y="23" width="12" height="2" rx="1" fill={accent} />
        <path d="M12 34 q12 -5 24 0 v10 h-24 z" fill="currentColor" opacity="0.85" />
      </>);
    case "Barbarian":
      return (<>
        {/* 角盔壮汉：双角 + 宽肩 + 胡须 */}
        <path d="M12 12 q-4 6 2 9 M36 12 q4 6 -2 9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
        <circle cx="24" cy="21" r="9" fill="currentColor" />
        <path d="M17 25 q7 6 14 0 v5 q-7 5 -14 0 z" fill={accent} opacity="0.85" />
        <path d="M8 38 q16 -7 32 0 v6 h-32 z" fill="currentColor" opacity="0.9" />
      </>);
    default: // Rogue
      return (<>
        {/* 圆兜帽游侠 */}
        <path d="M14 24 a10 10 0 0 1 20 0 v4 h-20 z" fill="currentColor" />
        <circle cx="24" cy="24" r="6" fill={accent} opacity="0.9" />
        <rect x="20" y="23.4" width="8" height="1.4" rx="0.7" fill="#0d1526" />
        <path d="M12 35 q12 -5 24 0 v9 h-24 z" fill="currentColor" opacity="0.85" />
      </>);
  }
}

export function AgentAvatar({
  kind, size = 32, ring = true, title,
}: {
  kind: AvatarKind;
  size?: number;
  ring?: boolean;      // 底座光环（与 3D 底座环同语义）
  title?: string;
}) {
  const c = KIND_COLOR[kind];
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={title ?? kind}
      style={{ color: c.main, flexShrink: 0, filter: ring ? `drop-shadow(0 0 ${size / 8}px ${c.accent}55)` : undefined }}
    >
      {title && <title>{title}</title>}
      {ring && <circle cx="24" cy="44" r="3.2" fill="none" stroke={c.accent} strokeWidth="1.2" opacity="0.7" />}
      <KindFigure kind={kind} accent={c.accent} />
    </svg>
  );
}

/** 便捷封装：按名称/岗位直接出头像 */
export function AgentAvatarOf({
  name, presetKey, size = 32, ring = true,
}: {
  name: string; presetKey?: string; size?: number; ring?: boolean;
}) {
  return <AgentAvatar kind={avatarKindOf(name, presetKey)} size={size} ring={ring} title={name} />;
}
