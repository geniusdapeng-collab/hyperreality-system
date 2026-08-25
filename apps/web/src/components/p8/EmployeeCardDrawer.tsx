/**
 * P8 员工卡（五层活档案 · 侧滑抽屉）
 *  ① 人格层：渐变方块头像 + 工种 emoji + 工种 + 人设一句话（preset meta.description）
 *  ② 专长层：挂载技能清单 + 围栏绑定徽章（fence_bindings → G 系列章）
 *  ③ 状态层：当前任务 / 今日动作数 / 在线·夜班中（roster 投影，缺则兜底「待命」）
 *  ④ 成绩单层：EMPLOYEE_SCORECARD 六指标行业口径（按 preset_key）；
 *     数值经 captain 成绩单/决策回测端点取数，缺省显示「本周未出评」
 *  ⑤ 记忆层：被驳回样本 / 校准记录入口（下钻链到相关事件列表 → P2，缺数据显「暂无」）
 *  操作：「@派活」（建线程预填 @该员工 → P2）/「看记忆」（下钻记忆层）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { BannerAlert, EventIdChip } from "../hud";
import { scorecardOf } from "./employeeScorecard";

/** 团队成员行投影（与 server roster.list 的 agents 行结构对齐，结构性传入） */
export interface EmployeeRow {
  id: string; presetKey: string; name: string; version: string; kind: string;
  readonly: boolean; status: string; invalidReason: string | null;
  fenceBindings: string[]; skills: string[];
  nightShift: boolean; highRisk: boolean; description: string; online: boolean;
  stats: {
    actions30: number; adopted30: number; rejected30: number;
    adoptionRate: number | null; credits30: number; offPeakRatio: number | null;
  };
}

/** 档案事件投影（roster.profile.events 行） */
interface ProfileEvent {
  eventId: string; sessionId: string | null; time: string;
  action: string; objectType: string; ruleResults: string[]; receiptSynced: boolean;
}
interface EmployeeProfile {
  skills: Array<{ id: string; name: string; level: string; version: string; fence_bindings: string[]; installed: boolean }>;
  events: ProfileEvent[];
}

/** 工种 emoji（按 kind/名称语义映射） */
function kindEmoji(a: EmployeeRow): string {
  const k = `${a.kind} ${a.presetKey} ${a.name}`;
  if (/render|渲染/.test(k)) return "🎬";
  if (/publish|发布/.test(k)) return "🚀";
  if (/comment|评论/.test(k)) return "💬";
  if (/metrics|看板|数据/.test(k)) return "📊";
  if (/research|情报|调研/.test(k)) return "🎯";
  if (/reviewer|审查|质检/.test(k)) return "🔍";
  if (/artist|美术|设计/.test(k)) return "🎨";
  if (/orchestrator|导演|编排/.test(k)) return "🎬";
  if (/analyst|分析/.test(k)) return "📈";
  if (/operator/.test(k)) return "⚙️";
  if (/content|剧本|策划|文案/.test(k)) return "📝";
  return "🛠";
}

/** 工种中文标签（preset kind → 展示口径） */
const KIND_LABEL: Record<string, string> = {
  operator: "执行工种", content: "内容工种", research: "情报工种",
  reviewer: "审查工种", analyst: "分析工种", artist: "美术工种", orchestrator: "编排工种",
};

/** 围栏绑定徽章（G 系列章 · 金边） */
function FenceMedal({ ruleId }: { ruleId: string }) {
  return (
    <span className="rounded border border-gold/50 bg-gold/10 px-1.5 py-0.5 font-mono text-micro font-bold text-goldhi" title="围栏绑定（声明即许可 F2.10）">
      🛡 {ruleId}
    </span>
  );
}

