/**
 * P2 任务页·主线执行（F4：Quest 会话页；PRD P2-①②③ 逐条对账）
 *  - 行动消息流（P2E2）= 该线程事件流子序列投影（P2-⑤：ts 升序；回执三态/命中规则/计量逐事件渲染）
 *  - 失败步红框 + 转人工/降级重试/回滚三入口（E3.1）；无回执标「未核实」不宣称完成（L3.6/E3.7）
 *  - ThreadInspector 右栏：进度 x/y · 参与成员 · 计量（档/窗口/积分/降级链）· 围栏判定，≤5s 轮询（F3.4）；
 *    断线显「连接中断·重连中」不伪造进度
 *  - 审批卡内联（ApprovalCardMsg 语义：diff + 命中规则版本 + 三手势 → approvals.decide 写回）
 *  - 完成后态 p2_done：交付卡 + 决策链路时间轴；无对外变更明示「仅只读分析」（E3.7）
 *  - 权限态：只读成员不显示输入栏（E2.6，隐藏非置灰）
 * 状态变体：p2 执行中 / p2_review 待审查 / p2_done 已完成 / p2_error 错误（?demo= 强制走查）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { COMMON_STATUS_TEXT, THREAD_MODE_TEXT, actionText, dictText, shortId } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import {
  AgentActionMessage,
  BannerAlert,
  DispatchBar,
  EmptyState,
  HumanBubble,
  SkeletonBlock,
  SubCallMessage,
  SystemDivider,
  TriGestureBar,
  XpBar,
  type ReceiptState,
} from "../../components/hud";

interface ThreadRow {
  id: string; title: string; mode: string; status: string;
  progress_done: number; progress_total: number; agent_id: string | null;
  created_by: string; created_at: string;
}
interface Ev {
  event_id: string;
  who: { type: "human" | "agent" | "system"; id: string; version?: string };
  context: { time: string };
  object: { type: string; id?: string };
  decision: { action: string; before?: unknown; after?: unknown; basis?: string[] };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  receipt?: { synced?: boolean; snapshot_uri?: string };
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  links?: string[];
}
interface ApprovalRow {
  approval_id: string; event_id: string; status: string;
  snapshot: { summary?: string; before?: unknown; after?: unknown; rule_version?: string };
}

/** 回执三态映射（L3.6/E3.7：无回执=未核实，不得宣称完成） */
function receiptOf(ev: Ev): ReceiptState {
  if (ev.rule_impact?.some((r) => r.result === "blocked")) return "failed";
  if (ev.receipt?.synced) return "synced";
  return "unverified";
}

/** 写类动作前缀（完成后态「仅只读分析」判定；与网关同源口径） */
const WRITE_PREFIX = ["render.submit", "publish.post", "comment.reply", "script.update", "trigger."];

