/**
 * P26 · 定制中心（租户覆盖层管理台）
 * 「行业经验我们给，你的个性自己长」——每个租户在行业包之上的专属定制：
 *  - 当前生效定制概览（七类资产项数、来源 note）
 *  - 版本时间线（草稿→灰度→全量→回滚 完整流水线状态）
 *  - 运营动作：进灰度（考试闸）/ 转全量 / 一键回滚 / 导出快照
 *  - Rebase 预检：行业包升级兼容报告（谁兼容/谁落回/谁待裁决）
 * 数据：trpc.overlay.*
 */
import { useCallback, useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AsyncState, clientChineseText, clientValueText } from "@workloom/ui";
import { versionText } from "../../lib/display";
import { useNavigationAccess } from "../../shell/NavigationAccess";

/* ---------------- 类型（与服务端对齐） ---------------- */
interface OverlayItem { type: string; op: string; path: string }
interface OverlayDoc {
  tenant_id: string; base_bundle: string; base_version: string;
  overlay_version: number; status: "draft" | "canary" | "active" | "rolled_back";
  items: OverlayItem[]; note?: string;
}
interface VersionRow { overlay_version: number; status: string; updated_at: string }
interface RebaseReport {
  from_version: string; to_version: string;
  compatible: number; autoFallback: number; needsDecision: number;
  items: Array<{ type: string; path: string; verdict: string; reason: string }>;
}

const STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: "草稿", cls: "text-ink2" },
  canary: { text: "灰度中", cls: "text-warn" },
  active: { text: "已生效", cls: "text-go" },
  rolled_back: { text: "已回滚", cls: "text-ink3" },
};
const TYPE_TEXT: Record<string, string> = {
  persona: "话术人格", kb: "知识", crew: "编制", threshold: "阈值",
  skill: "技能", fence: "围栏", brand: "品牌",
};
const VERDICT: Record<string, { text: string; cls: string }> = {
  compatible: { text: "兼容", cls: "text-go" },
  auto_fallback: { text: "自动落回", cls: "text-warn" },
  needs_decision: { text: "待裁决", cls: "text-alert" },
};

/* tRPC 弱类型通道（与 P25 同一模式） */
const svc = () => trpc.overlay as unknown as {
  versions: { query: (i: { baseBundle: string }) => Promise<VersionRow[]> };
  active: { query: (i: { baseBundle: string }) => Promise<OverlayDoc | null> };
  toCanary: { mutate: (i: { baseBundle: string; overlayVersion: number }) => Promise<{ exam: { pass: boolean; failures: string[] } }> };
  toActive: { mutate: (i: { baseBundle: string; overlayVersion: number }) => Promise<OverlayDoc> };
  rollback: { mutate: (i: { baseBundle: string }) => Promise<OverlayDoc> };
  export: { query: (i: { baseBundle: string }) => Promise<{ exported_at: string; doc: OverlayDoc } | null> };
  rebasePreview: { query: (i: { baseBundle: string; toVersion: string }) => Promise<{ report: RebaseReport | null; summary: string }> };
  myStatus: { query: (i: { baseBundle: string }) => Promise<{ hasOverlay: boolean; itemCount?: number; summary: string }> };
  l1Intake: { mutate: (i: { baseBundle: string; baseVersion: string; intents: Array<Record<string, unknown>>; canaryScope?: { ratio: number } }) => Promise<OverlayDoc> };
};

