/**
 * accounts/service —— 客户域账号服务（纯函数 + db 注入，可单测）
 *
 * 设计纪律：
 *  - 登录终点仍解析为「工作区成员身份」（members 行）——既有 Identity/三守卫/RLS 零改动；
 *  - 验证码：散列存储、一次性、5 分钟有效、同目标每日 5 次、错误 5 次作废；
 *  - 账号锁定：连续失败 5 次锁 15 分钟（accounts.failed_attempts/locked_until）；
 *  - 所有登录/异常写 login_events（审计台账，查询友好）。
 */
import type { Identity } from "../tenancy/auth.js";
import type { MemberRole, PlanTier } from "@workloom/shared";
import { hashPassword, verifyPassword, hashSecret, newId, randomToken } from "./kdf.js";
import { mintRefreshToken, hashRefreshToken, signAccessToken, ACCESS_TTL_SEC, REFRESH_TTL_DAYS } from "./tokens.js";
import type { SmsSender } from "./providers.js";

export type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface AccountsDeps {
  q: QueryFn;
  sms: SmsSender;
  now?: () => number;
}

const CODE_TTL_MS = 5 * 60_000;
const CODE_DAILY_LIMIT = 5;
const CODE_MAX_ATTEMPTS = 5;
const LOGIN_FAIL_LOCK = 5;
const LOCK_MS = 15 * 60_000;

const now = (d: AccountsDeps) => (d.now ? d.now() : Date.now());

/* ================= 验证码 ================= */

