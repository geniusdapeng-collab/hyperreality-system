/**
 * skill-ops · 客户端接收器（方案 v0.2 §3.3，P0 核心编排）
 *
 * 流程：拉取 manifest（夜班窗口/手动立即同步）→ 定向匹配 → staging 五道预检 → 定级分流：
 *  - L0/L1 + silent 策略 → 热装载（技能库 upsert + 已装技能版本快照跟进）+ 角标留痕
 *  - L0/L1 + prompt 策略 → 入 staging 待人工装载
 *  - L2 → 入 staging + 审批提案（审批卡片直达手机，批准后 loadStaging 完成装载）
 *  - 预检不过 → rejected 留档，不进运行时
 * 回滚：装载前必落快照（skill_dist_snapshots），rollbackSkill 恢复上一版本。
 * 红线：一切动作进 biz_events 哈希链；装载仅更新技能库与已装快照——
 *      新技能的"安装即绑定围栏"仍走 installSkill 原流程（E8.1 冲突检测不旁路）。
 */
import type pg from "pg";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { runStagingChecks } from "./staging.js";
import { matchesTargets, compareVersions } from "./targeting.js";
import { getSilentMode } from "./policy.js";
import { DistManifest, DistMeta, type InstanceProfile, type SkillPackage, type StagingCheck } from "./types.js";

interface Scope { tenantId: string; workspaceId: string }

export class SkillOpsError extends Error {
  constructor(
    public readonly code: "DISABLED" | "NOT_FOUND" | "BAD_STATE" | "NOT_APPROVED" | "NO_SNAPSHOT" | "REGISTRY_UNREACHABLE",
    message: string,
  ) {
    super(message);
    this.name = "SkillOpsError";
  }
}

/* ---------- 事件留痕（与 skills/registry.ts 同口径；actor 支持系统身份——夜班自动同步归因 night-shift） ---------- */

/** 事件归因身份：人工同步=human:memberNo；夜班自动同步=system:night-shift（白名单系统组件） */
export interface EventActor { id: string; type: "human" | "system" }

async function emit(gateway: pg.Pool, scope: Scope, by: EventActor, decision: Record<string, unknown>, links?: string[]): Promise<string> {
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by.id, type: by.type },
  }, {
    who: { type: by.type, id: by.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: by.type === "system" ? "夜班" : "inapp" },
    object: { type: "skill", id: (decision.after as { skillId?: string } | undefined)?.skillId },
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

async function emitInTx(client: pg.PoolClient, scope: Scope, by: EventActor, decision: Record<string, unknown>): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by.id, type: by.type },
  }, {
    who: { type: by.type, id: by.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: by.type === "system" ? "夜班" : "inapp" },
    object: { type: "skill", id: (decision.after as { skillId?: string } | undefined)?.skillId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

/** by 字符串（人工成员号）→ EventActor 的兼容转换 */
const human = (memberNo: string): EventActor => ({ id: memberNo, type: "human" });

/* ---------- 拉取 ---------- */

export type ManifestFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: ManifestFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new SkillOpsError("REGISTRY_UNREACHABLE", `registry 不可达：HTTP ${res.status}`);
  return res.json();
};

/* ---------- 装载（事务内：快照 → 技能库 upsert → 已装快照跟进 → 事件） ---------- */

async function loadPackageInTx(
  client: pg.PoolClient, scope: Scope, pkg: SkillPackage, tier: string, by: EventActor, checks: StagingCheck[],
): Promise<{ upgraded: boolean; previousVersion: string | null }> {
  // ① 快照（装载前必落：旧 skills 行 + 旧 install 行）
  const cur = await client.query(
    `SELECT s.*, i.installed_version, i.fence_bindings_snapshot
     FROM skills s LEFT JOIN skill_installs i ON i.skill_id=s.id AND i.workspace_id=$2
     WHERE s.id=$1`,
    [pkg.skillId, scope.workspaceId]);
  const prev = cur.rows[0] ?? null;
  const snapId = `snap-${pkg.skillId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await client.query(
    `INSERT INTO skill_dist_snapshots (id, skill_id, workspace_id, skill_row, install_row, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      snapId, pkg.skillId, scope.workspaceId,
      prev ? JSON.stringify({ ...prev, installed_version: undefined, fence_bindings_snapshot: undefined }) : null,
      prev?.installed_version ? JSON.stringify({ installed_version: prev.installed_version, fence_bindings_snapshot: prev.fence_bindings_snapshot }) : null,
      `装载 ${pkg.skillId}@${pkg.version}（${tier}）前自动快照`,
    ]);

  // ② 技能库 upsert（level=official：官方分发即官方套件；desensitized 对 official 无约束）
  await client.query(
    `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized, dist_meta)
     VALUES ($1,'official',NULL,$2,$3,$4,$5,$6,false,$7)
     ON CONFLICT (id) DO UPDATE SET
       name=$2, version=$3, description=$4, fence_bindings=$5, body=$6, dist_meta=$7`,
    [pkg.skillId, pkg.name, pkg.version, pkg.description, JSON.stringify(pkg.fenceBindings), pkg.body, JSON.stringify(pkg.meta)]);

  // ③ 已装技能快照跟进（升级路径：版本与围栏快照同步推进；新装技能不落 install 行——安装仍走 installSkill）
  await client.query(
    `UPDATE skill_installs SET installed_version=$3, fence_bindings_snapshot=$4
     WHERE skill_id=$1 AND workspace_id=$2`,
    [pkg.skillId, scope.workspaceId, pkg.version, JSON.stringify(pkg.fenceBindings)]);

  await emitInTx(client, scope, by, {
    action: tier === "L2" ? "skill.dist.approved_loaded" : "skill.dist.loaded",
    after: {
      skillId: pkg.skillId, name: pkg.name, version: pkg.version, tier,
      upgraded: !!prev, previousVersion: prev?.version ?? null, snapshotId: snapId,
    },
    basis: [
      `staging 五道预检全过（${checks.map((c) => c.gate).join("/")}）`,
      prev ? "已装技能版本快照同步跟进（installed_version + fence_bindings_snapshot）" : "新技能装载入技能库；安装即绑定围栏仍走 installSkill 原流程（E8.1 不旁路）",
    ],
  });
  return { upgraded: !!prev, previousVersion: prev?.version ?? null };
}