export default function P26() {
  const { bundle: currentBundle, bundleStatus, reload: reloadBundle, canAction } = useNavigationAccess();
  const canConfigure = canAction("workspace.configure");
  const bundle = currentBundle?.bundleId ?? "";
  const baseVersion = currentBundle?.bundleVersion ?? "";
  const [active, setActive] = useState<OverlayDoc | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [myStatus, setMyStatus] = useState<string>("");
  const [rebase, setRebase] = useState<{ report: RebaseReport | null; summary: string } | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [toast, setToast] = useState<string>("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  // L1 快速录入（说人话就能定制：三种最常用的定制意图）
  const [l1Tone, setL1Tone] = useState("");
  const [l1FaqQ, setL1FaqQ] = useState("");
  const [l1FaqA, setL1FaqA] = useState("");
  const [l1Mate, setL1Mate] = useState("");

  const load = useCallback(async () => {
    if (!bundle) return;
    setLoadState((current) => current === "ready" ? "ready" : "loading");
    try {
      await ensureDemoLogin();
      const [a, v, m] = await Promise.all([
        svc().active.query({ baseBundle: bundle }),
        svc().versions.query({ baseBundle: bundle }),
        svc().myStatus.query({ baseBundle: bundle }),
      ]);
      setActive(a); setVersions(v); setMyStatus(m.summary); setRebase(null); setLoadState("ready");
    } catch (error) {
      console.error("定制中心加载失败", error);
      setLoadState("error");
      throw error;
    }
  }, [bundle]);

  useEffect(() => { void load().catch(() => undefined); }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    if (!canConfigure) return;
    setBusy(key); setToast("");
    try { await fn(); if (ok) setToast(ok); await load(); }
    catch (err) {
      console.warn("定制操作失败", err);
      setToast("操作未能完成；现有配置没有改变，请稍后重试。");
    }
    finally { setBusy(""); }
  };

  const doExport = async () => {
    const r = await svc().export.query({ baseBundle: bundle });
    if (!r) { setToast("当前无生效定制可导出"); return; }
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `overlay-${bundle}-v${r.doc.overlay_version}.json`;
    a.click();
    setToast("定制快照已导出（您的资产，随时带走）");
  };

  const doL1 = async () => {
    if (!canConfigure) return;
    const intents: Array<Record<string, unknown>> = [];
    if (l1Tone.trim()) intents.push({ kind: "tone", tone: l1Tone.trim() });
    if (l1FaqQ.trim() && l1FaqA.trim()) intents.push({ kind: "faq", question: l1FaqQ.trim(), answer: l1FaqA.trim() });
    if (l1Mate.trim()) intents.push({ kind: "brand", field: "mate-name", value: l1Mate.trim() });
    if (intents.length === 0) { setToast("请先填一项想定制的内容"); return; }
    await act("l1", async () => {
      const doc = await svc().l1Intake.mutate({
        baseBundle: bundle, baseVersion: active?.base_version ?? baseVersion,
        intents, canaryScope: { ratio: 0.1 },
      });
      setL1Tone(""); setL1FaqQ(""); setL1FaqA(""); setL1Mate("");
      setToast(`已生成第 ${doc.overlay_version} 版定制草稿（${intents.length} 项），点「考试并进灰度」上线`);
    }, "");
  };

  const doRebase = async () => {
    setBusy("rebase");
    try { setRebase(await svc().rebasePreview.query({ baseBundle: bundle, toVersion: "next" })); }
    catch (err) {
      console.warn("升级兼容预检失败", err);
      setToast("兼容预检暂时无法完成，请稍后重试；当前配置没有改变。");
    }
    finally { setBusy(""); }
  };

  if (bundleStatus === "loading") {
    return <AsyncState status="loading" title="正在读取当前行业配置" description="定制中心会严格使用当前工作区已安装的行业包。" />;
  }
  if (bundleStatus === "error") {
    return <AsyncState status="error" title="当前行业配置暂时无法读取" description="系统没有使用默认行业配置，以免误改其他行业资产。" onRetry={reloadBundle} />;
  }
  if (bundleStatus === "unconfigured" || !currentBundle || !bundle || !baseVersion) {
    return <AsyncState status="empty" title="尚未安装行业配置" description="请先完成行业配置，再创建工作区专属定制。" />;
  }
  if (loadState === "loading") {
    return <AsyncState status="loading" title="正在读取定制记录" description="正在核对草稿、灰度与生效版本。" />;
  }
  if (loadState === "error") {
    return <AsyncState status="error" title="定制记录暂时无法读取" description="系统没有把读取失败显示为暂无定制。" onRetry={() => void load().catch(() => undefined)} />;
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-ink">定制中心</h1>
        <p className="mt-1 text-sm text-ink3">行业经验我们给，你的个性自己长——系统永远在升级，定制永远不过时</p>
      </header>

      {/* 当前行业配置 + 客户视角状态 */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="rounded-lg border border-gold bg-gold/10 px-4 py-2 text-sm font-semibold text-gold">{clientChineseText(currentBundle.bundleName, "当前行业配置")}</span>
        <span className="ml-auto rounded-full bg-bg850 px-3 py-1 text-body text-ink2">{clientValueText(myStatus)}</span>
      </div>

      {toast && <div className="mb-4 rounded-lg border border-gline bg-bg850 px-4 py-2 text-sm text-ink">{toast}</div>}

      {/* 快速录入：说人话就能定制 */}
      {canConfigure && <section className="mb-6 rounded-xl border border-gold/30 bg-bg900 p-5">
        <h2 className="mb-1 text-base font-bold text-ink">说人话就能定制 <span className="text-body font-normal text-ink3">（快速配置 · 三条最常用的先跑通）</span></h2>
        <p className="mb-3 text-body text-ink3">填哪条算哪条，提交后自动生成定制草稿，过考试、进灰度、再全量——改坏了随时一键回滚。</p>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-body font-semibold text-ink2">① 服务话术风格</label>
            <textarea value={l1Tone} onChange={(e) => setL1Tone(e.target.value)} rows={2}
              placeholder="例：对带孩子的家庭更亲切些，多推荐亲子设施"
              className="w-full rounded-lg border border-line bg-bg850 px-3 py-2 text-sm text-ink placeholder:text-ink3" />
          </div>
          <div>
            <label className="mb-1 block text-body font-semibold text-ink2">② 加一条常见问答</label>
            <input value={l1FaqQ} onChange={(e) => setL1FaqQ(e.target.value)} placeholder="问题，例：有婴儿床吗"
              className="mb-1.5 w-full rounded-lg border border-line bg-bg850 px-3 py-1.5 text-sm text-ink placeholder:text-ink3" />
            <input value={l1FaqA} onChange={(e) => setL1FaqA(e.target.value)} placeholder="答案，例：有，免费借用"
              className="w-full rounded-lg border border-line bg-bg850 px-3 py-1.5 text-sm text-ink placeholder:text-ink3" />
          </div>
          <div>
            <label className="mb-1 block text-body font-semibold text-ink2">③ 数字人名字</label>
            <input value={l1Mate} onChange={(e) => setL1Mate(e.target.value)} placeholder="例：小织（给你的数字伙伴起个名字）"
              className="w-full rounded-lg border border-line bg-bg850 px-3 py-2 text-sm text-ink placeholder:text-ink3" />
            <button onClick={() => void doL1()} disabled={busy !== ""}
              className="mt-2 w-full rounded-lg bg-gold px-4 py-2 text-sm font-bold text-bg950 hover:opacity-90 disabled:opacity-50">
              {busy === "l1" ? "生成中…" : "生成定制草稿"}
            </button>
          </div>
        </div>
      </section>}

      {/* 当前生效定制 */}
      <section className="mb-6 rounded-xl border border-line bg-bg900 p-5">
        <h2 className="mb-3 text-base font-bold text-ink">当前生效定制</h2>
        {!active ? (
          <p className="text-sm text-ink3">暂无生效定制——当前使用行业标准配置。客户说一句话或由运营人员手工编辑即可生成。</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
              <span className={`font-bold ${STATUS[active.status]?.cls ?? "text-ink3"}`}>{STATUS[active.status]?.text ?? "状态待确认"}</span>
              <span className="text-ink3">第 {active.overlay_version} 版 · {versionText(active.base_version)}</span>
              {active.note && <span className="text-ink3">｜{clientValueText(active.note)}</span>}
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
              {Object.entries(
                active.items.reduce<Record<string, number>>((m, i) => { m[i.type] = (m[i.type] ?? 0) + 1; return m; }, {}),
              ).map(([t, n]) => (
                <span key={t} className="rounded-full border border-line px-3 py-1 text-body text-ink2">
                  {TYPE_TEXT[t] ?? "其他定制项"} × {n}
                </span>
              ))}
            </div>
            <div className="wl-action-row flex flex-wrap gap-2">
              {canConfigure && <button onClick={() => void act("rollback", () => svc().rollback.mutate({ baseBundle: bundle }), "已一键回滚到上一版")}
                disabled={busy !== ""}
                className="rounded-lg border border-alert/50 px-4 py-2 text-sm font-semibold text-alert hover:bg-alert/10 disabled:opacity-50">
                一键回滚
              </button>}
              <button onClick={() => void doExport()} disabled={busy !== ""}
                className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink2 hover:text-ink disabled:opacity-50">
                导出快照
              </button>
              <button onClick={() => void doRebase()} disabled={busy !== ""}
                className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink2 hover:text-ink disabled:opacity-50">
                {busy === "rebase" ? "检测中…" : "升级兼容预检"}
              </button>
            </div>
          </>
        )}
      </section>

      {/* Rebase 报告 */}
      {rebase && (
        <section className="mb-6 rounded-xl border border-warn/40 bg-bg900 p-5">
          <h2 className="mb-2 text-base font-bold text-ink">升级兼容报告</h2>
          <p className="mb-3 text-sm text-gold">{clientValueText(rebase.summary)}</p>
          {rebase.report && (
            <div className="space-y-1.5">
              {rebase.report.items.map((it, i) => (
                <div key={i} className="flex flex-wrap items-start gap-2 text-body">
                  <span className={`shrink-0 font-bold ${VERDICT[it.verdict]?.cls ?? "text-ink3"}`}>{VERDICT[it.verdict]?.text ?? "待确认"}</span>
                  <span className="text-ink2">{TYPE_TEXT[it.type] ?? "其他定制项"}</span>
                  <span className="text-ink3">{clientValueText(it.reason)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 版本时间线 */}
      <section className="rounded-xl border border-line bg-bg900 p-5">
        <h2 className="mb-3 text-base font-bold text-ink">版本时间线（完整流水线：草稿→灰度→全量）</h2>
        {versions.length === 0 ? (
          <p className="text-sm text-ink3">暂无版本记录</p>
        ) : (
          <div className="space-y-2">
            {versions.map((v) => (
              <div key={v.overlay_version} className="flex flex-wrap items-center gap-3 rounded-lg border border-line/60 px-4 py-2.5 text-sm">
                <span className="font-mono text-ink2">第 {v.overlay_version} 版</span>
                <span className={`font-bold ${STATUS[v.status]?.cls ?? "text-ink3"}`}>{STATUS[v.status]?.text ?? "状态待确认"}</span>
                <span className="text-body text-ink3">{new Date(v.updated_at).toLocaleString("zh-CN")}</span>
                <span className="ml-auto flex gap-2">
                  {canConfigure && v.status === "draft" && (
                    <button onClick={() => void act(`c${v.overlay_version}`,
                      async () => {
                        const r = await svc().toCanary.mutate({ baseBundle: bundle, overlayVersion: v.overlay_version });
                        if (!r.exam.pass) throw new Error(`考试闸未通过：${r.exam.failures[0]}`);
                      }, "考试通过，已进入灰度")}
                      disabled={busy !== ""}
                      className="rounded border border-warn/50 px-2.5 py-1 text-body font-semibold text-warn hover:bg-warn/10 disabled:opacity-50">
                      {busy === `c${v.overlay_version}` ? "考试中…" : "考试并进灰度"}
                    </button>
                  )}
                  {canConfigure && v.status === "canary" && (
                    <button onClick={() => void act(`a${v.overlay_version}`,
                      () => svc().toActive.mutate({ baseBundle: bundle, overlayVersion: v.overlay_version }),
                      "已全量生效")}
                      disabled={busy !== ""}
                      className="rounded border border-go/50 px-2.5 py-1 text-body font-semibold text-go hover:bg-go/10 disabled:opacity-50">
                      转全量
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
