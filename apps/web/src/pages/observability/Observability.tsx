import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { EmptyState, Skeleton } from "../../components/hud";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import {
  actionText,
  actorText,
  COMMON_STATUS_TEXT,
  dictText,
  MODEL_TIER_TEXT,
  MODEL_WINDOW_TEXT,
  payloadText,
  RULE_RESULT_TEXT,
  shortId,
} from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { Icon } from "@workloom/ui";

interface ThreadRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

interface LedgerEvent {
  event_id: string;
  who?: { type?: string; id?: string; version?: string };
  context?: { time?: string };
  decision?: { action?: string; after?: unknown };
  rule_impact?: Array<{ rule_id?: string; version?: string; result?: string }>;
  receipt?: { synced?: boolean };
  model_trace?: { model_id?: string; tier?: string; window?: string; credits?: number };
}

interface EventWithThread extends LedgerEvent {
  thread: ThreadRow;
}

const MODEL_NAME_TEXT: Record<string, string> = {
  mock: "演示模型",
  "mock-llm": "演示模型",
  "human-operator": "人工处理",
  "human-chairman": "老板人工决策",
};

function modelName(value: string | undefined): string {
  if (!value) return "未记录模型";
  return MODEL_NAME_TEXT[value] ?? "模型来源已记录";
}

