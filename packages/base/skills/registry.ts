/**
 * skills · 技能注册与安装（F8.1/F8.2，L8.1–L8.4，E8.1/E8.2）
 *
 * 三级体系（F8.1）：official（随行业 Bundle 分发）/ team（工作区自建）/ industry（脱敏后跨组织）
 * 铁律落点：
 *  - L8.1 industry 层上架/安装前必须 desensitized=true，否则拦截（E8.4 禁止降级）
 *  - L8.2 生产仅签名白名单：首版白名单 = official（bundle 官方套件）+ team（本工作区自建）；
 *         其余来源一律拒绝（E8.2 拦截 + 安全事件留痕）
 *  - F8.2/L8.3 安装即绑定围栏、卸载即撤销：围栏绑定 = preset.fence_bindings ∪ 已装技能 fence_bindings
 *    的逻辑并集（resolveAgentFenceBindings 为运行时唯一消费点），卸载即并集收缩
 *  - E8.1 安装前冲突检测：绑定围栏必须存在于当前生效规则集；冲突项进审批（不静默放行）
 *  - F8.3 团队自建技能生效前必须 dry-run 预览（无 skill.dry_run 留痕 → 拒绝安装并提示先预览）
 */
import type pg from "pg";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { isSkillRevoked } from "./publish.js";


interface Scope { tenantId: string; workspaceId: string }

export type SkillLevel = "official" | "team" | "industry";

export interface SkillRow {
  id: string;
  level: SkillLevel;
  bundle: string | null;
  name: string;
  version: string;
  description: string;
  fence_bindings: string[];
  body: string;
  desensitized: boolean;
}

export class SkillError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND" | "NOT_DESENSITIZED" | "NOT_SIGNED"
      | "FENCE_CONFLICT" | "NEED_DRY_RUN" | "NOT_INSTALLED"
      | "SKILL_REVOKED" | "PUBLISH_SCAN_FAILED" | "SELF_REVIEW_FORBIDDEN"
      | "DUPLICATE_REVIEW" | "EMPTY_REASON" | "NOT_APPROVED",
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

/** 事务内事件留痕（D16：调用方持有事务，与业务写同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  by: string,
  decision: Record<string, unknown>,
  links?: string[],
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "human" },
  }, {
    who: { type: "human", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "skill", id: (decision.after as { skillId?: string } | undefined)?.skillId },
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

async function emit(
  gateway: pg.Pool,
  scope: Scope,
  by: string,
  decision: Record<string, unknown>,
  links?: string[],
): Promise<string> {
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "human" },
  }, {
    who: { type: "human", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "skill", id: (decision.after as { skillId?: string } | undefined)?.skillId },
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

export async function getSkill(app: pg.Pool, skillId: string): Promise<SkillRow | null> {
  const r = await app.query<SkillRow>(`SELECT * FROM skills WHERE id=$1`, [skillId]);
  return r.rows[0] ?? null;
}

/**
 * 技能列表（#23 修复：team 级按工作区隔离——skills 是无 RLS 的全局表，
 * team 技能 ID 内嵌 workspaceId，他区自建技能对本工作区不可见）
 */
export async function listSkills(app: pg.Pool, scope: Scope, opts: { level?: SkillLevel } = {}): Promise<SkillRow[]> {
  const teamPrefix = `skill-t-${scope.workspaceId}-%`;
  const r = opts.level
    ? await app.query<SkillRow>(
        `SELECT * FROM skills WHERE level=$1 AND (level <> 'team' OR id LIKE $2) ORDER BY id`,
        [opts.level, teamPrefix],
      )
    : await app.query<SkillRow>(
        `SELECT * FROM skills WHERE level <> 'team' OR id LIKE $1 ORDER BY id`,
        [teamPrefix],
      );
  return r.rows;
}

