/**
 * P6 技能中心（F10：Agent 能力商店 · 技能广场；PRD P6-①②③④⑤ 逐条对账）
 *  - P6E1 意识系统建议横幅（F8.4 ≥3 次/周高频检测；一键固化→触发器 F4.7 / 生成草稿→p6_create / 驳回降权 E8.3；
 *    确认前不产生任何自动化 L4.4；超时态 >10s 显「分析中」可关闭）
 *  - P6E2 官方技能（金边传说·随 Bundle 分发；安装/已安装状态；绑定围栏可见；「已装给谁」→P8）
 *  - P6E3 团队技能（银边）/ 行业共享（铜边 · 已脱敏 ✓ L8.1；调用次数与采纳率公开=F8.5 事件投影）
 *  - P6E4 零代码新建技能「打造新装备」→ /p6/create 三要素向导（F8.3；「不能做什么」自动转围栏声明）
 * 状态变体：p6 默认 / p6_create 创建；加载骨架 G10；空态仅官方技能+新建入口（F8.1）；
 *   错误态安装拒绝+原因（L8.2/E8.2）；权限态社区版不显行业共享区（F7.2）+ readonly 隐藏全部动作（E2.6 隐藏非置灰）；
 *   完成后态创建成功→团队技能 v1 进版本管理（F8.3）
 * 数据来源：skills router（list/installs/usage=F8.5 投影/forge/dryRun/awareness.*）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert, EmptyState, Skeleton } from "../../components/hud";
import { OBJECT_TYPE_TEXT, actionText, dictText, shortId, versionText } from "../../lib/display";
import { Icon, clientChineseText, clientValueText, skillIconOf, type SkillIconName } from "@workloom/ui";
import { useNavigationAccess } from "../../shell/NavigationAccess";

interface SkillRow {
  id: string; level: "official" | "team" | "industry"; bundle: string | null;
  name: string; version: string; description: string;
  fence_bindings: string[]; desensitized: boolean;
  /** Bundle/受控分发元数据；客户端只消费命名图标，不解析行业字段。 */
  dist_meta?: { presentation?: { icon?: string } } | null;
}
interface SkillUsage {
  calls30: number; adopted30: number; rejected30: number; adoptionRate: number | null;
  rejectReasons: Array<{ reason: string; count: number }>;
  boundAgents: Array<{ id: string; presetKey: string; name: string }>;
}
interface InstallRow { skill_id: string; installed_by: string; installed_at: string }
interface Suggestion {
  key: string; objectType: string; actionCategory: string;
  count: number; windowDays: number; threshold: number; sampleEventIds: string[];
}

/** 稀有度视觉口径（§6 设计规范：官方=金 / 团队=银 / 行业共享=铜） */
const RARITY = {
  official: { border: "border-gold/60", tag: "传说 · 官方", cls: "text-gold" },
  team: { border: "border-[#C0C8E8]/50", tag: "精良 · 团队", cls: "text-[#C0C8E8]" },
  industry: { border: "border-[#a8b2be]/50", tag: "共享 · 行业", cls: "text-[#a8b2be]" },
} as const;

/** 展示名（官方技能 description 首句可声明中文名；团队/行业直接用 name） */
function displayName(s: SkillRow): string {
  const m = /^([^。]{2,12})。/.exec(s.description);
  if (m?.[1]) return clientChineseText(m[1], "未命名技能");
  return clientChineseText(s.name, "未命名技能");
}
/** 展示描述（去掉首句中文名部分） */
function displayDesc(s: SkillRow): string {
  const m = /^[^。]{2,12}。(.+)$/.exec(s.description);
  const description = m?.[1] ?? s.description;
  return clientChineseText(description, "技能说明待补充");
}

function suggestionActionText(value: string): string {
  return clientChineseText(value, actionText(value));
}

function suggestionObjectText(value: string): string {
  return dictText(OBJECT_TYPE_TEXT, value);
}

/** 技能图标：显式分发元数据优先；缺省按 id 稳定分配，不猜测行业语义。 */
function skillIcon(s: SkillRow): SkillIconName {
  return skillIconOf(s.id, s.dist_meta?.presentation?.icon);
}

