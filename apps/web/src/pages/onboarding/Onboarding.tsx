/**
 * 落地向导（D24）——从「全模拟运行态」到「真实经营」的六步自动流程
 *
 * ① 环境自检（自动跑：DB/事件库/模型/数据模式）
 * ② 真实大模型（预设一键填 → 真实试调 → 通过才保存；保存即全链即时真实化，无需重启）
 * ③ 经营主体（名称/行业/简介 → 门店档案）
 * ④ 起步方式（客群选择：质检模式 audit_only 推荐——先体检再托管；选择即装配班底+技能+围栏）
 * ⑤ 启用真实模式（翻转 dataMode，横幅熄灭；模拟期数据保留为「演示期」历史）
 * ⑥ AI 服务前台（可选）：官网抓取建知识库 / 文档入库 / 试营业测试问 / 生成 C 端入口
 *
 * 设计纪律：每一步都可跳过但状态如实回显；所有写操作经 onboarding.* 端点五元事件留痕。
 */
import { useEffect, useMemo, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import type { OnboardingStatus } from "../../components/SimBanner";

const PROVIDERS: Array<{ key: string; label: string; baseUrl: string; model: string }> = [
  { key: "deepseek", label: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { key: "moonshot", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { key: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { key: "custom", label: "自定义（OpenAI 兼容网关）", baseUrl: "", model: "" },
];

const STEPS = ["环境自检", "真实大模型", "经营主体", "起步方式", "启用真实模式", "AI 服务前台"] as const;

/** 客群选项（onboarding.segments 返回形状） */
interface SegmentOption {
  key: string;
  label: string;
  pitch: string;
  presets: number;
  skills: number;
  hasFencePatch: boolean;
}

/** 装配结果（onboarding.chooseSegment 返回形状） */
interface AssemblyResult {
  segment: string;
  label: string;
  stage: "audit" | "managed";
  agents: number;
  skillsInstalled: number;
  skillsSkipped: number;
  fencePatch: string | null;
  fenceRulesApplied: number;
  fenceDefaultLevel: string | null;
}

export default function Onboarding() {
  const [st, setSt] = useState<OnboardingStatus | null>(null);
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");

  // 步骤②表单
  const [prov, setProv] = useState("deepseek");
  const [baseUrl, setBaseUrl] = useState(PROVIDERS[0]!.baseUrl);
  const [model, setModel] = useState(PROVIDERS[0]!.model);
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reply?: string; latencyMs?: number; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [llmDone, setLlmDone] = useState(false);

  // 步骤③表单
  const [bizName, setBizName] = useState("");
  const [industry, setIndustry] = useState("AI 视频内容制作");
  const [note, setNote] = useState("");
  const [bizDone, setBizDone] = useState(false);

  // 步骤④ 起步方式（客群选择）
  const [segments, setSegments] = useState<SegmentOption[]>([]);
  const [assembling, setAssembling] = useState(false);
  const [assembly, setAssembly] = useState<AssemblyResult | null>(null);

  // 步骤⑤
  const [activating, setActivating] = useState(false);
  const [done, setDone] = useState(false);

  const reload = async () => {
    await ensureDemoLogin();
    const s = (await trpc.onboarding.status.query()) as OnboardingStatus;
    setSt(s);
    return s;
  };
  useEffect(() => {
    void reload().then((s) => {
      setBizName((v) => v || s.workspace.name);
      if (s.llm.real) setLlmDone(true);
    }).catch((e) => setErr((e as Error).message));
    // 起步方式选项（audit_only 质检模式置顶并标推荐：先体检，再托管）
    void (trpc.onboarding.segments.query() as Promise<SegmentOption[]>)
      .then((list) => setSegments([...list].sort((a, b) => (a.key === "audit_only" ? -1 : b.key === "audit_only" ? 1 : 0))))
      .catch(() => setSegments([]));
  }, []);

  const checks = useMemo(() => {
    if (!st) return [];
    return [
      { label: "数据库连接", ok: true, detail: "事件库在线" },
      { label: "事件库规模", ok: st.workspace.events > 0, detail: `${st.workspace.events} 条五元事件（哈希链可验）` },
      { label: "数字团队", ok: st.workspace.agents > 0, detail: `${st.workspace.agents} 名员工 · ${st.workspace.members} 名人类成员 · ${st.workspace.memories} 条组织记忆` },
      { label: "大模型", ok: st.llm.real, detail: st.llm.real ? `${st.llm.provider} · ${st.llm.model}（真实推理）` : "内置 mock（确定性应答，非真实推理）" },
      { label: "数据模式", ok: st.dataMode === "real", detail: st.dataMode === "real" ? "真实经营模式" : "模拟演示数据" },
    ];
  }, [st]);

  const pickProvider = (key: string) => {
    setProv(key);
    const p = PROVIDERS.find((x) => x.key === key)!;
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setTestResult(null);
  };

  const test = async () => {
    setTesting(true); setTestResult(null); setErr("");
    try {
      const r = (await trpc.onboarding.testLlm.mutate({ baseUrl, apiKey, model })) as typeof testResult;
      setTestResult(r);
    } catch (e) { setTestResult({ ok: false, error: (e as Error).message }); }
    finally { setTesting(false); }
  };

  const saveLlm = async () => {
    setSaving(true); setErr("");
    try {
      await trpc.onboarding.saveLlmConfig.mutate({ provider: prov, baseUrl, apiKey, model });
      setLlmDone(true);
      await reload();
      setStep(2);
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  };

  const saveBiz = async () => {
    setSaving(true); setErr("");
    try {
      await trpc.onboarding.setupWorkspace.mutate({ displayName: bizName, industry, note });
      setBizDone(true);
      await reload();
      setStep(3);
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  };

  // 选择起步方式：调用 chooseSegment 一次性装配（班底+技能+围栏 patch+旅程档案，事件留痕）
  const choose = async (key: string) => {
    setAssembling(true); setErr(""); setAssembly(null);
    try {
      const r = (await trpc.onboarding.chooseSegment.mutate({ segment: key })) as AssemblyResult;
      setAssembly(r);
      await reload();
    } catch (e) { setErr((e as Error).message); }
    finally { setAssembling(false); }
  };

  const activate = async () => {
    setActivating(true); setErr("");
    try {
      await trpc.onboarding.activateRealMode.mutate();
      await reload();
      setStep(5);
    } catch (e) { setErr((e as Error).message); }
    finally { setActivating(false); }
  };

  // —— ⑤ AI 服务前台（可选）——
  const [siteUrl, setSiteUrl] = useState("");
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteResult, setSiteResult] = useState<{ entryCount: number; degraded?: boolean } | null>(null);
  const [docTitle, setDocTitle] = useState("");
  const [docMd, setDocMd] = useState("");
  const [docBusy, setDocBusy] = useState(false);
  const [docResult, setDocResult] = useState<{ version: number; chunks: number } | null>(null);
  const [testQ, setTestQ] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testHits, setTestHits] = useState<Array<{ documentTitle: string; heading: string; content: string; score: number }> | null>(null);

  const ensureCollection = async (): Promise<string> => {
    const r = await trpc.service.kb.listCollections.query();
    const first = (r.collections as Array<{ id: string }>)[0];
    if (first) return first.id;
    const r2 = (await trpc.service.kb.createCollection.mutate({ name: "企业知识库", description: "落地向导初始化" })) as { collection: { id: string } };
    return r2.collection.id;
  };

  const crawlSite = async () => {
    setSiteBusy(true); setErr("");
    try {
      const reg = (await trpc.service.kb.registerSite.mutate({ url: siteUrl.trim() })) as { sourceId: string };
      const r = (await trpc.service.kb.crawlNow.mutate({ sourceId: reg.sourceId })) as { entryCount: number; degraded?: boolean };
      setSiteResult(r);
    } catch (e) { setErr((e as Error).message); }
    finally { setSiteBusy(false); }
  };

  const addDoc = async () => {
    setDocBusy(true); setErr("");
    try {
      const collectionId = await ensureCollection();
      const r = (await trpc.service.kb.upsertDocument.mutate({ collectionId, title: docTitle.trim(), sourceKind: "manual", contentMd: docMd })) as { version: number; chunks: number };
      setDocResult(r);
    } catch (e) { setErr((e as Error).message); }
    finally { setDocBusy(false); }
  };

  const runTest = async () => {
    setTestBusy(true); setErr("");
    try {
      const r = await trpc.service.kb.search.query({ query: testQ.trim(), limit: 3 });
      setTestHits(r.hits as Array<{ documentTitle: string; heading: string; content: string; score: number }>);
    } catch (e) { setErr((e as Error).message); }
    finally { setTestBusy(false); }
  };

  const inputCls = "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none placeholder:text-ink3 focus:border-gline";
  const btnCls = "rounded-lg border border-gline bg-gold/10 px-4 py-2 text-sm text-gold transition-colors hover:bg-gold/20 disabled:opacity-40";

  return (
    <div className="min-h-screen bg-[#07070d] px-4 py-8 text-ink">
      <div className="mx-auto max-w-2xl">
        {/* 头 */}
        <div className="mb-6 flex items-center gap-3">
          <a href="/" className="rounded border border-line px-2.5 py-1 text-xs text-ink3 no-underline hover:border-gline">← 返回经营主页</a>
          <h1 className="bg-gradient-to-r from-[#fff6e3] to-gold bg-clip-text text-lg font-bold text-transparent">落地向导 · 接入真实数据</h1>
        </div>

        {/* 步骤条 */}
        <div className="mb-6 flex gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className={`flex-1 rounded-lg border px-2 py-2 text-center text-xs ${i === step ? "border-gline bg-gold/10 text-gold" : i < step || (i === 1 && llmDone) || (i === 2 && bizDone) || (i === 3 && assembly) ? "border-go/40 text-go" : "border-line text-ink3"}`}>
              {i < step || (i === 1 && llmDone) || (i === 2 && bizDone) || (i === 3 && assembly) ? "✓ " : `${i + 1}. `}{s}
            </div>
          ))}
        </div>

        {err && <div className="mb-4 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-xs text-warn">{err}</div>}

        {/* ① 环境自检 */}
        {step === 0 && (
          <div className="space-y-3 rounded-xl border border-line bg-panel/70 p-5">
            <div className="text-sm font-bold">环境自检 <span className="text-xs font-normal text-ink3">（自动完成）</span></div>
            {!st && <div className="text-xs text-ink3">自检中……</div>}
            {checks.map((c) => (
              <div key={c.label} className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
                <span className={c.ok ? "text-go" : "text-amber-300"}>{c.ok ? "✓" : "○"}</span>
                <span className="w-24 text-sm">{c.label}</span>
                <span className="flex-1 text-xs text-ink3">{c.detail}</span>
              </div>
            ))}
            {st && (
              <div className="pt-2 text-right">
                <button className={btnCls} onClick={() => setStep(st.llm.real ? 2 : 1)}>
                  {st.llm.real ? "模型已真实化，跳过 →" : "下一步：接入真实大模型 →"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ② 真实大模型 */}
        {step === 1 && (
          <div className="space-y-4 rounded-xl border border-line bg-panel/70 p-5">
            <div className="text-sm font-bold">接入真实大模型 <span className="text-xs font-normal text-ink3">真实试调通过才会保存；保存即全链生效，无需重启</span></div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PROVIDERS.map((p) => (
                <button key={p.key} onClick={() => pickProvider(p.key)}
                  className={`rounded-lg border px-3 py-2 text-xs ${prov === p.key ? "border-gline bg-gold/10 text-gold" : "border-line text-ink3 hover:border-gline"}`}>
                  {p.label}
                </button>
              ))}
            </div>
            <label className="block text-xs text-ink3">Base URL
              <input className={`${inputCls} mt-1`} value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); }} placeholder="https://api.deepseek.com/v1" />
            </label>
            <label className="block text-xs text-ink3">API Key <span className="text-ink3/70">（只落盘到本机 .env，事件留痕仅记掩码后 4 位）</span>
              <input className={`${inputCls} mt-1`} type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setTestResult(null); }} placeholder="sk-……" />
            </label>
            <label className="block text-xs text-ink3">模型
              <input className={`${inputCls} mt-1`} value={model} onChange={(e) => { setModel(e.target.value); setTestResult(null); }} placeholder="deepseek-chat" />
            </label>
            {testResult && (
              <div className={`rounded-lg border px-3 py-2 text-xs ${testResult.ok ? "border-go/50 bg-go/10 text-go" : "border-warn/50 bg-warn/10 text-warn"}`}>
                {testResult.ok
                  ? <>✓ 真实试调通过（{testResult.latencyMs}ms）——模型回复：「{testResult.reply}」</>
                  : <>✕ 试调失败：{testResult.error}</>}
              </div>
            )}
            <div className="flex items-center justify-between pt-1">
              <button className="text-xs text-ink3 underline" onClick={() => setStep(2)}>暂用内置 mock，跳过</button>
              <div className="flex gap-2">
                <button className={btnCls} disabled={testing || !baseUrl || !model} onClick={() => void test()}>
                  {testing ? "试调中……" : "测试连接（真实调用）"}
                </button>
                <button className={btnCls} disabled={saving || !testResult?.ok} onClick={() => void saveLlm()}>
                  {saving ? "保存中……" : "保存并启用 →"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ③ 经营主体 */}
        {step === 2 && (
          <div className="space-y-4 rounded-xl border border-line bg-panel/70 p-5">
            <div className="text-sm font-bold">经营主体 <span className="text-xs font-normal text-ink3">写入门店档案，成为数字团队的上下文</span></div>
            <label className="block text-xs text-ink3">主体名称
              <input className={`${inputCls} mt-1`} value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder="如：星芒好物" />
            </label>
            <label className="block text-xs text-ink3">行业
              <input className={`${inputCls} mt-1`} value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="如：短视频 MCN / 内容工作室 / 品牌自播" />
            </label>
            <label className="block text-xs text-ink3">经营简介（可选）
              <textarea className={`${inputCls} mt-1 h-20 resize-none`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="主营平台、账号矩阵、经营重点……数字员工会以此为背景工作" />
            </label>
            <div className="flex items-center justify-between pt-1">
              <button className="text-xs text-ink3 underline" onClick={() => setStep(3)}>跳过</button>
              <button className={btnCls} disabled={saving || !bizName.trim() || !industry.trim()} onClick={() => void saveBiz()}>
                {saving ? "保存中……" : "保存并继续 →"}
              </button>
            </div>
          </div>
        )}

        {/* ④ 起步方式（客群选择：先体检，再托管） */}
        {step === 3 && (
          <div className="space-y-4 rounded-xl border border-line bg-panel/70 p-5">
            <div className="text-sm font-bold">起步方式 <span className="text-xs font-normal text-ink3">选择即一次性装配数字班底 + 技能 + 围栏（全程留痕，可整体回滚）</span></div>
            <div className="space-y-2">
              {segments.map((s) => {
                const recommended = s.key === "audit_only";
                const active = assembly?.segment === s.key;
                return (
                  <button key={s.key} disabled={assembling} onClick={() => void choose(s.key)}
                    className={`block w-full rounded-xl border p-4 text-left transition-colors disabled:opacity-50 ${active ? "border-go/60 bg-go/5" : recommended ? "border-gline bg-gold/5 hover:bg-gold/10" : "border-line bg-card hover:border-gline"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-bold ${recommended ? "text-gold" : "text-ink"}`}>{s.label}</span>
                      {recommended && <span className="rounded border border-gline bg-gold/15 px-1.5 py-0.5 text-[10px] text-gold">推荐</span>}
                      {active && <span className="rounded border border-go/50 bg-go/10 px-1.5 py-0.5 text-[10px] text-go">已装配</span>}
                      <span className="ml-auto text-[11px] text-ink3">{s.presets} 名员工 · {s.skills} 项技能</span>
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-ink3">{s.pitch}</div>
                    {recommended && (
                      <div className="mt-1.5 text-[11px] leading-relaxed text-ink2">
                        先体检再托管 · 系统只读——不发帖、不回评、不私信 · 15–30 分钟出《账号快速体检报告》
                      </div>
                    )}
                  </button>
                );
              })}
              {segments.length === 0 && <div className="text-xs text-ink3">客群清单加载中……</div>}
            </div>
            {assembling && <div className="text-xs text-gold">装配中：上岗班底 → 安装技能 → 应用围栏 patch → 留痕……</div>}
            {assembly && (
              <div className="space-y-2 rounded-lg border border-go/50 bg-go/5 p-4">
                <div className="text-xs font-bold text-go">✓ {assembly.label} 装配完成</div>
                <div className="text-xs leading-relaxed text-ink2">
                  {assembly.agents} 名员工上岗 · {assembly.skillsInstalled} 项技能安装{assembly.skillsSkipped > 0 ? `（${assembly.skillsSkipped} 项已装跳过）` : ""} ·{" "}
                  {assembly.fencePatch
                    ? `围栏模式：${assembly.fencePatch}${assembly.fenceDefaultLevel === "block" ? "（一切写操作物理 block）" : ""}，收紧规则 ${assembly.fenceRulesApplied} 条`
                    : "围栏模式：基线"}
                </div>
                {assembly.stage === "audit" && (
                  <div className="rounded border border-holo/40 bg-holo/10 px-3 py-2 text-[11px] leading-relaxed text-holo">
                    体检期建议立即运行快照快扫：<code>pnpm audit:scan</code>——15–30 分钟出《账号快速体检报告》（一账号一份 + 矩阵总览，异常 P0/P1/P2 分级）。
                    体检报告出来后，随时回到本步骤改选正式托管客群。
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center justify-between pt-1">
              <button className="text-xs text-ink3 underline" onClick={() => setStep(4)}>暂不选择，跳过</button>
              <button className={btnCls} disabled={!assembly} onClick={() => setStep(4)}>
                下一步：启用真实模式 →
              </button>
            </div>
          </div>
        )}

        {/* ⑤ 启用真实模式 */}
        {step === 4 && !done && (
          <div className="space-y-4 rounded-xl border border-gline bg-panel/70 p-5">
            <div className="text-sm font-bold text-gold">启用真实经营模式</div>
            <ul className="space-y-1.5 text-xs leading-relaxed text-ink2">
              <li>· 数据模式 <b>simulated → real</b>：此后所有经营动作即为真实数据，全链五元事件留痕、哈希链可验。</li>
              <li>· 顶部的模拟数据横幅将<b>自动熄灭</b>。</li>
              <li>· 模拟期数据保留为「演示期」历史供对照；如需彻底清空，可运行 <code className="text-holo">pnpm demo</code> 前置的 <code className="text-holo">scripts/reset.sh</code> 整库重建。</li>
              <li>· 大模型状态：<b className={st?.llm.real ? "text-go" : "text-amber-300"}>{st?.llm.real ? `${st.llm.provider} · ${st.llm.model}（真实推理）` : "仍为内置 mock——可稍后从横幅再次进入本向导接入"}</b></li>
            </ul>
            <div className="pt-1 text-right">
              <button className={btnCls} disabled={activating} onClick={() => void activate()}>
                {activating ? "切换中……" : "确认启用真实经营模式"}
              </button>
            </div>
          </div>
        )}

        {/* ⑥ AI 服务前台（可选） */}
        {step === 5 && !done && (
          <div className="space-y-4 rounded-xl border border-gline bg-panel/70 p-5">
            <div className="text-sm font-bold text-gold">启用 AI 服务前台（ToBToC · 可选）</div>
            <div className="text-xs leading-relaxed text-ink2">
              为您的客户（C 端）配一个 7×24 的 AI 客服前台：知识库问答（带引用、不臆造）、订单/会员查询、服务工单流转与结果推送。入口为小程序级 H5：<code className="text-holo">/app/c</code>。
            </div>

            {/* 渠道 */}
            <div className="flex gap-2 text-[11px]">
              {["微信小程序", "支付宝小程序", "H5 网页（已就绪）"].map((c, i) => (
                <span key={c} className={`rounded border px-2 py-1 ${i === 2 ? "border-go/50 text-go" : "border-line text-ink3"}`}>{c}</span>
              ))}
            </div>

            {/* 官网抓取建库 */}
            <div className="space-y-2 rounded-lg border border-line p-3">
              <div className="text-xs font-bold text-ink">① 官网自动建库（抓取 → 结构化 → 每日扫描更新，变更必审）</div>
              <div className="flex gap-2">
                <input className={inputCls} placeholder="企业官网 URL，如 https://www.example.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
                <button className={btnCls} disabled={siteBusy || !siteUrl.trim()} onClick={() => void crawlSite()}>{siteBusy ? "抓取中……" : "抓取建库"}</button>
              </div>
              {siteResult && (
                <div className="text-xs text-go">✓ 已结构化抽取 {siteResult.entryCount} 条知识入库{siteResult.degraded ? "（无 LLM key，降级直存）" : ""}，已进入待审列表。</div>
              )}
            </div>

            {/* 文档入库 */}
            <div className="space-y-2 rounded-lg border border-line p-3">
              <div className="text-xs font-bold text-ink">② 或直接上传政策/手册内容（Markdown 粘贴即可）</div>
              <input className={inputCls} placeholder="文档标题，如《住客服务须知》" value={docTitle} onChange={(e) => setDocTitle(e.target.value)} />
              <textarea className={`${inputCls} h-24`} placeholder="# 服务政策
## 退换货
……" value={docMd} onChange={(e) => setDocMd(e.target.value)} />
              <div className="text-right">
                <button className={btnCls} disabled={docBusy || !docTitle.trim() || !docMd.trim()} onClick={() => void addDoc()}>{docBusy ? "入库中……" : "解析入库"}</button>
              </div>
              {docResult && <div className="text-xs text-go">✓ 已入库 v{docResult.version}，自动切分 {docResult.chunks} 个知识块。</div>}
            </div>

            {/* 试营业测试问 */}
            <div className="space-y-2 rounded-lg border border-line p-3">
              <div className="text-xs font-bold text-ink">③ 试营业：问一句，看命中与依据</div>
              <div className="flex gap-2">
                <input className={inputCls} placeholder="测试问题，如：退房时间是几点？" value={testQ} onChange={(e) => setTestQ(e.target.value)} />
                <button className={btnCls} disabled={testBusy || !testQ.trim()} onClick={() => void runTest()}>{testBusy ? "检索中……" : "试一句"}</button>
              </div>
              {testHits && (testHits.length === 0 ? (
                <div className="text-xs text-amber-300">未命中——真实问答时 AI 将诚实拒答并自动生成工单转专人，不臆造。</div>
              ) : testHits.map((h, i) => (
                <div key={i} className="rounded border border-line bg-card px-2.5 py-1.5 text-[11px] text-ink2">
                  <b className="text-holo">{h.documentTitle} · {h.heading}</b>（相关度 {h.score.toFixed(2)}）<br />{h.content.slice(0, 80)}
                </div>
              )))}
            </div>

            <div className="flex items-center justify-between pt-1">
              <button className="text-xs text-ink3 underline" onClick={() => setDone(true)}>暂不配置，稍后在知识中台配置</button>
              <button className={btnCls} onClick={() => setDone(true)}>完成，进入经营主页 →</button>
            </div>
          </div>
        )}

        {/* 完成 */}
        {done && (
          <div className="space-y-4 rounded-xl border border-go/50 bg-go/5 p-6 text-center">
            <div className="text-2xl">🎉</div>
            <div className="text-sm font-bold text-go">真实经营模式已启用</div>
            <div className="text-xs leading-relaxed text-ink3">
              横幅已熄灭，切换全程已留痕（onboarding.real_mode_activated）。<br />
              数字团队将继续以真实身份为您工作——回经营主页看看。
            </div>
            <div className="flex items-center justify-center gap-3">
              <a href="/" className="inline-block rounded-lg border border-gline bg-gold/10 px-5 py-2 text-sm text-gold no-underline hover:bg-gold/20">回到经营主页 →</a>
              <a href="/app/c" target="_blank" className="inline-block rounded-lg border border-holo/40 bg-holo/10 px-5 py-2 text-sm text-holo no-underline hover:bg-holo/20">打开 C 端服务前台 ↗</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