export async function requestCode(
  deps: AccountsDeps,
  input: { channel: "phone" | "email"; target: string; purpose: "login" | "activate" | "invite" | "danger-confirm"; ip?: string },
): Promise<{ sent: boolean; devCode?: string }> {
  const { q, sms } = deps;
  const dayAgo = new Date(now(deps) - 24 * 3600e3).toISOString();
  const recent = await q(
    `SELECT count(*)::int AS c FROM verification_codes WHERE channel=$1 AND target=$2 AND purpose=$3 AND created_at > $4`,
    [input.channel, input.target, input.purpose, dayAgo],
  );
  if ((recent.rows[0]?.c as number) >= CODE_DAILY_LIMIT) {
    throw new Error("今日验证码发送次数已达上限（5 次），请明天再试");
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await q(
    `INSERT INTO verification_codes (id, channel, target, purpose, code_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [newId("vcode"), input.channel, input.target, input.purpose, hashSecret(code, input.target), new Date(now(deps) + CODE_TTL_MS).toISOString()],
  );
  await sms.send(input.target, `【WorkLoom】验证码 ${code}，5 分钟内有效。请勿泄露给他人。`);
  return { sent: true, devCode: process.env.NODE_ENV === "production" ? undefined : code };
}

export async function consumeCode(
  deps: AccountsDeps,
  input: { channel: "phone" | "email"; target: string; purpose: string; code: string },
): Promise<boolean> {
  const { q } = deps;
  const r = await q(
    `SELECT id, code_hash, expires_at, attempts FROM verification_codes
     WHERE channel=$1 AND target=$2 AND purpose=$3 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [input.channel, input.target, input.purpose],
  );
  const row = r.rows[0];
  if (!row) return false;
  if ((row.attempts as number) >= CODE_MAX_ATTEMPTS) return false;
  if (new Date(row.expires_at as string).getTime() < now(deps)) return false;
  if (row.code_hash !== hashSecret(input.code, input.target)) {
    await q(`UPDATE verification_codes SET attempts=attempts+1 WHERE id=$1`, [row.id]);
    return false;
  }
  await q(`UPDATE verification_codes SET consumed_at=now() WHERE id=$1`, [row.id]);
  return true;
}

/* ================= 账号解析与锁定 ================= */

async function accountByPhone(q: QueryFn, phone: string) {
  const r = await q(`SELECT * FROM accounts WHERE phone=$1`, [phone]);
  return r.rows[0] ?? null;
}
async function accountByEmail(q: QueryFn, email: string) {
  const r = await q(`SELECT * FROM accounts WHERE email=$1`, [email]);
  return r.rows[0] ?? null;
}

function assertNotLocked(acc: Record<string, unknown>, nowMs: number): void {
  if (acc.status === "disabled") throw new Error("账号已停用，请联系平台");
  if (acc.locked_until && new Date(acc.locked_until as string).getTime() > nowMs) {
    throw new Error("账号已临时锁定（连续失败次数过多），请 15 分钟后再试");
  }
}

async function recordFail(q: QueryFn, accId: string): Promise<void> {
  // PG 不允许同一列重复赋值：单表达式版（SET 表达式按更新前的值求值）
  const r = await q(
    `UPDATE accounts SET
       failed_attempts = CASE WHEN failed_attempts+1 >= $2 THEN 0 ELSE failed_attempts+1 END,
       locked_until = CASE WHEN failed_attempts+1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
     WHERE id=$1 RETURNING locked_until`,
    [accId, LOGIN_FAIL_LOCK],
  );
  if (r.rows[0]?.locked_until) throw new Error("连续失败次数过多，账号已锁定 15 分钟");
}

async function clearFail(q: QueryFn, accId: string): Promise<void> {
  await q(`UPDATE accounts SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [accId]);
}

/* ================= 会话签发与旋转 ================= */

async function issueSession(
  deps: AccountsDeps,
  input: { accountId: string; identity: Identity; device?: string; ip?: string; ua?: string; trusted?: boolean },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const refresh = mintRefreshToken();
  await deps.q(
    `INSERT INTO auth_sessions (id, account_id, refresh_token_hash, device_name, device_trusted, ip, ua, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '${REFRESH_TTL_DAYS} days')`,
    [newId("sess"), input.accountId, refresh.hash, input.device ?? "", input.trusted ?? false, input.ip ?? "", input.ua ?? ""],
  );
  const accessToken = await signAccessToken(input.identity);
  return { accessToken, refreshToken: refresh.plain, expiresIn: ACCESS_TTL_SEC };
}

/** 账号 → 某工作区的成员身份（登录终点：仍是 members 行） */
async function identityFor(q: QueryFn, accountId: string, workspaceSlug: string): Promise<Identity | null> {
  const r = await q(
    `SELECT m.id AS member_id, m.member_no, COALESCE(m.alias, m.name) AS name, m.role,
            w.tenant_id, w.id AS workspace_id, t.plan
     FROM members m
     JOIN workspaces w ON w.id = m.workspace_id
     JOIN tenants t ON t.id = w.tenant_id
     WHERE m.account_id=$1 AND w.slug=$2 AND m.status='active'`,
    [accountId, workspaceSlug],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    memberId: row.member_id as string,
    memberNo: row.member_no as string,
    name: row.name as string,
    role: row.role as MemberRole,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    plan: row.plan as PlanTier,
  };
}

/** 账号的全部有效成员关系（统一待办与切店） */
export async function listMemberships(q: QueryFn, accountId: string) {
  const r = await q(
    `SELECT m.id AS member_id, m.role, m.member_no, w.id AS workspace_id, w.slug, w.name AS workspace_name,
            w.industry, w.tenant_id, t.name AS tenant_name, t.plan
     FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN tenants t ON t.id=w.tenant_id
     WHERE m.account_id=$1 AND m.status='active' ORDER BY t.name, w.name`,
    [accountId],
  );
  return r.rows;
}

/* ================= 登录 ================= */

export async function loginWithCode(
  deps: AccountsDeps,
  input: { phone: string; code: string; workspaceSlug: string; device?: string; ip?: string; ua?: string },
) {
  const acc = await accountByPhone(deps.q, input.phone);
  if (!acc) throw new Error("该手机号尚未注册或未被邀请");
  assertNotLocked(acc, now(deps));
  const ok = await consumeCode(deps, { channel: "phone", target: input.phone, purpose: "login", code: input.code });
  if (!ok) {
    await recordFail(deps.q, acc.id as string);
    await loginEvent(deps.q, { accountId: acc.id as string, kind: "login.fail", ip: input.ip, detail: { via: "code" } });
    throw new Error("验证码错误或已过期");
  }
  const identity = await identityFor(deps.q, acc.id as string, input.workspaceSlug);
  if (!identity) throw new Error("您在目标工作区没有成员身份，请联系管理员邀请");
  await clearFail(deps.q, acc.id as string);
  await loginEvent(deps.q, { accountId: acc.id as string, kind: "login.ok", workspaceId: identity.workspaceId, ip: input.ip, device: input.device });
  return { ...(await issueSession(deps, { accountId: acc.id as string, identity, ...input })), identity };
}

export async function loginWithPassword(
  deps: AccountsDeps,
  input: { email: string; password: string; workspaceSlug: string; device?: string; ip?: string; ua?: string },
) {
  const acc = await accountByEmail(deps.q, input.email);
  if (!acc) throw new Error("账号不存在");
  assertNotLocked(acc, now(deps));
  if (!acc.password_hash || !verifyPassword(input.password, acc.password_hash as string)) {
    await recordFail(deps.q, acc.id as string);
    await loginEvent(deps.q, { accountId: acc.id as string, kind: "login.fail", ip: input.ip, detail: { via: "password" } });
    throw new Error("邮箱或密码不正确");
  }
  const identity = await identityFor(deps.q, acc.id as string, input.workspaceSlug);
  if (!identity) throw new Error("您在目标工作区没有成员身份");
  await clearFail(deps.q, acc.id as string);
  await loginEvent(deps.q, { accountId: acc.id as string, kind: "login.ok", workspaceId: identity.workspaceId, ip: input.ip, device: input.device });
  return { ...(await issueSession(deps, { accountId: acc.id as string, identity, ...input })), identity };
}

/* ================= 刷新 / 切店 / 登出 ================= */

async function sessionByRefresh(q: QueryFn, refreshPlain: string) {
  const r = await q(
    `SELECT * FROM auth_sessions WHERE refresh_token_hash=$1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashRefreshToken(refreshPlain)],
  );
  return r.rows[0] ?? null;
}

