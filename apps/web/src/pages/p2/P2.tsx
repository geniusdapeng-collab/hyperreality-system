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
import { COMMON_STATUS_TEXT, MODEL_TIER_TEXT, MODEL_WINDOW_TEXT, RULE_RESULT_TEXT, THREAD_MODE_TEXT, actionText, actorText, approvalGestureText, dictText, payloadText, shortId } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import { RejectDialog } from "../../components/RejectDialog";
import {
  AgentActionMessage,
  BannerAlert,
  DispatchBar,
  EmptyState,
  HumanBubble,
  Skeleton,
  SubCallMessage,
  SystemDivider,
  TriGestureBar,
  XpBar,
  type ReceiptState,
} from "../../components/hud";
import { Icon, clientChineseText } from "@workloom/ui";
import { clientNaturalText } from "../../lib/clientText";

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
  decision: { action: string; effect?: "read" | "write"; before?: unknown; after?: unknown; basis?: string[]; kind?: string; outcome?: string };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  /** GR-15/N-16：receipt.mode 区分「模拟回执」与「真实连接器回执」（假回执不得外观同真回执） */
  receipt?: { synced?: boolean; snapshot_uri?: string; mode?: "simulated" | "real" };
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  links?: string[];
}
interface ApprovalRow {
  approval_id: string; event_id: string; status: string;
  snapshot: {
    summary?: string; before?: unknown; after?: unknown; rule_version?: string;
    /** GR-07：确定性兜底计划参数不完整 → 审批卡黄色警示条 */
    warning?: string;
    params_incomplete?: boolean;
    /** GR-01：审批绑定的步骤指纹（replay 比对，防漂移消费） */
    step_fingerprint?: string;
    tool?: string;
  };
}

/** 回执三态映射（L3.6/E3.7：无回执=未核实，不得宣称完成） */
function receiptOf(ev: Ev): ReceiptState {
  if (ev.rule_impact?.some((r) => r.result === "blocked")) return "failed";
  if (ev.receipt?.synced) return "synced";
  return "unverified";
}

