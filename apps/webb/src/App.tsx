import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AsyncState,
  AgentWorkCard,
  AppShell,
  Badge,
  BottomTabs,
  Button,
  Card,
  DecisionPackage,
  Drawer,
  Icon,
  IconButton,
  LedgerTimeline,
  MetricCard,
  NAVIGATION_GROUP_LABELS,
  NAVIGATION_GROUP_ORDER,
  Overlay,
  Select,
  Textarea,
  NightShiftStatus,
  TopContextBar,
  clientChineseText,
  clientIdentifierText,
  clientStatusLabel,
  clientValueText,
  composeNavigation,
  isNavigationActive,
  navigationEntriesFromBundle,
  type BundleNavigationSlot,
  type NavigationEntry,
} from "@workloom/ui";
import { Auth } from "./Auth";
import { clearSession, logoutSession, restoreSession, trpc } from "./lib/trpc";
import { safeMessage, useResource } from "./lib/useResource";
import { B_MOBILE_PRIMARY_TABS, isBMobileRoute, isBMobileRoutePermitted, permittedBMobileRoutes } from "./routes";

interface Identity {
  name: string;
  role: string;
  memberNo: string;
  plan: string;
  workspaceId: string;
}
interface Me { identity: Identity; capabilities: Record<string, boolean | number> }
interface Approval {
  approval_id: string;
  event_id: string;
  status: string;
  created_at: string;
  snapshot: { high_risk?: boolean; before?: unknown; after?: unknown; expires_at?: string };
  event?: { decision?: { action?: string }; who?: { id?: string }; rule_impact?: unknown[] };
}
interface ThreadRow { id: string; title: string; status: string; progress_done: number; progress_total: number; agent_id: string | null; created_at: string }
interface NightState { configured: boolean; run?: { id: string; status: string; runDate: string; stats?: { done: number; pending: number; need_human: number; credits_used: number } | null } }
interface FeedbackReason { code: string; label: string; appliesTo?: string[] }
interface MobileBundleProjection {
  configured: true;
  bundleId: string;
  bundleName: string;
  bundleVersion: string;
  ui: {
    navigation: { slots: BundleNavigationSlot[] };
    objects: string[];
    workflows: string[];
    home: { widgets: Array<{ component: string; clients: string[]; props: Record<string, unknown> }> };
  };
}
type MobileBundleState = MobileBundleProjection | { configured: false; reason: string; failed?: boolean };
interface AccessScopeOption {
  tenantId: string;
  tenantName: string;
  workspaceId: string;
  workspaceName: string;
}
interface MobileAccess {
  subject: { kind: "member" | "guest" | "partner"; id: string; memberNo?: string; name: string; role: string };
  scope: { tenantId: string; workspaceId: string };
  plan: string;
  capabilities: Record<string, boolean | number>;
  navigationPermissions: string[];
  actionPermissions: string[];
  availableScopes: AccessScopeOption[];
  bundle: MobileBundleState;
}

const ROLE_LABELS: Record<string, string> = { owner: "负责人", manager: "管理员", staff: "成员", readonly: "只读成员", partner: "合作伙伴" };
function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname || "/");
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setPathname(path);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  return { pathname, navigate };
}

function formatTime(value?: string) {
  if (!value) return "时间待确认";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待确认" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function PageHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><p className="muted">{description}</p></div>{action}</div>;
}

function Resource<T>({ state, retry, empty, children }: { state: ReturnType<typeof useResource<T>>["state"]; retry: () => void; empty?: (data: T) => boolean; children: (data: T) => React.ReactNode }) {
  if (state.status === "loading" && !("data" in state)) return <AsyncState status="loading" />;
  if (state.status === "error" && !("data" in state)) return <AsyncState status={state.kind === "forbidden" ? "forbidden" : "error"} title={state.kind === "unauthorized" ? "登录已失效" : undefined} description={state.message} onRetry={state.kind === "error" ? retry : undefined} />;
  const data = state.data as T;
  return <>
    {state.status === "loading" && <div className="status-strip" role="status">正在刷新，完成前继续显示上一次成功数据。</div>}
    {state.status === "error" && <div className="status-strip" role="alert">刷新失败，正在显示上一次成功数据。<Button variant="quiet" onClick={retry}>重试</Button></div>}
    {empty?.(data) ? <AsyncState status="empty" /> : children(data)}
  </>;
}