export async function refreshSession(
  deps: AccountsDeps,
  input: { refreshToken: string; workspaceSlug: string; device?: string; ip?: string },
) {
  const sess = await sessionByRefresh(deps.q, input.refreshToken);
  if (!sess) throw new Error("会话已失效，请重新登录");
  const identity = await identityFor(deps.q, sess.account_id as string, input.workspaceSlug);
  if (!identity) throw new Error("您在目标工作区没有成员身份");
  // 旋转：旧串作废，新串入库
  await deps.q(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`, [sess.id]);
  const out = await issueSession(deps, {
    accountId: sess.account_id as string, identity,
    device: input.device ?? (sess.device_name as string), ip: input.ip,
    trusted: sess.device_trusted as boolean,
  });
  return { ...out, identity };
}

export async function logout(deps: AccountsDeps, refreshToken: string): Promise<void> {
  await deps.q(`UPDATE auth_sessions SET revoked_at=now() WHERE refresh_token_hash=$1`, [hashRefreshToken(refreshToken)]);
}

export async function listSessions(q: QueryFn, accountId: string) {
  const r = await q(
    `SELECT id, device_name, device_trusted, ip, ua, issued_at, expires_at FROM auth_sessions
     WHERE account_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY issued_at DESC`,
    [accountId],
  );
  return r.rows;
}

export async function revokeSession(q: QueryFn, accountId: string, sessionId: string): Promise<void> {
  await q(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND account_id=$2`, [sessionId, accountId]);
}

export async function revokeAllSessions(q: QueryFn, accountId: string): Promise<void> {
  await q(`UPDATE auth_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL`, [accountId]);
}

