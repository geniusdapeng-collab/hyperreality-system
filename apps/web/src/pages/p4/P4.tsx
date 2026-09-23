/**
 * P4 审批中心（F7：待办收件箱 · 统一审查面板；PRD P4-①②③④⑤ 逐条对账）
 *  - 队列=approvals 表统一投影（F5.1 全来源）；分级：高风险、越围栏必审、其余逐步审
 *  - 选中展开原生审批卡：diff 对照表（前删线/后高亮，P4E1）+ 命中规则随行 + 影响面 + 执行回执位说明 + 三手势（P4E2）
 *  - 为什么这样改（P4E3）：依据事件 #E / 引用记忆 / 模型档与积分全展示（事件库投影 F1.12，关键数字来自回执 L3.6）
 *  - p4_conflict 异常态：快照过期/对象被后续动作修改 → 红条告警 + 刷新再审（E5.3/F2.7；sweep 后重载）
 *  - 空态：全部审完 → 「今日待办消息已清空」+ 手势统计（p4_empty，F5.5/F1.7 驳回原因进偏好模式）
 * 权限态：无审批权隐藏手势，diff 只读（E2.6/L5.1）；批量仅低风险（G6 二次确认）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AgentAvatarOf } from "../../components/AgentAvatar";
import {
  APPROVAL_STATUS_TEXT,
  MODEL_TIER_TEXT,
  MODEL_WINDOW_TEXT,
  OBJECT_TYPE_TEXT,
  RULE_RESULT_TEXT,
  actionText,
  actorText,
  dictText,
  shortId,
  payloadText,
  versionText,
} from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import {
  BannerAlert,
  EmptyState,
  TriGestureBar,
  type Gesture,
} from "../../components/hud";
import { RejectDialog } from "../../components/RejectDialog";
import { AsyncState, Button, DecisionPackage, Icon, Overlay, Textarea } from "@workloom/ui";
import { operationFailure, toUiFailure } from "../../lib/ui-state";
import { useNavigationAccess } from "../../shell/NavigationAccess";

interface BizEvent {
  event_id: string;
  who: { id: string; version?: string };
  object: { type: string; id?: string };
  decision: { action: string; before?: unknown; after?: unknown; memory_refs?: string[] };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  receipt?: { synced?: boolean };
}
interface ApprovalRow {
  approval_id: string; event_id: string; channel: string; status: string;
  snapshot: { before?: unknown; after?: unknown; expires_at?: string; high_risk?: boolean };
  created_at: string;
  event?: BizEvent;
}

/** 队列分级只使用服务端已有风险证据，不把 high_risk 伪装成尚未实现的“双人审批”。 */
function tierOf(a: ApprovalRow): "高风险" | "必审" | "逐步审" {
  if (a.snapshot.high_risk) return "高风险";
  if (a.event?.rule_impact?.some((r) => r.result === "review")) return "必审";
  return "逐步审";
}

function isConflict(a: ApprovalRow): boolean {
  return a.status === "pending" && !!a.snapshot.expires_at && new Date(a.snapshot.expires_at).getTime() < Date.now();
}

