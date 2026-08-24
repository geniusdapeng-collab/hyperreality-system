/**
 * P5 航道管制台（F8：群权限管理 · 规则围栏；PRD P5-①②③④⑤ 逐条对账）
 *  - 左栏版本历史（P5E1：active/rolled_back/出厂基线 🔒；单调守卫只可加严 L2.1）+ 生效范围统计
 *  - 中央规则列表（P5E2：级别 pill auto/review/block/需介入 + 来源 + 30 天触发数；基线 🔒 集团强制 F2.3）
 *  - 自然语言新增群规（P5E3：转写草稿 → 结构化预览 → dry-run → 审批；未确认不生效 L2.4）
 *  - dry-run 报告「模拟航行」（P5E4：回放最近 10 条，列出将拦截项；影响面过大标红 E2.3）
 * 状态变体：p5 默认 / p5_block 求值异常按 block 熔断横幅（E2.1）/ p5_readonly 只读权限（E2.6/L5.1）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { COMMON_STATUS_TEXT, FENCE_LEVEL_TEXT, actionText, dictText } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert, EmptyState, FenceLight, SkeletonBlock, type FenceLevel4 } from "../../components/hud";

interface RuleRow {
  id: string; rule_id: string; version: string; workspace_id: string; name: string;
  level: "auto" | "review" | "block"; match_spec: { object_types?: string[]; actions?: string[]; when?: string };
  is_baseline: boolean; status: string; created_by: string; hits30: string;
}
interface VersionRow { version: string; status: string; rules: string; created_at: string }
interface DryRunReport {
  ruleId: string; ruleVersion: string; replayed: number;
  wouldBlock: string[]; wouldReview: string[]; unchanged: number; impact: string;
}

/** 级别映射（需介入紫=高危险动作类，首版按名称推断；保持四色语义 §2.2） */
function levelOf(r: RuleRow): FenceLevel4 {
  return r.level as FenceLevel4;
}

