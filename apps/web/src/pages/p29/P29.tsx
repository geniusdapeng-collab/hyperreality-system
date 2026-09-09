/**
 * P29 · 我的（PRD §6.2 客户域个人中心：资料/待办/权限/设备会话/安全设置/登录日志/伙伴授权）
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

interface Session { id: string; device_name: string; device_trusted: boolean; ip: string; ua: string; issued_at: string }
interface LoginEvent { kind: string; workspace_id: string | null; ip: string; device: string; created_at: string }
interface Grant { id: string; tenant_name: string; capabilities: string[]; expires_at: string }

const KIND_LABEL: Record<string, string> = {
  "login.ok": "登录成功", "login.fail": "登录失败", "login.locked": "账号锁定",
  logout: "登出", "session.revoked": "会话下线", "invite.accept": "接受邀请", "activate.ok": "开通激活",
};

export default function P29() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");

  const svc = () => trpc.accounts.my as unknown as {
    sessions: { query: () => Promise<Session[]> };
    loginEvents: { query: () => Promise<LoginEvent[]> };
    myPartnerGrants: { query: () => Promise<Grant[]> };
    revokeSession: { mutate: (i: { sessionId: string }) => Promise<{ ok: boolean }> };
    revokeAllSessions: { mutate: () => Promise<{ ok: boolean }> };
    setQuickPin: { mutate: (i: { pin: string }) => Promise<{ ok: boolean }> };
  };

  async function load() {
    await ensureDemoLogin();
    const [s, e, g] = await Promise.all([
      svc().sessions.query().catch(() => [] as Session[]),
      svc().loginEvents.query().catch(() => [] as LoginEvent[]),
      svc().myPartnerGrants.query().catch(() => [] as Grant[]),
    ]);
    setSessions(s); setEvents(e); setGrants(g);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <h1 className="text-xl font-bold">我的</h1>
      {msg && <p className="text-sm text-emerald-400">{msg}</p>}

      <section className={card}>
        <h2 className={h2}>设备与会话（{sessions.length}）</h2>
        {sessions.length === 0 && <p className={dim}>账号体系启用后，这里列出您的全部登录设备</p>}
        {sessions.map((s) => (
          <div key={s.id} className="mt-2 flex items-center justify-between rounded-lg bg-neutral-800/60 px-4 py-2 text-sm">
            <div>
              <span className="font-medium">{s.device_name || "未命名设备"}</span>
              {s.device_trusted && <span className="ml-2 rounded bg-emerald-600/20 px-1.5 text-xs text-emerald-400">信任</span>}
              <div className="text-xs text-neutral-400">{s.ip} · {new Date(s.issued_at).toLocaleString("zh-CN")}</div>
            </div>
            <button
              className="text-xs text-red-400 underline"
              onClick={() => void svc().revokeSession.mutate({ sessionId: s.id }).then(() => { setMsg("已下线该设备"); void load(); })}
            >下线</button>
          </div>
        ))}
        {sessions.length > 1 && (
          <button className="mt-3 text-xs text-red-400 underline"
            onClick={() => void svc().revokeAllSessions.mutate().then(() => { setMsg("已全部下线，请重新登录"); })}>
            全部设备下线
          </button>
        )}
      </section>

      <section className={card}>
        <h2 className={h2}>安全设置</h2>
        <div className="mt-2 flex items-center gap-2 text-sm">
          <span className="text-neutral-300">前台快切 PIN（4-6 位数字，三班倒共用电脑场景）：</span>
          <input className="w-28 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm" value={pin}
            onChange={(e) => setPin(e.target.value)} placeholder="新 PIN" />
          <button className="rounded bg-emerald-600 px-3 py-1 text-sm text-white"
            onClick={() => void svc().setQuickPin.mutate({ pin }).then(() => setMsg("PIN 已更新")).catch((e) => setMsg(e instanceof Error ? e.message : "失败"))}>
            设置
          </button>
        </div>
      </section>

      <section className={card}>
        <h2 className={h2}>登录日志（近 20 条）</h2>
        {events.length === 0 && <p className={dim}>暂无记录</p>}
        {events.map((e, i) => (
          <div key={i} className="mt-1 flex justify-between border-b border-neutral-800 py-1.5 text-xs text-neutral-300">
            <span>{KIND_LABEL[e.kind] ?? e.kind}</span>
            <span className="text-neutral-500">{e.ip} · {new Date(e.created_at).toLocaleString("zh-CN")}</span>
          </div>
        ))}
      </section>

      <section className={card}>
        <h2 className={h2}>我的伙伴授权（代运营/外包视角）</h2>
        {grants.length === 0 && <p className={dim}>您当前没有以伙伴身份持有的授权</p>}
        {grants.map((g) => (
          <div key={g.id} className="mt-2 rounded-lg bg-neutral-800/60 px-4 py-2 text-sm">
            <span className="font-medium">{g.tenant_name}</span>
            <span className="ml-3 text-xs text-neutral-400">能力：{(g.capabilities ?? []).join("、")}</span>
            <div className="text-xs text-neutral-500">有效期至 {new Date(g.expires_at).toLocaleDateString("zh-CN")}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

const card = "rounded-xl border border-neutral-800 bg-neutral-900 p-5";
const h2 = "text-sm font-bold text-neutral-200";
const dim = "mt-2 text-xs text-neutral-500";