export async function listInstalls(app: pg.Pool, scope: Scope): Promise<Array<{ skill_id: string; installed_by: string; installed_at: Date }>> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ skill_id: string; installed_by: string; installed_at: Date }>(
      `SELECT skill_id, installed_by, installed_at FROM skill_installs WHERE workspace_id=$1 ORDER BY installed_at`,
      [scope.workspaceId],
    );
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** L8.2 签名白名单（首版演示口径；第三方入库前代码审计进流程，不落代码） */
export function isSignedSource(skill: SkillRow, scope: Scope): boolean {
  if (skill.level === "official") return true; // 随行业 Bundle 分发的官方套件
  if (skill.level === "team") return skill.id.startsWith(`skill-t-`); // 本工作区零代码自建（forge.ts 命名空间）
  return false; // industry 共享层须另走白名单签发（首版不放行）
}

/** team 技能本工作区归属校验（#23：skill-t-<workspaceId>- 前缀才视为「本工作区自建」） */
export function isOwnWorkspaceSkill(skill: SkillRow, scope: Scope): boolean {
  return skill.level !== "team" || skill.id.startsWith(`skill-t-${scope.workspaceId}-`);
}

/** E8.1 冲突检测（纯函数）：绑定围栏 vs 当前生效规则集 → 缺失/未生效即冲突 */
export function detectFenceConflicts(
  bindings: string[],
  activeRuleIds: Set<string>,
): { missing: string[] } {
  return { missing: bindings.filter((b) => !activeRuleIds.has(b)) };
}

