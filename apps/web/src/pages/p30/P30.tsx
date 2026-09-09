/**
 * P30 · 成员管理（owner/manager：邀请/移除/改角色 + 审批模板 + API 密钥）
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

interface Member { id: string; memberNo: string; name: string; role: string; status?: string }
interface Policy { action_class: string; fence_level: string; approver_rule: Record<string, unknown> }
interface ApiKey { id: string; name: string; key_prefix: string; capabilities: string[]; last_used_at: string | null; revoked_at: string | null }

const CLASS_LABEL: Record<string, string> = { daily: "日常执行", business: "经营敏感", finance: "资金相关", redline: "红线" };
const LEVEL_COLOR: Record<string, string> = { auto: "text-emerald-400", review: "text-amber-400", block: "text-red-400" };

export default function P30() {
  const [members, setMembers] = useState<Member[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("staff");
  const [inviteCode, setInviteCode] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keyName, setKeyName] = useState("");
  const [msg, setMsg] = useState("");

  const admin = () => trpc.accounts.admin as unknown as {
    invite: { mutate: (i: { phone: string; name: string; role: string }) => Promise<{ inviteCode: string }> };
    remove: { mutate: (i: { memberId: string }) => Promise<{ ok: boolean }> };
    updateRole: { mutate: (i: { memberId: string; role: string }) => Promise<{ ok: boolean }> };
    approvalPolicies: { query: () => Promise<Policy[]> };
    applyApprovalTemplate: { mutate: (i: { archetype: string }) => Promise<{ applied: number }> };
    apiKeys: { query: () => Promise<ApiKey[]> };
    createApiKey: { mutate: (i: { name: string; capabilities: string[] }) => Promise<{ plainKey: string }> };
    revokeApiKey: { mutate: (i: { keyId: string }) => Promise<{ ok: boolean }> };
  };
  const memberSvc = () => trpc.members as unknown as { list: { query: () => Promise<Member[]> } };

  async function load() {
    await ensureDemoLogin();
    const [m, p, k] = await Promise.all([
      memberSvc().list.query().catch(() => [] as Member[]),
      admin().approvalPolicies.query().catch(() => [] as Policy[]),
      admin().apiKeys.query().catch(() => [] as ApiKey[]),
    ]);
    setMembers(m.filter((x) => x.status !== "removed")); setPolicies(p); setKeys(k);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <h1 className="text-xl font-bold">成员管理</h1>
      {msg && <p className="text-sm text-emerald-400">{msg}</p>}

      <section className={card}>
        <h2 className={h2}>邀请成员</h2>
        <div className="mt-3 flex gap-2">
          <input className={inp} placeholder="姓名" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={inp} placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <select className={inp} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="staff">员工</option><option value="manager">店长</option>
            <option value="readonly">查看</option><option value="owner">老板</option>
          </select>
          <button className={btn} onClick={() => void admin().invite.mutate({ phone, name, role })
            .then((r) => { setInviteCode(r.inviteCode); setMsg("邀请已发送"); void load(); })
            .catch((e) => setMsg(e instanceof Error ? e.message : "失败"))}>邀请</button>
        </div>
        {inviteCode && <p className="mt-2 text-xs text-amber-400">开发通道邀请码：{inviteCode}（生产经短信送达）</p>}
      </section>

      <section className={card}>
        <h2 className={h2}>成员（{members.length}）</h2>
        {members.map((m) => (
          <div key={m.id} className="mt-2 flex items-center justify-between rounded-lg bg-neutral-800/60 px-4 py-2 text-sm">
            <div>
              <span className="font-medium">{m.name}</span>
              <span className="ml-2 text-xs text-neutral-400">{m.memberNo} · {m.role}</span>
            </div>
            <div className="flex gap-3 text-xs">
              <select className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5" value={m.role}
                onChange={(e) => void admin().updateRole.mutate({ memberId: m.id, role: e.target.value }).then(() => { setMsg("角色已更新"); void load(); })}>
                <option value="owner">owner</option><option value="manager">manager</option>
                <option value="staff">staff</option><option value="readonly">readonly</option>
              </select>
              <button className="text-red-400 underline"
                onClick={() => void admin().remove.mutate({ memberId: m.id }).then(() => { setMsg("已移除"); void load(); }).catch((e) => setMsg(e instanceof Error ? e.message : "失败"))}>
                移除
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className={card}>
        <h2 className={h2}>审批策略（业态模板）</h2>
        <div className="mt-2 flex gap-2 text-xs">
          <button className={chip} onClick={() => void admin().applyApprovalTemplate.mutate({ archetype: "single" }).then(() => { setMsg("已应用民宿一人店模板"); void load(); })}>民宿一人店</button>
          <button className={chip} onClick={() => void admin().applyApprovalTemplate.mutate({ archetype: "unmanned" }).then(() => { setMsg("已应用无人酒店模板"); void load(); })}>无人酒店</button>
          <button className={chip} onClick={() => void admin().applyApprovalTemplate.mutate({ archetype: "group-store" }).then(() => { setMsg("已应用集团门店模板"); void load(); })}>集团门店</button>
        </div>
        {policies.map((p) => (
          <div key={p.action_class} className="mt-2 flex justify-between border-b border-neutral-800 py-1.5 text-sm">
            <span>{CLASS_LABEL[p.action_class] ?? p.action_class}</span>
            <span className={LEVEL_COLOR[p.fence_level]}>{p.fence_level}</span>
          </div>
        ))}
      </section>

      <section className={card}>
        <h2 className={h2}>API 密钥（系统对接）</h2>
        <div className="mt-2 flex gap-2">
          <input className={inp} placeholder="密钥名称（如：PMS 对接）" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <button className={btn} onClick={() => void admin().createApiKey.mutate({ name: keyName, capabilities: ["read:*"] })
            .then((r) => { setNewKey(r.plainKey); void load(); }).catch((e) => setMsg(e instanceof Error ? e.message : "失败"))}>签发</button>
        </div>
        {newKey && <p className="mt-2 break-all rounded bg-amber-900/30 p-2 text-xs text-amber-300">请立即保存（只显示一次）：{newKey}</p>}
        {keys.map((k) => (
          <div key={k.id} className="mt-2 flex items-center justify-between rounded-lg bg-neutral-800/60 px-4 py-2 text-sm">
            <div>
              <span className="font-medium">{k.name}</span>
              <span className="ml-2 text-xs text-neutral-400">{k.key_prefix}… · {k.last_used_at ? `最近用 ${new Date(k.last_used_at).toLocaleDateString("zh-CN")}` : "未使用"}</span>
            </div>
            {!k.revoked_at && <button className="text-xs text-red-400 underline"
              onClick={() => void admin().revokeApiKey.mutate({ keyId: k.id }).then(() => { setMsg("已吊销"); void load(); })}>吊销</button>}
          </div>
        ))}
      </section>
    </div>
  );
}

const card = "rounded-xl border border-neutral-800 bg-neutral-900 p-5";
const h2 = "text-sm font-bold text-neutral-200";
const inp = "rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm";
const btn = "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white";
const chip = "rounded-full border border-neutral-700 px-3 py-1 hover:border-emerald-500";
