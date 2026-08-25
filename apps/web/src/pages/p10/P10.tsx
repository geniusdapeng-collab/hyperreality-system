/**
 * P10 片库 · 渲染脚本 CMS（F12：video.cms/render 端点接线；fusion-design §6 逐条对账）
 *  - 脚本列表：按项目分组（script_key 链聚合）、状态 chip（draft/approved/submitted/rendering/done/failed）、版本链
 *  - MD 详情：工作台展示（getScript）+ contentEditable 本地编辑（§6 本地编辑纪律：保存即新版本，不原地改）
 *  - 保存为新版本（cms.saveScriptVersion：parent_version 链 + diff 摘要 + 字数校验快照 2470-3000 口径）
 *  - G8 审批（cms.approveScript：仅 draft 可审；版本即审批对象，approved 不继承）
 *  - 三档提交（render.submit mode=manual/batch/auto）：G8 烧额度门——review 级须先 approved，block 级 403
 *  - 无 VOLCENGINE_ARK_API_KEY 时服务端 mock 提交（task_id 前缀 mock-，返回 mock:true 明确标注上屏）
 * 状态变体：加载骨架 G10 / 空态（无脚本引导）/ 错误横幅（围栏拒绝原因展示）
 * 轮询口径（D6）：脚本列表 15s 静默刷新
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert, EmptyState, SkeletonBlock } from "../../components/hud";

interface ScriptRow {
  id: string; project_id: string; shot_id: string; script_key: string; version: number;
  parent_version: number | null; status: string; md: string;
  char_check: Record<string, unknown>; diff_summary: string | null;
  created_by: string; created_at: string;
}

/** 状态 chip 口径（语义四色 §2.2：青=进行中/信息，绿=已完成，琥珀=待审，红=失败，灰=草稿） */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "draft 草稿", cls: "border-line text-ink3" },
  approved: { label: "approved 已审批", cls: "border-go/45 text-go" },
  submitted: { label: "submitted 已提交", cls: "border-holo/45 text-holo" },
  rendering: { label: "rendering 渲染中", cls: "border-holo/45 text-holo" },
  done: { label: "done 已完成", cls: "border-go/45 text-go" },
  failed: { label: "failed 失败", cls: "border-alert/55 text-alert" },
};

/** 三档提交模式（§6：manual 手动单镜 / batch 整片批量 / auto 全自动连锁） */
const SUBMIT_MODES = [
  { key: "manual", label: "🖱 手动单镜", hint: "点「提交渲染」单镜即提交 Seedance（G8 烧额度门）" },
  { key: "batch", label: "📦 整片批量", hint: "整片各镜一次提交，渲染师轮询回填 render_jobs" },
  { key: "auto", label: "⚡ 自动连锁", hint: "render.done → 后期 → G9 发布 → 监控 全链路自动推进" },
] as const;
type SubmitMode = (typeof SUBMIT_MODES)[number]["key"];

/** 字数校验口径（PromptDeliveryGuard：2470-3000 字符区间） */
const CHAR_MIN = 2470;
const CHAR_MAX = 3000;

