/**
 * P31 · 伙伴授权（owner：登记伙伴/签发授权/吊销 + 一次性工单通行证）
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

interface Grant {
  id: string; partner_name: string; partner_type: string; capabilities: string[];
  workspaces: string[]; expires_at: string; revoked_at: string | null; revoke_reason: string | null;
}

const TYPE_LABEL: Record<string, string> = { agency: "代运营/托管", contractor: "外包", observer: "观察者" };
const CAP_LABEL: Record<string, string> = {
  "ticket.handle": "工单处理", "ops.execute": "日常执行", "report.view": "经营报表",
  "deliverable.view": "交付物查看", "workorder.self": "仅本人工单",
};

export default function P31() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [pName, setPName] = useState("");
  const [pPhone, setPPhone] = useState("");
  const [pType, setPType] = useState("agency");
  const [partnerId, setPartnerId] = useState("");
  const [caps, setCaps] = useState<string[]>(["ticket.handle", "report.view"]);
  const [ttl, setTtl] = useState(90);
  const [msg, setMsg] = useState("");

  const admin = () => trpc.accounts.admin as unknown as {
    registerPartner: { mutate: (i: { name: string; type: string; contactPhone: string }) => Promise<{ partnerId: string }> };
    issueGrant: { mutate: (i: { partnerId: string; workspaces: string[]; capabilities: string[]; ttlDays: number }) => Promise<{ grantId: string }> };
    grants: { query: () => Promise<Grant[]> };
    revokeGrant: { mutate: (i: { grantId: string; reason: string }) => Promise<{ ok: boolean }> };
    issueWorkorderPass: { mutate: (i: { phone: string; name: string; ticketId: string }) => Promise<{ passCode: string }> };
  };

  async function load() {
    await ensureDemoLogin();
    const g = await admin().grants.query().catch(() => [] as Grant[]);
    setGrants(g);
  }
  useEffect(() => { void load(); }, []);

  const toggleCap = (c: string) => setCaps(caps.includes(c) ? caps.filter((x) => x !== c) : [...caps, c]);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <h1 className="text-xl font-bold">伙伴授权</h1>
      <p className="text-sm text-neutral-400">代运营/托管/外包/观察者——授权由您签发、随时可吊销，伙伴的每一个动作都记录在案</p>
      {msg && <p className="text-sm text-emerald-400">{msg}</p>}

      <section className={card}>
        <h2 className={h2}>① 登记伙伴</h2>
        <div className="mt-3 flex gap-2">
          <input className={inp} placeholder="伙伴名称（如：安心代运营）" value={pName} onChange={(e) => setPName(e.target.value)} />
          <input className={inp} placeholder="对接人手机号" value={pPhone} onChange={(e) => setPPhone(e.target.value)} />
          <select className={inp} value={pType} onChange={(e) => setPType(e.target.value)}>
            <option value="agency">代运营/托管</option><option value="contractor">外包</option><option value="observer">观察者</option>
          </select>
          <button className={btn} onClick={() => void admin().registerPartner.mutate({ name: pName, type: pType, contactPhone: pPhone })
            .then((r) => { setPartnerId(r.partnerId); setMsg(`已登记：${r.partnerId}`); })
            .catch((e) => setMsg(e instanceof Error ? e.message : "失败"))}>登记</button>
        </div>
      </section>

      <section className={card}>
        <h2 className={h2}>② 签发授权 {partnerId && <span className="text-xs text-emerald-400">（当前伙伴 {partnerId}）</span>}</h2>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {["ticket.handle", "ops.execute", "report.view", "deliverable.view"].map((c) => (
            <button key={c} onClick={() => toggleCap(c)}
              className={`rounded-full border px-3 py-1 ${caps.includes(c) ? "border-emerald-500 bg-emerald-600/20 text-emerald-300" : "border-neutral-700 text-neutral-400"}`}>
              {CAP_LABEL[c]}
            </button>
          ))}
          <select className={inp} value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            <option value={30}>30 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>一年</option>
          </select>
          <button className={btn} disabled={!partnerId} onClick={() => void admin().issueGrant.mutate({ partnerId, workspaces: [], capabilities: caps, ttlDays: ttl })
            .then(() => { setMsg("授权已签发并生效"); void load(); })
            .catch((e) => setMsg(e instanceof Error ? e.message : "失败"))}>签发</button>
        </div>
        <p className="mt-2 text-xs text-neutral-500">纪律：资金类能力永不对伙伴开放；吊销即时生效；伙伴动作在您店里逐条可见</p>
      </section>

      <section className={card}>
        <h2 className={h2}>授权台账（{grants.length}）</h2>
        {grants.map((g) => (
          <div key={g.id} className="mt-2 rounded-lg bg-neutral-800/60 px-4 py-3 text-sm">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{g.partner_name}</span>
                <span className="ml-2 rounded bg-neutral-700 px-1.5 text-xs">{TYPE_LABEL[g.partner_type]}</span>
                {g.revoked_at && <span className="ml-2 rounded bg-red-900/40 px-1.5 text-xs text-red-300">已吊销</span>}
              </div>
              {!g.revoked_at && (
                <button className="text-xs text-red-400 underline"
                  onClick={() => void admin().revokeGrant.mutate({ grantId: g.id, reason: "owner 手动吊销" }).then(() => { setMsg("已吊销"); void load(); })}>
                  吊销
                </button>
              )}
            </div>
            <div className="mt-1 text-xs text-neutral-400">
              能力：{(g.capabilities ?? []).map((c) => CAP_LABEL[c] ?? c).join("、")} · 有效期至 {new Date(g.expires_at).toLocaleDateString("zh-CN")}
              {g.revoke_reason && ` · 吊销原因：${g.revoke_reason}`}
            </div>
          </div>
        ))}
        {grants.length === 0 && <p className="mt-2 text-xs text-neutral-500">暂无授权——登记伙伴并签发后出现在这里</p>}
      </section>
    </div>
  );
}

const card = "rounded-xl border border-neutral-800 bg-neutral-900 p-5";
const h2 = "text-sm font-bold text-neutral-200";
const inp = "rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm";
const btn = "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white disabled:opacity-40";
