/**
 * 消息族（设计规范 §5.6）：人类气泡 / Agent 行动消息 / 子调用 / 系统分隔线
 * 铁律：回执徽标三态（✓已生效 绿 / ⚠未核实 琥珀 / ✗失败 红）——禁止隐藏失败与不确定（§9.3）；
 *      子调用必须与主调用同瀑布语义可见（H-4）；系统事件同样落库（分隔线带事件摘要）
 */
import type { ReactNode } from "react";
import { EventIdChip } from "./EventIdChip";
import { Icon, clientChineseText, type IconName } from "@workloom/ui";
import { versionText } from "../../lib/display";

/** 人类消息：右侧气泡，金边，圆角右上直角（§5.6） */
export function HumanBubble({ children, time }: { children: ReactNode; time?: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-msg rounded-tr-[4px] border border-gline bg-gold/8 px-3.5 py-2.5">
        <div className="text-body leading-relaxed text-ink">{children}</div>
        {time && <div className="mt-1 text-right text-body text-ink3">{time}</div>}
      </div>
    </div>
  );
}

export type ReceiptState = "synced" | "unverified" | "failed";

const RECEIPT_META: Record<ReceiptState, { icon: IconName; label: string; cls: string }> = {
  synced: { icon: "check", label: "已生效", cls: "border-go/45 text-go" },
  unverified: { icon: "warning", label: "未核实", cls: "border-warn/45 text-warn" },
  failed: { icon: "error", label: "失败", cls: "border-alert/55 text-alert" },
};

/** Agent 行动消息：左侧气泡（左上直角 4px 表「对方消息」§4.1） */
export function AgentActionMessage({
  sender,
  version,
  action,
  eventId,
  receipt,
  rules = [],
  credits,
  memoryRefs = [],
  children,
}: {
  sender: string;
  version: string;
  action: string;
  eventId: string;
  receipt: ReceiptState;
  rules?: string[];
  credits?: number;
  memoryRefs?: string[];
  children?: ReactNode;
}) {
  const rm = RECEIPT_META[receipt];
  return (
    <div className="flex justify-start">
      <div className="max-w-[82%] rounded-msg rounded-tl-[4px] border border-line bg-card px-3.5 py-2.5">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-body font-bold text-ink">{clientChineseText(sender, "数字员工")}</span>
          {version && <span className="text-body text-ink3">{versionText(version)}</span>}
          <EventIdChip id={eventId} />
          <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-body font-bold ${rm.cls}`}>
            <Icon name={rm.icon} size={13} /> {rm.label}
          </span>
        </div>
        <div className="text-body font-semibold text-holo">{action}</div>
        {children && <div className="mt-1 text-body leading-relaxed text-ink2">{children}</div>}
        {/* 底部小字：命中规则 / 能量 / 引用记忆（§5.6） */}
        {(rules.length > 0 || credits !== undefined || memoryRefs.length > 0) && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-line pt-1.5 text-body text-ink3">
            {rules.map((r, index) => (
              <span key={r} className="text-holo2">命中安全规则 {index + 1}</span>
            ))}
            {credits !== undefined && <span>能量 <b className="font-orb text-gold">{credits}</b></span>}
            {memoryRefs.map((m, index) => (
              <span key={m}>引用组织经验 {index + 1}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 子调用消息：虚线边框气泡 + 「@对象 版本」+ 数据卡回执（与主调用同瀑布语义可见 H-4） */
export function SubCallMessage({
  target,
  version,
  receipt,
  children,
}: {
  target: string;
  version: string;
  receipt: ReceiptState;
  children?: ReactNode;
}) {
  const rm = RECEIPT_META[receipt];
  return (
    <div className="ml-8 flex justify-start">
      <div className="max-w-[76%] rounded-msg border border-dashed border-holo/30 bg-bg800/50 px-3.5 py-2.5">
        <div className="mb-1 flex items-center gap-2 text-body">
          <span className="text-ink2">↳ 子调用</span>
          <span className="font-bold text-holo">@{clientChineseText(target, "数字员工")}</span>
          {version && <span className="text-body text-ink3">{versionText(version)}</span>}
          <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-body font-bold ${rm.cls}`}>
            <Icon name={rm.icon} size={13} /> {rm.label}
          </span>
        </div>
        {children && <div className="text-body leading-relaxed text-ink2">{children}</div>}
      </div>
    </div>
  );
}

/** 系统分隔线：中央细分隔线 + 时间与事件摘要（系统事件同样落库 G8） */
export function SystemDivider({ time, summary }: { time: string; summary: string }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-line" />
      <span className="text-body text-ink3">
        {time} · {summary}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
