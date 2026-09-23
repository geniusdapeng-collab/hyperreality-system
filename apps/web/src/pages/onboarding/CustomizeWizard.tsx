/**
 * 定制向导：现有装配持续运行 → 隔离草案/候选 → 绑定考试 → 带快照原子切换。
 * 页面步骤只展示服务端事实；刷新后由 customizationStatus 恢复，不能靠本地 setStep 宣称上岗。
 */
import { useCallback, useEffect, useState } from "react";
import { clientValueText } from "@workloom/ui";
import { capabilityText, versionText } from "../../lib/display";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

interface Preview { install: { bundleId: string } | null; uninstall: string[]; keep: string[] }
interface StaffingDraftView {
  team: Array<{ preset_key: string; role_title: string; description: string }>;
  fences: Array<{ rule_id: string; name: string; level: string }>;
  skills_suggested: string[];
}
type Step = "preview" | "staffing" | "exam" | "done";
interface AssemblyView { installId: string; version: number; hash: string; status: string }
interface CandidateExamView {
  agentId: string;
  roleTitle: string;
  totalScore: number;
  passed: boolean;
  redLineHit: boolean;
  failureReasons: string[];
  pendingCapabilities: string[];
}
interface ExamView {
  examId?: string;
  id?: string;
  totalScore: number | null;
  verdict: string | null;
  passed?: boolean;
  activated?: boolean;
  installStatus?: string;
  status?: string;
  candidates?: CandidateExamView[];
}
interface CustomizationState {
  phase: Step;
  snapshotId: string | null;
  currentInstall: { id: string; bundleId: string; installedAt: string } | null;
  industryText: string;
  draft: null | {
    id: string;
    hash: string | null;
    generationMode: string;
    status: string;
    compiled: StaffingDraftView | null;
    lastError: string | null;
  };
  assembly: AssemblyView | null;
  exam: null | { id: string; totalScore: number | null; verdict: string | null; status: string; candidates: CandidateExamView[] };
}

function safeWizardError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("版本") || message.includes("哈希") || message.includes("变化")) return "配置已由其他成员更新，请刷新后继续。";
  if (message.includes("真实模型") || message.includes("模拟骨架")) return "请先在落地向导中接入并验证真实模型，再重新生成。";
  if (message.includes("考试")) return "上岗考未完成，请稍后重试或回炉调整草案。";
  if (message.includes("权限") || message.includes("FORBIDDEN")) return "当前角色没有执行该操作的权限。";
  return "该步骤暂时未完成，现有装配未受影响，请稍后重试。";
}

const EXAM_LABELS: Record<string, string> = {
  pass: "通过", warn: "预警", fail: "未通过", running: "进行中", done: "已完成", failed: "执行失败",
};

