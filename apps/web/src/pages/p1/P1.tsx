/**
 * P1 工作台·工作台（F3：真实 API 接线版；PRD P1-①②③ 逐条对账）
 *  - 左栏 ConversationList：📌 置顶（夜班中心频道/昨夜日报）+ 待办（审批请求 badge）+ 任务线程（状态点实时）+ 问答
 *  - 中栏 MessageFlow：系统分隔线 → 交接班卡（P1E3，三计数与 P3 强一致 F4.4）→ KPI 投影（一企一档 history_curve 真实数据）
 *    → 巡检雷达推送（P1E4，一键派单接 inspection.dispatch；无异常显「昨夜一切正常」）
 *  - 右栏：档案 chips / 夜班班组状态卡 / 在线成员人机混编（P1E6）/ 渠道巡检状态
 *  - 底部：航线设定台（P1E1，Enter/启航→threads.dispatch；含糊→反问不建任务 F3.2）+ 快捷目标（P1E7，F3.5 酒店 6 条）
 * 状态变体：p1 默认 / p1_loading 骨架屏 / p1_empty 空态 / p1_community 社区版权限（隐藏夜班+Quest 快捷目标，F7.2/L2.2 隐藏非置灰）
 * 轮询：线程/夜班 5s，其余 10s（F3.4/D6）
 * 演示走查：?demo=p1_loading|p1_empty|p1_community 强制状态态（仅演示，数据接线不变）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
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
  SkeletonBlock,
  SystemDivider,
  type NightPillState,
} from "../../components/hud";
import { HostAgent } from "../../components/hud/HostAgent";
import { THREAD_MODE_TEXT, dictText } from "../../lib/display";

/* ---------- 类型（与 server router 对齐） ---------- */
interface ThreadRow {
  id: string; title: string; mode: string; status: string;
  progress_done: number; progress_total: number; agent_id: string | null; created_at: string;
}
interface Me { identity: { plan: string; name: string; role: string }; capabilities: { quest: boolean; nightShift: boolean; inspection: boolean } }
interface ArchiveShape {
  brand?: string;
  property?: { name: string; city: string; rooms: number; star: string };
  history_curve?: Record<string, { occ: number; adr: number; revpar: number; plays?: number; completion?: number; fans?: number }>;
}
interface ProfileResp { archive: ArchiveShape; stage: string | null; name: string }

/** 视频创作 6 快捷目标（行业 Bundle 预置：选题/脚本/评论/排期/合规/渲染；渲染进度直跳 P10 片库） */
const QUICK_GOALS: Array<{ label: string; text: string; preset: string; to?: string }> = [
  { label: "选题拆解", text: "拆解本周同类目爆款选题，给我 3 个可拍方向", preset: "trend-researcher" },
  { label: "起草脚本", text: "为「保温杯种草片」起草一版 3 镜脚本", preset: "scriptwriter" },
  { label: "评论分流", text: "把抖音评论区差评按三级分流并起草回复", preset: "comment-operator" },
  { label: "今日发布排期", text: "排一下今天各账号的发布排期", preset: "publish-operator" },
  { label: "素材合规检查", text: "检查待发素材的合规风险（功效宣称/版权）", preset: "field-inspector" },
  { label: "渲染进度", text: "汇报当前渲染队列进度与预计完成时间", preset: "render-operator", to: "/p10" },
];

const THREAD_DOT: Record<string, string> = {
  running: "bg-holo animate-pulse-hud", queued: "bg-ink3", pending_review: "bg-warn animate-pulse-warn",
  completed: "bg-go", failed: "bg-alert", paused: "bg-warn",
};

