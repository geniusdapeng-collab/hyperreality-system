/**
 * 落地向导（D24）——从「全模拟运行态」到「真实经营」的四步自动流程
 *
 * ① 环境自检（自动跑：DB/事件库/模型/数据模式）
 * ② 真实大模型（预设一键填 → 真实试调 → 通过才保存；保存即全链即时真实化，无需重启）
 * ③ 经营主体（名称/行业/简介 → 一店一档）
 * ④ 启用真实模式（翻转 dataMode，横幅熄灭；模拟期数据保留为「演示期」历史）
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

const STEPS = ["环境自检", "真实大模型", "经营主体", "启用真实模式"] as const;

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

  // 步骤④
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

  const activate = async () => {
    setActivating(true); setErr("");
    try {
      await trpc.onboarding.activateRealMode.mutate();
      await reload();
      setDone(true);
    } catch (e) { setErr((e as Error).message); }
    finally { setActivating(false); }
  };

  const inputCls = "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none placeholder:text-ink3 focus:border-gline";
  const btnCls = "rounded-lg border border-gline bg-gold/10 px-4 py-2 text-sm text-gold transition-colors hover:bg-gold/20 disabled:opacity-40";

  return (
    <div className="min-h-screen bg-[#07070d] px-4 py-8 text-ink">
      <div className="mx-auto max-w-2xl">
        {/* 头 */}
        <div className="mb-6 flex items-center gap-3">
          <a href="/" className="rounded border border-line px-2.5 py-1 text-xs text-ink3 no-underline hover:border-gline">← 返回剧场</a>
          <h1 className="bg-gradient-to-r from-[#fff6e3] to-gold bg-clip-text text-lg font-bold text-transparent">落地向导 · 接入真实数据</h1>
        </div>

        {/* 步骤条 */}
        <div className="mb-6 flex gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className={`flex-1 rounded-lg border px-2 py-2 text-center text-xs ${i === step ? "border-gline bg-gold/10 text-gold" : i < step || (i === 1 && llmDone) || (i === 2 && bizDone) ? "border-go/40 text-go" : "border-line text-ink3"}`}>
              {i < step || (i === 1 && llmDone) || (i === 2 && bizDone) ? "✓ " : `${i + 1}. `}{s}
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
            <div className="text-sm font-bold">经营主体 <span className="text-xs font-normal text-ink3">写入一店一档，成为数字团队的上下文</span></div>
            <label className="block text-xs text-ink3">主体名称
              <input className={`${inputCls} mt-1`} value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder="如：云栖酒店" />
            </label>
            <label className="block text-xs text-ink3">行业
              <input className={`${inputCls} mt-1`} value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="如：酒店民宿 / 餐饮 / 内容制作" />
            </label>
            <label className="block text-xs text-ink3">经营简介（可选）
              <textarea className={`${inputCls} mt-1 h-20 resize-none`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="门店位置、房型规模、经营重点……数字员工会以此为背景工作" />
            </label>
            <div className="flex items-center justify-between pt-1">
              <button className="text-xs text-ink3 underline" onClick={() => setStep(3)}>跳过</button>
              <button className={btnCls} disabled={saving || !bizName.trim() || !industry.trim()} onClick={() => void saveBiz()}>
                {saving ? "保存中……" : "保存并继续 →"}
              </button>
            </div>
          </div>
        )}

        {/* ④ 启用真实模式 */}
        {step === 3 && !done && (
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

        {/* 完成 */}
        {done && (
          <div className="space-y-4 rounded-xl border border-go/50 bg-go/5 p-6 text-center">
            <div className="text-2xl">🎉</div>
            <div className="text-sm font-bold text-go">真实经营模式已启用</div>
            <div className="text-xs leading-relaxed text-ink3">
              横幅已熄灭，切换全程已留痕（onboarding.real_mode_activated）。<br />
              数字团队将继续以真实身份为您工作——回剧场看看。
            </div>
            <a href="/" className="inline-block rounded-lg border border-gline bg-gold/10 px-5 py-2 text-sm text-gold no-underline hover:bg-gold/20">回到经营剧场 →</a>
          </div>
        )}
      </div>
    </div>
  );
}
