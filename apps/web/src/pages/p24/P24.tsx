/**
 * P24 · 考试院（方案 V2.0 §9）
 * 内置 AI 员工评测中心：成绩单看板（四维记分卡）/ 考试记录 / 题库 / 设置
 * 数据：trpc.service.eval.*（硬轨零 token；软题 L3 阅卷 P1 接入）
 */
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AsyncState, Button, Overlay, SectionNavigation, clientChineseText } from "@workloom/ui";
import { operationFailure, toUiFailure } from "../../lib/ui-state";
import { useNavigationAccess } from "../../shell/NavigationAccess";

/* ---------------- 类型（与服务端对齐） ---------------- */
interface DimScores { accuracy: number; recall: number; latency: number; satisfaction: number }
interface ExamRow {
  id: string; examType: string; triggerSource: string; totalQuestions: number;
  status: string; totalScore: number | null; dimScores: DimScores | null;
  redLineHit: boolean; verdict: "pass" | "warn" | "fail" | null;
  startedAt: string; finishedAt: string | null;
}
interface Report {
  id: string; exam_id: string; total_score: string; dim_scores: DimScores;
  delta: { total: number | null; perDim: Partial<Record<keyof DimScores, number>> } | null;
  verdict: string; red_line_hit: boolean; wrong_count: number;
  suggestions: Array<{ questionId: string; attribution: string | null; suggestion: string | null }>;
  created_at: string;
}
interface Question {
  id: string; subject: string; structure: string; primaryDimensions: string[];
  redLine: boolean; difficulty: string; source: string; tags: string[];
  scenario: { turns: Array<{ role: string; input: string }> };
}
interface EvalSettings {
  on_change_enabled: boolean; weekly_enabled: boolean; promotion_gate: boolean;
  pass_line: string; warn_line: string; budget_monthly_tokens: string;
}

const DIM_META: Array<{ key: keyof DimScores; label: string }> = [
  { key: "accuracy", label: "准确率" },
  { key: "recall", label: "召回率" },
  { key: "satisfaction", label: "满意度" },
  { key: "latency", label: "耗时" },
];
const STRUCTURE_TEXT: Record<string, string> = {
  "single-single": "单轮单意图", "single-multi": "单轮多意图",
  "multi-single": "多轮单意图", "multi-multi": "多轮多意图", adversarial: "对抗边界",
};
const VERDICT_META: Record<string, { text: string; cls: string }> = {
  pass: { text: "通过", cls: "text-go" },
  warn: { text: "预警", cls: "text-warn" },
  fail: { text: "不合格", cls: "text-alert" },
};
const EXAM_TYPE_TEXT: Record<string, string> = {
  "on-change": "变更即考", weekly: "周考", onboarding: "上岗考",
};
const ATTRIBUTION_TEXT: Record<string, string> = {
  intent: "意图理解错", skill: "技能产出错", knowledge: "知识检索错",
  tool: "工具调用错", "fence-config": "安全规则配置错", "model-tier": "模型档位错",
};
const EXAM_STATUS_TEXT: Record<string, string> = {
  pending: "等待开始", running: "考试中", completed: "已完成", failed: "考试失败", grading: "判卷中",
};
const SUBJECT_TEXT: Record<string, string> = {
  skill: "技能执行", fence: "安全规则治理", "knowledge-base": "知识检索", crew: "团队协作", "biz-flow": "业务流程",
};

function safeNarrative(value: string | null | undefined, fallback: string): string {
  return clientChineseText(value, fallback);
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待确认" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type Tab = "report" | "exams" | "questions" | "settings";
const TAB_ITEMS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "report", label: "成绩单" },
  { id: "exams", label: "考试记录" },
  { id: "questions", label: "题库" },
  { id: "settings", label: "设置" },
];
function tabFromSearch(search: string): Tab {
  const value = new URLSearchParams(search).get("section");
  return TAB_ITEMS.some((item) => item.id === value) ? value as Tab : "report";
}

