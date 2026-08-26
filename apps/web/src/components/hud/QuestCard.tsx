/**
 * QuestCard 主线任务卡（设计规范 §5.2）
 * 结构：「主线 MAIN QUEST」金色章 + 模式 pill + #E 编号（等宽青）+ 任务名 + 当前动作
 *      + XP 进度条（金色流光）+ 里程碑节点灯（x/y 段）
 * 状态：queued 排队 / running 执行中（青脉冲）/ review 待审查（琥珀）/ done 已完成（绿）
 *      / failed 失败（红框）/ paused 已暂停
 * 铁律：进度必须真实来自状态机轮询；断线显「重连中」，禁止伪造进度（§5.2）
 */
import { XpBar } from "./XpBar";
import { EventIdChip } from "./EventIdChip";

export type QuestStatus = "queued" | "running" | "review" | "done" | "failed" | "paused";

const STATUS_META: Record<QuestStatus, { label: string; cls: string; border: string; pulse?: string }> = {
  queued: { label: "排队", cls: "text-ink3", border: "border-line" },
  running: { label: "执行中", cls: "text-holo", border: "border-holo/45", pulse: "animate-pulse-hud" },
  review: { label: "待审查", cls: "text-warn", border: "border-warn/45", pulse: "animate-pulse-warn" },
  done: { label: "已完成", cls: "text-go", border: "border-go/40" },
  failed: { label: "失败", cls: "text-alert", border: "border-alert/55" },
  paused: { label: "已暂停", cls: "text-warn", border: "border-warn/35" },
};

export function QuestCard({
  eventId,
  title,
  mode = "quest",
  action = "",
  done,
  total,
  status,
  reconnecting = false,
}: {
  eventId: string;
  title: string;
  mode?: string;
  action?: string;
  done: number;
  total: number;
  status: QuestStatus;
  /** 断线显「重连中」（禁止伪造进度） */
  reconnecting?: boolean;
}) {
  const meta = STATUS_META[status];
  return (
    <div className={`rounded-msg border bg-card p-4 ${meta.border}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded border border-gold/60 bg-gold/10 px-1.5 py-0.5 text-micro font-black tracking-widest text-gold">
          主线 MAIN QUEST
        </span>
        <span className="rounded border border-line px-1.5 py-0.5 text-micro text-ink3">{mode}</span>
        <EventIdChip id={eventId} />
        <span className="flex-1" />
        <span className={`inline-flex items-center gap-1.5 text-caption font-bold ${meta.cls}`}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${meta.pulse ?? ""}`} />
          {reconnecting ? "重连中…" : meta.label}
        </span>
      </div>
      <div className="mb-1 text-h2 font-bold text-ink">{title}</div>
      {action && <div className="mb-2.5 text-body text-ink2">当前动作：{action}</div>}
      <XpBar done={done} total={total} />
      {/* 里程碑节点灯（x/y 段） */}
      <div className="mt-2 flex gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-2 w-2 rounded-full ${
              i < done
                ? "bg-gold shadow-[0_0_8px_rgba(255,36,66,.7)]"
                : i === done && status === "running"
                  ? "bg-holo animate-pulse-hud"
                  : "bg-bg700"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