export default function P1() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const demo = params.get("demo"); // 演示走查强制态（数据接线不变）

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [night, setNight] = useState<{ configured: boolean; run?: { id: string; status: string; fenceSnapshot: string | null; stats: { done: number; pending: number; need_human: number; credits_used: number } | null } } | null>(null);
  const [insp, setInsp] = useState<{ lastRunAt: string | null; totalChecks: number; okCount: number; attention: Array<{ eventId: string; severity: string; summary: string; objectType: string; objectId?: string }> } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [profile, setProfile] = useState<ProfileResp | null>(null);
  const [agents, setAgents] = useState<Array<{ preset_key: string; name: string; version: string; kind: string; status: string }>>([]);
  const [members, setMembers] = useState<Array<{ memberNo: string; name: string; role: string }>>([]);

  // 派遣栏状态（P1E1）
  const [draft, setDraft] = useState("");
  const [dispatchState, setDispatchState] = useState<"empty" | "typing" | "routing">("empty");
  const [clarify, setClarify] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [meR, th, ni, ins, ap, prof, ag, mb] = await Promise.all([
        trpc.members.me.query() as Promise<Me>,
        trpc.threads.list.query() as Promise<ThreadRow[]>,
        trpc.nightShift.current.query() as Promise<typeof night>,
        trpc.inspection.status.query() as Promise<typeof insp>,
        trpc.approvals.list.query({ status: "pending" }) as Promise<unknown[]>,
        trpc.workspace.profile.query() as Promise<ProfileResp>,
        trpc.workspace.agents.query() as Promise<typeof agents>,
        trpc.members.list.query() as Promise<typeof members>,
      ]);
      setMe(meR); setThreads(th); setNight(ni); setInsp(ins);
      setPendingCount(ap.length); setProfile(prof); setAgents(ag ?? []); setMembers(mb ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t1 = setInterval(() => { // 线程/夜班 5s（F3.4）
      trpc.threads.list.query().then((r) => setThreads(r as ThreadRow[])).catch(() => undefined);
      trpc.nightShift.current.query().then((r) => setNight(r as typeof night)).catch(() => undefined);
    }, 5000);
    const t2 = setInterval(() => { // 其余 10s（D6）
      trpc.inspection.status.query().then((r) => setInsp(r as typeof insp)).catch(() => undefined);
      trpc.approvals.list.query({ status: "pending" }).then((r) => setPendingCount((r as unknown[]).length)).catch(() => undefined);
    }, 10000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [load]);

  /* ---------- 派生状态 ---------- */
  const plan = demo === "p1_community" ? "community" : (me?.identity.plan ?? "pro");
  const isCommunity = plan === "community";
  const nightConfigured = !!night?.configured;
  const pillState: NightPillState = !nightConfigured
    ? "unconfigured"
    : night?.run?.status === "running" ? "cruising"
      : night?.run?.status === "paused" ? "paused" : "ready";

  // KPI 投影（一企一档 history_curve 真实数据；最新月 vs 上月；截至=档案口径月末；字段缺失优雅兜底 0）
  const kpis = useMemo(() => {
    const curve = profile?.archive?.history_curve;
    if (!curve) return [];
    const months = Object.keys(curve).sort();
    const cur = curve[months[months.length - 1]!]!;
    const prev = months.length > 1 ? curve[months[months.length - 2]!]! : null;
    const pct = (a: number, b?: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : undefined);
    const plays = cur.plays ?? 0;
    const completion = cur.completion ?? 0;
    const fans = cur.fans ?? 0;
    return [
      { name: "播放量", value: plays >= 10000 ? `${(plays / 10000).toFixed(1)}w` : `${plays}`, delta: pct(plays, prev?.plays) },
      { name: "完播率", value: `${Math.round(completion * 100)}%`, delta: pct(completion, prev?.completion) },
      { name: "涨粉数", value: `${fans}`, delta: pct(fans, prev?.fans) },
      { name: "巡检正常项", value: insp ? `${insp.okCount}/${insp.totalChecks}` : "—", delta: undefined },
    ];
  }, [profile, insp]);

  /* ---------- 派遣（P1E1：含糊→反问不建任务 F3.2；成功→完成后态新线程顶部 0/y 蓝呼吸 F3.4） ---------- */
  const dispatch = useCallback(async (text: string, presetKey = "trend-researcher") => {
    if (!text.trim()) return;
    setDispatchState("routing");
    setClarify(null);
    try {
      const r = await trpc.threads.dispatch.mutate({ title: text.trim(), presetKey });
      if (r.kind === "clarify") {
        setClarify(r.question ?? "请补充目标与时间"); // 反问澄清，不留任务
      } else {
        setDraft("");
        await load(); // 完成后态：新线程出现列表顶部
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // #18 修复：用 text.trim() 判断而非闭包旧值 draft（setDraft 异步，闭包内 draft 未更新）
      setDispatchState(text.trim() ? "typing" : "empty");
    }
  }, [load]);

  /* ---------- 状态变体 ---------- */
  const isLoading = demo === "p1_loading" || !ready;
  const isEmpty = demo === "p1_empty" || (ready && threads.length === 0 && pendingCount === 0 && (insp?.attention.length ?? 0) === 0);

  /* ---------- 左栏：会话列表（分组渲染） ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">会话 · THREADS</div>
      {!isCommunity && nightConfigured && (
        <div className="mb-1.5 cursor-pointer rounded-lg border border-holo/35 bg-holo/5 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-caption text-holo">📌 夜班中心频道</span>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${night?.run?.status === "running" ? "bg-holo animate-pulse-hud" : "bg-ink3"}`} />
          </div>
          <div className="mt-0.5 text-body text-ink2">夜班班组群 → P9</div>
        </div>
      )}
      {nightConfigured && night?.run?.stats && (
        <div className="mb-1.5 cursor-pointer rounded-lg border border-gline bg-gold/5 px-3 py-2.5">
          <div className="text-caption text-gold">📌 昨夜日报</div>
          <div className="mt-0.5 text-body text-ink2">
            ✓{night.run.stats.done} ◆{night.run.stats.pending} ▲{night.run.stats.need_human}
          </div>
        </div>
      )}
      {pendingCount > 0 && (
        <div className="mb-1.5 cursor-pointer rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-caption text-warn">待办 · 审批请求</span>
            <span className="rounded-full bg-warn/15 px-1.5 font-orb text-micro font-bold text-warn">{pendingCount}</span>
          </div>
          <div className="mt-0.5 text-body text-ink2">审批中心 → P4</div>
        </div>
      )}
      <div className="mt-3 mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">任务线程 · ≤10 并发（G11）</div>
      {threads.map((t) => (
        <a key={t.id} href={`/p2/${t.id}`} className="mb-1.5 block rounded-lg border border-line bg-card px-3 py-2.5 no-underline hover:border-gline">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-ink3">{t.id}</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${THREAD_DOT[t.status] ?? "bg-ink3"}`} />
              {t.progress_done}/{t.progress_total}
            </span>
          </div>
          <div className="mt-1 text-body text-ink2">{t.title}</div>
        </a>
      ))}
      {ready && threads.length === 0 && (
        <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-caption text-ink3">
          还没有会话，@ 一位 Agent 或说出第一句话
        </div>
      )}
    </>
  );

  /* ---------- 右栏：上下文面板 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">上下文 · CONTEXT</div>
      {/* 档案 chips */}
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-caption font-bold text-holo">一企一档</div>
        {(profile?.archive?.property || profile?.archive?.brand) && (
          <div className="flex flex-wrap gap-1.5">
            {[
              profile?.archive?.brand ?? null,
              profile?.archive?.property?.name ?? null, profile?.archive?.property?.city ?? null,
              profile?.archive?.property ? `${profile.archive.property.rooms} 间` : null, profile?.archive?.property?.star ?? null,
              profile?.stage ? `阶段：${profile.stage}` : null,
            ].filter(Boolean).map((c) => (
              <span key={c as string} className="rounded border border-holo/35 bg-holo/5 px-1.5 py-0.5 text-micro text-holo">{c}</span>
            ))}
          </div>
        )}
      </div>
      {/* 夜班班组状态卡（社区版隐藏，F7.2） */}
      {!isCommunity && (
        <div className="mb-3 rounded-lg border border-line bg-card p-3">
          <div className="mb-1.5 text-caption font-bold text-holo">夜班中心</div>
          <NightStatusPill state={pillState} window="22:00–08:00" onClick={() => { window.location.href = "/p9"; }} />
          {night?.run?.fenceSnapshot && (
            <div className="mt-1.5 font-mono text-micro text-ink3">围栏快照 {night.run.fenceSnapshot}</div>
          )}
        </div>
      )}
      {/* 在线成员（人机混编 P1E6） */}
      <div className="mb-3 rounded-lg border border-line bg-card p-3">
        <div className="mb-1.5 text-caption font-bold text-holo">在线成员 · {members.length + agents.length}</div>
        <div className="space-y-1">
          {members.map((m) => (
            <div key={m.memberNo} className="flex items-center gap-2 text-body">
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-gold/60 bg-gold/10 text-micro text-goldhi">{m.name.slice(0, 1)}</span>
              <span className="text-ink2">{m.name}</span>
              <span className="font-mono text-micro text-ink3">{m.role}</span>
            </div>
          ))}
          {agents.map((a) => (
            <div key={a.preset_key} className="flex items-center gap-2 text-body">
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-line bg-bg700 text-micro text-ink2">{a.name.slice(0, 1)}</span>
              <span className="text-ink2">{a.name}</span>
              <span className="font-mono text-micro text-ink3">{a.version}</span>
              <span className={`ml-auto inline-block h-1.5 w-1.5 rounded-full ${a.status === "ready" ? "bg-go" : "bg-ink3"}`} />
            </div>
          ))}
        </div>
      </div>
      {/* 渠道巡检状态 */}
      {me?.capabilities.inspection !== false && (
        <div className="rounded-lg border border-line bg-card p-3">
          <div className="mb-1.5 text-caption font-bold text-holo">平台巡检</div>
          <div className="font-orb text-h2 font-bold text-ink">{insp ? `${insp.okCount}/${insp.totalChecks}` : "—"}</div>
          <div className="text-micro text-ink3">
            正常项/总数{insp?.lastRunAt ? ` · 最近 ${new Date(insp.lastRunAt).toTimeString().slice(0, 5)}` : ""}
          </div>
        </div>
      )}
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-h1 font-black tracking-wider">工作台 · 总览</h2>
          <span className="text-[11px] tracking-[.2em] text-ink3">
            P1 · OVERVIEW{isCommunity ? " · 社区版" : ""}{demo ? ` · demo=${demo}` : ""}
          </span>
          <span className="flex-1" />
          {/* 本页主理员工（工作台=总导演；点击 → P8 员工档案） */}
          <HostAgent presetKey="director" fallbackName="总导演" />
        </div>

        {error && (
          <div className="mb-3">
            <BannerAlert level="alert" actionLabel="重试" onAction={() => void load()}>
              事件服务连接中断 · 指标卡已置灰（E1.1）：{error}
            </BannerAlert>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            <SkeletonBlock lines={2} h={52} />
            <div className="grid grid-cols-4 gap-2.5">{[0, 1, 2, 3].map((i) => <SkeletonBlock key={i} lines={2} h={18} />)}</div>
            <SkeletonBlock lines={3} />
          </div>
        ) : (
          <div className="flex-1 space-y-3.5">
            <SystemDivider
              time={new Date().toTimeString().slice(0, 5)}
              summary={`${profile?.archive?.brand ?? "视频经理 · 演示工作室"} · ${me?.identity.name ?? ""} 已上线（演示身份 MEM-V01 陈主理）`}
            />

            {/* P1E3 交接班卡（夜班未启用 → 空态「去配置」F4.8） */}
            {!isCommunity && (
              night?.run?.stats ? (
                <HandoffCard
                  data={{
                    deliveredAt: "08:30",
                    fenceSnapshot: night.run.fenceSnapshot ?? "—",
                    done: night.run.stats.done, pending: night.run.stats.pending,
                    needHuman: night.run.stats.need_human, credits: night.run.stats.credits_used,
                  }}
                />
              ) : (
                <HandoffCard nightEnabled={false} />
              )
            )}

            {/* KPI 全息仪表（一企一档 history_curve 投影；截至时间必显 §5.7） */}
            <div className="grid grid-cols-4 gap-2.5">
              {kpis.map((k) => (
                <KpiGauge key={k.name} name={k.name} value={k.value} delta={k.delta} asOf="月末档案" stale={!!error} />
              ))}
            </div>

            {/* P1E4 巡检雷达推送（同事件幂等/按严重度排序/无异常显正常——服务端 L9.3 保证） */}
            {me?.capabilities.inspection !== false && (
              <div className="space-y-2">
                {(insp?.attention.length ?? 0) === 0 ? (
                  <RadarAllClear />
                ) : (
                  insp!.attention.map((a) => (
                    <RadarAlertCard
                      key={a.eventId}
                      severity={a.severity === "high" ? "p0" : a.severity === "medium" ? "p1" : "p2"}
                      eventId={a.eventId}
                      title={a.summary}
                      source={a.objectType}
                      onDispatch={() => {
                        void trpc.inspection.dispatch.mutate({ anomalyEventId: a.eventId }).then(() => load());
                      }}
                    />
                  ))
                )}
              </div>
            )}

            {/* 最近 Agent 行动消息（演示：取最新线程摘要） */}
            {threads[0] && (
              <AgentActionMessage
                sender={threads[0].agent_id ?? "值班 Agent"}
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
                icon="🌌"
                title="今夜风平浪静"
                hint="还没有会话、待办与异常——@ 一位 Agent 或说出第一句话，团队即刻开工"
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
          {!isCommunity && (
            <div className="flex flex-wrap gap-1.5">
              {QUICK_GOALS.map((g) => (
                <button
                  key={g.label}
                  type="button"
                  onClick={() => (g.to ? nav(g.to) : void dispatch(g.text, g.preset))}
                  className="cursor-pointer rounded-md border border-line bg-card px-2.5 py-1 text-caption text-ink2 transition-colors hover:border-gline hover:text-gold"
                >
                  ⚡ {g.label}
                </button>
              ))}
            </div>
          )}
          <DispatchBar
            state={dispatchState}
            value={draft}
            chips={[profile?.archive?.brand ?? "视频经理 · 演示工作室", `阶段：${profile?.stage ?? "—"}`]}
            onCancelRoute={() => setDispatchState(draft ? "typing" : "empty")}
            onChange={(v) => { setDraft(v); setDispatchState(v ? "typing" : "empty"); }}
            onSubmit={() => void dispatch(draft)}
          />
        </div>
      </div>
    </Bridge>
  );
}
