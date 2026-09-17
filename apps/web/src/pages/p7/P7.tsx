/**
 * P7 装配中心（F11：行业装配台 · 皮肤+通讯录+群规，底座特有；PRD P7-①②③④⑤ 逐条对账）
 *  - P7E1 六槽位卡：档案 Schema/对象阶段/工具集/围栏包/Agent 班组/工作台 UI，逐卡显装配状态
 *    （底座代码零改动；行业 Bundle = npm 包 §2.3；围栏包→P5、班组→P8 回链）
 *  - P7E2 Agent 班组卡：preset 清单与围栏绑定校验状态；未声明 fence_bindings 即系统级禁写（F2.10）；点击 →P8
 *  - P7E3 起飞前检查单：档案 forbidden/枚举冲突/工具探针/围栏绑定完整/UI 用例同步；
 *    bundle 变更自动运行（活算），任一失败拒绝激活（F2.10）；校验留痕 bundle.check_run；修复后重跑
 *  - P7E4 围栏包卡 → P5 规则与权限（基线单调守卫 L2.1）
 *  - P7E5 新建行业 Bundle 五要素向导（§2.3：草稿态不进入分发）
 * 状态变体：p7 默认 / p7_fail 校验失败（红条+失败槽位标红+修复清单）；加载骨架 G10；
 *   空态=新行业草稿槽位待填充计数（§2.3）；权限态=readonly 无「新建/激活」入口（E2.6 隐藏非置灰，服务端 403）；
 *   完成后态=激活成功 profile 可切换，事件 bundle.activate 留痕（§2.3）
 * 数据来源：bundles router（status=注册表实物投影/recheck/activate/createDraft）
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert, EmptyState, Skeleton } from "../../components/hud";
import { MEMBER_ROLE_TEXT, actorText, dictText, shortId, versionText } from "../../lib/display";
import { Button, Icon, Overlay, clientChineseText, type IconName } from "@workloom/ui";
import { useNavigationAccess } from "../../shell/NavigationAccess";

interface SlotState { id: string; label: string; filled: boolean; failed: boolean; summary: string; go?: "p5" | "p8" }
interface CheckItem { key: string; label: string; ok: boolean; detail: string; fix?: string; slot?: string }
interface BundleAgentRow {
  id: string; presetKey: string; name: string; version: string; status: string;
  readonly: boolean; fenceBindings: string[]; fenceOk: boolean;
}
interface BundleProfile {
  slug: string; name: string; displayName: string; version: string; description: string;
  status: "active" | "available" | "draft";
  slots: SlotState[]; filledCount: number; checks: CheckItem[]; canActivate: boolean;
  agents: BundleAgentRow[]; checkedAt: string;
}
interface StatusResp { activeSlug: string; profiles: BundleProfile[]; selected: BundleProfile | null }
interface MemberRow { id: string; memberNo: string; name: string; role: string }

const SLOT_ICON: Record<string, IconName> = {
  archive: "folder", enums: "configuration", tools: "customize", fences: "rules", presets: "team", ui: "palette",
};

export default function P7() {
  const { canAction, subject } = useNavigationAccess();
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [data, setData] = useState<StatusResp | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardErr, setWizardErr] = useState("");
  const [draft, setDraft] = useState({
    slug: "", displayName: "", version: "0.1.0", changelog: "",
    fenceRef: "base-governance/v1", ownerMemberNo: "", // 打开向导时以当前登录身份填充
  });

  const load = useCallback(async (silent = false, slug?: string | null) => {
    if (!silent) setReady(false);
    try {
      await ensureDemoLogin();
      const [mem, st] = await Promise.all([
        trpc.members.list.query() as Promise<MemberRow[]>,
        trpc.bundles.status.query(slug ? { slug } : {}) as Promise<StatusResp>,
      ]);
      setMembers(mem);
      setData(st);
      if (subject?.memberNo) setDraft((d) => (d.ownerMemberNo ? d : { ...d, ownerMemberNo: subject.memberNo! }));
      if (!slug) setSelectedSlug(st.selected?.slug ?? st.activeSlug);
    } catch (e) {
      console.warn("装配信息加载失败", e);
      setBanner({ level: "alert", text: "装配信息暂时无法加载，请稍后重试。" });
    } finally {
      setReady(true);
    }
  }, [subject?.memberNo]);

  useEffect(() => { void load(); }, [load]);

  const canManage = canAction("bundle.manage"); // 动作能力完全取自服务端权威授权
  const selected = data?.selected ?? null;
  const failedChecks = selected?.checks.filter((c) => !c.ok) ?? [];
  const isFail = failedChecks.length > 0; // p7_fail 状态变体

  const selectProfile = useCallback(async (slug: string) => {
    setSelectedSlug(slug);
    setBanner(null);
    await load(true, slug);
  }, [load]);

  /** 重跑校验并留痕（P7E3：修复后重跑；bundle.check_run 事件可查） */
  const recheck = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await trpc.bundles.recheck.mutate({ slug: selected.slug }) as { eventId: string };
      await load(true, selected.slug);
      setBanner({ level: "info", text: `校验已重新运行，并写入事件账本。账本凭证 ${shortId(r.eventId)}。` });
    } catch (e) {
      console.warn("装配校验重跑失败", e);
      setBanner({ level: "alert", text: "暂时无法重新校验；当前装配状态没有改变，请稍后重试。" });
    } finally {
      setBusy(false);
    }
  }, [selected, load]);

  /** 激活/切换 profile（F2.10：任一失败拒绝激活——服务端 PRECONDITION_FAILED，不静默 L9.2） */
  const activate = useCallback(async (slug: string) => {
    setBusy(true);
    try {
      const r = await trpc.bundles.activate.mutate({ slug }) as { eventId: string };
      await load(true, slug);
      const profileName = clientChineseText(data?.profiles.find((profile) => profile.slug === slug)?.displayName, "所选行业方案");
      setBanner({ level: "info", text: `「${profileName}」已激活；主题、通讯录和协作规则已同步生效。账本凭证 ${shortId(r.eventId)}。` });
    } catch (e) {
      await load(true, slug);
      console.warn("行业方案激活失败", e);
      setBanner({ level: "alert", text: "激活被拒绝：至少一项装配校验未通过，请按修复清单处理后重试。" });
    } finally {
      setBusy(false);
    }
  }, [data?.profiles, load]);

  /** 五要素向导提交（P7E5/§2.3：草稿不进分发） */
  const submitDraft = useCallback(async () => {
    setBusy(true);
    setWizardErr("");
    try {
      const r = await trpc.bundles.createDraft.mutate(draft) as { eventId: string; slug: string };
      setWizardOpen(false);
      setBanner({ level: "info", text: `行业草稿「${draft.displayName}」已创建；草稿不会进入分发，补齐装配项并通过校验后才可激活。账本凭证 ${shortId(r.eventId)}。` });
      setDraft({ slug: "", displayName: "", version: "0.1.0", changelog: "", fenceRef: "base-governance/v1", ownerMemberNo: "" });
      await load(true, r.slug);
      setSelectedSlug(r.slug);
    } catch (e) {
      console.warn("创建行业草稿失败", e);
      setWizardErr("创建失败，请检查必填内容、短标识格式和账号权限后重试。");
    } finally {
      setBusy(false);
    }
  }, [draft, load]);

  return (
    <Bridge
      left={
        <>
          <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">装配导航</div>
          {([
            { href: "#sec-profiles", icon: "radar", label: "行业方案切换", meta: `${data?.profiles.length ?? 0} 套注册` },
            { href: "#sec-slots", icon: "puzzle", label: "六装配槽", meta: selected ? `${selected.filledCount}/6 已装配` : "—" },
            { href: "#sec-check", icon: "rocket", label: "起飞前检查单", meta: selected ? (selected.canActivate ? "五项全绿" : `${failedChecks.length} 项失败`) : "—" },
            { href: "#sec-crew", icon: "team", label: "数字员工班组", meta: selected ? `${selected.agents.length} 个岗位` : "—" },
          ] as Array<{ href: string; icon: IconName; label: string; meta: string }>).map(({ href, icon, label, meta }) => (
            <a key={href} href={href} className="mb-1.5 block rounded-lg border border-line bg-card px-3 py-2.5 hover:border-gline">
              <div className="flex items-center gap-1.5 text-body text-ink2"><Icon name={icon} size={14} />{label}</div>
              <div className="mt-0.5 text-body text-ink3">{meta}</div>
            </a>
          ))}
        </>
      }
      right={
        <>
          <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">平台化能力</div>
          <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
            新行业只需填写五类配置并通过校验，无需修改基座代码。切换行业会同步切换成员、协作规则与主题。
          </div>
          <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink3">
            <div className="mb-1 text-body font-bold text-ink2">装配纪律</div>
            任一校验失败都会拒绝激活<br />
            校验、激活和切换全部写入事件账本<br />
            草稿不会进入分发<br />
            行业围栏只能在基座围栏上加严
          </div>
          {selected && (
            <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-body text-ink3">
              <div className="mb-1 text-body font-bold text-ink2">最近校验</div>
              <span className="font-mono text-body">{new Date(selected.checkedAt).toLocaleTimeString("zh-CN")}</span>
              <span className={`inline-flex items-center gap-1 ${selected.canActivate ? " text-go" : " text-alert"}`}>
                · {selected.canActivate ? <>五项全绿 <Icon name="check" size={13} /></> : <>{failedChecks.length} 项待修复 <Icon name="error" size={13} /></>}
              </span>
            </div>
          )}
        </>
      }
    >
      <div className="px-1">
        <div className="mb-4 flex flex-wrap items-baseline gap-3">
          <h2 className="text-[20px] font-black text-ink">装配中心</h2>
          <span className="text-body text-ink3">切换行业方案即可同步切换成员、协作规则与主题</span>
        </div>

        {banner && <div className="mb-3"><BannerAlert level={banner.level}>{banner.text}</BannerAlert></div>}

        {!ready || !data ? (
          <Skeleton count={5} height={72} label="行业方案正在加载" /> /* 加载态 G10：槽位卡骨架屏 */
        ) : !selected ? (
          <EmptyState icon={<Icon name="assembly" size={24} />} title="暂无行业方案" hint="当前还没有可用行业包，请创建第一套行业草稿。" />
        ) : (
          <>
            {/* infobar（原型口径）：当前 profile · 装配计数 · 底座零改动 */}
            <div className="mb-4 rounded-lg border border-line bg-card px-3.5 py-2.5 text-body text-ink2">
              <Icon name="rocket" size={14} className="inline" /> 当前行业方案：<b className="text-holo">{clientChineseText(data.profiles.find((profile) => profile.slug === data.activeSlug)?.displayName, "名称待补充")}</b>
              {" "}· 装配 <b className="text-goldhi">{data.profiles.find((p) => p.slug === data.activeSlug)?.filledCount ?? 0}/6</b>
              {" "}· 基座代码无需修改
            </div>

            {/* ProfileSwitcher（P7-④：当前高亮；切换=整套皮肤+通讯录+群规生效，留痕） */}
            <div id="sec-profiles" className="mb-4 flex flex-wrap gap-2">
              {data.profiles.map((p) => (
                <button
                  key={p.slug}
                  type="button"
                  onClick={() => void selectProfile(p.slug)}
                  className={`cursor-pointer rounded-lg border px-3 py-2 text-left transition ${
                    p.slug === selected.slug ? "border-gold/60 bg-gold/8" : "border-line bg-card hover:border-gline"
                  }`}
                >
                  <div className="flex items-center gap-2 text-body font-bold text-ink2">
                    <span>{clientChineseText(p.displayName, "名称待补充")}</span>
                    {p.status === "active" && <span className="rounded border border-go/50 px-1 py-px text-body text-go">当前</span>}
                    {p.status === "draft" && <span className="rounded border border-[#a8b2be]/50 px-1 py-px text-body text-[#a8b2be]">草稿 · 不进分发</span>}
                    {!p.canActivate && <span className="rounded border border-alert/50 px-1 py-px text-body text-alert">校验未过</span>}
                  </div>
                  <div className="mt-0.5 text-body text-ink3">{clientChineseText(p.displayName, "名称待补充")} · {versionText(p.version)} · 装配 {p.filledCount}/6</div>
                </button>
              ))}
              {canManage && !wizardOpen && (
                <button
                  type="button"
                  onClick={() => setWizardOpen(true)}
                  className="cursor-pointer rounded-lg border border-dashed border-gline px-3 py-2 text-body text-goldhi hover:border-gold/60"
                >
                  <span className="inline-flex items-center gap-1"><Icon name="partner" size={15} aria-hidden="true" />新建行业包</span><span className="ml-1 text-body text-ink3">五要素向导</span>
                </button>
              )}
            </div>

            {/* P7E5 BundleWizard：五要素（档案/枚举/工具/围栏包/班组骨架 + 名称/版本/变更/围栏/负责人） */}
            {wizardOpen && canManage && (
              <Overlay
                open
                title="新建行业包"
                description="填写五类基础信息。草稿不会进入分发，全部校验通过后才可激活。"
                onClose={() => { if (!busy) { setWizardOpen(false); setWizardErr(""); } }}
                dismissOnBackdrop={!busy}
                dismissOnEscape={!busy}
                footer={(
                  <>
                    <Button variant="primary" busy={busy} disabled={!draft.slug || !draft.displayName || !draft.changelog} onClick={() => void submitDraft()}>
                      创建草稿
                    </Button>
                    <Button disabled={busy} onClick={() => { setWizardOpen(false); setWizardErr(""); }}>取消</Button>
                  </>
                )}
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="text-body text-ink3">行业短标识
                    <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                      placeholder="例如：retail（仅支持小写字母、数字和连字符）" className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-body text-ink outline-none focus:border-gline" />
                  </label>
                  <label className="text-body text-ink3">显示名
                    <input value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                      placeholder="例如：零售经营系统" className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-body text-ink outline-none focus:border-gline" />
                  </label>
                  <label className="text-body text-ink3">版本
                    <input value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })}
                      className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-body text-ink outline-none focus:border-gline" />
                  </label>
                  <label className="text-body text-ink3">继承围栏方案
                    <select value={draft.fenceRef} onChange={(e) => setDraft({ ...draft, fenceRef: e.target.value })}
                      className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-body text-ink outline-none focus:border-gline">
                      <option value="base-governance/v1">基座通用治理围栏</option>
                    </select>
                  </label>
                  <label className="text-body text-ink3">负责人
                    <select value={draft.ownerMemberNo} onChange={(e) => setDraft({ ...draft, ownerMemberNo: e.target.value })}
                      className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-body text-ink outline-none focus:border-gline">
                      {members.map((m) => <option key={m.memberNo} value={m.memberNo}>{m.name}（{dictText(MEMBER_ROLE_TEXT, m.role)}）</option>)}
                    </select>
                  </label>
                  <label className="text-body text-ink3">变更日志
                    <input value={draft.changelog} onChange={(e) => setDraft({ ...draft, changelog: e.target.value })}
                      placeholder="首版草稿：五槽待填充" className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-body text-ink outline-none focus:border-gline" />
                  </label>
                </div>
                {wizardErr && <div className="mt-2 flex items-start gap-1 rounded border border-alert/50 bg-alert/8 px-2 py-1 text-body text-alert"><Icon name="error" size={13} className="mt-0.5 shrink-0" />{wizardErr}</div>}
              </Overlay>
            )}

            {/* p7_fail：红条（不静默 L9.2） */}
            {isFail && (
              <div className="mb-4">
                <BannerAlert level="alert">
                  <b>装配校验未通过，已拒绝激活</b>：
                  {failedChecks.map((c) => clientChineseText(c.label, "装配项")).join("、")} · 修复后请重新校验
                </BannerAlert>
              </div>
            )}

            {/* P7E1 六槽位卡 */}
            <div id="sec-slots" className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
              {selected.slots.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => s.go && nav(s.go === "p5" ? "/guardrails" : "/agents")}
                  className={`relative rounded-xl border p-3 text-left transition ${
                    s.failed ? "border-alert/60 bg-alert/5"
                      : s.filled ? "border-go/35 bg-card hover:border-go/60"
                        : "border-dashed border-line bg-card/60"
                  } ${s.go ? "cursor-pointer" : "cursor-default"}`}
                >
                  <span className={`absolute right-2.5 top-2.5 rounded border px-1 py-px text-body ${
                    s.failed ? "border-alert/50 text-alert" : s.filled ? "border-go/50 text-go" : "border-line text-ink3"
                  }`}>
                    {s.failed ? <><Icon name="error" size={12} className="inline" /> 校验失败</> : s.filled ? <><Icon name="check" size={12} className="inline" /> 已装配</> : "待填充"}
                  </span>
                  <Icon name={SLOT_ICON[s.id] ?? "puzzle"} size={22} className="mb-1.5" />
                  <h4 className="text-body font-bold text-ink2">{clientChineseText(s.label, "装配项")}</h4>
                  <p className={`mt-1 text-body leading-relaxed ${s.failed ? "text-alert" : "text-ink3"}`}>{clientChineseText(s.summary, s.filled ? "已完成装配" : "等待补充配置")}</p>
                  {s.go && <p className="mt-1 text-body text-holo">{s.go === "p5" ? "→ 前往规则与权限" : "→ 前往团队成员"}</p>}
                </button>
              ))}
            </div>

            {/* P7E3 起飞前检查单 */}
            <div id="sec-check" className={`mt-4 rounded-xl border p-4 ${isFail ? "border-alert/50" : "border-line"} bg-card`}>
              <div className="flex items-center justify-between">
                <div className="text-body font-bold text-ink2">
                  起飞前检查单 · 装配校验
                  <span className="ml-2 text-body font-normal text-ink3">行业包变更后自动运行 · 任一失败都会拒绝激活</span>
                </div>
                <button type="button" disabled={busy} onClick={() => void recheck()}
                  className="cursor-pointer rounded-md border border-gline px-2.5 py-1 text-body text-goldhi hover:border-gold/60 disabled:opacity-40">
                  <Icon name="reset" size={13} className="inline" /> 重跑校验
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
                {selected.checks.map((c) => (
                  <div key={c.key} title={clientChineseText(c.detail, "查看下方校验详情")}
                    className={`rounded-xl border px-2 py-2.5 text-center text-body ${
                      c.ok ? "border-go/35 text-go" : "border-alert/60 bg-alert/8 text-alert"
                    }`}>
                    <Icon name={c.ok ? "check" : "error"} label={c.ok ? "校验通过" : "校验未通过"} size={15} className="mx-auto" />
                    {clientChineseText(c.label, "装配校验")}
                  </div>
                ))}
              </div>
              <div className="mt-2.5 space-y-1">
                {selected.checks.map((c) => (
                  <div key={c.key} className="flex gap-2 text-body leading-relaxed">
                    <Icon name={c.ok ? "check" : "error"} label={c.ok ? "校验通过" : "校验未通过"} size={13} className={c.ok ? "text-go" : "text-alert"} />
                    <span className="text-ink3">{clientChineseText(c.label, "装配校验")}：</span>
                    <span className={c.ok ? "text-ink2" : "text-alert"}>{clientChineseText(c.detail, c.ok ? "校验通过" : "校验未通过，请检查对应配置")}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* p7_fail FixList：存在即阻断激活；修复项回链槽位 */}
            {isFail && (
              <div className="mt-4 rounded-xl border border-alert/50 bg-card p-4">
                <div className="mb-2 text-body font-bold text-[#FFB9C6]">修复清单（存在即阻断激活）</div>
                {failedChecks.map((c) => (
                  <div key={c.key} className="mb-1.5 flex items-start gap-2.5 rounded-lg border border-alert/30 bg-alert/5 px-3 py-2">
                    <span className="mt-0.5 inline-block h-2 w-2 rounded-full bg-alert" />
                    <div className="text-body">
                      <div className="text-ink2"><b>{clientChineseText(c.label, "装配校验")}</b>：{clientChineseText(c.detail, "校验未通过，请检查对应配置")}</div>
                      {c.fix && <div className="mt-0.5 text-ink3">修复指引：{clientChineseText(c.fix, "请补齐或修正对应配置")}</div>}
                    </div>
                  </div>
                ))}
                <div className="mt-3">
                  <button type="button" disabled={busy} onClick={() => void recheck()}
                    className="cursor-pointer rounded-md gold-grad px-4 py-2 text-body font-black text-ongold disabled:opacity-40">
                    <Icon name="reset" size={13} className="inline" /> 修复并重跑校验
                  </button>
                </div>
              </div>
            )}

            {/* P7E2 Agent 班组卡：preset 清单与围栏绑定校验状态；点击 →P8 */}
            <div id="sec-crew" className="mt-4 rounded-xl border border-line bg-card p-4">
              <div className="mb-2.5 text-body font-bold text-ink2">
                数字员工班组 · 岗位清单
                <span className="ml-2 text-body font-normal text-ink3">未声明关联围栏的写操作会被系统阻断 · 点击查看成员档案</span>
              </div>
              {selected.agents.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-body text-ink3">
                  班组待填充：请在行业草稿中添加岗位并完成注册
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {selected.agents.map((a) => (
                    <button key={a.id} type="button" onClick={() => nav(`/agents/${a.id}`)}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-bg/60 px-3 py-2 text-left hover:border-gline">
                      <span className={`inline-block h-2 w-2 rounded-full ${a.fenceOk && a.status === "ready" ? "bg-go" : "bg-alert"}`} />
                      <div className="flex-1">
                        <div className="text-body font-bold text-ink2">
                          {clientChineseText(a.name, actorText(a.presetKey))} <span className="text-body text-ink3">{versionText(a.version)}</span>
                          {a.readonly && <span className="ml-1 rounded border border-line px-1 text-body text-ink3">只读岗位</span>}
                        </div>
                        <div className="mt-0.5 text-body text-ink3">
                          {actorText(a.presetKey)} · {a.readonly ? "只读岗位无需写入围栏" : a.fenceBindings.length > 0 ? `已绑定 ${a.fenceBindings.length} 条围栏` : "未声明围栏"}
                          {" "}{a.fenceOk ? <Icon name="check" size={13} className="inline text-go" /> : <span className="inline-flex items-center gap-1 text-alert"><Icon name="error" size={13} />禁写</span>}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 激活操作区（完成后态：激活成功→profile 可切换） */}
            {canManage && selected.status !== "active" && (
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-3">
                <div className="flex-1 text-body text-ink3">
                  {selected.status === "draft"
                    ? "草稿状态：补齐装配项 → 全部校验通过 → 方可激活；草稿不会进入分发。"
                    : "激活后，整套主题、通讯录与协作规则会同步生效，并写入事件账本。"}
                </div>
                <button type="button" disabled={busy || !selected.canActivate}
                  onClick={() => void activate(selected.slug)}
                  title={selected.canActivate ? "" : "校验未全部通过，暂不能激活"}
                  className="cursor-pointer rounded-md gold-grad px-4 py-2 text-body font-black text-ongold disabled:cursor-not-allowed disabled:opacity-40">
                  <Icon name="rocket" size={15} className="inline" /> 激活「{clientChineseText(selected.displayName, "所选行业方案")}」
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Bridge>
  );
}
