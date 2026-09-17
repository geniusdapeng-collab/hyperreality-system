/**
 * skill-ops · 官方运营台（官方侧，方案 v0.2 §4.3/§5；仅在 SKILL_OPS_MODE=official 的部署启用）
 *
 * 消化流水线：inbox 接收（验签）→ 聚类（cluster_key 归一化）→ 按客户侧六信号评分排序 →
 *            双人复核（D15-② 同构：两名不同成员 approve，提案人禁自批）→ 官方化
 *            （抽象完善后进官方技能库 origin=customer-reflux）→ buildManifest 签名分发 → 闭环。
 * 数据主权边界：官方只能看到客户 opt-in 上送的脱敏草案与统计摘要——本模块不读客户库。
 */
import type pg from "pg";
import { createHmac, timingSafeEqual } from "node:crypto";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import { signPackage } from "./signature.js";
import { DistMeta, type DistManifest, type SkillPackage } from "./types.js";
import type { RefluxPayload } from "./reflux.js";

export class ConsoleError extends Error {
  constructor(
    public readonly code: "BAD_SIGNATURE" | "NOT_FOUND" | "BAD_STATE" | "SELF_REVIEW_FORBIDDEN" | "DUPLICATE_REVIEW" | "EMPTY_REASON" | "NEED_DUAL_REVIEW",
    message: string,
  ) {
    super(message);
    this.name = "ConsoleError";
  }
}

const OPS_ACTOR = { id: "skill-ops", type: "system" as const };

