/** 自助注册开通：行业起步方案来自基座 Bundle 注册表；工作区地址默认由服务端安全生成。 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@workloom/ui";
import { trpc, setToken, setRefreshToken } from "../../lib/trpc";
import { versionText } from "../../lib/display";
import { activationBundleSystemText } from "./systemText";

interface ActivationBundle {
  slug: string;
  displayName: string;
  description: string;
  version: string;
  serviceFrontEnabled: boolean;
  provisioningMode: "guided-assembly";
}

interface ActivationForm {
  phone: string;
  code: string;
  displayName: string;
  tenantName: string;
  workspaceName: string;
  industry: string;
  workspaceSlug: string;
}

function suggestedSlug(name: string, phone: string): string {
  const latin = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
  const tail = phone.replace(/\D/g, "").slice(-4) || "new";
  return latin.length >= 3 ? latin : `workspace-${tail}`;
}

function safeActivationError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("已被使用")) return "该工作区网址标识已被使用，请在高级设置中更换。";
  if (message.includes("验证码")) return "验证码不正确、已过期或发送次数已达上限，请重新获取。";
  if (message.includes("起步方案")) return "所选起步方案已更新，请刷新页面后重新选择。";
  if (message.includes("短信通道")) return "短信服务尚未配置，请联系系统管理员完成配置。";
  return fallback;
}

export default function Activate() {
  const nav = useNavigate();
  const [form, setForm] = useState<ActivationForm>({
    phone: "", code: "", displayName: "", tenantName: "", workspaceName: "", industry: "", workspaceSlug: "",
  });
  const [bundles, setBundles] = useState<ActivationBundle[]>([]);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [devCode, setDevCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const svc = () => trpc.accounts.auth as unknown as {
    activationOptions: { query: () => Promise<{ registryVersion: string; bundles: ActivationBundle[] }> };
    requestCode: { mutate: (i: { channel: "phone"; target: string; purpose: "activate" }) => Promise<{ devCode?: string }> };
    register: { mutate: (i: Omit<ActivationForm, "workspaceSlug"> & { workspaceSlug?: string }) => Promise<{ accessToken: string; refreshToken: string; workspaceSlug: string }> };
  };

  useEffect(() => {
    void svc().activationOptions.query()
      .then((result) => {
        const safeBundles = result.bundles.map(activationBundleSystemText);
        setBundles(safeBundles);
        setForm((current) => current.industry || safeBundles.length === 0
          ? current
          : { ...current, industry: safeBundles[0]!.slug });
        if (safeBundles.length === 0) setErr("当前没有通过发布校验的自助起步方案，请联系管理员。");
      })
      .catch(() => setErr("暂时无法读取可用起步方案，请稍后重试。"))
      .finally(() => setRegistryLoading(false));
  }, []);

  const selected = useMemo(() => bundles.find((bundle) => bundle.slug === form.industry) ?? null, [bundles, form.industry]);
  const autoSlug = useMemo(() => suggestedSlug(form.workspaceName, form.phone), [form.workspaceName, form.phone]);
  const set = (key: keyof ActivationForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function sendCode() {
    setErr(""); setBusy(true);
    try {
      const result = await svc().requestCode.mutate({ channel: "phone", target: form.phone, purpose: "activate" });
      setDevCode(import.meta.env.DEV && result.devCode ? result.devCode : "");
    } catch (error) { setErr(safeActivationError(error, "验证码发送失败，请稍后重试。")); }
    finally { setBusy(false); }
  }

  async function submit() {
    setErr(""); setBusy(true);
    try {
      const { workspaceSlug: _workspaceSlug, ...base } = form;
      const result = await svc().register.mutate({
        ...base,
        ...(advanced && form.workspaceSlug.trim() ? { workspaceSlug: form.workspaceSlug.trim() } : {}),
      });
      setToken(result.accessToken);
      setRefreshToken(result.refreshToken);
      nav("/onboarding");
    } catch (error) { setErr(safeActivationError(error, "开通尚未完成，请检查信息后重试。")); }
    finally { setBusy(false); }
  }

  const complete = form.phone.length >= 6 && form.code.length === 6 && form.displayName.trim()
    && form.tenantName.trim() && form.workspaceName.trim() && form.industry
    && (!advanced || !form.workspaceSlug || /^[a-z0-9][a-z0-9-]{2,39}$/.test(form.workspaceSlug));

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg min-w-0 flex-col justify-center px-4 py-10 sm:px-6">
      <h1 className="mb-1 break-words text-2xl font-bold">注册开通 WorkLoom</h1>
      <p className="mb-6 break-words text-sm leading-relaxed text-neutral-400">创建企业与第一个工作区，再由配置引导完成真实模型、组织与围栏装配。</p>
      <div className="min-w-0 space-y-3">
        <input className={inp} placeholder="您的称呼（如：王经理）" value={form.displayName} onChange={set("displayName")} />
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <input className={inp} inputMode="tel" placeholder="手机号" value={form.phone} onChange={set("phone")} />
          <Button variant="primary" busy={busy} disabled={form.phone.length < 6} onClick={() => void sendCode()}>发送验证码</Button>
        </div>
        {import.meta.env.DEV && devCode && <p className="break-words text-sm text-amber-400">本地开发验证码：{devCode}</p>}
        <input className={inp} inputMode="numeric" maxLength={6} placeholder="6 位验证码" value={form.code} onChange={set("code")} />
        <input className={inp} placeholder="企业名称（如：远航科技）" value={form.tenantName} onChange={set("tenantName")} />
        <input className={inp} placeholder="工作区名称（如：产品研发中心）" value={form.workspaceName} onChange={set("workspaceName")} />

        <label className="block min-w-0 text-sm text-neutral-300">起步方案
          <select className={`${inp} mt-1`} value={form.industry} disabled={registryLoading || bundles.length === 0} onChange={set("industry")}>
            {registryLoading && <option value="">正在读取可安装方案…</option>}
            {!registryLoading && bundles.length === 0 && <option value="">暂无可安装方案</option>}
            {bundles.map((bundle) => <option key={bundle.slug} value={bundle.slug}>{bundle.displayName}</option>)}
          </select>
        </label>
        {selected && (
          <div className="min-w-0 rounded-lg border border-neutral-700 bg-neutral-900/70 px-3 py-2 text-sm leading-relaxed text-neutral-400">
            <div className="break-words font-semibold text-neutral-200">已通过基座兼容与完整性校验 · {versionText(selected.version)}</div>
            <div className="mt-1 line-clamp-3 break-words">{selected.description}</div>
            <div className="mt-1 break-words">开通后进入配置引导完成装配{selected.serviceFrontEnabled ? "，并可继续配置客户服务前台" : ""}。</div>
          </div>
        )}

        <button type="button" className="min-h-11 max-w-full break-words text-left text-sm text-neutral-400 underline" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>
          {advanced ? "收起高级设置" : "高级设置：自定义工作区网址标识"}
        </button>
        {advanced && (
          <label className="block min-w-0 text-sm text-neutral-300">工作区网址标识
            <input className={`${inp} mt-1`} placeholder={autoSlug} value={form.workspaceSlug} onChange={set("workspaceSlug")} />
            <span className="mt-1 block break-words text-sm leading-relaxed text-neutral-500">留空时由服务端自动生成并避让重复值；仅支持小写字母、数字和连字符。</span>
          </label>
        )}
      </div>
      {err && <p role="alert" className="mt-3 break-words text-sm leading-relaxed text-red-400">{err}</p>}
      <Button className="mt-5 w-full" variant="primary" busy={busy} busyLabel="正在开通…" disabled={registryLoading || !complete} onClick={() => void submit()}>开通并进入配置引导</Button>
      <Button className="mt-4 text-neutral-300 underline" variant="quiet" onClick={() => nav("/login")}>已有账号？去登录</Button>
    </main>
  );
}

const inp = "min-h-11 w-full min-w-0 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-500 focus:border-emerald-500";
