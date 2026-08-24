/**
 * P9 守夜战队频道（F5：夜班班组群 · AI–AI 协作现场；PRD P9-①②③④ 逐条对账）
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { actionText } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import {
  AgentActionMessage,
  BannerAlert,
  EmergencyBrake,
  EmptyState,
  HumanBubble,
  NightStatusPill,
  RadarAlertCard,
  SkeletonBlock,
  SquadRing,
  SystemDivider,
  type NightPillState,
  type ReceiptState,
} from "../../components/hud";

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
  if (ev.rule_impact?.some((r) => r.result === "blocked")) return "failed";
  if (ev.receipt?.synced) return "synced";
  return "unverified";
}

export default function P9() {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState("owner");
  const [run, setRun] = useState<NightRun | null>(null);
  const [configured, setConfigured] = useState(true);
  const [events, setEvents] = useState<Ev[]>([]);
  const [agents, setAgents] = useState<Array<{ preset_key: string; name: string; version: string; status: string }>>([]);
  const [note, setNote] = useState("");
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [pauseInfo, setPauseInfo] = useState<{ elapsedMs: number; withinSla: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [meR, cur, ev, ag] = await Promise.all([
        trpc.members.me.query() as Promise<{ identity: { role: string } }>,
        trpc.nightShift.current.query() as Promise<{ configured: boolean; run?: NightRun }>,
        trpc.nightShift.events.query() as Promise<Ev[]>,
        trpc.workspace.agents.query() as Promise<typeof agents>,
      ]);
      setRole(meR.identity.role);
      setConfigured(cur.configured);
      setRun(cur.run ?? null);
      setEvents(ev);
      setAgents(ag ?? []);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000); // 夜班 5s 轮询（F3.4）
    return () => clearInterval(t);
  }, [load]);

  const pillState: NightPillState = !configured
    ? "unconfigured"
    : run?.status === "running" ? "cruising" : run?.status === "paused" ? "paused" : "ready";
  const readonly = role === "readonly";

  const meter = useMemo(() => {
    const credits = events.reduce((s, e) => s + (e.model_trace?.credits ?? 0), 0);
    const needHuman = events.filter((e) => e.rule_impact?.some((r) => r.result === "blocked")).length;
    return { credits, needHuman, offPeak: events.some((e) => e.model_trace?.window === "off-peak") };
  }, [events]);

  /* 一键暂停（P9E2：二次确认在 EmergencyBrake 组件内；G5 计时回显；超时 P0 已在服务端升级 E4.1） */
  const doPause = useCallback(async () => {
    if (!run) return;
    const r = await trpc.nightShift.pause.mutate({ runId: run.id }) as { elapsedMs: number; withinSla: boolean; pausedThreads: number };
    setPauseInfo(r);
    setBanner(r.withinSla
      ? { level: "info", text: `一键暂停已生效：${r.elapsedMs}ms 全端制动（G5 ≤60s），running 线程已断点挂起（E4.2 可续跑）` }
      : { level: "alert", text: `暂停超时 ${r.elapsedMs}ms（G5 超 60s）——已升级 P0 告警并强制隔离会话（E4.1）` });
    await load();
  }, [run, load]);

  const doResume = useCallback(async () => {
    if (!run) return;
    await trpc.nightShift.resume.mutate({ runId: run.id });
    setPauseInfo(null);
    setBanner({ level: "info", text: "夜班已恢复：挂起线程回列，事件流重放续跑（E4.2/H-5 幂等）" });
    await load();
  }, [run, load]);

  const sendNote = useCallback(async () => {
    if (!note.trim()) return;
    await trpc.nightShift.note.mutate({ text: note.trim() });
    setNote("");
    await load();
  }, [note, load]);

  /* ---------- 左栏：班组导航 ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">守夜战队 · NIGHT SQUAD</div>
      <div className="mb-1.5 rounded-lg border border-gline bg-gold/6 px-3 py-2.5">
        <div className="text-caption text-gold">📌 班组群（本页）</div>
        <div className="mt-0.5 text-body text-ink2">{run ? `班次 ${run.id}` : "—"}</div>
      </div>
      <a href="/" className="mb-1.5 block rounded-lg border border-line bg-card px-3 py-2.5 text-body text-ink2 no-underline hover:border-gline">
        ← 返回主甲板（P1）
      </a>
      <div className="mt-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-caption font-bold text-holo">交接班预告（P9E5）</div>
        <div className="text-caption text-ink2">08:30 自动生成交接班消息并投递人类收件箱（→P3）</div>
        <div className="mt-1 font-mono text-micro text-ink3">三段投影 · 非额外报表（F4.4/H-7）</div>
      </div>
      {pauseInfo && (
        <div className={`mt-3 rounded-lg border p-3 ${pauseInfo.withinSla ? "border-warn/40 bg-warn/5" : "border-alert/55 bg-alert/8"}`}>
          <div className="text-caption font-bold text-warn">制动回执（G5 计时留痕）</div>
          <div className="mt-1 font-orb text-h2 font-bold text-ink">{pauseInfo.elapsedMs}ms</div>
          <div className="text-micro text-ink3">{pauseInfo.withinSla ? "≤60s 达标" : "超时 · P0 已升级（E4.1）"}</div>
        </div>
      )}
    </>
  );

  /* ---------- 右栏：班组信息 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">班组信息 · SQUAD</div>
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-caption font-bold text-holo">班组状态（F4.8 状态机）</div>
        <NightStatusPill state={pillState} window="22:00–08:00" />
        {run?.fenceSnapshot && (
          <div className="mt-1.5 font-mono text-micro text-ink3">围栏快照 {run.fenceSnapshot}（F2.6 可回溯）</div>
        )}
      </div>
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-caption font-bold text-holo">峰谷计量（NightMeter）</div>
        <div className="font-orb text-h2 font-bold text-ink">{run?.stats?.credits_used ?? meter.credits} <span className="text-caption text-ink3">积分</span></div>
        <div className="mt-0.5 font-mono text-micro text-ink3">
          {meter.offPeak ? "谷时窗口（峰谷费率 F6.3/G9）" : "峰时窗口"} · 需介入 {run?.stats?.need_human ?? meter.needHuman} 项
        </div>
      </div>
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-2 text-caption font-bold text-holo">群成员 · {agents.length} Agent（P9E4）</div>
        <SquadRing
          active={run?.status === "running"}
          members={agents.map((a) => ({ name: a.name, version: a.version }))}
        />
        <div className="mt-2 space-y-1">
          {agents.map((a) => (
            <div key={a.preset_key} className="flex items-center gap-2 text-body">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                run?.status === "running" ? "bg-holo animate-pulse-hud" : "bg-ink3"
              }`} />
              <span className="text-ink2">{a.name}</span>
              <span className="font-mono text-micro text-ink3">{a.version}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        {/* GroupHeader */}
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-h1 font-black tracking-wider">守夜战队频道</h2>
          <span className="text-[11px] tracking-[.2em] text-ink3">P9 · NIGHT SQUAD</span>
          <span className="flex-1" />
          {!readonly && configured && run?.status === "running" && <EmergencyBrake onConfirm={() => void doPause()} />}
          {!readonly && configured && run?.status === "paused" && (
            <button
              type="button"
              onClick={() => void doResume()}
              className="cursor-pointer rounded-lg border border-go/50 bg-go/10 px-3.5 py-1.5 text-xs font-extrabold text-go"
            >
              ▶ 恢复夜班（E4.2 断点续跑）
            </button>
          )}
        </div>

        {banner && (
          <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>
        )}
        {run?.status === "paused" && (
          <div className="mb-3">
            <BannerAlert level="warn">班组已制动 · 全部夜间 Agent 暂停，running 线程断点挂起（p9_paused；恢复后重放续跑 E4.2）</BannerAlert>
          </div>
        )}

        <div className="flex-1 space-y-3">
          {!ready ? (
            <><SkeletonBlock lines={2} h={44} /><SkeletonBlock lines={4} /></>
          ) : !configured ? (
            <EmptyState icon="🌙" title="夜班未配置" hint="去航道管制台（P5）配置守夜战队（F4.8）" actionLabel="去配置 →" />
          ) : (
            <>
              <SystemDivider time="22:00" summary={`夜班开始 · 围栏快照 ${run?.fenceSnapshot ?? "—"} 已写入事件 · 候选清单 ${run?.candidateCount ?? 0} 项已确认（F4.1/F2.6）`} />
              {events.map((ev) => {
                if (ev.decision.action === "night.note" && ev.who.type === "human") {
                  return <HumanBubble key={ev.event_id} time={new Date(ev.context.time).toTimeString().slice(0, 5)}>{String((ev.decision.after as { text?: string })?.text ?? "")}</HumanBubble>;
                }
                if (ev.who.type === "system") {
                  return <SystemDivider key={ev.event_id} time={new Date(ev.context.time).toTimeString().slice(0, 5)} summary={`${ev.who.id} · ${actionText(ev.decision.action)}（已落库）`} />;
                }
                // 需介入卡（红框，L4.2 夜间不确定不执行）+ 一键派单（P9E3）
                const blocked = ev.rule_impact?.some((r) => r.result === "blocked");
                if (blocked) {
                  return (
                    <RadarAlertCard
                      key={ev.event_id}
                      severity="p0"
                      eventId={ev.event_id}
                      title={`需介入：${ev.who.id} · ${actionText(ev.decision.action)}${ev.object.id ? `（${ev.object.id}）` : ""}`}
                      source={ev.object.type}
                      onDispatch={() => {
                        void trpc.inspection.dispatch.mutate({ anomalyEventId: ev.event_id, presetKey: "comment-operator" })
                          .then(() => setBanner({ level: "info", text: "已派单：以异常事件唤起业务 Agent，处理结果回链（F9.3）" }))
                          .catch(() => setBanner({ level: "warn", text: "该事件非巡检异常类，转 P4 决断队列处理" }));
                      }}
                    />
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
                    rules={(ev.rule_impact ?? []).map((r) => `${r.rule_id} ${r.version}${r.result === "review" ? " · 未生效待审批" : ""}`)}
                    credits={ev.model_trace?.credits}
                  >
                    {typeof ev.decision.after === "object" && ev.decision.after !== null
                      ? JSON.stringify(ev.decision.after).slice(0, 160) : ""}
                  </AgentActionMessage>
                );
              })}
              {events.length === 0 && (
                <EmptyState icon="🌌" title="班组尚未开张" hint="今夜 22:00 守夜战队出征后，这里将滚动各 Agent 的行动消息" />
              )}
            </>
          )}
        </div>

        {/* P9E6 班组留言（只读成员隐藏 E2.6/L3.4；留言=五元事件留痕） */}
        {!readonly && configured && (
          <div className="mt-4 flex gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void sendNote(); }}
              placeholder="给班组留言…（五元事件留痕；触发的动作照常过围栏 L4.1/L4.4）"
              className="flex-1 rounded-lg border border-line bg-bg800 px-3 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
            <button
              type="button"
              onClick={() => void sendNote()}
              disabled={!note.trim()}
              className="cursor-pointer rounded-lg gold-grad px-4 py-2 text-body font-black text-ongold disabled:cursor-not-allowed disabled:opacity-40"
            >
              留言 ▶
            </button>
          </div>
        )}
      </div>
    </Bridge>
  );
}