async function emitOps(
  client: pg.PoolClient,
  scope: { tenantId: string; workspaceId: string },
  decision: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: OPS_ACTOR,
  }, {
    who: { type: "system", id: OPS_ACTOR.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "ops" },
    object: { type: "skill_reflux", id: (decision.after as { draftId?: string } | undefined)?.draftId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

/** 聚类键（纯函数）：名称归一化（小写、去空白与标点） */
export function clusterKeyOf(name: string): string {
  return name.toLowerCase().replace(/[\s\-_·、，。,.:：()（）\[\]]+/g, "");
}

/** 验签（与 reflux.signReflux 同算法） */
export function verifyRefluxSignature(key: string, payload: RefluxPayload, signature: string): boolean {
  if (!key) return false;
  const expect = createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
  const a = Buffer.from(expect), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- ① 接收 ---------- */

export async function receiveReflux(
  app: pg.Pool, gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string }, // 官方实例自身 scope（事件留痕用）
  input: { payload: RefluxPayload; signature: string; signingKey: string },
): Promise<{ draftId: string; deduped: boolean }> {
  if (!verifyRefluxSignature(input.signingKey, input.payload, input.signature)) {
    throw new ConsoleError("BAD_SIGNATURE", "回流包签名验签失败，拒收");
  }
  const p = input.payload;
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 幂等：同来源同技能同版本的 inbox 草案不重复收
    const dup = await client.query<{ id: string }>(
      `SELECT id FROM skill_reflux_inbox
       WHERE from_tenant=$1 AND from_workspace=$2 AND skill_id=$3 AND version=$4 AND status='inbox'`,
      [p.from.tenantId, p.from.workspaceId, p.skillId, p.version]);
    if (dup.rows[0]) {
      await client.query("COMMIT");
      return { draftId: dup.rows[0].id, deduped: true };
    }
    const draftId = `rfi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await client.query(
      `INSERT INTO skill_reflux_inbox
         (id, from_tenant, from_workspace, skill_id, name, version, description, body, meta, signals, cluster_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [draftId, p.from.tenantId, p.from.workspaceId, p.skillId, p.name, p.version,
       p.description, p.body, JSON.stringify(p.meta ?? {}), JSON.stringify(p.signals ?? {}), clusterKeyOf(p.name)]);
    await emitOps(client, scope, {
      action: "skill.reflux.received",
      after: { draftId, skillId: p.skillId, name: p.name, from: p.from, signalsScore: (p.signals as { score?: number })?.score ?? null },
      basis: ["客户 opt-in 回流草案接收（脱敏后上送，官方只见草案与统计摘要）"],
    });
    await client.query("COMMIT");
    return { draftId, deduped: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/* ---------- ② 入池排序（聚类 + 评分榜） ---------- */

export interface InboxDraft {
  id: string; from_tenant: string; from_workspace: string; skill_id: string;
  name: string; version: string; description: string; cluster_key: string;
  signals: { score?: number; samples?: number; sparse?: boolean };
  status: string; reviews: Array<{ member: string; gesture: string; at: string }>;
  created_at: Date;
}

export async function listInbox(app: pg.Pool): Promise<{ drafts: InboxDraft[]; clusters: Array<{ clusterKey: string; count: number; bestScore: number }> }> {
  const r = await app.query<InboxDraft>(
    `SELECT * FROM skill_reflux_inbox WHERE status='inbox' ORDER BY (signals->>'score')::float DESC NULLS LAST, created_at DESC`);
  const clusters = new Map<string, { count: number; bestScore: number }>();
  for (const d of r.rows) {
    const c = clusters.get(d.cluster_key) ?? { count: 0, bestScore: 0 };
    c.count += 1;
    c.bestScore = Math.max(c.bestScore, Number(d.signals?.score ?? 0));
    clusters.set(d.cluster_key, c);
  }
  return {
    drafts: r.rows,
    clusters: [...clusters.entries()]
      .map(([clusterKey, v]) => ({ clusterKey, ...v }))
      .sort((a, b) => b.count - a.count || b.bestScore - a.bestScore),
  };
}

/* ---------- ③ 双人复核（D15-② 同构） ---------- */

export async function reviewRefluxDraft(
  app: pg.Pool, gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  input: { draftId: string; by: string; gesture: "approve" | "reject"; reason?: string },
): Promise<{ status: string; approves: number }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const cur = await client.query<InboxDraft & { reviews: Array<{ member: string; gesture: string; at: string }> }>(
      `SELECT * FROM skill_reflux_inbox WHERE id=$1 FOR UPDATE`, [input.draftId]);
    const row = cur.rows[0];
    if (!row) throw new ConsoleError("NOT_FOUND", `回流草案 ${input.draftId} 不存在`);
    if (row.status !== "inbox") throw new ConsoleError("BAD_STATE", `草案状态 ${row.status}，仅 inbox 可复核`);
    if (row.reviews.some((x) => x.member === input.by)) {
      throw new ConsoleError("DUPLICATE_REVIEW", `成员 ${input.by} 已复核过本草案`);
    }
    if (input.gesture === "reject" && (!input.reason || input.reason.trim() === "")) {
      throw new ConsoleError("EMPTY_REASON", "驳回必须填写原因（L5.2 同口径）");
    }
    const reviews = [...row.reviews, { member: input.by, gesture: input.gesture, at: new Date().toISOString() }];
    const approves = reviews.filter((x) => x.gesture === "approve").length;
    const status = input.gesture === "reject" ? "rejected" : "inbox";
    await client.query(
      `UPDATE skill_reflux_inbox SET reviews=$2, status=$3, decided_by=CASE WHEN $3='rejected' THEN $4 ELSE decided_by END,
         decided_at=CASE WHEN $3='rejected' THEN now() ELSE decided_at END WHERE id=$1`,
      [input.draftId, JSON.stringify(reviews), status, input.by]);
    await emitOps(client, scope, {
      action: `skill.reflux.${input.gesture}`,
      after: { draftId: input.draftId, approves, status, reason: input.reason ?? null },
      basis: ["双人复核制（D15-② 同构）：两名不同成员 approve 方可官方化"],
    });
    await client.query("COMMIT");
    return { status, approves };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/* ---------- ④ 官方化（抽象完善 → 官方技能库） ---------- */

export async function officializeDraft(
  app: pg.Pool, gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  input: {
    draftId: string; by: string;
    /** 抽象完善后的最终稿（人工编辑：通用化/去客户特征/复核脱敏）；缺省=草案原文 */
    final?: { name?: string; description?: string; body?: string };
  },
): Promise<{ skillId: string }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const cur = await client.query<InboxDraft & { body: string; meta: Record<string, unknown> }>(
      `SELECT * FROM skill_reflux_inbox WHERE id=$1 FOR UPDATE`, [input.draftId]);
    const row = cur.rows[0];
    if (!row) throw new ConsoleError("NOT_FOUND", `回流草案 ${input.draftId} 不存在`);
    if (row.status !== "inbox") throw new ConsoleError("BAD_STATE", `草案状态 ${row.status}，仅 inbox 可官方化`);
    const approves = new Set(row.reviews.filter((x) => x.gesture === "approve").map((x) => x.member));
    if (approves.size < 2) {
      throw new ConsoleError("NEED_DUAL_REVIEW", `官方化须两名不同成员复核通过（当前 ${approves.size}/2，D15-② 同构）`);
    }
    if (approves.has(input.by) === false) {
      // 官方化执行人必须复核过（防止未读草案者直接上架）
      throw new ConsoleError("NEED_DUAL_REVIEW", `官方化执行人 ${input.by} 须为复核通过成员之一`);
    }
    const finalName = input.final?.name ?? row.name;
    const finalDesc = input.final?.description ?? row.description;
    const finalBody = input.final?.body ?? row.body;
    const meta = DistMeta.parse({ ...(row.meta ?? {}), origin: "customer-reflux" });
    await client.query(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized, dist_meta)
       VALUES ($1,'official',NULL,$2,$3,$4,'[]',$5,true,$6)
       ON CONFLICT (id) DO UPDATE SET name=$2, version=$3, description=$4, body=$5, desensitized=true, dist_meta=$6`,
      [row.skill_id, finalName, row.version, finalDesc, finalBody, JSON.stringify(meta)]);
    await client.query(
      `UPDATE skill_reflux_inbox SET status='officialized', decided_by=$2, decided_at=now() WHERE id=$1`,
      [input.draftId, input.by]);
    await emitOps(client, scope, {
      action: "skill.reflux.officialize",
      after: { draftId: input.draftId, skillId: row.skill_id, name: finalName, edited: !!input.final },
      basis: [
        `双人复核通过（${[...approves].join("、")}），官方化进官方技能库（origin=customer-reflux）`,
        "客户最佳实践脱敏抽象后成为全网能力——保鲜环闭环合拢（方案 v0.2 §4.3）",
      ],
    });
    await client.query("COMMIT");
    return { skillId: row.skill_id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/* ---------- ⑤ 分发 manifest 构建（官方技能库 → 签名分发包） ---------- */

export async function buildManifest(
  app: pg.Pool,
  opts: { signingKey: string; registryVersion?: string },
): Promise<DistManifest> {
  const r = await app.query<{
    id: string; name: string; version: string; description: string; body: string;
    fence_bindings: string[]; dist_meta: Record<string, unknown>;
  }>(`SELECT id, name, version, description, body, fence_bindings, dist_meta FROM skills
       WHERE level='official' AND body <> '' ORDER BY id`); // 无正文的残缺资产不进分发（种子纪律同 official.ts）
  const entries = r.rows.map((s) => {
    const base = {
      skillId: s.id, name: s.name, version: s.version, description: s.description,
      body: s.body, fenceBindings: s.fence_bindings ?? [], meta: DistMeta.parse(s.dist_meta ?? {}),
    };
    const pkg: SkillPackage = { ...base, signature: signPackage(opts.signingKey, base) };
    return { targets: {}, package: pkg };
  });
  return {
    registryVersion: opts.registryVersion ?? new Date().toISOString().slice(0, 10).replace(/-/g, ".") + ".1",
    publishedAt: new Date().toISOString(),
    entries,
  };
}

/* ---------- 健康看板 ---------- */

export async function consoleHealth(app: pg.Pool) {
  const r = await app.query<{
    inbox: string; officialized: string; rejected: string; official_skills: string;
  }>(
    `SELECT count(*) FILTER (WHERE status='inbox') AS inbox,
            count(*) FILTER (WHERE status='officialized') AS officialized,
            count(*) FILTER (WHERE status='rejected') AS rejected,
            (SELECT count(*) FROM skills WHERE level='official') AS official_skills
     FROM skill_reflux_inbox`);
  const last = await app.query<{ at: Date }>(
    `SELECT created_at AS at FROM biz_events
     WHERE payload->'decision'->>'action'='skill.reflux.received' ORDER BY created_at DESC LIMIT 1`);
  return {
    inbox: Number(r.rows[0]?.inbox ?? 0),
    officialized: Number(r.rows[0]?.officialized ?? 0),
    rejected: Number(r.rows[0]?.rejected ?? 0),
    officialSkills: Number(r.rows[0]?.official_skills ?? 0),
    lastReceivedAt: last.rows[0]?.at ?? null,
  };
}
