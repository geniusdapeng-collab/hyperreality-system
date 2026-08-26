/**
 * P6 技能中心（F10：Agent 能力商店 · 技能广场；PRD P6-①②③④⑤ 逐条对账）
 *  - P6E1 意识系统建议横幅（F8.4 ≥3 次/周高频检测；一键固化→触发器 F4.7 / 生成草稿→p6_create / 驳回降权 E8.3；
 *    确认前不产生任何自动化 L4.4；超时态 >10s 显「分析中」可关闭）
 *  - P6E2 官方技能（金边传说·随 Bundle 分发；安装/已安装状态；绑定围栏可见；「已装给谁」→P8）
 *  - P6E3 团队技能（银边）/ 行业共享（铜边 · 已脱敏 ✓ L8.1；调用次数与采纳率公开=F8.5 事件投影）
 *  - P6E4 零代码新建技能「打造新装备」→ /p6/create 三要素向导（F8.3；「不能做什么」自动转围栏声明）
 *  - 技能广场四环（components/p6/*）：
 *    ①发现环：技能卡「战斗力」区（调用次数/关联爆款率/上周命中率，skills 遥测投影，缺显「—」）
 *      + 顶部「适合当前阶段」推荐横条（workspace.profile.stage → 3 个官方技能）
 *    ②组合环：技能链（爆款种草/合规发布两条样例链，查看步骤 + 编译为管线 toast 占位）
 *    ③进化环：冷藏区（连续 4 周零命中降权展示，Mock 兜底）+ 进化提案（驳回样本修订建议，批准 toast 占位）
 *    ④生产环：拉片反推（jenny-loom-research v2 + 上传占位）+ forge 自建入口（沿用 /p6/create）
 * 状态变体：p6 默认 / p6_create 创建；加载骨架 G10；空态仅官方技能+新建入口（F8.1）；
 *   错误态安装拒绝+原因（L8.2/E8.2）；权限态社区版不显行业共享区（F7.2）+ readonly 隐藏全部动作（E2.6 隐藏非置灰）；
 *   完成后态创建成功→团队技能 v1 进版本管理（F8.3）
 * 数据来源：skills router（list/installs/usage=F8.5 投影/forge/dryRun/awareness.*）+ workspace.profile（阶段）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert, EmptyState, SkeletonBlock } from "../../components/hud";
import {
  RARITY, displayDesc, displayName, skillIcon,
} from "../../components/p6/skillShared";
import type { SkillRow, SkillUsage } from "../../components/p6/skillShared";
import { StageRecommendBar } from "../../components/p6/StageRecommendBar";
import { SkillChains } from "../../components/p6/SkillChains";
import { EvolutionZone } from "../../components/p6/EvolutionZone";
import { ProductionEntry } from "../../components/p6/ProductionEntry";

interface InstallRow { skill_id: string; installed_by: string; installed_at: string }
interface Suggestion {
  key: string; objectType: string; actionCategory: string;
  count: number; windowDays: number; threshold: number; sampleEventIds: string[];
}

export default function P6() {
  const nav = useNavigate();
  const location = useLocation();
  const isCreate = location.pathname.endsWith("/create");
  const prefill = (location.state ?? null) as { name?: string; trigger?: string; fromSuggestion?: string } | null;

  const [ready, setReady] = useState(false);
  const [role, setRole] = useState("owner");
  const [plan, setPlan] = useState("pro");
  const [stage, setStage] = useState<string | null>(null); // 工作区阶段（发现环推荐口径）
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
      const [meR, sk, ins, usg, sug, wsp] = await Promise.all([
        trpc.members.me.query() as Promise<{ identity: { role: string; plan: string } }>,
        trpc.skills.list.query() as Promise<SkillRow[]>,
        trpc.skills.installs.query() as Promise<InstallRow[]>,
        trpc.skills.usage.query() as Promise<Record<string, SkillUsage>>,
        trpc.skills.awareness.suggestions.query() as Promise<Suggestion[]>,
        trpc.workspace.profile.query() as Promise<{ stage: string | null }>,
      ]);
      if (slowTimer.current) clearTimeout(slowTimer.current);
      setSuggSlow(false);
      setRole(meR.identity.role);
      setPlan(meR.identity.plan);
      setSkills(sk);
      setInstalls(ins);
      setUsage(usg);
      setSuggestions(sug);
      setStage(wsp.stage);
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

  const canManage = role === "owner" || role === "manager";
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
      setBanner({ level: "info", text: `已固化为定时触发器 ${r.artifactId}（每周一 08:00，受围栏管辖 L4.4；事件 ${r.eventId}）` });
      await load(true);
    } catch (e) {
      setBanner({ level: "alert", text: `固化失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [load]);

  /** 驳回建议 → 降权（E8.3 校准闭环：该类阈值 ×2） */
  const rejectSug = useCallback(async (s: Suggestion) => {
    setBusy(`sug-${s.key}`);
    try {
      await trpc.skills.awareness.reject.mutate({ key: s.key });
      setBanner({ level: "warn", text: `已驳回「${s.actionCategory}」类建议——该类检测阈值 ×2 降权（E8.3 校准闭环）` });
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
      setBanner({ level: "info", text: `已装备 ${skillId}（围栏绑定随安装生效 F8.2${r.bindings.length ? `：${r.bindings.join("/")}` : ""}）` });
      await load(true);
    } catch (e) {
      setCardError((m) => ({ ...m, [skillId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  }, [load]);

  /** 卸载（L8.3 卸载即撤销围栏绑定） */
  const uninstall = useCallback(async (skillId: string) => {
    setBusy(skillId);
    try {
      await trpc.skills.uninstall.mutate({ skillId });
      setBanner({ level: "warn", text: `已卸载 ${skillId}（围栏绑定即撤销 L8.3）` });
      await load(true);
    } catch (e) {
      setCardError((m) => ({ ...m, [skillId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  }, [load]);

  /** 占位动作 toast（技能链编译/进化批准/拉片上传等未上线能力统一走横幅说明，不落库） */
  const notify = useCallback((text: string) => setBanner({ level: "info", text }), []);

  /** 技能卡（装备卡 · 稀有度边框；P6-④ SkillCard） */
  const renderCard = (s: SkillRow) => {
    const r = RARITY[s.level];
    const u = usage[s.id];
    const installed = installedSet.has(s.id);
    const err = cardError[s.id];
    return (
      <div key={s.id} className={`rounded-msg border-2 bg-card p-3.5 ${r.border}`}>
        <div className="flex items-center justify-between">
          <span className={`text-micro font-bold ${r.cls}`}>{r.icon} {r.tag}{s.level === "team" ? ` v${s.version.replace(/\.0$/, "")}` : ""}</span>
          {s.level === "industry" && s.desensitized && (
            <span className="text-micro text-go">已脱敏 ✓</span> /* L8.1 共享前必须脱敏 */
          )}
        </div>
        <div className="mt-1.5 text-[22px]">{skillIcon(s)}</div>
        <h4 className="mt-1.5 text-body font-bold text-ink">{displayName(s)}</h4>
        <div className="mt-1 text-caption leading-relaxed text-ink2">{displayDesc(s)}</div>
        {/* 绑定围栏可见（P6E2） */}
        {s.fence_bindings.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {s.fence_bindings.map((f) => (
              <span key={f} className="rounded border border-line bg-bg800/60 px-1.5 py-0.5 font-mono text-micro text-holo">绑 {f}</span>
            ))}
          </div>
        )}
        {/* 发现环 · 战斗力区（skills 遥测投影；缺数据显「—」不伪造） */}
        <div className="mt-2 flex gap-2.5 rounded-lg border border-line/60 bg-bg800/40 px-2 py-1.5 text-micro text-ink3">
          <span title="近 30 天绑定 Agent 动作投影">⚔ 调用 <b className="font-orb text-holo">{u && u.calls30 > 0 ? u.calls30 : "—"}</b></span>
          <span title="关联产出进入爆款样本占比（遥测未出数）">🔥 爆款率 <b className="font-orb text-ink2">—</b></span>
          <span title="上周命中率（遥测未出数）">🎯 周命中 <b className="font-orb text-ink2">—</b></span>
        </div>
        {/* F8.5 使用看板：调用次数 / 采纳率 / 驳回模式（绑定 Agent 事件投影） */}
        <div className="mt-2 text-micro text-ink3">
          {u && u.calls30 > 0 ? (
            <>
              <b className="font-orb text-holo">{u.calls30}</b> 次调用 · 采纳率{" "}
              <b className={u.adoptionRate !== null && u.adoptionRate >= 0.8 ? "text-go" : "text-warn"}>
                {u.adoptionRate !== null ? `${Math.round(u.adoptionRate * 100)}%` : "—"}
              </b>
              {u.adoptionRate !== null && u.adoptionRate < 0.6 && <span className="text-warn">（低采纳，建议优化或下架 F8.5）</span>}
              {u.rejectReasons.length > 0 && (
                <div className="mt-0.5">驳回模式：{u.rejectReasons.map((x) => `${x.reason}×${x.count}`).join(" / ")}</div>
              )}
            </>
          ) : (
            "近 30 天暂无绑定 Agent 动作投影"
          )}
        </div>
        {/* 已装给谁（P6E2 →P8）/ 装备动作（readonly 隐藏 E2.6） */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {installed ? (
            <>
              <span className="rounded border border-go/40 px-2 py-0.5 text-micro text-go">✓ 已装备</span>
              {(u?.boundAgents ?? []).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => nav(`/p8/agent/${a.id}`)}
                  className="cursor-pointer rounded border border-line bg-bg800/60 px-2 py-0.5 text-micro text-ink2 hover:border-holo/50"
                >
                  {a.name} →
                </button>
              ))}
              {canManage && (
                <button
                  type="button"
                  disabled={busy === s.id}
                  onClick={() => void uninstall(s.id)}
                  className="cursor-pointer rounded border border-line px-2 py-0.5 text-micro text-ink3 hover:border-alert/50 hover:text-alert disabled:opacity-40"
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
                className="cursor-pointer rounded-md border border-gline bg-bg800/60 px-2.5 py-1 text-caption font-bold text-goldhi hover:border-gold/60 disabled:opacity-40"
              >
                ⚙ 装备到船员
              </button>
            )
          )}
        </div>
        {err && <div className="mt-2 rounded border border-alert/50 bg-alert/8 px-2 py-1 text-micro text-alert">✗ 拒绝安装：{err}</div>}
      </div>
    );
  };

  if (isCreate) {
    return <SkillWizard prefill={prefill} canManage={canManage} ready={ready} onDone={() => { void load(true); nav("/p6"); }} />;
  }

  return (
    <Bridge
      left={
        <>
          <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">技能中心 · ARMORY</div>
          {[
            ["#sec-official", "✦ 官方技能", `金边 · ${officials.length}`],
            ["#sec-team", "✧ 团队技能", `银边 · ${teams.length}`],
            ...(showIndustry ? [["#sec-industry", "❖ 行业共享", `铜边 · ${industries.length}`] as const] : []),
            ["#sec-chains", "⛓ 技能链", "组合环 · 2 条样例"],
            ["#sec-evolution", "🧬 进化环", "冷藏区 · 提案"],
            ["#sec-production", "🎞 生产环", "拉片反推 · forge"],
          ].map(([href, label, meta]) => (
            <a
              key={href}
              href={href}
              className="mb-1.5 block rounded-lg border border-line bg-card px-3 py-2.5 hover:border-gline"
            >
              <div className="text-body text-ink2">{label}</div>
              <div className="mt-0.5 text-micro text-ink3">{meta}</div>
            </a>
          ))}
          <button
            type="button"
            onClick={() => nav("/")}
            className="mt-2 w-full cursor-pointer rounded-lg border border-line px-3 py-2 text-caption text-ink3 hover:border-holo/40 hover:text-ink2"
          >
            ← 返回工作台
          </button>
        </>
      }
      right={
        <>
          <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">资产飞轮 · FLYWHEEL</div>
          <div className="rounded-lg border border-line bg-card p-3 text-caption leading-relaxed text-ink2">
            执行 → 沉淀（技能/记忆）→ 复用（Agent 调用）→ 再执行；审批手势与驳回原因回流为评估数据（F8.7）。
          </div>
          <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-caption leading-relaxed text-ink3">
            <div className="mb-1 text-micro font-bold text-ink2">安全约束</div>
            行业共享上架前必须脱敏（L8.1/E8.4）<br />
            生产仅签名白名单（L8.2）<br />
            技能动作照常过围栏瀑布（L8.3）<br />
            安装/卸载/创建全部事件化（G8）
          </div>
          <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-caption text-ink3">
            <div className="mb-1 text-micro font-bold text-ink2">待确认建议</div>
            <b className="font-orb text-holo text-[16px]">{suggestions.length}</b> 条（F8.4 高频检测 ≥3 次/周）
          </div>
        </>
      }
    >
      <div className="px-1">
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-[20px] font-black text-ink">技能中心</h2>
          <span className="text-caption text-ink3">Agent 能力商店 · 技能广场</span>
          <span className="font-mono text-micro text-ink3">F8.2 · F8.4</span>
        </div>

        {banner && (
          <div className="mb-3">
            <BannerAlert level={banner.level}>{banner.text}</BannerAlert>
          </div>
        )}

        {!ready ? (
          <SkeletonBlock lines={5} h={72} /> /* 加载态 G10 */
        ) : (
          <>
            {/* P6E1 意识系统建议横幅（F8.4；确认前不产生任何自动化 L4.4） */}
            {suggSlow && !suggSlowDismissed && (
              <div className="mb-3">
                <BannerAlert level="info" actionLabel="关闭" onAction={() => setSuggSlowDismissed(true)}>
                  意识系统分析中（建议生成 &gt;10s）…可关闭稍后再看
                </BannerAlert>
              </div>
            )}
            {/* P6E1 AwarenessBanner：主建议卡 + 待确认折叠（组件口径：横幅单卡带「待确认 N 条」计数） */}
            {suggestions.length > 0 && (
              <div className="mb-3 rounded-lg border border-holo/35 bg-card px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="text-[18px]">🤖</span>
                  <div className="flex-1">
                    <b className="text-body text-ink">AI 副官建议</b>
                    {suggestions.length > 1 && (
                      <span className="ml-2 rounded border border-holo/40 px-1.5 py-0.5 text-micro text-holo">待确认 {suggestions.length} 条</span>
                    )}
                    <div className="mt-0.5 text-caption text-ink2">
                      检测到高频任务：「{suggestions[0]!.actionCategory}（{suggestions[0]!.objectType}）」近 {suggestions[0]!.windowDays} 天 × <b className="text-holo">{suggestions[0]!.count}</b> 次
                      （≥{suggestions[0]!.threshold} 次/周 触发建议 F8.4{suggestions[0]!.threshold > 3 ? "，阈值已经驳回校准" : ""}）
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy === `sug-${suggestions[0]!.key}`}
                        onClick={() => void confirmTrigger(suggestions[0]!)}
                        className="cursor-pointer rounded-md gold-grad px-3 py-1.5 text-caption font-bold text-ongold disabled:opacity-40"
                      >
                        ⚡ 一键固化为定时任务
                      </button>
                      <button
                        type="button"
                        onClick={() => nav("/p6/create", { state: { name: suggestions[0]!.actionCategory, trigger: `出现「${suggestions[0]!.objectType}」类 ${suggestions[0]!.actionCategory} 任务时（高频样本 ${suggestions[0]!.count} 次）`, fromSuggestion: suggestions[0]!.key } })}
                        className="cursor-pointer rounded-md border border-gline px-3 py-1.5 text-caption font-bold text-goldhi hover:border-gold/60"
                      >
                        🛠 生成装备草稿
                      </button>
                      <button
                        type="button"
                        disabled={busy === `sug-${suggestions[0]!.key}`}
                        onClick={() => void rejectSug(suggestions[0]!)}
                        className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-caption text-ink3 hover:border-alert/40 hover:text-alert disabled:opacity-40"
                      >
                        驳回（降权 E8.3）
                      </button>
                    </div>
                  )}
                </div>
                {/* 其余待确认建议（紧凑行；同三手势） */}
                {suggestions.slice(1).map((s) => (
                  <div key={s.key} className="mt-2 flex items-center gap-2.5 border-t border-line/60 pt-2 text-caption">
                    <span className="flex-1 text-ink2">
                      「{s.actionCategory}（{s.objectType}）」× <b className="text-holo">{s.count}</b> 次 / {s.windowDays} 天
                    </span>
                    {canManage && (
                      <>
                        <button type="button" disabled={busy === `sug-${s.key}`} onClick={() => void confirmTrigger(s)}
                          className="cursor-pointer rounded border border-gline px-2 py-0.5 text-micro font-bold text-goldhi hover:border-gold/60 disabled:opacity-40">⚡ 固化</button>
                        <button type="button" onClick={() => nav("/p6/create", { state: { name: s.actionCategory, trigger: `出现「${s.objectType}」类 ${s.actionCategory} 任务时（高频样本 ${s.count} 次）`, fromSuggestion: s.key } })}
                          className="cursor-pointer rounded border border-line px-2 py-0.5 text-micro text-ink2 hover:border-gline">🛠 草稿</button>
                        <button type="button" disabled={busy === `sug-${s.key}`} onClick={() => void rejectSug(s)}
                          className="cursor-pointer rounded border border-line px-2 py-0.5 text-micro text-ink3 hover:border-alert/40 hover:text-alert disabled:opacity-40">驳回</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 发现环①「适合当前阶段」推荐横条（workspace.profile.stage → 3 个官方技能） */}
            <StageRecommendBar
              stage={stage}
              officials={officials}
              installedSet={installedSet}
              busy={busy}
              canManage={canManage}
              onInstall={(id) => void install(id)}
            />

            {/* 空态（F8.1）：未安装任何技能 → 仅显官方技能 + 新建入口 */}
            {nothingInstalled && (
              <div className="mb-3">
                <EmptyState title="尚未装备任何技能" hint="从官方技能开始——安装即绑定围栏（F8.2），卸载即撤销（L8.3）" />
              </div>
            )}

            {/* P6E2 官方技能（金边传说） */}
            <div id="sec-official" className="mb-2 text-caption font-bold tracking-wider text-ink2">
              官方技能 · 随行业 Bundle 分发（金边传说）
            </div>
            <div className="mb-5 grid grid-cols-3 gap-3">
              {officials.map(renderCard)}
            </div>

            {/* P6E3 团队技能（银边） */}
            {!nothingInstalled || teams.length > 0 ? (
              <>
                <div id="sec-team" className="mb-2 text-caption font-bold tracking-wider text-ink2">
                  团队技能（银边 · 本工作区自建）
                </div>
                <div className="mb-5 grid grid-cols-2 gap-3">
                  {teams.length > 0 ? teams.map(renderCard) : (
                    <div className="col-span-2 rounded-lg border border-dashed border-line p-4 text-center text-caption text-ink3">
                      还没有团队技能——用下方「打造新装备」零代码创建（F8.3）
                    </div>
                  )}
                </div>
              </>
            ) : null}

            {/* P6E3 行业共享（铜边 · 已脱敏；F7.2 社区版不显示） */}
            {showIndustry && (!nothingInstalled || industries.length > 0) && (
              <>
                <div id="sec-industry" className="mb-2 text-caption font-bold tracking-wider text-ink2">
                  行业共享（铜边 · 已脱敏 ✓ L8.1）
                </div>
                <div className="mb-5 grid grid-cols-2 gap-3">
                  {industries.length > 0 ? industries.map(renderCard) : (
                    <div className="col-span-2 rounded-lg border border-dashed border-line p-4 text-center text-caption text-ink3">
                      当前行业联盟暂无共享技能
                    </div>
                  )}
                </div>
              </>
            )}

            {/* 组合环② 技能链（样例链 · 查看步骤 / 编译为管线占位） */}
            <div id="sec-chains">
              <SkillChains skills={skills} onToast={notify} />
            </div>

            {/* 进化环③ 冷藏区 + 进化提案（驳回样本校准闭环） */}
            <div id="sec-evolution">
              <EvolutionZone skills={skills} usage={usage} onToast={notify} />
            </div>

            {/* 生产环④ 拉片反推 + forge 自建入口（P6E4 沿用 /p6/create） */}
            <div id="sec-production">
              <ProductionEntry canManage={canManage} onToast={notify} onForge={() => nav("/p6/create")} />
            </div>
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
      setRuleOptions(rules.filter((r) => r.status === "active").map((r) => ({ rule_id: r.rule_id, name: r.name })));
    })();
  }, [ready]);

  const steps = useMemo(() => stepsText.split("\n").map((s) => s.trim()).filter(Boolean), [stepsText]);
  const valid = name.trim().length > 0 && trigger.trim().length > 0 && steps.length > 0 && boundary.trim().length > 0;

  /** 草稿预览（SKILL.md 投影；与服务端 renderSkillMarkdown 同构） */
  const preview = useMemo(() => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
    return [
      `name: ${slug}`,
      `description: ${desc || "（未填）"}`,
      "",
      "## 触发（何时用）",
      trigger || "（未填）",
      "",
      "## 步骤（怎么做）",
      ...(steps.length > 0 ? steps.map((s, i) => `${i + 1}. ${s}`) : ["（未填）"]),
      "",
      "## 边界（什么不做）",
      boundary || "（未填）",
      "",
      `fence_bindings: [${fences.join(", ")}]`,
      "生效前 dry-run（F8.3/F2.5）",
    ].join("\n");
  }, [name, desc, trigger, steps, boundary, fences]);

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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [created, onDone]);

  return (
    <Bridge>
      <div className="px-1">
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-[20px] font-black text-ink">打造新装备</h2>
          <span className="text-caption text-ink3">零代码自定义技能 · F8.3</span>
          {prefill?.fromSuggestion && <span className="font-mono text-micro text-holo">来自意识系统建议 {prefill.fromSuggestion}</span>}
        </div>
        {!canManage && ready && (
          <BannerAlert level="warn">只读成员无创建权限（E2.6 隐藏非置灰——此页入口已在技能中心隐藏）</BannerAlert>
        )}
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="mb-1.5 text-caption font-bold text-ink2">装备名称 / 简述</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：每周爆款复盘"
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
              { t: "① 何时触发", v: trigger, set: setTrigger, ph: "每周一 08:00，或账号播放连续 3 天下滑时", rows: 2 },
            ].map((f) => (
              <div key={f.t} className="rounded-lg border border-line bg-card p-3">
                <div className="mb-1.5 text-caption font-bold text-ink2">{f.t}</div>
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
              <div className="mb-1.5 text-caption font-bold text-ink2">② 做什么（每行一步）</div>
              <textarea
                value={stepsText}
                onChange={(e) => setStepsText(e.target.value)}
                placeholder={"汇总上周发布·播放·涨粉\n对比竞对账号同档内容\n给出 3 条本周动作建议"}
                rows={3}
                className="w-full resize-none rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
              />
            </div>
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="mb-1.5 text-caption font-bold text-ink2">③ 不能做什么 → 自动转围栏声明（F8.3）</div>
              <textarea
                value={boundary}
                onChange={(e) => setBoundary(e.target.value)}
                placeholder="只读分析，不得直接发布；涉及功效宣称必审"
                rows={2}
                className="w-full resize-none rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
              />
              {boundary.trim() && (
                <div className="mt-1.5 flex items-center gap-1.5 text-micro text-warn">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn" />
                  已生成围栏声明草稿：边界文本将随技能生效受围栏瀑布管辖（L8.3）
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ruleOptions.map((r) => (
                  <button
                    key={r.rule_id}
                    type="button"
                    onClick={() => setFences((xs) => xs.includes(r.rule_id) ? xs.filter((x) => x !== r.rule_id) : [...xs, r.rule_id])}
                    className={`cursor-pointer rounded border px-2 py-0.5 font-mono text-micro ${
                      fences.includes(r.rule_id) ? "border-holo/60 bg-holo/10 text-holo" : "border-line text-ink3 hover:border-holo/40"
                    }`}
                    title={r.name}
                  >
                    {r.rule_id}
                  </button>
                ))}
              </div>
            </div>
            {error && <BannerAlert level="alert">{error}</BannerAlert>}
            <div className="flex gap-2.5">
              {!created ? (
                <>
                  <button
                    type="button"
                    disabled={!valid || busy || !canManage}
                    onClick={() => void doForge()}
                    className="cursor-pointer rounded-md gold-grad px-4 py-2 text-body font-bold text-ongold disabled:opacity-40"
                  >
                    ✓ 确认创建（进版本管理 v1）
                  </button>
                  <button
                    type="button"
                    onClick={() => nav("/p6")}
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
                    🧪 dry-run 预览（回放最近 10 条 F2.5）
                  </button>
                  <button
                    type="button"
                    disabled={busy || !dryReport}
                    onClick={() => void doInstall()}
                    title={dryReport ? "" : "生效前须先 dry-run（F8.3）"}
                    className="cursor-pointer rounded-md border border-go/50 px-4 py-2 text-body font-bold text-go disabled:opacity-40"
                  >
                    ⚙ 安装到本工作区
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-line bg-card p-3">
              <div className="mb-1.5 text-caption font-bold text-ink2">装备草稿预览 · SKILL.md</div>
              <pre className="whitespace-pre-wrap rounded-lg border border-line bg-bg900 p-3 font-mono text-micro leading-relaxed text-ink2">{preview}</pre>
              <div className="mt-2 text-micro leading-relaxed text-ink3">
                确认创建 → 装备 v1 进版本管理 · 绑定围栏随安装生效、卸载即撤销（F8.2/L8.3）· 生产环境仅签名白名单（L8.2）
              </div>
            </div>
            {created && (
              <div className="rounded-lg border border-go/40 bg-go/5 p-3">
                <div className="text-caption font-bold text-go">✓ 已创建 {created.skillId} v{created.version}（团队技能 · 进版本管理 F8.3）</div>
                {dryReport && (
                  <div className="mt-2 text-micro text-ink2">
                    dry-run 回放 {dryReport.replayed} 条：
                    {dryReport.perRule.length > 0 ? dryReport.perRule.map((r) => (
                      <div key={r.ruleId} className="mt-1 font-mono">
                        {r.ruleId}（{r.version}）：pass {r.pass} / review {r.wouldReview} / block {r.wouldBlock}
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
