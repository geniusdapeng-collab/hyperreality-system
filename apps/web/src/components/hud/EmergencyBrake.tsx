/**
 * EmergencyBrake 紧急制动杆（设计规范 §5.9/§6：顶栏/底栏红色长杆，拉动式二次确认）
 * 铁律：永远可见可用；触发后全端 ≤60s 生效（G5）——产品级安全承诺，不是装饰；
 *      制动永远严肃可用，禁用游戏化文案掩盖（§9.3）
 * 本卡含二次确认视觉态；真实暂停链路（pauseAll，B9）在 F11/P9 接线。
 */
import { useState } from "react";

export function EmergencyBrake({ onConfirm }: { onConfirm?: () => void }) {
  const [arming, setArming] = useState(false);
  if (arming) {
    // 二次确认（拉动式）：确认杆 + 撤回
    return (
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => { onConfirm?.(); setArming(false); }}
          className="cursor-pointer rounded-lg border border-alert bg-alert/20 px-3.5 py-1.5 text-xs font-extrabold tracking-wider text-alert shadow-[0_0_16px_rgba(255,77,109,.4)]"
        >
          ⚠ 确认制动（全端 ≤60s 生效）
        </button>
        <button
          type="button"
          onClick={() => setArming(false)}
          className="cursor-pointer rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink3"
        >
          撤回
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArming(true)}
      className="cursor-pointer rounded-lg border border-alert/55 bg-alert/7 px-3.5 py-1.5 text-xs font-extrabold tracking-wider text-alert transition-colors hover:bg-alert/15"
      title="紧急制动：一键暂停全部夜间 Agent（G5 · ≤60s）"
    >
      🛑 紧急制动
    </button>
  );
}
