import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { getConfig, getConfigState } from "../lib/config";
import type { ActionReceipt, ActionState, Ticket, TimelineItem } from "../lib/types";
import { EmptyState, Icon, Skeleton, StatusChip } from "@workloom/ui";
import { PageHeader, PullToRefresh, chineseMessage, formatTime } from "../components/common";
import { AsyncState, Button, Overlay, clientChineseText, clientIdentifierText } from "@workloom/ui";

function useKindLabel(): (kind: string) => string {
  const cfg = getConfig();
  const common: Record<string, string> = {
    service_request: "服务请求",
    consult: "咨询服务",
    complaint: "投诉建议",
    other: "其他服务",
  };
  return (kind) => cfg.serviceEntries.find((e) => e.kind === kind)?.title ?? common[kind] ?? "服务请求";
}

const ACTION_LABELS: Record<string, string> = {
  create: "工单已提交",
  created: "工单已提交",
  assign: "已分派服务团队",
  assigned: "已分派服务团队",
  start: "开始处理",
  progress: "处理进度已更新",
  complete: "处理已完成",
  close: "工单已关闭",
  rate: "评价已提交",
};

function actionLabel(item: TimelineItem): string {
  const detail = clientChineseText(item.detail, "");
  if (detail) return detail;
  return ACTION_LABELS[item.action] ?? "处理进度已更新";
}

function actorLabel(actorType: string): string {
  if (actorType === "guest" || actorType === "c_user") return "我";
  if (actorType === "staff" || actorType === "agent") return "服务团队";
  return "系统";
}