export default function P2() {
  const { threadId = "" } = useParams();
  const [params] = useSearchParams();
  const demo = params.get("demo");

  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false); // 断线重连中（F3.4 不伪造进度）
  const [role, setRole] = useState<string>("owner");
  const [thread, setThread] = useState<ThreadRow | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [composer, setComposer] = useState("");
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [meR, th, list, ap] = await Promise.all([
        trpc.members.me.query() as Promise<{ identity: { role: string } }>,
        trpc.threads.get.query({ threadId }) as Promise<ThreadRow | null>,
        trpc.threads.list.query() as Promise<ThreadRow[]>,
        trpc.approvals.list.query() as Promise<ApprovalRow[]>,
      ]);
      setRole(meR.identity.role);
      setThread(th);
      setThreads(list);
      if (th) {
        const ev = (await trpc.threads.events.query({ threadId })) as Ev[];
        setEvents(ev);
        // 本线程相关审批（event_id ∈ 线程事件链）
        const ids = new Set(ev.map((e) => e.event_id));
        setApprovals(ap.filter((a) => ids.has(a.event_id)));
      }
      setOffline(false);
    } catch {
      setOffline(true); // 断线：显「重连中」，保留最后已知进度（不伪造）
    } finally {
      setReady(true);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000); // F3.4 ≤5s 轮询
    return () => clearInterval(t);
  }, [load]);

  /* ---------- 计量与围栏聚合（ThreadInspector） ---------- */
  const meter = useMemo(() => {
    const traces = events.map((e) => e.model_trace).filter(Boolean) as NonNullable<Ev["model_trace"]>[];
    const credits = traces.reduce((s, t) => s + (t.credits ?? 0), 0);
    const impacts = events.flatMap((e) => e.rule_impact ?? []);
    return {
      credits,
      tiers: [...new Set(traces.map((t) => t.tier ?? "standard"))],
      window: traces[traces.length - 1]?.window ?? "—",
      pass: impacts.filter((i) => i.result === "pass").length,
      review: impacts.filter((i) => i.result === "review").length,
      blocked: impacts.filter((i) => i.result === "blocked").length,
    };
  }, [events]);

  const hasWrite = events.some((e) => WRITE_PREFIX.some((p) => e.decision.action.startsWith(p)));
  const isDone = thread?.status === "completed";
  const isFailed = demo === "p2_error" || thread?.status === "failed";
  const readonly = role === "readonly";

  /* ---------- 手势写回（approvals.decide；驳回原因弹窗在 P4 落地完整枚举，此处驳回走默认原因） ---------- */
  const gesture = useCallback(async (approvalId: string, g: "approve" | "edit" | "reject") => {
    if (g === "reject") {
      const reason = window.prompt("驳回原因（必填 ≤200 字，L5.2）") ?? "";
      if (!reason.trim()) { setBanner({ level: "warn", text: "驳回必须填写原因（L5.2），本次未提交" }); return; }
      await trpc.approvals.decide.mutate({ approvalId, gesture: "reject", reasonText: reason.slice(0, 200) });
    } else {
      await trpc.approvals.decide.mutate({ approvalId, gesture: g });
    }
    setBanner({ level: "info", text: "审批已写回事件库并回流偏好记忆（F5.5/F1.7）" });
    await load();
  }, [load]);

  /* ---------- 追问（P2E6：沿用线程上下文；threads.run 续跑，replay 幂等 H-5） ---------- */
  const followUp = useCallback(async () => {
    if (!composer.trim() || !thread) return;
    setBanner({ level: "info", text: "追问已沿本线程上下文入列（F3.6），执行中…" });
    setComposer("");
    try {
      await trpc.threads.run.mutate({ threadId: thread.id, goal: composer, presetKey: thread.agent_id ?? "director" });
    } finally {
      await load();
    }
  }, [composer, thread, load]);

  /* ---------- 左栏：会话列表（P2E1 状态点浏览，单击切换） ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">会话 · THREADS</div>
      {threads.map((t) => (
        <a
          key={t.id}
          href={`/p2/${t.id}`}
          className={`mb-1.5 block rounded-lg border px-3 py-2.5 no-underline ${
            t.id === threadId ? "border-gline bg-gold/6" : "border-line bg-card hover:border-gline"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-ink3">{t.id}</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                t.status === "running" ? "bg-holo animate-pulse-hud"
                : t.status === "pending_review" ? "bg-warn animate-pulse-warn"
                : t.status === "completed" ? "bg-go"
                : t.status === "failed" ? "bg-alert" : "bg-ink3"
              }`} />
              {t.progress_done}/{t.progress_total}
            </span>
          </div>
          <div className="mt-1 text-body text-ink2">{t.title}</div>
        </a>
      ))}
    </>
  );

  /* ---------- 右栏：ThreadInspector（P2E5 只读；成员点击 → P8 后续卡） ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">线程信息 · INSPECTOR</div>
      {thread && (
        <div className="space-y-3">
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-caption font-bold text-holo">进度（≤5s 轮询 F3.4）</div>
            <XpBar done={thread.progress_done} total={thread.progress_total} />
            <div className="mt-1.5 text-micro text-ink3">
              {offline ? "连接中断 · 重连中（保留最后已知进度）" : `状态 ${dictText(COMMON_STATUS_TEXT, thread.status)} · 预计剩余 —`}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-caption font-bold text-holo">计量（model_trace 投影 L6.3）</div>
            <div className="font-orb text-h2 font-bold text-ink">{meter.credits} <span className="text-caption text-ink3">积分</span></div>
            <div className="mt-0.5 font-mono text-micro text-ink3">
              档 {meter.tiers.join("/")} · 窗口 {meter.window}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-caption font-bold text-holo">围栏判定（rule_impact 渲染）</div>
            <div className="flex gap-2.5 font-mono text-caption">
              <span className="text-go">放行 {meter.pass}</span>
              <span className="text-warn">复核 {meter.review}</span>
              <span className="text-alert">阻断 {meter.blocked}</span>
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-caption font-bold text-holo">参与成员</div>
            <div className="text-body text-ink2">{thread.agent_id ?? "值班 Agent"}</div>
            <div className="mt-0.5 font-mono text-micro text-ink3">发起 {thread.created_by}</div>
          </div>
        </div>
      )}
    </>
  );

  /* ---------- 中栏：行动消息流 ---------- */
  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        {/* ThreadHeader（P2-④：mode/路由置信度可见） */}
        <div className="mb-3 flex items-center gap-2.5">
          <h2 className="text-h1 font-black tracking-wider">任务执行</h2>
          <span className="text-[11px] tracking-[.2em] text-ink3">P2 · QUEST</span>
          {thread && (
            <>
              <span className="rounded border border-gold/60 bg-gold/10 px-1.5 py-0.5 text-micro font-black text-gold">
                {dictText(THREAD_MODE_TEXT, thread.mode)}
              </span>
              <span className="font-mono text-micro text-ink3">{thread.id}</span>
              <span className="text-body text-ink2">{thread.title}</span>
              <span className="flex-1" />
              {thread.status !== "completed" && thread.status !== "failed" && (
                <button
                  type="button"
                  onClick={() => void trpc.threads.run.mutate({ threadId: thread.id, goal: thread.title, presetKey: thread.agent_id ?? "director" }).then(load)}
                  className="cursor-pointer rounded-md border border-gline bg-gold/8 px-3 py-1 text-caption font-bold text-gold hover:bg-gold/15"
                >
                  ▶ 执行/续跑（replay 幂等 H-5）
                </button>
              )}
            </>
          )}
        </div>

        {offline && (
          <div className="mb-3"><BannerAlert level="warn">连接中断 · 重连中（F3.4：不伪造进度，显示最后已知状态）</BannerAlert></div>
        )}
        {banner && (
          <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>
        )}

        {/* p2_error：探针失效停止一切点击 + 三入口（E3.1/L3.3） */}
        {isFailed && (
          <div className="mb-3 rounded-lg border border-alert/55 bg-alert/8 p-3.5">
            <div className="mb-2 text-body font-bold text-alert">⛔ 渠道适配探针失效 · 已停止一切点击（E3.1/L3.3）</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setBanner({ level: "info", text: "已转需介入：人工接管通道开启（E1 联调卡接强制隔离）" })}
                className="cursor-pointer rounded-md border border-alert/60 bg-alert/10 px-3 py-1.5 text-caption font-bold text-alert">转人工</button>
              <button type="button" onClick={() => thread && void trpc.threads.run.mutate({ threadId: thread.id, goal: thread.title, presetKey: thread.agent_id ?? "director" }).then(load)}
                className="cursor-pointer rounded-md border border-warn/50 bg-warn/10 px-3 py-1.5 text-caption font-bold text-warn">降级重试</button>
              <button type="button" onClick={() => setBanner({ level: "info", text: "回滚=逆向补偿事件序列（F1.6 append-only），E1 联调卡接线" })}
                className="cursor-pointer rounded-md border border-holo/40 bg-holo/8 px-3 py-1.5 text-caption font-bold text-holo">回滚</button>
            </div>
          </div>
        )}

        <div className="flex-1 space-y-3">
          {!ready ? (
            <><SkeletonBlock lines={2} h={44} /><SkeletonBlock lines={4} /></>
          ) : !thread ? (
            <EmptyState icon="🧭" title="线程不存在或已越权清空" hint="从左侧会话列表选择一条任务线程" />
          ) : events.length === 0 ? (
            <EmptyState icon="🌌" title="还没有会话内容" hint="@ 一位 Agent 或说出第一句话（F3.1）" />
          ) : (
            <>
              <SystemDivider time={new Date(thread.created_at).toTimeString().slice(0, 5)} summary={`线程 ${thread.id} 建立（派遣事件已落库）`} />
              {events.map((ev) => {
                if (ev.who.type === "human") {
                  // 人类消息文案化（§9.1 副官语气；动作码不直接上屏）
                  const after = ev.decision.after as { title?: string; gesture?: string } | undefined;
                  const text = ev.decision.action === "thread.dispatch"
                    ? (after?.title ?? thread.title)
                    : ev.decision.action === "approval.gesture"
                      ? `待我审批：${after?.gesture ?? "已处理"}`
                      : actionText(ev.decision.action);
                  return <HumanBubble key={ev.event_id} time={new Date(ev.context.time).toTimeString().slice(0, 5)}>{text}</HumanBubble>;
                }
                if (ev.links && ev.links.length > 0 && ev.who.type === "agent" && ev.decision.action.includes("subcall")) {
                  return (
                    <SubCallMessage key={ev.event_id} target={ev.object.id ?? ev.object.type} version={ev.who.version ?? ""} receipt={receiptOf(ev)}>
                      {actionText(ev.decision.action)}
                    </SubCallMessage>
                  );
                }
                if (ev.decision.action === "ask.answer") {
                  // ask 问询应答（B8）：正文上屏（§9.1 动作码不直接上屏同口径）
                  const ans = (ev.decision.after as { text?: string } | undefined)?.text ?? "";
                  return (
                    <AgentActionMessage
                      key={ev.event_id}
                      sender={ev.who.id}
                      version={ev.who.version ?? ""}
                      action="创作参谋·应答"
                      eventId={ev.event_id}
                      receipt={receiptOf(ev)}
                      credits={ev.model_trace?.credits}
                    >
                      {ans}
                    </AgentActionMessage>
                  );
                }
                return (
                  <AgentActionMessage
                    key={ev.event_id}
                    sender={ev.who.id}
                    version={ev.who.version ?? ""}
                    action={actionText(ev.decision.action)}
                    eventId={ev.event_id}
                    receipt={receiptOf(ev)}
                    rules={(ev.rule_impact ?? []).map((r) => `${r.rule_id} ${r.version}`)}
                    credits={ev.model_trace?.credits}
                  >
                    {typeof ev.decision.after === "object" && ev.decision.after !== null
                      ? JSON.stringify(ev.decision.after).slice(0, 160)
                      : String(ev.decision.after ?? "")}
                  </AgentActionMessage>
                );
              })}

              {/* 内联审批卡（ApprovalCardMsg 语义：diff + 命中规则版本 + 三手势/已决态） */}
              {approvals.map((a) => (
                <div key={a.approval_id} className={`rounded-msg border p-4 ${a.status === "pending" ? "border-warn/40 bg-warn/4" : "border-line bg-card"}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className={`text-h2 font-bold ${a.status === "pending" ? "text-warn" : "text-ink2"}`}>
                      ◆ 待我审批 · {a.status === "pending" ? "待审查" : a.status === "approved" ? "已采纳" : a.status === "edited" ? "编辑后采纳" : a.status === "rejected" ? "已驳回" : "已过期"}
                    </span>
                    <span className="font-mono text-micro text-ink3">{shortId(a.approval_id)}</span>
                    {a.snapshot.rule_version && <span className="font-mono text-micro text-holo">命中 {a.snapshot.rule_version}</span>}
                  </div>
                  {(a.snapshot.before !== undefined || a.snapshot.after !== undefined) && (
                    <div className="mb-3 grid grid-cols-2 gap-2 font-mono text-caption">
                      <div className="rounded border border-line bg-bg800/60 p-2 text-ink3">前：{JSON.stringify(a.snapshot.before)}</div>
                      <div className="rounded border border-holo/30 bg-holo/5 p-2 text-holo">后：{JSON.stringify(a.snapshot.after)}</div>
                    </div>
                  )}
                  {a.status === "pending" ? (
                    <TriGestureBar canApprove={!readonly} onGesture={(g) => void gesture(a.approval_id, g)} />
                  ) : (
                    <div className="text-caption text-ink3">手势已写回事件库并回流偏好记忆（F5.5/F1.7，幂等 L5.3）</div>
                  )}
                </div>
              ))}

              {/* 完成后态 p2_done：交付卡 + 决策链路时间轴；无对外变更明示「仅只读分析」（E3.7） */}
              {isDone && (
                <div className="rounded-msg border border-go/40 bg-go/5 p-4">
                  <div className="mb-1.5 text-h2 font-black text-go">✓ 交付完成 · 变更报告</div>
                  {!hasWrite && <div className="mb-1.5 text-caption text-warn">⚠ 本线程无对外变更 · 仅只读分析（E3.7）</div>}
                  <div className="text-caption text-ink2">决策链路时间轴（{events.length} 个事件，点击 #E 编号展开）：</div>
                  <div className="mt-1.5 space-y-1">
                    {events.map((ev) => (
                      <div key={ev.event_id} className="flex items-center gap-2 font-mono text-micro text-ink3">
                        <span className="text-holo">#{ev.event_id}</span>
                        <span>{ev.who.id} · {actionText(ev.decision.action)}</span>
                        <span className={receiptOf(ev) === "synced" ? "text-go" : receiptOf(ev) === "failed" ? "text-alert" : "text-warn"}>
                          {receiptOf(ev) === "synced" ? "✓" : receiptOf(ev) === "failed" ? "✗" : "⚠"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* P2E6 线程内追问（只读成员不显示输入栏 E2.6；沿用线程上下文 F3.6） */}
        {!readonly && thread && (
          <div className="mt-4">
            <DispatchBar
              state={composer ? "typing" : "empty"}
              value={composer}
              chips={["本线程上下文", thread.id]}
              onChange={setComposer}
              onSubmit={() => void followUp()}
            />
          </div>
        )}
      </div>
    </Bridge>
  );
}