function TodayPage({ navigate, me, entries }: { navigate: (path: string) => void; me: Me; entries: readonly NavigationEntry[] }) {
  const canOpenInbox = isBMobileRoutePermitted("/inbox", entries);
  const canOpenTasks = isBMobileRoutePermitted("/tasks", entries);
  const canOpenNight = isBMobileRoutePermitted("/night", entries);
  const loader = useCallback(async () => {
    const [approvals, threads, night] = await Promise.all([
      canOpenInbox ? trpc.approvals.list.query({ status: "pending" }) as Promise<Approval[]> : Promise.resolve([]),
      canOpenTasks ? trpc.threads.list.query() as Promise<ThreadRow[]> : Promise.resolve([]),
      canOpenNight ? trpc.nightShift.current.query() as Promise<NightState> : Promise.resolve({ configured: false } as NightState),
    ]);
    return { me, approvals, threads, night };
  }, [canOpenInbox, canOpenNight, canOpenTasks, me]);
  const resource = useResource(loader);
  return <div className="page"><PageHeading title="今天需要关注什么" description="先看需要你决定的事，再看数字员工运行进度。" />
    <Resource state={resource.state} retry={resource.reload}>{({ me, approvals, threads, night }) => {
      const running = threads.filter((thread) => ["running", "queued", "pending_review"].includes(thread.status));
      const needsHuman = night.run?.stats?.need_human ?? 0;
      return <>
        <div className={`status-strip ${me.identity.memberNo === "GUEST" ? "demo" : ""}`}>
          {me.identity.memberNo === "GUEST" ? "只读示例：不会执行审批、外发或正式经营动作。" : `当前身份：${me.identity.name} · ${ROLE_LABELS[me.identity.role] ?? "成员"}`}
        </div>
        <div className="metric-grid">
          {canOpenInbox && <MetricCard label="待我审批" value={approvals.length} period="当前待办" source="审批服务" updatedAt="接口未提供更新时间" />}
          {canOpenTasks && <MetricCard label="运行中任务" value={running.length} period="当前任务" source="任务事件" updatedAt="接口未提供更新时间" />}
          {canOpenNight && <MetricCard label="夜班需介入" value={needsHuman} period="最近班次" source="夜班交接" updatedAt="接口未提供更新时间" />}
          {canOpenTasks && <MetricCard label="已完成任务" value={threads.filter((item) => item.status === "completed").length} period="当前任务列表" source="任务事件" updatedAt="接口未提供更新时间" />}
        </div>
        {canOpenInbox && approvals.length > 0 && <Card><div className="row"><h2>优先处理审批</h2><Badge tone="warning">{approvals.length} 项</Badge></div><p className="item-copy">最高风险事项会排在待办页前面，提交后可从事件账本核对回执。</p><div className="action-row"><Button variant="primary" onClick={() => navigate("/inbox")}>查看待办</Button></div></Card>}
        {canOpenTasks && <><div className="row"><h2>数字员工正在做</h2><Button variant="quiet" onClick={() => navigate("/tasks")}>查看全部</Button></div>
        <div className="stack">{running.slice(0, 3).map((thread) => <AgentWorkCard key={thread.id} work={{ id: thread.id, actor: thread.agent_id ? "数字员工" : "等待分派", humanOwner: me.identity.name, goal: thread.title, stage: clientStatusLabel(thread.status), progress: { completed: thread.progress_done, total: thread.progress_total || undefined, next: thread.status === "pending_review" ? "等待人类裁决" : "继续执行当前里程碑" }, reason: "进度来自当前工作区的任务事件。", needsHuman: thread.status === "pending_review" ? { action: "查看并裁决当前结果", consequence: "任务会保持等待，不会自行越过围栏。" } : undefined, risk: thread.status === "pending_review" ? "medium" : "none", receipt: { requestId: thread.id }, recovery: "可进入任务页查看、暂停或接管" }} />)}{running.length === 0 && <AsyncState status="empty" title="目前没有运行中的任务" description="新任务创建后，会在这里展示执行者、阶段、依据和需要你的动作。" />}</div></>}
        {canOpenNight && <><NightShiftStatus status={night.configured ? clientStatusLabel(night.run?.status ?? "pending") : "尚未配置"} nextRun={night.run?.runDate ? formatTime(night.run.runDate) : undefined} needsHuman={needsHuman} />
        <div className="action-row"><Button onClick={() => navigate("/night")}>查看夜班</Button></div></>}
      </>;
    }}</Resource>
  </div>;
}

