import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { getConfig } from "../lib/config";
import { demoTickets, demoTimeline } from "../lib/demo";
import type { Ticket, TimelineItem } from "../lib/types";
import { DemoBadge, EmptyState, PageHeader, PullToRefresh, SkeletonList, StatusChip, formatTime } from "../components/common";

function useKindLabel(): (kind: string) => string {
  const cfg = getConfig();
  return (kind) => cfg.serviceEntries.find((e) => e.kind === kind)?.title ?? kind;
}

export default function TicketsPage({ refreshKey }: { refreshKey: number }) {
  const kindLabel = useKindLabel();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.tickets();
      setTickets(r.tickets);
      setDemo(false);
    } catch {
      setTickets(demoTickets);
      setDemo(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (activeId) {
    return <TicketDetail id={activeId} demo={demo} kindLabel={kindLabel} onBack={() => setActiveId(null)} />;
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="我的工单" right={demo ? <DemoBadge /> : undefined} />
      <PullToRefresh onRefresh={load} className="flex-1 px-4 py-4">
        {loading ? (
          <SkeletonList rows={3} />
        ) : tickets.length === 0 ? (
          <EmptyState
            title="暂无工单"
            desc="有送物、维修或其他需求时，可到「服务」页一键提交"
          />
        ) : (
          <div className="space-y-3">
            {tickets.map((t, i) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveId(t.id)}
                className="pressable w-full animate-fadein rounded-2xl border border-line bg-card p-3.5 text-left active:bg-bg700"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-ink3">{kindLabel(t.kind)}</span>
                  <StatusChip status={t.statusText ?? t.status} />
                </div>
                <p className="mt-1.5 text-[13.5px] font-medium text-ink">{t.title}</p>
                <div className="mt-2 flex items-center justify-between text-[10px] text-ink3">
                  <span className="font-mono">{t.id}</span>
                  <span>{formatTime(t.createdAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </PullToRefresh>
    </div>
  );
}

function TicketDetail({
  id,
  demo,
  kindLabel,
  onBack,
}: {
  id: string;
  demo: boolean;
  kindLabel: (kind: string) => string;
  onBack: () => void;
}) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [rated, setRated] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const autoShown = useRef(false);

  // 实时轮询 10s；页面不可见（切后台/锁屏）时暂停
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = () => {
      api
        .ticketDetail(id)
        .then((r) => {
          if (stop) return;
          setTicket(r.ticket);
          setTimeline(r.timeline);
          setLoading(false);
        })
        .catch(() => {
          if (stop) return;
          setTicket(demoTickets.find((t) => t.id === id) ?? null);
          setTimeline(demoTimeline(id));
          setLoading(false);
        });
    };
    const start = () => {
      if (timer == null) timer = setInterval(load, 10_000);
    };
    const halt = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => {
      if (document.hidden) halt();
      else {
        load();
        start();
      }
    };
    load();
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      halt();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [id]);

  const done = (ticket?.statusText ?? ticket?.status) === "已完成" || ticket?.status === "done";

  // 工单完成后自动弹出满意度评价弹层（仅一次）
  useEffect(() => {
    if (done && !rated && !autoShown.current) {
      autoShown.current = true;
      setRateOpen(true);
    }
  }, [done, rated]);

  const rate = async () => {
    if (score === 0 || rated) return;
    try {
      await api.rateTicket(id, { score, comment: comment.trim() || undefined });
    } catch {
      // 演示态下静默记录本地
    }
    setRated(true);
    setRateOpen(false);
  };

  return (
    <div className="relative flex h-full flex-col">
      <PageHeader
        title="工单详情"
        right={
          <button type="button" onClick={onBack} className="text-[12px] text-ink2">
            返回
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <SkeletonList rows={2} />
        ) : (
          <>
            <div className="animate-fadein rounded-2xl border border-line bg-card p-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-ink3">{ticket ? kindLabel(ticket.kind) : "…"}</span>
                {ticket && <StatusChip status={ticket.statusText ?? ticket.status} />}
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

            {/* 进度时间线（节点动画） */}
            <h3 className="mb-2 mt-5 text-[12px] font-medium text-ink2">处理进度（每 10s 自动刷新）</h3>
            <div className="space-y-0">
              {timeline.map((it, i) => {
                const last = i === timeline.length - 1;
                return (
                  <div key={i} className="relative flex gap-3 pb-5">
                    <div className="flex flex-col items-center">
                      <span
                        className={`mt-1 h-2.5 w-2.5 animate-pop rounded-full ${
                          last ? "animate-pulse-ring bg-gold" : "bg-line"
                        }`}
                        style={{ animationDelay: `${i * 120}ms` }}
                      />
                      {!last && <span className="w-px flex-1 bg-line" />}
                    </div>
                    <div className="flex-1 animate-fadein" style={{ animationDelay: `${i * 120 + 60}ms` }}>
                      <p className="text-[12.5px] text-ink">{it.detail || it.action}</p>
                      <p className="mt-0.5 text-[10px] text-ink3">
                        {it.actorType === "guest" ? "我" : it.actorId} · {formatTime(it.createdAt)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 已完成：评价入口（弹层） */}
            {done && !rated && (
              <button
                type="button"
                onClick={() => setRateOpen(true)}
                className="pressable mt-2 h-11 w-full animate-fadein rounded-full border border-gline bg-gold/10 text-[13.5px] font-medium text-gold"
              >
                评价本次服务
              </button>
            )}
            {rated && (
              <p className="mt-3 animate-fadein text-center text-[12px] text-go">感谢您的评价，期待再次为您服务。</p>
            )}
          </>
        )}
      </div>

      {/* 满意度评价弹层（底部弹出） */}
      {rateOpen && (
        <div className="absolute inset-0 z-20 flex flex-col justify-end">
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setRateOpen(false)}
            className="flex-1 bg-bg950/70 backdrop-blur-sm"
          />
          <div className="animate-fadein rounded-t-3xl border-t border-gline bg-bg800 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5">
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
            <h3 className="text-center text-[15px] font-semibold text-goldhi">服务满意度评价</h3>
            <p className="mt-1 text-center text-[11px] text-ink3">工单 {id} 已完成，请为本次服务打分</p>
            <div className="mt-4 flex justify-center gap-3">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setScore(n)}
                  aria-label={`${n} 星`}
                  className="pressable p-0.5"
                >
                  <svg
                    width="30"
                    height="30"
                    viewBox="0 0 24 24"
                    fill={n <= score ? "var(--color-gold)" : "none"}
                    stroke={n <= score ? "var(--color-gold)" : "var(--color-ink3)"}
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
              className="mt-4 w-full resize-none rounded-xl border border-line bg-bg900 px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
            <button
              type="button"
              onClick={() => void rate()}
              disabled={score === 0}
              className="pressable mt-3 h-11 w-full rounded-full bg-gold text-[14px] font-medium text-ongold disabled:opacity-40"
            >
              提交评价
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