export default function P5() {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState("owner");
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  // NL 新增群规（P5E3）
  const [nlText, setNlText] = useState("");
  const [draft, setDraft] = useState<{ ruleId: string; name: string; level: "auto" | "review" | "block"; objectTypes: string[]; actions: string[]; when: string } | null>(null);
  const [report, setReport] = useState<{ dryRunId: string; report: DryRunReport } | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [meR, ru, ve] = await Promise.all([
        trpc.members.me.query() as Promise<{ identity: { role: string } }>,
        trpc.fence.rules.query() as Promise<RuleRow[]>,
        trpc.fence.versions.query() as Promise<VersionRow[]>,
      ]);
      setRole(meR.identity.role);
      setRules(ru);
      setVersions(ve);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const readonly = role === "readonly";
  const activeRules = rules.filter((r) => r.status === "active");
  const baselineCount = activeRules.filter((r) => r.is_baseline).length;
  const localCount = activeRules.filter((r) => !r.is_baseline && r.workspace_id !== "*").length;

  /** NL 转写（演示口径：Mock 结构化——真实 LLM 翻译由 .env 接入后升级，D4） */
  const transcribe = useCallback(() => {
    const text = nlText.trim();
    if (!text) return;
    const maxId = Math.max(0, ...rules.map((r) => Number(r.rule_id.replace("R", "")) || 0));
    setDraft({
      ruleId: `R${maxId + 1}`,
      name: text.length > 24 ? `${text.slice(0, 24)}…` : text,
      level: "review", // 新规默认必审（只可加严纪律 L2.1：不从 auto 起步）
      objectTypes: ["publish_quota"],
      actions: ["publish.post"],
      when: "true",
    });
    setReport(null);
  }, [nlText, rules]);

  const doDryRun = useCallback(async () => {
    if (!draft) return;
    const r = await trpc.fence.dryRun.mutate(draft) as { dryRunId: string; report: DryRunReport };
    setReport(r);
  }, [draft]);

  const confirm = useCallback(async () => {
    if (!draft || !report) return;
    // 影响面过大 → 拒绝提交并提示拆条（F2.5/E2.3）
    if (report.report.wouldBlock.length > 3) {
      setBanner({ level: "alert", text: `影响面过大（将拦截 ${report.report.wouldBlock.length} 条），拒绝提交——请拆条细化（E2.3）` });
      return;
    }
    await trpc.fence.confirmDryRun.mutate({ dryRunId: report.dryRunId, rule: draft });
    setBanner({ level: "info", text: `规则 ${draft.ruleId} 已进变更审批（${COMMON_STATUS_TEXT.pending_approval}，F2.4）——请去 P4 决断队列完成审批后激活` });
    setDraft(null); setReport(null); setNlText("");
    await load();
  }, [draft, report, load]);

  /* ---------- 左栏：版本历史 + 生效范围 ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">航路变更记录 · VERSIONS</div>
      {versions.map((v) => (
        <div key={`${v.version}-${v.status}`} className={`mb-1.5 rounded-lg border px-3 py-2.5 ${
          v.status === "active" ? "border-gline bg-gold/6" : "border-line bg-card"
        }`}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-body font-bold text-ink">{v.version}</span>
            <span className={`text-micro ${v.status === "active" ? "text-go" : v.status === "rolled_back" ? "text-ink3" : "text-warn"}`}>
              {dictText(COMMON_STATUS_TEXT, v.status)}
            </span>
          </div>
          <div className="mt-0.5 text-micro text-ink3">{v.rules} 条规则</div>
        </div>
      ))}
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="text-caption font-bold text-holo">生效范围</div>
        <div className="mt-1 text-caption text-ink2">本工作室规则 {localCount} 条 + 基线 {baselineCount} 条 🔒 公司/MCN 强制</div>
        <div className="mt-0.5 text-micro text-ink3">单调守卫：只可加严不可放宽（L2.1/F2.3）</div>
      </div>
    </>
  );

  /* ---------- 右栏：NL 新增群规 + dry-run 报告 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">新增群规 · NL→RULE</div>
      {readonly ? (
        <div className="rounded-lg border border-line bg-card p-3 text-caption text-ink3">
          只读视图（p5_readonly）：无群规管理权，编辑/新增入口已隐藏（E2.6/L5.1）
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-caption font-bold text-holo">自然语言新增群规（P5E3）</div>
            <textarea
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              rows={2}
              placeholder="如：抖音单日发布不得超过 5 条"
              className="w-full rounded-lg border border-line bg-bg800 px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
            <button
              type="button"
              onClick={transcribe}
              disabled={!nlText.trim()}
              className="mt-2 w-full cursor-pointer rounded-lg border border-holo/40 bg-holo/8 px-3 py-1.5 text-caption font-bold text-holo disabled:opacity-40"
            >
              转写为规则草稿（Mock 翻译 · D4）
            </button>
          </div>

          {draft && (
            <div className="rounded-lg border border-gline bg-gold/5 p-3">
              <div className="mb-1.5 text-caption font-bold text-gold">草稿预览（确认后走变更审批 F2.8）</div>
              <div className="space-y-0.5 font-mono text-caption text-ink2">
                <div>{draft.ruleId} · {draft.name}</div>
                <div>级别 <span className="text-warn">{dictText(FENCE_LEVEL_TEXT, draft.level)}</span>（新规默认必审，只可加严 L2.1）</div>
                <div>对象 {draft.objectTypes.join("/")} · 动作 {draft.actions.map(actionText).join("/")}</div>
                <div>条件 <span className="text-holo">{draft.when}</span></div>
              </div>
              <button
                type="button"
                onClick={() => void doDryRun()}
                className="mt-2 w-full cursor-pointer rounded-lg gold-grad px-3 py-1.5 text-caption font-black text-ongold"
              >
                ▶ dry-run 模拟航行（回放最近 10 条 F2.5）
              </button>
            </div>
          )}

          {report && (
            <div className={`rounded-lg border p-3 ${report.report.wouldBlock.length > 3 ? "border-alert/50 bg-alert/6" : "border-holo/35 bg-holo/5"}`}>
              <div className="mb-1.5 text-caption font-bold text-holo">dry-run 报告「模拟航行」（P5E4）</div>
              <div className="text-caption text-ink2">{report.report.impact}</div>
              {report.report.wouldBlock.length > 0 && (
                <div className="mt-1 text-micro text-alert">
                  将拦截：{report.report.wouldBlock.map((e) => `#${e}`).join("、")}
                </div>
              )}
              {report.report.wouldReview.length > 0 && (
                <div className="mt-0.5 text-micro text-warn">
                  将挂起：{report.report.wouldReview.map((e) => `#${e}`).join("、")}
                </div>
              )}
              <button
                type="button"
                onClick={() => void confirm()}
                className="mt-2 w-full cursor-pointer rounded-lg border border-go/50 bg-go/10 px-3 py-1.5 text-caption font-bold text-go"
              >
                ✓ 确认并提交变更审批（未确认不生效 L2.4）
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-h1 font-black tracking-wider">航道管制台</h2>
          <span className="text-[11px] tracking-[.2em] text-ink3">P5 · FENCE CONTROL</span>
        </div>

        {banner && <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>}

        {/* p5_block 求值异常横幅（E2.1：宁可错杀；当前规则表无异常时隐藏） */}
        {rules.some((r) => !(r.match_spec.when ?? "")) && (
          <div className="mb-3"><BannerAlert level="alert">表达式求值异常 → 按 block 熔断（E2.1 宁可错杀），请检查规则条件</BannerAlert></div>
        )}

        {!ready ? (
          <><SkeletonBlock lines={2} h={40} /><SkeletonBlock lines={6} /></>
        ) : activeRules.length === 0 ? (
          <EmptyState icon="🛡" title="本工作室暂无自定义群规" hint="仅出厂基线生效 🔒（L2.1 单调守卫不可放宽）" />
        ) : (
          <div className="space-y-2">
            {activeRules.map((r) => (
              <div key={r.id} className="flex items-center gap-3">
                <div className="flex-1">
                  <FenceLight
                    level={levelOf(r)}
                    name={`${r.rule_id} ${r.name}`}
                    desc={`${r.workspace_id === "*" ? "基线包" : "本工作室"} ${r.version} · ${(r.match_spec.actions ?? []).map(actionText).join("/")}`}
                    baseline={r.is_baseline}
                  />
                </div>
                <div className="w-24 text-right">
                  <div className="font-orb text-body font-bold text-holo">{r.hits30}</div>
                  <div className="text-micro text-ink3">30 天触发</div>
                </div>
              </div>
            ))}
            <div className="rounded-lg border border-line bg-bg800/40 p-3 text-micro text-ink3">
              判定为纯函数（输入=对象+动作+参数）；子调用与自动化触发同瀑布（F2.1/L2.2）；硬约束先于一切规则求值（F2.2）；
              规则缓存本地，断网照常拦截（F2.9/E2.4）；行业默认值由 Bundle 提供，底座不内置行业数值（L2.6）。
            </div>
          </div>
        )}
      </div>
    </Bridge>
  );
}