/* ---------- 主流程：同步分发 ---------- */

export interface SyncResult {
  disabled?: boolean;
  manifestVersion?: string;
  matched: number;
  loaded: Array<{ skillId: string; version: string; tier: string }>;
  pending: Array<{ skillId: string; version: string; tier: string; stagingId: string; approvalId?: string }>;
  rejected: Array<{ skillId: string; version: string; reasons: string[] }>;
  skipped: Array<{ skillId: string; reason: string }>;
}

export async function syncDistribution(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  opts: {
    registryUrl: string; signingKey: string; instance: InstanceProfile; by: string;
    fetcher?: ManifestFetcher;
    depsAvailable?: (dep: string) => boolean;
    /** 事件归因身份：缺省 = human:by（人工同步）；夜班自动同步传 { id: "night-shift", type: "system" } */
    actor?: EventActor;
  },
): Promise<SyncResult> {
  // 未配置 registry 或签名密钥 = 分发功能整体禁用（不降级为跳过验签）
  if (!opts.registryUrl || !opts.signingKey) {
    return { disabled: true, matched: 0, loaded: [], pending: [], rejected: [], skipped: [] };
  }
  const fetcher = opts.fetcher ?? defaultFetcher;
  const actor: EventActor = opts.actor ?? human(opts.by);
  const raw = await fetcher(opts.registryUrl);
  const manifest = DistManifest.parse(raw); // schema 不合直接抛错（残缺资产不静默放行，与 official.ts 同纪律）

  const result: SyncResult = { manifestVersion: manifest.registryVersion, matched: 0, loaded: [], pending: [], rejected: [], skipped: [] };
  const silentMode = await getSilentMode(app, scope);

  for (const entry of manifest.entries) {
    const pkg = entry.package;
    if (!matchesTargets(entry.targets, opts.instance)) {
      result.skipped.push({ skillId: pkg.skillId, reason: "定向不匹配" });
      continue;
    }
    result.matched++;

    // 幂等：本机版本已 ≥ 分发版本 → 跳过（同版本重推不重复装载）
    const cur = await app.query<{ version: string; dist_meta: unknown; fence_bindings: string[] }>(
      `SELECT version, dist_meta, fence_bindings FROM skills WHERE id=$1`, [pkg.skillId]);
    const curRow = cur.rows[0] ?? null;
    if (curRow && compareVersions(curRow.version, pkg.version) >= 0) {
      result.skipped.push({ skillId: pkg.skillId, reason: `本机版本 ${curRow.version} 已不落后于分发版本` });
      continue;
    }
    const currentState = curRow
      ? { meta: DistMeta.parse(curRow.dist_meta ?? {}), fenceBindings: curRow.fence_bindings ?? [] }
      : null;

    // staging 五道预检
    const staging = runStagingChecks({ pkg, signingKey: opts.signingKey, current: currentState, depsAvailable: opts.depsAvailable });
    const stagingId = `stg-${pkg.skillId}-${pkg.version}`;

    if (!staging.pass) {
      const reasons = staging.checks.filter((c) => !c.pass).map((c) => c.detail);
      await upsertStaging(app, scope, { stagingId, pkg, tier: staging.tier, checks: staging.checks, status: "rejected" });
      await emit(gateway, scope, actor, {
        action: "skill.dist.rejected",
        after: { skillId: pkg.skillId, name: pkg.name, version: pkg.version, stagingId, reasons },
        basis: ["staging 预检不过不装载、不降级（方案 v0.2 §3.3）；留档供审计"],
      });
      result.rejected.push({ skillId: pkg.skillId, version: pkg.version, reasons });
      continue;
    }

    // 定级分流
    if (staging.tier === "L2") {
      // L2 永不静默：入 staging + 审批提案（幂等：同 staging 已有 pending 审批则复用）
      const existing = await app.query<{ approval_id: string | null }>(
        `SELECT approval_id FROM skill_dist_staging WHERE id=$1 AND status='pending'`, [stagingId]);
      let approvalId = existing.rows[0]?.approval_id ?? undefined;
      if (!approvalId) {
        const evId = await emit(gateway, scope, actor, {
          action: "skill.dist.pending_approval",
          after: { skillId: pkg.skillId, name: pkg.name, version: pkg.version, stagingId, tier: "L2", diff: staging.diff },
          basis: ["L2 执行面/权限面变化永不静默，走审批（升级永不自动铁律）"],
        });
        approvalId = `apr-${evId.toLowerCase()}`;
        const client = await app.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
          await client.query(
            // tier='l4_chairman'：权限面扩张=董事长级人审（围栏放宽同层），
            // 必须显式指定——缺省 tier='l2_captain' 会被数字CEO队列节拍自动裁决，绕过 L2 永不静默红线
            `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot, tier)
             VALUES ($1,$2,$3,$4,'inapp','pending',$5,'l4_chairman')`,
            [approvalId, scope.tenantId, scope.workspaceId, evId,
             JSON.stringify({ kind: "skill_dist_install", stagingId, skillId: pkg.skillId, version: pkg.version })]);
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          await client.query("COMMIT").catch(() => undefined);
          client.release();
        }
      }
      await upsertStaging(app, scope, { stagingId, pkg, tier: "L2", checks: staging.checks, status: "pending", approvalId });
      result.pending.push({ skillId: pkg.skillId, version: pkg.version, tier: "L2", stagingId, approvalId });
      continue;
    }

    // L0/L1：silent → 立即热装载；prompt → 入 staging 待人工
    if (silentMode === "prompt") {
      await upsertStaging(app, scope, { stagingId, pkg, tier: staging.tier, checks: staging.checks, status: "pending" });
      await emit(gateway, scope, actor, {
        action: "skill.dist.staged",
        after: { skillId: pkg.skillId, name: pkg.name, version: pkg.version, stagingId, tier: staging.tier },
        basis: ["静默策略=prompt：L0/L1 入 staging 待人工装载（提示后升级）"],
      });
      result.pending.push({ skillId: pkg.skillId, version: pkg.version, tier: staging.tier, stagingId });
      continue;
    }

    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await loadPackageInTx(client, scope, pkg, staging.tier, actor, staging.checks);
      await client.query(
        `INSERT INTO skill_dist_staging (id, skill_id, workspace_id, tier, package, checks, status, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,'loaded',now())
         ON CONFLICT (id) DO UPDATE SET status='loaded', decided_at=now(), checks=$6, package=$5, tier=$4`,
        [stagingId, pkg.skillId, scope.workspaceId, staging.tier, JSON.stringify(pkg), JSON.stringify(staging.checks)]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
    result.loaded.push({ skillId: pkg.skillId, version: pkg.version, tier: staging.tier });
  }

  // 同步游标 + 总事件
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query(
      `INSERT INTO skill_dist_state (workspace_id, last_manifest_version, last_sync_at)
       VALUES ($1,$2,now())
       ON CONFLICT (workspace_id) DO UPDATE SET last_manifest_version=$2, last_sync_at=now()`,
      [scope.workspaceId, manifest.registryVersion]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
  await emit(gateway, scope, actor, {
    action: "skill.dist.sync",
    after: {
      manifestVersion: manifest.registryVersion,
      matched: result.matched, loaded: result.loaded.length,
      pending: result.pending.length, rejected: result.rejected.length, skipped: result.skipped.length,
    },
    basis: ["下行分发同步完成（拉取为主通道；夜班窗口/手动立即同步同路径）"],
  });
  return result;
}

async function upsertStaging(
  app: pg.Pool, scope: Scope,
  row: { stagingId: string; pkg: SkillPackage; tier: string; checks: StagingCheck[]; status: string; approvalId?: string },
): Promise<void> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query(
      `INSERT INTO skill_dist_staging (id, skill_id, workspace_id, tier, package, checks, status, approval_id, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7='rejected' THEN now() ELSE NULL END)
       ON CONFLICT (id) DO UPDATE SET tier=$4, package=$5, checks=$6, status=$7,
         approval_id=COALESCE($8, skill_dist_staging.approval_id),
         decided_at=CASE WHEN $7='rejected' THEN now() ELSE skill_dist_staging.decided_at END`,
      [row.stagingId, row.pkg.skillId, scope.workspaceId, row.tier,
       JSON.stringify(row.pkg), JSON.stringify(row.checks), row.status, row.approvalId ?? null]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/* ---------- 人工装载（prompt 策略项 / L2 审批通过项） ---------- */

export async function loadStaging(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { stagingId: string; by: string },
): Promise<{ skillId: string; version: string; tier: string }> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{
      id: string; skill_id: string; tier: string; package: SkillPackage;
      checks: StagingCheck[]; status: string; approval_id: string | null;
    }>(`SELECT * FROM skill_dist_staging WHERE id=$1 FOR UPDATE`, [input.stagingId]);
    const row = r.rows[0];
    if (!row) throw new SkillOpsError("NOT_FOUND", `staging 项 ${input.stagingId} 不存在`);
    if (row.status === "loaded") {
      await client.query("COMMIT");
      return { skillId: row.skill_id, version: row.package.version, tier: row.tier }; // 幂等
    }
    if (row.status !== "pending") {
      throw new SkillOpsError("BAD_STATE", `staging 项状态 ${row.status}，仅 pending 可装载`);
    }
    if (row.tier === "L2") {
      // L2 必须审批已通过（approvalRef 验真口径同段③：查无此行/状态不符一律拒绝）
      if (!row.approval_id) throw new SkillOpsError("NOT_APPROVED", "L2 staging 项缺审批单，拒绝装载");
      const ap = await client.query<{ status: string }>(
        `SELECT status FROM approvals WHERE approval_id=$1`, [row.approval_id]);
      if (ap.rows[0]?.status !== "approved") {
        throw new SkillOpsError("NOT_APPROVED", `审批单 ${row.approval_id} 状态 ${ap.rows[0]?.status ?? "不存在"}，L2 装载须审批通过（升级永不自动）`);
      }
    }
    const pkg = row.package;
    await loadPackageInTx(client, scope, pkg, row.tier, human(input.by), row.checks ?? []);
    await client.query(`UPDATE skill_dist_staging SET status='loaded', decided_at=now() WHERE id=$1`, [input.stagingId]);
    await client.query("COMMIT");
    return { skillId: row.skill_id, version: pkg.version, tier: row.tier };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/* ---------- 回滚 ---------- */

export async function rollbackSkill(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { skillId: string; by: string },
): Promise<{ restoredVersion: string | null; snapshotId: string }> {
  interface SnapRow {
    id: string;
    skill_row: {
      id: string; level: string; bundle: string | null; name: string; version: string;
      description: string; fence_bindings: string[]; body: string; desensitized: boolean; dist_meta: unknown;
    } | null;
    install_row: { installed_version: string; fence_bindings_snapshot: string[] } | null;
  }
  const client = await app.connect();
  let snap: SnapRow | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<SnapRow>(
      `SELECT id, skill_row, install_row FROM skill_dist_snapshots
       WHERE skill_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [input.skillId]);
    snap = r.rows[0];
    if (!snap) throw new SkillOpsError("NO_SNAPSHOT", `技能 ${input.skillId} 无可用快照，无法回滚`);

    if (snap.skill_row) {
      // 恢复旧 skills 行（dist_meta 等全字段恢复）
      const s = snap.skill_row;
      await client.query(
        `UPDATE skills SET level=$2, bundle=$3, name=$4, version=$5, description=$6, fence_bindings=$7, body=$8, desensitized=$9, dist_meta=$10
         WHERE id=$1`,
        [s.id, s.level, s.bundle, s.name, s.version, s.description,
         JSON.stringify(s.fence_bindings ?? []), s.body, s.desensitized, JSON.stringify(s.dist_meta ?? {})]);
    } else {
      // 首装回滚 = 从技能库移除
      await client.query(`DELETE FROM skills WHERE id=$1`, [input.skillId]);
    }
    if (snap.install_row) {
      await client.query(
        `UPDATE skill_installs SET installed_version=$3, fence_bindings_snapshot=$4
         WHERE skill_id=$1 AND workspace_id=$2`,
        [input.skillId, scope.workspaceId, snap.install_row.installed_version, JSON.stringify(snap.install_row.fence_bindings_snapshot)]);
    } else {
      await client.query(`DELETE FROM skill_installs WHERE skill_id=$1 AND workspace_id=$2`, [input.skillId, scope.workspaceId]);
    }
    // 快照为栈语义：回滚即消费——恢复到该快照状态后，下一次回滚取更早一份
    await client.query(`DELETE FROM skill_dist_snapshots WHERE id=$1`, [snap.id]);
    await emitInTx(client, scope, human(input.by), {
      action: "skill.dist.rollback",
      after: {
        skillId: input.skillId, snapshotId: snap.id,
        restoredVersion: snap.skill_row?.version ?? null,
      },
      basis: ["回滚即恢复装载前快照（skills 行 + install 快照同事务恢复）；回滚本身留痕可审计"],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
  return {
    restoredVersion: snap!.skill_row?.version ?? null,
    snapshotId: snap!.id,
  };
}

/* ---------- 状态查询（技能中心 + 通栏通知投影） ---------- */

export async function distStatus(app: pg.Pool, scope: Scope) {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const staging = await client.query(
      `SELECT id, skill_id, tier, status, approval_id, created_at, decided_at,
              package->>'name' AS name, package->>'version' AS version
       FROM skill_dist_staging ORDER BY created_at DESC LIMIT 50`);
    const policy = await client.query(
      `SELECT silent_mode, auto_sync, updated_by, updated_at FROM skill_dist_policy WHERE workspace_id=$1`, [scope.workspaceId]);
    const state = await client.query(
      `SELECT last_manifest_version, last_sync_at FROM skill_dist_state WHERE workspace_id=$1`, [scope.workspaceId]);
    // 通栏通知数据源①：近 24h 装载事件（静默/审批装载；auto=系统归因即夜班自动）
    const loaded = await client.query<{
      skillId: string; name: string; version: string; tier: string; at: Date; auto: boolean;
    }>(
      `SELECT payload->'decision'->'after'->>'skillId' AS "skillId",
              payload->'decision'->'after'->>'name' AS name,
              payload->'decision'->'after'->>'version' AS version,
              payload->'decision'->'after'->>'tier' AS tier,
              created_at AS at,
              (payload->'who'->>'type' = 'system') AS auto
       FROM biz_events
       WHERE workspace_id=$1
         AND payload->'decision'->>'action' IN ('skill.dist.loaded','skill.dist.approved_loaded')
         AND created_at > now() - interval '24 hours'
       ORDER BY created_at DESC LIMIT 10`, [scope.workspaceId]);
    // 通栏通知数据源②：待审批/待装载计数（L2 审批提案 + prompt 待装载）
    const pending = await client.query<{ c: string }>(
      `SELECT count(*) AS c FROM skill_dist_staging WHERE status='pending'`);
    await client.query("COMMIT");
    return {
      staging: staging.rows,
      silentMode: policy.rows[0]?.silent_mode ?? "silent",
      autoSync: policy.rows[0]?.auto_sync ?? true,
      policyUpdatedBy: policy.rows[0]?.updated_by ?? null,
      lastManifestVersion: state.rows[0]?.last_manifest_version ?? null,
      lastSyncAt: state.rows[0]?.last_sync_at ?? null,
      recentLoaded: loaded.rows,
      pendingCount: Number(pending.rows[0]?.c ?? 0),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}
