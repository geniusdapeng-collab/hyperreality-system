/**
 * P24 · 考试院（方案 V2.0 §9）
 * 内置 AI 员工评测中心：成绩单看板（四维记分卡）/ 考试记录 / 题库 / 设置
 * 数据：trpc.service.eval.*（硬轨零 token；软题 L3 阅卷 P1 接入）
 */
import { useCallback, useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

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
  tool: "工具调用错", "fence-config": "围栏配置错", "model-tier": "模型档位错",
};

type Tab = "report" | "exams" | "questions" | "settings";

export default function P24() {
  const [tab, setTab] = useState<Tab>("report");
  const [report, setReport] = useState<Report | null>(null);
  const [exams, setExams] = useState<ExamRow[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [settings, setSettings] = useState<EvalSettings | null>(null);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
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
      svc.eval.latestReport.query().catch(() => ({ report: null })),
      svc.eval.listExams.query().catch(() => ({ exams: [] })),
      svc.eval.listQuestions.query().catch(() => ({ questions: [] })),
      svc.eval.settings.query().catch(() => ({ settings: null })),
    ]);
    setReport(r.report);
    setExams(e.exams);
    setQuestions(q.questions);
    setSettings(st.settings);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runExam = async () => {
    setRunning(true);
    setToast("");
    try {
      const svc = trpc.service as unknown as {
        eval: { runExam: { mutate: (i: { examType: "weekly" }) => Promise<{ exam: ExamRow; wrongCount: number }> } };
      };
      const r = await svc.eval.runExam.mutate({ examType: "weekly" });
      setToast(`考试完成：总分 ${r.exam.totalScore}，错题 ${r.wrongCount} 道`);
      await load();
    } catch (e) {
      setToast(`开考失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const toggleGate = async (enabled: boolean) => {
    const svc = trpc.service as unknown as {
      eval: { setPromotionGate: { mutate: (i: { enabled: boolean }) => Promise<unknown> } };
    };
    await svc.eval.setPromotionGate.mutate({ enabled });
    setToast(enabled ? "已开启自动卡晋升（授权已留痕上链）" : "已关闭自动卡晋升");
    await load();
  };

  const score = report ? Number(report.total_score) : null;
  const vm = report ? VERDICT_META[report.verdict] : null;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-5 text-ink">
      {/* 头部 */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">考试院</h1>
          <p className="mt-0.5 text-xs text-ink2">内置 AI 员工评测 · 四维记分卡 · 双轨判卷（硬题零成本 / 软题 L3）· 红线一票否决</p>
        </div>
        <button
          onClick={() => void runExam()}
          disabled={running}
          className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-[13px] font-semibold text-ongold shadow hover:opacity-90 disabled:opacity-50"
        >
          {running ? "考试中……" : "立即开考（周考）"}
        </button>
      </div>
      {toast && (
        <div className="mb-3 rounded-lg border border-gline bg-bg800 px-3 py-2 text-xs text-ink">{toast}</div>
      )}

      {/* Tab 栏 */}
      <div className="mb-4 flex gap-1 rounded-lg border border-line bg-card p-1 text-[13px]">
        {([["report", "成绩单"], ["exams", "考试记录"], ["questions", `题库 ${questions.length}`], ["settings", "设置"]] as Array<[Tab, string]>).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-md px-3 py-1.5 ${tab === k ? "bg-bg700 font-semibold text-ink" : "text-ink2 hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 成绩单 */}
      {tab === "report" && (
        <div>
          {!report ? (
            <Empty text="还没有考试成绩——点右上角「立即开考」出第一份成绩单" />
          ) : (
            <>
              {/* 总分卡 + 四维记分卡 */}
              <div className="mb-4 grid grid-cols-[220px_1fr] gap-4">
                <div className="rounded-xl border border-line bg-card p-5 text-center">
                  <div className="text-[42px] font-bold leading-none" style={{ color: report.verdict === "pass" ? "var(--color-go)" : report.verdict === "warn" ? "var(--color-warn)" : "var(--color-alert)" }}>
                    {score}
                  </div>
                  <div className={`mt-2 text-[13px] font-semibold ${vm?.cls}`}>
                    {vm?.text}{report.red_line_hit && " · 触碰红线"}
                  </div>
                  {report.delta?.total !== null && report.delta?.total !== undefined && (
                    <div className="mt-1 text-xs text-ink2">
                      vs 上场 {report.delta.total >= 0 ? "+" : ""}{report.delta.total}
                    </div>
                  )}
                  <div className="mt-2 text-[11px] text-ink3">错题 {report.wrong_count} 道</div>
                </div>
                <div className="rounded-xl border border-line bg-card p-5">
                  <div className="mb-3 text-[13px] font-semibold">四维记分卡</div>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                    {DIM_META.map(({ key, label }) => {
                      const v = report.dim_scores?.[key] ?? 0;
                      const d = report.delta?.perDim?.[key];
                      return (
                        <div key={key}>
                          <div className="mb-1 flex items-baseline justify-between text-xs">
                            <span className="text-ink2">{label}</span>
                            <span>
                              <b className="text-ink">{Math.round(v)}</b>
                              {d !== undefined && (
                                <span className={`ml-1.5 text-[11px] ${d >= 0 ? "text-go" : "text-alert"}`}>
                                  {d >= 0 ? "+" : ""}{d}
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-bg700">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-goldhi to-gold2"
                              style={{ width: `${Math.min(100, v)}%` }}
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
                  <div className="mb-3 text-[13px] font-semibold">错题归因与建议动作</div>
                  <div className="space-y-2">
                    {report.suggestions.map((s, i) => (
                      <div key={i} className="flex items-start gap-3 rounded-lg bg-bg800 px-3 py-2.5 text-xs">
                        <span className="shrink-0 rounded bg-alert/15 px-2 py-0.5 font-medium text-alert">
                          {s.attribution ? ATTRIBUTION_TEXT[s.attribution] ?? s.attribution : "待归因"}
                        </span>
                        <span className="text-ink2">{s.suggestion ?? "—"}</span>
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
        <div className="rounded-xl border border-line bg-card">
          {exams.length === 0 ? <Empty text="暂无考试记录" /> : (
            <table className="w-full text-xs">
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
                {exams.map((e) => (
                  <tr key={e.id} className="border-b border-line/50 last:border-0 hover:bg-bg800/50">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink2">{e.id.slice(0, 18)}…</td>
                    <td className="px-4 py-2.5">{EXAM_TYPE_TEXT[e.examType] ?? e.examType}</td>
                    <td className="px-4 py-2.5">{e.totalQuestions}</td>
                    <td className="px-4 py-2.5 font-semibold">{e.totalScore ?? "—"}</td>
                    <td className={`px-4 py-2.5 font-medium ${e.verdict ? VERDICT_META[e.verdict]?.cls : ""}`}>
                      {e.verdict ? VERDICT_META[e.verdict]?.text : e.status}
                      {e.redLineHit && <span className="ml-1 text-alert">·红线</span>}
                    </td>
                    <td className="px-4 py-2.5 text-ink3">{new Date(e.startedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
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
              <div className="flex items-center gap-2 text-[11px]">
                <span className="rounded bg-holo/15 px-2 py-0.5 font-medium text-holo">{STRUCTURE_TEXT[q.structure] ?? q.structure}</span>
                <span className="rounded bg-bg700 px-2 py-0.5 text-ink2">{q.subject}</span>
                {q.redLine && <span className="rounded bg-alert/15 px-2 py-0.5 font-medium text-alert">红线题</span>}
                <span className="text-ink3">{q.tags.join(" · ")}</span>
              </div>
              <div className="mt-1.5 text-[13px] text-ink">
                {q.scenario.turns.map((t) => t.input).join(" → ")}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 设置 */}
      {tab === "settings" && settings && (
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-card p-5">
            <div className="mb-1 text-[13px] font-semibold">考试频率</div>
            <div className="space-y-2 text-xs text-ink2">
              <div>变更即考：{settings.on_change_enabled ? "开启（配置变动自动开考相关科目）" : "关闭"}</div>
              <div>周考：{settings.weekly_enabled ? "开启（每周一次，夜班闲时执行）" : "关闭"}</div>
              <div>上岗线 {settings.pass_line} 分 · 预警线 {settings.warn_line} 分 · 月预算 {Number(settings.budget_monthly_tokens).toLocaleString()} tokens</div>
            </div>
          </div>
          <div className="rounded-xl border border-line bg-card p-5">
            <div className="mb-2 text-[13px] font-semibold">卡晋升（自动拦截）</div>
            <p className="mb-3 text-xs text-ink2">
              开启后：考试跌破上岗线或触碰红线时，自动拦截新技能启用 / 版本发布 / 影子转正 / 模拟转实盘。默认关闭（只提示不拦截），授权动作留痕上链。
            </p>
            <button
              onClick={() => void toggleGate(!settings.promotion_gate)}
              className={`rounded-lg px-4 py-2 text-[13px] font-semibold ${settings.promotion_gate ? "bg-alert/15 text-alert" : "bg-go/15 text-go"}`}
            >
              {settings.promotion_gate ? "已开启 · 点击关闭" : "已关闭 · 点击授权开启"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-line bg-card/50 px-4 py-12 text-center text-xs text-ink3">{text}</div>;
}
