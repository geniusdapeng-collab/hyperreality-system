/**
 * P23 组织记忆中心（D24 自我进化飞轮 M2.1 + M5）
 *  - 记忆可读可改可禁用：企业的「口味、规矩、教训」是看得见摸得着的数据资产（信任+纠偏通道）
 *  - 每条记忆可反查来源事件与被引用记录（F1.4 归因闭环）
 *  - 来源人一键清算：成员离任/换岗时作废其手势沉淀的偏好（防个人口味过拟合，D24 修订 2）
 *  - 进化积分卡：北极星=审批一次通过率，趋势看斜率；记忆引用量=偏好注入生效口径
 * 权限态：readonly 隐藏编辑/禁用/清算按钮（服务端 writeProcedure 同样 403，前端隐藏非置灰）
 */
import { useCallback, useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { shortId } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert, SkeletonBlock } from "../../components/hud";

interface MemoryRow {
  memory_id: string;
  scope: "workspace" | "agent" | "run";
  kind: "preference" | "pattern" | "sop" | "forbidden";
  content: string;
  confidence: number;
  subject_id: string | null;
}

interface Scorecard {
  totals: { decided: number; approved: number; edited: number; rejected: number; firstPassRate: number | null; editRate: number | null };
  weekly: Array<{ weekStart: string; decided: number; firstPassRate: number | null }>;
  rejectReasons: Array<{ reasonEnum: string; count: number }>;
  memory: { activeByKind: Record<string, number>; usages30d: number; calibrations30d: number };
}

const KIND_TEXT: Record<string, string> = { preference: "偏好", pattern: "模式", sop: "SOP", forbidden: "禁忌" };
const KIND_CLS: Record<string, string> = {
  preference: "border-gold/50 text-gold",
  pattern: "border-holo/50 text-holo",
  sop: "border-go/50 text-go",
  forbidden: "border-alert/60 text-alert",
};

function pct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}