export default function P6() {
  const { canAction, plan } = useNavigationAccess();
  const nav = useNavigate();
  const location = useLocation();
  const isCreate = location.pathname.endsWith("/create");
  const prefill = (location.state ?? null) as { name?: string; trigger?: string; fromSuggestion?: string } | null;

  const [ready, setReady] = useState(false);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [installs, setInstalls] = useState<InstallRow[]>([]);
  const [usage, setUsage] = useState<Record<string, SkillUsage>>({});
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggSlow, setSuggSlow] = useState(false); // 超时态：建议生成 >10s 显「分析中」（F8.4）
  const [suggSlowDismissed, setSuggSlowDismissed] = useState(false);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [cardError, setCardError] = useState<Record<string, string>>({}); // 错误态：安装/卸载失败原因（L8.2/E8.2）
  const [busy, setBusy] = useState<string | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setReady(false);
    try {
      await ensureDemoLogin();
      // 意识系统建议超时态：>10s 显「分析中」可关闭（F8.4 状态规格）
      setSuggSlow(false);
      if (slowTimer.current) clearTimeout(slowTimer.current);
      slowTimer.current = setTimeout(() => setSuggSlow(true), 10_000);
      const [sk, ins, usg, sug] = await Promise.all([
        trpc.skills.list.query() as Promise<SkillRow[]>,
        trpc.skills.installs.query() as Promise<InstallRow[]>,
        trpc.skills.usage.query() as Promise<Record<string, SkillUsage>>,
        trpc.skills.awareness.suggestions.query() as Promise<Suggestion[]>,
      ]);
      if (slowTimer.current) clearTimeout(slowTimer.current);
      setSuggSlow(false);
      setSkills(sk);
      setInstalls(ins);
      setUsage(usg);
      setSuggestions(sug);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // 轮询口径（D6）：技能中心 15s 静默刷新
  useEffect(() => {
    const t = setInterval(() => void load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const canManage = canAction("skill.manage");
  const showIndustry = plan !== "community"; // F7.2：社区版不显示行业共享区（隐藏非置灰）
  const installedSet = useMemo(() => new Set(installs.map((i) => i.skill_id)), [installs]);
  const officials = skills.filter((s) => s.level === "official");
  const teams = skills.filter((s) => s.level === "team");
  const industries = skills.filter((s) => s.level === "industry");
  const nothingInstalled = installs.length === 0; // 空态 F8.1

  /** 一键固化 → 生成触发器（F4.7，受围栏管辖 L4.4） */
  const confirmTrigger = useCallback(async (s: Suggestion) => {
    setBusy(`sug-${s.key}`);
    try {
      const r = await trpc.skills.awareness.confirm.mutate({ suggestion: s, target: "trigger", schedule: "0 8 * * 1" });
      setBanner({ level: "info", text: `已固化为每周一 08:00 运行的定时任务；自动执行仍受围栏管辖。任务回执 ${shortId(r.artifactId)}，账本凭证 ${shortId(r.eventId)}。` });
      await load(true);
    } catch (e) {
      console.warn("固化定时任务失败", e);
      setBanner({ level: "alert", text: "暂时无法固化定时任务，请稍后重试；原建议仍会保留。" });
    } finally {
      setBusy(null);
    }
  }, [load]);

  /** 驳回建议 → 降权（E8.3 校准闭环：该类阈值 ×2） */
  const rejectSug = useCallback(async (s: Suggestion) => {
    setBusy(`sug-${s.key}`);
    try {
      await trpc.skills.awareness.reject.mutate({ key: s.key });
      setBanner({ level: "warn", text: `已驳回「${suggestionActionText(s.actionCategory)}」类建议；系统已降低同类建议的出现频率。` });
      await load(true);
    } finally {
      setBusy(null);
    }
  }, [load]);

  /** 安装（F8.2 安装即绑定；错误态原因展示 L8.2/E8.2） */
  const install = useCallback(async (skillId: string) => {
    setBusy(skillId);
    setCardError((m) => ({ ...m, [skillId]: "" }));
    try {
      const r = await trpc.skills.install.mutate({ skillId });
      const skillName = displayName(skills.find((item) => item.id === skillId) ?? { id: skillId, level: "team", bundle: null, name: skillId, version: "", description: "", fence_bindings: [], desensitized: false });
      setBanner({ level: "info", text: `已装备「${skillName}」；${r.bindings.length ? `同时启用 ${r.bindings.length} 条关联围栏。` : "该技能没有额外围栏。"}` });
      await load(true);
    } catch (e) {
      console.warn("安装技能失败", e);
      setCardError((m) => ({ ...m, [skillId]: "暂时无法安装，请检查权限或稍后重试。" }));
    } finally {
      setBusy(null);
    }
  }, [load]);

  /** 卸载（L8.3 卸载即撤销围栏绑定） */
  const uninstall = useCallback(async (skillId: string) => {
    setBusy(skillId);
    try {
      await trpc.skills.uninstall.mutate({ skillId });
      const skillName = displayName(skills.find((item) => item.id === skillId) ?? { id: skillId, level: "team", bundle: null, name: skillId, version: "", description: "", fence_bindings: [], desensitized: false });
      setBanner({ level: "warn", text: `已卸载「${skillName}」；随技能启用的关联围栏已同步撤销。` });
      await load(true);
    } catch (e) {
      console.warn("卸载技能失败", e);
      setCardError((m) => ({ ...m, [skillId]: "暂时无法卸载，请检查权限或稍后重试。" }));
    } finally {
      setBusy(null);
    }
  }, [load]);

  /** 技能卡（装备卡 · 稀有度边框；P6-④ SkillCard） */
  const renderCard = (s: SkillRow) => {
    const r = RARITY[s.level];
    const u = usage[s.id];
    const installed = installedSet.has(s.id);
    const err = cardError[s.id];
    return (
      <div key={s.id} className={`rounded-msg border-2 bg-card p-3.5 ${r.border}`}>
        <div className="flex items-center justify-between">
          <span className={`text-body font-bold ${r.cls}`}>{r.tag}{s.level === "team" ? ` · ${versionText(s.version)}` : ""}</span>
          {s.level === "industry" && s.desensitized && (
            <span className="inline-flex items-center gap-1 text-body text-go">已脱敏 <Icon name="check" size={13} /></span> /* L8.1 共享前必须脱敏 */
          )}
        </div>
        <div className="mt-1.5 text-holo"><Icon name={skillIcon(s)} size={22} /></div>
        <h4 className="mt-1.5 text-body font-bold text-ink">{displayName(s)}</h4>
        <div className="mt-1 text-body leading-relaxed text-ink2">{displayDesc(s)}</div>
        {/* 绑定围栏可见（P6E2） */}
        {s.fence_bindings.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            <span className="rounded border border-line bg-bg800/60 px-1.5 py-0.5 text-body text-holo">
              已关联 {s.fence_bindings.length} 条围栏
            </span>
          </div>
        )}
        {/* F8.5 使用看板：调用次数 / 采纳率 / 驳回模式（绑定 Agent 事件投影） */}
        <div className="mt-2 text-body text-ink3">
          {u && u.calls30 > 0 ? (
            <>
              <b className="font-orb text-holo">{u.calls30}</b> 次调用 · 采纳率{" "}
              <b className={u.adoptionRate !== null && u.adoptionRate >= 0.8 ? "text-go" : "text-warn"}>
                {u.adoptionRate !== null ? `${Math.round(u.adoptionRate * 100)}%` : "—"}
              </b>
              {u.adoptionRate !== null && u.adoptionRate < 0.6 && <span className="text-warn">（采纳率偏低，建议优化或下架）</span>}
              {u.rejectReasons.length > 0 && (
                <div className="mt-0.5">驳回原因：{u.rejectReasons.map((x) => `${clientValueText(x.reason)} × ${x.count}`).join("；")}</div>
              )}
            </>
          ) : (
            "近 30 天暂无数字员工调用记录"
          )}
        </div>
        {/* 已装给谁（P6E2 →P8）/ 装备动作（readonly 隐藏 E2.6） */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {installed ? (
            <>
              <span className="inline-flex items-center gap-1 rounded border border-go/40 px-2 py-0.5 text-body text-go"><Icon name="check" size={13} />已装备</span>
              {(u?.boundAgents ?? []).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => nav(`/agents/${a.id}`)}
                  className="cursor-pointer rounded border border-line bg-bg800/60 px-2 py-0.5 text-body text-ink2 hover:border-holo/50"
                >
                  {clientChineseText(a.name, "数字员工")} →
                </button>
              ))}
              {canManage && (
                <button
                  type="button"
                  disabled={busy === s.id}
                  onClick={() => void uninstall(s.id)}
                  className="cursor-pointer rounded border border-line px-2 py-0.5 text-body text-ink3 hover:border-alert/50 hover:text-alert disabled:opacity-40"
                >
                  卸载
                </button>
              )}
            </>
          ) : (
            canManage && (
              <button
                type="button"
                disabled={busy === s.id}
                onClick={() => void install(s.id)}
                className="cursor-pointer rounded-md border border-gline bg-bg800/60 px-2.5 py-1 text-body font-bold text-goldhi hover:border-gold/60 disabled:opacity-40"
              >
                <Icon name="configuration" size={14} className="inline" /> 装备到船员
              </button>
            )
          )}
        </div>
        {err && <div className="mt-2 flex items-start gap-1 rounded border border-alert/50 bg-alert/8 px-2 py-1 text-body text-alert"><Icon name="error" size={13} className="mt-0.5 shrink-0" />拒绝安装：{err}</div>}
      </div>
    );
  };

  if (isCreate) {
    return <SkillWizard prefill={prefill} canManage={canManage} ready={ready} onDone={() => { void load(true); nav("/skills"); }} />;
  }

  return (
    <Bridge
      left={
        <>
          <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">技能分类</div>
          {[
            ["#sec-official", "官方技能", `金边 · ${officials.length}`],
            ["#sec-team", "团队技能", `银边 · ${teams.length}`],
            ...(showIndustry ? [["#sec-industry", "行业共享", `铜边 · ${industries.length}`] as const] : []),
          ].map(([href, label, meta]) => (
            <a
              key={href}
              href={href}
              className="mb-1.5 block rounded-lg border border-line bg-card px-3 py-2.5 hover:border-gline"
            >
              <div className="text-body text-ink2">{label}</div>
              <div className="mt-0.5 text-body text-ink3">{meta}</div>
            </a>
          ))}
          <button
            type="button"
            onClick={() => nav("/")}
            className="mt-2 w-full cursor-pointer rounded-lg border border-line px-3 py-2 text-body text-ink3 hover:border-holo/40 hover:text-ink2"
          >
            ← 返回工作台
          </button>
        </>
      }
      right={
        <>
          <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">能力沉淀闭环</div>
          <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
            执行 → 沉淀为技能和记忆 → 数字员工复用 → 再执行；审批结果和驳回原因会回流为评估数据。
          </div>
          <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink3">
            <div className="mb-1 text-body font-bold text-ink2">安全约束</div>
            行业共享上架前必须脱敏<br />
            正式环境只允许已签名的白名单技能<br />
            技能动作始终经过围栏判定<br />
            安装、卸载和创建都会写入事件账本
          </div>
          <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-body text-ink3">
            <div className="mb-1 text-body font-bold text-ink2">待确认建议</div>
            <b className="font-orb text-holo text-h2">{suggestions.length}</b> 条（同类任务每周出现至少 3 次时生成建议）
          </div>
        </>
      }
    >
      <div className="px-1">
        <div className="mb-4 flex flex-wrap items-baseline gap-3">
          <h2 className="text-[20px] font-black text-ink">技能中心</h2>
          <span className="text-body text-ink3">数字员工能力广场</span>
        </div>

        {banner && (
          <div className="mb-3">
            <BannerAlert level={banner.level}>{banner.text}</BannerAlert>
          </div>
        )}

        {!ready ? (
          <Skeleton count={5} height={72} label="技能列表正在加载" /> /* 加载态 G10 */
        ) : (
          <>
            {/* P6E1 意识系统建议横幅（F8.4；确认前不产生任何自动化 L4.4） */}
            {suggSlow && !suggSlowDismissed && (
              <div className="mb-3">
                <BannerAlert level="info" actionLabel="关闭" onAction={() => setSuggSlowDismissed(true)}>
                  意识系统分析中（建议生成超过 10 秒）…可关闭稍后再看
                </BannerAlert>
              </div>
            )}
            {/* P6E1 AwarenessBanner：主建议卡 + 待确认折叠（组件口径：横幅单卡带「待确认 N 条」计数） */}
            {suggestions.length > 0 && (
              <div className="mb-3 rounded-lg border border-holo/35 bg-card px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Icon name="agents" size={18} />
                  <div className="flex-1">
                    <b className="text-body text-ink">AI 副官建议</b>
                    {suggestions.length > 1 && (
                      <span className="ml-2 rounded border border-holo/40 px-1.5 py-0.5 text-body text-holo">待确认 {suggestions.length} 条</span>
                    )}
                    <div className="mt-0.5 text-body text-ink2">
                      检测到高频任务：「{suggestionActionText(suggestions[0]!.actionCategory)}（{suggestionObjectText(suggestions[0]!.objectType)}）」近 {suggestions[0]!.windowDays} 天共 <b className="text-holo">{suggestions[0]!.count}</b> 次
                      （每周达到 {suggestions[0]!.threshold} 次时生成建议{suggestions[0]!.threshold > 3 ? "；频率已根据历史驳回结果调整" : ""}）
                    </div>
                  </div>
                  {canManage && (
                    <div className="wl-action-row flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy === `sug-${suggestions[0]!.key}`}
                        onClick={() => void confirmTrigger(suggestions[0]!)}
                        className="cursor-pointer rounded-md gold-grad px-3 py-1.5 text-body font-bold text-ongold disabled:opacity-40"
                      >
                        <Icon name="lightning" size={14} className="inline" /> 一键固化为定时任务
                      </button>
                      <button
                        type="button"
                        onClick={() => nav("/skills/create", { state: { name: suggestionActionText(suggestions[0]!.actionCategory), trigger: `出现「${suggestionObjectText(suggestions[0]!.objectType)}」类 ${suggestionActionText(suggestions[0]!.actionCategory)} 任务时（高频样本 ${suggestions[0]!.count} 次）`, fromSuggestion: suggestions[0]!.key } })}
                        className="cursor-pointer rounded-md border border-gline px-3 py-1.5 text-body font-bold text-goldhi hover:border-gold/60"
                      >
                        <Icon name="customize" size={14} className="inline" /> 生成装备草稿
                      </button>
                      <button
                        type="button"
                        disabled={busy === `sug-${suggestions[0]!.key}`}
                        onClick={() => void rejectSug(suggestions[0]!)}
                        className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-body text-ink3 hover:border-alert/40 hover:text-alert disabled:opacity-40"
                      >
                        驳回并减少同类建议
                      </button>
                    </div>
                  )}
                </div>
                {/* 其余待确认建议（紧凑行；同三手势） */}
                {suggestions.slice(1).map((s) => (
                  <div key={s.key} className="mt-2 flex items-center gap-2.5 border-t border-line/60 pt-2 text-body">
                    <span className="flex-1 text-ink2">
                      「{suggestionActionText(s.actionCategory)}（{suggestionObjectText(s.objectType)}）」共 <b className="text-holo">{s.count}</b> 次，统计周期 {s.windowDays} 天
                    </span>
                    {canManage && (
                      <>
                        <button type="button" disabled={busy === `sug-${s.key}`} onClick={() => void confirmTrigger(s)}
                          className="cursor-pointer rounded border border-gline px-2 py-0.5 text-body font-bold text-goldhi hover:border-gold/60 disabled:opacity-40"><Icon name="lightning" size={13} className="inline" /> 固化</button>
                        <button type="button" onClick={() => nav("/skills/create", { state: { name: suggestionActionText(s.actionCategory), trigger: `出现「${suggestionObjectText(s.objectType)}」类 ${suggestionActionText(s.actionCategory)} 任务时（高频样本 ${s.count} 次）`, fromSuggestion: s.key } })}
                          className="cursor-pointer rounded border border-line px-2 py-0.5 text-body text-ink2 hover:border-gline"><Icon name="customize" size={13} className="inline" /> 草稿</button>
                        <button type="button" disabled={busy === `sug-${s.key}`} onClick={() => void rejectSug(s)}
                          className="cursor-pointer rounded border border-line px-2 py-0.5 text-body text-ink3 hover:border-alert/40 hover:text-alert disabled:opacity-40">驳回</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 空态（F8.1）：未安装任何技能 → 仅显官方技能 + 新建入口 */}
            {nothingInstalled && (
              <div className="mb-3">
                <EmptyState title="尚未装备任何技能" hint="可以从官方技能开始；安装时会同步启用关联围栏，卸载时同步撤销。" />
              </div>
            )}

            {/* P6E2 官方技能（金边传说） */}
            <div id="sec-official" className="mb-2 text-body font-bold tracking-wider text-ink2">
              官方技能 · 随行业包分发
            </div>
            <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {officials.map(renderCard)}
            </div>

            {/* P6E3 团队技能（银边） */}
            {!nothingInstalled || teams.length > 0 ? (
              <>
                <div id="sec-team" className="mb-2 text-body font-bold tracking-wider text-ink2">
                  团队技能（银边 · 本工作区自建）
                </div>
                <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {teams.length > 0 ? teams.map(renderCard) : (
                    <div className="col-span-2 rounded-lg border border-dashed border-line p-4 text-center text-body text-ink3">
                      还没有团队技能——可用下方「打造新装备」零代码创建
                    </div>
                  )}
                </div>
              </>
            ) : null}

            {/* P6E3 行业共享（铜边 · 已脱敏；F7.2 社区版不显示） */}
            {showIndustry && (!nothingInstalled || industries.length > 0) && (
              <>
                <div id="sec-industry" className="mb-2 text-body font-bold tracking-wider text-ink2">
                  行业共享（已脱敏）
                </div>
                <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {industries.length > 0 ? industries.map(renderCard) : (
                    <div className="col-span-2 rounded-lg border border-dashed border-line p-4 text-center text-body text-ink3">
                      当前行业联盟暂无共享技能
                    </div>
                  )}
                </div>
              </>
            )}

            {/* P6E4 零代码新建技能 */}
            {canManage && (
              <button
                type="button"
                onClick={() => nav("/skills/create")}
                className="cursor-pointer rounded-md gold-grad px-4 py-2.5 text-body font-bold text-ongold"
              >
                <Icon name="customize" size={15} className="inline" /> 打造新装备（零代码）
              </button>
            )}
          </>
        )}
      </div>
    </Bridge>
  );
}

/** 零代码创建向导（p6_create；PRD P6-④ SkillWizard：三要素 + 草稿预览 + dry-run 前置 F8.3/F2.5） */
function SkillWizard({
  prefill,
  canManage,
  ready,
  onDone,
}: {
  prefill: { name?: string; trigger?: string; fromSuggestion?: string } | null;
  canManage: boolean;
  ready: boolean;
  onDone: () => void;
}) {
  const nav = useNavigate();
  const [name, setName] = useState(prefill?.name ?? "");
  const [desc, setDesc] = useState("");
  const [trigger, setTrigger] = useState(prefill?.trigger ?? "");
  const [stepsText, setStepsText] = useState("");
  const [boundary, setBoundary] = useState("");
  const [fences, setFences] = useState<string[]>([]);
  const [ruleOptions, setRuleOptions] = useState<Array<{ rule_id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ skillId: string; version: string } | null>(null); // 完成后态
  const [dryReport, setDryReport] = useState<{ replayed: number; perRule: Array<{ ruleId: string; version: string; wouldBlock: number; wouldReview: number; pass: number }> } | null>(null);

  useEffect(() => {
    if (!ready) return;
    void (async () => {
      const rules = await trpc.fence.rules.query() as Array<{ rule_id: string; name: string; status: string }>;
      setRuleOptions(rules.filter((r) => r.status === "active").map((r) => ({
        rule_id: r.rule_id,
        name: clientChineseText(r.name, "关联围栏"),
      })));
    })();
  }, [ready]);

  const steps = useMemo(() => stepsText.split("\n").map((s) => s.trim()).filter(Boolean), [stepsText]);
  const valid = name.trim().length > 0 && trigger.trim().length > 0 && steps.length > 0 && boundary.trim().length > 0;

  /** 客户端只展示中文业务草稿，不泄露实际存储字段。 */
  const preview = useMemo(() => {
    const selectedRules = fences.map((id) => ruleOptions.find((rule) => rule.rule_id === id)?.name).filter(Boolean);
    return [
      `技能名称：${name.trim() || "（未填）"}`,
      `技能说明：${desc || "（未填）"}`,
      "",
      "触发条件（何时用）",
      trigger || "（未填）",
      "",
      "执行步骤（怎么做）",
      ...(steps.length > 0 ? steps.map((s, i) => `${i + 1}. ${s}`) : ["（未填）"]),
      "",
      "安全边界（什么不做）",
      boundary || "（未填）",
      "",
      `关联围栏：${selectedRules.length > 0 ? selectedRules.join("、") : "暂无"}`,
      "创建后需先完成模拟回放，再允许安装。",
    ].join("\n");
  }, [name, desc, trigger, steps, boundary, fences, ruleOptions]);

  const doForge = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const r = await trpc.skills.forge.mutate({
        name: name.trim(), description: desc.trim(),
        triplet: { trigger: trigger.trim(), steps, boundary: boundary.trim() },
        fenceBindings: fences,
      }) as { skillId: string; version: string };
      setCreated(r);
    } catch (e) {
      console.warn("创建技能失败", e);
      setError("创建失败，请检查必填内容与权限后重试。");
    } finally {
      setBusy(false);
    }
  }, [name, desc, trigger, steps, boundary, fences]);

  const doDryRun = useCallback(async () => {
    if (!created) return;
    setBusy(true);
    try {
      const r = await trpc.skills.dryRun.mutate({ skillId: created.skillId }) as typeof dryReport;
      setDryReport(r);
    } catch (e) {
      console.warn("技能模拟回放失败", e);
      setError("模拟回放暂时失败，技能尚未安装，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }, [created]);

  const doInstall = useCallback(async () => {
    if (!created) return;
    setBusy(true);
    try {
      await trpc.skills.install.mutate({ skillId: created.skillId });
      onDone(); // 完成后态：回技能中心，新卡入「团队技能」（F8.3）
    } catch (e) {
      console.warn("安装新技能失败", e);
      setError("安装失败，草稿仍已保留；请稍后重试。");
      setBusy(false);
    }
  }, [created, onDone]);

  return (
    <Bridge>
      <div className="px-1">
        <div className="mb-4 flex flex-wrap items-baseline gap-3">
          <h2 className="text-[20px] font-black text-ink">打造新装备</h2>
          <span className="text-body text-ink3">零代码自定义技能</span>
          {prefill?.fromSuggestion && <span className="text-body text-holo">已带入系统建议内容</span>}
        </div>
        {!canManage && ready && (
          <BannerAlert level="warn">当前账号为只读成员，不能创建技能。请联系工作区管理员调整权限。</BannerAlert>
        )}
        <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="mb-1.5 text-body font-bold text-ink2">装备名称 / 简述</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：周一经营复盘"
                className="mb-2 w-full rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
              />
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="一句话说明这件装备做什么"
                className="w-full rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
              />
            </div>
              {[
              { t: "① 何时触发", v: trigger, set: setTrigger, ph: "每周一 08:00，或核心指标连续 3 天下滑时", rows: 2 },
            ].map((f) => (
              <div key={f.t} className="rounded-lg border border-line bg-card p-3">
                <div className="mb-1.5 text-body font-bold text-ink2">{f.t}</div>
                <textarea
                  value={f.v}
                  onChange={(e) => f.set(e.target.value)}
                  placeholder={f.ph}
                  rows={f.rows}
                  className="w-full resize-none rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
                />
              </div>
            ))}
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="mb-1.5 text-body font-bold text-ink2">② 做什么（每行一步）</div>
              <textarea
                value={stepsText}
                onChange={(e) => setStepsText(e.target.value)}
                placeholder={"汇总上周核心经营指标\n对比同类业务表现\n给出 3 条本周动作建议"}
                rows={3}
                className="w-full resize-none rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
              />
            </div>
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="mb-1.5 text-body font-bold text-ink2">③ 不能做什么 → 自动生成围栏声明</div>
              <textarea
                value={boundary}
                onChange={(e) => setBoundary(e.target.value)}
                placeholder="只读分析，不得直接写回；涉及金额或高风险动作必须审批"
                rows={2}
                className="w-full resize-none rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
              />
              {boundary.trim() && (
                <div className="mt-1.5 flex items-center gap-1.5 text-body text-warn">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn" />
                  已生成围栏声明草稿：边界文本将随技能生效，并始终受围栏判定管辖
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ruleOptions.map((r) => (
                  <button
                    key={r.rule_id}
                    type="button"
                    onClick={() => setFences((xs) => xs.includes(r.rule_id) ? xs.filter((x) => x !== r.rule_id) : [...xs, r.rule_id])}
                    className={`cursor-pointer rounded border px-2 py-0.5 text-body ${
                      fences.includes(r.rule_id) ? "border-holo/60 bg-holo/10 text-holo" : "border-line text-ink3 hover:border-holo/40"
                    }`}
                    title={clientChineseText(r.name, "关联围栏")}
                  >
                    {clientChineseText(r.name, "关联围栏")}
                  </button>
                ))}
              </div>
            </div>
            {error && <BannerAlert level="alert">{error}</BannerAlert>}
            <div className="wl-action-row flex flex-wrap gap-2.5">
              {!created ? (
                <>
                  <button
                    type="button"
                    disabled={!valid || busy || !canManage}
                    onClick={() => void doForge()}
                    className="cursor-pointer rounded-md gold-grad px-4 py-2 text-body font-bold text-ongold disabled:opacity-40"
                  >
                    <Icon name="check" size={15} className="inline" /> 确认创建（进版本管理 v1）
                  </button>
                  <button
                    type="button"
                    onClick={() => nav("/skills")}
                    className="cursor-pointer rounded-md border border-line px-4 py-2 text-body text-ink3 hover:text-ink2"
                  >
                    返回技能中心
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void doDryRun()}
                    className="cursor-pointer rounded-md gold-grad px-4 py-2 text-body font-bold text-ongold disabled:opacity-40"
                  >
                    <Icon name="experiment" size={15} className="inline" /> 模拟回放最近 10 条事件
                  </button>
                  <button
                    type="button"
                    disabled={busy || !dryReport}
                    onClick={() => void doInstall()}
                    title={dryReport ? "" : "生效前须先完成模拟回放"}
                    className="cursor-pointer rounded-md border border-go/50 px-4 py-2 text-body font-bold text-go disabled:opacity-40"
                  >
                    <Icon name="configuration" size={15} className="inline" /> 安装到本工作区
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="mb-1.5 text-body font-bold text-ink2">技能草稿预览</div>
              <pre className="whitespace-pre-wrap rounded-lg border border-line bg-bg900 p-3 font-mono text-body leading-relaxed text-ink2">{preview}</pre>
              <div className="mt-2 text-body leading-relaxed text-ink3">
                确认创建后进入版本管理；关联围栏随安装生效、卸载撤销；正式环境仅允许已签名的白名单技能。
              </div>
            </div>
            {created && (
              <div className="rounded-lg border border-go/40 bg-go/5 p-3">
                <div className="text-body font-bold text-go"><Icon name="check" size={14} className="inline" /> 团队技能已创建并进入版本管理，{versionText(created.version)}</div>
                {dryReport && (
                  <div className="mt-2 text-body text-ink2">
                    已模拟回放 {dryReport.replayed} 条：
                    {dryReport.perRule.length > 0 ? dryReport.perRule.map((r) => (
                      <div key={r.ruleId} className="mt-1">
                        {clientChineseText(ruleOptions.find((rule) => rule.rule_id === r.ruleId)?.name, "关联围栏")}：放行 {r.pass} 条、需复核 {r.wouldReview} 条、阻断 {r.wouldBlock} 条
                      </div>
                    )) : <span className="text-ink3">（无绑定围栏可回放）</span>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Bridge>
  );
}
