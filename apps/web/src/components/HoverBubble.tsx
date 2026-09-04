/**
 * HoverBubble · 一句话状态条（hover 0.5s / 注视触发共用）
 *
 * 深色胶囊：角色当前状态一句话（statusLine，真实任务数据）。
 * 与名牌分层：名牌恒定显示人名，气泡显示"在做什么"。
 */
import { Html } from "@react-three/drei";

export function HoverBubble({
  text, visible, position = [0, 1.05, 0],
}: {
  text: string;
  visible: boolean;
  position?: [number, number, number];
}) {
  if (!visible || !text) return null;
  return (
    <Html center position={position} style={{ pointerEvents: "none" }} zIndexRange={[30, 0]}>
      <div style={{
        whiteSpace: "nowrap", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis",
        fontSize: 11, color: "#eef4ff", lineHeight: 1.5,
        background: "rgba(14,16,19,.88)", border: "1px solid rgba(179,198,222,.35)",
        borderRadius: 8, padding: "3px 10px",
        boxShadow: "0 4px 16px rgba(0,0,0,.4)",
        animation: "wl-bubble-in .18s ease-out",
      }}>
        {text}
      </div>
      <style>{`@keyframes wl-bubble-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </Html>
  );
}
