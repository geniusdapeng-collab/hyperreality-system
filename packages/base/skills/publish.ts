/**
 * skills · industry 上架门禁（D15 五机制位，第 9 轮）
 *
 * ① 上架脱敏扫描：maskText PII 检测 + 敏感凭据词清单，正文/描述命中即拒
 * ③ 供应链注入评估：提示词注入模式扫描（覆盖/泄露/外发三类），命中即拒
 * ② 审核流水线：提案（事件留痕）→ 两名不同成员复核（禁止自批）→ 完成上架
 * ④ 全局吊销：kill switch，installSkill 与 resolveAgentFenceBindings 双点排除
 * ⑤ 版本通道：安装时版本快照 vs 当前版本，列示可更新技能
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { maskText } from "../workdata/pii.js";
/** 本地 Scope（与 registry.Scope 同构；避免 registry↔publish 循环依赖） */
export interface Scope { tenantId: string; workspaceId: string }

/** 上架门禁错误（code 与 SkillError 同口径） */
export class PublishError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PublishError";
  }
}

/* ================= ① 脱敏扫描 ================= */

/** 敏感凭据词清单（正文/描述出现即拒——无论是否被 PII 正则命中） */
const SENSITIVE_TERMS = [
  "api_key", "apikey", "secret_key", "access_token", "private_key", "password",
  "passwd", "aksk", "secret=", "token=", "-----BEGIN", "密码", "密钥", "凭据", "内网IP",
];

export interface ScanHit { kind: "pii" | "sensitive_term" | "injection"; detail: string }

/** ① 上架脱敏扫描：返回命中清单（空=通过） */
export function scanSkillForPublish(body: string, description = ""): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const [label, text] of [["正文", body], ["描述", description]] as const) {
    const masked = maskText(text);
    if (masked.hits > 0) hits.push({ kind: "pii", detail: `${label}含 ${masked.hits} 处 PII（手机号/身份证/银行卡/邮箱等）` });
    const lower = text.toLowerCase();
    for (const term of SENSITIVE_TERMS) {
      if (lower.includes(term.toLowerCase())) {
        hits.push({ kind: "sensitive_term", detail: `${label}含敏感词「${term}」` });
      }
    }
  }
  return hits;
}

/* ================= ③ 供应链注入评估 ================= */

/** 提示词注入模式（三类：覆盖指令 / 窃取泄露 / 数据外发） */
const INJECTION_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /忽略(以上|之前|先前|所有).*指令/i, detail: "覆盖指令：要求忽略先前指令" },
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, detail: "覆盖指令：ignore previous instructions" },
  { re: /你(现在)?是(一个)?(不受限制|无审查|全新)/i, detail: "覆盖指令：人格覆盖" },
  { re: /(jailbreak|DAN\s+mode|do\s+anything\s+now)/i, detail: "覆盖指令：越狱模式" },
  { re: /(读取|获取|打印|输出).*(环境变量|env\b|process\.env)/i, detail: "窃取泄露：读取环境变量" },
  { re: /(泄露|发送|上传|回传).*(密钥|凭据|token|secret|password)/i, detail: "窃取泄露：凭据外泄" },
  { re: /(exfiltrate|leak)/i, detail: "窃取泄露：exfiltrate/leak" },
  { re: /(密钥|凭据|token|secret|password).{0,12}(发送|上传|回传|外发|到外部)/i, detail: "窃取泄露：凭据外发" },
  { re: /(curl|wget|fetch|http\.post).{0,40}https?:\/\/(?!(registry\.npmjs\.org|github\.com))/i, detail: "数据外发：指示对外发起网络请求" },
  { re: /(发送|POST).{0,20}(到|至).{0,20}(外部|第三方|远程)服务/i, detail: "数据外发：发送至外部服务" },
  { re: /绕过?(围栏|审批|权限|安全检查)/i, detail: "越权诱导：绕过围栏/审批" },
  { re: /bypass\s+(fence|approval|permission|security)/i, detail: "越权诱导：bypass fence/approval" },
];

/** ③ 供应链注入评估：返回命中清单（空=通过） */
export function scanSkillForInjection(body: string): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const { re, detail } of INJECTION_PATTERNS) {
    if (re.test(body)) hits.push({ kind: "injection", detail });
  }
  return hits;
}

