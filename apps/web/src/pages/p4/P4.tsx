/**
 * P4 审批中心（F7：待办收件箱 · 统一审查面板；PRD P4-①②③④⑤ 逐条对账）
 *  - 队列=approvals 表统一投影（F5.1 全来源）；分级：高危→双人（F5.4/L2.6）、越围栏 review→必审、其余→逐步审
 *  - 选中展开原生审批卡：diff 对照表（前删线/后高亮，P4E1）+ 命中规则随行 + 影响面 + 执行回执位说明 + 三手势（P4E2）
 *  - 为什么这样改（P4E3）：依据事件 #E / 引用记忆 / 模型档与积分全展示（事件库投影 F1.12，关键数字来自回执 L3.6）
 *  - p4_conflict 异常态：快照过期/对象被后续动作修改 → 红条告警 + 刷新再审（E5.3/F2.7；sweep 后重载）
 *  - 空态：全部审完 → 「今日待办消息已清空」+ 手势统计（p4_empty，F5.5/F1.7 驳回原因进偏好模式）
 * 权限态：无审批权隐藏手势，diff 只读（E2.6/L5.1）；批量仅低风险（G6 二次确认）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AgentAvatarOf } from "../../components/AgentAvatar";
import { APPROVAL_STATUS_TEXT, actionText, dictText, shortId , payloadText } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import {
  BannerAlert,
  EmptyState,
  EventIdChip,
  SkeletonBlock,
  TriGestureBar,
  type Gesture,
} from "../../components/hud";
import { actionLabel, agentOfApproval } from "../../components/hud/gateAgentMap";
import { RejectDialog } from "../../components/RejectDialog";

interface BizEvent {
  event_id: string;
  who: { id: string; version?: string };
  object: { type: string; id?: string };
  decision: { action: string; before?: unknown; after?: unknown; memory_refs?: string[]; basis?: string[] };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  receipt?: { synced?: boolean };
}
interface ApprovalRow {
  approval_id: string; event_id: string; channel: string; status: string;
  snapshot: {
    before?: unknown; after?: unknown; expires_at?: string; high_risk?: boolean;
    /** 依据链（治理 §九.3；存在即可展开渲染） */
    basis?: string[]; contentMd?: string;
    /** 成本预估（渲染类快照可能携带；缺则「待估算」） */
    estimate_credits?: number; estimate_cost?: string;
  };
  created_at: string;
  event?: BizEvent;
}

/** 分级（P4E5：必审/逐步审/双人——越批量阈值强制双人 F5.4/L2.6） */
function tierOf(a: ApprovalRow): "双人" | "必审" | "逐步审" {
  if (a.snapshot.high_risk) return "双人";
  if (a.event?.rule_impact?.some((r) => r.result === "review")) return "必审";
  return "逐步审";
}

function isConflict(a: ApprovalRow): boolean {
  return a.status === "pending" && !!a.snapshot.expires_at && new Date(a.snapshot.expires_at).getTime() < Date.now();
}

