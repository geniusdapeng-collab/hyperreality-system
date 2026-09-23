/** P31 · 伙伴授权：明确租户/工作区边界、能力、期限和吊销原因。 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AsyncState, Button, Input, Overlay } from "@workloom/ui";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { capabilityText } from "../../lib/display";
import { operationFailure, toUiFailure } from "../../lib/ui-state";
import { useNavigationAccess } from "../../shell/NavigationAccess";

interface Grant {
  id: string; partner_id?: string; partner_name: string; partner_type: string; capabilities: string[];
  workspaces: string[]; expires_at: string; revoked_at: string | null; revoke_reason: string | null;
}
interface Membership { workspace_id: string; workspace_name: string; tenant_id: string; tenant_name: string; role: string }
type PendingAction = { kind: "register" } | { kind: "grant" } | { kind: "revoke"; grant: Grant };

const TYPE_LABEL: Record<string, string> = { agency: "代运营或托管", contractor: "外包服务", observer: "只读观察" };
const AVAILABLE_CAPABILITIES = ["ticket.handle", "ops.execute", "report.view", "deliverable.view"] as const;

export default function P31() {
  const { canAction, scope } = useNavigationAccess();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadMessage, setLoadMessage] = useState("");
  const [pName, setPName] = useState("");
  const [pPhone, setPPhone] = useState("");
  const [pType, setPType] = useState("agency");
  const [partnerId, setPartnerId] = useState("");
  const [caps, setCaps] = useState<string[]>(["ticket.handle", "report.view"]);
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);
  const [ttl, setTtl] = useState(90);
  const [revokeReason, setRevokeReason] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [dangerCode, setDangerCode] = useState("");
  const [dangerChallenge, setDangerChallenge] = useState<{ maskedTarget: string; devCode?: string } | null>(null);
  const [challengeBusy, setChallengeBusy] = useState(false);

  const admin = () => trpc.accounts.admin as unknown as {
    registerPartner: { mutate: (i: { name: string; type: string; contactPhone: string }) => Promise<{ partnerId: string }> };
    issueGrant: { mutate: (i: { partnerId: string; workspaces: string[]; capabilities: string[]; ttlDays: number; dangerCode: string }) => Promise<{ grantId: string }> };
    grants: { query: () => Promise<Grant[]> };
    revokeGrant: { mutate: (i: { grantId: string; reason: string; dangerCode: string }) => Promise<{ ok: boolean }> };
  };
  const my = () => trpc.accounts.my as unknown as {
    requestDangerCode: { mutate: (i: { action: "partner.grant.issue" | "partner.grant.revoke" }) => Promise<{ sent: boolean; maskedTarget: string; devCode?: string }> };
  };

  const load = useCallback(async (background = false) => {
    if (!background) setLoadState("loading");
    try {
      await ensureDemoLogin();
      const [membershipRows, grantRows] = await Promise.all([
        trpc.accounts.my.memberships.query() as unknown as Promise<Membership[]>,
        admin().grants.query(),
      ]);
      const sameTenant = membershipRows.filter((item) => item.tenant_id === scope?.tenantId);
      setMemberships(sameTenant);
      setGrants(grantRows);
      setSelectedWorkspaces((current) => current.filter((id) => sameTenant.some((item) => item.workspace_id === id)));
      setHasSnapshot(true);
      setLoadMessage("");
      setLoadState("ready");
    } catch (error) {
      console.warn("读取伙伴授权数据失败", error);
      const failure = toUiFailure(error);
      setLoadMessage(operationFailure(error, "读取伙伴授权数据"));
      setLoadState(failure.kind === "forbidden" ? "forbidden" : "error");
    }
  }, [scope?.tenantId]);

  useEffect(() => { void load(); }, [load]);

  const canManage = loadState === "ready" && canAction("partner.manage");
  const workspaceNames = useMemo(() => new Map(memberships.map((item) => [item.workspace_id, item.workspace_name])), [memberships]);
  const toggleCap = (capability: string) => setCaps((current) => current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability]);
  const toggleWorkspace = (workspaceId: string) => setSelectedWorkspaces((current) => current.includes(workspaceId) ? current.filter((item) => item !== workspaceId) : [...current, workspaceId]);

  const closePending = () => {
    setPendingAction(null);
    setRevokeReason("");
    setDangerCode("");
    setDangerChallenge(null);
  };

  const requestDangerChallenge = async () => {
    if (!pendingAction || pendingAction.kind === "register" || challengeBusy || busy) return;
    setChallengeBusy(true);
    setNotice(null);
    try {
      const result = await my().requestDangerCode.mutate({ action: pendingAction.kind === "grant" ? "partner.grant.issue" : "partner.grant.revoke" });
      const developmentCode = import.meta.env.DEV ? result.devCode : undefined;
      setDangerChallenge({ maskedTarget: result.maskedTarget, devCode: developmentCode });
      if (developmentCode) setDangerCode(developmentCode);
      setNotice({ tone: "success", text: `身份验证码已发送至 ${result.maskedTarget}，5 分钟内有效且只能使用一次。` });
    } catch (error) {
      console.warn("发送身份验证码失败", error);
      setNotice({ tone: "error", text: operationFailure(error, "身份验证") });
    } finally {
      setChallengeBusy(false);
    }
  };

  const executePending = async () => {
    const action = pendingAction;
    if (!action || !canManage || busy) return;
    if (action.kind !== "register" && (!dangerChallenge || !/^\d{6}$/.test(dangerCode))) return;
    setBusy(true);
    setNotice(null);
    try {
      if (action.kind === "register") {
        const result = await admin().registerPartner.mutate({ name: pName.trim(), type: pType, contactPhone: pPhone.trim() });
        setPartnerId(result.partnerId);
        setNotice({ tone: "success", text: "服务端已登记伙伴。当前尚未签发任何工作区权限。" });
      } else if (action.kind === "grant") {
        await admin().issueGrant.mutate({ partnerId, workspaces: selectedWorkspaces, capabilities: caps, ttlDays: ttl, dangerCode });
        setNotice({ tone: "success", text: `服务端已签发授权，仅覆盖所选 ${selectedWorkspaces.length} 个工作区。` });
        setSelectedWorkspaces([]);
      } else {
        await admin().revokeGrant.mutate({ grantId: action.grant.id, reason: revokeReason.trim(), dangerCode });
        setNotice({ tone: "success", text: `服务端已确认吊销“${action.grant.partner_name}”的授权；历史动作与吊销原因已保留。` });
        setRevokeReason("");
      }
      closePending();
      await load(true);
    } catch (error) {
      console.warn("伙伴授权操作失败", error);
      const label = action.kind === "register" ? "伙伴登记" : action.kind === "grant" ? "授权签发" : "授权吊销";
      setNotice({ tone: "error", text: operationFailure(error, label) });
    } finally {
      setBusy(false);
    }
  };

  if (!hasSnapshot) {
    return <div className="mx-auto max-w-3xl px-6 py-16"><AsyncState status={loadState === "forbidden" ? "forbidden" : loadState === "error" ? "error" : "loading"} title={loadState === "loading" ? "正在确认伙伴授权边界" : undefined} description={loadMessage || "公司与工作区范围确认完成前，不会开放授权操作。"} onRetry={loadState === "error" ? () => void load() : undefined} /></div>;
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-8 px-3 py-8 sm:px-6">
      <div className="min-w-0 break-words"><h1 className="text-xl font-bold">伙伴授权</h1><p className="mt-1 text-sm text-neutral-400">授权必须明确选择工作区、能力和有效期；伙伴的动作与吊销记录均可追溯。</p></div>
      {loadState !== "ready" && <Notice tone="warning">{loadMessage} 正在显示上一次成功快照，授权操作已暂停。</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {!canManage && loadState === "ready" && <Notice tone="warning">当前角色只能查看伙伴授权，签发和吊销仅限工作区负责人。</Notice>}

      <section className={card}>
        <h2 className={h2}>第一步：登记伙伴</h2>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <input className={inp} placeholder="伙伴名称" value={pName} disabled={!canManage || busy} onChange={(event) => setPName(event.target.value)} />
          <input className={inp} placeholder="对接人手机号" value={pPhone} disabled={!canManage || busy} onChange={(event) => setPPhone(event.target.value)} />
          <select className={inp} value={pType} disabled={!canManage || busy} onChange={(event) => setPType(event.target.value)}><option value="agency">代运营或托管</option><option value="contractor">外包服务</option><option value="observer">只读观察</option></select>
          <Button variant="primary" disabled={!canManage || busy || !pName.trim() || pPhone.trim().length < 6} onClick={() => setPendingAction({ kind: "register" })}>预览登记</Button>
        </div>
      </section>

      <section className={card}>
        <h2 className={h2}>第二步：签发授权 {partnerId && <span className="text-body font-normal text-emerald-400">伙伴已登记，待签发</span>}</h2>
        <fieldset className="mt-4" disabled={!canManage || busy}><legend className="text-body font-semibold text-neutral-300">选择工作区（至少一项）</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{memberships.map((item) => <label key={item.workspace_id} className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm"><input type="checkbox" checked={selectedWorkspaces.includes(item.workspace_id)} onChange={() => toggleWorkspace(item.workspace_id)} /><span className="min-w-0 break-words">{item.workspace_name}</span><span className="ml-auto text-body text-neutral-500">{item.tenant_name}</span></label>)}</div>{memberships.length === 0 && <p className="mt-2 text-body text-red-300">当前账号在本公司没有可授权工作区，签发已阻断。</p>}</fieldset>
        <fieldset className="mt-4 min-w-0" disabled={!canManage || busy}><legend className="break-words text-body font-semibold text-neutral-300">选择伙伴能力（至少一项）</legend><div className="mt-2 flex min-w-0 flex-wrap gap-2">{AVAILABLE_CAPABILITIES.map((capability) => <button type="button" key={capability} onClick={() => toggleCap(capability)} className={`max-w-full whitespace-normal break-words rounded-full border px-3 py-1 text-sm ${caps.includes(capability) ? "border-emerald-500 bg-emerald-600/20 text-emerald-300" : "border-neutral-700 text-neutral-400"}`}>{capabilityText(capability)}</button>)}</div></fieldset>
        <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
          <label className="flex max-w-full min-w-0 flex-wrap items-center gap-2 text-body text-neutral-300">
            <span>有效期</span>
            <select className="max-w-full min-w-0 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100" value={ttl} disabled={!canManage || busy} onChange={(event) => setTtl(Number(event.target.value))}><option value={30}>30 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>一年</option></select>
          </label>
          <Button variant="primary" disabled={!canManage || busy || !partnerId || selectedWorkspaces.length === 0 || caps.length === 0} onClick={() => setPendingAction({ kind: "grant" })}>预览并签发</Button>
        </div>
        <p className="mt-3 text-body text-neutral-500">资金相关能力不向伙伴开放；空工作区范围会被客户端和服务端同时拒绝。</p>
      </section>

      <section className={card}>
        <h2 className={h2}>授权台账（{grants.length}）</h2>
        {grants.length === 0 ? <p className="mt-3 text-body text-neutral-500">当前公司暂无伙伴授权。</p> : grants.map((grant) => (
          <article key={grant.id} className="mt-2 rounded-lg bg-neutral-800/60 px-4 py-3 text-sm">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3"><div className="min-w-0"><span className="font-medium break-words">{grant.partner_name}</span><span className="ml-2 rounded bg-neutral-700 px-1.5 text-body">{TYPE_LABEL[grant.partner_type] ?? "其他伙伴"}</span>{grant.revoked_at && <span className="ml-2 rounded bg-red-900/40 px-1.5 text-body text-red-300">已吊销</span>}</div>{canManage && !grant.revoked_at && <button disabled={busy} className="text-body text-red-400 underline disabled:opacity-40" onClick={() => { setRevokeReason(""); setPendingAction({ kind: "revoke", grant }); }}>吊销</button>}</div>
            <div className="mt-2 text-body leading-relaxed text-neutral-400">工作区：{grant.workspaces?.length ? grant.workspaces.map((id) => workspaceNames.get(id) ?? "已授权工作区").join("、") : "范围异常，已提示管理员复核"}<br />能力：{grant.capabilities?.length ? grant.capabilities.map(capabilityText).join("、") : "未配置"} · 有效期至 {formatDate(grant.expires_at)}{grant.revoke_reason && <><br />吊销原因：{grant.revoke_reason}</>}</div>
          </article>
        ))}
      </section>

      <Overlay open={pendingAction !== null} title={pendingAction ? actionTitle(pendingAction) : "确认伙伴操作"} description="提交前请复核公司与工作区边界；敏感授权还需当前账号再次验证。" onClose={() => { if (!busy) closePending(); }} dismissOnBackdrop={!busy} dismissOnEscape={!busy} footer={<><Button variant="quiet" disabled={busy} onClick={closePending}>取消</Button><Button variant={pendingAction?.kind === "revoke" ? "danger" : "primary"} busy={busy} disabled={(pendingAction?.kind === "revoke" && revokeReason.trim().length < 2) || (pendingAction?.kind !== "register" && (!dangerChallenge || !/^\d{6}$/.test(dangerCode)))} onClick={() => void executePending()}>{pendingAction?.kind === "register" ? "确认登记" : "验证并提交"}</Button></>}>
        {pendingAction?.kind === "register" && <p>将登记“{pName.trim()}”为{TYPE_LABEL[pType] ?? "伙伴"}，对接手机号为 {pPhone.trim()}。登记本身不授予任何工作区权限。</p>}
        {pendingAction?.kind === "grant" && <div className="space-y-2"><p>伙伴：刚刚登记并确认的伙伴</p><p>工作区：{selectedWorkspaces.map((id) => workspaceNames.get(id) ?? "已选工作区").join("、")}</p><p>能力：{caps.map(capabilityText).join("、")}</p><p>有效期：{ttl} 天。到期后授权自动失效。</p></div>}
        {pendingAction?.kind === "revoke" && <div className="space-y-3"><p>将立即撤销“{pendingAction.grant.partner_name}”对 {pendingAction.grant.workspaces.length} 个工作区的访问能力。历史记录不会删除。</p><label className="block text-sm">吊销原因（必填）<textarea rows={3} maxLength={200} value={revokeReason} disabled={busy} onChange={(event) => setRevokeReason(event.target.value)} className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2" /></label></div>}
        {pendingAction && pendingAction.kind !== "register" && <div className="mt-4 rounded-lg border border-neutral-700 bg-neutral-950/50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold">身份再确认</p><p className="text-body text-neutral-400">验证码只发送到当前账号绑定手机号，并且只能使用一次。</p></div><Button variant="quiet" busy={challengeBusy} disabled={busy} onClick={() => void requestDangerChallenge()}>{dangerChallenge ? "重新发送" : "发送身份验证码"}</Button></div>
          {dangerChallenge && <Input label="6 位身份验证码" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={dangerCode} disabled={busy} onChange={(event) => setDangerCode(event.target.value.replace(/\D/g, "").slice(0, 6))} description={`已发送至 ${dangerChallenge.maskedTarget}${import.meta.env.DEV && dangerChallenge.devCode ? "；当前为开发验证通道" : ""}`} wrapperClassName="mt-3" />}
        </div>}
      </Overlay>
    </div>
  );
}

function actionTitle(action: PendingAction): string {
  if (action.kind === "register") return "确认登记伙伴";
  if (action.kind === "grant") return "确认签发伙伴授权";
  return "确认吊销伙伴授权";
}

function Notice({ tone, children }: { tone: "success" | "error" | "warning"; children: ReactNode }) {
  const cls = tone === "success" ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-300" : tone === "error" ? "border-red-500/50 bg-red-950/30 text-red-300" : "border-amber-500/40 bg-amber-950/30 text-amber-300";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${cls}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待确认" : date.toLocaleDateString("zh-CN");
}

const card = "min-w-0 break-words rounded-xl border border-neutral-800 bg-neutral-900 p-5";
const h2 = "break-words text-sm font-bold text-neutral-200";
const inp = "w-full max-w-full min-w-0 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100";