export default function TicketsPage({ refreshKey }: { refreshKey: number }) {
  const kindLabel = useKindLabel();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    if (!getConfigState().ready) {
      setTickets([]);
      setError("服务配置尚未就绪，工单没有被当作空结果或演示数据处理。请恢复配置后重试。");
      setLoading(false);
      return;
    }
    try {
      const r = await api.tickets();
      setTickets(r.tickets);
    } catch {
      setTickets([]);
      setError("工单暂时无法读取；系统没有用演示工单替代真实结果。请检查网络后重试。");
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
    return <TicketDetail id={activeId} kindLabel={kindLabel} onBack={() => setActiveId(null)} />;
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="我的工单" />
      <PullToRefresh onRefresh={load} className="flex-1 px-4 py-4">
        {loading ? (
          <Skeleton count={3} variant="card" label="工单列表正在加载" />
        ) : error ? (
          <AsyncState status="error" title="工单读取失败" description={error} onRetry={() => void load()} />
        ) : tickets.length === 0 ? (
          <EmptyState
            title="暂无工单"
            desc="有服务需求时，可到「服务」页选择对应入口提交"
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
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-body text-ink3">{kindLabel(t.kind)}</span>
                  <StatusChip status={t.statusText ?? t.status} />
                </div>
                <p className="mt-1.5 break-words text-body font-medium text-ink">{t.title}</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-body text-ink3">
                  <span className="min-w-0 break-words">{clientIdentifierText(t.id)}</span>
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
  kindLabel,
  onBack,
}: {
  id: string;
  kindLabel: (kind: string) => string;
  onBack: () => void;
}) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [rated, setRated] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [rateState, setRateState] = useState<ActionState>("idle");
  const [rateError, setRateError] = useState("");
  const [rateReceipt, setRateReceipt] = useState<ActionReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
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
          setDetailError("");
          setLoading(false);
        })
        .catch(() => {
          if (stop) return;
          setDetailError("工单详情暂时无法读取；系统保留最后一次真实结果，且没有展示演示数据。");
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
  }, [id, reloadVersion]);

  const done = (ticket?.statusText ?? ticket?.status) === "已完成" || ticket?.status === "done";

  // 工单完成后自动弹出满意度评价弹层（仅一次）
  useEffect(() => {
    if (done && !rated && !autoShown.current) {
      autoShown.current = true;
      setRateOpen(true);
    }
  }, [done, rated]);

  const rate = async () => {
    if (score === 0 || rated || rateState === "pending") return;
    setRateState("pending");
    setRateError("");
    try {
      const result = await api.rateTicket(id, { score, comment: comment.trim() || undefined });
      setRateReceipt(result.receipt);
      if (result.receipt.demo) {
        setRateState("demo");
        setRateError("当前渠道只返回了演示回执，评价未被标记为正式提交成功。");
        return;
      }
      setRateState("success");
      setRated(true);
      setRateOpen(false);
    } catch (err) {
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      setRateState("failed");
      setRateError(`${chineseMessage(err instanceof Error ? err.message : null, "评价暂时无法提交，请稍后重试")}${requestId ? `（请求${clientIdentifierText(requestId)}）` : ""}`);
    }
  };

  return (
    <div className="relative flex h-full flex-col">
      <PageHeader
        title="工单详情"
        right={
          <button type="button" onClick={onBack} className="text-body text-ink2">
            返回
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <Skeleton count={2} variant="card" label="工单详情正在加载" />
        ) : detailError && !ticket ? (
          <AsyncState
            status="error"
            title="工单详情读取失败"
            description={detailError}
            onRetry={() => {
              setLoading(true);
              setDetailError("");
              setReloadVersion((version) => version + 1);
            }}
          />
        ) : (
          <>
            {detailError && (
              <div role="alert" className="mb-3 flex min-w-0 flex-col gap-3 rounded-2xl border border-alert/50 bg-alert/10 p-3 text-body text-alert min-[380px]:flex-row min-[380px]:items-center min-[380px]:justify-between">
                <p className="min-w-0 break-words leading-relaxed">{detailError}</p>
                <Button
                  className="shrink-0"
                  onClick={() => {
                    setDetailError("");
                    setReloadVersion((version) => version + 1);
                  }}
                >
                  重新加载
                </Button>
              </div>
            )}
            <div className="animate-fadein rounded-2xl border border-line bg-card p-4">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-body text-ink3">{ticket ? kindLabel(ticket.kind) : "…"}</span>
                {ticket && <StatusChip status={ticket.statusText ?? ticket.status} />}
              </div>
              <p className="mt-1.5 break-words text-[0.9375rem] font-semibold text-ink">{ticket?.title ?? "加载中…"}</p>
              <p className="mt-1.5 break-words text-body text-ink3">工单{clientIdentifierText(id)}</p>
              {ticket?.slaDueAt && (
                <p className="mt-1 text-body text-gold">预计响应：{formatTime(ticket.slaDueAt)} 前</p>
              )}
            </div>

            {/* 进度时间线（节点动画） */}
            <h3 className="mb-2 mt-5 text-body font-medium text-ink2">处理进度（每 10 秒自动刷新）</h3>
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
                    <div className="min-w-0 flex-1 animate-fadein" style={{ animationDelay: `${i * 120 + 60}ms` }}>
                      <p className="break-words text-body text-ink">{actionLabel(it)}</p>
                      <p className="mt-0.5 text-body text-ink3">
                        {actorLabel(it.actorType)} · {formatTime(it.createdAt)}
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
                className="pressable mt-2 min-h-11 w-full animate-fadein rounded-full border border-gline bg-gold/10 px-4 py-2 text-body font-medium leading-snug text-gold"
              >
                评价本次服务
              </button>
            )}
            {rated && (
              <div className="mt-3 animate-fadein text-center">
                <p className="text-body text-go">评价已成功记录，感谢您的反馈。</p>
                {rateReceipt && (
                  <div className="mt-1 space-y-1 text-body text-ink3">
                    <p className="break-words">请求回执：{clientIdentifierText(rateReceipt.requestId)}</p>
                    {rateReceipt.eventId && <p className="break-words">账本凭证：{clientIdentifierText(rateReceipt.eventId)}</p>}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <Overlay
        open={rateOpen}
        title="服务满意度评价"
        description="工单已完成，请为本次服务打分。"
        onClose={() => { if (rateState !== "pending") setRateOpen(false); }}
        dismissOnBackdrop={rateState !== "pending"}
        dismissOnEscape={rateState !== "pending"}
        footer={(
          <>
            <Button
              variant="primary"
              busy={rateState === "pending"}
              disabled={score === 0}
              onClick={() => void rate()}
            >
              {rateState === "failed" || rateState === "demo" ? "重新提交评价" : "提交评价"}
            </Button>
            <Button disabled={rateState === "pending"} onClick={() => setRateOpen(false)}>稍后评价</Button>
          </>
        )}
      >
          <div className="px-1 pb-[max(.5rem,env(safe-area-inset-bottom))]">
            <div className="mt-4 flex justify-center gap-3">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setScore(n)}
                  aria-label={`${n} 星`}
                  title={`${n} 星`}
                  aria-pressed={n === score}
                  className="pressable p-0.5"
                >
                  <Icon
                    name="star"
                    size={30}
                    fill={n <= score ? "var(--color-gold)" : "none"}
                    stroke={n <= score ? "var(--color-gold)" : "var(--color-ink3)"}
                    strokeWidth="1.5"
                  />
                </button>
              ))}
            </div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="补充您的感受（选填）"
              className="mt-4 w-full resize-none rounded-xl border border-line bg-bg900 px-3 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
            {rateError && (
              <div role="alert" className={`mt-3 break-words rounded-xl border px-3 py-2 text-body leading-relaxed ${rateState === "demo" ? "border-warn/50 bg-warn/10 text-warn" : "border-alert/50 bg-alert/10 text-alert"}`}>
                {rateError}
              </div>
            )}
          </div>
      </Overlay>
    </div>
  );
}