export default function CustomizeWizard() {
  const [step, setStep] = useState<Step>("preview");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [industry, setIndustry] = useState("");
  const [draft, setDraft] = useState<StaffingDraftView | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftHash, setDraftHash] = useState("");
  const [generationMode, setGenerationMode] = useState("");
  const [assembly, setAssembly] = useState<AssemblyView | null>(null);
  const [examResult, setExamResult] = useState<ExamView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const bundle = () => trpc.service as unknown as {
    bundle: {
      clearPreview: { query: () => Promise<Preview> };
      customizationStatus: { query: () => Promise<CustomizationState> };
      rollback: { mutate: (i: { snapshotId: string }) => Promise<unknown> };
      generateStaffing: { mutate: (i: { industryText: string }) => Promise<{ draftId: string; draftHash: string; draft: StaffingDraftView; mock: boolean }> };
      confirmAndAssembleStaffing: { mutate: (i: { draftId: string; expectedDraftHash: string }) => Promise<{ installId: string; assemblyVersion: number; assemblyHash: string; status: string }> };
      onboardingExam: { mutate: (i: { installId: string; expectedAssemblyHash: string }) => Promise<Required<Pick<ExamView, "examId" | "totalScore" | "verdict" | "passed" | "activated" | "installStatus" | "candidates">>> };
    };
  };

  const applyServerState = (state: CustomizationState) => {
    setStep(state.phase);
    setSnapshotId(state.snapshotId ?? "");
    setIndustry((value) => value || state.industryText);
    setDraft(state.draft?.compiled ?? null);
    setDraftId(state.draft?.id ?? "");
    setDraftHash(state.draft?.hash ?? "");
    setGenerationMode(state.draft?.generationMode ?? "");
    setAssembly(state.assembly);
    setExamResult(state.exam);
    if (state.draft?.lastError) setErr(safeWizardError(new Error(state.draft.lastError)));
  };

  const load = useCallback(async () => {
    await ensureDemoLogin();
    const [nextPreview, state] = await Promise.all([
      bundle().bundle.clearPreview.query(),
      bundle().bundle.customizationStatus.query(),
    ]);
    setPreview(nextPreview);
    applyServerState(state);
  }, []);
  useEffect(() => { void load().catch((error) => setErr(safeWizardError(error))); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try { await fn(); }
    catch (error) { setErr(safeWizardError(error)); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-[760px] min-w-0 px-4 py-8 text-ink sm:px-6">
      <h1 className="break-words text-lg font-bold">定制我的行业版</h1>
      <p className="mt-1 break-words text-body leading-relaxed text-ink2">
        现有团队持续运行；新团队只在隔离草案中生成、预览和考试。全员通过后，系统先保存旧装配快照，再一次性切换。页面关闭后可继续。
      </p>

      <div className="mt-4 flex flex-wrap gap-1 text-body">
        {(["preview", "staffing", "exam", "done"] as Step[]).map((item, index) => (
          <span key={item} className={`rounded px-2 py-1 ${item === step ? "bg-bg700 font-bold text-ink" : "text-ink3"}`}>
            {index + 1}.{ { preview: "确认现状", staffing: "隔离编制", exam: "上岗考", done: "已切换" }[item]}
          </span>
        ))}
      </div>
      {err && <div role="alert" className="mt-3 max-w-full break-words rounded border border-alert/50 bg-alert/10 px-3 py-2 text-body leading-relaxed text-alert">{err}</div>}

      {step === "preview" && (
        <div className="mt-4 min-w-0 rounded-xl border border-line bg-card p-5">
          {!preview ? <div className="text-body text-ink3">正在读取当前装配……</div> : <>
            <div className="break-words text-body font-semibold">① 确认当前运行状态（当前装配：{preview.install ? "已安装行业方案" : "无"}）</div>
            <p className="mt-2 break-words text-body leading-relaxed text-go">当前装配不会在此步骤被清空，将一直服务到新团队通过考试并完成最终切换。</p>
            <div className="mt-3 grid grid-cols-1 gap-4 text-body sm:grid-cols-2">
              <div className="min-w-0">
                <div className="mb-1.5 font-semibold text-amber-200">最终切换时将停用</div>
                {preview.uninstall.map((item) => <div key={item} className="break-words py-0.5 text-ink2">· {clientValueText(item)}</div>)}
              </div>
              <div className="min-w-0">
                <div className="mb-1.5 font-semibold text-go">将保留</div>
                {preview.keep.map((item) => <div key={item} className="break-words py-0.5 text-ink2">· {clientValueText(item)}</div>)}
              </div>
            </div>
            <button
              disabled={busy}
              onClick={() => setStep("staffing")}
              className="mt-4 max-w-full whitespace-normal break-words rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-body font-semibold text-ongold disabled:opacity-50"
            >继续创建隔离草案 →</button>
          </>}
        </div>
      )}

      {step === "staffing" && (
        <div className="mt-4 min-w-0 rounded-xl border border-line bg-card p-5">
          <div className="break-words text-body font-semibold">② 描述您的行业与经营重点</div>
          <p className="mt-1 break-words text-body leading-relaxed text-ink3">真实模型输出须通过结构、安全规则引用和写入岗位保护校验，才会保存为可确认草案。</p>
          <textarea
            value={industry}
            onChange={(event) => setIndustry(event.target.value)}
            placeholder="例：我们经营 30 家连锁餐饮门店，重点解决差评响应、库存损耗与新品定价……"
            className="mt-3 h-24 w-full resize-y break-words rounded-lg border border-line bg-bg800 p-3 text-body text-ink outline-none focus:border-gline"
          />
          <button
            disabled={busy || industry.trim().length < 4}
            onClick={() => void run(async () => {
              const result = await bundle().bundle.generateStaffing.mutate({ industryText: industry.trim() });
              setDraft(result.draft);
              setDraftId(result.draftId);
              setDraftHash(result.draftHash);
              setGenerationMode(result.mock ? "mock" : "real");
            })}
            className="mt-3 rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-body font-semibold text-ongold disabled:opacity-50"
          >{busy ? "正在生成……" : draft ? "重新生成草案" : "生成编制草案"}</button>

          {draft && (
            <div className="mt-4 min-w-0 rounded-lg border border-line bg-bg800 p-4">
              <div className="break-words text-body font-semibold">编制草案（{draft.team.length} 人）</div>
              {draft.team.map((member) => (
                <div key={member.preset_key} className="min-w-0 py-1 text-body sm:flex sm:items-baseline sm:gap-2">
                  <span className="font-semibold text-ink">{clientValueText(member.role_title)}</span>
                  <span className="block break-words text-ink3 sm:inline">{clientValueText(member.description)}</span>
                </div>
              ))}
              <div className="mt-2 break-words text-body text-ink3">可执行安全规则 {draft.fences.length} 条 · 待后续安装的技能建议 {draft.skills_suggested.length} 项</div>
              {generationMode !== "real" && (
                <div className="mt-3 break-words rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-body leading-relaxed text-amber-200">
                  这是模拟骨架，仅供预览，服务端不会允许装配或上岗。请返回标准落地向导接入真实模型，再重新生成。
                </div>
              )}
              <button
                disabled={busy || generationMode !== "real" || !draftId || !draftHash}
                onClick={() => void run(async () => {
                  const result = await bundle().bundle.confirmAndAssembleStaffing.mutate({ draftId, expectedDraftHash: draftHash });
                  setAssembly({ installId: result.installId, version: result.assemblyVersion, hash: result.assemblyHash, status: result.status });
                  await load();
                })}
                className="mt-3 max-w-full whitespace-normal break-words rounded-lg bg-go/15 px-4 py-2 text-body font-semibold text-go disabled:cursor-not-allowed disabled:opacity-40"
              >{busy ? "正在创建候选装配……" : "确认草案并创建停用候选 →"}</button>
            </div>
          )}
        </div>
      )}

      {step === "exam" && assembly && (
        <div className="mt-4 min-w-0 rounded-xl border border-line bg-card p-5">
          <div className="break-words text-body font-semibold">③ 逐岗位上岗考（未全员通过前，候选员工与安全规则保持停用）</div>
          <div className="mt-2 rounded border border-line bg-bg800 px-3 py-2 text-body text-ink3">
            <div>候选装配版本：{versionText(String(assembly.version))}</div>
            <div className="mt-1 break-words">装配内容已由服务端指纹锁定，考试期间发生变化将拒绝切换。</div>
          </div>
          {examResult && (
            <div aria-live="polite" className="mt-3 min-w-0 text-body">
              <div className={`text-2xl font-bold ${examResult.verdict === "pass" ? "text-go" : "text-alert"}`}>{examResult.totalScore ?? "—"}</div>
              <div className="mt-1 break-words text-ink2">
                考试结论：{EXAM_LABELS[examResult.verdict ?? examResult.status ?? ""] ?? "未完成"}。
                {examResult.candidates?.length ? `逐岗位通过 ${examResult.candidates.filter((item) => item.passed).length}/${examResult.candidates.length}。` : "尚无逐岗位答卷。"}
                {examResult.status === "running"
                  ? "考试仍在服务端执行；候选保持停用。若执行超过 10 分钟，可用下方按钮安全重试。"
                  : examResult.verdict === "pass" ? "服务端正在核验绑定并激活。" : "候选仍停用，可回炉生成新草案后重考。"}
              </div>
              {examResult.candidates && examResult.candidates.length > 0 && (
                <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  {examResult.candidates.map((candidate) => (
                    <div key={candidate.agentId} className="min-w-0 rounded-lg border border-line bg-bg800 px-3 py-2">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <span className="min-w-0 break-words font-semibold text-ink">{clientValueText(candidate.roleTitle)}</span>
                        <span className={`shrink-0 ${candidate.passed ? "text-go" : "text-alert"}`}>{candidate.passed ? "通过" : "未通过"} · {candidate.totalScore}</span>
                      </div>
                      {candidate.failureReasons.map((reason) => <div key={reason} className="mt-1 break-words leading-relaxed text-alert">· {clientValueText(reason)}</div>)}
                      {candidate.pendingCapabilities.length > 0 && (
                        <div className="mt-1 break-words leading-relaxed text-amber-200">
                          待审批、未安装：{candidate.pendingCapabilities.map(capabilityText).join("、")}。相关能力保持阻断，不纳入已激活能力。
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              disabled={busy}
              onClick={() => void run(async () => {
                const result = await bundle().bundle.onboardingExam.mutate({ installId: assembly.installId, expectedAssemblyHash: assembly.hash });
                setExamResult(result);
                if (!result.passed || !result.activated || result.installStatus !== "active") {
                  setErr(result.passed ? "考试已通过，但服务端未完成装配激活；系统不会宣告上岗，请重试或查看错误。" : "考试未通过，候选团队保持停用。");
                }
                await load();
              })}
              className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-body font-semibold text-ongold disabled:opacity-50"
            >{busy
                ? "正在逐岗位考试与核验……"
                : examResult?.status === "running" ? "检查考试；超时则安全重试"
                  : examResult?.verdict ? "重新考试" : "开始逐岗位绑定上岗考"}</button>
            {examResult?.verdict && examResult.verdict !== "pass" && (
              <button onClick={() => { setExamResult(null); setStep("staffing"); }} className="rounded-lg border border-line px-4 py-2 text-body text-ink2">回炉生成新草案</button>
            )}
          </div>
        </div>
      )}

      {step === "done" && assembly?.status === "active" && (
        <div className="mt-4 min-w-0 rounded-xl border border-go/40 bg-go/10 p-5">
          <div className="break-words text-[15px] font-bold text-go">专属团队已通过绑定上岗考并激活</div>
          <p className="mt-2 break-words text-body leading-relaxed text-ink2">服务端已核验装配{versionText(String(assembly.version))}与内容指纹，数字员工及安全规则现已进入运行态。技能建议仍需通过技能市场安装；正式经营模式还须完成真实模型与经营主体门禁。</p>
          {examResult?.candidates && examResult.candidates.length > 0 && (
            <div className="mt-3 min-w-0 rounded-lg border border-line bg-bg800 px-3 py-2 text-body text-ink2">
              <div className="break-words font-semibold text-go">逐岗位实测通过 {examResult.candidates.filter((item) => item.passed).length}/{examResult.candidates.length}</div>
              {examResult.candidates.some((item) => item.pendingCapabilities.length > 0) && (
                <div className="mt-1 break-words leading-relaxed text-amber-200">
                  以下能力仍待审批、未安装，运行时保持阻断：{[...new Set(examResult.candidates.flatMap((item) => item.pendingCapabilities))].map(capabilityText).join("、")}。
                </div>
              )}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <a href="/onboarding" className="inline-block max-w-full whitespace-normal break-words rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-body font-semibold text-ongold no-underline">继续完成正式运行门禁 →</a>
            {snapshotId && (
              <button disabled={busy} onClick={() => void run(async () => { await bundle().bundle.rollback.mutate({ snapshotId }); await load(); })} className="max-w-full whitespace-normal break-words rounded-lg border border-line px-4 py-2 text-body text-ink2 hover:border-gline disabled:opacity-50">恢复切换前装配</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