export default function P10() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? "vp-demo-001"; // 演示项目（种子口径；多项目经 ?project= 切换）

  const [ready, setReady] = useState(false);
  const [scripts, setScripts] = useState<ScriptRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScriptRow | null>(null);
  const [mode, setMode] = useState<SubmitMode>("manual");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const mdRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setReady(false);
    try {
      await ensureDemoLogin();
      const rows = await trpc.video.cms.listScripts.query({ projectId }) as unknown as ScriptRow[];
      setScripts(rows);
      setSelectedKey((cur) => cur ?? rows[rows.length - 1]?.script_key ?? null); // 缺省选最新一条链
    } catch (e) {
      setBanner({ level: "alert", text: `片库加载失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setReady(true);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  // 轮询口径（D6）：片库 15s 静默刷新
  useEffect(() => {
    const t = setInterval(() => void load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  /* ---------- 按 script_key 聚合成版本链（listByProject 已按 script_key, version 排序） ---------- */
  const chains = useMemo(() => {
    const m = new Map<string, ScriptRow[]>();
    for (const r of scripts) {
      const arr = m.get(r.script_key) ?? [];
      arr.push(r);
      m.set(r.script_key, arr);
    }
    return [...m.entries()].map(([key, versions]) => ({ key, versions, head: versions[versions.length - 1]! }));
  }, [scripts]);

  /* ---------- 选中链头 → getScript 拉详情（MD 正文 + 字段 JSON + 字符数校验快照） ---------- */
  const selectChain = useCallback(async (scriptKey: string) => {
    setSelectedKey(scriptKey);
    setDirty(false);
    setDetail(null);
    const head = scripts.filter((r) => r.script_key === scriptKey).sort((a, b) => b.version - a.version)[0];
    if (!head) return;
    try {
      const row = await trpc.video.cms.getScript.query({ scriptId: head.id }) as unknown as ScriptRow | null;
      setDetail(row);
    } catch (e) {
      setBanner({ level: "alert", text: `脚本详情加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }, [scripts]);

  useEffect(() => {
    if (selectedKey && scripts.length > 0) void selectChain(selectedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  /* ---------- 字数校验（2470-3000 口径快照，随 saveScriptVersion 入库） ---------- */
  const charCount = useMemo(() => (detail?.md ?? "").length, [detail]);
  const withinSpec = charCount >= CHAR_MIN && charCount <= CHAR_MAX;

  /** 保存即新版本（§6：parent_version 链 + diff 摘要；新版本回 draft，approved 不继承须重新过 G8） */
  const saveVersion = useCallback(async () => {
    if (!detail) return;
    const md = mdRef.current?.innerText ?? detail.md;
    setBusy("save");
    try {
      const r = await trpc.video.cms.saveScriptVersion.mutate({
        scriptKey: detail.script_key,
        md,
        charCheck: { charCount: md.length, withinSpec: md.length >= CHAR_MIN && md.length <= CHAR_MAX },
        diffSummary: "工作台手工编辑",
      }) as unknown as ScriptRow;
      setBanner({ level: "info", text: `已保存为 v${r.version}（parent v${r.parent_version}；回 draft 须重新过 G8，版本即审批对象）` });
      setDirty(false);
      await load(true);
      await selectChain(detail.script_key);
    } catch (e) {
      setBanner({ level: "alert", text: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [detail, load, selectChain]);

  /** G8 审批（仅 draft 可审；approvals 行随版本同一 COMMIT） */
  const approve = useCallback(async () => {
    if (!detail) return;
    setBusy("approve");
    try {
      await trpc.video.cms.approveScript.mutate({ scriptKey: detail.script_key, version: detail.version });
      setBanner({ level: "info", text: `G8 审批通过：${detail.script_key} v${detail.version} → approved（渲染提交烧额度门已开）` });
      await load(true);
      await selectChain(detail.script_key);
    } catch (e) {
      setBanner({ level: "alert", text: `审批失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [detail, load, selectChain]);

  /** 三档渲染提交（render.submit；review 级须 approved，block 级 403；无 ARK Key 走 mock 明确标注） */
  const submit = useCallback(async () => {
    if (!detail) return;
    setBusy("submit");
    try {
      const r = await trpc.video.render.submit.mutate({ scriptId: detail.id, mode }) as unknown as {
        jobId: string; taskId: string | null; mock: boolean; level: string;
      };
      setBanner({
        level: "info",
        text: `渲染已提交（${mode} 档）：render_job ${r.jobId}${r.mock ? ` · mock 回执 ${r.taskId}（无 VOLCENGINE_ARK_API_KEY，不触真实渲染不烧额度）` : ` · task ${r.taskId}`}`,
      });
      await load(true);
      await selectChain(detail.script_key);
    } catch (e) {
      setBanner({ level: "alert", text: `提交被围栏拦下：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }, [detail, mode, load, selectChain]);

  /* ---------- 左栏：项目分组脚本列表（状态 chip + 版本链） ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">片库 · LIBRARY</div>
      <div className="mb-1.5 rounded-lg border border-gline bg-gold/5 px-3 py-2.5">
        <div className="text-caption text-gold">星芒保温杯 · 抖音种草片</div>
        <div className="mt-0.5 font-mono text-micro text-ink3">{projectId} · 营销片管线</div>
      </div>
      {chains.map((c) => {
        const meta = STATUS_META[c.head.status] ?? STATUS_META.draft!;
        const active = c.key === selectedKey;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => void selectChain(c.key)}
            className={`mb-1.5 block w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left ${
              active ? "border-gline bg-gold/6" : "border-line bg-card hover:border-gline"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-ink3">{c.head.shot_id}</span>
              <span className={`rounded border px-1.5 py-0.5 text-micro ${meta.cls}`}>{meta.label}</span>
            </div>
            <div className="mt-1 text-body text-ink2">{c.key}</div>
            {/* 版本链（parent_version 链投影；当前=head） */}
            <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-micro text-ink3">
              {c.versions.map((v, i) => (
                <span key={v.id} className={v.version === c.head.version ? "text-goldhi" : ""}>
                  {i > 0 && "→ "}v{v.version}
                </span>
              ))}
            </div>
          </button>
        );
      })}
      {ready && chains.length === 0 && (
        <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-caption text-ink3">
          该项目还没有渲染脚本——提示词工程师交付后逐镜入 v1
        </div>
      )}
      <button
        type="button"
        onClick={() => nav("/")}
        className="mt-2 w-full cursor-pointer rounded-lg border border-line px-3 py-2 text-caption text-ink3 hover:border-holo/40 hover:text-ink2"
      >
        ← 返回工作台
      </button>
    </>
  );

  /* ---------- 右栏：提交纪律 + 围栏口径 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">提交纪律 · DISCIPLINE</div>
      <div className="rounded-lg border border-line bg-card p-3 text-caption leading-relaxed text-ink2">
        保存即新版本（parent_version 链，§6）；版本即审批对象——新版本的 approved 不继承，须重新过 G8。
      </div>
      <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-caption leading-relaxed text-ink3">
        <div className="mb-1 text-micro font-bold text-ink2">G8 烧额度门</div>
        block → 直接 403 熔断<br />
        review → 须先 cms.approveScript（approved）<br />
        auto → 信任后放行<br />
        无 VOLCENGINE_ARK_API_KEY → mock 提交（不烧额度，明确标注）
      </div>
      <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-caption text-ink3">
        <div className="mb-1 text-micro font-bold text-ink2">字数校验</div>
        口径 <b className="font-orb text-holo">{CHAR_MIN}–{CHAR_MAX}</b> 字符（PromptDeliveryGuard 快照随版本入库）
      </div>
      <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-caption text-ink3">
        <div className="mb-1 text-micro font-bold text-ink2">围栏基线</div>
        <span className="font-mono text-holo">ai-video-baseline/v1</span>
      </div>
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="px-1">
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-[20px] font-black text-ink">片库 · 渲染脚本 CMS</h2>
          <span className="text-caption text-ink3">每镜一脚本 · 版本链管理 · 三档提交</span>
          <span className="text-[11px] tracking-[.2em] text-ink3">P10 · SCRIPT CMS</span>
        </div>

        {banner && (
          <div className="mb-3">
            <BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>
              {banner.text}
            </BannerAlert>
          </div>
        )}

        {!ready ? (
          <SkeletonBlock lines={5} h={72} /> /* 加载态 G10 */
        ) : chains.length === 0 ? (
          <EmptyState icon="🎬" title="片库空空如也" hint="营销片管线走到预生产后，提示词工程师会逐镜交付渲染脚本（MD + 字段 JSON + 字数快照）" />
        ) : (
          <>
            {/* 三档提交切换（render.submit mode 参数） */}
            <div className="mb-3 flex flex-wrap gap-2">
              {SUBMIT_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => { setMode(m.key); setBanner({ level: "info", text: `当前档位：${m.hint}` }); }}
                  className={`cursor-pointer rounded-md border px-3 py-1.5 text-caption font-bold ${
                    mode === m.key
                      ? "border-gline bg-gold/8 text-goldhi"
                      : "border-line bg-card text-ink2 hover:border-gline"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {!detail ? (
              <SkeletonBlock lines={4} h={56} />
            ) : (
              <div className="rounded-lg border border-line bg-card p-4">
                {/* 工作台头：镜头 / 版本链 / 状态 / 字数校验 */}
                <div className="mb-3 flex flex-wrap items-center gap-2.5">
                  <b className="text-h2 text-ink">{detail.shot_id} · {detail.script_key}</b>
                  <span className={`rounded border px-1.5 py-0.5 text-micro ${(STATUS_META[detail.status] ?? STATUS_META.draft!).cls}`}>
                    {(STATUS_META[detail.status] ?? STATUS_META.draft!).label}
                  </span>
                  <span className="font-mono text-micro text-ink3">
                    {detail.parent_version ? `v${detail.parent_version} → ` : ""}v{detail.version} 当前
                  </span>
                  <span className={`rounded border px-1.5 py-0.5 text-micro ${withinSpec ? "border-go/45 text-go" : "border-warn/45 text-warn"}`}>
                    字数 {charCount.toLocaleString()} {withinSpec ? "✓ 口径内" : `⚠ 须 ${CHAR_MIN}-${CHAR_MAX}`}
                  </span>
                  {detail.diff_summary && (
                    <span className="font-mono text-micro text-ink3">diff：{detail.diff_summary}</span>
                  )}
                  <span className="flex-1" />
                  <button
                    type="button"
                    disabled={busy === "save" || !dirty}
                    onClick={() => void saveVersion()}
                    className="cursor-pointer rounded-md border border-gline bg-bg800/60 px-3 py-1.5 text-caption font-bold text-goldhi hover:border-gold/60 disabled:opacity-40"
                  >
                    ✎ 保存为新版本
                  </button>
                  {detail.status === "draft" && (
                    <button
                      type="button"
                      disabled={busy === "approve"}
                      onClick={() => void approve()}
                      className="cursor-pointer rounded-md border border-go/50 px-3 py-1.5 text-caption font-bold text-go hover:bg-go/10 disabled:opacity-40"
                    >
                      ✓ G8 审批通过
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy === "submit"}
                    onClick={() => void submit()}
                    className="cursor-pointer rounded-md gold-grad px-3.5 py-1.5 text-caption font-bold text-ongold disabled:opacity-40"
                  >
                    ▶ 提交渲染（{SUBMIT_MODES.find((m) => m.key === mode)?.label.replace(/^[^ ]+ /, "")}）
                  </button>
                </div>

                {/* MD 工作台（contentEditable 本地编辑；保存即新版本，不原地改） */}
                <pre
                  ref={mdRef}
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  onInput={() => setDirty(true)}
                  className="max-h-[460px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-bg900 p-3.5 font-mono text-caption leading-relaxed text-ink2 outline-none focus:border-holo/50"
                  style={{ whiteSpace: "pre-wrap" }}
                >{detail.md}</pre>

                <div className="mt-2 text-micro leading-relaxed text-ink3">
                  {dirty ? "已本地修改（未保存）——保存即生成新版本并回 draft" : "工作台可直接编辑；保存即新版本（§6）"} ·
                  提交渲染走 G8 审批（烧额度）；回执自动回填 render_jobs
                  {detail.status === "approved" && " · 当前版本已过 G8，可提交"}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Bridge>
  );
}