function ApprovalsPage({ canDecide }: { canDecide: boolean }) {
  const loader = useCallback(async () => Promise.all([
    trpc.approvals.list.query() as Promise<Approval[]>,
    trpc.memory.feedbackEnums.query() as Promise<FeedbackReason[]>,
  ]).then(([approvals, reasons]) => ({ approvals, reasons: reasons.filter((item) => !item.appliesTo || item.appliesTo.includes("reject")) })), []);
  const resource = useResource(loader);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [approving, setApproving] = useState<Approval | null>(null);
  const [rejecting, setRejecting] = useState<Approval | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const decide = async (approval: Approval, gesture: "approve" | "reject") => {
    if (busy) return;
    setBusy(approval.approval_id); setError(""); setNotice("");
    try {
      const result = await trpc.approvals.decide.mutate({ approvalId: approval.approval_id, gesture, ...(gesture === "reject" ? { reasonEnum: reason, reasonText: note || undefined } : {}) }) as { deduped?: boolean; gestureEventId?: string };
      setApproving(null); setRejecting(null); setNote("");
      setNotice(result.deduped ? "该审批此前已完成，本次未重复执行。" : "服务端已记录本次审批决定；外部动作仍以执行回执为准。");
      await resource.reload();
    } catch (cause) { setError(`审批提交未完成。${safeMessage(cause)}`); }
    finally { setBusy(null); }
  };
  return <div className="page"><PageHeading title="待办与审批" description="每次决定都会写入事件账本；审批成功不等于外部执行成功。" />
    {error && <div className="status-strip" role="alert">{error}</div>}
    {notice && <div className="status-strip" role="status">{notice}</div>}
    <Resource state={resource.state} retry={resource.reload} empty={({ approvals }) => approvals.length === 0}>{({ approvals, reasons }) => <div className="stack">{approvals.map((approval) => {
      const readonly = !canDecide || approval.status !== "pending";
      return <DecisionPackage key={approval.approval_id} decision={{ title: approval.event?.decision?.action ? "待确认的经营动作" : "待确认事项", action: "批准后由受控执行链继续处理", summary: `由${approval.event?.who?.id ? "数字员工" : "系统流程"}发起，当前状态为${clientStatusLabel(approval.status)}。`, before: clientValueText(approval.snapshot.before), after: clientValueText(approval.snapshot.after), evidence: approval.event?.rule_impact?.length ? [{ title: `命中 ${approval.event.rule_impact.length} 条规则`, source: "围栏判断" }] : [{ title: "审批事件已进入待办", source: "事件账本" }], risk: approval.snapshot.high_risk ? "high" : "medium", fence: approval.snapshot.high_risk ? "高风险动作必须由人类明确裁决" : "当前动作需要人类确认", impact: clientValueText(approval.snapshot.after), rollback: "审批前不会执行；执行后的回滚方式以对应任务回执为准。", eventId: approval.event_id }} actions={!readonly ? <><Button variant="primary" disabled={Boolean(busy)} onClick={() => setApproving(approval)}>批准</Button><Button variant="danger" disabled={Boolean(busy)} onClick={() => { setReason(reasons[0]?.code ?? "other"); setRejecting(approval); }}>驳回</Button></> : undefined} />;
    })}</div>}</Resource>
    <Overlay open={Boolean(approving)} title="确认批准" description="审批决定会写入事件账本；批准不等于外部动作已经生效。" onClose={() => { if (!busy) setApproving(null); }} dismissOnBackdrop={!busy} dismissOnEscape={!busy} footer={<><Button disabled={Boolean(busy)} onClick={() => setApproving(null)}>取消</Button><Button variant="primary" busy={busy === approving?.approval_id} onClick={() => approving && void decide(approving, "approve")}>确认批准</Button></>}>
      <p>影响摘要：{clientValueText(approving?.snapshot.after)}。提交后请继续核对外部执行回执。</p>
    </Overlay>
    <Overlay open={Boolean(rejecting)} title="驳回审批" description="请选择结构化原因；补充说明会进入可追溯记录。" onClose={() => { if (!busy) setRejecting(null); }} dismissOnBackdrop={!busy} dismissOnEscape={!busy} footer={<><Button disabled={Boolean(busy)} onClick={() => setRejecting(null)}>取消</Button><Button variant="danger" busy={busy === rejecting?.approval_id} disabled={!reason} onClick={() => rejecting && void decide(rejecting, "reject")}>确认驳回</Button></>}>
      <div className="stack">
        <Select label="驳回原因" required value={reason} disabled={Boolean(busy)} onChange={(event) => setReason(event.target.value)}>
          {(resource.state.status === "ready" ? resource.state.data.reasons : [{ code: "other", label: "其他原因" }]).map((item) => (
            <option key={item.code} value={item.code}>{clientChineseText(item.label, "其他原因")}</option>
          ))}
        </Select>
        <Textarea
          label="补充说明"
          description="最多 200 个字；内容会随驳回原因写入事件账本。"
          value={note}
          disabled={Boolean(busy)}
          onChange={(event) => setNote(event.target.value)}
          maxLength={200}
          rows={4}
        />
      </div>
    </Overlay>
  </div>;
}

