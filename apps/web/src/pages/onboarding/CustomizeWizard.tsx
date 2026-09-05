/**
 * CustomizeWizard · 定制向导（方案 V4 §1.3/§4，/onboarding?mode=customize）
 * 四步闭环：①清空预览（明示范围）→ ②一键清空（快照可回滚）→ ③行业编制生成（人审预览）→ ④上岗考（达标激活）
 * 状态机与 wizard.ts TRANSITIONS 同序；每步可回滚/重来，全程真实端点驱动（service.bundle.*）。
 */
import { useCallback, useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

interface Preview { install: { bundleId: string } | null; uninstall: string[]; keep: string[] }
interface StaffingDraftView {
  team: Array<{ preset_key: string; role_title: string; description: string }>;
  fences: Array<{ rule_id: string; name: string; level: string }>;
  skills_suggested: string[];
}

type Step = "preview" | "cleared" | "staffing" | "exam" | "done";

export default function CustomizeWizard() {
  const [step, setStep] = useState<Step>("preview");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [industry, setIndustry] = useState("");
  const [draft, setDraft] = useState<StaffingDraftView | null>(null);
  const [examResult, setExamResult] = useState<{ totalScore: number | null; verdict: string | null; passed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const bundle = () => trpc.service as unknown as {
    bundle: {
      clearPreview: { query: () => Promise<Preview> };
      clear: { mutate: () => Promise<{ snapshotId: string }> };
      rollback: { mutate: (i: { snapshotId: string }) => Promise<unknown> };
      generateStaffing: { mutate: (i: { industryText: string }) => Promise<{ draft: StaffingDraftView }> };
      onboardingExam: { mutate: () => Promise<{ totalScore: number | null; verdict: string | null; passed: boolean }> };
    };
  };

  const load = useCallback(async () => {
    await ensureDemoLogin();
    setPreview(await bundle().bundle.clearPreview.query().catch(() => null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-[760px] px-6 py-8 text-ink">
      <h1 className="text-lg font-bold">定制我的行业版</h1>
      <p className="mt-1 text-xs text-ink2">清空示例装配 → 说出您的行业 → 生成团队编制 → 考试上岗。全程快照可回滚，事件存证永不删除。</p>

      {/* 步骤条 */}
      <div className="mt-4 flex gap-1 text-[11px]">
        {(["preview", "cleared", "staffing", "exam", "done"] as Step[]).map((s, i) => (
          <span key={s} className={`rounded px-2 py-1 ${s === step ? "bg-bg700 font-bold text-ink" : "text-ink3"}`}>
            {i + 1}.{ { preview: "清空预览", cleared: "已清空", staffing: "编制生成", exam: "上岗考", done: "完成" }[s]}
          </span>
        ))}
      </div>
      {err && <div className="mt-3 rounded border border-alert/50 bg-alert/10 px-3 py-2 text-xs text-alert">{err}</div>}

      {/* ① 清空预览 */}
      {step === "preview" && preview && (
        <div className="mt-4 rounded-xl border border-line bg-card p-5">
          <div className="text-[13px] font-semibold">① 清空预览（当前装配：{preview.install?.bundleId ?? "无"}）</div>
          <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
            <div>
              <div className="mb-1.5 font-semibold text-alert">将卸载</div>
              {preview.uninstall.map((u) => <div key={u} className="py-0.5 text-ink2">· {u}</div>)}
            </div>
            <div>
              <div className="mb-1.5 font-semibold text-go">将保留</div>
              {preview.keep.map((k) => <div key={k} className="py-0.5 text-ink2">· {k}</div>)}
            </div>
          </div>
          <button
            disabled={busy || !preview.install}
            onClick={() => void run(async () => {
              const r = await bundle().bundle.clear.mutate();
              setSnapshotId(r.snapshotId);
              setStep("cleared");
            })}
            className="mt-4 rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-[13px] font-semibold text-ongold disabled:opacity-50"
          >{busy ? "清空中……" : "确认清空（自动快照，30 天可回滚）"}</button>
        </div>
      )}

      {/* ② 已清空 */}
      {step === "cleared" && (
        <div className="mt-4 rounded-xl border border-line bg-card p-5">
          <div className="text-[13px] font-semibold text-go">✓ 已清空（快照 {snapshotId.slice(0, 16)}…）</div>
          <p className="mt-2 text-xs text-ink2">示例装配已按台账卸载，事件存证完整保留。后悔了可以回滚——或者继续定制您的行业版。</p>
          <div className="mt-4 flex gap-3">
            <button onClick={() => setStep("staffing")} className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-[13px] font-semibold text-ongold">继续：生成我的团队编制 →</button>
            <button
              disabled={busy}
              onClick={() => void run(async () => {
                await bundle().bundle.rollback.mutate({ snapshotId });
                setStep("preview");
                await load();
              })}
              className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink2 hover:border-gline"
            >回滚到示例版</button>
          </div>
        </div>
      )}

      {/* ③ 编制生成 */}
      {step === "staffing" && (
        <div className="mt-4 rounded-xl border border-line bg-card p-5">
          <div className="text-[13px] font-semibold">③ 说出您的行业（AI 生成团队编制草案，您审完才装配）</div>
          <textarea
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="例：我们是做连锁餐饮的，30 家门店，主要痛点是差评响应慢和新品定价拍脑袋……"
            className="mt-3 h-24 w-full rounded-lg border border-line bg-bg800 p-3 text-xs text-ink outline-none focus:border-gline"
          />
          <button
            disabled={busy || industry.trim().length < 4}
            onClick={() => void run(async () => {
              const r = await bundle().bundle.generateStaffing.mutate({ industryText: industry });
              setDraft(r.draft);
            })}
            className="mt-3 rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-[13px] font-semibold text-ongold disabled:opacity-50"
          >{busy ? "生成中……" : "生成编制草案"}</button>

          {draft && (
            <div className="mt-4 rounded-lg border border-line bg-bg800 p-4">
              <div className="mb-2 text-xs font-semibold">编制草案（{draft.team.length} 人）——确认后进入上岗考</div>
              {draft.team.map((m) => (
                <div key={m.preset_key} className="flex items-baseline gap-2 py-1 text-xs">
                  <span className="font-semibold text-ink">{m.role_title}</span>
                  <span className="text-ink3">{m.description}</span>
                </div>
              ))}
              <div className="mt-2 text-[11px] text-ink3">围栏 {draft.fences.length} 条 · 建议技能 {draft.skills_suggested.length} 项</div>
              <button onClick={() => setStep("exam")} className="mt-3 rounded-lg bg-go/15 px-4 py-2 text-[13px] font-semibold text-go">确认编制，进入上岗考 →</button>
            </div>
          )}
        </div>
      )}

      {/* ④ 上岗考 */}
      {step === "exam" && (
        <div className="mt-4 rounded-xl border border-line bg-card p-5">
          <div className="text-[13px] font-semibold">④ 上岗考（考试院门禁：达标才激活，不达标回炉修订）</div>
          {!examResult ? (
            <button
              disabled={busy}
              onClick={() => void run(async () => {
                const r = await bundle().bundle.onboardingExam.mutate();
                setExamResult(r);
                if (r.passed) setStep("done");
              })}
              className="mt-3 rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-[13px] font-semibold text-ongold disabled:opacity-50"
            >{busy ? "考试中……" : "开考"}</button>
          ) : (
            <div className="mt-3 text-xs">
              <div className={`text-2xl font-bold ${examResult.passed ? "text-go" : "text-alert"}`}>{examResult.totalScore}</div>
              <div className="mt-1 text-ink2">结论：{examResult.verdict}{examResult.passed ? "——达标，团队上岗" : "——未达标，请回上一步修订编制后重考"}</div>
              {!examResult.passed && (
                <button onClick={() => { setExamResult(null); setStep("staffing"); }} className="mt-3 rounded-lg border border-line px-4 py-2 text-[13px] text-ink2">回炉修订</button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 完成 */}
      {step === "done" && (
        <div className="mt-4 rounded-xl border border-go/40 bg-go/10 p-5">
          <div className="text-[15px] font-bold text-go">🎉 您的专属行业版已上岗</div>
          <p className="mt-2 text-xs text-ink2">团队编制已激活，晨会/夜班/考试院全部就位。回到经营主页，您的团队已经在等您了。</p>
          <a href="/" className="mt-4 inline-block rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-[13px] font-semibold text-ongold no-underline">进入系统 →</a>
        </div>
      )}
    </div>
  );
}
