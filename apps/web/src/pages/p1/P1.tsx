/**
 * P1 工作台·工作台（F3：真实 API 接线版；PRD P1-①②③ 逐条对账）
 *  - 左栏 ConversationList：📌 置顶（夜班中心频道/昨夜日报）+ 待办（审批请求 badge）+ 任务线程（状态点实时）+ 问答
 *  - 中栏 MessageFlow：系统分隔线 → 交接班卡（P1E3，三计数与 P3 强一致 F4.4）→ 基座运行指标
 *    → 巡检雷达推送（P1E4，一键派单接 inspection.dispatch；无异常显「昨夜一切正常」）
 *  - 右栏：档案 chips / 夜班班组状态卡 / 在线成员人机混编（P1E6）/ 渠道巡检状态
 *  - 底部：航线设定台（P1E1，Enter/启航→threads.dispatch；含糊→反问不建任务 F3.2）+ 快捷目标（P1E7，F3.5 内置 6 条）
 * 状态变体：p1 默认 / p1_loading 骨架屏 / p1_empty 空态 / p1_community 社区版权限（隐藏夜班+Quest 快捷目标，F7.2/L2.2 隐藏非置灰）
 * 轮询：线程/夜班 5s，其余 10s（F3.4/D6）
 * 演示走查：?demo=p1_loading|p1_empty|p1_community 强制状态态（仅演示，数据接线不变）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { Bridge } from "../../shell/Bridge";
import {
  AgentActionMessage,
  BannerAlert,
  DispatchBar,
  EmptyState,
  HandoffCard,
  KpiGauge,
  NightStatusPill,
  RadarAlertCard,
  RadarAllClear,
  Skeleton,
  SystemDivider,
  type NightPillState,
} from "../../components/hud";
import { MEMBER_ROLE_TEXT, OBJECT_TYPE_TEXT, THREAD_MODE_TEXT, actorText, dictText, shortId, versionText } from "../../lib/display";
import { CreditsPanel } from "../../components/CreditsPanel";
import { Icon, clientChineseText, clientValueText } from "@workloom/ui";
import { useNavigationAccess } from "../../shell/NavigationAccess";

/* ---------- 类型（与 server router 对齐） ---------- */
interface ThreadRow {
  id: string; title: string; mode: string; status: string;
  progress_done: number; progress_total: number; agent_id: string | null; created_at: string;
}
interface ProfileResp { archive?: Record<string, unknown>; stage: string | null; name: string }

const THREAD_DOT: Record<string, string> = {
  running: "bg-holo animate-pulse-hud", queued: "bg-ink3", pending_review: "bg-warn animate-pulse-warn",
  completed: "bg-go", failed: "bg-alert", paused: "bg-warn",
};