export function EmployeeCardDrawer({
  agent,
  nightRange,
  canDispatch,
  onClose,
}: {
  agent: EmployeeRow;
  nightRange: string;
  canDispatch: boolean;
  onClose: () => void;
}) {
  const nav = useNavigate();
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [grade, setGrade] = useState<string | null>(null); // captain 周评议（hr.review）
  const [goal, setGoal] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const memoryRef = useRef<HTMLDivElement | null>(null);

  /* 档案细节（技能包/事件流）+ captain 评议（缺数据优雅兜底） */
  const load = useCallback(async () => {
    await ensureDemoLogin();
    try {
      const prof = await trpc.roster.profile.query({ agentId: agent.id }) as EmployeeProfile | null;
      setProfile(prof);
    } catch {
      setProfile(null);
    }
    try {
      const th = await trpc.captain.theater.query() as {
        satellites: Array<{ id: string; presetKey: string; name: string; grade: string }>;
      };
      const g = th.satellites.find((s) => s.id === agent.id || s.presetKey === agent.presetKey)?.grade ?? null;
      // 「正常」为默认档而非评议结论——仅展示真实评议结果（表扬/关注/辅导）
      setGrade(g && g !== "正常" ? g : null);
    } catch {
      setGrade(null); // 成绩单端点缺数据 → 「本周未出评」兜底
    }
  }, [agent.id, agent.presetKey]);

  useEffect(() => {
    setProfile(null);
    setGrade(null);
    setComposerOpen(false);
    setGoal("");
    setBanner(null);
    void load();
  }, [load]);

  /** @派活：预填 @该员工 → 建线程 → 跳 P2（含糊反问不建单 F3.2） */
  const dispatch = useCallback(async () => {
    const title = goal.trim();
    if (!title) return;
    setSending(true);
    try {
      const r = await trpc.threads.dispatch.mutate({
        title, presetKey: agent.presetKey, runImmediately: false,
      }) as { kind: "clarify"; question: string } | { kind: "routed"; threadId: string };
      if (r.kind === "clarify") {
        setBanner({ level: "warn", text: `意图含糊，未建任务（F3.2）：${r.question}` });
      } else {
        nav(`/p2/${encodeURIComponent(r.threadId)}`);
      }
    } finally {
      setSending(false);
    }
  }, [goal, agent.presetKey, nav]);

  const spec = scorecardOf(agent.presetKey);
  const latestAction = profile?.events[0]?.action ?? null;
  // 记忆层：被驳回样本（30 天驳回计数）+ 校准记录（触围栏 review/block 的事件留痕，下钻 → P2）
  const calibrationEvents = (profile?.events ?? []).filter((e) =>
    e.ruleResults.some((r) => /:(review|block)$/.test(r)),
  );
  const statusText = agent.status === "invalid"
    ? "校验失败 · 禁写"
    : agent.online
      ? "夜班在线"
      : agent.readonly
        ? "只读待命"
        : "待命";
  const statusCls = agent.status === "invalid" ? "text-alert" : agent.online ? "text-holo" : "text-ink3";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label={`员工卡 · ${agent.name}`}>
      {/* 背板（点击关闭） */}
      <button type="button" aria-label="关闭员工卡" onClick={onClose} className="absolute inset-0 cursor-pointer bg-bg900/70 backdrop-blur-sm" />
      <div className="relative flex h-full w-[460px] max-w-full flex-col overflow-y-auto border-l border-gline bg-bg800 shadow-[0_0_60px_rgba(0,0,0,.6)]">
        {/* 头部 */}
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg800/95 px-4 py-3 backdrop-blur">
          <span className="text-[11px] tracking-[.2em] text-ink3">员工卡 · 五层活档案</span>
          <span className="ml-auto font-mono text-micro text-ink3">{agent.id}</span>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded border border-line px-2 py-0.5 text-caption text-ink3 hover:border-gline hover:text-ink2"
          >
            ✕ 关闭
          </button>
        </div>

        <div className="flex flex-col gap-3 p-4">
          {banner && (
            <BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert>
          )}

          {/* ① 人格层 */}
          <section className="rounded-msg border border-line bg-card p-3.5">
            <div className="mb-2 text-micro font-bold tracking-wider text-ink3">① 人格层 · PERSONA</div>
            <div className="flex items-center gap-3">
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border-2 border-gline text-[26px]"
                style={{ background: "linear-gradient(135deg, rgba(212,175,55,.35), rgba(69,224,255,.18) 60%, rgba(36,27,77,.5))" }}
              >
                {kindEmoji(agent)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-h1 font-black text-ink">{agent.name}</span>
                  <span className="font-mono text-micro text-ink3">{agent.version}</span>
                </div>
                <div className="mt-0.5 text-caption text-holo">
                  {KIND_LABEL[agent.kind] ?? agent.kind} · {agent.presetKey}
                  {agent.readonly && <span className="ml-1.5 text-go">只读</span>}
                  {agent.highRisk && <span className="ml-1.5 text-warn">高危逐次授权</span>}
                </div>
              </div>
            </div>
            <p className="mt-2.5 border-t border-line/60 pt-2 text-caption leading-relaxed text-ink2">
              {agent.description || "（preset 未填写人设一句话）"}
            </p>
          </section>

          {/* ② 专长层 */}
          <section className="rounded-msg border border-line bg-card p-3.5">
            <div className="mb-2 text-micro font-bold tracking-wider text-ink3">② 专长层 · EXPERTISE</div>
            {profile === null ? (
              <div className="text-caption text-ink3">技能清单加载中…</div>
            ) : profile.skills.length === 0 ? (
              <div className="text-caption text-ink3">暂无挂载技能（→P6 技能中心安装）</div>
            ) : (
              <div className="space-y-1.5">
                {profile.skills.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => nav("/p6")}
                    title="技能 → P6 技能中心"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-bg800/40 px-2.5 py-1.5 text-left text-caption hover:border-gline"
                  >
                    <span className="min-w-0 flex-1 truncate text-ink2">🎒 {s.name} <span className="font-mono text-micro text-ink3">v{s.version}</span></span>
                    <span className={`shrink-0 text-micro ${s.installed ? "text-go" : "text-warn"}`}>{s.installed ? "已装备" : "未安装"}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2.5 border-t border-line/60 pt-2">
              <div className="mb-1 text-micro text-ink3">围栏绑定（G 系列章 · 声明即许可 F2.10）</div>
              {agent.fenceBindings.length === 0 ? (
                <div className="text-caption text-warn">未声明围栏 · 系统级禁写</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {agent.fenceBindings.map((r) => <FenceMedal key={r} ruleId={r} />)}
                </div>
              )}
            </div>
          </section>

          {/* ③ 状态层 */}
          <section className="rounded-msg border border-line bg-card p-3.5">
            <div className="mb-2 text-micro font-bold tracking-wider text-ink3">③ 状态层 · STATUS</div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-line bg-bg800/40 p-2.5">
                <div className="text-micro text-ink3">当前任务</div>
                <div className="mt-0.5 truncate text-caption text-ink2" title={latestAction ?? ""}>
                  {latestAction ?? "无在办任务"}
                </div>
              </div>
              <div className="rounded-lg border border-line bg-bg800/40 p-2.5">
                <div className="text-micro text-ink3">今日动作数</div>
                <div className="mt-0.5 font-orb text-caption text-ink2">—</div>
                <div className="text-[9.5px] text-ink3">投影未含当日分桶</div>
              </div>
              <div className="rounded-lg border border-line bg-bg800/40 p-2.5">
                <div className="text-micro text-ink3">在线状态</div>
                <div className={`mt-0.5 text-caption font-bold ${statusCls}`}>
                  {agent.online && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-holo shadow-[0_0_6px_rgba(69,224,255,.8)]" />}
                  {statusText}
                </div>
                {agent.nightShift && <div className="text-[9.5px] text-ink3">夜班窗口 {nightRange} 自动上线</div>}
              </div>
            </div>
          </section>

          {/* ④ 成绩单层（六指标行业口径 · EMPLOYEE_SCORECARD 映射） */}
          <section className="rounded-msg border border-line bg-card p-3.5">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-micro font-bold tracking-wider text-ink3">④ 成绩单层 · {spec.title}</span>
              {grade && (
                <span className={`rounded border px-1.5 py-0.5 text-micro font-bold ${
                  grade === "表扬" ? "border-go/50 bg-go/10 text-go"
                    : grade === "关注" ? "border-warn/50 bg-warn/10 text-warn"
                      : "border-alert/50 bg-alert/10 text-alert"
                }`}>
                  本周评议 · {grade}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {spec.metrics.map((m) => (
                <div key={m.key} className="rounded-lg border border-line bg-bg800/40 p-2.5" title={m.hint}>
                  <div className="text-micro text-ink3">{m.label}</div>
                  <div className="mt-0.5 text-caption text-ink3">本周未出评</div>
                </div>
              ))}
            </div>
            <div className="mt-2 text-micro text-ink3">
              数值经 captain 成绩单/决策回测端点取数；未出评周期显示「本周未出评」，不伪造
            </div>
          </section>

          {/* ⑤ 记忆层 */}
          <section ref={memoryRef} className="rounded-msg border border-line bg-card p-3.5">
            <div className="mb-2 text-micro font-bold tracking-wider text-ink3">⑤ 记忆层 · MEMORY</div>
            <div className="mb-2 text-caption text-ink2">
              被驳回样本 <b className={`font-orb ${agent.stats.rejected30 > 0 ? "text-warn" : "text-ink3"}`}>{agent.stats.rejected30}</b> 件 / 30 天
              <span className="ml-1 text-micro text-ink3">（驳回原因进偏好模式 F1.7）</span>
            </div>
            {profile === null ? (
              <div className="text-caption text-ink3">校准记录加载中…</div>
            ) : calibrationEvents.length === 0 ? (
              <div className="text-caption text-ink3">暂无校准记录（触围栏 review/block 的事件会出现在这里）</div>
            ) : (
              <div className="space-y-1.5">
                {calibrationEvents.map((e) => (
                  <button
                    key={e.eventId}
                    type="button"
                    onClick={() => e.sessionId?.startsWith("T-") && nav(`/p2/${encodeURIComponent(e.sessionId)}`)}
                    title={e.sessionId ? `下钻事件 → 线程 ${e.sessionId}（P2）` : "无线程上下文"}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg border-l-2 border-warn/50 bg-bg800/30 px-2.5 py-1.5 text-left hover:border-l-gold"
                  >
                    <EventIdChip id={e.eventId} />
                    <span className="min-w-0 flex-1 truncate text-caption text-ink2">
                      {e.action}
                      <span className="ml-1 text-micro text-warn">{e.ruleResults.filter((r) => /:(review|block)$/.test(r)).join(" ")}</span>
                    </span>
                    <span className="shrink-0 text-micro text-ink3">{e.sessionId ?? "—"}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* 操作：@派活 / 看记忆 */}
          <div className="sticky bottom-0 flex gap-2 border-t border-line bg-bg800/95 py-3 backdrop-blur">
            {canDispatch && (
              <button
                type="button"
                onClick={() => {
                  setComposerOpen((v) => !v);
                  if (!composerOpen && !goal) setGoal(`@${agent.name} `);
                }}
                className="cursor-pointer rounded-lg gold-grad px-4 py-2 text-caption font-black text-ongold"
              >
                💬 @派活
              </button>
            )}
            <button
              type="button"
              onClick={() => memoryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="cursor-pointer rounded-lg border border-line px-4 py-2 text-caption text-ink2 hover:border-holo/50"
            >
              🧠 看记忆
            </button>
          </div>
          {composerOpen && canDispatch && (
            <div className="rounded-msg border border-gline bg-card p-3">
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={2}
                placeholder={`@${agent.name} 要做什么（含糊将反问不建单 F3.2）`}
                className="w-full rounded-lg border border-line bg-bg900 px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
              />
              <button
                type="button"
                disabled={!goal.trim() || sending}
                onClick={() => void dispatch()}
                className="mt-2 cursor-pointer rounded-lg gold-grad px-4 py-1.5 text-caption font-black text-ongold disabled:opacity-40"
              >
                建线程并跳 P2 任务中心 →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