export default function P23() {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<string>("readonly");
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [kindFilter, setKindFilter] = useState<string>("");
  const [showRecalled, setShowRecalled] = useState(false);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [editing, setEditing] = useState<{ memoryId: string; content: string } | null>(null);
  const [sources, setSources] = useState<{ memoryId: string; usedBy: string[]; sourceCount: number } | null>(null);
  const [recallMember, setRecallMember] = useState("");

  const load = useCallback(async () => {
    const [mems, sc] = await Promise.all([
      trpc.memory.list.query({
        kind: (kindFilter || undefined) as "preference" | "pattern" | "sop" | "forbidden" | undefined,
        status: showRecalled ? undefined : "active",
        limit: 50,
      }) as Promise<MemoryRow[]>,
      trpc.evolution.scorecard.query() as Promise<Scorecard>,
    ]);
    setMemories(mems);
    setScorecard(sc);
  }, [kindFilter, showRecalled]);

  useEffect(() => {
    void (async () => {
      await ensureDemoLogin();
      const me = await trpc.members.me.query().catch(() => null) as { identity?: { role?: string } } | null;
      setRole(me?.identity?.role ?? "owner");
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const canWrite = role !== "readonly";

  const doDisable = async (memoryId: string) => {
    await trpc.memory.disable.mutate({ memoryId });
    setBanner({ level: "info", text: `记忆 ${memoryId} 已禁用（回收区口径，事件留痕可反查）` });
    await load();
  };

  const doEdit = async () => {
    if (!editing) return;
    try {
      await trpc.memory.update.mutate({ memoryId: editing.memoryId, content: editing.content });
      setEditing(null);
      setBanner({ level: "info", text: "记忆已更新（memory.calibrate 留痕）" });
      await load();
    } catch (e) {
      setBanner({ level: "alert", text: `更新被拒：${(e as Error).message.slice(0, 120)}` });
    }
  };

  const doRecallByMember = async () => {
    const memberId = recallMember.trim();
    if (!memberId) return;
    const r = await trpc.memory.recallBySource.mutate({ memberId }) as { recalled: string[] };
    setBanner({ level: "info", text: `来源人「${memberId}」清算完成：作废 ${r.recalled.length} 条偏好记忆（全部留痕）` });
    setRecallMember("");
    await load();
  };

  const doMineNow = async () => {
    const r = await trpc.memory.mineNow.mutate() as { samples: number; reinforced: number; editPatterns: number; skipped?: string };
    setBanner({
      level: r.skipped ? "warn" : "info",
      text: r.skipped ?? `提炼完成：样本 ${r.samples} 条，强化偏好 ${r.reinforced} 条，改稿模式 ${r.editPatterns} 条（memory.calibrate 已留痕）`,
    });
    await load();
  };

  const viewSources = async (memoryId: string) => {
    const r = await trpc.memory.sources.query({ memoryId }) as { sourceEvents: unknown[]; usedBy: string[] };
    setSources({ memoryId, usedBy: r.usedBy, sourceCount: r.sourceEvents.length });
  };

  const t = scorecard?.totals;

  return (
    <Bridge>
      <div className="mx-auto max-w-5xl px-5 py-6">
        <div className="mb-1 text-lg font-bold text-ink">组织记忆中心</div>
        <div className="mb-4 text-xs text-ink3">
          企业的口味、规矩与教训——系统越用越懂你的全部依据。可读、可改、可禁用；每一次变更都进哈希链留痕（D24 自我进化飞轮）。
        </div>

        {banner && (
          <div onClick={() => setBanner(null)}>
            <BannerAlert level={banner.level}>{banner.text}</BannerAlert>
          </div>
        )}

        {/* 进化积分卡（M5：北极星 + 趋势斜率） */}
        <div className="mb-5 grid grid-cols-4 gap-3">
          <div className="rounded-xl border border-gold/40 bg-panel p-4">
            <div className="text-[11px] tracking-widest text-ink3">北极星 · 审批一次通过率</div>
            <div className="mt-1 text-2xl font-bold text-gold">{pct(t?.firstPassRate ?? null)}</div>
            <div className="mt-1 text-[11px] text-ink3">已裁决 {t?.decided ?? 0} 条（批 {t?.approved ?? 0} / 改 {t?.edited ?? 0} / 驳 {t?.rejected ?? 0}）</div>
          </div>
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="text-[11px] tracking-widest text-ink3">人类修改率</div>
            <div className="mt-1 text-2xl font-bold text-ink">{pct(t?.editRate ?? null)}</div>
            <div className="mt-1 text-[11px] text-ink3">改稿占比，越低说明提案越贴合</div>
          </div>
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="text-[11px] tracking-widest text-ink3">记忆引用（30 天）</div>
            <div className="mt-1 text-2xl font-bold text-ink">{scorecard?.memory.usages30d ?? 0}</div>
            <div className="mt-1 text-[11px] text-ink3">偏好注入生效次数（F1.4 归因）</div>
          </div>
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="text-[11px] tracking-widest text-ink3">进化活动（30 天）</div>
            <div className="mt-1 text-2xl font-bold text-ink">{scorecard?.memory.calibrations30d ?? 0}</div>
            <div className="mt-1 text-[11px] text-ink3">memory.calibrate 事件数</div>
          </div>
        </div>

        {/* 周趋势 + 驳回分布 */}
        <div className="mb-5 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 text-xs font-semibold text-ink">一次通过率 · 近 8 周（飞轮看斜率）</div>
            {(scorecard?.weekly ?? []).length === 0 && <div className="text-xs text-ink3">暂无裁决样本</div>}
            {(scorecard?.weekly ?? []).map((w) => (
              <div key={w.weekStart} className="flex items-center gap-2 py-0.5 text-xs">
                <span className="w-20 text-ink3">{w.weekStart.slice(5)}</span>
                <div className="h-2 flex-1 rounded bg-bg950">
                  <div className="h-2 rounded bg-gold/70" style={{ width: `${((w.firstPassRate ?? 0) * 100).toFixed(0)}%` }} />
                </div>
                <span className="w-12 text-right text-ink">{pct(w.firstPassRate)}</span>
                <span className="w-8 text-right text-ink3">×{w.decided}</span>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 text-xs font-semibold text-ink">驳回原因分布（受控枚举才能聚类，M1.2）</div>
            {(scorecard?.rejectReasons ?? []).length === 0 && <div className="text-xs text-ink3">暂无驳回样本</div>}
            {(scorecard?.rejectReasons ?? []).map((r) => (
              <div key={r.reasonEnum} className="flex justify-between py-0.5 text-xs">
                <span className="text-ink">{r.reasonEnum}</span>
                <span className="text-ink3">×{r.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 操作区 */}
        {canWrite && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-3 text-xs">
            <button onClick={() => void doMineNow()} className="rounded bg-gold px-3 py-1.5 font-semibold text-bg950">
              立即运行记忆提炼
            </button>
            <span className="text-ink3">（生产由夜班窗口自动运行；统计闸：样本不足只观察不提炼）</span>
            <span className="mx-1 text-line">|</span>
            <input
              value={recallMember}
              onChange={(e) => setRecallMember(e.target.value)}
              placeholder="来源人清算：成员编号（如 MEM-001）"
              className="w-56 rounded border border-line bg-bg950 px-2 py-1.5 text-ink outline-none focus:border-gold/60"
            />
            <button onClick={() => void doRecallByMember()} className="rounded border border-alert/50 px-3 py-1.5 text-alert hover:bg-alert/10">
              一键清算其偏好记忆
            </button>
          </div>
        )}

        {/* 过滤 */}
        <div className="mb-3 flex items-center gap-2 text-xs">
          {["", "preference", "pattern", "sop", "forbidden"].map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={`rounded border px-2.5 py-1 ${kindFilter === k ? "border-gold bg-gold/10 text-ink" : "border-line text-ink3"}`}
            >
              {k === "" ? "全部" : KIND_TEXT[k]}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1 text-ink3">
            <input type="checkbox" checked={showRecalled} onChange={(e) => setShowRecalled(e.target.checked)} />
            显示回收区
          </label>
        </div>

        {/* 记忆列表 */}
        {!ready && <SkeletonBlock lines={4} />}
        {ready && memories.length === 0 && (
          <div className="rounded-xl border border-line bg-panel p-8 text-center text-xs text-ink3">
            暂无记忆。系统会在你审批、驳回、改稿的过程中持续沉淀——也可以点「立即运行记忆提炼」。
          </div>
        )}
        <div className="space-y-2">
          {memories.map((m) => (
            <div key={m.memory_id} className="rounded-xl border border-line bg-panel p-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span className={`rounded border px-2 py-0.5 text-[11px] ${KIND_CLS[m.kind]}`}>{KIND_TEXT[m.kind]}</span>
                <span className="text-[11px] text-ink3">{m.memory_id}</span>
                {m.subject_id && <span className="text-[11px] text-ink3">主体：{m.subject_id}</span>}
                <span className="ml-auto text-[11px] text-ink3">置信度 {(Number(m.confidence) * 100).toFixed(0)}%</span>
              </div>
              {editing?.memoryId === m.memory_id ? (
                <div>
                  <textarea
                    value={editing.content}
                    onChange={(e) => setEditing({ memoryId: m.memory_id, content: e.target.value })}
                    className="mb-2 h-20 w-full resize-none rounded border border-gold/50 bg-bg950 px-2 py-1.5 text-xs text-ink outline-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => void doEdit()} className="rounded bg-gold px-3 py-1 text-xs font-semibold text-bg950">保存</button>
                    <button onClick={() => setEditing(null)} className="rounded border border-line px-3 py-1 text-xs text-ink3">取消</button>
                  </div>
                </div>
              ) : (
                <div className="text-xs leading-relaxed text-ink">{m.content}</div>
              )}
              <div className="mt-2 flex gap-2 text-[11px]">
                <button onClick={() => void viewSources(m.memory_id)} className="text-holo hover:underline">
                  归因反查
                </button>
                {canWrite && editing?.memoryId !== m.memory_id && (
                  <>
                    <button onClick={() => setEditing({ memoryId: m.memory_id, content: m.content })} className="text-gold hover:underline">
                      编辑
                    </button>
                    <button onClick={() => void doDisable(m.memory_id)} className="text-alert hover:underline">
                      禁用
                    </button>
                  </>
                )}
              </div>
              {sources?.memoryId === m.memory_id && (
                <div className="mt-2 rounded border border-line bg-bg950 p-2 text-[11px] text-ink3">
                  来源事件 {sources.sourceCount} 条 · 被引用 {sources.usedBy.length} 次
                  {sources.usedBy.length > 0 && `（最近：${sources.usedBy.slice(-3).map(shortId).join("、")}）`}
                  ——任一记忆可反查来源（F1.4 验收断言）
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Bridge>
  );
}