export default function P1() {
  const { entries, subject, plan: accessPlan, capabilities, canAction } = useNavigationAccess();
  const [params] = useSearchParams();
  const demo = params.get("demo"); // 演示走查强制态（数据接线不变）

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [night, setNight] = useState<{ configured: boolean; run?: { id: string; status: string; fenceSnapshot: string | null; stats: { done: number; pending: number; need_human: number; credits_used: number } | null } } | null>(null);
  const [insp, setInsp] = useState<{ lastRunAt: string | null; totalChecks: number; okCount: number; attention: Array<{ eventId: string; severity: string; summary: string; objectType: string; objectId?: string }> } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [profile, setProfile] = useState<ProfileResp | null>(null);
  const [agents, setAgents] = useState<Array<{ preset_key: string; name: string; version: string; kind: string; status: string }>>([]);
  const [members, setMembers] = useState<Array<{ memberNo: string; name: string; role: string }>>([]);
  const quickGoals = useMemo(() => agents.slice(0, 6).map((agent) => ({
    label: clientChineseText(agent.name, actorText(agent.preset_key)),
    text: `请${clientChineseText(agent.name, actorText(agent.preset_key))}汇报当前进展并给出下一步建议`,
    preset: agent.preset_key,
  })), [agents]);

  // 派遣栏状态（P1E1）
  const [draft, setDraft] = useState("");
  const [dispatchState, setDispatchState] = useState<"empty" | "typing" | "routing">("empty");
  const [clarify, setClarify] = useState<string | null>(null);
  const canViewInbox = entries.some((entry) => entry.route === "/inbox");
  const canViewNight = entries.some((entry) => entry.route === "/night");
  const canViewMembers = entries.some((entry) => entry.route === "/members");
  const canInspect = capabilities.inspection !== false;
  const canDispatch = canAction("task.dispatch");

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [th, ni, ins, ap, prof, ag, mb] = await Promise.all([
        trpc.threads.list.query() as Promise<ThreadRow[]>,
        canViewNight ? trpc.nightShift.current.query() as Promise<typeof night> : Promise.resolve(null),
        canInspect ? trpc.inspection.status.query() as Promise<typeof insp> : Promise.resolve(null),
        canViewInbox ? trpc.approvals.list.query({ status: "pending" }) as Promise<unknown[]> : Promise.resolve([]),
        trpc.workspace.profile.query() as Promise<ProfileResp>,
        trpc.workspace.agents.query() as Promise<typeof agents>,
        canViewMembers ? trpc.members.list.query() as Promise<typeof members> : Promise.resolve([]),
      ]);
      setThreads(th); setNight(ni); setInsp(ins);
      setPendingCount(ap.length); setProfile(prof); setAgents(ag ?? []); setMembers(mb ?? []);
      setError(null);
    } catch (e) {
      console.error("工作台加载失败", e);
      setError("工作台数据暂时无法读取，请稍后重试。");
    } finally {
      setReady(true);
    }
  }, [canInspect, canViewInbox, canViewMembers, canViewNight]);

  useEffect(() => {
    void load();
    const t1 = setInterval(() => { // 线程/夜班 5s（F3.4）
      trpc.threads.list.query().then((r) => setThreads(r as ThreadRow[])).catch(() => undefined);
      if (canViewNight) trpc.nightShift.current.query().then((r) => setNight(r as typeof night)).catch(() => undefined);
    }, 5000);
    const t2 = setInterval(() => { // 其余 10s（D6）
      if (canInspect) trpc.inspection.status.query().then((r) => setInsp(r as typeof insp)).catch(() => undefined);
      if (canViewInbox) trpc.approvals.list.query({ status: "pending" }).then((r) => setPendingCount((r as unknown[]).length)).catch(() => undefined);
    }, 10000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [canInspect, canViewInbox, canViewNight, load]);

  /* ---------- 派生状态 ---------- */
  const plan = demo === "p1_community" ? "community" : (accessPlan ?? "community");
  const isCommunity = plan === "community";
  const nightConfigured = !!night?.configured;
  const pillState: NightPillState = !nightConfigured
    ? "unconfigured"
    : night?.run?.status === "running" ? "cruising"
      : night?.run?.status === "paused" ? "paused" : "ready";

  // 基座只展示跨行业成立的运行事实；经营指标由行业 Bundle 的页面投影提供。
  const kpis = useMemo(() => {
    return [
      { name: "进行中任务", value: `${threads.filter((thread) => thread.status === "running" || thread.status === "queued").length} 项` },
      { name: "待人工决策", value: `${pendingCount} 项` },
      { name: "巡检正常项", value: insp ? `${insp.okCount}/${insp.totalChecks}` : "—" },
      { name: "可用数字员工", value: `${agents.filter((agent) => agent.status === "ready").length} 位` },
    ];
  }, [agents, insp, pendingCount, threads]);
  const metricsAsOf = new Date().toTimeString().slice(0, 5);

  /* ---------- 派遣（P1E1：含糊→反问不建任务 F3.2；成功→完成后态新线程顶部 0/y 蓝呼吸 F3.4） ---------- */
  const dispatch = useCallback(async (text: string, presetKey?: string) => {
    if (!canDispatch || !text.trim()) return;
    const selectedAgent = presetKey ?? agents[0]?.preset_key;
    if (!selectedAgent) {
      setError("当前没有可接单的数字员工，请先在团队中心完成装配。");
      return;
    }
    setDispatchState("routing");
    setClarify(null);
    try {
      const r = await trpc.threads.dispatch.mutate({
        title: text.trim(),
        presetKey: selectedAgent,
      });
      if (r.kind === "clarify") {
        setClarify(clientChineseText(r.question, "请补充目标与时间")); // 反问澄清，不留任务
      } else {
        setDraft("");
        await load(); // 完成后态：新线程出现列表顶部
      }
    } catch (e) {
      console.error("工作台派遣失败", e);
      setError("任务暂时无法派发，请稍后重试；系统没有创建任务。");
    } finally {
      // #18 修复：用 text.trim() 判断而非闭包旧值 draft（setDraft 异步，闭包内 draft 未更新）
      setDispatchState(text.trim() ? "typing" : "empty");
    }
  }, [agents, canDispatch, load]);

  /* ---------- 状态变体 ---------- */
  const isLoading = demo === "p1_loading" || !ready;
  const isEmpty = demo === "p1_empty" || (ready && threads.length === 0 && pendingCount === 0 && (insp?.attention.length ?? 0) === 0);

  /* ---------- 左栏：会话列表（分组渲染） ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">任务会话</div>
      {!isCommunity && canViewNight && nightConfigured && (
        <div className="mb-1.5 cursor-pointer rounded-lg border border-holo/35 bg-holo/5 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-body text-holo"><Icon name="pin" size={13} />夜班中心频道</span>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${night?.run?.status === "running" ? "bg-holo animate-pulse-hud" : "bg-ink3"}`} />
          </div>
          <div className="mt-0.5 text-body text-ink2">夜班班组实时协作</div>
        </div>
      )}
      {canViewNight && nightConfigured && night?.run?.stats && (
        <div className="mb-1.5 cursor-pointer rounded-lg border border-gline bg-gold/5 px-3 py-2.5">
          <div className="inline-flex items-center gap-1 text-body text-gold"><Icon name="pin" size={13} />昨夜日报</div>
          <div className="mt-0.5 text-body text-ink2">
            完成 {night.run.stats.done} · 待审批 {night.run.stats.pending} · 求援 {night.run.stats.need_human}
          </div>
        </div>
      )}
      {canViewInbox && pendingCount > 0 && (
        <div className="mb-1.5 cursor-pointer rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-body text-warn">待办 · 审批请求</span>
            <span className="rounded-full bg-warn/15 px-1.5 font-orb text-body font-bold text-warn">{pendingCount}</span>
          </div>
          <div className="mt-0.5 text-body text-ink2">请到审批中心处理</div>
        </div>
      )}
      <div className="mt-3 mb-2 px-1 text-body tracking-[.2em] text-ink3">任务线程 · 最多 10 项并行</div>
      {threads.map((t) => (
        <a key={t.id} href={`/tasks/${t.id}`} className="mb-1.5 block rounded-lg border border-line bg-card px-3 py-2.5 no-underline hover:border-gline">
          <div className="flex items-center justify-between">
            <span className="font-mono text-body text-ink3">任务 {shortId(t.id)}</span>
            <span className="inline-flex items-center gap-1.5 text-body text-ink2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${THREAD_DOT[t.status] ?? "bg-ink3"}`} />
              {t.progress_done}/{t.progress_total}
            </span>
          </div>
          <div className="mt-1 text-body text-ink2">{t.title}</div>
        </a>
      ))}
      {ready && threads.length === 0 && (
        <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-body text-ink3">
          还没有会话，可选择一位数字员工或直接说出第一句话
        </div>
      )}
    </>
  );

  /* ---------- 右栏：上下文面板 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">任务上下文</div>
      {/* 工作区档案仅展示基座字段；行业业务档案由 Bundle 页面投影负责。 */}
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-body font-bold text-holo">工作区档案</div>
        {profile && (
          <div className="flex flex-wrap gap-1.5">
            {[
              profile.name,
              profile.stage ? `阶段：${clientValueText(profile.stage)}` : null,
            ].filter(Boolean).map((c) => (
              <span key={c as string} className="rounded border border-holo/35 bg-holo/5 px-1.5 py-0.5 text-body text-holo">{c}</span>
            ))}
          </div>
        )}
      </div>
      {/* 夜班班组状态卡（社区版隐藏，F7.2） */}
      {!isCommunity && canViewNight && (
        <div className="mb-3 rounded-lg border border-line bg-card p-3">
          <div className="mb-1.5 text-body font-bold text-holo">夜班中心</div>
          <NightStatusPill state={pillState} window="22:00–08:00" onClick={() => { window.location.href = "/night"; }} />
          {night?.run?.fenceSnapshot && <div className="mt-1.5 text-body text-ink3">安全规则已锁定并留痕</div>}
        </div>
      )}
      {/* 在线成员（人机混编 P1E6） */}
      {(canViewMembers || agents.length > 0) && <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-body font-bold text-holo">在线成员 · {members.length + agents.length}</div>
        <div className="space-y-1">
          {members.map((m) => (
            <div key={m.memberNo} className="flex items-center gap-2 text-body">
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-gold/60 bg-gold/10 text-body text-goldhi">{m.name.slice(0, 1)}</span>
              <span className="text-ink2">{m.name}</span>
              <span className="text-body text-ink3">{dictText(MEMBER_ROLE_TEXT, m.role)}</span>
            </div>
          ))}
          {agents.map((a) => (
            <div key={a.preset_key} className="flex items-center gap-2 text-body">
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-line bg-bg700 text-body text-ink2">{clientChineseText(a.name, actorText(a.preset_key)).slice(0, 1)}</span>
              <span className="text-ink2">{clientChineseText(a.name, actorText(a.preset_key))}</span>
              <span className="text-body text-ink3">{versionText(a.version)}</span>
              <span className={`ml-auto inline-block h-1.5 w-1.5 rounded-full ${a.status === "ready" ? "bg-go" : "bg-ink3"}`} />
            </div>
          ))}
        </div>
      </div>}
      {/* 渠道巡检状态 */}
      {canInspect && (
        <div className="rounded-lg border border-line bg-card p-3">
          <div className="mb-1.5 text-body font-bold text-holo">渠道巡检</div>
          <div className="font-orb text-h2 font-bold text-ink">{insp ? `${insp.okCount}/${insp.totalChecks}` : "—"}</div>
          <div className="text-body text-ink3">
            正常项/总数{insp?.lastRunAt ? ` · 最近 ${new Date(insp.lastRunAt).toTimeString().slice(0, 5)}` : ""}
          </div>
        </div>
      )}
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-h1 font-black tracking-wider">工作台 · 总览</h2>
          {isCommunity && <span className="text-body tracking-[.2em] text-ink3">社区版</span>}
        </div>

        {/* v3.0 积分账本（三池余额 + 加油包；P1 商业化产品化） */}
        <details className="mb-3 rounded-lg border border-line/60 bg-white/[0.02] px-3 py-2">
          <summary className="cursor-pointer text-body text-ink3"><Icon name="ledger" size={14} className="inline" /> 积分账本与加油包（三池余额 / 消耗流水）</summary>
          <div className="pt-2"><CreditsPanel /></div>
        </details>

        {error && (
          <div className="mb-3">
            <BannerAlert level="alert" actionLabel="重试" onAction={() => void load()}>
              事件服务暂时无法连接，指标卡已置灰；请检查服务状态后重试。
            </BannerAlert>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton count={2} height={52} label="首页摘要正在加载" />
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} count={2} height={18} label={`指标 ${i + 1} 正在加载`} />)}</div>
            <Skeleton count={3} label="首页事项正在加载" />
          </div>
        ) : (
          <div className="flex-1 space-y-3.5">
            <SystemDivider
              time={new Date().toTimeString().slice(0, 5)}
              summary={`${profile?.name ?? "演示工作区"} · ${subject?.name ?? ""} 已上线`}
            />

            {/* P1E3 交接班卡（夜班未启用 → 空态「去配置」F4.8） */}
            {!isCommunity && canViewNight && (
              night?.run?.stats ? (
                <HandoffCard
                  data={{
                    deliveredAt: "08:30",
                    fenceSnapshot: night.run.fenceSnapshot ? "配置已锁定" : "—",
                    done: night.run.stats.done, pending: night.run.stats.pending,
                    needHuman: night.run.stats.need_human, credits: night.run.stats.credits_used,
                  }}
                />
              ) : (
                <HandoffCard nightEnabled={false} />
              )
            )}

            {/* 基座运行指标；行业经营 KPI 由 Bundle 独立投影。截至时间必显 §5.7。 */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              {kpis.map((k) => (
                <KpiGauge key={k.name} name={k.name} value={k.value} asOf={metricsAsOf} stale={!!error} />
              ))}
            </div>

            {/* P1E4 巡检雷达推送（同事件幂等/按严重度排序/无异常显正常——服务端 L9.3 保证） */}
            {canInspect && (
              <div className="space-y-2">
                {(insp?.attention.length ?? 0) === 0 ? (
                  <RadarAllClear />
                ) : (
                  insp!.attention.map((a) => (
                    <RadarAlertCard
                      key={a.eventId}
                      severity={a.severity === "high" ? "p0" : a.severity === "medium" ? "p1" : "p2"}
                      eventId={a.eventId}
                      title={clientChineseText(a.summary, "发现一项需要关注的巡检异常")}
                      source={dictText(OBJECT_TYPE_TEXT, a.objectType)}
                      onDispatch={canDispatch ? () => {
                        void trpc.inspection.dispatch.mutate({ anomalyEventId: a.eventId }).then(() => load());
                      } : undefined}
                    />
                  ))
                )}
              </div>
            )}

            {/* 最近数字员工行动消息（演示：取最新线程摘要） */}
            {threads[0] && (
              <AgentActionMessage
                sender={actorText(threads[0].agent_id ?? "system")}
                version=""
                action={dictText(THREAD_MODE_TEXT, threads[0].mode)}
                eventId={threads[0].id}
                receipt={threads[0].status === "completed" ? "synced" : threads[0].status === "failed" ? "failed" : "unverified"}
              >
                {threads[0].title}（进度 {threads[0].progress_done}/{threads[0].progress_total}）
              </AgentActionMessage>
            )}

            {isEmpty && (
              <EmptyState
                icon={<Icon name="star" size={24} />}
                title="今夜风平浪静"
                hint="还没有会话、待办与异常——选择一位数字员工或说出第一句话，团队即刻开工"
              />
            )}
          </div>
        )}

        {/* 反问澄清条（F3.2：含糊指令不建任务） */}
        {clarify && (
          <div className="mt-3">
            <BannerAlert level="info" actionLabel="知道了" onAction={() => setClarify(null)}>
              任务待确认（未建任务）：{clarify}
            </BannerAlert>
          </div>
        )}

        {/* 底部航线设定台（P1E1）+ 快捷目标（P1E7；社区版隐藏 Quest 类 F7.2） */}
        <div className="mt-4 space-y-2">
          {canDispatch && !isCommunity && (
            <div className="flex flex-wrap gap-1.5">
              {quickGoals.map((g) => (
                <button
                  key={g.label}
                  type="button"
                  onClick={() => void dispatch(g.text, g.preset)}
                  className="cursor-pointer rounded-md border border-line bg-card px-2.5 py-1 text-body text-ink2 transition-colors hover:border-gline hover:text-gold"
                >
                  <Icon name="lightning" size={13} className="inline" /> {g.label}
                </button>
              ))}
            </div>
          )}
          {canDispatch && <DispatchBar
            state={dispatchState}
            value={draft}
            chips={[profile?.name ?? "当前工作区", `阶段：${clientValueText(profile?.stage)}`]}
            onCancelRoute={() => setDispatchState(draft ? "typing" : "empty")}
            onChange={(v) => { setDraft(v); setDispatchState(v ? "typing" : "empty"); }}
            onSubmit={() => void dispatch(draft)}
          />}
        </div>
      </div>
    </Bridge>
  );
}
