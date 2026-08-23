import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { demoTickets, demoTimeline } from "../lib/demo";
import type { Ticket, TimelineItem } from "../lib/types";
import { DemoBadge, PageHeader, StatusChip, formatTime } from "../components/common";

const KIND_LABEL: Record<string, string> = {
  delivery: "送物服务",
  repair: "维修报修",
  complaint: "投诉建议",
  other: "其他需求",
};

export default function TicketsPage({ refreshKey }: { refreshKey: number }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [demo, setDemo] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    api
      .tickets()
      .then((r) => {
        setTickets(r.tickets);
        setDemo(false);
      })
      .catch(() => {
        setTickets(demoTickets);
        setDemo(true);
      });
  }, [refreshKey]);

  if (activeId) {
    return <TicketDetail id={activeId} demo={demo} onBack={() => setActiveId(null)} />;
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="我的工单" right={demo ? <DemoBadge /> : undefined} />
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {tickets.length === 0 && (
          <p className="pt-16 text-center text-[12px] text-ink3">暂无工单，去「服务」页提交一个吧</p>
        )}
        {tickets.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveId(t.id)}
            className="w-full rounded-2xl border border-line bg-card p-3.5 text-left active:bg-bg700"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-ink3">{KIND_LABEL[t.kind] ?? t.kind}</span>
              <StatusChip status={t.status} />
            </div>
            <p className="mt-1.5 text-[13.5px] font-medium text-ink">{t.title}</p>
            <div className="mt-2 flex items-center justify-between text-[10px] text-ink3">
              <span className="font-mono">{t.id}</span>
              <span>{formatTime(t.createdAt)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TicketDetail({ id, demo, onBack }: { id: string; demo: boolean; onBack: () => void }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [rated, setRated] = useState(false);

  // 实时轮询 10s
  useEffect(() => {
    let stop = false;
    const load = () => {
      api
        .ticketDetail(id)
        .then((r) => {
          if (stop) return;
          setTicket(r.ticket);
          setTimeline(r.timeline);
        })
        .catch(() => {
          if (stop) return;
          setTicket(demoTickets.find((t) => t.id === id) ?? null);
          setTimeline(demoTimeline(id));
        });
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [id]);

  const rate = async () => {
    if (score === 0 || rated) return;
    try {
      await api.rateTicket(id, { score, comment: comment.trim() || undefined });
    } catch {
      // 演示态下静默记录本地
    }
    setRated(true);
  };

  const done = ticket?.status === "已完成";

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="工单详情"
        right={
          <button type="button" onClick={onBack} className="text-[12px] text-ink2">
            返回
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="rounded-2xl border border-line bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink3">{ticket ? KIND_LABEL[ticket.kind] : "…"}</span>
            {ticket && <StatusChip status={ticket.status} />}
          </div>
          <p className="mt-1.5 text-[15px] font-semibold text-ink">{ticket?.title ?? "加载中…"}</p>
          <p className="mt-1.5 font-mono text-[11px] text-ink3">{id}</p>
          {ticket?.slaDueAt && (
            <p className="mt-1 text-[11px] text-gold">预计响应：{formatTime(ticket.slaDueAt)} 前</p>
          )}
          {demo && (
            <div className="mt-2">
              <DemoBadge />
            </div>
          )}
        </div>

        {/* 进度时间线 */}
        <h3 className="mb-2 mt-5 text-[12px] font-medium text-ink2">处理进度（每 10s 自动刷新）</h3>
        <div className="space-y-0">
          {timeline.map((it, i) => (
            <div key={i} className="relative flex gap-3 pb-5">
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1 h-2.5 w-2.5 rounded-full ${i === timeline.length - 1 ? "bg-gold" : "bg-line"}`}
                />
                {i < timeline.length - 1 && <span className="w-px flex-1 bg-line" />}
              </div>
              <div className="flex-1">
                <p className="text-[12.5px] text-ink">{it.detail || it.action}</p>
                <p className="mt-0.5 text-[10px] text-ink3">
                  {it.actorType === "guest" ? "我" : it.actorId} · {formatTime(it.createdAt)}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* 满意度评价 */}
        {done && (
          <div className="mt-2 rounded-2xl border border-gline bg-gold/5 p-4">
            <h3 className="text-[13px] font-medium text-goldhi">服务满意度评价</h3>
            {rated ? (
              <p className="mt-2 text-[12px] text-go">感谢您的评价，期待再次为您服务。</p>
            ) : (
              <>
                <div className="mt-2.5 flex gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setScore(n)}
                      aria-label={`${n} 星`}
                      className="p-0.5"
                    >
                      <svg
                        width="26"
                        height="26"
                        viewBox="0 0 24 24"
                        fill={n <= score ? "#e9b558" : "none"}
                        stroke={n <= score ? "#e9b558" : "#5e7099"}
                        strokeWidth="1.5"
                      >
                        <path d="M12 2l2.4 4.8 5.3.8-3.8 3.7.9 5.3L12 14.1 7.2 16.6l.9-5.3L4.3 7.6l5.3-.8L12 2z" />
                      </svg>
                    </button>
                  ))}
                </div>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                  placeholder="补充您的感受（选填）"
                  className="mt-2.5 w-full resize-none rounded-xl border border-line bg-bg900 px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink3 focus:border-gline"
                />
                <button
                  type="button"
                  onClick={() => void rate()}
                  disabled={score === 0}
                  className="mt-2.5 h-9 w-full rounded-full bg-gold text-[13px] font-medium text-ongold disabled:opacity-40"
                >
                  提交评价
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