/* ================= 注册 / 激活 / 邀请 ================= */

/** 自助开通：注册账号 + 建租户 + 建首店工作区 + 本人即 owner */
export async function registerTenantOwner(
  deps: AccountsDeps,
  input: {
    phone: string; code: string; displayName: string;
    tenantName: string; workspaceName: string; workspaceSlug: string; industry: string; plan?: PlanTier;
    password?: string; ip?: string;
  },
) {
  const ok = await consumeCode(deps, { channel: "phone", target: input.phone, purpose: "activate", code: input.code });
  if (!ok) throw new Error("激活验证码错误或已过期");
  let acc = await accountByPhone(deps.q, input.phone);
  if (!acc) {
    const id = newId("acc");
    await deps.q(
      `INSERT INTO accounts (id, phone, display_name, password_hash) VALUES ($1,$2,$3,$4)`,
      [id, input.phone, input.displayName, input.password ? hashPassword(input.password) : null],
    );
    acc = { id };
  }
  const tenantId = newId("tenant");
  const wsId = newId("ws");
  await deps.q(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,$3)`, [tenantId, input.tenantName, input.plan ?? "pro"]);
  await deps.q(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config) VALUES ($1,$2,$3,$4,$5,'stable','{}')`,
    [wsId, tenantId, input.workspaceName, input.workspaceSlug, input.industry],
  );
  const memberId = newId("mem");
  await deps.q(
    `INSERT INTO members (id, workspace_id, member_no, name, role, account_id, status)
     VALUES ($1,$2,$3,$4,'owner',$5,'active')`,
    [memberId, wsId, "MEM-001", input.displayName, acc.id],
  );
  await loginEvent(deps.q, { accountId: acc.id as string, kind: "activate.ok", workspaceId: wsId, ip: input.ip });
  const identity = await identityFor(deps.q, acc.id as string, input.workspaceSlug);
  return { ...(await issueSession(deps, { accountId: acc.id as string, identity: identity!, ip: input.ip })), identity, tenantId, workspaceId: wsId };
}

/** 邀请成员（owner/manager 发起） */
export async function inviteMember(
  deps: AccountsDeps,
  input: { workspaceId: string; phone: string; role: MemberRole; name: string; invitedBy: string },
): Promise<{ inviteCode: string }> {
  const dup = await deps.q(
    `SELECT m.id FROM members m JOIN accounts a ON a.id=m.account_id
     WHERE m.workspace_id=$1 AND a.phone=$2 AND m.status='active'`,
    [input.workspaceId, input.phone],
  );
  if (dup.rows[0]) throw new Error("该手机号已是本工作区成员");
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const no = await nextMemberNo(deps.q, input.workspaceId);
  await deps.q(
    `INSERT INTO members (id, workspace_id, member_no, name, role, status) VALUES ($1,$2,$3,$4,$5,'invited')`,
    [newId("mem"), input.workspaceId, no, input.name, input.role],
  );
  await deps.q(
    `INSERT INTO member_invites (id, workspace_id, phone, role, code_hash, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '72 hours')`,
    [newId("inv"), input.workspaceId, input.phone, input.role, hashSecret(code, input.phone), input.invitedBy],
  );
  await deps.sms.send(input.phone, `【WorkLoom】邀请码 ${code}：您被邀请加入工作区，72 小时内有效。`);
  return { inviteCode: process.env.NODE_ENV === "production" ? "" : code };
}

async function nextMemberNo(q: QueryFn, workspaceId: string): Promise<string> {
  const r = await q(
    `SELECT count(*)::int AS c FROM members WHERE workspace_id=$1`,
    [workspaceId],
  );
  return `MEM-${String((r.rows[0]?.c as number) + 1).padStart(3, "0")}`;
}

