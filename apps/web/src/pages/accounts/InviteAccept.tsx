/**
 * InviteAccept —— 接受成员邀请（PRD §4.2：输手机号+邀请码 → 绑定成员身份 → 直接进入）
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { trpc, setToken, setRefreshToken } from "../../lib/trpc";

const WS = (import.meta.env.VITE_DEMO_WORKSPACE as string | undefined) ?? "yunqi-hotel";

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
      const r = await svc.acceptInvite.mutate({ phone, code, workspaceSlug: WS, displayName: name || undefined });
      setToken(r.accessToken); setRefreshToken(r.refreshToken);
      nav("/p28");
    } catch (e) { setErr(e instanceof Error ? e.message : "接受邀请失败"); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
      <h1 className="mb-1 text-2xl font-bold">接受邀请</h1>
      <p className="mb-6 text-sm text-neutral-400">输入邀请短信中的 6 位邀请码，加入工作区 <code className="text-emerald-400">{WS}</code></p>
      <div className="space-y-3">
        <input className={inp} placeholder="您的称呼" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={inp} placeholder="手机号（与邀请一致）" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input className={inp} placeholder="6 位邀请码" value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
      <button className={`${btn} mt-5 w-full`} disabled={busy} onClick={() => void submit()}>加入工作区</button>
      <button className="mt-4 text-sm text-neutral-400 underline" onClick={() => nav("/login")}>去登录</button>
    </div>
  );
}

const inp = "w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-emerald-500";
const btn = "rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-40";
