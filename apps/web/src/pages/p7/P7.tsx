/**
 * P7 舰船换装坞（F11：行业装配台 · 皮肤+通讯录+群规，底座特有；PRD P7-①②③④⑤ 逐条对账）
 *  - P7E1 六槽位卡：档案 Schema/对象阶段/工具集/围栏包/Agent 班组/工作台 UI，逐卡显装配状态
 *    （底座代码零改动；行业 Bundle = npm 包 §2.3；围栏包→P5、班组→P8 回链）
 *  - P7E2 Agent 班组卡：preset 清单与围栏绑定校验状态；未声明 fence_bindings 即系统级禁写（F2.10）；点击 →P8
 *  - P7E3 起飞前检查单：档案 forbidden/枚举冲突/工具探针/围栏绑定完整/UI 用例同步；
 *    bundle 变更自动运行（活算），任一失败拒绝激活（F2.10）；校验留痕 bundle.check_run；修复后重跑
 *  - P7E4 围栏包卡 → P5 航道管制台（基线单调守卫 L2.1）
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
import { BannerAlert, EmptyState, SkeletonBlock } from "../../components/hud";

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

const SLOT_ICON: Record<string, string> = {
  archive: "📁", enums: "🧭", tools: "🔧", fences: "🛡", presets: "👥", ui: "🎨",
};

export default function P7() {
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState("owner");
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [data, setData] = useState<StatusResp | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardErr, setWizardErr] = useState("");
  const [draft, setDraft] = useState({
    slug: "", displayName: "", version: "0.1.0", changelog: "",
    fenceRef: "ai-video-baseline/v1", ownerMemberNo: "MEM-V01",
  });

  const load = useCallback(async (silent = false, slug?: string | null) => {
    if (!silent) setReady(false);
    try {
      await ensureDemoLogin();
      const [meR, mem, st] = await Promise.all([
        trpc.members.me.query() as Promise<{ identity: { role: string } }>,
        trpc.members.list.query() as Promise<MemberRow[]>,
        trpc.bundles.status.query(slug ? { slug } : {}) as Promise<StatusResp>,
      ]);
      setRole(meR.identity.role);
      setMembers(mem);
      setData(st);
      if (!slug) setSelectedSlug(st.selected?.slug ?? st.activeSlug);
    } catch (e) {
      setBanner({ level: "alert", text: `装配投影加载失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const canManage = role === "owner" || role === "manager"; // E2.6：readonly 无「新建/激活」入口（隐藏非置灰）
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
      setBanner({ level: "info", text: `校验已重跑并留痕 ${r.eventId}（P7E3 记录可查）` });
    } catch (e) {
      setBanner({ level: "alert", text: `校验重跑失败：${e instanceof Error ? e.message : String(e)}` });
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
      setBanner({ level: "info", text: `profile「${slug}」已激活——整套皮肤+通讯录+群规生效（§2.3，留痕 ${r.eventId}）` });
    } catch (e) {
      await load(true, slug);
      setBanner({ level: "alert", text: `拒绝激活：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [load]);

  /** 五要素向导提交（P7E5/§2.3：草稿不进分发） */
  const submitDraft = useCallback(async () => {
    setBusy(true);
    setWizardErr("");
    try {
      const r = await trpc.bundles.createDraft.mutate(draft) as { eventId: string; slug: string };
      setWizardOpen(false);
      setBanner({ level: "info", text: `行业草稿「${draft.displayName}」已创建（草稿态不进分发 §2.3，留痕 ${r.eventId}）——填充五槽后过校验即可激活` });
      setDraft({ slug: "", displayName: "", version: "0.1.0", changelog: "", fenceRef: "ai-video-baseline/v1", ownerMemberNo: "MEM-V01" });
      await load(true, r.slug);
      setSelectedSlug(r.slug);
    } catch (e) {
      setWizardErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, load]);

  return (
    <Bridge
      left={
        <>
          <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">换装坞 · DOCK</div>
          {[
            ["#sec-profiles", "🛰 Profile 切换器", `${data?.profiles.length ?? 0} 套注册`],
            ["#sec-slots", "🧩 六装配槽", selected ? `${selected.filledCount}/6 已装配` : "—"],
            ["#sec-check", "🚀 起飞前检查单", selected ? (selected.canActivate ? "五项全绿" : `${failedChecks.length} 项失败`) : "—"],
            ["#sec-crew", "👥 Agent 班组", selected ? `${selected.agents.length} preset` : "—"],
          ].map(([href, label, meta]) => (
            <a key={href} href={href} className="mb-1.5 block rounded-lg border border-line bg-card px-3 py-2.5 hover:border-gline">
              <div className="text-body text-ink2">{label}</div>
              <div className="mt-0.5 text-micro text-ink3">{meta}</div>
            </a>
          ))}
        </>
      }
      right={
        <>
          <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">平台化证明 · PROOF</div>
          <div className="rounded-lg border border-line bg-card p-3 text-caption leading-relaxed text-ink2">
            第三行业落地 = 填五要素 + 过校验，底座代码零改动（§2.3/§2.4）。换行业 = 换一套成员、群规与皮肤。
          </div>
          <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-caption leading-relaxed text-ink3">
            <div className="mb-1 text-micro font-bold text-ink2">装配纪律</div>
            任一校验失败拒绝激活（F2.10）<br />
            校验/激活/切换全部事件化（P7-⑤）<br />
            草稿态不进入分发（§2.3）<br />
            基线围栏单调守卫（L2.1）
          </div>
          {selected && (
            <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-caption text-ink3">
              <div className="mb-1 text-micro font-bold text-ink2">最近校验</div>
              <span className="font-mono text-micro">{new Date(selected.checkedAt).toLocaleTimeString("zh-CN")}</span>
              <span className={selected.canActivate ? " text-go" : " text-alert"}>
                {selected.canActivate ? " · 五项全绿 ✓" : ` · ${failedChecks.length} 项待修复 ✗`}
              </span>
            </div>
          )}
        </>
      }
    >
      <div className="px-1">
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-[20px] font-black text-ink">舰船换装坞</h2>
          <span className="text-caption text-ink3">行业装配台 · 换行业=换成员/群规/皮肤</span>
          <span className="font-mono text-micro text-ink3">§2.2 · F2.10</span>
        </div>

        {banner && <div className="mb-3"><BannerAlert level={banner.level}>{banner.text}</BannerAlert></div>}

        {!ready || !data ? (
          <SkeletonBlock lines={5} h={72} /> /* 加载态 G10：槽位卡骨架屏 */
        ) : !selected ? (
          <EmptyState icon="🛰" title="注册表为空" hint="bundles/ 下没有可用行业包——用下方向导创建第一套行业草稿（§2.3）" />
        ) : (
          <>
            {/* infobar（原型口径）：当前 profile · 装配计数 · 底座零改动 */}
            <div className="mb-4 rounded-lg border border-line bg-card px-3.5 py-2.5 text-caption text-ink2">
              🚀 当前 profile：<b className="font-mono text-holo">hyperreality-{data.activeSlug}</b>
              {" "}· 装配 <b className="text-goldhi">{data.profiles.find((p) => p.slug === data.activeSlug)?.filledCount ?? 0}/6</b>
              {" "}· 底座代码零改动（Bundle = npm 包 §2.3）
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
                    <span className="font-mono">hyperreality-{p.slug}</span>
                    {p.status === "active" && <span className="rounded border border-go/50 px-1 py-px text-micro text-go">当前</span>}
                    {p.status === "draft" && <span className="rounded border border-[#CD8B5A]/50 px-1 py-px text-micro text-[#CD8B5A]">草稿 · 不进分发</span>}
                    {!p.canActivate && <span className="rounded border border-alert/50 px-1 py-px text-micro text-alert">校验未过</span>}
                  </div>
                  <div className="mt-0.5 text-micro text-ink3">{p.displayName} · v{p.version} · 装配 {p.filledCount}/6</div>
                </button>
              ))}
              {canManage && !wizardOpen && (
                <button
                  type="button"
                  onClick={() => setWizardOpen(true)}
                  className="cursor-pointer rounded-lg border border-dashed border-gline px-3 py-2 text-body text-goldhi hover:border-gold/60"
                >
                  ＋ 新建行业 Bundle<span className="ml-1 text-micro text-ink3">五要素向导 §2.3</span>
                </button>
              )}
            </div>

            {/* P7E5 BundleWizard：五要素（档案/枚举/工具/围栏包/班组骨架 + 名称/版本/变更/围栏/负责人） */}
            {wizardOpen && canManage && (
              <div className="mb-4 rounded-xl border border-gold/40 bg-card p-4">
                <div className="mb-2 text-body font-bold text-goldhi">新建行业 Bundle · 五要素向导（§2.3）</div>
                <div className="mb-3 text-caption text-ink3">产出五槽骨架（档案/枚举/工具/围栏包/班组）+ bundle.json；<b>草稿态不进入分发</b>，五项校验全绿后才可激活（F2.10）。</div>
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="text-caption text-ink3">行业标识（slug）
                    <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                      placeholder="如 retail" className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-body text-ink outline-none focus:border-gline" />
                  </label>
                  <label className="text-caption text-ink3">显示名
                    <input value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                      placeholder="如 HyperReality for MCN" className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-body text-ink outline-none focus:border-gline" />
                  </label>
                  <label className="text-caption text-ink3">版本
                    <input value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })}
                      className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-body text-ink outline-none focus:border-gline" />
                  </label>
                  <label className="text-caption text-ink3">继承围栏包
                    <input value={draft.fenceRef} onChange={(e) => setDraft({ ...draft, fenceRef: e.target.value })}
                      className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-body text-ink outline-none focus:border-gline" />
                  </label>
                  <label className="text-caption text-ink3">负责人
                    <select value={draft.ownerMemberNo} onChange={(e) => setDraft({ ...draft, ownerMemberNo: e.target.value })}
                      className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-body text-ink outline-none focus:border-gline">
                      {members.map((m) => <option key={m.memberNo} value={m.memberNo}>{m.name}（{m.role}）</option>)}
                    </select>
                  </label>
                  <label className="text-caption text-ink3">变更日志
                    <input value={draft.changelog} onChange={(e) => setDraft({ ...draft, changelog: e.target.value })}
                      placeholder="首版草稿：五槽待填充" className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-body text-ink outline-none focus:border-gline" />
                  </label>
                </div>
                {wizardErr && <div className="mt-2 rounded border border-alert/50 bg-alert/8 px-2 py-1 text-micro text-alert">✗ {wizardErr}</div>}
                <div className="mt-3 flex gap-2">
                  <button type="button" disabled={busy || !draft.slug || !draft.displayName || !draft.changelog}
                    onClick={() => void submitDraft()}
                    className="cursor-pointer rounded-md gold-grad px-3.5 py-1.5 text-caption font-black text-ongold disabled:opacity-40">
                    创建草稿（不进分发）
                  </button>
                  <button type="button" onClick={() => { setWizardOpen(false); setWizardErr(""); }}
                    className="cursor-pointer rounded-md border border-line px-3.5 py-1.5 text-caption text-ink3 hover:border-gline">
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* p7_fail：红条（不静默 L9.2） */}
            {isFail && (
              <div className="mb-4">
                <BannerAlert level="alert">
                  🚫 <b>装配校验未通过，已拒绝激活</b>（不静默失败 L9.2）：
                  {failedChecks.map((c) => c.label).join("、")} · 修复后自动重跑
                </BannerAlert>
              </div>
            )}

            {/* P7E1 六槽位卡 */}
            <div id="sec-slots" className="grid grid-cols-3 gap-2.5">
              {selected.slots.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => s.go && nav(s.go === "p5" ? "/p5" : "/p8")}
                  className={`relative rounded-xl border p-3 text-left transition ${
                    s.failed ? "border-alert/60 bg-alert/5"
                      : s.filled ? "border-go/35 bg-card hover:border-go/60"
                        : "border-dashed border-line bg-card/60"
                  } ${s.go ? "cursor-pointer" : "cursor-default"}`}
                >
                  <span className={`absolute right-2.5 top-2.5 rounded border px-1 py-px text-micro ${
                    s.failed ? "border-alert/50 text-alert" : s.filled ? "border-go/50 text-go" : "border-line text-ink3"
                  }`}>
                    {s.failed ? "✗ 校验失败" : s.filled ? "✓ 已装配" : "待填充"}
                  </span>
                  <div className="mb-1.5 text-[22px]">{SLOT_ICON[s.id] ?? "🧩"}</div>
                  <h4 className="text-body font-bold text-ink2">{s.label}</h4>
                  <p className={`mt-1 text-micro leading-relaxed ${s.failed ? "text-alert" : "text-ink3"}`}>{s.summary}</p>
                  {s.go && <p className="mt-1 text-micro text-holo">{s.go === "p5" ? "→ P5 航道管制台" : "→ P8 船员名册"}</p>}
                </button>
              ))}
            </div>

            {/* P7E3 起飞前检查单 */}
            <div id="sec-check" className={`mt-4 rounded-xl border p-4 ${isFail ? "border-alert/50" : "border-line"} bg-card`}>
              <div className="flex items-center justify-between">
                <div className="text-body font-bold text-ink2">
                  起飞前检查单 · 装配校验
                  <span className="ml-2 text-micro font-normal text-ink3">bundle 变更自动运行 · 任一失败拒绝激活（F2.10）</span>
                </div>
                <button type="button" disabled={busy} onClick={() => void recheck()}
                  className="cursor-pointer rounded-md border border-gline px-2.5 py-1 text-caption text-goldhi hover:border-gold/60 disabled:opacity-40">
                  ↻ 重跑校验
                </button>
              </div>
              <div className="mt-3 grid grid-cols-5 gap-2.5">
                {selected.checks.map((c) => (
                  <div key={c.key} title={c.detail}
                    className={`rounded-xl border px-2 py-2.5 text-center text-micro ${
                      c.ok ? "border-go/35 text-go" : "border-alert/60 bg-alert/8 text-alert"
                    }`}>
                    <div className="text-[15px]">{c.ok ? "✓" : "✗"}</div>
                    {c.label}
                  </div>
                ))}
              </div>
              <div className="mt-2.5 space-y-1">
                {selected.checks.map((c) => (
                  <div key={c.key} className="flex gap-2 text-micro leading-relaxed">
                    <span className={c.ok ? "text-go" : "text-alert"}>{c.ok ? "✓" : "✗"}</span>
                    <span className="text-ink3">{c.label}：</span>
                    <span className={c.ok ? "text-ink2" : "text-alert"}>{c.detail}</span>
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
                    <div className="text-caption">
                      <div className="text-ink2"><b>{c.label}</b>：{c.detail}</div>
                      {c.fix && <div className="mt-0.5 text-ink3">修复指引：{c.fix}{c.slot ? `（回链槽位 ${c.slot}）` : ""}</div>}
                    </div>
                  </div>
                ))}
                <div className="mt-3">
                  <button type="button" disabled={busy} onClick={() => void recheck()}
                    className="cursor-pointer rounded-md gold-grad px-4 py-2 text-caption font-black text-ongold disabled:opacity-40">
                    ↻ 修复并重跑校验
                  </button>
                </div>
              </div>
            )}

            {/* P7E2 Agent 班组卡：preset 清单与围栏绑定校验状态；点击 →P8 */}
            <div id="sec-crew" className="mt-4 rounded-xl border border-line bg-card p-4">
              <div className="mb-2.5 text-body font-bold text-ink2">
                Agent 班组 · preset 清单
                <span className="ml-2 text-micro font-normal text-ink3">未声明 fence_bindings 即系统级禁写（F2.10）· 点击进 P8 通讯录</span>
              </div>
              {selected.agents.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-caption text-ink3">
                  班组待填充（空态 §2.3：新行业草稿 → 填充 presets/*.yml 并注册实例）
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {selected.agents.map((a) => (
                    <button key={a.id} type="button" onClick={() => nav(`/p8/agent/${a.id}`)}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-bg/60 px-3 py-2 text-left hover:border-gline">
                      <span className={`inline-block h-2 w-2 rounded-full ${a.fenceOk && a.status === "ready" ? "bg-go" : "bg-alert"}`} />
                      <div className="flex-1">
                        <div className="text-caption font-bold text-ink2">
                          {a.name} <span className="font-mono text-micro text-ink3">{a.version}</span>
                          {a.readonly && <span className="ml-1 rounded border border-line px-1 text-micro text-ink3">只读 L9.1</span>}
                        </div>
                        <div className="mt-0.5 text-micro text-ink3">
                          {a.presetKey} · {a.readonly ? "只读 preset 豁免绑定" : a.fenceBindings.length > 0 ? `围栏 ${a.fenceBindings.join("/")}` : "未声明围栏"}
                          {" "}{a.fenceOk ? <span className="text-go">✓</span> : <span className="text-alert">✗ 禁写</span>}
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
                <div className="flex-1 text-caption text-ink3">
                  {selected.status === "draft"
                    ? "草稿态：填充五槽 → 校验全绿 → 方可激活（草稿不进分发 §2.3）"
                    : "激活=整套皮肤+通讯录+群规生效，留痕 bundle.activate（§2.3）"}
                </div>
                <button type="button" disabled={busy || !selected.canActivate}
                  onClick={() => void activate(selected.slug)}
                  title={selected.canActivate ? "" : "F2.10：校验未全绿，拒绝激活"}
                  className="cursor-pointer rounded-md gold-grad px-4 py-2 text-caption font-black text-ongold disabled:cursor-not-allowed disabled:opacity-40">
                  🚀 激活 hyperreality-{selected.slug}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Bridge>
  );
}
