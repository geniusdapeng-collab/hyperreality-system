/**
 * AgentAvatar · 数字员工统一形象资产（现代职场 SVG 版）
 *
 * 与 3D 角色（Avatar3D / KayKit）同源设计语义：同一套岗位→形象映射，
 * 让"世界里的他"在产品任何角落都被认出来——审批卡、成员页、Ask 栏、通栏、空状态。
 *
 * 历史枚举名为兼容旧数据继续保留，但画面不再使用骑士、法师和武器等游戏职业：
 * 五种外观全部是现代商务装数字员工，岗位通过配色、发型和胸前识别光区分。
 */

export type AvatarKind = "Knight" | "Mage" | "Rogue" | "Rogue_Hooded" | "Barbarian";

/** 与 Avatar3D.roleSkinOf 同规则的岗位→角色（2D 版只取角色种类） */
export function avatarKindOf(name: string, presetKey = ""): AvatarKind {
  const k = `${name}${presetKey}`.toLowerCase();
  if (k.includes("ceo")) return "Knight";
  if (k.includes("竞对") || k.includes("scout") || k.includes("competitor")) return "Rogue_Hooded";
  if (k.includes("内容") || k.includes("content") || k.includes("调价") || k.includes("pricing") || k.includes("收益")) return "Mage";
  if (k.includes("对账") || k.includes("账") || k.includes("finance") || k.includes("巡检") || k.includes("inspect")) return "Barbarian";
  const pool: AvatarKind[] = ["Rogue", "Mage", "Rogue_Hooded", "Barbarian"];
  let h = 0;
  for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return pool[Math.abs(h) % pool.length]!;
}

const KIND_COLOR: Record<AvatarKind, { main: string; accent: string }> = {
  Knight: { main: "#c2943f", accent: "#ffd98a" },
  Mage: { main: "#665ca8", accent: "#b9aaff" },
  Rogue: { main: "#385f86", accent: "#8ad8ff" },
  Rogue_Hooded: { main: "#2d756f", accent: "#84eadb" },
  Barbarian: { main: "#8a554a", accent: "#ffb29e" },
};

/** 现代职场全身人物（48×48 viewBox）：西装/针织衫/胸牌，不出现盔甲与武器。 */
function KindFigure({ kind, accent }: { kind: AvatarKind; accent: string }) {
  const skin = kind === "Barbarian" ? "#9a6249" : kind === "Rogue_Hooded" ? "#d59a72" : "#efc29e";
  const longHair = kind === "Mage" || kind === "Rogue_Hooded";
  const glasses = kind === "Rogue" || kind === "Knight";
  return (<>
    {/* 柔和地面光，强化“站立的人”而不是头像图标 */}
    <ellipse cx="24" cy="45" rx="10" ry="2" fill={accent} opacity=".18" />
    {/* 双腿与鞋 */}
    <path d="M18.8 34.5h4.3l-.5 8.2h-5.1zM24.9 34.5h4.3l1.3 8.2h-5.1z" fill="#17243a" />
    <path d="M16.5 42h7v2.2h-7.8zM25 42h6.8l.7 2.2H25z" fill="#09111f" />
    {/* 手臂 */}
    <path d="M15.2 24.3c-2 3.3-2.5 7.2-1.5 10.8l3.2-.7.9-8.9zM32.8 24.3c2 3.3 2.5 7.2 1.5 10.8l-3.2-.7-.9-8.9z" fill="currentColor" opacity=".9" />
    <circle cx="14.4" cy="35" r="1.7" fill={skin} /><circle cx="33.6" cy="35" r="1.7" fill={skin} />
    {/* 商务上装 */}
    <path d="M17 22.5c4-1.8 10-1.8 14 0l1.5 13.7h-17z" fill="currentColor" />
    <path d="M21 22l3 4 3-4-1.2 13h-3.6z" fill="#eef5ff" opacity=".95" />
    <path d="M23.2 26h1.6l.8 6-1.6 1.8-1.6-1.8z" fill={accent} />
    <rect x="27.8" y="27" width="2.6" height="2" rx=".5" fill={accent} opacity=".9" />
    {/* 颈部与脸 */}
    <rect x="21.8" y="18.3" width="4.4" height="4.6" rx="1.6" fill={skin} />
    {longHair && <path d="M17.3 10.7c1.2-6.5 12.2-7.1 14.1-.1l-.3 9.8-3.8-1.5-7.6.1-2.8 1.7z" fill="#18243a" />}
    <circle cx="24" cy="13.4" r="7" fill={skin} />
    {/* 发型 */}
    {longHair
      ? <path d="M17.3 12.6c.1-8.3 12.7-9.8 14-.9-2.8-3-7.7-3.8-13.8 1.8z" fill="#202b42" />
      : <path d="M17.8 11.7c1-7.4 11.7-7.8 12.8-1.3-3-1.5-7.4-2.5-12.8 1.3z" fill="#202b42" />}
    {/* 表情与眼镜 */}
    <circle cx="21.5" cy="13.8" r=".65" fill="#172033" /><circle cx="26.5" cy="13.8" r=".65" fill="#172033" />
    {glasses && <><rect x="19.5" y="12.5" width="4" height="2.7" rx="1" fill="none" stroke={accent} strokeWidth=".55" /><rect x="24.5" y="12.5" width="4" height="2.7" rx="1" fill="none" stroke={accent} strokeWidth=".55" /><path d="M23.5 13.6h1" stroke={accent} strokeWidth=".55" /></>}
    <path d="M22 17c1.3 1 2.7 1 4 0" fill="none" stroke="#8d5545" strokeWidth=".65" strokeLinecap="round" />
  </>);
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