export default function P4() {
  const { canAction } = useNavigationAccess();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadMessage, setLoadMessage] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [batchArmed, setBatchArmed] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<ApprovalRow | null>(null);
  const [editTarget, setEditTarget] = useState<ApprovalRow | null>(null);
  const [editText, setEditText] = useState("");
  const [editKind, setEditKind] = useState<"correction" | "preference">("correction");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const loadSequence = useRef(0);

  const load = useCallback(async (background = false) => {
    const requestId = ++loadSequence.current;
    if (!background) setLoadState("loading");
    try {
      await ensureDemoLogin();
      const ap = await trpc.approvals.list.query() as ApprovalRow[];
      if (requestId !== loadSequence.current) return;
      setApprovals(ap);
      setSelectedId((cur) => {
        const currentPending = ap.some((a) => a.approval_id === cur && a.status === "pending");
        return currentPending ? cur : ap.find((a) => a.status === "pending")?.approval_id ?? null;
      });
      setHasSnapshot(true);
      setLoadMessage("");
      setLoadState("ready");
    } catch (error) {
      if (requestId !== loadSequence.current) return;
      console.warn("读取审批队列失败", error);
      const failure = toUiFailure(error);
      setLoadMessage(operationFailure(error, "读取审批队列"));
      setLoadState(failure.kind === "forbidden" ? "forbidden" : "error");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 10000); // 其余 10s（D6）
    return () => { clearInterval(t); loadSequence.current += 1; };
  }, [load]);

  const canApprove = loadState === "ready" && canAction("approval.decide");
  const pending = approvals.filter((a) => a.status === "pending");
  const batchable = pending.filter((a) => !a.snapshot.high_risk && !isConflict(a));
  const conflicts = pending.filter(isConflict);
  const selected = approvals.find((a) => a.approval_id === selectedId) ?? null;
  const gestureStats = useMemo(() => ({
    approved: approvals.filter((a) => a.status === "approved").length,
    edited: approvals.filter((a) => a.status === "edited").length,
    rejected: approvals.filter((a) => a.status === "rejected").length,
  }), [approvals]);

  const gesture = useCallback(async (a: ApprovalRow, g: Gesture) => {
    if (busy) return;
    if (g === "reject") {
      // M1.2（D24）：驳回必须选择行业受控枚举（弹窗），自由文本只做补充——结构化原因是校准信号的前提
      setRejectTarget(a);
      return;
    }
    if (g === "edit") {
      setEditTarget(a);
      setEditText(payloadText(a.snapshot.after ?? a.event?.decision.after ?? "", 500));
      setEditKind("correction");
      return;
    }
    setBusy(`gesture-${a.approval_id}`);
    setActionError("");
    try {
      const result = await trpc.approvals.decide.mutate({ approvalId: a.approval_id, gesture: g }) as { deduped: boolean; gestureEventId?: string };
      const receipt = result.gestureEventId ? `，账本事件 ${shortId(result.gestureEventId)}` : "";
      setBanner({ level: "info", text: result.deduped ? "该审批已在此前完成，本次未重复执行。" : `审批决定已写入事件账本${receipt}；外部动作仍以执行回执为准。` });
      await load(true);
    } catch (error) {
      console.warn("提交审批决定失败", error);
      setActionError(operationFailure(error, "审批提交"));
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  /** 驳回弹窗提交（M1.2 受控枚举 + L5.2 留痕） */
  const submitReject = useCallback(async (r: { reasonEnum: string; reasonText?: string }) => {
    if (!rejectTarget || busy) return;
    const target = rejectTarget;
    setBusy(`reject-${target.approval_id}`);
    setActionError("");
    try {
      const result = await trpc.approvals.decide.mutate({
        approvalId: target.approval_id,
        gesture: "reject",
        reasonEnum: r.reasonEnum,
        reasonText: r.reasonText,
      }) as { deduped: boolean; gestureEventId?: string };
      setRejectTarget(null);
      setBanner({ level: "info", text: result.deduped ? "该审批已在此前完成，本次未重复执行。" : `驳回决定已写入事件账本${result.gestureEventId ? `，事件 ${shortId(result.gestureEventId)}` : ""}。` });
      await load(true);
    } catch (error) {
      console.warn("驳回审批失败", error);
      setActionError(operationFailure(error, "驳回提交"));
    } finally {
      setBusy(null);
    }
  }, [rejectTarget, busy, load]);

  const submitEdit = useCallback(async () => {
    if (!editTarget || !editText.trim() || busy) return;
    const target = editTarget;
    setBusy(`edit-${target.approval_id}`);
    setActionError("");
    try {
      const result = await trpc.approvals.decide.mutate({
        approvalId: target.approval_id,
        gesture: "edit",
        editedAfter: editText.trim(),
        editKind,
      }) as { deduped: boolean; gestureEventId?: string };
      setEditTarget(null);
      setBanner({ level: "info", text: result.deduped ? "该审批已在此前完成，本次未重复执行。" : `校准后的决定已写入事件账本${result.gestureEventId ? `，事件 ${shortId(result.gestureEventId)}` : ""}；外部动作仍以执行回执为准。` });
      await load(true);
    } catch (error) {
      console.warn("编辑后采纳失败", error);
      setActionError(operationFailure(error, "校准提交"));
    } finally {
      setBusy(null);
    }
  }, [editKind, editTarget, editText, busy, load]);

  const doBatch = useCallback(async () => {
    if (busy || batchable.length === 0) return;
    setBusy("batch");
    setActionError("");
    try {
      const r = await trpc.approvals.batchApprove.mutate({ approvalIds: batchable.map((a) => a.approval_id) }) as { approved: string[]; skipped: unknown[] };
      setBatchArmed(false);
      setBanner({ level: r.skipped.length > 0 ? "warn" : "info", text: `服务端回执：已逐条记录 ${r.approved.length} 项；${r.skipped.length} 项未执行，请刷新后复核。` });
      await load(true);
    } catch (error) {
      console.warn("批量审批失败", error);
      setActionError(operationFailure(error, "批量审批"));
    } finally {
      setBusy(null);
    }
  }, [batchable, busy, load]);

  /** p4_conflict 刷新再审（E5.3：sweep 过期项 + 重载最新快照） */
  const refreshConflict = useCallback(async () => {
    if (busy) return;
    setBusy("refresh");
    setActionError("");
    try {
      await trpc.approvals.sweep.mutate();
      setBanner({ level: "info", text: "过期快照已由服务端标记，请基于刷新后的内容重新审核。" });
      await load(true);
    } catch (error) {
      console.warn("刷新审批快照失败", error);
      setActionError(operationFailure(error, "快照刷新"));
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  /* ---------- 左栏：待办队列（分级） ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">待办收件箱</div>
      {(["高风险", "必审", "逐步审"] as const).map((tier) => {
        const items = pending.filter((a) => tierOf(a) === tier);
        if (items.length === 0) return null;
        return (
          <div key={tier} className="mb-3">
            <div className="mb-1.5 px-1 text-body tracking-wider text-ink3">{tier} · {items.length}</div>
            {items.map((a) => (
              <button
                key={a.approval_id}
                type="button"
                onClick={() => setSelectedId(a.approval_id)}
                className={`mb-1.5 block w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left ${
                  selectedId === a.approval_id ? "border-gline bg-gold/6" : "border-line bg-card hover:border-gline"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="break-all font-mono text-body text-ink3">{shortId(a.approval_id)}</span>
                  <span className={`rounded border px-1 py-0.5 text-body ${
                    tier === "高风险" ? "border-need/50 text-need" : tier === "必审" ? "border-warn/50 text-warn" : "border-line text-ink3"
                  }`}>{tier}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-body text-ink2">
                  {a.event && <AgentAvatarOf name={actorText(a.event.who.id)} size={18} ring={false} />}
                  <span>{a.event ? `${actorText(a.event.who.id)} · ${actionText(a.event.decision.action)}` : shortId(a.event_id)}</span>
                </div>
                {isConflict(a) && <div className="mt-0.5 inline-flex items-center gap-1 text-body text-alert"><Icon name="warning" size={13} />快照已过期</div>}
                {/* 清单先说清截止时间：超时不自动放行（保持未批准），避免"以为系统会自己处理" */}
                {!isConflict(a) && a.status === "pending" && a.snapshot.expires_at && (
                  <div className="mt-0.5 text-body text-ink3">请于 {new Date(a.snapshot.expires_at).toLocaleString("zh-CN", { hour12: false })} 前处理 · 超时保持未批准，不会自动放行</div>
                )}
              </button>
            ))}
          </div>
        );
      })}
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="text-body font-bold text-holo">今日已审</div>
        <div className="mt-1 font-mono text-body text-ink2">
          采纳 {gestureStats.approved} · 编辑后采纳 {gestureStats.edited} · 驳回 {gestureStats.rejected}
        </div>
        <div className="mt-0.5 text-body text-ink3">驳回原因会用于后续提案校准</div>
      </div>
    </>
  );

  /* ---------- 右栏：为什么这样改（WhyPanel）+ IM 同步 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">审批依据</div>
      {selected?.event ? (
        <>
          <div className="mb-3 rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">为什么这样改</div>
            <div className="space-y-1 font-mono text-body text-ink2">
              <div>依据事件 <span className="text-holo">{shortId(selected.event.event_id)}</span></div>
              <div>发起 {actorText(selected.event.who.id)} · {versionText(selected.event.who.version)}</div>
              {selected.event.model_trace && (
                <div>
                  {dictText(MODEL_TIER_TEXT, selected.event.model_trace.tier ?? "standard")} · {dictText(MODEL_WINDOW_TEXT, selected.event.model_trace.window)} ·{" "}
                  {selected.event.model_trace.credits ?? 0} 积分
                </div>
              )}
              {(selected.event.decision.memory_refs ?? []).length > 0 && <div>引用组织经验 <span className="text-holo2">{selected.event.decision.memory_refs?.length} 条</span></div>}
              {selected.event.rule_impact.map((r) => (
                <div key={r.rule_id} className={r.result === "pass" ? "text-go" : r.result === "review" ? "text-warn" : "text-alert"}>
                  规则 {shortId(r.rule_id)} · {versionText(r.version)} · {dictText(RULE_RESULT_TEXT, r.result)}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">审批投递状态</div>
            <div className="text-body text-ink2">已进入{selected.channel === "inapp" ? "站内待办" : "审批队列"} · 当前状态 {dictText(APPROVAL_STATUS_TEXT, selected.status)}</div>
            <div className="mt-1 text-body text-ink3">
              审批编号 {shortId(selected.approval_id)} · 当前数据未提供外部渠道送达回执，因此不标记为已送达
            </div>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-line bg-card p-3 text-body text-ink3">选中左侧待办查看决策链路</div>
      )}
    </>
  );

  return (
    <Bridge
      left={hasSnapshot ? left : <AsyncState status={loadState === "error" ? "error" : loadState === "forbidden" ? "forbidden" : "loading"} description={loadMessage || undefined} onRetry={loadState === "error" ? () => void load() : undefined} />}
      right={hasSnapshot ? right : <AsyncState status="loading" title="审批依据尚未就绪" description="队列加载完成后再显示决策依据。" />}
    >
      <div className="flex min-h-full flex-col">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-h1 font-black tracking-wider">审批中心</h2>
          <span className="flex-1" />
          {canApprove && batchable.length > 0 && (
            <button type="button" disabled={Boolean(busy)} onClick={() => setBatchArmed(true)}
                className="cursor-pointer rounded-lg gold-grad px-3.5 py-1.5 text-body font-extrabold text-ongold">
                批量采纳低风险（{batchable.length}）
              </button>
          )}
        </div>

        {loadState !== "ready" && hasSnapshot && <div className="mb-3"><BannerAlert level="warn" actionLabel="重新加载" onAction={() => void load()}>{loadMessage} 正在显示上一次成功快照，不代表当前没有新审批。</BannerAlert></div>}
        {actionError && <div className="mb-3"><BannerAlert level="alert" actionLabel="关闭" onAction={() => setActionError("")}>{actionError}</BannerAlert></div>}
        {banner && <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>}

        {/* p4_conflict 异常态（E5.3/F2.7：红条告警 + 刷新再审） */}
        {conflicts.length > 0 && (
          <div className="mb-3">
            <BannerAlert level="alert" actionLabel="刷新最新快照" onAction={() => void refreshConflict()}>
              {conflicts.length} 条审批对象已被后续动作修改或快照过期，禁止基于旧内容审批。
            </BannerAlert>
          </div>
        )}

        {!hasSnapshot ? (
          <AsyncState
            status={loadState === "forbidden" ? "forbidden" : loadState === "error" ? "error" : "loading"}
            description={loadMessage || undefined}
            onRetry={loadState === "error" ? () => void load() : undefined}
          />
        ) : pending.length === 0 && !selected ? (
          /* p4_empty（F5.5） */
          <EmptyState
            icon={<Icon name="check" size={24} />}
            title="今日待办消息已清空"
            hint={`手势统计：采纳 ${gestureStats.approved} · 编辑后采纳 ${gestureStats.edited} · 驳回 ${gestureStats.rejected}`}
          />
        ) : !selected ? (
          <EmptyState icon={<Icon name="approval" size={24} />} title="选中左侧待办项" hint="单击队列条目展开原生审批卡" />
        ) : (
          <DecisionPackage
            decision={{
              title: `${selected.status === "pending" ? "待我审批" : "审批记录"} · ${dictText(APPROVAL_STATUS_TEXT, selected.status)}`,
              action: selected.event ? actionText(selected.event.decision.action) : "待确认事项",
              summary: selected.event ? `由${actorText(selected.event.who.id)}发起，需要根据证据和影响范围作出裁决。` : "审批事件详情尚未完整同步，请先核对信息。",
              before: <span className="line-through">{payloadText(selected.snapshot.before ?? selected.event?.decision.before ?? null, 120) || "无调整前内容"}</span>,
              after: payloadText(selected.snapshot.after ?? selected.event?.decision.after ?? null, 120) || "无调整后内容",
              evidence: selected.event?.rule_impact.map((rule) => ({ title: `安全规则判断：${dictText(RULE_RESULT_TEXT, rule.result)}`, detail: versionText(rule.version), source: `规则 ${shortId(rule.rule_id)}` })) ?? [],
              risk: tierOf(selected) === "高风险" ? "high" : tierOf(selected) === "必审" ? "medium" : "low",
              fence: selected.event?.rule_impact.length ? `命中 ${selected.event.rule_impact.length} 条安全规则` : "未返回安全规则明细，仍需人工确认",
              memory: selected.event?.decision.memory_refs?.length ? `引用 ${selected.event.decision.memory_refs.length} 条组织经验` : "未引用组织经验",
              model: selected.event?.model_trace?.model_id,
              impact: selected.event ? `${dictText(OBJECT_TYPE_TEXT, selected.event.object.type)}${selected.event.object.id ? `「${shortId(selected.event.object.id)}」` : ""}` : "影响范围待确认",
              rollback: selected.event?.receipt?.synced ? "动作已有同步回执；如需撤回，请从对应账本事件发起受控回滚。" : "外部生效尚未确认；审批后仍需核对执行回执。",
              eventId: selected.event_id,
            }}
            actions={selected.status === "pending" && canApprove ? (
              isConflict(selected) ? (
                <div className="rounded-lg border border-alert/50 bg-alert/8 px-4 py-2.5 text-body text-alert">
                  快照已过期或对象已被修改，请先刷新最新内容再审批。
                </div>
              ) : (
                <TriGestureBar busy={busy === `gesture-${selected.approval_id}`} onGesture={(g) => void gesture(selected, g)} />
              )
            ) : undefined}
          />
        )}
      </div>
      <RejectDialog
        open={rejectTarget !== null}
        mode="reject"
        busy={busy === `reject-${rejectTarget?.approval_id}`}
        onCancel={() => setRejectTarget(null)}
        onSubmit={(r) => void submitReject(r)}
      />
      <Overlay
        open={editTarget !== null}
        title="校准后采纳"
        description="修改后的内容和归因类型会写入审批账本；提交前不会产生任何变更。"
        onClose={() => { if (!busy) setEditTarget(null); }}
        dismissOnBackdrop={!busy}
        dismissOnEscape={!busy}
        footer={<><Button variant="quiet" disabled={Boolean(busy)} onClick={() => setEditTarget(null)}>取消</Button><Button variant="primary" busy={busy === `edit-${editTarget?.approval_id}`} disabled={!editText.trim()} onClick={() => void submitEdit()}>确认校准并采纳</Button></>}
      >
        <div className="space-y-3">
          <Textarea
            label="修改后的业务内容"
            description="最多 500 个字；提交后会与本次校准类型一并写入审批账本。"
            required
            className="min-h-28 bg-bg800 text-ink"
            maxLength={500}
            value={editText}
            disabled={Boolean(busy)}
            onChange={(event) => setEditText(event.target.value)}
          />
          <fieldset disabled={Boolean(busy)}><legend className="mb-2 text-body text-ink2">本次校准属于</legend><div className="flex flex-wrap gap-2"><Button variant={editKind === "correction" ? "primary" : "secondary"} onClick={() => setEditKind("correction")}>事实或数据纠错</Button><Button variant={editKind === "preference" ? "primary" : "secondary"} onClick={() => setEditKind("preference")}>风格或偏好调整</Button></div></fieldset>
        </div>
      </Overlay>
      <Overlay
        open={batchArmed}
        title="确认批量采纳"
        description="批量操作会逐条写入审批账本；外部动作仍需等待各自执行回执。"
        onClose={() => { if (!busy) setBatchArmed(false); }}
        dismissOnBackdrop={!busy}
        dismissOnEscape={!busy}
        footer={<><Button variant="quiet" disabled={Boolean(busy)} onClick={() => setBatchArmed(false)}>取消</Button><Button variant="primary" busy={busy === "batch"} onClick={() => void doBatch()}>确认采纳 {batchable.length} 项</Button></>}
      >
        <p>本次仅包含非高风险待办，共 {batchable.length} 项；高风险和快照冲突项不会进入批量操作。提交后请根据服务端返回的成功数和未执行数复核。</p>
      </Overlay>
    </Bridge>
  );
}
