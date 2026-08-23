import { useState } from "react";
import type { Citation, MemberInfo, Order } from "../lib/types";
import { StatusChip, formatTime } from "./common";

/** AI 答案下方的引用来源卡（可展开） */
export function CitationCard({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (citations.length === 0) return null;
  return (
    <div className="mt-2 rounded-xl border border-holo/30 bg-holo/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-[11px] text-holo">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          引用来源 · {citations.length} 条
        </span>
        <span className={`text-holo transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-holo/20 px-3 py-2">
          {citations.map((c, i) => (
            <div key={i} className="rounded-lg bg-bg900/60 p-2">
              <p className="text-[11px] font-medium text-holo">
                《{c.documentTitle}》 · {c.heading}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink2">{c.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 订单业务卡 */
export function OrderCard({ order }: { order: Order }) {
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-gline bg-card">
      <div className="flex items-center justify-between bg-gold/10 px-3 py-1.5">
        <span className="text-[11px] font-medium text-gold">我的订单</span>
        <span className="font-mono text-[10px] text-ink3">{order.id}</span>
      </div>
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-medium text-ink">{order.title}</p>
          <StatusChip status={order.status} />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink2">
          <span>
            {order.roomType ?? ""}
            {order.checkIn ? ` · 入住 ${order.checkIn}` : ""}
          </span>
          {typeof order.amount === "number" && (
            <span className="font-orb text-[13px] text-gold">¥{order.amount}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 会员业务卡 */
export function MemberCard({ member }: { member: MemberInfo }) {
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-gline bg-gradient-to-br from-bg700 to-bg800">
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-gold">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l2.4 4.8 5.3.8-3.8 3.7.9 5.3L12 14.1 7.2 16.6l.9-5.3L4.3 7.6l5.3-.8L12 2z" />
          </svg>
          {member.level}
        </span>
        <span className="font-orb text-[15px] text-goldhi">{member.points} 积分</span>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
        {member.benefits.map((b) => (
          <span key={b} className="rounded-full bg-gold/10 px-2 py-0.5 text-[10px] text-goldhi">
            {b}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 低置信度转人工工单卡 */
export function TicketNoticeCard({ title }: { title: string }) {
  return (
    <div className="mt-2 flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn/10 p-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warn/20 text-warn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
      </span>
      <div>
        <p className="text-[12px] font-medium text-warn">已为您转专人处理</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink2">{title}</p>
      </div>
    </div>
  );
}

/** 仿微信服务通知卡 */
export function ServiceNoticeCard({
  kind,
  title,
  detail,
  createdAt,
  read,
}: {
  kind: string;
  title: string;
  detail?: string;
  createdAt: string;
  read: boolean;
}) {
  const label =
    kind === "ticket.completed" ? "工单完成通知" : kind === "ticket.accepted" ? "工单受理通知" : "会员权益通知";
  const tone = kind === "ticket.completed" ? "text-go" : kind === "ticket.accepted" ? "text-holo" : "text-gold";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className={`text-[11px] font-medium ${tone}`}>{label}</span>
        <span className="flex items-center gap-1.5 text-[10px] text-ink3">
          {!read && <span className="h-1.5 w-1.5 rounded-full bg-alert" />}
          {formatTime(createdAt)}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <p className="text-[13px] font-medium text-ink">{title}</p>
        {detail && <p className="mt-1 text-[11px] leading-relaxed text-ink2">{detail}</p>}
      </div>
      <div className="border-t border-line px-3 py-1.5 text-[10px] text-ink3">星芒好物 · AI 服务前台</div>
    </div>
  );
}
