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
import { shortId } from "../../lib/display";
import {
  BannerAlert,
  EmergencyBrake,
  EmptyState,
  SkeletonBlock,
  type Gesture,
} from "../../components/hud";

interface NightRun {
  id: string; status: string; fenceSnapshot: string | null;
  stats: { done: number; pending: number; need_human: number; credits_used: number } | null;
}
interface ApprovalRow {
  approval_id: string; event_id: string; status: string;
  snapshot: { summary?: string; title?: string; gate?: string; ceo_rationale?: string; params?: Record<string, unknown>; before?: unknown; after?: unknown; rule_version?: string; high_risk?: boolean; gesture?: string };
}

type Filter = "all" | "done" | "pending" | "needHuman";

export default function P3() {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState("owner");
  const [nightConfigured, setNightConfigured] = useState(true);
  const [run, setRun] = useState<NightRun | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [batchArmed, setBatchArmed] = useState(false);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [meR, cur, ap] = await Promise.all([
        trpc.members.me.query() as Promise<{ identity: { role: string } }>,
        trpc.nightShift.current.query() as Promise<{ configured: boolean; run?: NightRun }>,
        trpc.approvals.list.query() as Promise<ApprovalRow[]>,
      ]);
      setRole(meR.identity.role);
      setNightConfigured(cur.configured);
      setRun(cur.run ?? null);
      setApprovals(ap);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000); // 移动端 10s（D6）
    return () => clearInterval(t);
  }, [load]);

  const stats = run?.stats ?? { done: 0, pending: 0, need_human: 0, credits_used: 0 };
  const pending = approvals.filter((a) => a.status === "pending");
  const expired = approvals.filter((a) => a.status === "expired");
  const canApprove = role !== "readonly";
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
      const reason = window.prompt("驳回原因（必填 ≤200 字，L5.2）") ?? "";
      if (!reason.trim()) { setBanner({ level: "warn", text: "驳回必须填写原因（L5.2），本次未提交" }); return; }
      await trpc.approvals.decide.mutate({ approvalId: a.approval_id, gesture: "reject", reasonText: reason.slice(0, 200) });
    } else {
      await trpc.approvals.decide.mutate({ approvalId: a.approval_id, gesture: g });
    }
    setBanner({ level: "info", text: "审批已写回事件库并触发组织记忆校准（F4.5/F1.7）" });
    await load();
  }, [load]);

  const doBatch = useCallback(async () => {
    const r = await trpc.approvals.batchApprove.mutate({ approvalIds: batchable.map((a) => a.approval_id) }) as { approved: string[]; skipped: Array<{ id: string; reason: string }> };
    setBatchArmed(false);
    setBanner({ level: "info", text: `批量采纳 ${r.approved.length} 条低风险项（逐条留痕 G6）；跳过 ${r.skipped.length} 条（高危不批放 L5.4）` });
    await load();
  }, [batchable, load]);

  const doPause = useCallback(async () => {
    if (!run) return;
    const r = await trpc.nightShift.pause.mutate({ runId: run.id }) as { elapsedMs: number; withinSla: boolean };
    setBanner(r.withinSla
      ? { level: "info", text: `一键暂停 ${r.elapsedMs}ms 全端生效（G5 ≤60s）` }
      : { level: "alert", text: `暂停超时 ${r.elapsedMs}ms，已升级 P0 告警（E4.1）` });
    await load();
  }, [run, load]);

  /* ---------- 移动端 375px 机身（§4.2：真机框 44px 圆角 + 深空内容区） ---------- */
  return (
    <div className="flex min-h-screen items-start justify-center bg-bg950 py-6">
      <div className="w-[375px] overflow-hidden rounded-[44px] border border-line bg-bg900 shadow-[0_30px_80px_rgba(0,0,0,.6)]">
        {/* 机身边框装饰 */}
        <div className="flex justify-center border-b border-line bg-bg950/80 py-2">
          <span className="h-1.5 w-16 rounded-full bg-bg700" />
        </div>

        <div className="space-y-3 p-3.5">
          {/* 页头 */}
          <div className="flex items-center gap-2">
            <a href="/" className="text-caption text-holo no-underline">← 工作台</a>
            <span className="text-h2 font-black text-ink">掌上日报</span>
            <span className="text-micro tracking-[.2em] text-ink3">P3 · HANDOFF</span>
          </div>

          {banner && <BannerAlert level={banner.level} actionLabel="好" onAction={() => setBanner(null)}>{banner.text}</BannerAlert>}

          {!ready ? (
            <><SkeletonBlock lines={2} h={56} /><SkeletonBlock lines={4} /></>
          ) : !nightConfigured ? (
            /* p3_empty：夜班未启用（F4.8） */
            <EmptyState icon="🌙" title="夜班中心尚未出征" hint="去规则与权限（P5）配置夜班，明早 08:30 日报送达" actionLabel="去配置 →" />
          ) : (
            <>
              {/* P3E1 三栏计数头（与 P1 交接班卡强一致 F4.4；点击筛选） */}
              <div className="rounded-2xl border border-line bg-card p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-body font-black text-goldhi">✦ 昨夜日报</span>
                  <span className="font-mono text-micro text-holo">{run?.fenceSnapshot ?? ""}</span>
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
                      <div className="mt-0.5 text-micro text-ink2">{c.label}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-center font-mono text-micro text-ink3">
                  能量 {stats.credits_used} · 峰谷费率（F4.6/G9） · 计数与 P1 强一致（F4.4）
                </div>
              </div>

              {/* p3_expired：超 24h 待审虚框（F5.7；高危项不存在超时自动放行 L5.4） */}
              {expired.map((a) => (
                <div key={a.approval_id} className="rounded-2xl border border-dashed border-warn/50 bg-warn/4 p-3.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-body font-bold text-warn">◆ 已超时（虚框标记）</span>
                    <span className="font-mono text-micro text-ink3">{shortId(a.approval_id)}</span>
                  </div>
                  <div className="text-caption text-ink2">{a.snapshot.summary ?? a.snapshot.title ?? "待审项超 24h 未处理（F5.7）"}</div>
                  <div className="mt-1 text-micro text-ink3">高危项不存在超时自动放行（L5.4）· 请尽快审批</div>
                </div>
              ))}

              {/* 审批卡逐条（P3E2 拇指热区 ≥44px §4.2；单条 ≤2 步 G6） */}
              {(filter === "all" || filter === "pending" ? pending : []).map((a) => (
                <div key={a.approval_id} className="rounded-2xl border border-warn/40 bg-card p-3.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-body font-bold text-warn">◆ 待审批</span>
                    <span className="font-mono text-micro text-ink3">{shortId(a.approval_id)}</span>
                  </div>
                  {(a.snapshot.summary ?? a.snapshot.title) && (
                    <div className="mb-1 text-body font-bold text-ink">{a.snapshot.summary ?? a.snapshot.title}</div>
                  )}
                  {a.snapshot.ceo_rationale && (
                    <div className="mb-1.5 text-caption text-ink2">CEO 意见：{a.snapshot.ceo_rationale}</div>
                  )}
                  {(a.snapshot.rule_version ?? a.snapshot.gate) && (
                    <div className="mb-1 font-mono text-micro text-holo">命中 {a.snapshot.rule_version ?? a.snapshot.gate}</div>
                  )}
                  {(a.snapshot.before !== undefined || a.snapshot.after !== undefined) && (
                    <div className="mb-2.5 rounded-lg border border-line bg-bg800/60 p-2.5 font-mono text-caption">
                      <div className="text-ink3 line-through">{JSON.stringify(a.snapshot.before)}</div>
                      <div className="mt-0.5 text-holo">{JSON.stringify(a.snapshot.after)}</div>
                    </div>
                  )}
                  {canApprove && (
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { g: "approve" as Gesture, icon: "✓", name: "推进", cls: "border-go/50 text-go" },
                        { g: "edit" as Gesture, icon: "✎", name: "校准", cls: "border-holo/50 text-holo" },
                        { g: "reject" as Gesture, icon: "✗", name: "制动", cls: "border-alert/55 text-alert" },
                      ]).map((r) => (
                        <button
                          key={r.g}
                          type="button"
                          onClick={() => void gesture(a, r.g)}
                          className={`min-h-11 cursor-pointer rounded-xl border bg-bg800/50 text-body font-bold ${r.cls}`}
                        >
                          {r.icon} {r.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* P3E3 查看决策链路 → P4 */}
                  <div className="mt-2 text-right">
                    <a href="/p4" className="text-micro text-holo no-underline">查看决策链路 → P4（F1.12）</a>
                  </div>
                </div>
              ))}

              {/* 求援卡（需介入：夜间未执行任何动作 L4.2） */}
              {(filter === "all" || filter === "needHuman") && stats.need_human > 0 && (
                <div className="rounded-2xl border border-alert/50 bg-alert/6 p-3.5">
                  <div className="mb-1 text-body font-bold text-alert">▲ 求援 · 需介入 {stats.need_human} 项</div>
                  <div className="text-caption text-ink2">夜间未执行任何动作（不确定不猜测，L4.2）——请查看决策链路定位处理</div>
                  <div className="mt-2 text-right"><a href="/p4" className="text-micro text-holo no-underline">去审批中心 →</a></div>
                </div>
              )}

              {/* 完成后态（F5.5：整包处理完 → 清空提示 + 手势统计） */}
              {pending.length === 0 && (
                <div className="rounded-2xl border border-go/35 bg-go/5 p-3.5 text-center">
                  <div className="text-body font-bold text-go">✓ 今日待审已清空</div>
                  <div className="mt-1 text-caption text-ink2">
                    手势统计：采纳 {gestureStats.approved} · 编辑后采纳 {gestureStats.edited} · 驳回 {gestureStats.rejected}（F5.5）
                  </div>
                </div>
              )}

              {/* 底部双键（§4.2：批量推进 + 紧急制动；P3E4 仅低风险可批量 G6） */}
              {canApprove && (
                <div className="grid grid-cols-2 gap-2 pb-2">
                  {batchArmed ? (
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
                  )}
                  <div className="flex items-stretch"><EmergencyBrake onConfirm={() => void doPause()} /></div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
