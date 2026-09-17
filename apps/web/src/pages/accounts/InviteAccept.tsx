/**
 * InviteAccept —— 接受成员邀请（PRD §4.2：输手机号+邀请码 → 绑定成员身份 → 直接进入）
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@workloom/ui";
import { trpc, setToken, setRefreshToken } from "../../lib/trpc";
import { DEMO_WORKSPACE } from "../../lib/product";

function safeInviteError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("邀请码") || message.includes("验证码")) return "邀请码不正确、已过期或已被使用，请向邀请人重新获取。";
  if (message.includes("手机号")) return "手机号与邀请记录不一致，请检查后重试。";
  if (message.includes("工作区") || message.includes("权限")) return "暂时无法加入该工作区，请联系邀请人确认权限。";
  return "加入尚未完成，请检查信息后重试。";
}

export default function InviteAccept() {
  const nav = useNavigate();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(""); setBusy(true);
    try {
      const svc = trpc.accounts.auth as unknown as {
        acceptInvite: { mutate: (i: { phone: string; code: string; workspaceSlug: string; displayName?: string }) => Promise<{ accessToken: string; refreshToken: string }> };
      };
      const r = await svc.acceptInvite.mutate({ phone, code, workspaceSlug: DEMO_WORKSPACE, displayName: name || undefined });
      setToken(r.accessToken); setRefreshToken(r.refreshToken);
      nav("/inbox");
    } catch (e) { setErr(safeInviteError(e)); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col justify-center px-4 py-10 sm:px-6">
      <h1 className="mb-1 break-words text-2xl font-bold">接受邀请</h1>
      <p className="mb-6 break-words text-body leading-relaxed text-neutral-300">输入邀请消息中的 6 位邀请码；验证成功后会自动加入邀请指定的工作区。</p>
      <div className="min-w-0 space-y-3">
        <input className={inp} autoComplete="name" aria-label="您的称呼" placeholder="您的称呼" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={inp} inputMode="tel" autoComplete="tel" aria-label="手机号" placeholder="手机号（与邀请一致）" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input className={inp} inputMode="numeric" autoComplete="one-time-code" aria-label="邀请码" maxLength={6} placeholder="6 位邀请码" value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      {err && <p role="alert" className="mt-3 break-words text-body leading-relaxed text-red-300">{err}</p>}
      <Button className="mt-5 w-full" variant="primary" busy={busy} busyLabel="正在加入…" disabled={phone.length < 6 || code.length !== 6} onClick={() => void submit()}>加入工作区</Button>
      <Button className="mt-4 text-neutral-300 underline" variant="quiet" onClick={() => nav("/login")}>去登录</Button>
    </main>
  );
}

const inp = "min-h-11 w-full min-w-0 rounded-lg border border-neutral-600 bg-neutral-900 px-3 py-2 text-body text-neutral-100 outline-none placeholder:text-neutral-400 focus:border-blue-400";