function TasksPage({ canDispatch }: { canDispatch: boolean }) {
  const loader = useCallback(async () => Promise.all([
    trpc.members.me.query() as Promise<Me>,
    trpc.threads.list.query() as Promise<ThreadRow[]>,
    trpc.workspace.agents.query() as Promise<Array<{ preset_key: string; name: string }>>,
  ]).then(([me, threads, agents]) => ({ me, threads, agents })), []);
  const resource = useResource(loader);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDispatch, setConfirmDispatch] = useState(false);
  const dispatch = async (agents: Array<{ preset_key: string; name: string }>) => {
    const agent = agents[0];
    if (!agent || !title.trim() || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await trpc.threads.dispatch.mutate({ title: title.trim(), presetKey: agent.preset_key }) as { kind: "clarify" | "routed"; question?: string; threadId?: string };
      setConfirmDispatch(false);
      if (result.kind === "clarify") {
        setNotice(`信息还不够，系统没有创建任务。请补充：${clientChineseText(result.question, "目标、对象或完成标准")}`);
      } else {
        setNotice(`服务端已创建任务${result.threadId ? `（${clientIdentifierText(result.threadId)}）` : ""}，可在任务列表跟踪进度。`);
        setTitle("");
      }
      await resource.reload();
    }
    catch (cause) { setError(`任务创建未完成。${safeMessage(cause)}`); }
    finally { setBusy(false); }
  };
  return <div className="page"><PageHeading title="任务" description="查看谁在做、做到哪、为什么停住，以及下一步是否需要你。" />
    <Resource state={resource.state} retry={resource.reload}>{({ me, threads, agents }) => <>
      {canDispatch && <Card><h2>发起任务</h2><p className="item-copy">请写清目标、对象和时间；信息不足时系统会先反问，不会偷偷创建任务。</p><div className="stack"><label>任务目标<textarea rows={3} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} placeholder="例如：复盘本周核心指标变化，并列出需要我决定的三件事" /></label>{error && <div className="status-strip" role="alert">{error}</div>}{notice && <div className="status-strip" role="status">{notice}</div>}<Button variant="primary" disabled={!title.trim() || agents.length === 0 || busy} onClick={() => setConfirmDispatch(true)}>预览并创建任务</Button></div></Card>}
      <div className="stack">{threads.map((thread) => <AgentWorkCard key={thread.id} work={{ id: thread.id, actor: thread.agent_id ? "数字员工" : "等待分派", humanOwner: me.identity.name, goal: thread.title, stage: clientStatusLabel(thread.status), progress: { completed: thread.progress_done, total: thread.progress_total || undefined, next: thread.status === "pending_review" ? "等待人类裁决" : thread.status === "failed" ? "查看失败原因并选择重试或接管" : undefined }, reason: `状态和进度来自当前工作区的任务事件；创建于 ${formatTime(thread.created_at)}。`, needsHuman: thread.status === "pending_review" ? { action: "审核当前结果", consequence: "未裁决前任务保持等待。" } : thread.status === "failed" ? { action: "选择重试、接管或停止", consequence: "任务不会被标记为完成。" } : undefined, risk: thread.status === "failed" ? "high" : thread.status === "pending_review" ? "medium" : "none", receipt: { requestId: thread.id }, recovery: "失败可重试，关键动作可由人类接管" }} />)}{threads.length === 0 && <AsyncState status="empty" title="暂无任务" description="创建任务后，可以在这里跟踪数字员工进度和异常。" />}</div>
      <Overlay open={confirmDispatch} title="确认创建任务" description="提交后系统会先判断信息是否充分；信息不足时只会反问，不会创建任务。" onClose={() => { if (!busy) setConfirmDispatch(false); }} dismissOnBackdrop={!busy} dismissOnEscape={!busy} footer={<><Button disabled={busy} onClick={() => setConfirmDispatch(false)}>取消</Button><Button variant="primary" busy={busy} onClick={() => void dispatch(agents)}>确认交给数字员工</Button></>}><div className="stack"><p><strong>任务目标：</strong>{title.trim()}</p><p><strong>首选执行者：</strong>{clientChineseText(agents[0]?.name, "尚无可用数字员工")}</p></div></Overlay>
    </>}</Resource>
  </div>;
}

function OperationsPage() {
  const loader = useCallback(async () => Promise.all([
    trpc.workspace.profile.query() as Promise<{ name: string; stage: string | null; archive?: unknown }>,
    trpc.inspection.status.query() as Promise<{ lastRunAt: string | null; totalChecks: number; okCount: number; attention: unknown[] }>,
    trpc.workspace.agents.query() as Promise<Array<{ name: string; status: string }>>,
  ]).then(([profile, inspection, agents]) => ({ profile, inspection, agents })), []);
  const resource = useResource(loader);
  return <div className="page"><PageHeading title="经营" description="行业内容由当前行业包生成；这里不使用任何默认行业兜底。" />
    <Resource state={resource.state} retry={resource.reload}>{({ profile, inspection, agents }) => <>
      <Card><p className="eyebrow">当前经营对象</p><h2>{profile.name || "当前工作区"}</h2><p className="item-copy">当前阶段：{profile.stage ? clientValueText(profile.stage) : "尚未设置"}。行业字段由已安装的行业包提供。</p></Card>
      <div className="metric-grid"><div className="metric"><span>巡检正常</span><strong>{inspection.okCount}/{inspection.totalChecks}</strong></div><div className="metric"><span>需要关注</span><strong>{inspection.attention.length}</strong></div><div className="metric"><span>数字员工</span><strong>{agents.length}</strong></div><div className="metric"><span>最近巡检</span><strong>{inspection.lastRunAt ? formatTime(inspection.lastRunAt) : "尚无"}</strong></div></div>
      <Card><h2>行业移动看板插槽</h2><p className="item-copy">已安装行业包可在此追加业务对象、阶段和受控快捷动作，但不能新增基础导航或覆盖公共组件。</p></Card>
    </>}</Resource>
  </div>;
}

