/**
 * P5 规则与权限（F8：群权限管理 · 规则围栏；PRD P5-①②③④⑤ 逐条对账）
 *  - 左栏版本历史（P5E1：active/rolled_back/出厂基线 🔒；单调守卫只可加严 L2.1）+ 生效范围统计
 *  - 中央规则列表（P5E2：级别 pill auto/review/block/需介入 + 来源 + 30 天触发数；基线 🔒 集团强制 F2.3）
 *  - 新增群规：文本命名 + 当前行业包范围显式选择 → dry-run → 审批；未接入语义翻译时不伪装理解
 *  - dry-run 报告「模拟航行」（P5E4：回放最近 10 条，列出将拦截项；影响面过大标红 E2.3）
 * 状态变体：p5 默认 / p5_block 求值异常按 block 熔断横幅（E2.1）/ p5_readonly 只读权限（E2.6/L5.1）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { COMMON_STATUS_TEXT, FENCE_LEVEL_TEXT, actionText, dictText, shortId, versionText } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert, EmptyState, FenceLight, type FenceLevel4 } from "../../components/hud";
import { AsyncState, Icon, clientChineseText, clientIdentifierText, clientValueText } from "@workloom/ui";
import { operationFailure, toUiFailure } from "../../lib/ui-state";
import { useNavigationAccess } from "../../shell/NavigationAccess";

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
  const { canAction } = useNavigationAccess();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadMessage, setLoadMessage] = useState("");
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  // NL 新增群规（P5E3）
  const [nlText, setNlText] = useState("");
  const [draft, setDraft] = useState<{ ruleId: string; name: string; level: "auto" | "review" | "block"; objectTypes: string[]; actions: string[]; when: string; scopeLabel: string } | null>(null);
  const [report, setReport] = useState<{ dryRunId: string; report: DryRunReport } | null>(null);
  const [busy, setBusy] = useState<"dry-run" | "confirm" | null>(null);
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      await ensureDemoLogin();
      const [ru, ve] = await Promise.all([
        trpc.fence.rules.query() as Promise<RuleRow[]>,
        trpc.fence.versions.query() as Promise<VersionRow[]>,
      ]);
      setRules(ru);
      setVersions(ve);
      setHasSnapshot(true);
      setLoadMessage("");
      setLoadState("ready");
    } catch (error) {
      console.warn("读取安全规则失败", error);
      const failure = toUiFailure(error);
      setLoadMessage(operationFailure(error, "读取安全规则"));
      setLoadState(failure.kind === "forbidden" ? "forbidden" : "error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const readonly = loadState !== "ready" || !canAction("guardrail.manage");
  const activeRules = rules.filter((r) => r.status === "active");
  const baselineCount = activeRules.filter((r) => r.is_baseline).length;
  const localCount = activeRules.filter((r) => !r.is_baseline && r.workspace_id !== "*").length;

  // 可选范围只从当前工作区已经装配的规则投影生成，基座不猜测、更不硬编码行业对象。
  const scopeOptions = useMemo(() => activeRules.flatMap((rule, ruleIndex) => {
    const objectTypes = rule.match_spec.object_types ?? [];
    const actions = rule.match_spec.actions ?? [];
    const ruleName = clientChineseText(rule.name, `行业规则 ${ruleIndex + 1}`);
    return objectTypes.flatMap((objectType) => actions.map((action) => ({
      key: `${rule.id}:${objectType}:${action}`,
      objectType,
      action,
      label: `${ruleName} · ${actionText(action)}`,
    })));
  }), [activeRules]);
  const [selectedScopeKey, setSelectedScopeKey] = useState("");
  const selectedScope = scopeOptions.find((option) => option.key === selectedScopeKey) ?? scopeOptions[0] ?? null;

  /** 只生成用户明确确认过范围的结构化草稿；未接入语义翻译时不伪造“已理解”。 */
  const prepareDraft = useCallback(() => {
    const text = nlText.trim();
    if (!text || !selectedScope) return;
    const maxId = Math.max(0, ...rules.map((r) => Number(r.rule_id.replace("R", "")) || 0));
    setDraft({
      ruleId: `R${maxId + 1}`,
      name: text.length > 24 ? `${text.slice(0, 24)}…` : text,
      level: "review", // 新规默认必审（只可加严纪律 L2.1：不从 auto 起步）
      objectTypes: [selectedScope.objectType],
      actions: [selectedScope.action],
      when: "true",
      scopeLabel: selectedScope.label,
    });
    setReport(null);
  }, [nlText, rules, selectedScope]);

  const doDryRun = useCallback(async () => {
    if (!draft || busy) return;
    setBusy("dry-run");
    setActionError("");
    try {
      const { scopeLabel: _scopeLabel, ...rule } = draft;
      const r = await trpc.fence.dryRun.mutate(rule) as { dryRunId: string; report: DryRunReport };
      setReport(r);
    } catch (error) {
      console.warn("围栏模拟回放失败", error);
      setActionError(operationFailure(error, "模拟回放"));
    } finally {
      setBusy(null);
    }
  }, [draft, busy]);

  const confirm = useCallback(async () => {
    if (!draft || !report || busy) return;
    // 影响面过大 → 拒绝提交并提示拆条（F2.5/E2.3）
    if (report.report.wouldBlock.length > 3) {
      setBanner({ level: "alert", text: `影响面过大（将拦截 ${report.report.wouldBlock.length} 条），系统已拒绝提交，请拆分并细化规则。` });
      return;
    }
    setBusy("confirm");
    setActionError("");
    try {
      const { scopeLabel: _scopeLabel, ...rule } = draft;
      const result = await trpc.fence.confirmDryRun.mutate({ dryRunId: report.dryRunId, rule }) as { eventId?: string; approvalId?: string };
      setBanner({ level: "info", text: `服务端已受理规则草稿，当前为${COMMON_STATUS_TEXT.pending_approval}；${result.eventId ? `账本事件 ${shortId(result.eventId)}，` : ""}审批前不会生效。` });
      setDraft(null); setReport(null); setNlText("");
      await load();
    } catch (error) {
      console.warn("提交围栏变更失败", error);
      setActionError(operationFailure(error, "规则提交"));
    } finally {
      setBusy(null);
    }
  }, [draft, report, busy, load]);

  /* ---------- 左栏：版本历史 + 生效范围 ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">规则版本记录</div>
      {versions.map((v) => (
        <div key={`${v.version}-${v.status}`} className={`mb-1.5 rounded-lg border px-3 py-2.5 ${
          v.status === "active" ? "border-gline bg-gold/6" : "border-line bg-card"
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-body font-bold text-ink">{versionText(v.version)}</span>
            <span className={`text-body ${v.status === "active" ? "text-go" : v.status === "rolled_back" ? "text-ink3" : "text-warn"}`}>
              {dictText(COMMON_STATUS_TEXT, v.status)}
            </span>
          </div>
          <div className="mt-0.5 text-body text-ink3">{clientValueText(v.rules)} 条规则</div>
        </div>
      ))}
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="text-body font-bold text-holo">生效范围</div>
        <div className="mt-1 flex items-center gap-1 text-body text-ink2">本店规则 {localCount} 条 + 基线 {baselineCount} 条 <Icon name="lock" size={13} />集团强制</div>
        <div className="mt-0.5 text-body text-ink3">安全基线只可加严，不可被工作区规则放宽。</div>
      </div>
    </>
  );

  /* ---------- 右栏：NL 新增群规 + dry-run 报告 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">新增规则草稿</div>
      {readonly ? (
        <div className="rounded-lg border border-line bg-card p-3 text-body text-ink3">
          当前账户只有查看权限，编辑和新增入口已隐藏。
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="rounded-lg border border-line bg-card p-3">
            <div className="mb-1.5 text-body font-bold text-holo">配置规则草稿</div>
            <textarea
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              rows={2}
              disabled={Boolean(busy)}
              placeholder="填写规则名称或审批意图，例如：对外发布必须经过负责人审批"
              className="w-full rounded-lg border border-line bg-bg800 px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
            {scopeOptions.length > 0 ? (
              <label className="mt-2 block text-body text-ink2">
                适用范围（来自当前行业包）
                <select
                  className="mt-1 w-full rounded-lg border border-line bg-bg800 px-2.5 py-2 text-body text-ink"
                  value={selectedScope?.key ?? ""}
                  disabled={Boolean(busy)}
                  onChange={(event) => setSelectedScopeKey(event.target.value)}
                >
                  {scopeOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                </select>
              </label>
            ) : (
              <div className="mt-2 rounded border border-warn/40 bg-warn/5 px-2.5 py-2 text-body text-warn">
                当前行业包尚未提供可选规则范围，系统不会代替你猜测对象或动作。
              </div>
            )}
            <div className="mt-2 text-body text-ink3">当前未启用语义条件翻译；草稿只使用你明确选择的范围，并默认进入人工复核。</div>
            <button
              type="button"
              onClick={prepareDraft}
              disabled={!nlText.trim() || !selectedScope || Boolean(busy)}
              className="mt-2 w-full cursor-pointer rounded-lg border border-holo/40 bg-holo/8 px-3 py-1.5 text-body font-bold text-holo disabled:opacity-40"
            >
              生成结构化规则草稿
            </button>
          </div>

          {draft && (
            <div className="rounded-lg border border-gline bg-gold/5 p-3">
              <div className="mb-1.5 text-body font-bold text-gold">草稿预览（确认后进入变更审批）</div>
              <div className="space-y-0.5 font-mono text-body text-ink2">
                <div>{draft.name}</div>
                <div>级别 <span className="text-warn">{dictText(FENCE_LEVEL_TEXT, draft.level)}</span>（新规则默认必须审批，且不可放宽安全基线）</div>
                <div>适用范围 {draft.scopeLabel}</div>
                <div>条件 <span className="text-holo">对所选范围内的每次动作生效</span></div>
              </div>
              <button
                type="button"
                onClick={() => void doDryRun()}
                disabled={Boolean(busy)}
                aria-busy={busy === "dry-run" || undefined}
                className="mt-2 w-full cursor-pointer rounded-lg gold-grad px-3 py-1.5 text-body font-black text-ongold disabled:cursor-wait disabled:opacity-50"
              >
                {busy === "dry-run" ? "正在模拟回放…" : <><Icon name="play" size={14} className="inline" /> 模拟回放最近 10 条事件</>}
              </button>
            </div>
          )}

          {report && (
            <div className={`rounded-lg border p-3 ${report.report.wouldBlock.length > 3 ? "border-alert/50 bg-alert/6" : "border-holo/35 bg-holo/5"}`}>
              <div className="mb-1.5 text-body font-bold text-holo">模拟回放报告</div>
              <div className="text-body text-ink2">{clientChineseText(report.report.impact, "本次变更影响已完成模拟，请核对下方结果。")}</div>
              {report.report.wouldBlock.length > 0 && (
                <div className="mt-1 text-body text-alert">
                  将拦截：{report.report.wouldBlock.map((e) => clientIdentifierText(e)).join("、")}
                </div>
              )}
              {report.report.wouldReview.length > 0 && (
                <div className="mt-0.5 text-body text-warn">
                  将挂起：{report.report.wouldReview.map((e) => clientIdentifierText(e)).join("、")}
                </div>
              )}
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={Boolean(busy)}
                aria-busy={busy === "confirm" || undefined}
                className="mt-2 w-full cursor-pointer rounded-lg border border-go/50 bg-go/10 px-3 py-1.5 text-body font-bold text-go disabled:cursor-wait disabled:opacity-50"
              >
                {busy === "confirm" ? "正在提交…" : <><Icon name="check" size={14} className="inline" /> 确认并提交变更审批（审批前不生效）</>}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <Bridge
      left={hasSnapshot ? left : <AsyncState status={loadState === "error" ? "error" : loadState === "forbidden" ? "forbidden" : "loading"} description={loadMessage || undefined} onRetry={loadState === "error" ? () => void load() : undefined} />}
      right={hasSnapshot ? right : <AsyncState status="loading" title="规则编辑尚未就绪" description="权限和规则版本确认完成后再开放编辑。" />}
    >
      <div className="flex min-h-full flex-col">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-h1 font-black tracking-wider">规则与权限</h2>
        </div>

        {loadState !== "ready" && hasSnapshot && <div className="mb-3"><BannerAlert level={loadState === "loading" ? "info" : "warn"} actionLabel={loadState === "loading" ? undefined : "重新加载"} onAction={loadState === "loading" ? undefined : () => void load()}>{loadState === "loading" ? "正在重新读取规则与权限，操作入口暂时锁定。" : `${loadMessage} 正在显示上一次成功快照，不能据此判断当前规则状态。`}</BannerAlert></div>}
        {actionError && <div className="mb-3"><BannerAlert level="alert" actionLabel="关闭" onAction={() => setActionError("")}>{actionError}</BannerAlert></div>}
        {banner && <div className="mb-3"><BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert></div>}

        {/* p5_block 求值异常横幅（E2.1：宁可错杀；当前规则表无异常时隐藏） */}
        {rules.some((r) => !(r.match_spec.when ?? "")) && (
          <div className="mb-3"><BannerAlert level="alert">规则条件无法判断，系统已按阻断处理，请检查规则设置。</BannerAlert></div>
        )}

        {!hasSnapshot ? (
          <AsyncState
            status={loadState === "forbidden" ? "forbidden" : loadState === "error" ? "error" : "loading"}
            description={loadMessage || undefined}
            onRetry={loadState === "error" ? () => void load() : undefined}
          />
        ) : activeRules.length === 0 ? (
          <EmptyState icon={<Icon name="rules" size={24} />} title="当前工作区暂无自定义规则" hint="系统安全基线仍在生效，且不能被工作区规则放宽。" />
        ) : (
          <div className="space-y-2">
            {activeRules.map((r) => (
              <div key={r.id} className="flex items-center gap-3">
                <div className="flex-1">
                  <FenceLight
                    level={levelOf(r)}
                    name={`${shortId(r.rule_id)} ${clientChineseText(r.name, "未命名规则")}`}
                    desc={`${r.workspace_id === "*" ? "系统基线" : "当前工作区"} · ${versionText(r.version)} · ${(r.match_spec.actions ?? []).map(actionText).join("、") || "适用动作待说明"}`}
                    baseline={r.is_baseline}
                  />
                </div>
                <div className="w-24 text-right">
                  <div className="font-orb text-body font-bold text-holo">{clientValueText(r.hits30)}</div>
                  <div className="text-body text-ink3">30 天触发</div>
                </div>
              </div>
            ))}
            <div className="rounded-lg border border-line bg-bg800/40 p-3 text-body text-ink3">
              所有直接操作、子任务和自动化触发都经过同一套安全规则；平台硬约束优先于工作区自定规则。
              断网时仍按最近一次有效规则拦截；行业默认值由当前行业包提供，基座不内置行业数值。
            </div>
          </div>
        )}
      </div>
    </Bridge>
  );
}
