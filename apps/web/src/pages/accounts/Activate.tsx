/**
 * Activate —— 自助注册开通（PRD §4.2 首次开通主通道：扫码/验证码 → 建企业+首店 → 本人即 owner）
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { trpc, setToken, setRefreshToken } from "../../lib/trpc";

export default function Activate() {
  const nav = useNavigate();
  const [form, setForm] = useState({
    phone: "", code: "", displayName: "", tenantName: "", workspaceName: "", workspaceSlug: "", industry: "hotel",
  });
  const [devCode, setDevCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const svc = () => trpc.accounts.auth as unknown as {
    requestCode: { mutate: (i: { channel: "phone"; target: string; purpose: "activate" }) => Promise<{ devCode?: string }> };
    register: { mutate: (i: typeof form) => Promise<{ accessToken: string; refreshToken: string }> };
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function sendCode() {
    setErr(""); setBusy(true);
    try {
      const r = await svc().requestCode.mutate({ channel: "phone", target: form.phone, purpose: "activate" });
      if (r.devCode) setDevCode(r.devCode);
    } catch (e) { setErr(e instanceof Error ? e.message : "发送失败"); }
    finally { setBusy(false); }
  }

  async function submit() {
    setErr(""); setBusy(true);
    try {
      const r = await svc().register.mutate(form);
      setToken(r.accessToken); setRefreshToken(r.refreshToken);
      nav("/p28");
    } catch (e) { setErr(e instanceof Error ? e.message : "开通失败"); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
      <h1 className="mb-1 text-2xl font-bold">注册开通 WorkLoom</h1>
      <p className="mb-6 text-sm text-neutral-400">创建您的企业与第一家店，全程约 2 分钟</p>
      <div className="space-y-3">
        <input className={inp} placeholder="您的称呼（如：王老板）" value={form.displayName} onChange={set("displayName")} />
        <div className="flex gap-2">
          <input className={inp} placeholder="手机号" value={form.phone} onChange={set("phone")} />
          <button className={btn} disabled={busy || form.phone.length < 6} onClick={() => void sendCode()}>发验证码</button>
        </div>
        {devCode && <p className="text-xs text-amber-400">开发通道验证码：{devCode}</p>}
        <input className={inp} placeholder="6 位验证码" value={form.code} onChange={set("code")} />
        <input className={inp} placeholder="企业名称（如：云栖民宿）" value={form.tenantName} onChange={set("tenantName")} />
        <input className={inp} placeholder="首店名称（如：云栖一号店）" value={form.workspaceName} onChange={set("workspaceName")} />
        <input className={inp} placeholder="店铺标识（小写字母数字中划线，如 yunqi-01）" value={form.workspaceSlug} onChange={set("workspaceSlug")} />
        <select className={inp} value={form.industry} onChange={set("industry")}>
          <option value="hotel">酒店 / 民宿</option>
          <option value="ecommerce">电商</option>
          <option value="ai-video">视频营销</option>
          <option value="marketing">营销获客</option>
        </select>
      </div>
      {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
      <button className={`${btn} mt-5 w-full`} disabled={busy} onClick={() => void submit()}>开通并进入</button>
      <button className="mt-4 text-sm text-neutral-400 underline" onClick={() => nav("/login")}>已有账号？去登录</button>
    </div>
  );
}

const inp = "w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-emerald-500";
const btn = "rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-40";
