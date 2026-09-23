/**
 * P23 组织记忆中心（D24 自我进化飞轮 M2.1 + M5）
 *  - 记忆可读可改可禁用：企业的「口味、规矩、教训」是看得见摸得着的数据资产（信任+纠偏通道）
 *  - 每条记忆可反查来源事件与被引用记录（F1.4 归因闭环）
 *  - 来源人一键清算：成员离任/换岗时作废其手势沉淀的偏好（防个人口味过拟合，D24 修订 2）
 *  - 进化积分卡：北极星=审批一次通过率，趋势看斜率；记忆引用量=偏好注入生效口径
 * 权限态：readonly 隐藏编辑/禁用/清算按钮（服务端 writeProcedure 同样 403，前端隐藏非置灰）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../../lib/trpc";
import { actorText, shortId } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert } from "../../components/hud";
import { AsyncState, Button, Overlay } from "@workloom/ui";
import { operationFailure, toUiFailure } from "../../lib/ui-state";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import { feedbackReasonLabels, memoryImpactSystemText } from "./systemText";

interface MemoryRow {
  memory_id: string;
  scope: "workspace" | "agent" | "run";
  kind: "preference" | "pattern" | "sop" | "forbidden";
  content: string;
  confidence: number;
  status: "active" | "superseded" | "recalled";
  subject_id: string | null;
}

interface Scorecard {
  totals: { decided: number; approved: number; edited: number; rejected: number; firstPassRate: number | null; editRate: number | null };
  weekly: Array<{ weekStart: string; decided: number; firstPassRate: number | null }>;
  rejectReasons: Array<{ reasonEnum: string; count: number }>;
  memory: { activeByKind: Record<string, number>; usages30d: number; calibrations30d: number };
}
interface MemberRow { memberNo: string; name: string; role: string }
interface MemoryImpact {
  affectedMemoryIds: string[];
  agents: Array<{ id: string; name: string }>;
  rules: Array<{ id: string; name: string }>;
  activeTasks: Array<{ id: string; title: string; status: string }>;
  futureTaskPolicy: string;
}

const KIND_TEXT: Record<string, string> = { preference: "偏好", pattern: "模式", sop: "标准作业流程", forbidden: "禁忌" };
const KIND_CLS: Record<string, string> = {
  preference: "border-gold/50 text-gold",
  pattern: "border-holo/50 text-holo",
  sop: "border-go/50 text-go",
  forbidden: "border-alert/60 text-alert",
};

function pct(x: number | null): string {
  return x === null || !Number.isFinite(Number(x)) ? "—" : `${(Number(x) * 100).toFixed(1)}%`;
}

export default function P23() {
  const { status: accessStatus, canAction, reload: reloadAccess } = useNavigationAccess();
  const [dataState, setDataState] = useState<"idle" | "loading" | "ready" | "error" | "forbidden">("idle");
  const [stateMessage, setStateMessage] = useState("");
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [kindFilter, setKindFilter] = useState<string>("");
  const [showRecalled, setShowRecalled] = useState(false);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [editing, setEditing] = useState<{ memoryId: string; content: string } | null>(null);
  const [sources, setSources] = useState<{ memoryId: string; usedBy: string[]; sourceCount: number } | null>(null);
  const [sourceState, setSourceState] = useState<{ memoryId: string; status: "loading" | "error" } | null>(null);
  const [recallMember, setRecallMember] = useState("");
  const [reasonLabels, setReasonLabels] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ kind: "disable"; memoryId: string; summary: string } | { kind: "recall"; memberId: string; memberName: string } | null>(null);
  const [impact, setImpact] = useState<MemoryImpact | null>(null);
  const [lastRecall, setLastRecall] = useState<string[]>([]);
  const dataSequence = useRef(0);

  const load = useCallback(async (background = false) => {
    const requestId = ++dataSequence.current;
    if (!background) setDataState("loading");
    try {
      const [mems, sc, enums, memberRows] = await Promise.all([
        trpc.memory.list.query({
          kind: (kindFilter || undefined) as "preference" | "pattern" | "sop" | "forbidden" | undefined,
          status: showRecalled ? "recalled" : "active",
          limit: 50,
        }) as Promise<MemoryRow[]>,
        trpc.evolution.scorecard.query() as Promise<Scorecard>,
        trpc.memory.feedbackEnums.query() as Promise<Array<{ code: string; label: string }>>,
        trpc.members.list.query() as Promise<MemberRow[]>,
      ]);
      if (requestId !== dataSequence.current) return;
      setMemories(mems);
      setScorecard(sc);
      setReasonLabels(feedbackReasonLabels(enums));
      setMembers(memberRows);
      setHasSnapshot(true);
      setStateMessage("");
      setDataState("ready");
    } catch (error) {
      if (requestId !== dataSequence.current) return;
      console.warn("读取组织经验失败", error);
      const failure = toUiFailure(error);
      setStateMessage(failure.message);
      setDataState(failure.kind === "forbidden" ? "forbidden" : "error");
    }
  }, [kindFilter, showRecalled]);

  useEffect(() => {
    if (accessStatus === "ready") void load();
    return () => { dataSequence.current += 1; };
  }, [accessStatus, load]);

  const canWrite = accessStatus === "ready" && dataState === "ready" && canAction("memory.manage");
  const canRecall = canWrite && canAction("memory.recall");

  const doDisable = async (memoryId: string) => {
    if (busy) return;
    setBusy(`disable-${memoryId}`);
    setBanner(null);
    try {
      const result = await trpc.memory.disable.mutate({ memoryId }) as { eventId?: string; ok?: boolean };
      setConfirmAction(null);
      setImpact(null);
      setBanner({ level: "info", text: `服务端已确认停用这条记忆${result.eventId ? `，账本事件 ${shortId(result.eventId)}` : ""}。后续决策不再引用该记忆。` });
      await load(true);
    } catch (error) {
      console.warn("停用组织经验失败", error);
      setBanner({ level: "alert", text: operationFailure(error, "记忆停用") });
    } finally {
      setBusy(null);
    }
  };

  const prepareConfirm = async (action: NonNullable<typeof confirmAction>) => {
    if (busy) return;
    setBusy("impact");
    setBanner(null);
    try {
      const preview = await trpc.memory.impact.query(action.kind === "recall" ? { memberId: action.memberId } : { memoryId: action.memoryId }) as MemoryImpact;
      setImpact(memoryImpactSystemText(preview));
      setConfirmAction(action);
    } catch (error) {
      console.warn("读取记忆影响失败", error);
      setBanner({ level: "alert", text: operationFailure(error, "影响预览") });
    } finally {
      setBusy(null);
    }
  };

  const doReactivate = async (memoryId: string) => {
    if (busy) return;
    setBusy(`reactivate-${memoryId}`);
    try {
      const result = await trpc.memory.reactivate.mutate({ memoryId }) as { calibrateEventId?: string };
      setBanner({ level: "info", text: `服务端已重新启用这条记忆${result.calibrateEventId ? `，恢复事件 ${shortId(result.calibrateEventId)}` : ""}。历史停用记录仍保留。` });
      await load(true);
    } catch (error) {
      setBanner({ level: "alert", text: operationFailure(error, "记忆恢复") });
    } finally {
      setBusy(null);
    }
  };

  const doRestoreLastRecall = async () => {
    if (busy || lastRecall.length === 0) return;
    setBusy("restore");
    try {
      const result = await trpc.memory.restore.mutate({ memoryIds: lastRecall }) as { restored: string[] };
      setLastRecall([]);
      setBanner({ level: "info", text: `已撤销本次来源清算，恢复 ${result.restored.length} 条仍在回收区的记忆；恢复动作已写入事件账本。` });
      await load(true);
    } catch (error) {
      setBanner({ level: "alert", text: operationFailure(error, "撤销来源清算") });
    } finally {
      setBusy(null);
    }
  };

  const doEdit = async () => {
    if (!editing || busy || !editing.content.trim()) return;
    setBusy(`edit-${editing.memoryId}`);
    setBanner(null);
    try {
      await trpc.memory.update.mutate({ memoryId: editing.memoryId, content: editing.content });
      setEditing(null);
      setBanner({ level: "info", text: "服务端已确认更新，校准记录已写入事件账本。" });
      await load(true);
    } catch (error) {
      console.warn("更新组织经验失败", error);
      setBanner({ level: "alert", text: operationFailure(error, "记忆更新") });
    } finally {
      setBusy(null);
    }
  };

  const doRecallByMember = async () => {
    const memberId = confirmAction?.kind === "recall" ? confirmAction.memberId : recallMember.trim();
    if (!memberId || busy) return;
    setBusy("recall");
    setBanner(null);
    try {
      const r = await trpc.memory.recallBySource.mutate({ memberId }) as { recalled: string[] };
      setConfirmAction(null);
      setImpact(null);
      setRecallMember("");
      setLastRecall(r.recalled);
      setBanner({ level: "info", text: `服务端已完成来源清算：共停用 ${r.recalled.length} 条偏好记忆，全部保留审计记录。` });
      await load(true);
    } catch (error) {
      console.warn("来源记忆清算失败", error);
      setBanner({ level: "alert", text: operationFailure(error, "来源清算") });
    } finally {
      setBusy(null);
    }
  };

  const doMineNow = async () => {
    if (busy) return;
    setBusy("mine");
    setBanner(null);
    try {
      const r = await trpc.memory.mineNow.mutate() as { samples: number; reinforced: number; editPatterns: number; skipped?: string };
      setBanner({
        level: r.skipped ? "warn" : "info",
        text: r.skipped ? "本次未生成新记忆：有效样本不足。" : `服务端已完成提炼：读取 ${r.samples} 条样本，强化 ${r.reinforced} 条偏好，形成 ${r.editPatterns} 条改稿模式。`,
      });
      await load(true);
    } catch (error) {
      console.warn("组织经验提炼失败", error);
      setBanner({ level: "alert", text: operationFailure(error, "记忆提炼") });
    } finally {
      setBusy(null);
    }
  };

  const viewSources = async (memoryId: string) => {
    if (sourceState?.status === "loading") return;
    setSourceState({ memoryId, status: "loading" });
    try {
      const r = await trpc.memory.sources.query({ memoryId }) as { sourceEvents: unknown[]; usedBy: string[] };
      setSources({ memoryId, usedBy: r.usedBy, sourceCount: r.sourceEvents.length });
      setSourceState(null);
    } catch (error) {
      console.warn("读取记忆归因失败", error);
      setSources(null);
      setSourceState({ memoryId, status: "error" });
    }
  };

  const t = scorecard?.totals;

  if (accessStatus !== "ready") {
    return (
      <Bridge>
        <div className="mx-auto max-w-3xl px-5 py-16">
          <AsyncState
            status={accessStatus === "error" ? "error" : "loading"}
            title={accessStatus === "loading" ? "正在确认记忆权限" : undefined}
            description="身份确认完成前，系统保持只读并且不会显示组织经验。"
            onRetry={accessStatus === "error" ? reloadAccess : undefined}
          />
        </div>
      </Bridge>
    );
  }

  if (!hasSnapshot) {
    return (
      <Bridge>
        <div className="mx-auto max-w-3xl px-5 py-16">
          <AsyncState
            status={dataState === "forbidden" ? "forbidden" : dataState === "error" ? "error" : "loading"}
            title={dataState === "loading" ? "正在读取组织经验" : undefined}
            description={stateMessage || undefined}
            onRetry={dataState === "error" ? () => void load() : undefined}
          />
        </div>
      </Bridge>
    );
  }

  return (
    <Bridge>
      <div className="mx-auto w-full min-w-0 max-w-5xl px-3 py-6 sm:px-5">
        <div className="mb-1 text-lg font-bold text-ink">组织经验中心</div>
        <div className="mb-4 break-words text-body text-ink3">
          企业的口味、规矩与教训，是数字员工持续改进的依据。内容可读、可改、可停用，每次变更都写入不可篡改的事件账本。
        </div>

        {banner && (
          <div className="mb-3"><BannerAlert level={banner.level} actionLabel="关闭" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>
        )}
        {lastRecall.length > 0 && (
          <div className="mb-3 rounded border border-holo/40 bg-panel px-3 py-2 text-body text-ink2">
            本次清算可恢复 {lastRecall.length} 条记忆。
            <Button className="ml-3" variant="secondary" busy={busy === "restore"} disabled={Boolean(busy)} onClick={() => void doRestoreLastRecall()}>撤销本次清算</Button>
          </div>
        )}
        {(dataState === "error" || dataState === "forbidden") && (
          <div className="mb-3">
            <BannerAlert level="warn" actionLabel={dataState === "error" ? "重新加载" : undefined} onAction={dataState === "error" ? () => void load() : undefined}>
              {stateMessage} 正在显示上一次成功快照，不能据此判断当前记忆是否已变化。
            </BannerAlert>
          </div>
        )}
        {dataState === "loading" && (
          <div className="mb-3"><BannerAlert level="info">正在按新条件读取组织经验，完成前继续显示上一次成功快照且不开放写操作。</BannerAlert></div>
        )}

        {/* 进化积分卡（M5：北极星 + 趋势斜率） */}
        <div className="mb-5 grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-4">
          <div className="min-w-0 break-words rounded-xl border border-gold/40 bg-panel p-4">
            <div className="break-words text-body tracking-widest text-ink3">北极星 · 审批一次通过率</div>
            <div className="mt-1 text-2xl font-bold text-gold">{pct(t?.firstPassRate ?? null)}</div>
            <div className="mt-1 text-body text-ink3">已裁决 {t?.decided ?? 0} 条（批 {t?.approved ?? 0} / 改 {t?.edited ?? 0} / 驳 {t?.rejected ?? 0}）</div>
          </div>
          <div className="min-w-0 break-words rounded-xl border border-line bg-panel p-4">
            <div className="text-body tracking-widest text-ink3">人类修改率</div>
            <div className="mt-1 text-2xl font-bold text-ink">{pct(t?.editRate ?? null)}</div>
            <div className="mt-1 text-body text-ink3">改稿占比，越低说明提案越贴合</div>
          </div>
          <div className="min-w-0 break-words rounded-xl border border-line bg-panel p-4">
            <div className="text-body tracking-widest text-ink3">记忆引用（30 天）</div>
            <div className="mt-1 text-2xl font-bold text-ink">{scorecard?.memory.usages30d ?? 0}</div>
            <div className="mt-1 text-body text-ink3">偏好被数字员工引用的次数</div>
          </div>
          <div className="min-w-0 break-words rounded-xl border border-line bg-panel p-4">
            <div className="text-body tracking-widest text-ink3">进化活动（30 天）</div>
            <div className="mt-1 text-2xl font-bold text-ink">{scorecard?.memory.calibrations30d ?? 0}</div>
            <div className="mt-1 text-body text-ink3">记忆校准事件数</div>
          </div>
        </div>

        {/* 周趋势 + 驳回分布 */}
        <div className="mb-5 grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-2">
          <div className="min-w-0 break-words rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 break-words text-body font-semibold text-ink">一次通过率 · 近 8 周（飞轮看斜率）</div>
            {(scorecard?.weekly ?? []).length === 0 && <div className="text-body text-ink3">暂无裁决样本</div>}
            {(scorecard?.weekly ?? []).map((w) => (
              <div key={w.weekStart} className="flex flex-wrap items-center gap-2 py-0.5 text-body">
                <span className="w-20 text-ink3">{w.weekStart.slice(5)}</span>
                <div className="h-2 min-w-0 flex-1 rounded bg-bg950">
                  <div className="h-2 rounded bg-gold/70" style={{ width: `${Number.isFinite(Number(w.firstPassRate)) ? Math.min(100, Math.max(0, Number(w.firstPassRate) * 100)).toFixed(0) : 0}%` }} />
                </div>
                <span className="w-12 text-right text-ink">{pct(w.firstPassRate)}</span>
                <span className="w-8 text-right text-ink3">×{w.decided}</span>
              </div>
            ))}
          </div>
          <div className="min-w-0 break-words rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 break-words text-body font-semibold text-ink">驳回原因分布（使用受控原因才能聚类）</div>
            {(scorecard?.rejectReasons ?? []).length === 0 && <div className="text-body text-ink3">暂无驳回样本</div>}
            {(scorecard?.rejectReasons ?? []).map((r) => (
              <div key={r.reasonEnum} className="flex flex-wrap justify-between gap-2 py-0.5 text-body">
                <span className="text-ink">{reasonLabels[r.reasonEnum] ?? "其他原因"}</span>
                <span className="text-ink3">×{r.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 操作区 */}
        {canWrite && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-3 text-body">
            <button disabled={Boolean(busy)} aria-busy={busy === "mine" || undefined} onClick={() => void doMineNow()} className="max-w-full break-words rounded bg-gold px-3 py-1.5 font-semibold text-bg950 disabled:cursor-wait disabled:opacity-50">
              {busy === "mine" ? "正在提炼…" : "立即运行记忆提炼"}
            </button>
            <span className="text-ink3">（生产由夜班窗口自动运行；统计闸：样本不足只观察不提炼）</span>
            {canRecall && <><span className="mx-1 text-line">|</span>
              <select value={recallMember} disabled={Boolean(busy)} onChange={(e) => setRecallMember(e.target.value)} className="w-56 max-w-full min-w-0 rounded border border-line bg-bg950 px-2 py-1.5 text-ink outline-none focus:border-gold/60">
                <option value="">选择需要清算的来源成员</option>
                {members.map((member) => <option key={member.memberNo} value={member.memberNo}>{member.name}</option>)}
              </select>
              <button disabled={Boolean(busy) || !recallMember} onClick={() => { const member = members.find((item) => item.memberNo === recallMember); if (member) void prepareConfirm({ kind: "recall", memberId: member.memberNo, memberName: member.name }); }} className="max-w-full break-words rounded border border-alert/50 px-3 py-1.5 text-alert hover:bg-alert/10 disabled:cursor-not-allowed disabled:opacity-40">
                清算其偏好记忆
              </button></>}
          </div>
        )}

        {/* 过滤 */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-body">
          {["", "preference", "pattern", "sop", "forbidden"].map((k) => (
            <button
              key={k}
              disabled={Boolean(busy)}
              onClick={() => setKindFilter(k)}
              className={`rounded border px-2.5 py-1 ${kindFilter === k ? "border-gold bg-gold/10 text-ink" : "border-line text-ink3"}`}
            >
              {k === "" ? "全部" : KIND_TEXT[k]}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1 text-ink3">
            <input type="checkbox" checked={showRecalled} onChange={(e) => setShowRecalled(e.target.checked)} />
            查看回收区
          </label>
        </div>

        {/* 记忆列表 */}
        {memories.length === 0 && (
          <div className="rounded-xl border border-line bg-panel p-8 text-center text-body text-ink3">
            {showRecalled ? "回收区暂无记忆。" : "暂无记忆。系统会在你审批、驳回、改稿的过程中持续沉淀——也可以点「立即运行记忆提炼」。"}
          </div>
        )}
        <div className="space-y-2">
          {memories.map((m) => (
            <div key={m.memory_id} className="min-w-0 break-words rounded-xl border border-line bg-panel p-4">
              <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
                <span className={`rounded border px-2 py-0.5 text-body ${KIND_CLS[m.kind]}`}>{KIND_TEXT[m.kind]}</span>
                <span className="text-body text-ink3">记忆记录</span>
                {m.status === "recalled" && <span className="rounded border border-alert/50 px-2 py-0.5 text-body text-alert">已停用</span>}
                {m.subject_id && <span className="break-words text-body text-ink3">适用对象：{actorText(m.subject_id)}</span>}
                <span className="text-body text-ink3 sm:ml-auto">置信度 {Number.isFinite(Number(m.confidence)) ? `${(Number(m.confidence) * 100).toFixed(0)}%` : "待确认"}</span>
              </div>
              {editing?.memoryId === m.memory_id ? (
                <div>
                  <textarea
                    value={editing.content}
                    onChange={(e) => setEditing({ memoryId: m.memory_id, content: e.target.value })}
                    className="mb-2 h-20 w-full resize-none rounded border border-gold/50 bg-bg950 px-2 py-1.5 text-body text-ink outline-none"
                    disabled={busy === `edit-${m.memory_id}`}
                  />
                  <div className="flex gap-2">
                    <button disabled={Boolean(busy) || !editing.content.trim()} aria-busy={busy === `edit-${m.memory_id}` || undefined} onClick={() => void doEdit()} className="rounded bg-gold px-3 py-1 text-body font-semibold text-bg950 disabled:cursor-wait disabled:opacity-50">{busy === `edit-${m.memory_id}` ? "正在保存…" : "保存"}</button>
                    <button disabled={Boolean(busy)} onClick={() => setEditing(null)} className="rounded border border-line px-3 py-1 text-body text-ink3 disabled:opacity-50">取消</button>
                  </div>
                </div>
              ) : (
                <div className="break-words text-body leading-relaxed text-ink">{m.content}</div>
              )}
              <div className="mt-2 flex flex-wrap gap-2 text-body">
                <button disabled={sourceState?.status === "loading"} onClick={() => void viewSources(m.memory_id)} className="text-holo hover:underline disabled:cursor-wait disabled:opacity-50">
                  {sourceState?.memoryId === m.memory_id && sourceState.status === "loading" ? "正在读取归因…" : "归因反查"}
                </button>
                {canWrite && m.status === "active" && editing?.memoryId !== m.memory_id && (
                  <>
                    <button disabled={Boolean(busy)} onClick={() => setEditing({ memoryId: m.memory_id, content: m.content })} className="text-gold hover:underline disabled:opacity-50">
                      编辑
                    </button>
                    <button disabled={Boolean(busy)} onClick={() => void prepareConfirm({ kind: "disable", memoryId: m.memory_id, summary: m.content })} className="text-alert hover:underline disabled:opacity-50">
                      停用
                    </button>
                  </>
                )}
                {canWrite && m.status === "recalled" && (
                  <button disabled={Boolean(busy)} onClick={() => void doReactivate(m.memory_id)} className="text-go hover:underline disabled:opacity-50">
                    {busy === `reactivate-${m.memory_id}` ? "正在恢复…" : "重新启用"}
                  </button>
                )}
              </div>
              {sources?.memoryId === m.memory_id && (
                <div className="mt-2 break-words rounded border border-line bg-bg950 p-2 text-body text-ink3">
                  来源事件 {sources.sourceCount} 条 · 被引用 {sources.usedBy.length} 次
                  {sources.usedBy.length > 0 && `（最近：${sources.usedBy.slice(-3).map(shortId).join("、")}）`}
                  ——每条记忆都可以反查来源与引用记录
                </div>
              )}
              {sourceState?.memoryId === m.memory_id && sourceState.status === "error" && (
                <div className="mt-2 break-words rounded border border-alert/40 bg-alert/5 p-2 text-body text-alert">
                  归因记录暂时无法读取。<button className="ml-2 underline" onClick={() => void viewSources(m.memory_id)}>重新读取</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <Overlay
        open={confirmAction !== null}
        title={confirmAction?.kind === "recall" ? "确认来源记忆清算" : "确认停用这条记忆"}
        description="这是高影响操作。提交前不会改变任何记忆，完成后仍会保留事件账本记录。"
        onClose={() => { if (!busy) { setConfirmAction(null); setImpact(null); } }}
        dismissOnBackdrop={!busy}
        dismissOnEscape={!busy}
        footer={<><Button variant="quiet" disabled={Boolean(busy)} onClick={() => { setConfirmAction(null); setImpact(null); }}>取消</Button><Button variant="danger" busy={busy === "recall" || Boolean(busy?.startsWith("disable-"))} onClick={() => { if (confirmAction?.kind === "recall") void doRecallByMember(); else if (confirmAction?.kind === "disable") void doDisable(confirmAction.memoryId); }}>确认执行</Button></>}
      >
        <div className="space-y-3">
          {confirmAction?.kind === "recall" ? (
            <p>将停用所有来源人为“{confirmAction.memberName}”的偏好记忆，后续数字员工不再引用这些内容。</p>
          ) : (
            <p>将停用记忆“{confirmAction?.summary.slice(0, 120)}”。这不会删除历史记录。</p>
          )}
          {impact && <div className="rounded border border-line bg-bg950 p-3 text-body text-ink2">
            <div className="font-semibold text-ink">服务端影响预览</div>
            <div className="mt-1">记忆：{impact.affectedMemoryIds.length} 条</div>
            <div>数字员工：{impact.agents.length ? impact.agents.map((item) => item.name).join("、") : "没有已知直接引用"}</div>
            <div>关联安全规则：{impact.rules.length ? impact.rules.map((item) => item.name).join("、") : "没有已知直接引用"}</div>
            <div>进行中任务：{impact.activeTasks.length ? impact.activeTasks.map((item) => item.title).join("、") : "没有已知直接引用"}</div>
            <div className="mt-1 text-ink3">{impact.futureTaskPolicy}</div>
          </div>}
        </div>
      </Overlay>
    </Bridge>
  );
}