function IndustryProjectionPage({ bundle, entry }: { bundle: MobileBundleProjection; entry: NavigationEntry }) {
  return <div className="page"><PageHeading title={clientChineseText(entry.title, "行业经营")} description={`${clientChineseText(bundle.bundleName, "当前行业包")}提供的移动经营视图。`} />
    <Card><h2>业务对象</h2><div className="chip-list">{bundle.ui.objects.map((item, index) => <span className="chip" key={`${item}-${index}`}>{clientChineseText(item, `业务对象 ${index + 1}`)}</span>)}{bundle.ui.objects.length === 0 && <p className="muted">当前行业包尚未配置移动业务对象。</p>}</div></Card>
    <Card><h2>常用流程</h2><div className="stack">{bundle.ui.workflows.map((item, index) => <div className="row" key={`${item}-${index}`}><span>{clientChineseText(item, `业务流程 ${index + 1}`)}</span><Badge tone="neutral">第 {index + 1} 步</Badge></div>)}{bundle.ui.workflows.length === 0 && <p className="muted">当前行业包尚未配置移动流程。</p>}</div></Card>
  </div>;
}

function LedgerPage({ modelsOnly = false }: { modelsOnly?: boolean }) {
  const loader = useCallback(async () => {
    const threads = ((await trpc.threads.list.query()) as ThreadRow[]).slice(0, 10);
    const batches = await Promise.all(threads.map(async (thread) => ((await trpc.threads.events.query({ threadId: thread.id, limit: 30 })) as Array<{ event_id: string; context?: { time?: string }; decision?: { action?: string }; receipt?: { synced?: boolean }; model_trace?: { model_id?: string; tier?: string; credits?: number } }>).map((event) => ({ ...event, thread }))));
    return batches.flat().filter((event) => !modelsOnly || event.model_trace).sort((a, b) => new Date(b.context?.time ?? 0).getTime() - new Date(a.context?.time ?? 0).getTime());
  }, [modelsOnly]);
  const resource = useResource(loader);
  return <div className="page"><PageHeading title={modelsOnly ? "模型路由" : "事件账本"} description={modelsOnly ? "查看任务实际使用的模型、档位和消耗证据。" : "查看谁在什么时间执行了什么，以及结果是否同步。"} />
    <Resource state={resource.state} retry={resource.reload} empty={(events) => events.length === 0}>{(events) => modelsOnly ? <div className="stack">{events.slice(0, 80).map((event) => <Card key={event.event_id}><div className="row"><h2>{event.model_trace?.model_id ? "已记录模型调用" : "模型待确认"}</h2><Badge tone={event.receipt?.synced ? "success" : "warning"}>{event.receipt?.synced ? "已同步" : "待核实"}</Badge></div><p className="item-copy">实际模型：{clientValueText(event.model_trace?.model_id)}；能力档位：{clientValueText(event.model_trace?.tier)}；积分：{clientValueText(event.model_trace?.credits)}。</p><div className="item-meta"><span>{event.thread.title}</span><span>{formatTime(event.context?.time)}</span><span>事件{clientIdentifierText(event.event_id)}</span></div></Card>)}</div> : <LedgerTimeline items={events.slice(0, 80).map((event) => ({ id: event.event_id, action: event.decision?.action ? "业务动作已记录" : "任务事件已记录", actor: event.thread.title, time: formatTime(event.context?.time), result: event.receipt?.synced ? "结果已同步到事件账本。" : "同步状态仍待核实。", verified: Boolean(event.receipt?.synced) }))} />}</Resource>
  </div>;
}

type TrustListKind = "exams" | "memory" | "night" | "guardrails" | "skills" | "agents" | "members";