export default function P2() {
  const { canAction } = useNavigationAccess();
  const { threadId = "" } = useParams();
  const [params] = useSearchParams();
  const demo = params.get("demo");
  /** X-02：来自对话框卡片的审批锚点（?apr=）——高亮并滚动到该审批卡 */
  const anchorApprovalId = params.get("apr");

  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false); // 断线重连中（F3.4 不伪造进度）
  const [thread, setThread] = useState<ThreadRow | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [composer, setComposer] = useState("");
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [th, list, ap] = await Promise.all([
        trpc.threads.get.query({ threadId }) as Promise<ThreadRow | null>,
        trpc.threads.list.query() as Promise<ThreadRow[]>,
        trpc.approvals.list.query() as Promise<ApprovalRow[]>,
      ]);
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

  const hasWrite = events.some((e) => e.decision.effect === "write" && e.receipt?.synced === true);
  const isDone = thread?.status === "completed";
  const isFailed = demo === "p2_error" || thread?.status === "failed";
  const canApprove = canAction("approval.decide");
  const canDispatch = canAction("task.dispatch");

  /* ---------- 手势写回（approvals.decide；驳回原因弹窗在 P4 落地完整枚举，此处驳回走默认原因） ---------- */
  const gesture = useCallback(async (approvalId: string, g: "approve" | "edit" | "reject") => {
    if (g === "reject") {
      // M1.2（D24）：驳回必须选择行业受控枚举（弹窗），自由文本只做补充
      setRejectTarget(approvalId);
      return;
    }
    await trpc.approvals.decide.mutate({ approvalId, gesture: g });
    setBanner({ level: "info", text: "审批结果已写入事件账本，并用于校准协作偏好。" });
    await load();
  }, [load]);

  /** 驳回弹窗提交（M1.2 受控枚举 + L5.2 留痕） */
  const submitReject = useCallback(async (r: { reasonEnum: string; reasonText?: string }) => {
    if (!rejectTarget) return;
    await trpc.approvals.decide.mutate({
      approvalId: rejectTarget,
      gesture: "reject",
      reasonEnum: r.reasonEnum,
      reasonText: r.reasonText,
    });
    setRejectTarget(null);
    setBanner({ level: "info", text: "已驳回并记录原因，后续会用于校准协作偏好。" });
    await load();
  }, [rejectTarget, load]);

  /* ---------- 追问（P2E6：沿用线程上下文；threads.run 续跑，replay 幂等 H-5） ---------- */
  const followUp = useCallback(async () => {
    if (!composer.trim() || !thread) return;
    setBanner({ level: "info", text: "追问已沿用当前任务上下文并进入队列，正在执行…" });
    setComposer("");
    try {
      await trpc.threads.run.mutate({ threadId: thread.id, goal: composer, ...(thread.agent_id ? { presetKey: thread.agent_id } : {}) });
    } finally {
      await load();
    }
  }, [composer, thread, load]);

  /* ---------- 左栏：会话列表（P2E1 状态点浏览，单击切换） ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">任务会话</div>
      {threads.map((t) => (
        <a
          key={t.id}
          href={`/tasks/${t.id}`}
          className={`mb-1.5 block rounded-lg border px-3 py-2.5 no-underline ${
            t.id === threadId ? "border-gline bg-gold/6" : "border-line bg-card hover:border-gline"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-body text-ink3">{shortId(t.id)}</span>
            <span className="inline-flex items-center gap-1.5 text-body text-ink2">
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
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">任务信息</div>
      {thread && (
        <div className="space-y-3">
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">实时进度（约每 5 秒更新）</div>
            <XpBar done={thread.progress_done} total={thread.progress_total} />
            <div className="mt-1.5 text-body text-ink3">
              {offline ? "连接中断 · 重连中（保留最后已知进度）" : `状态 ${dictText(COMMON_STATUS_TEXT, thread.status)} · 预计剩余 —`}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">模型调用计量</div>
            <div className="font-orb text-h2 font-bold text-ink">{meter.credits} <span className="text-body text-ink3">积分</span></div>
            <div className="mt-0.5 text-body text-ink3">
              {meter.tiers.map((tier) => dictText(MODEL_TIER_TEXT, tier)).join(" / ")} · {dictText(MODEL_WINDOW_TEXT, meter.window)}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">安全规则判定</div>
            <div className="flex gap-2.5 font-mono text-body">
              <span className="text-go">放行 {meter.pass}</span>
              <span className="text-warn">复核 {meter.review}</span>
              <span className="text-alert">阻断 {meter.blocked}</span>
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">参与成员</div>
            <div className="text-body text-ink2">{actorText(thread.agent_id ?? "system")}</div>
            <div className="mt-0.5 text-body text-ink3">发起人 {actorText(thread.created_by)}</div>
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
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <h2 className="text-h1 font-black tracking-wider">任务执行</h2>
          {thread && (
            <>
              <span className="rounded border border-gold/60 bg-gold/10 px-1.5 py-0.5 text-body font-black text-gold">
                {dictText(THREAD_MODE_TEXT, thread.mode)}
              </span>
              <span className="font-mono text-body text-ink3">{shortId(thread.id)}</span>
              <span className="text-body text-ink2">{thread.title}</span>
              <span className="flex-1" />
              {canDispatch && thread.status !== "completed" && thread.status !== "failed" && (
                <button
                  type="button"
                  onClick={() => void trpc.threads.run.mutate({ threadId: thread.id, goal: thread.title, ...(thread.agent_id ? { presetKey: thread.agent_id } : {}) }).then(load)}
                  className="cursor-pointer rounded-md border border-gline bg-gold/8 px-3 py-1 text-body font-bold text-gold hover:bg-gold/15"
                >
                  <Icon name="play" size={14} className="inline" /> 执行或从中断处继续
                </button>
              )}
            </>
          )}
        </div>

        {offline && (
          <div className="mb-3"><BannerAlert level="warn">连接中断，正在重连；当前显示最后一次成功获取的进度，不会把旧数据当作最新结果。</BannerAlert></div>
        )}
        {banner && (
          <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>
        )}

        {/* p2_error：探针失效停止一切点击 + 三入口（E3.1/L3.3） */}
        {isFailed && (
          <div className="mb-3 rounded-lg border border-alert/55 bg-alert/8 p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-body font-bold text-alert"><Icon name="brake" size={15} />渠道连接检查失败 · 已暂停所有外部操作</div>
            {canDispatch && <div className="wl-action-row flex flex-wrap gap-2">
              <button type="button" onClick={() => setBanner({ level: "info", text: "已标记为需要人工介入，并开启人工接管通道。" })}
                className="cursor-pointer rounded-md border border-alert/60 bg-alert/10 px-3 py-1.5 text-body font-bold text-alert">转人工</button>
              <button type="button" onClick={() => thread && void trpc.threads.run.mutate({ threadId: thread.id, goal: thread.title, ...(thread.agent_id ? { presetKey: thread.agent_id } : {}) }).then(load)}
                className="cursor-pointer rounded-md border border-warn/50 bg-warn/10 px-3 py-1.5 text-body font-bold text-warn">降级重试</button>
              <button type="button" onClick={() => setBanner({ level: "info", text: "回滚会生成一组反向补偿事件，原始账本记录不会被覆盖。" })}
                className="cursor-pointer rounded-md border border-holo/40 bg-holo/8 px-3 py-1.5 text-body font-bold text-holo">回滚</button>
            </div>}
          </div>
        )}

        <div className="flex-1 space-y-3">
          {!ready ? (
            <><Skeleton count={2} height={44} label="会话摘要正在加载" /><Skeleton count={4} label="会话内容正在加载" /></>
          ) : !thread ? (
            <EmptyState icon={<Icon name="tasks" size={24} />} title="这个任务不存在，或已被清理" hint="从左侧会话列表选择一条任务线程" />
          ) : events.length === 0 ? (
            <EmptyState icon={<Icon name="chat" size={24} />} title="还没有会话内容" hint="选择一位数字员工或说出第一句话" />
          ) : (
            <>
              <SystemDivider time={new Date(thread.created_at).toTimeString().slice(0, 5)} summary={`任务会话 ${shortId(thread.id)} 已建立，派遣事件已写入账本`} />
              {events.map((ev) => {
                if (ev.who.type === "human") {
                  // 人类消息文案化（§9.1 副官语气；动作码不直接上屏）
                  const after = ev.decision.after as { title?: string; gesture?: string } | undefined;
                  const text = ev.decision.action === "thread.dispatch"
                    ? (after?.title ?? thread.title)
                    : ev.decision.action === "approval.gesture"
                      ? `待我审批：${approvalGestureText(after?.gesture)}`
                      : actionText(ev.decision.action);
                  return <HumanBubble key={ev.event_id} time={new Date(ev.context.time).toTimeString().slice(0, 5)}>{text}</HumanBubble>;
                }
                if (ev.links && ev.links.length > 0 && ev.who.type === "agent" && ev.decision.action.includes("subcall")) {
                  return (
                    <SubCallMessage key={ev.event_id} target="协作数字员工" version={ev.who.version ?? ""} receipt={receiptOf(ev)}>
                      {actionText(ev.decision.action)}
                    </SubCallMessage>
                  );
                }
                if (ev.decision.action === "ask.answer") {
                  // ask 问询应答（B8）：正文上屏（§9.1 动作码不直接上屏同口径）
                  const ans = clientNaturalText(
                    (ev.decision.after as { text?: string } | undefined)?.text,
                    "应答内容暂时无法显示，请稍后再试。",
                  );
                  return (
                    <AgentActionMessage
                      key={ev.event_id}
                      sender={actorText(ev.who.id)}
                      version={ev.who.version ?? ""}
                      action="经营参谋·应答"
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
                    sender={actorText(ev.who.id)}
                    version={ev.who.version ?? ""}
                    action={actionText(ev.decision.action)}
                    eventId={ev.event_id}
                    receipt={receiptOf(ev)}
                    rules={(ev.rule_impact ?? []).map((r) => `关联安全规则 · ${dictText(RULE_RESULT_TEXT, r.result)}`)}
                    credits={ev.model_trace?.credits}
                  >
                    {payloadText(ev.decision.after)}
                  </AgentActionMessage>
                );
              })}

              {/* 内联审批卡（ApprovalCardMsg 语义：diff + 命中规则版本 + 三手势/已决态） */}
              {approvals.map((a) => (
                <div
                  key={a.approval_id}
                  id={`apr-${a.approval_id}`}
                  ref={(el) => {
                    // X-02：从对话框「去审批」进入时，滚动并高亮对应审批卡
                    if (el && anchorApprovalId && a.approval_id === anchorApprovalId && a.status === "pending") {
                      requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "center" }));
                    }
                  }}
                  className={`rounded-msg border p-4 ${
                    anchorApprovalId && a.approval_id === anchorApprovalId && a.status === "pending"
                      ? "border-amber-400 bg-amber-500/10 ring-2 ring-amber-400/60"
                      : a.status === "pending" ? "border-warn/40 bg-warn/4" : "border-line bg-card"
                  }`}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 text-h2 font-bold ${a.status === "pending" ? "text-warn" : "text-ink2"}`}>
                      <Icon name="approval" size={15} />待我审批 · {a.status === "pending" ? "待审查" : a.status === "approved" ? "已采纳" : a.status === "edited" ? "编辑后采纳" : a.status === "rejected" ? "已驳回" : "已过期"}
                    </span>
                    <span className="font-mono text-body text-ink3">{shortId(a.approval_id)}</span>
                    {a.snapshot.rule_version && <span className="text-body text-holo">命中关联安全规则</span>}
                  </div>
                  {/* GR-07：兜底计划的参数不完整必须先说清楚，再让人决定放不放行（不盲批） */}
                  {(a.snapshot.warning || a.snapshot.params_incomplete) && (
                    <div className="mb-3 flex items-center gap-1 rounded border border-warn/50 bg-warn/10 p-2 text-body text-warn">
                      <Icon name="warning" size={13} label="提示" />
                      {a.snapshot.warning ?? "该步骤由确定性兜底计划生成，参数不完整，请人工补齐或驳回。"}
                    </div>
                  )}
                  {(a.snapshot.before !== undefined || a.snapshot.after !== undefined) && (
                    <div className="mb-3 grid grid-cols-1 gap-2 text-body sm:grid-cols-2">
                      <div className="rounded border border-line bg-bg800/60 p-2 text-ink3">调整前：{payloadText(a.snapshot.before, 220) || "暂无"}</div>
                      <div className="rounded border border-holo/30 bg-holo/5 p-2 text-holo">调整后：{payloadText(a.snapshot.after, 220) || "暂无"}</div>
                    </div>
                  )}
                  {a.status === "pending" ? (
                    <TriGestureBar canApprove={canApprove} onGesture={(g) => void gesture(a.approval_id, g)} />
                  ) : (
                    <div className="text-body text-ink3">审批动作已写入事件账本，并用于校准协作偏好；重复提交不会重复生效。</div>
                  )}
                </div>
              ))}

              {/* 完成后态 p2_done：交付卡 + 决策链路时间轴；无对外变更明示「仅只读分析」（E3.7） */}
              {isDone && (
                <div className="rounded-msg border border-go/40 bg-go/5 p-4">
                  <div className="mb-1.5 flex items-center gap-1.5 text-h2 font-black text-go"><Icon name="check" size={17} />交付完成 · 变更报告</div>
                  {/* N-16：模拟回执必须一眼可辨——"演示完成的交付"与"真实完成的交付"不得同外观 */}
                  {events.some((ev) => ev.decision?.kind === "execute" && ev.receipt?.mode === "simulated") && (
                    <div className="mb-1.5 inline-flex items-center gap-1 rounded border border-warn/50 bg-warn/10 px-2 py-0.5 text-body text-warn">
                      <Icon name="warning" size={13} />演示模式执行（模拟回执，非真实交付）
                    </div>
                  )}
                  {events.some((ev) => ev.decision?.kind === "execute" && ev.receipt?.mode === "real" && ev.receipt?.synced === true) && (
                    <div className="mb-1.5 inline-flex items-center gap-1 rounded border border-go/50 bg-go/10 px-2 py-0.5 text-body text-go">
                      <Icon name="check" size={13} />真实连接器回执（可核验）
                    </div>
                  )}
                  {!hasWrite && <div className="mb-1.5 flex items-center gap-1.5 text-body text-warn"><Icon name="warning" size={14} />本任务没有产生对外变更，仅完成了只读分析。</div>}
                  <div className="text-body text-ink2">决策链路时间轴（共 {events.length} 条账本事件）：</div>
                  <div className="mt-1.5 space-y-1">
                    {events.map((ev) => (
                      <div key={ev.event_id} className="flex items-center gap-2 font-mono text-body text-ink3">
                        <span className="text-holo">账本凭证 {shortId(ev.event_id)}</span>
                        <span>{actorText(ev.who.id)} · {actionText(ev.decision.action)}</span>
                        <span className={receiptOf(ev) === "synced" ? "text-go" : receiptOf(ev) === "failed" ? "text-alert" : "text-warn"}>
                          <Icon
                            name={receiptOf(ev) === "synced" ? "check" : receiptOf(ev) === "failed" ? "error" : "warning"}
                            label={receiptOf(ev) === "synced" ? "已生效" : receiptOf(ev) === "failed" ? "失败" : "未核实"}
                            size={13}
                          />
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
        {canDispatch && thread && (
          <div className="mt-4">
            <DispatchBar
              state={composer ? "typing" : "empty"}
              value={composer}
              chips={["沿用当前任务上下文"]}
              onChange={setComposer}
              onSubmit={() => void followUp()}
            />
          </div>
        )}
      </div>
      <RejectDialog
        open={rejectTarget !== null}
        mode="reject"
        onCancel={() => setRejectTarget(null)}
        onSubmit={(r) => void submitReject(r)}
      />
    </Bridge>
  );
}
