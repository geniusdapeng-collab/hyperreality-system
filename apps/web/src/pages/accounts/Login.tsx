/**
 * Login —— 登录页（PRD §4.1：扫码主通道占位 + 手机验证码 + 邮箱密码 + 注册开通/接受邀请入口）
 * 演示入口（loginAs）仅开发环境展示；生产不出现。
 */
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { trpc, setToken, setRefreshToken, ensureDemoLogin, DEV_DEMO_MEMBER, clearGuestFlag } from "../../lib/trpc";

const WS = (import.meta.env.VITE_DEMO_WORKSPACE as string | undefined) ?? "yunqi-hotel";

type Tab = "code" | "password";

export default function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  // F-GUEST1：游客进配置引导被拦到这里时，登录成功后送回原目的地
  const next = params.get("next") || "/p28";
  const [tab, setTab] = useState<Tab>("code");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeSent, setCodeSent] = useState(false);

  const svc = () => trpc.accounts.auth as unknown as {
    requestCode: { mutate: (i: { channel: "phone"; target: string; purpose: "login" }) => Promise<{ sent: boolean; devCode?: string }> };
    loginWithCode: { mutate: (i: { phone: string; code: string; workspaceSlug: string }) => Promise<{ accessToken: string; refreshToken: string }> };
    loginWithPassword: { mutate: (i: { email: string; password: string; workspaceSlug: string }) => Promise<{ accessToken: string; refreshToken: string }> };
  };

  async function sendCode() {
    setErr(""); setBusy(true);
    try {
      const r = await svc().requestCode.mutate({ channel: "phone", target: phone, purpose: "login" });
      setCodeSent(true);
      if (r.devCode) setDevCode(r.devCode);
    } catch (e) { setErr(e instanceof Error ? e.message : "发送失败"); }
    finally { setBusy(false); }
  }

  async function doLogin() {
    setErr(""); setBusy(true);
    try {
      const r = tab === "code"
        ? await svc().loginWithCode.mutate({ phone, code, workspaceSlug: WS })
        : await svc().loginWithPassword.mutate({ email, password, workspaceSlug: WS });
      clearGuestFlag(); // 正式身份进场，摘掉游客标记
      setToken(r.accessToken);
      setRefreshToken(r.refreshToken);
      nav(next);
    } catch (e) { setErr(e instanceof Error ? e.message : "登录失败"); }
    finally { setBusy(false); }
  }

  async function demoEnter() {
    // 开发后门（仅 DEV 展示）：以种子成员真身份进入，绕过账号体系
    await ensureDemoLogin(DEV_DEMO_MEMBER);
    nav(next);
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
      <h1 className="mb-1 text-2xl font-bold">登录 WorkLoom</h1>
      <p className="mb-6 text-sm text-neutral-400">工作区：<code className="text-emerald-400">{WS}</code>（可在登录后切换）</p>

      <div className="mb-4 flex gap-2 text-sm">
        <button className={btn(tab === "code")} onClick={() => setTab("code")}>手机验证码</button>
        <button className={btn(tab === "password")} onClick={() => setTab("password")}>邮箱密码</button>
        <button className={btn(false)} disabled title="微信开放平台接入后开放">微信扫码（即将开放）</button>
      </div>

      {tab === "code" ? (
        <div className="space-y-3">
          <input className={inp} placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <div className="flex gap-2">
            <input className={inp} placeholder="6 位验证码" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className={btn(true)} disabled={busy || phone.length < 6} onClick={() => void sendCode()}>
              {codeSent ? "重发" : "发送验证码"}
            </button>
          </div>
          {devCode && <p className="text-xs text-amber-400">开发通道验证码：{devCode}（生产环境不显示）</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <input className={inp} placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className={inp} type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      )}

      {err && <p className="mt-3 text-sm text-red-400">{err}</p>}

      <button className={`${btn(true)} mt-5 w-full`} disabled={busy} onClick={() => void doLogin()}>登 录</button>

      <div className="mt-6 flex justify-between text-sm text-neutral-400">
        <button className="underline" onClick={() => nav("/activate")}>注册开通（老板首店）</button>
        <button className="underline" onClick={() => nav("/invite")}>接受成员邀请</button>
      </div>

      {import.meta.env.DEV && (
        <button className="mt-8 text-xs text-neutral-500 underline" onClick={() => void demoEnter()}>
          开发演示：直接进入演示身份（不经过账号）
        </button>
      )}
    </div>
  );
}

const inp = "w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-emerald-500";
const btn = (active: boolean) =>
  `rounded-lg px-3 py-2 text-sm ${active ? "bg-emerald-600 text-white" : "bg-neutral-800 text-neutral-300"} disabled:opacity-40`;