/** 上架前完整门禁（①+③）：命中即抛 PUBLISH_SCAN_FAILED */
export function assertPublishable(body: string, description = ""): void {
  const hits = [...scanSkillForPublish(body, description), ...scanSkillForInjection(body)];
  if (hits.length > 0) {
    throw new PublishError(
      "PUBLISH_SCAN_FAILED",
      `上架扫描未通过（D15-①/③）：${hits.map((h) => h.detail).join("；")}`,
    );
  }
}

/* ================= ② 审核流水线 ================= */

interface PublishReviewRow {
  id: string; skill_id: string; from_workspace_id: string; proposed_by: string;
  status: "pending" | "approved" | "rejected" | "completed";
  approvals: Array<{ member_no: string; gesture: string; at: string }>;
  required_approvals: number; reason: string | null;
}

/** 提案上架：写入审核单 + 事件留痕（幂等：同技能 pending 单复用） */
export async function proposePublish(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; skillName: string; body: string; description: string; by: string },
): Promise<{ reviewId: string; deduped: boolean }> {
  // ①+③ 上架门禁：扫描不过连提案都进不了
  assertPublishable(input.body, input.description);
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const dup = await client.query<PublishReviewRow>(
      `SELECT * FROM skill_publish_reviews WHERE skill_id=$1 AND status='pending'`, [input.skillId]);
    if (dup.rows[0]) {
      await client.query("COMMIT");
      return { reviewId: dup.rows[0].id, deduped: true };
    }
    const seq = await client.query<{ c: string }>(`SELECT count(*) AS c FROM skill_publish_reviews WHERE skill_id=$1`, [input.skillId]);
    const reviewId = `pub-${input.skillId}-${Number(seq.rows[0]!.c) + 1}`;
    await client.query(
      `INSERT INTO skill_publish_reviews (id, skill_id, from_workspace_id, proposed_by) VALUES ($1,$2,$3,$4)`,
      [reviewId, input.skillId, scope.workspaceId, input.by]);
    // D16（#1/A）：审核单行与提案事件同一事务同一 COMMIT
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: "human" } }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
      object: { type: "skill", id: input.skillId },
      decision: { action: "skill.publish.propose", after: { reviewId, skillName: input.skillName } },
      rule_impact: [],
    });
    await client.query("COMMIT");
    return { reviewId, deduped: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/** 复核手势：两名不同成员 approve 后单转 approved；提案人禁止自批（D15-②） */
export async function reviewPublish(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { reviewId: string; by: string; gesture: "approve" | "reject"; reason?: string },
): Promise<{ status: string; deduped: boolean }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const cur = await client.query<PublishReviewRow>(
      `SELECT * FROM skill_publish_reviews WHERE id=$1 FOR UPDATE`, [input.reviewId]);
    const row = cur.rows[0];
    if (!row) throw new PublishError("NOT_FOUND", `上架审核单 ${input.reviewId} 不存在`);
    if (row.status !== "pending") {
      await client.query("COMMIT");
      return { status: row.status, deduped: true }; // 重复手势幂等（L5.3 同口径）
    }
    if (row.proposed_by === input.by) {
      throw new PublishError("SELF_REVIEW_FORBIDDEN", `提案人 ${input.by} 禁止自批（D15-② 双人复核）`);
    }
    if (row.approvals.some((a) => a.member_no === input.by)) {
      throw new PublishError("DUPLICATE_REVIEW", `成员 ${input.by} 已复核过本单`);
    }
    if (input.gesture === "reject" && (!input.reason || input.reason.trim() === "")) {
      throw new PublishError("EMPTY_REASON", "驳回必须填写原因（L5.2 同口径）");
    }
    const approvals = [...row.approvals, { member_no: input.by, gesture: input.gesture, at: new Date().toISOString() }];
    const approvedCount = approvals.filter((a) => a.gesture === "approve").length;
    const status = input.gesture === "reject" ? "rejected"
      : approvedCount >= row.required_approvals ? "approved" : "pending";
    await client.query(
      `UPDATE skill_publish_reviews SET approvals=$2, status=$3, reason=$4, decided_at=CASE WHEN $3 IN ('approved','rejected') THEN now() ELSE NULL END WHERE id=$1`,
      [input.reviewId, JSON.stringify(approvals), status, input.reason ?? null]);
    // D16（#1/A）：复核手势落库与事件同一事务同一 COMMIT
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: "human" } }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
      object: { type: "skill_publish_review", id: input.reviewId },
      decision: { action: `skill.publish.${input.gesture}`, after: { status, approvals: approvedCount, required: row.required_approvals, reason: input.reason ?? null } },
      rule_impact: [],
    });
    await client.query("COMMIT");
    return { status, deduped: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/** 完成上架：approved 单 → 技能置 industry + desensitized（事件留痕） */
export async function completePublish(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { reviewId: string; by: string },
): Promise<{ skillId: string }> {
  const client = await app.connect();
  let skillId = "";
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const cur = await client.query<PublishReviewRow>(`SELECT * FROM skill_publish_reviews WHERE id=$1 FOR UPDATE`, [input.reviewId]);
    const row = cur.rows[0];
    if (!row) throw new PublishError("NOT_FOUND", `上架审核单 ${input.reviewId} 不存在`);
    if (row.status === "completed") {
      await client.query("COMMIT");
      return { skillId: row.skill_id };
    }
    if (row.status !== "approved") {
      throw new PublishError("NOT_APPROVED", `审核单状态 ${row.status}，仅 approved 可完成上架（D15-②）`);
    }
    skillId = row.skill_id;
    await client.query(`UPDATE skills SET level='industry', desensitized=true WHERE id=$1`, [skillId]);
    await client.query(`UPDATE skill_publish_reviews SET status='completed', decided_at=now() WHERE id=$1`, [input.reviewId]);
    // D16（#1/A）：上架状态变更与完成事件同一事务同一 COMMIT
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: "human" } }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
      object: { type: "skill", id: skillId },
      decision: { action: "skill.publish.complete", after: { reviewId: input.reviewId, level: "industry", desensitized: true } },
      rule_impact: [],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
  return { skillId };
}