export default function P24() {
  const { canAction } = useNavigationAccess();
  const { search } = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(() => tabFromSearch(search));
  const [report, setReport] = useState<Report | null>(null);
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [settings, setSettings] = useState<EvalSettings | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadMessage, setLoadMessage] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [running, setRunning] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [confirmExam, setConfirmExam] = useState(false);
  const [gateTarget, setGateTarget] = useState<boolean | null>(null);
  const [toast, setToast] = useState("");

  const load = useCallback(async (background = false) => {
    if (!background) setLoadState("loading");
    try {
      await ensureDemoLogin();
      const svc = trpc.service as unknown as {
        eval: {
          latestReport: { query: () => Promise<{ report: Report | null }> };
          listExams: { query: () => Promise<{ exams: ExamRow[] }> };
          listQuestions: { query: () => Promise<{ questions: Question[] }> };
          settings: { query: () => Promise<{ settings: EvalSettings }> };
        };
      };
      const [r, e, q, st] = await Promise.all([
        svc.eval.latestReport.query(),
        svc.eval.listExams.query(),
        svc.eval.listQuestions.query(),
        svc.eval.settings.query(),
      ]);
      setReport(r.report);
      setExams(e.exams);
      setQuestions(q.questions);
      setSettings(st.settings);
      setHasSnapshot(true);
      setLastLoadedAt(new Date());
      setLoadMessage("");
      setLoadState("ready");
    } catch (error) {
      console.warn("读取考试数据失败", error);
      const failure = toUiFailure(error);
      setLoadMessage(operationFailure(error, "读取考试数据"));
      setLoadState(failure.kind === "forbidden" ? "forbidden" : "error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setTab(tabFromSearch(search)); }, [search]);

  const selectTab = (next: Tab) => {
    const params = new URLSearchParams(search);
    params.set("section", next);
    setTab(next);
    navigate({ search: `?${params.toString()}` });
  };

  const runExam = async () => {
    if (running) return;
    setRunning(true);
    setToast("");
    try {
      const svc = trpc.service as unknown as {
        eval: { runExam: { mutate: (i: { examType: "weekly" }) => Promise<{ exam: ExamRow; wrongCount: number }> } };
      };
      const r = await svc.eval.runExam.mutate({ examType: "weekly" });
      setConfirmExam(false);
      setToast(`服务端已完成本场考试：总分 ${finiteNumber(r.exam.totalScore) ?? "待判定"}，错题 ${finiteNumber(r.wrongCount) ?? "待确认"} 道。`);
      await load(true);
    } catch (error) {
      console.warn("立即开考失败", error);
      setToast(operationFailure(error, "开考"));
    } finally {
      setRunning(false);
    }
  };

  const toggleGate = async (enabled: boolean) => {
    if (gateBusy) return;
    setGateBusy(true);
    setToast("");
    try {
      const svc = trpc.service as unknown as {
        eval: { setPromotionGate: { mutate: (i: { enabled: boolean }) => Promise<unknown> } };
      };
      await svc.eval.setPromotionGate.mutate({ enabled });
      setGateTarget(null);
      await load(true);
      setToast(enabled ? "服务端已确认开启晋升门禁，后续晋升将按考试结论拦截。" : "服务端已确认关闭晋升门禁，考试结果仍会保留但不自动拦截。" );
    } catch (error) {
      console.warn("更新晋升门禁失败", error);
      setToast(operationFailure(error, "晋升门禁更新"));
    } finally {
      setGateBusy(false);
    }
  };

  const score = report ? finiteNumber(report.total_score) : null;
  const vm = report ? VERDICT_META[report.verdict] : null;
  const canRunExam = loadState === "ready" && canAction("exam.run");

  if (!hasSnapshot) {
    return (
      <div className="mx-auto max-w-[760px] px-6 py-16 text-ink">
        <AsyncState
          status={loadState === "forbidden" ? "forbidden" : loadState === "error" ? "error" : "loading"}
          title={loadState === "loading" ? "正在读取考试数据" : undefined}
          description={loadMessage || "考试版本、门禁和成绩确认完成前，不会显示空数据或放行结论。"}
          onRetry={loadState === "error" ? () => void load() : undefined}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-5 text-ink">
      {/* 头部 */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">上岗考试</h1>
          <p className="mt-0.5 break-words text-body text-ink2">数字员工评测 · 四维记分卡 · 规则判卷与模型判卷双轨运行 · 红线一票否决</p>
        </div>
        {canRunExam ? <button
            onClick={() => setConfirmExam(true)}
            disabled={running}
            className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-body font-semibold text-ongold shadow hover:opacity-90 disabled:opacity-50"
          >
            {running ? "考试中……" : "立即开考（周考）"}
          </button> : <span className="rounded-lg border border-line px-3 py-2 text-body text-ink3">当前角色仅可查看</span>}
      </div>
      {toast && (
        <div className="mb-3 break-words rounded-lg border border-gline bg-bg800 px-3 py-2 text-body text-ink">{toast}</div>
      )}
      {loadState !== "ready" && (
        <div className="mb-3 break-words rounded-lg border border-warn/50 bg-warn/5 px-3 py-2 text-body text-warn" role="alert">
          {loadMessage} 正在显示 {lastLoadedAt ? lastLoadedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "此前"} 的成功快照；错误期间不会变更晋升结论。
          <button className="ml-2 underline" onClick={() => void load()}>重新加载</button>
        </div>
      )}

      <div className="wl-section-layout">
        <SectionNavigation
          label="上岗考试分区"
          items={TAB_ITEMS.map((item) => item.id === "questions" ? { ...item, badge: questions.length } : item)}
          activeId={tab}
          onSelect={(item) => selectTab(item.id as Tab)}
        />
        <section className="min-w-0" aria-label={TAB_ITEMS.find((item) => item.id === tab)?.label}>

      {/* 成绩单 */}
      {tab === "report" && (
        <div>
          {!report ? (
            <Empty text="还没有考试成绩——点右上角「立即开考」出第一份成绩单" />
          ) : (
            <>
              {/* 总分卡 + 四维记分卡 */}
              <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-[220px_1fr]">
                <div className="rounded-xl border border-line bg-card p-5 text-center">
                  <div className="text-[42px] font-bold leading-none" style={{ color: report.verdict === "pass" ? "var(--color-go)" : report.verdict === "warn" ? "var(--color-warn)" : "var(--color-alert)" }}>
                    {score}
                  </div>
                  <div className={`mt-2 text-body font-semibold ${vm?.cls}`}>
                    {vm?.text}{report.red_line_hit && " · 触碰红线"}
                  </div>
                  {report.delta?.total !== null && report.delta?.total !== undefined && (
                    <div className="mt-1 text-body text-ink2">
                      较上场 {finiteNumber(report.delta.total) === null ? "变化待确认" : `${report.delta.total >= 0 ? "+" : ""}${report.delta.total}`}
                    </div>
                  )}
                  <div className="mt-2 text-body text-ink3">错题 {report.wrong_count} 道</div>
                </div>
                <div className="rounded-xl border border-line bg-card p-5">
                  <div className="mb-3 text-body font-semibold">四维记分卡</div>
                  <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
                    {DIM_META.map(({ key, label }) => {
                      const v = finiteNumber(report.dim_scores?.[key]);
                      const d = finiteNumber(report.delta?.perDim?.[key]);
                      return (
                        <div key={key}>
                          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-body">
                            <span className="text-ink2">{label}</span>
                            <span>
                              <b className="text-ink">{v === null ? "—" : Math.round(v)}</b>
                              {d !== null && (
                                <span className={`ml-1.5 text-body ${d >= 0 ? "text-go" : "text-alert"}`}>
                                  {d >= 0 ? "+" : ""}{d}
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-bg700">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-goldhi to-gold2"
                              style={{ width: `${v === null ? 0 : Math.min(100, Math.max(0, v))}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 建议动作 */}
              {report.suggestions?.length > 0 && (
                <div className="rounded-xl border border-line bg-card p-5">
                  <div className="mb-3 text-body font-semibold">错题归因与建议动作</div>
                  <div className="space-y-2">
                    {report.suggestions.map((s, i) => (
                      <div key={i} className="flex min-w-0 items-start gap-3 rounded-lg bg-bg800 px-3 py-2.5 text-body">
                        <span className="shrink-0 rounded bg-alert/15 px-2 py-0.5 font-medium text-alert">
                          {s.attribution ? ATTRIBUTION_TEXT[s.attribution] ?? "其他原因" : "待归因"}
                        </span>
                        <span className="text-ink2">{safeNarrative(s.suggestion, "请根据本题结果复核相关技能、知识或安全规则配置。")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 考试记录 */}
      {tab === "exams" && (
        <div className="overflow-x-auto rounded-xl border border-line bg-card">
          {exams.length === 0 ? <Empty text="暂无考试记录" /> : (
            <table className="w-full text-body">
              <thead>
                <tr className="border-b border-line text-left text-ink3">
                  <th className="px-4 py-2.5 font-medium">场次</th>
                  <th className="px-4 py-2.5 font-medium">类型</th>
                  <th className="px-4 py-2.5 font-medium">题量</th>
                  <th className="px-4 py-2.5 font-medium">总分</th>
                  <th className="px-4 py-2.5 font-medium">结论</th>
                  <th className="px-4 py-2.5 font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {exams.map((e, index) => (
                  <tr key={e.id} className="border-b border-line/50 last:border-0 hover:bg-bg800/50">
                    <td className="px-4 py-2.5 text-body text-ink2">第 {exams.length - index} 场</td>
                    <td className="px-4 py-2.5">{EXAM_TYPE_TEXT[e.examType] ?? "其他考试"}</td>
                    <td className="px-4 py-2.5">{e.totalQuestions}</td>
                    <td className="px-4 py-2.5 font-semibold">{e.totalScore ?? "—"}</td>
                    <td className={`px-4 py-2.5 font-medium ${e.verdict ? VERDICT_META[e.verdict]?.cls : ""}`}>
                      {e.verdict ? VERDICT_META[e.verdict]?.text : EXAM_STATUS_TEXT[e.status] ?? "状态待确认"}
                      {e.redLineHit && <span className="ml-1 text-alert">·红线</span>}
                    </td>
                    <td className="px-4 py-2.5 text-ink3">{formatDateTime(e.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 题库 */}
      {tab === "questions" && (
        <div className="space-y-2">
          {questions.length === 0 ? <Empty text="题库为空——开考时自动播种行业种子题" /> : questions.map((q) => (
            <div key={q.id} className="rounded-xl border border-line bg-card px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-body">
                <span className="rounded bg-holo/15 px-2 py-0.5 font-medium text-holo">{STRUCTURE_TEXT[q.structure] ?? "其他题型"}</span>
                <span className="rounded bg-bg700 px-2 py-0.5 text-ink2">{SUBJECT_TEXT[q.subject] ?? "综合能力"}</span>
                {q.redLine && <span className="rounded bg-alert/15 px-2 py-0.5 font-medium text-alert">红线题</span>}
                {q.tags.length > 0 && <span className="text-ink3">已配置 {q.tags.length} 个题目标签</span>}
              </div>
              <div className="mt-1.5 text-body text-ink">
                {safeNarrative(q.scenario.turns.map((t) => t.input).join(" → "), "题目内容已配置，请在考试运行时查看受控作答上下文。")}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 设置 */}
      {tab === "settings" && settings && (
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-card p-5">
            <div className="mb-1 text-body font-semibold">考试频率</div>
            <div className="space-y-2 text-body text-ink2">
              <div>变更即考：{settings.on_change_enabled ? "开启（配置变动自动开考相关科目）" : "关闭"}</div>
              <div>周考：{settings.weekly_enabled ? "开启（每周一次，夜班闲时执行）" : "关闭"}</div>
              <div>上岗线 {finiteNumber(settings.pass_line) ?? "待确认"} 分 · 预警线 {finiteNumber(settings.warn_line) ?? "待确认"} 分 · 月度计算额度 {finiteNumber(settings.budget_monthly_tokens)?.toLocaleString("zh-CN") ?? "待确认"}</div>
            </div>
          </div>
          <div className="rounded-xl border border-line bg-card p-5">
            <div className="mb-2 text-body font-semibold">卡晋升（自动拦截）</div>
            <p className="mb-3 break-words text-body text-ink2">
              开启后：考试跌破上岗线或触碰红线时，自动拦截新技能启用 / 版本发布 / 影子转正 / 模拟转实盘。默认关闭（只提示不拦截），授权动作留痕上链。
            </p>
            {canRunExam ? <button
              onClick={() => setGateTarget(!settings.promotion_gate)}
              disabled={gateBusy}
              className={`rounded-lg px-4 py-2 text-body font-semibold ${settings.promotion_gate ? "bg-alert/15 text-alert" : "bg-go/15 text-go"}`}
            >
              {settings.promotion_gate ? "已开启 · 点击关闭" : "已关闭 · 点击授权开启"}
            </button> : <p className="text-body text-ink3">当前角色仅可查看门禁状态，不能修改。</p>}
          </div>
        </div>
      )}
        </section>
      </div>
      <Overlay
        open={confirmExam}
        title="确认立即开考"
        description="本次会创建一场周考并产生真实评测记录。"
        onClose={() => { if (!running) setConfirmExam(false); }}
        dismissOnBackdrop={!running}
        dismissOnEscape={!running}
        footer={<><Button variant="quiet" disabled={running} onClick={() => setConfirmExam(false)}>取消</Button><Button variant="primary" busy={running} onClick={() => void runExam()}>确认开考</Button></>}
      >
        <p>{questions.length > 0 ? `当前题库已显示 ${questions.length} 道题，服务端将按已装配题库生成本场试卷。` : "当前尚未显示题目；服务端只会在已装配题库可用时生成试卷。"}考试完成前不会改变现有晋升结论；完成后以服务端成绩单和门禁回执为准。</p>
      </Overlay>
      <Overlay
        open={gateTarget !== null}
        title={gateTarget ? "确认开启晋升门禁" : "确认关闭晋升门禁"}
        description="该设置会影响技能启用、版本发布和其他晋升动作。"
        onClose={() => { if (!gateBusy) setGateTarget(null); }}
        dismissOnBackdrop={!gateBusy}
        dismissOnEscape={!gateBusy}
        footer={<><Button variant="quiet" disabled={gateBusy} onClick={() => setGateTarget(null)}>取消</Button><Button variant={gateTarget ? "danger" : "secondary"} busy={gateBusy} onClick={() => gateTarget !== null && void toggleGate(gateTarget)}>确认{gateTarget ? "开启" : "关闭"}</Button></>}
      >
        <p>{gateTarget ? "开启后，未达上岗线或触碰红线的数字员工晋升会被自动阻断。" : "关闭后，考试仍会运行和留痕，但不再自动阻断晋升；请确认已有其他人工治理机制。"}</p>
      </Overlay>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-line bg-card/50 px-4 py-12 text-center text-body text-ink3">{text}</div>;
}