function TrustListPage({ kind }: { kind: TrustListKind }) {
  const loader = useCallback(async () => {
    if (kind === "exams") return (await (trpc.service.eval as unknown as { listExams: { query: () => Promise<{ exams: unknown[] }> } }).listExams.query()).exams;
    if (kind === "memory") return await trpc.memory.list.query({ limit: 30 }) as unknown[];
    if (kind === "night") return [await trpc.nightShift.current.query()] as unknown[];
    if (kind === "guardrails") return await trpc.fence.rules.query() as unknown[];
    if (kind === "skills") return await trpc.skills.list.query() as unknown[];
    if (kind === "agents") return await trpc.workspace.agents.query() as unknown[];
    return await trpc.members.list.query() as unknown[];
  }, [kind]);
  const resource = useResource(loader);
  const labels = {
    exams: ["考试院", "查看考试版本、门禁状态和最近结果。"],
    memory: ["组织记忆", "查看当前工作区可见记忆；高影响编辑请在 PC 完成。"],
    night: ["夜班中心", "查看最近班次及是否需要人工介入。"],
    guardrails: ["围栏规则", "查看自动、待审与阻断规则。"],
    skills: ["技能中心", "查看当前工作区可用的数字员工技能。"],
    agents: ["数字员工", "查看当前工作区已装配的数字员工。"],
    members: ["成员", "查看当前工作区成员和角色。"],
  } as const;
  return <div className="page"><PageHeading title={labels[kind][0]} description={labels[kind][1]} />
    <Resource state={resource.state} retry={resource.reload} empty={(items) => items.length === 0}>{(items) => <div className="stack">{items.map((item, index) => {
      const row = item as Record<string, unknown>;
      const description = typeof row.description === "string" ? row.description : "";
      const chineseDescriptionTitle = clientChineseText(/^([^。]{2,18})。/.exec(description)?.[1], "");
      const rawTitle = String(row.name ?? row.title ?? row.display_name ?? row.runDate ?? "");
      const title = chineseDescriptionTitle || clientChineseText(rawTitle, `第 ${index + 1} 项`);
      const status = String(row.status ?? (row.configured === false ? "inactive" : "active"));
      return <Card key={String(row.id ?? row.memory_id ?? row.exam_id ?? index)}><div className="row"><h2>{title}</h2><Badge tone={status === "failed" ? "danger" : status === "active" || status === "passed" ? "success" : "neutral"}>{clientStatusLabel(status)}</Badge></div><p className="item-copy">详情已按业务摘要展示；内部字段和值不会直接释放到客户端。</p></Card>;
    })}</div>}</Resource>
  </div>;
}

function AccountPage({ navigate, onLogout, me, entries, partner, scope, availableScopes, onSelectScope }: {
  navigate: (path: string) => void;
  onLogout: () => void;
  me: Me;
  entries: readonly NavigationEntry[];
  partner: boolean;
  scope: { tenantId: string; workspaceId: string };
  availableScopes: readonly AccessScopeOption[];
  onSelectScope: (scope: AccessScopeOption) => void;
}) {
  const loader = useCallback(async () => ({
    me,
    memberships: partner ? [] : await trpc.accounts.my.memberships.query() as unknown as Array<{ workspace_id?: string; workspace_name?: string; tenant_name?: string; role?: string }>,
  }), [me, partner]);
  const resource = useResource(loader);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const logout = async () => {
    setLogoutBusy(true);
    await logoutSession().catch(() => undefined);
    onLogout();
  };
  const links = [
    ["事件账本", "/events", "ledger"], ["考试院", "/exams", "exam"], ["组织记忆", "/memory", "memory"],
    ["夜班中心", "/night", "night"], ["模型路由", "/models", "model"], ["围栏规则", "/guardrails", "rules"],
    ["数字员工", "/agents", "agents"], ["成员", "/members", "team"],
  ] as const;
  const permittedPaths = new Set(permittedBMobileRoutes(links.map(([, path]) => path), entries));
  const visibleLinks = links.filter(([, path]) => permittedPaths.has(path));
  return <div className="page"><PageHeading title="我的" description="身份、工作区、通知与治理入口。" />
    <Resource state={resource.state} retry={resource.reload}>{({ me, memberships }) => <>
      <Card><div className="row"><div><h2>{me.identity.name}</h2><p className="item-copy">{ROLE_LABELS[me.identity.role] ?? "成员"} · {me.identity.plan === "community" ? "社区版" : "已开通版本"}</p></div><Badge tone={me.identity.memberNo === "GUEST" ? "warning" : "success"}>{me.identity.memberNo === "GUEST" ? "只读示例" : "身份已验证"}</Badge></div></Card>
      {partner
        ? <Card><h2>授权工作区</h2><p className="item-copy">列表来自服务端实时有效授权；切换时会再次校验授权状态。</p><div className="stack">{availableScopes.map((option) => {
          const selected = option.tenantId === scope.tenantId && option.workspaceId === scope.workspaceId;
          return <button className="drawer-link" aria-current={selected ? "page" : undefined} disabled={selected} key={`${option.tenantId}:${option.workspaceId}`} onClick={() => onSelectScope(option)}><span>{option.workspaceName || clientIdentifierText(option.workspaceId)}{option.tenantName ? ` · ${option.tenantName}` : ""}</span><Badge tone={selected ? "success" : "neutral"}>{selected ? "当前" : "切换"}</Badge></button>;
        })}</div></Card>
        : <Card><h2>我的工作区</h2><div className="stack">{memberships.map((membership, index) => <div className="row" key={membership.workspace_id ?? index}><span>{membership.workspace_name ?? "工作区"}{membership.tenant_name ? ` · ${membership.tenant_name}` : ""}</span><span className="muted">{ROLE_LABELS[membership.role ?? ""] ?? "成员"}</span></div>)}{memberships.length === 0 && <p className="muted">示例身份没有可切换的正式工作区。</p>}</div></Card>}
      {visibleLinks.length > 0 && <Card><h2>治理与自动化</h2><div className="stack">{visibleLinks.map(([title, path, icon]) => <button className="drawer-link" key={path} onClick={() => navigate(path)}><Icon name={icon} /><span>{title}</span><Icon name="chevron" size={16} style={{ marginLeft: "auto" }} /></button>)}</div></Card>}
      <Button variant="danger" busy={logoutBusy} onClick={() => void logout()}>退出登录</Button>
    </>}</Resource>
  </div>;
}

