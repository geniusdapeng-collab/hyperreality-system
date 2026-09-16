import { useState } from "react";
import { AsyncState, Button, Card } from "@workloom/ui";
import { enterGuest, savedWorkspace, setSession, trpc } from "./lib/trpc";
import { safeMessage } from "./lib/useResource";

export function Auth({ onReady }: { onReady: () => void }) {
  const [workspace, setWorkspace] = useState(savedWorkspace());
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<"code" | "login" | "guest" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function sendCode() {
    if (busy) return;
    setBusy("code"); setError(""); setNotice("");
    try {
      const result = await trpc.accounts.auth.requestCode.mutate({ channel: "phone", target: phone, purpose: "login" });
      if (!result.sent) {
        setSent(false);
        setError("验证码未发送，请检查手机号后重试。");
        return;
      }
      setSent(true);
      setNotice("验证码发送服务已确认受理，请查收后继续登录。");
      if (import.meta.env.DEV && result.devCode) setDevCode(result.devCode); else setDevCode("");
    } catch (cause) { setError(safeMessage(cause)); }
    finally { setBusy(null); }
  }

  async function login() {
    if (busy) return;
    setBusy("login"); setError(""); setNotice("");
    try {
      const result = await trpc.accounts.auth.loginWithCode.mutate({
        phone,
        code,
        workspaceSlug: workspace,
        device: "B 端移动客户端",
      });
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, workspaceSlug: workspace });
      onReady();
    } catch (cause) { setError(safeMessage(cause)); }
    finally { setBusy(null); }
  }

  async function guest() {
    if (busy) return;
    setBusy("guest"); setError(""); setNotice("");
    try { await enterGuest(); onReady(); }
    catch (cause) { setError(safeMessage(cause)); }
    finally { setBusy(null); }
  }

  return (
    <main className="auth-page" data-workloom-client="b-mobile">
      <Card className="auth-card">
        <p className="eyebrow">B 端移动工作台</p>
        <h1>登录 WorkLoom</h1>
        <p className="muted">审批、任务、夜班交接和经营结果会使用与 PC 相同的工作区数据。</p>
        <label>工作区识别码<input value={workspace} disabled={Boolean(busy)} onChange={(event) => setWorkspace(event.target.value)} autoComplete="organization" /></label>
        <label>手机号<input value={phone} disabled={Boolean(busy)} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" /></label>
        <div className="inline-fields">
          <label>验证码<input value={code} disabled={Boolean(busy)} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></label>
          <Button onClick={() => void sendCode()} busy={busy === "code"} disabled={phone.length < 6 || Boolean(busy)}>{sent ? "重新发送" : "发送验证码"}</Button>
        </div>
        {devCode && <p className="dev-note">本机开发验证码：{devCode}</p>}
        {notice && <p className="status-strip" role="status">{notice}</p>}
        {error && <AsyncState status="error" title="登录未完成" description={error} />}
        <Button variant="primary" onClick={() => void login()} busy={busy === "login"} disabled={workspace.length < 3 || code.length !== 6 || Boolean(busy)}>登录工作区</Button>
        <Button variant="quiet" onClick={() => void guest()} busy={busy === "guest"} disabled={Boolean(busy)}>体验只读示例</Button>
        <p className="fine-print">示例不会执行审批、外发或正式经营动作；正式账号请使用受邀手机号登录。</p>
      </Card>
    </main>
  );
}