/* ================= ④ 全局吊销（kill switch） ================= */

/** 全局吊销：全租户生效，install 与装配双点排除（事件留痕；幂等） */
export async function revokeSkill(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; reason: string; by: string },
): Promise<{ deduped: boolean }> {
  if (!input.reason || input.reason.trim() === "") {
    throw new PublishError("EMPTY_REASON", "吊销必须填写原因");
  }
  // D16（#1/A）：吊销行与吊销事件同一事务同一 COMMIT
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ skill_revoke: boolean }>(
      `SELECT public.skill_revoke($1, $2, $3)`, // D31：吊销收口 owner 通道（REVOKE app 写权后改 SECURITY DEFINER 函数）
      [input.skillId, input.reason, input.by]);
    if (r.rows[0]?.skill_revoke !== true) {
      await client.query("COMMIT");
      return { deduped: true };
    }
    await gatewayAppendOnClient(client, { ...scope, actor: { id: input.by, type: "human" } }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
      object: { type: "skill", id: input.skillId },
      decision: { action: "skill.revoke", after: { reason: input.reason, scope: "global" } },
      rule_impact: [],
    });
    await client.query("COMMIT");
    return { deduped: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/** 吊销查询（installSkill / resolveAgentFenceBindings 消费） */
export async function isSkillRevoked(app: pg.Pool, skillId: string): Promise<boolean> {
  const r = await app.query(`SELECT 1 FROM skill_revocations WHERE skill_id=$1`, [skillId]);
  return (r.rowCount ?? 0) > 0;
}

/* ================= ⑤ 版本通道 ================= */

export interface SkillUpdate {
  skillId: string; name: string; installedVersion: string; currentVersion: string;
}

/** 本工作区已装技能的版本变更清单（installed_version ≠ skills.version 即有更新；不自动升级，变更进审批由人工确认） */
export async function listSkillUpdates(app: pg.Pool, scope: Scope): Promise<SkillUpdate[]> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ skill_id: string; name: string; installed_version: string; version: string }>(
      `SELECT si.skill_id, s.name, si.installed_version, s.version
       FROM skill_installs si JOIN skills s ON s.id = si.skill_id
       WHERE si.workspace_id=$1 AND si.installed_version <> '' AND si.installed_version <> s.version
       ORDER BY si.skill_id`,
      [scope.workspaceId]);
    await client.query("COMMIT");
    return r.rows.map((x) => ({ skillId: x.skill_id, name: x.name, installedVersion: x.installed_version, currentVersion: x.version }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}