/** 接受邀请：绑定账号 ↔ 成员，签发会话 */
export async function acceptInvite(
  deps: AccountsDeps,
  input: { phone: string; code: string; workspaceSlug: string; displayName?: string; ip?: string },
) {
  const r = await deps.q(
    `SELECT i.*, w.slug FROM member_invites i JOIN workspaces w ON w.id=i.workspace_id
     WHERE i.phone=$1 AND i.status='pending' AND i.expires_at > now() AND w.slug=$2
     ORDER BY i.created_at DESC LIMIT 1`,
    [input.phone, input.workspaceSlug],
  );
  const inv = r.rows[0];
  if (!inv || inv.code_hash !== hashSecret(input.code, input.phone)) throw new Error("邀请码错误或已过期");
  let acc = await accountByPhone(deps.q, input.phone);
  if (!acc) {
    const id = newId("acc");
    await deps.q(`INSERT INTO accounts (id, phone, display_name) VALUES ($1,$2,$3)`, [id, input.phone, input.displayName ?? ""]);
    acc = { id };
  }
  await deps.q(
    `UPDATE members SET account_id=$1, status='active' WHERE workspace_id=$2 AND role=$3 AND status='invited'
       AND id NOT IN (SELECT id FROM members WHERE workspace_id=$2 AND account_id IS NOT NULL)`,
    [acc.id, inv.workspace_id, inv.role],
  );
  await deps.q(`UPDATE member_invites SET status='accepted', accepted_at=now() WHERE id=$1`, [inv.id]);
  await loginEvent(deps.q, { accountId: acc.id as string, kind: "invite.accept", workspaceId: inv.workspace_id as string, ip: input.ip });
  const identity = await identityFor(deps.q, acc.id as string, input.workspaceSlug);
  if (!identity) throw new Error("成员绑定失败，请联系管理员");
  return { ...(await issueSession(deps, { accountId: acc.id as string, identity, ip: input.ip })), identity };
}

/** 移除成员（即时生效：成员停用 + 该成员身份下 refresh 全部吊销通过 members 状态生效；会话按账号+工作区粒度失效由 identityFor 的 status 检查保证） */
export async function removeMember(deps: AccountsDeps, input: { workspaceId: string; memberId: string }): Promise<void> {
  await deps.q(`UPDATE members SET status='removed' WHERE id=$1 AND workspace_id=$2`, [input.memberId, input.workspaceId]);
}

export async function updateMemberRole(
  deps: AccountsDeps,
  input: { workspaceId: string; memberId: string; role: MemberRole; permissions?: Record<string, unknown> },
): Promise<void> {
  await deps.q(
    `UPDATE members SET role=$3, permissions=COALESCE($4, permissions) WHERE id=$1 AND workspace_id=$2`,
    [input.memberId, input.workspaceId, input.role, input.permissions ? JSON.stringify(input.permissions) : null],
  );
}

/** 设置/修改前台快切 PIN（本人操作） */
export async function setQuickPin(deps: AccountsDeps, input: { memberId: string; pin: string }): Promise<void> {
  if (!/^\d{4,6}$/.test(input.pin)) throw new Error("PIN 须为 4-6 位数字");
  await deps.q(`UPDATE members SET quick_pin_hash=$2 WHERE id=$1`, [input.memberId, hashPassword(input.pin)]);
}

/* ================= 审计台账 ================= */

export async function loginEvent(
  q: QueryFn,
  e: { accountId?: string; kind: string; workspaceId?: string; ip?: string; device?: string; detail?: Record<string, unknown> },
): Promise<void> {
  await q(
    `INSERT INTO login_events (id, account_id, kind, workspace_id, ip, device, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [newId("le"), e.accountId ?? null, e.kind, e.workspaceId ?? null, e.ip ?? "", e.device ?? "", JSON.stringify(e.detail ?? {})],
  );
}

export async function myLoginEvents(q: QueryFn, accountId: string, limit = 20) {
  const r = await q(
    `SELECT kind, workspace_id, ip, device, detail, created_at FROM login_events WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [accountId, limit],
  );
  return r.rows;
}
