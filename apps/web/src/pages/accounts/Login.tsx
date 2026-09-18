/**
 * Login —— 登录页（PRD §4.1：扫码主通道占位 + 手机验证码 + 邮箱密码 + 注册开通/接受邀请入口）
 * 演示入口（loginAs）仅开发环境展示；生产不出现。
 */
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@workloom/ui";
import { trpc, setToken, setRefreshToken, ensureDemoLogin, DEV_DEMO_MEMBER, clearGuestFlag } from "../../lib/trpc";
import { DEMO_WORKSPACE, PRODUCT_NAME } from "../../lib/product";

type Tab = "code" | "password";

function safeLoginError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("验证码")) return "验证码不正确、已过期或发送次数已达上限，请重新获取。";
  if (message.includes("密码") || message.includes("账号") || message.includes("邮箱")) return "账号或密码不正确，请检查后重试。";
  if (message.includes("工作区")) return "暂时无法进入该工作区，请联系管理员确认成员权限。";
  if (message.includes("网络") || message.includes("fetch")) return "网络连接异常，请检查网络后重试。";
  return fallback;
}

export default function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  // F-GUEST1：游客进配置引导被拦到这里时，登录成功后送回原目的地
  const next = params.get("next") || "/inbox";
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
      setDevCode(import.meta.env.DEV && r.devCode ? r.devCode : "");
    } catch (e) { setErr(safeLoginError(e, "验证码发送失败，请稍后重试。")); }
    finally { setBusy(false); }
  }

  async function doLogin() {
    setErr(""); setBusy(true);
    try {
      const r = tab === "code"
        ? await svc().loginWithCode.mutate({ phone, code, workspaceSlug: DEMO_WORKSPACE })
        : await svc().loginWithPassword.mutate({ email, password, workspaceSlug: DEMO_WORKSPACE });
      clearGuestFlag(); // 正式身份进场，摘掉游客标记
      setToken(r.accessToken);
      setRefreshToken(r.refreshToken);
      nav(next);
    } catch (e) { setErr(safeLoginError(e, "登录尚未完成，请检查信息后重试。")); }
    finally { setBusy(false); }
  }

  async function demoEnter() {
    // 开发后门（仅 DEV 展示）：以种子成员真身份进入，绕过账号体系
    await ensureDemoLogin(DEV_DEMO_MEMBER);
    nav(next);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col justify-center px-4 py-10 sm:px-6">
      {/* 游客浮标会直达本页（F-GUEST1）；登录页也必须给出可见返回出口，不能只靠浏览器后退。 */}
      <Button className="mb-4 w-fit text-neutral-300 underline" variant="quiet" onClick={() => nav("/")}>← 返回经营首页</Button>
      <h1 className="mb-1 break-words text-2xl font-bold">登录 {PRODUCT_NAME}</h1>
      <p className="mb-6 break-words text-body leading-relaxed text-neutral-300">登录后可查看并切换您有权限访问的工作区。</p>

      <div className="mb-4 flex min-w-0 flex-wrap gap-2" role="group" aria-label="登录方式">
        <Button aria-pressed={tab === "code"} variant={tab === "code" ? "primary" : "secondary"} onClick={() => setTab("code")}>手机验证码</Button>
        <Button aria-pressed={tab === "password"} variant={tab === "password" ? "primary" : "secondary"} onClick={() => setTab("password")}>邮箱密码</Button>
        <Button variant="secondary" disabled title="微信开放平台接入后开放">微信扫码（即将开放）</Button>
      </div>

      {tab === "code" ? (
        <div className="space-y-3">
          <input className={inp} inputMode="tel" autoComplete="tel" aria-label="手机号" placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input className={inp} inputMode="numeric" autoComplete="one-time-code" aria-label="验证码" maxLength={6} placeholder="6 位验证码" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button variant="primary" disabled={busy || phone.length < 6} onClick={() => void sendCode()}>
              {codeSent ? "重发" : "发送验证码"}
            </Button>
          </div>
          {import.meta.env.DEV && devCode && <p className="break-words text-body text-amber-300">本地开发验证码：{devCode}（生产环境不显示）</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <input className={inp} type="email" autoComplete="email" aria-label="邮箱" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className={inp} type="password" autoComplete="current-password" aria-label="密码" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      )}

      {err && <p role="alert" className="mt-3 break-words text-body leading-relaxed text-red-300">{err}</p>}

      <Button className="mt-5 w-full" variant="primary" busy={busy} busyLabel="正在登录…" onClick={() => void doLogin()}>登录</Button>

      <div className="mt-4 flex min-w-0 flex-wrap justify-between gap-2 text-neutral-300">
        <Button variant="quiet" onClick={() => nav("/activate")}>注册开通</Button>
        <Button variant="quiet" onClick={() => nav("/invite")}>接受成员邀请</Button>
      </div>

      {import.meta.env.DEV && (
        <Button variant="quiet" className="mt-6 text-neutral-300 underline" onClick={() => void demoEnter()}>
          开发演示：直接进入演示身份（不经过账号）
        </Button>
      )}
    </main>
  );
}

const inp = "min-h-11 w-full min-w-0 rounded-lg border border-neutral-600 bg-neutral-900 px-3 py-2 text-body text-neutral-100 outline-none placeholder:text-neutral-400 focus:border-blue-400";
