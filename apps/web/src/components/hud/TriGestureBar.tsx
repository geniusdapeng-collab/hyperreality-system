/**
 * TriGestureBar 待我审批三操纵杆（设计规范 §5.4；审批手势 F5.2）
 * 结构：三杆并列 ✓推进（绿边）/ ✎校准（青边）/ ✗制动（红边）；大图标+主名+小字副标题
 *      （采纳 / 编辑后采纳 / 驳回）
 * 铁律：驳回必弹原因（枚举+≤200 字，L5.2）；无审批权角色整组隐藏（非置灰，L5.1/F5.6）；
 *      快照过期时三杆整体禁用并刷新（E5.3）
 */

export type Gesture = "approve" | "edit" | "reject";

const RODS: Array<{ key: Gesture; icon: string; name: string; sub: string; cls: string; hover: string }> = [
  { key: "approve", icon: "✓", name: "推进", sub: "采纳", cls: "border-go/50 text-go", hover: "hover:bg-go/10" },
  { key: "edit", icon: "✎", name: "校准", sub: "编辑后采纳", cls: "border-holo/50 text-holo", hover: "hover:bg-holo/10" },
  { key: "reject", icon: "✗", name: "制动", sub: "驳回", cls: "border-alert/55 text-alert", hover: "hover:bg-alert/10" },
];

export function TriGestureBar({
  expired = false,
  canApprove = true,
  onGesture,
  onRefresh,
}: {
  /** 快照过期（E5.3）：三杆整体禁用并提示刷新 */
  expired?: boolean;
  /** 无审批权 → 整组隐藏（非置灰；L5.1 服务端另有强制鉴权） */
  canApprove?: boolean;
  onGesture?: (g: Gesture) => void;
  onRefresh?: () => void;
}) {
  if (!canApprove) return null; // 隐藏非置灰（§8.2/§5.4 铁律）
  if (expired) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn/5 px-4 py-2.5">
        <span className="text-body text-warn">快照已过期，审批杆已锁定（E5.3）</span>
        <button
          type="button"
          onClick={onRefresh}
          className="cursor-pointer rounded-md border border-holo/40 bg-holo/8 px-3 py-1 text-caption font-bold text-holo"
        >
          刷新最新快照
        </button>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {RODS.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onGesture?.(r.key)}
          className={`cursor-pointer rounded-lg border bg-card px-3 py-2.5 text-center transition-colors ${r.cls} ${r.hover}`}
        >
          <div className="text-lg leading-none">{r.icon}</div>
          <div className="mt-1 text-body font-black">{r.name}</div>
          <div className="mt-0.5 text-micro text-ink3">{r.sub}</div>
        </button>
      ))}
    </div>
  );
}