function NotFound({ navigate }: { navigate: (path: string) => void }) {
  return <div className="page"><AsyncState status="empty" title="页面不存在" description="该地址没有对应页面，可能是旧链接或权限发生变化。" action={<Button onClick={() => navigate("/")}>返回今日</Button>} /></div>;
}

function MobileApp({ onLogout }: { onLogout: () => void }) {
  const { pathname, navigate } = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [requestedScope, setRequestedScope] = useState<Pick<AccessScopeOption, "tenantId" | "workspaceId"> | undefined>();
  const meLoader = useCallback(async () => {
    const access = await trpc.access.me.query(requestedScope) as MobileAccess;
    const me: Me = {
      identity: {
        name: access.subject.name,
        role: access.subject.role,
        memberNo: access.subject.memberNo ?? "",
        plan: access.plan,
        workspaceId: access.scope.workspaceId,
      },
      capabilities: access.capabilities,
    };
    return { me, access, bundle: access.bundle };
  }, [requestedScope]);
  const meResource = useResource(meLoader);
  useEffect(() => {
    if (requestedScope && meResource.state.status === "error" && meResource.state.kind === "forbidden") {
      setRequestedScope(undefined);
      return;
    }
    if (meResource.state.status === "error" && meResource.state.kind === "unauthorized") {
      clearSession();
      onLogout();
    }
  }, [meResource.state, onLogout, requestedScope]);
  const shellData = meResource.state.status === "ready" ? meResource.state.data : undefined;
  const me = shellData?.me;
  const activeBundle = shellData?.bundle.configured ? shellData.bundle : undefined;
  const bundleNavigation = useMemo(() => {
    try {
      return {
        entries: activeBundle ? navigationEntriesFromBundle(activeBundle.bundleId, activeBundle.ui.navigation.slots) : [],
        failed: false,
      };
    } catch {
      return { entries: [] as NavigationEntry[], failed: true };
    }
  }, [activeBundle]);
  const bundleEntries = bundleNavigation.entries;
  const permissions = useMemo(() => {
    return new Set(shellData?.access.navigationPermissions ?? []);
  }, [shellData?.access.navigationPermissions]);
  const actionPermissions = useMemo(() => new Set(shellData?.access.actionPermissions ?? []), [shellData?.access.actionPermissions]);
  const navEntries = useMemo(() => composeNavigation({ client: "b-mobile", permissions, bundleEntries }), [permissions, bundleEntries]);
  const primaryTabs = useMemo(() => B_MOBILE_PRIMARY_TABS.filter((tab) => isBMobileRoutePermitted(tab.id, navEntries)), [navEntries]);
  const currentTitle = clientChineseText(B_MOBILE_PRIMARY_TABS.find((tab) => tab.id === pathname)?.label ?? navEntries.find((entry) => isNavigationActive(entry, pathname))?.title, "移动工作台");
  const renderPage = () => {
    if (meResource.state.status === "loading") return <AsyncState status="loading" title="正在确认访问范围" description="服务端授权返回前不会打开业务页面。" />;
    if (meResource.state.status === "error") return <AsyncState status="error" title="暂时无法确认访问范围" description="为避免误入其他工作区，权限恢复前不会打开业务页面。" onRetry={meResource.reload} />;
    const industryEntry = navEntries.find((entry) => entry.source.startsWith("bundle:") && isNavigationActive(entry, pathname));
    if (industryEntry && activeBundle) return <IndustryProjectionPage bundle={activeBundle} entry={industryEntry} />;
    if (!isBMobileRoute(pathname)) return <NotFound navigate={navigate} />;
    if (!isBMobileRoutePermitted(pathname, navEntries)) {
      return <AsyncState status="forbidden" title="当前身份不能访问此页面" description="该入口受当前工作区角色、套餐或伙伴授权限制。权限变化后可重新刷新。" action={<Button onClick={() => navigate(primaryTabs[0]?.id ?? "/")}>返回可用页面</Button>} />;
    }
    if (pathname === "/" && me) return <TodayPage navigate={navigate} me={me} entries={navEntries} />;
    if (pathname === "/inbox" || pathname === "/approvals") return <ApprovalsPage canDecide={actionPermissions.has("approval.decide")} />;
    if (pathname === "/tasks") return <TasksPage canDispatch={actionPermissions.has("task.dispatch")} />;
    if (pathname === "/operations" || pathname === "/reports" || pathname === "/executive") return <OperationsPage />;
    if (pathname === "/account" && me && shellData) return <AccountPage navigate={navigate} onLogout={onLogout} me={me} entries={navEntries} partner={shellData.access.subject.kind === "partner"} scope={shellData.access.scope} availableScopes={shellData.access.availableScopes} onSelectScope={(option) => setRequestedScope({ tenantId: option.tenantId, workspaceId: option.workspaceId })} />;
    if (pathname === "/events") return <LedgerPage />;
    if (pathname === "/models") return <LedgerPage modelsOnly />;
    if (["/exams", "/memory", "/night", "/guardrails", "/skills", "/agents", "/members"].includes(pathname)) return <TrustListPage kind={pathname.slice(1) as TrustListKind} />;
    return <NotFound navigate={navigate} />;
  };
  const groups = NAVIGATION_GROUP_ORDER.map((group) => [group, navEntries.filter((entry) => entry.group === group)] as const).filter(([, entries]) => entries.length);
  return <AppShell
    className="mobile-shell"
    data-workloom-client="b-mobile"
    navigationMode="bottom"
    mainLabel={currentTitle}
    topBar={<TopContextBar
      className="mobile-header"
      title={currentTitle}
      description={`${me?.identity.name ?? "正在确认身份"} · ${me?.identity.memberNo === "GUEST" ? "只读示例" : "当前工作区"}`}
      leading={<IconButton icon="menu" label="打开主导航" onClick={() => setDrawer(true)} />}
      actions={<IconButton icon="reset" label="刷新当前页面" onClick={() => window.location.reload()} />}
    />}
    bottomTabs={<BottomTabs
      className="mobile-bottom-tabs"
      label="常用页面"
      items={primaryTabs}
      activeId={pathname}
      onSelect={(tab) => navigate(tab.id)}
    />}
  >
    {meResource.state.status === "error" && <div className="status-strip" role="alert">身份暂时无法确认，受保护导航已收起。<Button variant="quiet" onClick={meResource.reload}>重新确认</Button></div>}
    {shellData?.bundle.configured === false && shellData.bundle.failed && <div className="status-strip" role="alert">行业界面未通过安全加载，当前仅显示基座能力。<Button variant="quiet" onClick={meResource.reload}>重新加载</Button></div>}
    {bundleNavigation.failed && <div className="status-strip" role="alert">行业导航配置未通过校验，当前仅显示公共能力。<Button variant="quiet" onClick={meResource.reload}>重新加载</Button></div>}
    {renderPage()}
    <Drawer
      open={drawer}
      side="left"
      title="主导航"
      description="当前工作区的全部可用页面"
      closeLabel="关闭主导航"
      onClose={() => setDrawer(false)}
      footer={<><Button onClick={() => { navigate("/account"); setDrawer(false); }}>个人与帮助</Button><Button variant="quiet" onClick={() => setDrawer(false)}>收起导航</Button></>}
    >
      <nav aria-label="全部页面">{groups.map(([group, entries]) => <div className="drawer-group" key={group}><strong>{NAVIGATION_GROUP_LABELS[group]}</strong>{entries.map((entry: NavigationEntry) => <button className="drawer-link" aria-current={isNavigationActive(entry, pathname) ? "page" : undefined} key={entry.capabilityId} onClick={() => { navigate(entry.route); setDrawer(false); }}><Icon name={entry.icon} /><span>{clientChineseText(entry.title, "行业页面")}</span></button>)}</div>)}</nav>
    </Drawer>
  </AppShell>;
}

export default function App() {
  const [auth, setAuth] = useState<"checking" | "ready" | "signed-out">("checking");
  useEffect(() => { void restoreSession().then((ok) => setAuth(ok ? "ready" : "signed-out")); }, []);
  if (auth === "checking") return <main className="auth-page"><AsyncState status="loading" title="正在恢复工作区" description="身份确认完成前不会显示任何业务数据。" /></main>;
  if (auth === "signed-out") return <Auth onReady={() => setAuth("ready")} />;
  return <MobileApp onLogout={() => setAuth("signed-out")} />;
}
