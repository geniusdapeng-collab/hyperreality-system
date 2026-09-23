/**
 * P9 夜班中心频道（F5：夜班班组群 · AI–AI 协作现场；PRD P9-①②③④ 逐条对账）
 *  - 班组消息流（P9E1）：夜班频道事件流按时间排列，每条带 #E 编号+回执位；
 *    越围栏项标「未生效·待审批」（L4.1 夜班动作 100% 过围栏，无例外通道）
 *  - 一键暂停（P9E2）：二次确认 → nightShift.pause（pauseAll，G5 端到端计时留痕；
 *    超时 P0 升级 E4.1）；暂停/恢复均留痕；断点挂起可续跑（E4.2）
 *  - 需介入卡（红框，L4.2 夜间不确定不执行）→ 一键派单（P9E3 接 inspection.dispatch，F9.3）
 *  - 群成员 7 Agent 在线列表（P9E4，夜班窗口内全员上线·青脉冲）；班组留言=五元事件留痕（P9E6）
 *  - 右栏：班组状态/峰谷计量/围栏快照（F2.6 可回溯当晚版本）/交接班预告（P9E5，08:30 → P3）
 * 状态变体：p9 运行中 / p9_paused 一键暂停后；权限态：只读成员隐藏输入栏与暂停按钮（E2.6/L3.4）
 * 轮询：夜班 5s（F3.4/D6）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { COMMON_STATUS_TEXT, OBJECT_TYPE_TEXT, RULE_RESULT_TEXT, actionText, actorText, dictText, latencyText, payloadText, shortId, versionText } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import {
  AgentActionMessage,
  BannerAlert,
  EmergencyBrake,
  EmptyState,
  HumanBubble,
  NightStatusPill,
  RadarAlertCard,
  SquadRing,
  SystemDivider,
  type NightPillState,
  type ReceiptState,
} from "../../components/hud";
import { AsyncState, Button, Icon, Overlay, clientChineseText } from "@workloom/ui";
import { operationFailure, toUiFailure } from "../../lib/ui-state";
import { useNavigationAccess } from "../../shell/NavigationAccess";

interface Ev {
  event_id: string;
  who: { type: "human" | "agent" | "system"; id: string; version?: string };
  context: { time: string };
  object: { type: string; id?: string };
  decision: { action: string; after?: unknown; basis?: string[] };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  receipt?: { synced?: boolean };
  model_trace?: { credits?: number; tier?: string; window?: string };
}
interface NightRun {
  id: string; status: string; runDate: string; fenceSnapshot: string | null;
  candidateCount: number; startedAt: string | null;
  stats: { done: number; pending: number; need_human: number; credits_used: number } | null;
}

function receiptOf(ev: Ev): ReceiptState {
  if (ev.rule_impact?.some((r) => ["block", "blocked", "deny"].includes(r.result))) return "failed";
  if (ev.receipt?.synced) return "synced";
  return "unverified";
}

export default function P9() {
  const { canAction } = useNavigationAccess();
  const navigate = useNavigate();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadMessage, setLoadMessage] = useState("");
  const [run, setRun] = useState<NightRun | null>(null);
  const [configured, setConfigured] = useState(false);
  const [events, setEvents] = useState<Ev[]>([]);
  const [agents, setAgents] = useState<Array<{ preset_key: string; name: string; version: string; status: string }>>([]);
  const [note, setNote] = useState("");
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [pauseInfo, setPauseInfo] = useState<{ elapsedMs: number; withinSla: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [dispatchTarget, setDispatchTarget] = useState<Ev | null>(null);
  const [dispatchAgentKey, setDispatchAgentKey] = useState("");
  const loadSequence = useRef(0);

  const load = useCallback(async (background = false) => {
    const requestId = ++loadSequence.current;
    if (!background) setLoadState("loading");
    try {
      await ensureDemoLogin();
      const [cur, ev, ag] = await Promise.all([
        trpc.nightShift.current.query() as Promise<{ configured: boolean; run?: NightRun }>,
        trpc.nightShift.events.query() as Promise<Ev[]>,
        trpc.workspace.agents.query() as Promise<typeof agents>,
      ]);
      if (requestId !== loadSequence.current) return;
      setConfigured(cur.configured);
      setRun(cur.run ?? null);
      setEvents(ev);
      setAgents(ag ?? []);
      setHasSnapshot(true);
      setLoadMessage("");
      setLoadState("ready");
    } catch (error) {
      if (requestId !== loadSequence.current) return;
      console.warn("读取夜班状态失败", error);
      const failure = toUiFailure(error);
      setLoadMessage(operationFailure(error, "读取夜班状态"));
      setLoadState(failure.kind === "forbidden" ? "forbidden" : "error");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 5000); // 夜班 5s 轮询（F3.4）
    return () => { clearInterval(t); loadSequence.current += 1; };
  }, [load]);

  const pillState: NightPillState = !configured
    ? "unconfigured"
    : run?.status === "running" ? "cruising" : run?.status === "paused" ? "paused" : run?.status === "package_generated" ? "completed" : "ready";
  const readonly = loadState !== "ready" || !canAction("night.manage");
  const canDispatch = loadState === "ready" && canAction("task.dispatch");

  const meter = useMemo(() => {
    const credits = events.reduce((s, e) => s + (e.model_trace?.credits ?? 0), 0);
    const needHuman = events.filter((e) => e.rule_impact?.some((r) => r.result === "blocked")).length;
    return { credits, needHuman, offPeak: events.some((e) => e.model_trace?.window === "off-peak") };
  }, [events]);

  /* 一键暂停（P9E2：二次确认在 EmergencyBrake 组件内；G5 计时回显；超时 P0 已在服务端升级 E4.1） */
  const doPause = useCallback(async () => {
    if (!run || busy) return;
    setBusy("pause");
    setActionError("");
    try {
      const r = await trpc.nightShift.pause.mutate({ runId: run.id }) as { elapsedMs: number; withinSla: boolean; pausedThreads: number };
      setPauseInfo(r);
      setBanner(r.withinSla
        ? { level: "info", text: `服务端已确认暂停：${r.pausedThreads} 个运行任务已挂起，用时 ${r.elapsedMs} 毫秒。` }
        : { level: "alert", text: `服务端已返回暂停结果，但用时 ${r.elapsedMs} 毫秒，超过目标；请立即复核任务状态。` });
      await load(true);
    } catch (error) {
      console.warn("暂停夜班失败", error);
      setActionError(operationFailure(error, "夜班暂停"));
    } finally {
      setBusy(null);
    }
  }, [run, busy, load]);

  const doResume = useCallback(async () => {
    if (!run || busy) return;
    setBusy("resume");
    setActionError("");
    try {
      await trpc.nightShift.resume.mutate({ runId: run.id });
      setPauseInfo(null);
      await load(true);
      setBanner({ level: "info", text: "服务端已确认恢复请求，夜班状态已重新读取；后续执行以事件回执为准。" });
    } catch (error) {
      console.warn("恢复夜班失败", error);
      setActionError(operationFailure(error, "夜班恢复"));
    } finally {
      setBusy(null);
    }
  }, [run, busy, load]);

  const sendNote = useCallback(async () => {
    if (!note.trim() || busy) return;
    setBusy("note");
    setActionError("");
    try {
      const result = await trpc.nightShift.note.mutate({ text: note.trim() }) as { eventId: string };
      setNote("");
      await load(true);
      setBanner({ level: "info", text: `留言已写入事件账本（${shortId(result.eventId)}）。` });
    } catch (error) {
      console.warn("提交夜班留言失败", error);
      setActionError(operationFailure(error, "留言提交"));
    } finally {
      setBusy(null);
    }
  }, [note, busy, load]);

  const dispatchAlert = useCallback(async (eventId: string, presetKey: string) => {
    if (busy || !presetKey || !canDispatch) return;
    setBusy(`dispatch-${eventId}`);
    setActionError("");
    try {
      const result = await trpc.inspection.dispatch.mutate({ anomalyEventId: eventId, presetKey }) as { eventId?: string; deduped?: boolean };
      setDispatchTarget(null);
      setBanner({ level: "info", text: result.deduped ? "该异常此前已派单，本次未重复创建任务。" : `服务端已创建处理任务${result.eventId ? `，账本事件 ${shortId(result.eventId)}` : ""}。` });
      await load(true);
    } catch (error) {
      console.warn("夜班异常派单失败", error);
      setActionError(operationFailure(error, "异常派单"));
    } finally {
      setBusy(null);
    }
  }, [busy, canDispatch, load]);

  /* ---------- 左栏：班组导航 ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">夜班中心 · 班组频道</div>
      <div className="mb-1.5 rounded-lg border border-gline bg-gold/6 px-3 py-2.5">
        <div className="inline-flex items-center gap-1 text-body text-gold"><Icon name="pin" size={13} />班组群（本页）</div>
        <div className="mt-0.5 text-body text-ink2">{run ? `班次 ${shortId(run.id)}` : "—"}</div>
      </div>
      <a href="/" className="mb-1.5 block rounded-lg border border-line bg-card px-3 py-2.5 text-body text-ink2 no-underline hover:border-gline">
        ← 返回工作台
      </a>
      <div className="mt-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-body font-bold text-holo">交接班预告</div>
        <div className="text-body text-ink2">08:30 自动生成交接班消息并投递到人类收件箱。</div>
        <div className="mt-1 text-body text-ink3">交接内容分为结果、风险和待决策事项三段。</div>
      </div>
      {pauseInfo && (
        <div className={`mt-3 rounded-lg border p-3 ${pauseInfo.withinSla ? "border-warn/40 bg-warn/5" : "border-alert/55 bg-alert/8"}`}>
          <div className="text-body font-bold text-warn">制动回执</div>
          <div className="mt-1 font-orb text-h2 font-bold text-ink">{latencyText(pauseInfo.elapsedMs)}</div>
          <div className="text-body text-ink3">{pauseInfo.withinSla ? "在 60 秒目标内完成" : "超过 60 秒目标，需立即复核"}</div>
        </div>
      )}
    </>
  );

  /* ---------- 右栏：班组信息 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">班组信息 · 概览</div>
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-body font-bold text-holo">班组状态</div>
        <NightStatusPill state={pillState} window="22:00–08:00" />
        {run?.fenceSnapshot && (
          <div className="mt-1.5 text-body text-ink3">当班安全规则 {versionText(run.fenceSnapshot)}（可回溯）</div>
        )}
      </div>
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-body font-bold text-holo">峰谷计量</div>
        <div className="font-orb text-h2 font-bold text-ink">{run?.stats?.credits_used ?? meter.credits} <span className="text-body text-ink3">积分</span></div>
        <div className="mt-0.5 font-mono text-body text-ink3">
          {meter.offPeak ? "谷时窗口" : "峰时窗口"} · 需介入 {run?.stats?.need_human ?? meter.needHuman} 项
        </div>
      </div>
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-2 text-body font-bold text-holo">班组成员 · {agents.length} 位数字员工</div>
        <SquadRing
          active={run?.status === "running"}
          members={agents.map((a) => ({ name: clientChineseText(a.name, actorText(a.preset_key)), version: versionText(a.version) }))}
        />
        <div className="mt-2 space-y-1">
          {agents.map((a) => (
            <div key={a.preset_key} className="flex items-center gap-2 text-body">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${a.status === "ready" ? "bg-go" : "bg-ink3"}`} />
              <span className="text-ink2">{clientChineseText(a.name, actorText(a.preset_key))}</span>
              <span className="text-body text-ink3">{versionText(a.version)}</span>
              <span className="ml-auto text-body text-ink3">{dictText(COMMON_STATUS_TEXT, a.status)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );

  return (
    <Bridge
      left={hasSnapshot ? left : <AsyncState status={loadState === "error" ? "error" : loadState === "forbidden" ? "forbidden" : "loading"} description={loadMessage || undefined} onRetry={loadState === "error" ? () => void load() : undefined} />}
      right={hasSnapshot ? right : <AsyncState status="loading" title="班组信息尚未就绪" description="班次状态确认后再显示安全规则和计量信息。" />}
    >
      <div className="flex min-h-full flex-col">
        {/* GroupHeader */}
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-h1 font-black tracking-wider">夜班中心频道</h2>
          <span className="text-body tracking-[.2em] text-ink3">夜班班组</span>
          <span className="flex-1" />
          {!readonly && configured && run?.status === "running" && <EmergencyBrake busy={busy === "pause"} disabled={Boolean(busy && busy !== "pause")} onConfirm={() => void doPause()} />}
          {!readonly && configured && run?.status === "paused" && (
            <button
              type="button"
              disabled={Boolean(busy)}
              aria-busy={busy === "resume" || undefined}
              onClick={() => void doResume()}
              className="cursor-pointer rounded-lg border border-go/50 bg-go/10 px-3.5 py-1.5 text-body font-extrabold text-go disabled:cursor-wait disabled:opacity-50"
            >
              {busy === "resume" ? "正在恢复…" : <><Icon name="play" size={14} className="inline" /> 恢复夜班（从断点续跑）</>}
            </button>
          )}
        </div>

        {loadState !== "ready" && hasSnapshot && <div className="mb-3"><BannerAlert level="warn" actionLabel="重新加载" onAction={() => void load()}>{loadMessage} 正在显示上一次成功快照，不能据此判断当前班次是否有新变化。</BannerAlert></div>}
        {actionError && <div className="mb-3"><BannerAlert level="alert" actionLabel="关闭" onAction={() => setActionError("")}>{actionError}</BannerAlert></div>}
        {banner && (
          <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>
        )}
        {run?.status === "paused" && (
          <div className="mb-3">
            <BannerAlert level="warn">班组已制动：全部夜间数字员工暂停，运行中的任务已从断点挂起；恢复后将从断点续跑。</BannerAlert>
          </div>
        )}

        <div className="flex-1 space-y-3">
          {!hasSnapshot ? (
            <AsyncState
              status={loadState === "forbidden" ? "forbidden" : loadState === "error" ? "error" : "loading"}
              description={loadMessage || undefined}
              onRetry={loadState === "error" ? () => void load() : undefined}
            />
          ) : !configured ? (
            <EmptyState icon={<Icon name="night" size={24} />} title="夜班未配置" hint="请前往规则与权限页面完成夜班配置。" actionLabel="去配置 →" onAction={() => navigate("/guardrails")} />
          ) : (
            <>
              <SystemDivider time="22:00" summary={`夜班开始 · 当班安全规则${versionText(run?.fenceSnapshot)} · 候选清单 ${run?.candidateCount ?? 0} 项已确认`} />
              {events.map((ev) => {
                if (ev.decision.action === "night.note" && ev.who.type === "human") {
                  return <HumanBubble key={ev.event_id} time={new Date(ev.context.time).toTimeString().slice(0, 5)}>{String((ev.decision.after as { text?: string })?.text ?? "")}</HumanBubble>;
                }
                if (ev.who.type === "system") {
                  return <SystemDivider key={ev.event_id} time={new Date(ev.context.time).toTimeString().slice(0, 5)} summary={`${actorText(ev.who.id)} · ${actionText(ev.decision.action)}（已落库）`} />;
                }
                // 需介入卡（红框，L4.2 夜间不确定不执行）+ 一键派单（P9E3）
                const blocked = ev.rule_impact?.some((r) => ["block", "blocked", "deny"].includes(r.result));
                if (blocked) {
                  return (
                    <RadarAlertCard
                      key={ev.event_id}
                      severity="attention"
                      eventId={ev.event_id}
                      title={`需介入：${actorText(ev.who.id)} · ${actionText(ev.decision.action)}${ev.object.id ? `（${shortId(ev.object.id)}）` : ""}`}
                      source={dictText(OBJECT_TYPE_TEXT, ev.object.type)}
                      busy={Boolean(busy)}
                      onDispatch={readonly || !canDispatch ? undefined : () => {
                        if (busy) return;
                        setDispatchTarget(ev);
                        setDispatchAgentKey(agents[0]?.preset_key ?? "");
                      }}
                    />
                  );
                }
                return (
                  <AgentActionMessage
                    key={ev.event_id}
                    sender={actorText(ev.who.id)}
                    version={versionText(ev.who.version)}
                    action={actionText(ev.decision.action)}
                    eventId={ev.event_id}
                    receipt={receiptOf(ev)}
                    rules={(ev.rule_impact ?? []).map((r) => `规则 ${shortId(r.rule_id)} · ${versionText(r.version)} · ${dictText(RULE_RESULT_TEXT, r.result)}`)}
                    credits={ev.model_trace?.credits}
                  >
                    {payloadText(ev.decision.after)}
                  </AgentActionMessage>
                );
              })}
              {events.length === 0 && (
                <EmptyState icon={<Icon name="night" size={24} />} title="班组尚未运行" hint="夜班开始后，这里会持续显示各数字员工的行动消息。" />
              )}
            </>
          )}
        </div>

        {/* P9E6 班组留言（只读成员隐藏 E2.6/L3.4；留言=五元事件留痕） */}
        {!readonly && configured && (
          <div className="mt-4 flex gap-2">
            <input
              value={note}
              disabled={busy === "note"}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void sendNote(); }}
              placeholder="给班组留言…（留言会留痕，触发的动作仍需经过安全规则）"
              className="flex-1 rounded-lg border border-line bg-bg800 px-3 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
            <button
              type="button"
              onClick={() => void sendNote()}
              disabled={!note.trim() || Boolean(busy)}
              aria-busy={busy === "note" || undefined}
              className="cursor-pointer rounded-lg gold-grad px-4 py-2 text-body font-black text-ongold disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "note" ? "正在提交…" : <>留言 <Icon name="send" size={14} className="inline" /></>}
            </button>
          </div>
        )}
      </div>
      <Overlay
        open={dispatchTarget !== null}
        title="确认派发异常处理任务"
        description="请选择当前行业包中的数字员工；确认后才会创建任务并写入事件账本。"
        onClose={() => { if (!busy) setDispatchTarget(null); }}
        dismissOnBackdrop={!busy}
        dismissOnEscape={!busy}
        footer={<><Button variant="quiet" disabled={Boolean(busy)} onClick={() => setDispatchTarget(null)}>取消</Button><Button variant="primary" busy={busy === `dispatch-${dispatchTarget?.event_id}`} disabled={!dispatchAgentKey} onClick={() => dispatchTarget && void dispatchAlert(dispatchTarget.event_id, dispatchAgentKey)}>确认派单</Button></>}
      >
        <div className="space-y-3">
          <p className="text-body text-ink2">异常：{dispatchTarget ? `${actorText(dispatchTarget.who.id)} · ${actionText(dispatchTarget.decision.action)}` : "待确认"}</p>
          {agents.length > 0 ? (
            <label className="block text-body text-ink2">承接数字员工<select className="mt-1 w-full rounded-lg border border-line bg-bg800 px-3 py-2 text-body text-ink" value={dispatchAgentKey} disabled={Boolean(busy)} onChange={(event) => setDispatchAgentKey(event.target.value)}>{agents.map((agent) => <option key={agent.preset_key} value={agent.preset_key}>{clientChineseText(agent.name, actorText(agent.preset_key))}</option>)}</select></label>
          ) : (
            <AsyncState status="empty" title="暂无可承接的数字员工" description="请先在当前行业包中装配数字员工，再回来派发异常任务。" />
          )}
        </div>
      </Overlay>
    </Bridge>
  );
}
