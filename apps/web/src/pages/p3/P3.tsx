/**
 * P3 掌上日报（F6：夜班交接班消息 · 移动端监督者视角；PRD P3-①②③④⑤ 逐条对账）
 *  - 375px 内容区（§4.2 拇指化重排）：日报计数头置顶 → 审批卡逐条（单条 ≤2 步）→ 求援卡 → 底部双键
 *  - P3E1 三栏计数头与 P1 交接班卡强一致（F4.4 同一 stats 数据源）；点击筛选消息列表
 *  - P3E2 三手势写回（采纳/编辑后采纳/驳回 = 权重 1/2/3，F5.3/F5.5；驳回必填原因 ≤200 字 L5.2）
 *  - P3E4 批量采纳仅低风险项（review/block 不进批量 G6；二次确认；接 approvals.batchApprove 高危跳过）
 *  - P3E5 紧急制动（二次确认 → nightShift.pause，G5 ≤60s 全端生效）
 * 状态变体：p3 默认 / p3_empty 夜班未启用 / p3_expired 待审超 24h 虚框（F5.7；高危项无超时放行 L5.4）
 * 权限态：非审批人仅可查看，不显示手势按钮（E2.6 隐藏非置灰）；完成后态：整包清空+手势统计（F5.5）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { payloadText, shortId } from "../../lib/display";
import {
  BannerAlert,
  EmergencyBrake,
  EmptyState,
  Skeleton,
  type Gesture,
} from "../../components/hud";
import { RejectDialog } from "../../components/RejectDialog";
import { Link } from "react-router";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import { Icon, clientChineseText, type IconName } from "@workloom/ui";

interface NightRun {
  id: string; status: string; fenceSnapshot: string | null;
  stats: { done: number; pending: number; need_human: number; credits_used: number } | null;
}
interface ApprovalRow {
  approval_id: string; event_id: string; status: string;
  snapshot: { summary?: string; before?: unknown; after?: unknown; rule_version?: string; high_risk?: boolean; gesture?: string };
}

type Filter = "all" | "done" | "pending" | "needHuman";

export default function P3() {
  const { entries, canAction } = useNavigationAccess();
  const [ready, setReady] = useState(false);
  const [nightConfigured, setNightConfigured] = useState(true);
  const [run, setRun] = useState<NightRun | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ApprovalRow | null>(null);
  const [batchArmed, setBatchArmed] = useState(false);
  const canReadApprovals = entries.some((entry) => entry.route === "/approvals");
  const canReadNight = entries.some((entry) => entry.route === "/night");

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [cur, ap] = await Promise.all([
        canReadNight ? trpc.nightShift.current.query() as Promise<{ configured: boolean; run?: NightRun }> : Promise.resolve({ configured: false } as { configured: boolean; run?: NightRun }),
        canReadApprovals ? trpc.approvals.list.query() as Promise<ApprovalRow[]> : Promise.resolve([]),
      ]);
      setNightConfigured(cur.configured);
      setRun(cur.run ?? null);
      setApprovals(ap);
    } finally {
      setReady(true);
    }
  }, [canReadApprovals, canReadNight]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000); // 移动端 10s（D6）
    return () => clearInterval(t);
  }, [load]);

  const stats = run?.stats ?? { done: 0, pending: 0, need_human: 0, credits_used: 0 };
  const pending = approvals.filter((a) => a.status === "pending");
  const expired = approvals.filter((a) => a.status === "expired");
  const canApprove = canAction("approval.decide");
  const canManageNight = canAction("night.manage");
  // 批量采纳低风险：仅 auto 级（非高危）可批量（G6；review/block 不进入批量）
  const batchable = pending.filter((a) => !a.snapshot.high_risk);
  // 手势统计（完成后态 F5.5）
  const gestureStats = useMemo(() => ({
    approved: approvals.filter((a) => a.status === "approved").length,
    edited: approvals.filter((a) => a.status === "edited").length,
    rejected: approvals.filter((a) => a.status === "rejected").length,
  }), [approvals]);

  const gesture = useCallback(async (a: ApprovalRow, g: Gesture) => {
    if (g === "reject") {
      // M1.2（D24）：驳回必须选择行业受控枚举（弹窗），自由文本只做补充
      setRejectTarget(a);
      return;
    }
    await trpc.approvals.decide.mutate({ approvalId: a.approval_id, gesture: g });
    setBanner({ level: "info", text: "审批结果已写入事件账本，并用于校准组织经验。" });
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
    setBanner({ level: "info", text: "已驳回并记录原因，后续会用于校准协作偏好。" });
    await load();
  }, [rejectTarget, load]);

  const doBatch = useCallback(async () => {
    const r = await trpc.approvals.batchApprove.mutate({ approvalIds: batchable.map((a) => a.approval_id) }) as { approved: string[]; skipped: Array<{ id: string; reason: string }> };
    setBatchArmed(false);
    setBanner({ level: "info", text: `已批量采纳 ${r.approved.length} 条低风险事项，并逐条写入账本；另有 ${r.skipped.length} 条高风险事项未处理。` });
    await load();
  }, [batchable, load]);

  const doPause = useCallback(async () => {
    if (!run) return;
    const r = await trpc.nightShift.pause.mutate({ runId: run.id }) as { elapsedMs: number; withinSla: boolean };
    const elapsed = `${Math.max(0.1, r.elapsedMs / 1000).toFixed(1)} 秒`;
    setBanner(r.withinSla
      ? { level: "info", text: `夜班已暂停，并在 ${elapsed} 内同步到全部客户端。` }
      : { level: "alert", text: `暂停指令在 ${elapsed} 内未能完成，系统已升级为首页告警。` });
    await load();
  }, [run, load]);

  /* 同一响应式内容同时适配桌面窄栏与移动视口，不模拟固定尺寸手机壳。 */
  return (
    <div className="mx-auto flex min-h-full w-full min-w-0 max-w-3xl items-start justify-center px-2 py-4 sm:px-4 sm:py-6">
      <div className="w-full overflow-hidden rounded-panel border border-line bg-bg900 shadow-[0_20px_60px_rgba(0,0,0,.35)]">
        <div className="space-y-3 p-3.5">
          {/* 页头 */}
          <div className="flex items-center gap-2">
            <span className="text-h2 font-black text-ink">掌上日报</span>
            <span className="text-body tracking-[.2em] text-ink3">夜班交接</span>
          </div>

          {banner && <BannerAlert level={banner.level} actionLabel="好" onAction={() => setBanner(null)}>{banner.text}</BannerAlert>}

          {!ready ? (
            <><Skeleton count={2} height={56} label="夜班摘要正在加载" /><Skeleton count={4} label="夜班详情正在加载" /></>
          ) : !nightConfigured ? (
            /* p3_empty：夜班未启用（F4.8） */
            <EmptyState icon={<Icon name="night" size={24} />} title="夜班中心尚未出征" hint="前往规则与权限配置夜班，明早 08:30 日报送达。" actionLabel="去配置 →" />
          ) : (
            <>
              {/* P3E1 三栏计数头（与 P1 交接班卡强一致 F4.4；点击筛选） */}
              <div className="rounded-2xl border border-line bg-card p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 text-body font-black text-goldhi"><Icon name="night" size={14} />昨夜日报</span>
                  {run?.fenceSnapshot && <span className="text-body text-holo">安全规则快照已锁定</span>}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { k: "done" as Filter, n: stats.done, label: "已完成", cls: "text-go" },
                    { k: "pending" as Filter, n: stats.pending, label: "待审批", cls: "text-warn" },
                    { k: "needHuman" as Filter, n: stats.need_human, label: "需介入", cls: "text-alert" },
                  ]).map((c) => (
                    <button
                      key={c.k}
                      type="button"
                      onClick={() => setFilter(filter === c.k ? "all" : c.k)}
                      className={`cursor-pointer rounded-xl border px-2 py-2.5 text-center ${
                        filter === c.k ? "border-gline bg-gold/8" : "border-line bg-bg800/60"
                      }`}
                    >
                      <div className={`font-orb text-kpi font-bold ${c.cls}`}>{c.n}</div>
                      <div className="mt-0.5 text-body text-ink2">{c.label}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-center font-mono text-body text-ink3">
                  积分 {stats.credits_used} · 已应用峰谷费率 · 与工作台数据同步
                </div>
              </div>

              {/* p3_expired：超 24h 待审虚框（F5.7；高危项不存在超时自动放行 L5.4） */}
              {expired.map((a) => (
                <div key={a.approval_id} className="rounded-2xl border border-dashed border-warn/50 bg-warn/4 p-3.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 text-body font-bold text-warn"><Icon name="warning" size={13} />已超时（虚框标记）</span>
                    <span className="font-mono text-body text-ink3">{shortId(a.approval_id)}</span>
                  </div>
                  <div className="text-body text-ink2">{clientChineseText(a.snapshot.summary, "待审事项超过 24 小时未处理")}</div>
                  <div className="mt-1 text-body text-ink3">高风险事项不会因超时自动放行，请尽快审批。</div>
                </div>
              ))}

              {/* 审批卡逐条（P3E2 拇指热区 ≥44px §4.2；单条 ≤2 步 G6） */}
              {(filter === "all" || filter === "pending" ? pending : []).map((a) => (
                <div key={a.approval_id} className="rounded-2xl border border-warn/40 bg-card p-3.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 text-body font-bold text-warn"><Icon name="approval" size={13} />待审批</span>
                    <span className="font-mono text-body text-ink3">{shortId(a.approval_id)}</span>
                  </div>
                  {a.snapshot.rule_version && (
                    <div className="mb-1 text-body text-holo">命中关联安全规则</div>
                  )}
                  {(a.snapshot.before !== undefined || a.snapshot.after !== undefined) && (
                    <div className="mb-2.5 rounded-lg border border-line bg-bg800/60 p-2.5 font-mono text-body">
                      <div className="text-ink3 line-through">调整前：{payloadText(a.snapshot.before, 180) || "暂无"}</div>
                      <div className="mt-0.5 text-holo">调整后：{payloadText(a.snapshot.after, 180) || "暂无"}</div>
                    </div>
                  )}
                  {canApprove && (
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { g: "approve" as Gesture, icon: "check" as IconName, name: "推进", cls: "border-go/50 text-go" },
                        { g: "edit" as Gesture, icon: "edit" as IconName, name: "校准", cls: "border-holo/50 text-holo" },
                        { g: "reject" as Gesture, icon: "error" as IconName, name: "制动", cls: "border-alert/55 text-alert" },
                      ]).map((r) => (
                        <button
                          key={r.g}
                          type="button"
                          onClick={() => void gesture(a, r.g)}
                          className={`min-h-11 cursor-pointer rounded-xl border bg-bg800/50 text-body font-bold ${r.cls}`}
                        >
                          <Icon name={r.icon} size={14} className="inline" /> {r.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* P3E3 查看决策链路 → P4 */}
                  {canReadApprovals && <div className="mt-2 text-right">
                    <Link to="/approvals" className="text-body text-holo no-underline">查看完整决策链路 →</Link>
                  </div>}
                </div>
              ))}

              {/* 求援卡（需介入：夜间未执行任何动作 L4.2） */}
              {(filter === "all" || filter === "needHuman") && stats.need_human > 0 && (
                <div className="rounded-2xl border border-alert/50 bg-alert/6 p-3.5">
                  <div className="mb-1 flex items-center gap-1 text-body font-bold text-alert"><Icon name="warning" size={14} />求援 · 需介入 {stats.need_human} 项</div>
                  <div className="text-body text-ink2">夜间未执行任何动作；系统不会在信息不足时猜测，请查看决策链路并处理。</div>
                  {canReadApprovals && <div className="mt-2 text-right"><Link to="/approvals" className="text-body text-holo no-underline">去审批中心 →</Link></div>}
                </div>
              )}

              {/* 完成后态（F5.5：整包处理完 → 清空提示 + 手势统计） */}
              {pending.length === 0 && (
                <div className="rounded-2xl border border-go/35 bg-go/5 p-3.5 text-center">
                  <div className="inline-flex items-center gap-1 text-body font-bold text-go"><Icon name="check" size={14} />今日待审已清空</div>
                  <div className="mt-1 text-body text-ink2">
                    手势统计：采纳 {gestureStats.approved} · 编辑后采纳 {gestureStats.edited} · 驳回 {gestureStats.rejected}
                  </div>
                </div>
              )}

              {/* 底部双键（§4.2：批量推进 + 紧急制动；P3E4 仅低风险可批量 G6） */}
              {(canApprove || canManageNight) && (
                <div className="grid grid-cols-2 gap-2 pb-2">
                  {canApprove && (batchArmed ? (
                    <button
                      type="button"
                      onClick={() => void doBatch()}
                      className="min-h-11 cursor-pointer rounded-xl border border-gold/70 bg-gold/15 text-body font-black text-gold"
                    >
                      确认批量采纳 {batchable.length} 条？
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={batchable.length === 0}
                      onClick={() => setBatchArmed(true)}
                      className="min-h-11 cursor-pointer rounded-xl gold-grad text-body font-black text-ongold disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      批量推进（{batchable.length}）
                    </button>
                  ))}
                  {canManageNight && <div className="flex items-stretch"><EmergencyBrake onConfirm={() => void doPause()} /></div>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <RejectDialog
        open={rejectTarget !== null}
        mode="reject"
        onCancel={() => setRejectTarget(null)}
        onSubmit={(r) => void submitReject(r)}
      />
    </div>
  );
}