export default function P4() {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState("owner");
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [batchArmed, setBatchArmed] = useState(false);
  const [basisOpen, setBasisOpen] = useState(false); // 依据链展开（选中项切换时收起）
  const [rejectTarget, setRejectTarget] = useState<ApprovalRow | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [meR, ap] = await Promise.all([
        trpc.members.me.query() as Promise<{ identity: { role: string } }>,
        trpc.approvals.list.query() as Promise<ApprovalRow[]>,
      ]);
      setRole(meR.identity.role);
      setApprovals(ap);
      setSelectedId((cur) => cur ?? ap.find((a) => a.status === "pending")?.approval_id ?? null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000); // 其余 10s（D6）
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => setBasisOpen(false), [selectedId]);

  const canApprove = role !== "readonly";
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending" && a.status !== "expired");
  const batchable = pending.filter((a) => !a.snapshot.high_risk);
  const conflicts = pending.filter(isConflict);
  const selected = approvals.find((a) => a.approval_id === selectedId) ?? null;
  const gestureStats = useMemo(() => ({
    approved: approvals.filter((a) => a.status === "approved").length,
    edited: approvals.filter((a) => a.status === "edited").length,
    rejected: approvals.filter((a) => a.status === "rejected").length,
  }), [approvals]);

  /* ---------- 审批拟人化（请示语气）：门 → 主理员工（gateAgentMap 常量表） ---------- */
  const hostAgent = selected ? agentOfApproval(selected) : null;
  const hostAction = selected?.event ? actionLabel(selected.event.decision.action) : "提交审批事项";
  const isRenderCard = !!selected && (
    (selected.event?.decision.action ?? "").startsWith("render.") ||
    selected.snapshot.estimate_credits !== undefined || selected.snapshot.estimate_cost !== undefined
  );
  /** 依据链（snapshot 优先，事件 decision.basis 兜底；存在即可展开） */
  const basisLines = selected?.snapshot.basis ?? selected?.event?.decision.basis ?? [];
  const basisMd = selected?.snapshot.contentMd ?? null;

  const gesture = useCallback(async (a: ApprovalRow, g: Gesture) => {
    if (g === "reject") {
      // M1.2（D24）：驳回必须选择行业受控枚举（弹窗），自由文本只做补充——结构化原因是校准信号的前提
      setRejectTarget(a);
      return;
    }
    await trpc.approvals.decide.mutate({ approvalId: a.approval_id, gesture: g });
    setBanner({ level: "info", text: "审批已写回事件库 + 记忆校准（F5.5/F1.7）；采纳后执行回执位待外部确认（F1.1/E3.7 不宣称完成）" });
    await load();
  }, [load]);

  /** 驳回弹窗提交（M1.2 受控枚举 + L5.2 留痕） */
  const submitReject = useCallback(async (r: { reasonEnum: string; reasonText?: string }) => {
    if (!rejectTarget) return;
    await trpc.approvals.decide.mutate({
      approvalId: rejectTarget.approval_id,
      gesture: "reject",
      reasonEnum: r.reasonEnum,
      reasonText: r.reasonText,
    });
    setRejectTarget(null);
    setBanner({ level: "info", text: `已驳回（${r.reasonEnum}）并回流偏好校准（F5.5/F1.7/D24）` });
    await load();
  }, [rejectTarget, load]);

  const doBatch = useCallback(async () => {
    const r = await trpc.approvals.batchApprove.mutate({ approvalIds: batchable.map((a) => a.approval_id) }) as { approved: string[]; skipped: unknown[] };
    setBatchArmed(false);
    setBanner({ level: "info", text: `批量采纳 ${r.approved.length} 条（逐条留痕 G6）；跳过 ${r.skipped.length} 条高危（L5.4）` });
    await load();
  }, [batchable, load]);

  /** p4_conflict 刷新再审（E5.3：sweep 过期项 + 重载最新快照） */
  const refreshConflict = useCallback(async () => {
    await trpc.approvals.sweep.mutate();
    setBanner({ level: "info", text: "已刷新：过期快照标记 expired，请基于最新快照再审（E5.3）" });
    await load();
  }, [load]);

  /* ---------- 左栏：待办队列（分级） ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">待办收件箱 · INBOX</div>
      {(["双人", "必审", "逐步审"] as const).map((tier) => {
        const items = pending.filter((a) => tierOf(a) === tier);
        if (items.length === 0) return null;
        return (
          <div key={tier} className="mb-3">
            <div className="mb-1.5 px-1 text-micro tracking-wider text-ink3">{tier} · {items.length}</div>
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
                  <span className="font-mono text-[11px] text-ink3">{shortId(a.approval_id)}</span>
                  <span className={`rounded border px-1 py-0.5 text-micro ${
                    tier === "双人" ? "border-need/50 text-need" : tier === "必审" ? "border-warn/50 text-warn" : "border-line text-ink3"
                  }`}>{tier}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-body text-ink2">
                  {a.event && <AgentAvatarOf name={agentOfApproval(a).name} size={18} ring={false} />}
                  <span>{a.event ? `${agentOfApproval(a).name} · ${actionText(a.event.decision.action)}` : shortId(a.event_id)}</span>
                </div>
                {isConflict(a) && <div className="mt-0.5 text-micro text-alert">⚠ 快照冲突（E5.3）</div>}
              </button>
            ))}
          </div>
        );
      })}
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="text-caption font-bold text-holo">今日已审（F5.5）</div>
        <div className="mt-1 font-mono text-caption text-ink2">
          采纳 {gestureStats.approved} · 编辑后采纳 {gestureStats.edited} · 驳回 {gestureStats.rejected}
        </div>
        <div className="mt-0.5 text-micro text-ink3">驳回原因进偏好模式（F1.7）</div>
      </div>
    </>
  );

  /* ---------- 右栏：为什么这样改（WhyPanel）+ IM 同步 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">决策链路 · WHY</div>
      {selected?.event ? (
        <>
          <div className="mb-3 rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-caption font-bold text-holo">为什么这样改（P4E3/F1.12）</div>
            <div className="space-y-1 font-mono text-caption text-ink2">
              <div>依据事件 <span className="text-holo">#{selected.event.event_id}</span></div>
              <div>发起 {selected.event.who.id} {selected.event.who.version}</div>
              {selected.event.model_trace && (
                <div>
                  {selected.event.model_trace.tier ?? "standard"} 档 · {selected.event.model_trace.window ?? "—"} ·{" "}
                  {selected.event.model_trace.credits ?? 0} 积分
                </div>
              )}
              {(selected.event.decision.memory_refs ?? []).map((m) => (
                <div key={m}>引用记忆 <span className="text-holo2">{m}</span></div>
              ))}
              {selected.event.rule_impact.map((r) => (
                <div key={r.rule_id} className={r.result === "pass" ? "text-go" : r.result === "review" ? "text-warn" : "text-alert"}>
                  {r.rule_id} {r.version} · {r.result}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-caption font-bold text-holo">IM 卡片同步（P4E4）</div>
            <div className="text-caption text-ink2">渠道 inapp（本地回环 D7）· 审批人映射 {role}</div>
            <div className="mt-1 font-mono text-micro text-ink3">
              幂等键 {shortId(selected.approval_id)} · 同事件同渠道不重复推送（L5.3）· 回调签名校验（E5.2）
            </div>
            <div className="mt-1 text-micro text-go">✓ {selected.status === "pending" ? "已推送" : "已原地更新"}</div>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-line bg-card p-3 text-caption text-ink3">选中左侧待办查看决策链路</div>
      )}
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-h1 font-black tracking-wider">审批中心</h2>
          <span className="text-[11px] tracking-[.2em] text-ink3">P4 · DECISION INBOX</span>
          <span className="flex-1" />
          {canApprove && batchable.length > 0 && (
            batchArmed ? (
              <button type="button" onClick={() => void doBatch()}
                className="cursor-pointer rounded-lg border border-gold/70 bg-gold/15 px-3.5 py-1.5 text-xs font-extrabold text-gold">
                确认批量采纳 {batchable.length} 条？
              </button>
            ) : (
              <button type="button" onClick={() => setBatchArmed(true)}
                className="cursor-pointer rounded-lg gold-grad px-3.5 py-1.5 text-xs font-extrabold text-ongold">
                批量采纳低风险（{batchable.length}）
              </button>
            )
          )}
        </div>

        {banner && <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>}

        {/* p4_conflict 异常态（E5.3/F2.7：红条告警 + 刷新再审） */}
        {conflicts.length > 0 && (
          <div className="mb-3">
            <BannerAlert level="alert" actionLabel="刷新最新快照" onAction={() => void refreshConflict()}>
              {conflicts.length} 条审批对象已被后续动作修改/快照过期——禁止基于旧快照审批（E5.3/F2.7）
            </BannerAlert>
          </div>
        )}

        {!ready ? (
          <><SkeletonBlock lines={2} h={48} /><SkeletonBlock lines={4} /></>
        ) : pending.length === 0 && !selected ? (
          /* p4_empty（F5.5） */
          <EmptyState
            icon="✓"
            title="今日待办消息已清空"
            hint={`手势统计：采纳 ${gestureStats.approved} · 编辑后采纳 ${gestureStats.edited} · 驳回 ${gestureStats.rejected}（驳回原因进偏好模式 F1.7）`}
          />
        ) : !selected ? (
          <EmptyState icon="◆" title="选中左侧待办项" hint="单击队列条目展开原生审批卡" />
        ) : (
          <div className="space-y-3.5">
            {/* 原生审批卡（桌面详情版 · 请示语气：员工向你请示） */}
            <div className="rounded-msg border border-warn/40 bg-card p-4">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gold/60 bg-gold/10 text-caption font-bold text-goldhi">
                  {(hostAgent?.name ?? "值").slice(0, 1)}
                </span>
                <span className="text-h2 font-bold text-warn">
                  {hostAgent?.name ?? "值班 Agent"} 向你请示：{hostAction}
                </span>
                <span className="rounded border border-line px-1.5 py-0.5 text-micro text-ink3">{dictText(APPROVAL_STATUS_TEXT, selected.status)}</span>
                <EventIdChip id={selected.event_id} />
                <span className={`rounded border px-1.5 py-0.5 text-micro ${
                  tierOf(selected) === "双人" ? "border-need/50 text-need" : tierOf(selected) === "必审" ? "border-warn/50 text-warn" : "border-line text-ink3"
                }`}>{tierOf(selected)}</span>
                <span className="font-mono text-micro text-ink3">
                  {dictText(APPROVAL_STATUS_TEXT, selected.status)}
                  {hostAgent?.gate ? ` · ${hostAgent.gate} 门` : ""}
                </span>
                {selected.event && (
                  <span className="font-mono text-micro text-ink3">
                    来源 {selected.event.who.id} · {actionText(selected.event.decision.action)}
                  </span>
                )}
              </div>

              {/* 成本预估区（渲染类卡片；数据缺时显「待估算」） */}
              {isRenderCard && (
                <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-gline bg-gold/5 px-3 py-2">
                  <span className="text-caption font-bold text-gold">成本预估</span>
                  <span className="font-mono text-caption text-ink2">
                    预计额度 <b className="font-orb text-gold">
                      {selected.snapshot.estimate_credits ?? selected.event?.model_trace?.credits ?? "待估算"}
                    </b>{selected.snapshot.estimate_credits ?? selected.event?.model_trace?.credits ? " 积分" : ""}
                  </span>
                  <span className="font-mono text-caption text-ink2">
                    预计费用 <b className="font-orb text-gold">{selected.snapshot.estimate_cost ?? "待估算"}</b>
                  </span>
                  {selected.event?.model_trace?.window && (
                    <span className="font-mono text-micro text-ink3">窗口 {selected.event.model_trace.window}</span>
                  )}
                </div>
              )}

              {/* 依据链（可展开；snapshot.contentMd/basis 存在即渲染，治理 §九.3） */}
              {(basisLines.length > 0 || basisMd) && (
                <div className="mb-3 rounded-lg border border-line bg-bg800/40">
                  <button
                    type="button"
                    onClick={() => setBasisOpen((v) => !v)}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-caption font-bold text-holo"
                  >
                    <span>{basisOpen ? "▾" : "▸"}</span>
                    依据链（{basisLines.length > 0 ? `${basisLines.length} 条依据` : "正文快照"}）
                  </button>
                  {basisOpen && (
                    <div className="space-y-1.5 border-t border-line px-3 py-2.5">
                      {basisLines.map((b) => (
                        <div key={b} className="flex gap-2 text-caption text-ink2">
                          <span className="text-holo2">◆</span>{b}
                        </div>
                      ))}
                      {basisMd && (
                        <pre className="max-h-56 overflow-auto rounded border border-line bg-bg900/70 p-2.5 font-mono text-caption whitespace-pre-wrap text-ink2">{basisMd}</pre>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* P4E1 diff 对照表（前删线 → 后高亮；命中规则随行） */}
              <div className="mb-3 grid grid-cols-2 gap-2.5">
                <div className="rounded-lg border border-line bg-bg800/60 p-3">
                  <div className="mb-1 text-micro tracking-wider text-ink3">调整前</div>
                  <div className="font-mono text-body text-ink3 line-through">{payloadText(selected.snapshot.before ?? selected.event?.decision.before ?? null, 120) || "—"}</div>
                </div>
                <div className="rounded-lg border border-holo/35 bg-holo/5 p-3">
                  <div className="mb-1 text-micro tracking-wider text-holo">调整后（高亮）</div>
                  <div className="font-mono text-body text-holo">{payloadText(selected.snapshot.after ?? selected.event?.decision.after ?? null, 120) || "—"}</div>
                </div>
              </div>
              {selected.event && selected.event.rule_impact.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {selected.event.rule_impact.map((r) => (
                    <span key={r.rule_id} className={`rounded border px-2 py-0.5 font-mono text-micro ${
                      r.result === "pass" ? "border-go/40 text-go" : r.result === "review" ? "border-warn/40 text-warn" : "border-alert/50 text-alert"
                    }`}>命中 {r.rule_id} {r.version} · {r.result}</span>
                  ))}
                </div>
              )}
              {/* 影响面 + 执行回执位说明 */}
              <div className="mb-3 rounded-lg border border-line bg-bg800/40 p-3 text-caption text-ink2">
                影响面：{selected.event ? `${selected.event.object.type}${selected.event.object.id ? `「${selected.event.object.id}」` : ""}` : "—"} ·
                执行回执位：{selected.event?.receipt?.synced ? "✓ 已生效" : "⚠ 采纳后执行，外部生效回写回执位（F1.1；回执缺失不宣称完成 E3.7）"}
              </div>

              {/* P4E2 三手势（快照冲突禁审 E5.3；无权限隐藏 L5.1） */}
              {selected.status === "pending" && canApprove && (
                isConflict(selected) ? (
                  <div className="rounded-lg border border-alert/50 bg-alert/8 px-4 py-2.5 text-body text-alert">
                    快照已过期/对象已被修改，禁止基于旧快照审批（E5.3）——请先刷新最新快照
                  </div>
                ) : (
                  <TriGestureBar onGesture={(g) => void gesture(selected, g)} />
                )
              )}
            </div>
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
