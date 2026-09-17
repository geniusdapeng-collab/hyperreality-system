/**
 * service-ticket · 工单状态机（纯函数：迁移合法性唯一事实源）
 *
 * created → assigned → processing → done → closed
 * created 允许直接关闭（客人撤单/误单）；其余跃迁一律拒绝。
 */

export type TicketStatus = "created" | "assigned" | "processing" | "done" | "closed";

const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  created: ["assigned", "closed"],
  assigned: ["processing"],
  processing: ["done"],
  done: ["closed"],
  closed: [],
};

export class TicketTransitionError extends Error {
  constructor(
    public readonly from: TicketStatus,
    public readonly to: TicketStatus,
  ) {
    super(`工单状态机非法迁移：${from} → ${to}`);
    this.name = "TicketTransitionError";
  }
}

export function assertTicketTransition(from: TicketStatus, to: TicketStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new TicketTransitionError(from, to);
}

/** advanceTicket 的「下一态」推导（assigned→processing→done；其他态调用即非法） */
export function nextStatusOf(status: TicketStatus): TicketStatus {
  const next = TRANSITIONS[status].filter((s) => s !== "closed");
  if (next.length !== 1) throw new TicketTransitionError(status, next[0] ?? "closed");
  return next[0]!;
}