async function activeRuleIds(app: pg.Pool, scope: Scope): Promise<Set<string>> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ rule_id: string }>(
      `SELECT DISTINCT rule_id FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'`,
      [scope.workspaceId],
    );
    return new Set(r.rows.map((x) => x.rule_id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** F8.3 前置：团队技能须已有 dry-run 预览留痕（生效前 dry-run） */
async function hasDryRunTrace(app: pg.Pool, scope: Scope, skillId: string): Promise<boolean> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ c: string }>(
      `SELECT count(*) AS c FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action'='skill.dry_run'
         AND payload->'decision'->'after'->>'skillId'=$2`,
      [scope.workspaceId, skillId],
    );
    return Number(r.rows[0]?.c ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** 安装（F8.2）：全部前置校验过 → 写 skill_installs（幂等）+ skill.installed 事件（含绑定清单） */
export async function installSkill(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: { skillId: string; by: string },
): Promise<{ installed: boolean; deduped: boolean; bindings: string[] }> {
  const skill = await getSkill(app, input.skillId);
  if (!skill) throw new SkillError("NOT_FOUND", `技能 ${input.skillId} 不存在`);

  // L8.1：industry 共享层必须脱敏
  if (skill.level === "industry" && !skill.desensitized) {
    throw new SkillError("NOT_DESENSITIZED", `行业共享技能「${skill.name}」未脱敏（desensitized=false），拦截安装（L8.1/E8.4 禁止降级）`);
  }
  // D15-④：全局吊销（kill switch）——任何级别吊销技能禁止新安装，并留痕
  if (await isSkillRevoked(app, skill.id)) {
    const evId = await emit(gateway, scope, input.by, {
      action: "skill.install.blocked",
      after: { skillId: skill.id, name: skill.name, reason: "SKILL_REVOKED", level: skill.level },
      basis: ["全局吊销技能禁止安装（D15-④ kill switch）"],
    });
    throw new SkillError("SKILL_REVOKED", `技能「${skill.name}」已被全局吊销（D15-④），已拦截并留痕 ${evId}`);
  }
  // #23：team 技能仅限本工作区自建（skill-t-<workspaceId>- 命名空间），他区技能按未签名拦截
  if (!isOwnWorkspaceSkill(skill, scope)) {
    const evId = await emit(gateway, scope, input.by, {
      action: "skill.install.blocked",
      after: { skillId: skill.id, name: skill.name, reason: "NOT_OWN_WORKSPACE", level: skill.level },
      basis: ["team 技能仅限本工作区自建命名空间（#23：skill-t-<workspaceId>-），他区技能拦截留痕"],
    });
    throw new SkillError("NOT_SIGNED", `技能「${skill.name}」非本工作区自建（#23 命名空间隔离），已拦截并留痕 ${evId}`);
  }
  // L8.2：签名白名单
  if (!isSignedSource(skill, scope)) {
    const evId = await emit(gateway, scope, input.by, {
      action: "skill.install.blocked",
      after: { skillId: skill.id, name: skill.name, reason: "NOT_SIGNED", level: skill.level },
      basis: ["生产环境仅允许签名白名单内技能（L8.2/E8.2）"],
    });
    throw new SkillError("NOT_SIGNED", `技能「${skill.name}」不在签名白名单（L8.2），已拦截并留痕 ${evId}`);
  }
  // F8.3：团队自建先生效预览
  if (skill.level === "team" && !(await hasDryRunTrace(app, scope, skill.id))) {
    throw new SkillError("NEED_DRY_RUN", `团队自建技能「${skill.name}」生效前须 dry-run 预览（F8.3），请先调用 skills.dryRun`);
  }
  // E8.1：围栏冲突检测 → 冲突项进审批，不静默放行
  const bindings = skill.fence_bindings ?? [];
  if (bindings.length > 0) {
    const active = await activeRuleIds(app, scope);
    const { missing } = detectFenceConflicts(bindings, active);
    if (missing.length > 0) {
      const evId = await emit(gateway, scope, input.by, {
        action: "skill.install.conflict",
        after: { skillId: skill.id, name: skill.name, missingBindings: missing },
        basis: ["技能与现有围栏冲突：冲突项进审批，不静默放行（E8.1）"],
      });
      const client = await app.connect();
      try {
        // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await client.query(
          `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
           VALUES ($1,$2,$3,$4,'inapp','pending',$5)`,
          [
            // #28 修复：approval_id 由事件 ID 确定性派生（同 loop.ts 口径 apr-e-<n>），
            // 原 makeReadableId("AP", Date.now()%100000) 同毫秒两审批即主键碰撞
            `apr-${evId.toLowerCase()}`, scope.tenantId, scope.workspaceId, evId,
            JSON.stringify({ kind: "skill_fence_conflict", skillId: skill.id, missingBindings: missing }),
          ],
        );
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        await client.query("COMMIT").catch(() => undefined);
        client.release();
      }
      throw new SkillError("FENCE_CONFLICT", `技能「${skill.name}」绑定围栏 ${missing.join("/")} 未生效，冲突项已进审批（E8.1），安装挂起`);
    }
  }

  // 落安装（幂等 L1.4 同源：重复安装不报错）
  // #17 修复：安装时快照 fence_bindings，运行时读快照而非实时值，防止技能作者更新绑定绕过冲突检测
  // D16（#1/A）：安装行与 skill.installed 事件同一事务同一 COMMIT
  const client = await app.connect();
  let deduped = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    // D15-⑤：安装时记录版本快照（installed_version），供 listSkillUpdates 版本通道对比
    const r = await client.query(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
      [skill.id, scope.workspaceId, input.by, JSON.stringify(bindings), skill.version],
    );
    deduped = r.rowCount === 0;
    if (!deduped) {
      await emitInTx(client, scope, input.by, {
        action: "skill.installed",
        after: { skillId: skill.id, name: skill.name, level: skill.level, bindings },
        basis: ["安装即绑定围栏（F8.2）；技能动作照常过围栏瀑布（L8.3，运行时由 tools/pre-execute 瀑布强制）"],
      });
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
  return { installed: true, deduped, bindings };
}

/** 卸载（L8.3）：删 install 行（绑定并集即收缩）+ skill.uninstalled 事件（记录撤销清单） */
export async function uninstallSkill(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: { skillId: string; by: string },
): Promise<{ uninstalled: boolean; revokedBindings: string[] }> {
  const skill = await getSkill(app, input.skillId);
  if (!skill) throw new SkillError("NOT_FOUND", `技能 ${input.skillId} 不存在`);
  const client = await app.connect();
  let removed = 0;
  // #40 修复：撤销清单读安装时快照（与 #17 口径一致）——此前读 skills.fence_bindings
  // 实时值，若技能作者安装后改过绑定，卸载留痕的撤销清单与实际安装清单不符。
  // 快照一致性（双路径同构）：seed 直写与运行时 installSkill 两条安装路径都落
  // fence_bindings_snapshot=安装时刻 skills.fence_bindings、installed_version=skills.version，
  // 因此此处 snapshot 必有值；`?? skill.fence_bindings` 仅为历史行（快照列上线前安装）兜底，
  // 兜底值与 seed 快照同源（同读 skills 表），口径不分裂。
  let revokedBindings: string[] = [];
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const snap = await client.query<{ fence_bindings_snapshot: string[] }>(
      `SELECT fence_bindings_snapshot FROM skill_installs WHERE skill_id=$1 AND workspace_id=$2`,
      [skill.id, scope.workspaceId],
    );
    revokedBindings = snap.rows[0]?.fence_bindings_snapshot ?? skill.fence_bindings ?? [];
    const r = await client.query(
      `DELETE FROM skill_installs WHERE skill_id=$1 AND workspace_id=$2`,
      [skill.id, scope.workspaceId],
    );
    removed = r.rowCount ?? 0;
    // D16（#1/A）：删除行与 skill.uninstalled 事件同一事务（removed=0 时事件也不写，一并滚回）
    if (removed > 0) {
      await emitInTx(client, scope, input.by, {
        action: "skill.uninstalled",
        after: { skillId: skill.id, name: skill.name, revokedBindings },
        basis: ["卸载即撤销围栏绑定（F8.2/L8.3：绑定并集随 install 行删除即时收缩，US8.5 不留后门）"],
      });
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
  if (removed === 0) throw new SkillError("NOT_INSTALLED", `技能「${skill.name}」未安装到本工作区`);
  return { uninstalled: true, revokedBindings };
}

/**
 * 运行时并集口径（L8.3/F8.2）：Agent 生效围栏 = preset 声明 ∪ 已装技能绑定（安装时快照）。
 * 消费点：runtime 装配（B8 assembly.ts，#24 已接线取并集，同一事务内直查快照）；
 * 本函数供查询/测试与后续消费点复用。
 */
export async function resolveAgentFenceBindings(
  app: pg.Pool,
  scope: Scope,
  agentId: string,
): Promise<string[]> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const ag = await client.query<{ fence_bindings: string[] }>(
      `SELECT fence_bindings FROM agents WHERE id=$1 AND workspace_id=$2`,
      [agentId, scope.workspaceId],
    );
    const base = ag.rows[0]?.fence_bindings ?? [];
    // #17 修复：读 skill_installs.fence_bindings_snapshot（安装时快照），而非 skills.fence_bindings（实时值）
    // 防止技能作者在安装后更新 skills.fence_bindings 绕过 E8.1 冲突检测
    // D15-④：全局吊销的技能不再并入装配围栏（kill switch）
    const sk = await client.query<{ fence_bindings_snapshot: string[] }>(
      `SELECT i.fence_bindings_snapshot FROM skill_installs i
       WHERE i.workspace_id=$1
         AND NOT EXISTS (SELECT 1 FROM skill_revocations r WHERE r.skill_id = i.skill_id)`,
      [scope.workspaceId],
    );
    const union = new Set<string>(base);
    for (const row of sk.rows) for (const b of row.fence_bindings_snapshot ?? []) union.add(b);
    return [...union].sort();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** L8.4 行业资产验证闸门（纯函数）：未 verified / 未脱敏的资产在任何入口不可批量复用 */
export function isAssetReusable(asset: {
  share_scope: string;
  desensitized: boolean;
  payload?: { verified?: boolean };
}): boolean {
  if (asset.payload?.verified !== true) return false; // 未通过验证闸门
  if (asset.share_scope === "industry" && !asset.desensitized) return false; // L8.1/E8.4
  return true;
}