function formatTime(value: string | undefined): string {
  if (!value) return "时间待确认";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间待确认"
    : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function Observability({ view }: { view: "events" | "models" }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [events, setEvents] = useState<EventWithThread[]>([]);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const threads = ((await trpc.threads.list.query()) as ThreadRow[]).slice(0, 12);
      const batches = await Promise.all(threads.map(async (thread) => {
        const rows = (await trpc.threads.events.query({ threadId: thread.id, limit: 40 })) as LedgerEvent[];
        return rows.map((event) => ({ ...event, thread }));
      }));
      setEvents(batches.flat().sort((a, b) =>
        new Date(b.context?.time ?? 0).getTime() - new Date(a.context?.time ?? 0).getTime(),
      ));
      setError(false);
    } catch (cause) {
      console.warn("读取可观测数据失败", cause);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const modelEvents = useMemo(() => events.filter((event) => event.model_trace), [events]);
  const visibleEvents = useMemo(() => {
    if (view === "models") return modelEvents.slice(0, 80);
    const key = query.trim().toLowerCase();
    if (!key) return events.slice(0, 120);
    return events.filter((event) => [
      event.thread.title,
      actionText(event.decision?.action ?? ""),
      actorText(event.who?.id ?? "system"),
      event.event_id,
    ].some((text) => text.toLowerCase().includes(key))).slice(0, 120);
  }, [events, modelEvents, query, view]);

  const totalCredits = modelEvents.reduce((sum, event) => sum + (event.model_trace?.credits ?? 0), 0);
  const modelCount = new Set(modelEvents.map((event) => event.model_trace?.model_id).filter(Boolean)).size;
  const right = (
    <div className="space-y-3">
      <div className="text-body font-bold text-holo">当前可见范围</div>
      <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
        只汇总当前公司最近 12 个任务的事件；数据范围与权限隔离由服务端统一控制。
      </div>
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="text-body text-ink3">已读取事件</div>
        <div className="mt-1 font-orb text-h2 text-ink">{events.length}</div>
      </div>
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="text-body text-ink3">模型调用 / 积分</div>
        <div className="mt-1 font-orb text-h2 text-ink">{modelEvents.length} / {totalCredits}</div>
      </div>
    </div>
  );

  const left = (
    <div className="space-y-3">
      <div className="text-body font-bold text-holo">查看与筛选</div>
      {view === "events" ? (
        <label className="block text-body text-ink2">
          搜索任务、动作或事件编号
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            className="mt-1.5 w-full rounded-lg border border-line bg-bg950 px-2.5 py-2 text-body outline-none focus:border-gline"
            placeholder="输入关键词" />
        </label>
      ) : (
        <div className="space-y-2 text-body text-ink2">
          <div className="rounded-lg border border-line bg-card p-3">已观察到 {modelCount} 个模型来源</div>
          <div className="rounded-lg border border-line bg-card p-3">路由证据来自事件账本中的模型调用记录</div>
        </div>
      )}
      <button type="button" onClick={() => void load()}
        className="w-full rounded-lg border border-gline px-3 py-2 text-body text-gold hover:bg-card">
        重新读取
      </button>
    </div>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-h1 font-black tracking-wider">{view === "events" ? "事件账本" : "模型与成本"}</h1>
            <p className="mt-1 text-body leading-relaxed text-ink3">
              {view === "events"
                ? "按时间查看谁执行了什么、安全规则如何判定、结果是否已同步。"
                : "查看实际模型选择、能力档位、调用时段与积分证据。"}
            </p>
          </div>
          {view === "models" && (
            <button type="button" onClick={() => navigate("/onboarding")}
              className="rounded-lg border border-gline px-3 py-2 text-body font-semibold text-gold hover:bg-card">
              配置模型服务
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-alert/50 bg-alert/8 p-3 text-body text-alert">
            <span className="min-w-0 flex-1">暂时无法读取数据，已保留当前页面。</span>
            <button type="button" onClick={() => void load()} className="rounded border border-alert/60 px-2 py-1">重试</button>
          </div>
        )}

        {loading ? (
          <div className="space-y-3"><Skeleton count={3} label="运行指标正在加载" /><Skeleton count={3} label="告警数据正在加载" /><Skeleton count={3} label="事件数据正在加载" /></div>
        ) : visibleEvents.length === 0 ? (
          <EmptyState
            icon={<Icon name={view === "events" ? "ledger" : "model"} size={24} />}
            title={view === "events" ? "暂无可见事件" : "暂无模型调用记录"}
            hint={view === "events" ? "运行一条任务后，执行证据会出现在这里。" : "先配置模型并执行任务，路由证据会写入事件账本。"}
            actionLabel={view === "models" ? "去配置模型" : "前往任务工作台"}
            onAction={() => navigate(view === "models" ? "/onboarding" : "/tasks")}
          />
        ) : (
          <div className="space-y-2.5">
            {visibleEvents.map((event, index) => {
              const action = actionText(event.decision?.action ?? "unknown");
              const trace = event.model_trace;
              return (
                <article key={`${event.event_id}-${index}`} className="min-w-0 rounded-xl border border-line bg-card p-3.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{view === "models" ? modelName(trace?.model_id) : action}</span>
                    <span className="rounded border border-line px-1.5 py-0.5 text-body text-ink3">{formatTime(event.context?.time)}</span>
                    {view === "events" && (
                      <span className={event.receipt?.synced ? "text-body text-go" : "text-body text-warn"}>
                        {event.receipt?.synced ? "已同步" : "待核实"}
                      </span>
                    )}
                    <button type="button" onClick={() => navigate(`/tasks/${encodeURIComponent(event.thread.id)}`)}
                      className="ml-auto max-w-full truncate text-body text-holo underline" title={event.thread.title}>
                      {event.thread.title}
                    </button>
                  </div>
                  {view === "events" ? (
                    <>
                      <div className="mt-1.5 text-body text-ink2">
                        {actorText(event.who?.id ?? "system")} · 事件 {shortId(event.event_id)}
                      </div>
                      {payloadText(event.decision?.after) && (
                        <div className="mt-2 break-words rounded-lg bg-bg800/70 px-2.5 py-2 text-body leading-relaxed text-ink2">
                          {payloadText(event.decision?.after, 260)}
                        </div>
                      )}
                      {(event.rule_impact?.length ?? 0) > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {event.rule_impact!.map((rule, ruleIndex) => (
                            <span key={`${rule.rule_id}-${ruleIndex}`} className="rounded-full border border-line px-2 py-0.5 text-body text-ink3">
                              {rule.rule_id ? `规则 ${shortId(rule.rule_id)}` : "规则"} · {dictText(RULE_RESULT_TEXT, rule.result)}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="mt-2 grid grid-cols-2 gap-2 text-body sm:grid-cols-4">
                      <div><span className="text-ink3">能力档位</span><div className="mt-0.5 text-ink2">{dictText(MODEL_TIER_TEXT, trace?.tier)}</div></div>
                      <div><span className="text-ink3">调用时段</span><div className="mt-0.5 text-ink2">{dictText(MODEL_WINDOW_TEXT, trace?.window)}</div></div>
                      <div><span className="text-ink3">积分消耗</span><div className="mt-0.5 text-ink2">{trace?.credits ?? 0}</div></div>
                      <div><span className="text-ink3">执行动作</span><div className="mt-0.5 text-ink2">{action}</div></div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </Bridge>
  );
}
