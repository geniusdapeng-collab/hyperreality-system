/**
 * service/bundle · 行业装配机制（方案 V4 §3 一键清空 / §6 L3 编制生成 / §7 上岗考）
 * 契约：
 *  - 清空前必须快照成功（bundle_snapshots 写入失败禁止清空）；
 *  - 卸载按 bundle_installs 台账逐项执行，不清糊涂账；
 *  - 红线：biz_events / members / 审计记录永不清空；清空动作五元事件留痕；
 *  - L3 编制生成：草案先行（wizard_staffing_drafts），人审确认才装配（预览即所装）。
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { svcQuery, serviceTx, appendEventOn } from "./events.js";
import { llmCall } from "./llm.js";
import {
  runCandidateOnboardingExam,
  type CandidateExamTarget,
  type CandidateRoleResult,
} from "./eval.js";
import {
  sameExamBinding,
  sha256Canonical,
  staffingAssemblyHash,
  staffingDraftHash,
  type ExamBinding,
} from "./onboarding-truth.js";

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

/* ---------------- 装配台账 ---------------- */
export interface BundleInstall {
  id: string; bundle_id: string; assets: {
    preset_ids?: string[]; fence_rule_ids?: string[]; skill_ids?: string[];
    kb_collection_ids?: string[]; seed_batch_id?: string;
  }; status: string; installed_at: string;
  draft_id?: string | null;
  assembly_version?: number | null;
  assembly_hash?: string | null;
  qualified_exam_id?: string | null;
}

/** 原子切换与回滚都必须先证明当前最多只有一套生效装配；异常时失败关闭。 */
export function requireAtMostOneActiveInstall<T>(rows: readonly T[], operation: "切换" | "回滚"): T | null {
  if (rows.length > 1) throw new Error(`检测到多个生效装配，已中止${operation}，请先修复装配台账`);
  return rows[0] ?? null;
}

interface BundleSnapshotPayload {
  install: BundleInstall;
  note: string;
  reason?: "manual-clear" | "atomic-switch" | "rollback-replacement";
  workspace?: {
    bundleId: string | null;
    isExample: boolean;
    industry: string;
    profileCustomization: unknown | null;
  };
  previous?: {
    agents: Array<{ id: string; status: string }>;
    fences: Array<{ id: string; status: string }>;
    skillInstalls: Array<{
      skill_id: string; installed_by: string; fence_bindings_snapshot: string[]; installed_version: string;
    }>;
    kbCollections: Array<{ id: string; status: string }>;
    kbDocuments: Array<{ id: string; status: string }>;
    staffingDraft: { id: string; status: string } | null;
  };
}

async function captureInstallSnapshotOn(
  client: pg.PoolClient,
  workspaceId: string,
  install: BundleInstall,
  input: { note: string; reason: NonNullable<BundleSnapshotPayload["reason"]> },
): Promise<string> {
  const assets = install.assets;
  const workspaceRows = await client.query<{
    bundle_id: string | null; is_example: boolean; industry: string; profile_customization: unknown | null;
  }>(
    `SELECT w.bundle_id, w.is_example, w.industry,
            p.archive->'customization' AS profile_customization
     FROM workspaces w LEFT JOIN profiles p ON p.workspace_id=w.id
     WHERE w.id=$1`,
    [workspaceId],
  );
  const workspace = workspaceRows.rows[0];
  if (!workspace) throw new Error("工作区状态读取失败，已中止切换");
  const previous: NonNullable<BundleSnapshotPayload["previous"]> = {
    agents: assets.preset_ids?.length ? (await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM agents WHERE workspace_id=$1 AND id=ANY($2)`, [workspaceId, assets.preset_ids],
    )).rows : [],
    fences: assets.fence_rule_ids?.length ? (await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM fence_rules WHERE workspace_id=$1 AND id=ANY($2)`, [workspaceId, assets.fence_rule_ids],
    )).rows : [],
    skillInstalls: assets.skill_ids?.length ? (await client.query<{
      skill_id: string; installed_by: string; fence_bindings_snapshot: string[]; installed_version: string;
    }>(
      `SELECT skill_id, installed_by, fence_bindings_snapshot, installed_version
       FROM skill_installs WHERE workspace_id=$1 AND skill_id=ANY($2)`, [workspaceId, assets.skill_ids],
    )).rows : [],
    kbCollections: assets.kb_collection_ids?.length ? (await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM kb_collections WHERE workspace_id=$1 AND id=ANY($2)`, [workspaceId, assets.kb_collection_ids],
    )).rows : [],
    kbDocuments: assets.kb_collection_ids?.length ? (await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM kb_documents WHERE workspace_id=$1 AND collection_id=ANY($2)`, [workspaceId, assets.kb_collection_ids],
    )).rows : [],
    staffingDraft: install.draft_id ? (await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM wizard_staffing_drafts WHERE workspace_id=$1 AND id=$2`, [workspaceId, install.draft_id],
    )).rows[0] ?? null : null,
  };
  const snapshotId = newId("bs");
  const payload: BundleSnapshotPayload = {
    install,
    note: input.note,
    reason: input.reason,
    workspace: {
      bundleId: workspace.bundle_id,
      isExample: workspace.is_example,
      industry: workspace.industry,
      profileCustomization: workspace.profile_customization,
    },
    previous,
  };
  const inserted = await client.query(
    `INSERT INTO bundle_snapshots (id, workspace_id, bundle_id, install_id, payload)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [snapshotId, workspaceId, install.bundle_id, install.id, JSON.stringify(payload)],
  );
  if (!inserted.rows[0]) throw new Error("快照写入失败，已中止切换");
  return snapshotId;
}

async function deactivateInstallOn(
  client: pg.PoolClient,
  workspaceId: string,
  install: BundleInstall,
): Promise<void> {
  const assets = install.assets;
  if (assets.preset_ids?.length) {
    await client.query(`UPDATE agents SET status='disabled' WHERE workspace_id=$1 AND id=ANY($2)`, [workspaceId, assets.preset_ids]);
  }
  if (assets.skill_ids?.length) {
    await client.query(`DELETE FROM skill_installs WHERE workspace_id=$1 AND skill_id=ANY($2)`, [workspaceId, assets.skill_ids]);
  }
  if (assets.fence_rule_ids?.length) {
    await client.query(`UPDATE fence_rules SET status='rolled_back' WHERE workspace_id=$1 AND id=ANY($2)`, [workspaceId, assets.fence_rule_ids]);
  }
  if (assets.kb_collection_ids?.length) {
    await client.query(`UPDATE kb_documents SET status='disabled' WHERE workspace_id=$1 AND collection_id=ANY($2)`, [workspaceId, assets.kb_collection_ids]);
    await client.query(`UPDATE kb_collections SET status='disabled' WHERE workspace_id=$1 AND id=ANY($2)`, [workspaceId, assets.kb_collection_ids]);
  }
  await client.query(
    `UPDATE bundle_installs SET status='uninstalled', uninstalled_at=now()
     WHERE workspace_id=$1 AND id=$2`, [workspaceId, install.id],
  );
  if (install.draft_id) {
    await client.query(
      `UPDATE wizard_staffing_drafts SET status='retired'
       WHERE workspace_id=$1 AND id=$2 AND status='active'`, [workspaceId, install.draft_id],
    );
  }
}

export async function activeInstall(workspaceId: string): Promise<BundleInstall | null> {
  const rows = await svcQuery<BundleInstall & Record<string, unknown>>(workspaceId,
    `SELECT * FROM bundle_installs WHERE status='active' ORDER BY installed_at DESC LIMIT 1`);
  return rows[0] ?? null;
}

/* ---------------- 清空预览（明示范围：将卸什么/将留什么） ---------------- */
export async function clearPreview(workspaceId: string) {
  const install = await activeInstall(workspaceId);
  if (!install) return { install: null, uninstall: [], keep: ["基座能力", "账户成员", "事件哈希链", "审计记录"] };
  const a = install.assets;
  return {
    install: { id: install.id, bundleId: install.bundle_id, installedAt: install.installed_at },
    uninstall: [
      ...(a.preset_ids?.length ? [`数字员工 ${a.preset_ids.length} 个（停用）`] : []),
      ...(a.skill_ids?.length ? [`技能安装 ${a.skill_ids.length} 项（卸载安装行）`] : []),
      ...(a.fence_rule_ids?.length ? [`围栏规则 ${a.fence_rule_ids.length} 条（停用）`] : []),
      ...(a.kb_collection_ids?.length ? [`行业知识集 ${a.kb_collection_ids.length} 个（含文档）`] : []),
    ],
    keep: ["基座能力（围栏引擎/事件库/技能市场/考试院/3D 视图）", "账户与人类成员", "演示期事件与业务样例（保留为历史，不冒充正式数据）", "事件哈希链存证（永不删除）", "审计记录", "行业包本体（可随时重新装配）"],
  };
}

/* ---------------- 一键清空 ---------------- */
export async function clearBundle(workspaceId: string, actor: { id: string; type: "human" | "agent" }): Promise<{ snapshotId: string; uninstalled: string[] }> {
  return serviceTx(workspaceId, async (client, sc) => {
    await client.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const installRows = await client.query<BundleInstall & Record<string, unknown>>(
      `SELECT * FROM bundle_installs WHERE workspace_id=$1 AND status='active'
       ORDER BY installed_at DESC LIMIT 1 FOR UPDATE`, [workspaceId],
    );
    const install = installRows.rows[0];
    if (!install) throw new Error("当前无已装配的行业包——无需清空");
    const a = install.assets;
    // ① 快照（未成功写入禁止清空——红线）
    const snapshotId = await captureInstallSnapshotOn(client, workspaceId, install, {
      note: "清空前自动快照，30 天可回滚",
      reason: "manual-clear",
    });

    const uninstalled: string[] = [];

    // ② 台账逐项卸载
    if (a.preset_ids?.length) uninstalled.push(`数字员工 ${a.preset_ids.length} 个已停用`);
    if (a.skill_ids?.length) uninstalled.push(`技能安装 ${a.skill_ids.length} 项已卸载`);
    if (a.fence_rule_ids?.length) uninstalled.push(`围栏规则 ${a.fence_rule_ids.length} 条已停用`);
    if (a.kb_collection_ids?.length) uninstalled.push(`行业知识集 ${a.kb_collection_ids.length} 个已停用`);
    await deactivateInstallOn(client, workspaceId, install);

    // ③ 台账关闭 + 工作区示例标记清除
    await client.query(
      `UPDATE workspaces SET is_example=false, bundle_id=NULL WHERE id=$1`, [workspaceId]);

    // ④ 留痕上链（五元：谁/何时/卸了什么/快照指针）
    await appendEventOn(client, sc, actor, {
      objectType: "bundle", objectId: install.bundle_id,
      action: "bundle.uninstall",
      after: { snapshot_id: snapshotId, uninstalled },
    });

    return { snapshotId, uninstalled };
  });
}

/* ---------------- 快照回滚 ---------------- */
export async function rollbackSnapshot(workspaceId: string, snapshotId: string, actor: { id: string; type: "human" | "agent" }): Promise<{ restored: boolean; replacedSnapshotId: string | null }> {
  return serviceTx(workspaceId, async (client, sc) => {
    await client.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const snap = await client.query<{ payload: BundleSnapshotPayload }>(
      `SELECT payload FROM bundle_snapshots WHERE workspace_id=$2 AND id=$1 AND expires_at > now() AND restored_at IS NULL FOR UPDATE`,
      [snapshotId, workspaceId]);
    if (!snap.rows[0]) throw new Error("快照不存在或已过期（30 天）");
    const install = snap.rows[0].payload.install;
    const previous = snap.rows[0].payload.previous;
    const a = install.assets;
    const activeRows = await client.query<BundleInstall & Record<string, unknown>>(
      `SELECT * FROM bundle_installs
       WHERE workspace_id=$1 AND status='active' AND id<>$2
       ORDER BY installed_at DESC FOR UPDATE`, [workspaceId, install.id],
    );
    const replaced = requireAtMostOneActiveInstall(activeRows.rows, "回滚");
    const replacedSnapshotId = replaced
      ? await captureInstallSnapshotOn(client, workspaceId, replaced, {
        note: "回滚替换前自动快照，支持恢复到回滚前状态",
        reason: "rollback-replacement",
      })
      : null;
    if (replaced) await deactivateInstallOn(client, workspaceId, replaced);

    // 逆操作恢复（幂等：行还在则恢复状态，行没了则标记需重新装配）
    if (previous) {
      for (const row of previous.agents) await client.query(`UPDATE agents SET status=$3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, row.id, row.status]);
      for (const row of previous.fences) await client.query(`UPDATE fence_rules SET status=$3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, row.id, row.status]);
      for (const row of previous.kbCollections) await client.query(`UPDATE kb_collections SET status=$3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, row.id, row.status]);
      for (const row of previous.kbDocuments) await client.query(`UPDATE kb_documents SET status=$3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, row.id, row.status]);
      if (previous.staffingDraft) {
        await client.query(
          `UPDATE wizard_staffing_drafts SET status=$3 WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, previous.staffingDraft.id, previous.staffingDraft.status],
        );
      }
    } else {
      if (a.preset_ids?.length) await client.query(`UPDATE agents SET status='ready' WHERE workspace_id=$2 AND id = ANY($1)`, [a.preset_ids, workspaceId]);
      if (a.fence_rule_ids?.length) await client.query(`UPDATE fence_rules SET status='active' WHERE workspace_id=$2 AND id = ANY($1)`, [a.fence_rule_ids, workspaceId]);
    }
    if (a.skill_ids?.length) {
      if (previous) {
        for (const row of previous.skillInstalls) {
          await client.query(
            `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (skill_id, workspace_id) DO UPDATE
             SET installed_by=EXCLUDED.installed_by,
                 fence_bindings_snapshot=EXCLUDED.fence_bindings_snapshot,
                 installed_version=EXCLUDED.installed_version`,
            [row.skill_id, workspaceId, row.installed_by, JSON.stringify(row.fence_bindings_snapshot), row.installed_version],
          );
        }
      } else {
        for (const sid of a.skill_ids) {
          await client.query(
            `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
             SELECT s.id, $2, $3, s.fence_bindings, s.version FROM skills s WHERE s.id=$1
             ON CONFLICT (skill_id, workspace_id) DO NOTHING`, [sid, workspaceId, actor.id]);
        }
      }
    }
    await client.query(
      `UPDATE bundle_installs SET status='active', uninstalled_at=NULL WHERE workspace_id=$2 AND id=$1`, [install.id, workspaceId]);
    const workspace = snap.rows[0].payload.workspace;
    await client.query(
      `UPDATE workspaces SET bundle_id=$2, is_example=$3, industry=COALESCE($4,industry) WHERE id=$1`,
      [workspaceId, workspace?.bundleId ?? install.bundle_id, workspace?.isExample ?? (install.bundle_id !== "custom"), workspace?.industry ?? null],
    );
    if (workspace) {
      if (workspace.profileCustomization === null) {
        await client.query(`UPDATE profiles SET archive=archive-'customization', updated_at=now() WHERE workspace_id=$1`, [workspaceId]);
      } else {
        await client.query(
          `UPDATE profiles SET archive=jsonb_set(archive,'{customization}',$2::jsonb,true), updated_at=now() WHERE workspace_id=$1`,
          [workspaceId, JSON.stringify(workspace.profileCustomization)],
        );
      }
    }
    await client.query(`UPDATE bundle_snapshots SET restored_at=now() WHERE workspace_id=$2 AND id=$1`, [snapshotId, workspaceId]);

    await appendEventOn(client, sc, actor, {
      objectType: "bundle", objectId: install.bundle_id,
      action: "bundle.rollback",
      after: { snapshot_id: snapshotId, replaced_install_id: replaced?.id ?? null, replaced_snapshot_id: replacedSnapshotId },
    });
    return { restored: true, replacedSnapshotId };
  });
}

/* ---------------- L3 编制生成（草案先行，人审才装配） ---------------- */
export interface StaffingDraft {
  team: Array<{
    preset_key: string;
    role_title: string;
    kind: string;
    description: string;
    readonly: boolean;
    night_shift: boolean;
    fence_bindings: string[];
    skills: string[];
  }>;
  fences: Array<{
    rule_id: string;
    name: string;
    level: "auto" | "review" | "block";
    match: { object_types: string[]; actions: string[] };
    when: string;
    match_desc: string;
  }>;
  skills_suggested: string[];
}

type HumanActor = { id: string; type: "human" | "agent" };

interface CandidateAgent {
  id: string;
  preset_key: string;
  name: string;
  version: string;
  kind: string;
  readonly: boolean;
  fence_bindings: string[];
  skills: string[];
  meta: Record<string, unknown>;
}

interface CandidateFence {
  id: string;
  rule_id: string;
  version: string;
  name: string;
  level: "auto" | "review" | "block";
  match_spec: { object_types: string[]; actions: string[]; when: string };
  action: { result: "pass" | "review" | "blocked"; note: string };
  is_baseline: boolean;
}

interface CandidateAssets {
  preset_ids: string[];
  fence_rule_ids: string[];
  skill_ids: string[];
  candidate: { agents: CandidateAgent[]; fences: CandidateFence[] };
}

interface DraftRow extends Record<string, unknown> {
  id: string;
  industry_text: string;
  compiled: StaffingDraft;
  status: string;
  generation_mode: string;
  draft_hash: string | null;
  assembly_version: number | null;
  assembly_hash: string | null;
  last_error: string | null;
  created_at: string;
}

interface InstallRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  bundle_id: string;
  assets: CandidateAssets;
  status: string;
  draft_id: string | null;
  assembly_version: number | null;
  assembly_hash: string | null;
  qualified_exam_id: string | null;
  installed_at: string;
}

class StaffingDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffingDraftValidationError";
  }
}

function text(value: unknown, label: string, min = 1, max = 300): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new StaffingDraftValidationError(`${label}长度应为 ${min}-${max} 个字符。`);
  }
  return value.trim();
}

function stringList(value: unknown, label: string, max = 30): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new StaffingDraftValidationError(`${label}应为不超过 ${max} 项的有效内容。`);
  }
  return value.map((v) => (v as string).trim());
}

function stateLabel(value: string | null | undefined): string {
  return ({
    draft: "草案", confirmed: "已确认", assembled: "待考试", exam_failed: "考试未通过",
    staged: "待考试", active: "已激活", uninstalled: "已卸载", retired: "已退役",
    running: "进行中", done: "已完成", failed: "执行失败", pass: "通过", warn: "预警", fail: "未通过",
  } as Record<string, string>)[value ?? ""] ?? "未知";
}

/** 输出契约校验（L3 产出必须过校验才入预览——非法结构拒收）。 */
export function validateStaffing(draft: unknown): StaffingDraft {
  if (!draft || typeof draft !== "object") throw new StaffingDraftValidationError("团队编制草案格式不正确。");
  const raw = draft as Record<string, unknown>;
  if (!Array.isArray(raw.team) || raw.team.length === 0 || raw.team.length > 20) {
    throw new StaffingDraftValidationError("团队编制应包含 1-20 个岗位。");
  }
  if (!Array.isArray(raw.fences) || raw.fences.length === 0 || raw.fences.length > 40) {
    throw new StaffingDraftValidationError("团队编制应包含 1-40 条可执行围栏。");
  }

  const fenceIds = new Set<string>();
  const fences = raw.fences.map((item, index) => {
    if (!item || typeof item !== "object") throw new StaffingDraftValidationError(`第 ${index + 1} 条围栏格式不正确。`);
    const f = item as Record<string, unknown>;
    const ruleId = text(f.rule_id, `第 ${index + 1} 条围栏的规则标识`, 2, 40);
    if (!/^[A-Z][A-Z0-9_-]{1,39}$/.test(ruleId)) throw new StaffingDraftValidationError(`第 ${index + 1} 条围栏的规则标识格式不正确。`);
    if (fenceIds.has(ruleId)) throw new StaffingDraftValidationError("围栏规则标识重复。");
    fenceIds.add(ruleId);
    if (f.level !== "auto" && f.level !== "review" && f.level !== "block") {
      throw new StaffingDraftValidationError(`第 ${index + 1} 条围栏的处理方式不正确。`);
    }
    const level: "auto" | "review" | "block" = f.level;
    const match = f.match as Record<string, unknown> | undefined;
    const objectTypes = stringList(match?.object_types, `第 ${index + 1} 条围栏的业务对象`, 20);
    const actions = stringList(match?.actions, `第 ${index + 1} 条围栏的业务动作`, 30);
    if (objectTypes.length === 0 || actions.length === 0) throw new StaffingDraftValidationError(`第 ${index + 1} 条围栏缺少业务对象或动作。`);
    return {
      rule_id: ruleId,
      name: text(f.name, `第 ${index + 1} 条围栏的名称`, 1, 100),
      level,
      match: { object_types: objectTypes, actions },
      when: typeof f.when === "string" ? f.when.trim() : "",
      match_desc: text(f.match_desc, `第 ${index + 1} 条围栏的触发说明`, 1, 300),
    };
  });

  const presetKeys = new Set<string>();
  const team = raw.team.map((item, index) => {
    if (!item || typeof item !== "object") throw new StaffingDraftValidationError(`第 ${index + 1} 个岗位配置格式不正确。`);
    const m = item as Record<string, unknown>;
    const presetKey = text(m.preset_key, `第 ${index + 1} 个岗位的内部标识`, 2, 41);
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(presetKey)) throw new StaffingDraftValidationError(`第 ${index + 1} 个岗位的标识格式不正确。`);
    if (presetKeys.has(presetKey)) throw new StaffingDraftValidationError("岗位标识重复。");
    presetKeys.add(presetKey);
    if (typeof m.readonly !== "boolean" || typeof m.night_shift !== "boolean") {
      throw new StaffingDraftValidationError(`第 ${index + 1} 个岗位缺少必需的只读或夜班设置。`);
    }
    const bindings = stringList(m.fence_bindings, `第 ${index + 1} 个岗位的围栏关联`, 20);
    const unknown = bindings.filter((id) => !fenceIds.has(id));
    if (unknown.length) throw new StaffingDraftValidationError(`第 ${index + 1} 个岗位引用了不存在的围栏。`);
    if (!m.readonly) {
      const protectedByReview = fences.some((f) => bindings.includes(f.rule_id) && (f.level === "review" || f.level === "block"));
      if (!protectedByReview) throw new StaffingDraftValidationError(`第 ${index + 1} 个可写岗位未绑定人审或阻断级围栏。`);
    }
    return {
      preset_key: presetKey,
      role_title: text(m.role_title, `第 ${index + 1} 个岗位的名称`, 2, 80),
      kind: text(m.kind, `第 ${index + 1} 个岗位的类型`, 2, 40),
      description: text(m.description, `第 ${index + 1} 个岗位的职责说明`, 2, 300),
      readonly: m.readonly,
      night_shift: m.night_shift,
      fence_bindings: bindings,
      skills: stringList(m.skills, `第 ${index + 1} 个岗位的技能建议`, 20),
    };
  });

  return {
    team,
    fences,
    skills_suggested: stringList(raw.skills_suggested, "团队技能建议", 50),
  };
}

/** 大模型失败时只生成可讲解的模拟骨架，服务端装配门禁会拒绝该来源。 */
function fallbackStaffing(industry: string, note: string): StaffingDraft {
  return validateStaffing({
    team: [
      { preset_key: "ops-coordinator", role_title: "经营参谋官", kind: "coordinator", description: `统筹团队与晨报汇总（行业：${industry.slice(0, 30)}）`, readonly: false, night_shift: false, fence_bindings: ["R1"], skills: ["metric-digest"] },
      { preset_key: "data-analyst", role_title: "数据洞察官", kind: "analyst", description: "指标日报与异动检测", readonly: true, night_shift: true, fence_bindings: [], skills: ["metric-digest"] },
      { preset_key: "service-responder", role_title: "客户响应官", kind: "service", description: "客户咨询应答与工单流转", readonly: false, night_shift: false, fence_bindings: ["R2"], skills: ["review-miner"] },
    ],
    fences: [
      { rule_id: "R1", name: "重大事项上报必审", level: "review", match: { object_types: ["workspace"], actions: ["workspace.change"] }, when: "", match_desc: "对外发布或重大变更" },
      { rule_id: "R2", name: "外发回复必审", level: "review", match: { object_types: ["customer_message"], actions: ["message.send"] }, when: "", match_desc: "对客户的任何外发回复" },
    ],
    skills_suggested: ["metric-digest", "review-miner", `骨架原因：${note.slice(0, 120)}`],
  });
}

export async function generateStaffing(
  workspaceId: string,
  industryText: string,
  actor: HumanActor,
): Promise<{ draftId: string; draftHash: string; draft: StaffingDraft; mock: boolean }> {
  const llm = llmCall("wizard-staffing");
  let draft: StaffingDraft;
  let mock = false;
  if (llm) {
    try {
      const raw = await llm(
        `你是团队编制专家。客户行业描述：「${industryText}」。请生成一支 5-8 人的数字员工团队编制草案，严格只输出 JSON：
{"team":[{"preset_key":"kebab-case英文","role_title":"岗位名","kind":"英文类型","description":"一句话职责","readonly":false,"night_shift":true,"fence_bindings":["R1"],"skills":["非必需技能建议，不代表已安装"]}],"fences":[{"rule_id":"R1","name":"规则名","level":"review","match":{"object_types":["业务对象英文名"],"actions":["object.action"]},"when":"","match_desc":"中文触发条件"}],"skills_suggested":["非必需技能建议，不代表已安装"]}
纪律：所有数组必须给出；skills 与 skills_suggested 仅能列建议，系统不会自动安装；写入岗 readonly=false 且必须绑定 review/block 规则；只读岗 readonly=true；围栏对象与动作必须可执行，不得只写自然语言。`);
      const jsonMatch = /\{[\s\S]*\}/.exec(raw);
      draft = validateStaffing(JSON.parse(jsonMatch?.[0] ?? "{}"));
    } catch (error) {
      mock = true;
      const reason = error instanceof StaffingDraftValidationError
        ? error.message
        : error instanceof SyntaxError
          ? "模型返回内容格式不正确"
          : "模型生成暂时不可用";
      draft = fallbackStaffing(industryText, reason);
    }
  } else {
    mock = true;
    draft = fallbackStaffing(industryText, "未配置真实模型");
  }

  const draftId = newId("wsd");
  const draftHash = staffingDraftHash(industryText, draft);
  await serviceTx(workspaceId, async (client, scope) => {
    await client.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    // 现有装配继续服务；回炉只精确移除从未激活的隔离候选资产。
    const staged = await client.query<InstallRow>(
      `SELECT * FROM bundle_installs WHERE workspace_id=$1 AND status='staged' FOR UPDATE`, [workspaceId],
    );
    for (const row of staged.rows) {
      const presetIds = row.assets?.preset_ids ?? [];
      const fenceIds = row.assets?.fence_rule_ids ?? [];
      if (presetIds.length) await client.query(`DELETE FROM agents WHERE workspace_id=$1 AND status='disabled' AND id=ANY($2)`, [workspaceId, presetIds]);
      if (fenceIds.length) await client.query(`DELETE FROM fence_rules WHERE workspace_id=$1 AND status='draft' AND id=ANY($2)`, [workspaceId, fenceIds]);
      await client.query(`UPDATE bundle_installs SET status='uninstalled', uninstalled_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, row.id]);
    }
    await client.query(
      `UPDATE wizard_staffing_drafts SET status='retired'
       WHERE workspace_id=$1 AND status IN ('draft','confirmed','assembled','exam_failed')`,
      [workspaceId],
    );
    await client.query(
      `INSERT INTO wizard_staffing_drafts
         (id, workspace_id, industry_text, compiled, status, generation_mode, draft_hash)
       VALUES ($1,$2,$3,$4,'draft',$5,$6)`,
      [draftId, workspaceId, industryText, JSON.stringify(draft), mock ? "mock" : "real", draftHash],
    );
    await appendEventOn(client, scope, actor, {
      objectType: "staffing_draft",
      objectId: draftId,
      action: "wizard.staffing.generated",
      after: { draft_hash: draftHash, generation_mode: mock ? "mock" : "real", team_size: draft.team.length },
    });
  });
  return { draftId, draftHash, draft, mock };
}

function makeCandidateAssets(draftId: string, version: number, draft: StaffingDraft): CandidateAssets {
  const versionLabel = `custom-v${version}`;
  const short = draftId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase();
  const agents: CandidateAgent[] = draft.team.map((member, index) => ({
    id: `agt-custom-${short}-${index + 1}`,
    preset_key: `custom-${short}-${member.preset_key}`,
    name: member.role_title,
    version: versionLabel,
    kind: member.kind,
    readonly: member.readonly,
    fence_bindings: member.fence_bindings,
    // 技能建议尚未经过技能市场安装/围栏快照，不能冒充已安装技能。
    skills: [],
    meta: {
      source_preset_key: member.preset_key,
      description: member.description,
      night_shift: member.night_shift,
      suggested_skills: member.skills,
      capability_declarations: member.skills.map((name) => ({
        kind: "skill",
        name,
        status: "pending_approval",
      })),
      capability_mode: member.skills.length > 0 ? "base_only_until_approved" : "base_only",
      tools: [],
      prompt: { role: member.role_title, responsibility: member.description },
    },
  }));
  const fences: CandidateFence[] = draft.fences.map((fence, index) => ({
    id: `fr-custom-${short}-${index + 1}`,
    rule_id: fence.rule_id,
    version: versionLabel,
    name: fence.name,
    level: fence.level,
    match_spec: { ...fence.match, when: fence.when },
    action: {
      result: fence.level === "auto" ? "pass" : fence.level === "review" ? "review" : "blocked",
      note: fence.match_desc,
    },
    is_baseline: false,
  }));
  return {
    preset_ids: agents.map((agent) => agent.id),
    fence_rule_ids: fences.map((fence) => fence.id),
    skill_ids: [],
    candidate: { agents, fences },
  };
}

function bindingOf(row: InstallRow): ExamBinding {
  if (!row.draft_id || row.assembly_version === null || !row.assembly_hash) {
    throw new Error("候选装配缺少草案、版本或哈希，已拒绝继续");
  }
  return { installId: row.id, draftId: row.draft_id, version: row.assembly_version, hash: row.assembly_hash };
}

function candidateExamTargets(assets: CandidateAssets): CandidateExamTarget[] {
  const fences = new Map(assets.candidate.fences.map((fence) => [fence.rule_id, fence]));
  return assets.candidate.agents.map((agent) => {
    const suggested = Array.isArray(agent.meta.suggested_skills)
      ? agent.meta.suggested_skills.filter((value): value is string => typeof value === "string")
      : [];
    const tools = Array.isArray(agent.meta.tools)
      ? agent.meta.tools.filter((value): value is string => typeof value === "string")
      : [];
    return {
      agentId: agent.id,
      presetKey: agent.preset_key,
      roleTitle: agent.name,
      responsibility: typeof agent.meta.description === "string" ? agent.meta.description : agent.name,
      readonly: agent.readonly,
      fences: agent.fence_bindings.map((ruleId) => {
        const fence = fences.get(ruleId);
        if (!fence) throw new Error(`候选员工 ${agent.name} 引用的围栏 ${ruleId} 不在装配清单中`);
        return {
          ruleId,
          name: fence.name,
          level: fence.level,
          objectTypes: fence.match_spec.object_types,
          actions: fence.match_spec.actions,
          when: fence.match_spec.when,
        };
      }),
      declaredSkills: suggested,
      installedSkills: agent.skills,
      installedTools: tools,
    };
  });
}

export interface CandidateExamView {
  agentId: string;
  roleTitle: string;
  totalScore: number;
  passed: boolean;
  redLineHit: boolean;
  failureReasons: string[];
  pendingCapabilities: string[];
}

function candidateView(result: CandidateRoleResult): CandidateExamView {
  return {
    agentId: result.agentId,
    roleTitle: result.roleTitle,
    totalScore: result.totalScore,
    passed: result.passed,
    redLineHit: result.redLineHit,
    failureReasons: result.failureReasons,
    pendingCapabilities: result.pendingCapabilities,
  };
}

async function assertMaterializedAssembly(
  client: pg.PoolClient,
  workspaceId: string,
  install: InstallRow,
  expectedState: "staged" | "active",
): Promise<void> {
  const binding = bindingOf(install);
  const expectedHash = staffingAssemblyHash({
    workspaceId,
    draftId: binding.draftId,
    draftHash: (await client.query<{ draft_hash: string }>(
      `SELECT draft_hash FROM wizard_staffing_drafts WHERE workspace_id=$1 AND id=$2`, [workspaceId, binding.draftId],
    )).rows[0]?.draft_hash ?? "",
    version: binding.version,
    assets: install.assets,
  });
  if (expectedHash !== binding.hash) throw new Error("候选装配清单哈希不一致，可能已被修改，已拒绝激活");

  const expectedAgents = [...(install.assets?.candidate?.agents ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const expectedFences = [...(install.assets?.candidate?.fences ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  if (expectedAgents.length === 0 || expectedFences.length === 0) throw new Error("候选装配缺少员工或围栏资产");

  const agentRows = await client.query<Record<string, unknown>>(
    `SELECT id, preset_key, name, version, kind, readonly, fence_bindings, skills, meta
     FROM agents WHERE workspace_id=$1 AND id=ANY($2) AND status=$3 ORDER BY id`,
    [workspaceId, install.assets.preset_ids, expectedState === "staged" ? "disabled" : "ready"],
  );
  const fenceRows = await client.query<Record<string, unknown>>(
    `SELECT id, rule_id, version, name, level, match_spec, action, is_baseline
     FROM fence_rules WHERE workspace_id=$1 AND id=ANY($2) AND status=$3 ORDER BY id`,
    [workspaceId, install.assets.fence_rule_ids, expectedState === "staged" ? "draft" : "active"],
  );
  if (sha256Canonical(agentRows.rows) !== sha256Canonical(expectedAgents)) throw new Error("候选数字员工与装配清单不一致，已拒绝激活");
  if (sha256Canonical(fenceRows.rows) !== sha256Canonical(expectedFences)) throw new Error("候选围栏与装配清单不一致，已拒绝激活");
}

/** 人审确认后，在单一事务内形成不可运行的候选装配。重复确认同一草案幂等返回。 */
export async function confirmAndAssembleStaffing(
  workspaceId: string,
  input: { draftId: string; expectedDraftHash: string },
  actor: HumanActor,
): Promise<{ installId: string; assemblyVersion: number; assemblyHash: string; status: "staged" }> {
  return serviceTx(workspaceId, async (client, scope) => {
    await client.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const result = await client.query<DraftRow>(
      `SELECT * FROM wizard_staffing_drafts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, input.draftId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("编制草案不存在或不属于当前工作区");

    const existing = await client.query<InstallRow>(
      `SELECT * FROM bundle_installs WHERE workspace_id=$1 AND draft_id=$2 FOR UPDATE`, [workspaceId, row.id],
    );
    if (existing.rows[0]) {
      const binding = bindingOf(existing.rows[0]);
      if (binding.hash !== row.assembly_hash || row.draft_hash !== input.expectedDraftHash) {
        throw new Error("重复确认的版本或哈希与已装配记录不一致");
      }
      if (existing.rows[0].status !== "staged") throw new Error(`该草案装配已处于“${stateLabel(existing.rows[0].status)}”状态`);
      return { installId: binding.installId, assemblyVersion: binding.version, assemblyHash: binding.hash, status: "staged" as const };
    }

    if (row.status !== "draft") throw new Error(`草案状态为“${stateLabel(row.status)}”，不能确认装配`);
    if (row.generation_mode !== "real") throw new Error("当前是模拟骨架预览，不能装配上岗；请先接入真实模型并重新生成");
    const draft = validateStaffing(row.compiled);
    const actualDraftHash = staffingDraftHash(row.industry_text, draft);
    if (!row.draft_hash || row.draft_hash !== actualDraftHash || input.expectedDraftHash !== actualDraftHash) {
      throw new Error("草案内容或哈希已变化，请重新生成并再次确认");
    }
    const conflicting = await client.query(
      `SELECT id, status FROM bundle_installs WHERE workspace_id=$1 AND status='staged' LIMIT 1 FOR UPDATE`,
      [workspaceId],
    );
    if (conflicting.rows[0]) throw new Error("当前已有待考装配，请先完成现有流程或重新生成草案");

    const versionRows = await client.query<{ max_version: number }>(
      `SELECT COALESCE(max(assembly_version),0)::int AS max_version FROM bundle_installs WHERE workspace_id=$1`,
      [workspaceId],
    );
    const assemblyVersion = (versionRows.rows[0]?.max_version ?? 0) + 1;
    const installId = newId("bi-custom");
    const assets = makeCandidateAssets(row.id, assemblyVersion, draft);
    const assemblyHash = staffingAssemblyHash({
      workspaceId,
      draftId: row.id,
      draftHash: actualDraftHash,
      version: assemblyVersion,
      assets,
    });

    for (const agent of assets.candidate.agents) {
      await client.query(
        `INSERT INTO agents
           (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'disabled',$10)`,
        [agent.id, workspaceId, agent.preset_key, agent.name, agent.version, agent.kind, agent.readonly,
         JSON.stringify(agent.fence_bindings), JSON.stringify(agent.skills), JSON.stringify(agent.meta)],
      );
    }
    for (const fence of assets.candidate.fences) {
      await client.query(
        `INSERT INTO fence_rules
           (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`,
        [fence.id, fence.rule_id, fence.version, workspaceId, fence.name, fence.level,
         JSON.stringify(fence.match_spec), JSON.stringify(fence.action), fence.is_baseline, actor.id],
      );
    }
    await client.query(
      `INSERT INTO bundle_installs
         (id, workspace_id, bundle_id, assets, status, draft_id, assembly_version, assembly_hash)
       VALUES ($1,$2,'custom',$3,'staged',$4,$5,$6)`,
      [installId, workspaceId, JSON.stringify(assets), row.id, assemblyVersion, assemblyHash],
    );
    await client.query(
      `UPDATE wizard_staffing_drafts
       SET status='assembled', confirmed_at=now(), confirmed_by=$3,
           assembly_version=$4, assembly_hash=$5, assembled_at=now(), last_error=NULL
       WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, row.id, actor.id, assemblyVersion, assemblyHash],
    );
    await appendEventOn(client, scope, actor, {
      objectType: "bundle_install",
      objectId: installId,
      action: "wizard.staffing.assembled",
      after: { draft_id: row.id, draft_hash: actualDraftHash, assembly_version: assemblyVersion, assembly_hash: assemblyHash, status: "staged" },
    });
    return { installId, assemblyVersion, assemblyHash, status: "staged" as const };
  });
}

export interface CustomizationStatus {
  phase: "preview" | "staffing" | "exam" | "done";
  snapshotId: string | null;
  currentInstall: null | { id: string; bundleId: string; installedAt: string };
  industryText: string;
  draft: null | {
    id: string;
    hash: string | null;
    generationMode: string;
    status: string;
    compiled: StaffingDraft | null;
    lastError: string | null;
  };
  assembly: null | { installId: string; version: number; hash: string; status: string };
  exam: null | {
    id: string;
    totalScore: number | null;
    verdict: string | null;
    status: string;
    candidates: CandidateExamView[];
  };
}

/** 页面刷新后的唯一恢复事实源。 */
export async function customizationStatus(workspaceId: string): Promise<CustomizationStatus> {
  return serviceTx(workspaceId, async (client) => {
    const draftRows = await client.query<DraftRow>(
      `SELECT * FROM wizard_staffing_drafts WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`, [workspaceId],
    );
    const draft = draftRows.rows[0] ?? null;
    const installRows = draft ? await client.query<InstallRow>(
      `SELECT * FROM bundle_installs WHERE workspace_id=$1 AND draft_id=$2 ORDER BY installed_at DESC LIMIT 1`,
      [workspaceId, draft.id],
    ) : null;
    const install = installRows?.rows[0] ?? null;
    const examRows = install ? await client.query<{ id: string; total_score: string | null; verdict: string | null; status: string }>(
      `SELECT id, total_score, verdict, status FROM eval_exams
       WHERE workspace_id=$1 AND target_install_id=$2 ORDER BY started_at DESC LIMIT 1`,
      [workspaceId, install.id],
    ) : null;
    const exam = examRows?.rows[0] ?? null;
    const candidateRows = exam ? await client.query<{
      agent_id: string; role_title: string; dimension_scores: { accuracy?: number; recall?: number; latency?: number; satisfaction?: number };
      passed: boolean; red_line_hit: boolean; failure_reasons: string[];
      declared_skills: string[]; installed_skills: string[]; installed_tools: string[];
    }>(
      `SELECT agent_id, role_title, dimension_scores, passed, red_line_hit, failure_reasons,
              declared_skills, installed_skills, installed_tools
       FROM eval_candidate_results WHERE workspace_id=$1 AND exam_id=$2 ORDER BY created_at, agent_id`,
      [workspaceId, exam.id],
    ) : null;
    const snapshotRows = await client.query<{ id: string }>(
      `SELECT id FROM bundle_snapshots WHERE workspace_id=$1 AND restored_at IS NULL AND expires_at>now()
         AND payload->>'reason'='atomic-switch'
       ORDER BY created_at DESC LIMIT 1`, [workspaceId],
    );
    const activeRows = await client.query<{ id: string; bundle_id: string; installed_at: string }>(
      `SELECT id, bundle_id, installed_at FROM bundle_installs
       WHERE workspace_id=$1 AND status='active' ORDER BY installed_at DESC LIMIT 1`, [workspaceId],
    );
    const draftAvailable = Boolean(
      draft && draft.status !== "retired"
      && (draft.status === "draft" || install?.status === "staged" || install?.status === "active"),
    );
    let compiledDraft: StaffingDraft | null = null;
    let draftValidationError: string | null = null;
    if (draft && draftAvailable) {
      try {
        compiledDraft = validateStaffing(draft.compiled);
      } catch (error) {
        draftValidationError = `旧草案不符合当前装配契约，请重新生成：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    let phase: CustomizationStatus["phase"] = "preview";
    if (draft?.status === "active" && install?.status === "active") phase = "done";
    else if (install?.status === "staged" && ["assembled", "exam_failed"].includes(draft?.status ?? "")) phase = "exam";
    else if (draftAvailable) phase = "staffing";

    return {
      phase,
      snapshotId: snapshotRows.rows[0]?.id ?? null,
      currentInstall: activeRows.rows[0] ? {
        id: activeRows.rows[0].id,
        bundleId: activeRows.rows[0].bundle_id,
        installedAt: activeRows.rows[0].installed_at,
      } : null,
      industryText: draft?.industry_text ?? "",
      draft: draft && draftAvailable ? {
        id: draft.id,
        hash: draft.draft_hash,
        generationMode: draft.generation_mode,
        status: draft.status,
        compiled: compiledDraft,
        lastError: draft.last_error ?? draftValidationError,
      } : null,
      assembly: install && install.assembly_version !== null && install.assembly_hash ? {
        installId: install.id,
        version: install.assembly_version,
        hash: install.assembly_hash,
        status: install.status,
      } : null,
      exam: exam ? {
        id: exam.id,
        totalScore: exam.total_score === null ? null : Number(exam.total_score),
        verdict: exam.verdict,
        status: exam.status,
        candidates: (candidateRows?.rows ?? []).map((row) => {
          const dims = row.dimension_scores ?? {};
          const totalScore = Math.round((
            Number(dims.accuracy ?? 0) * 0.4
            + Number(dims.recall ?? 0) * 0.25
            + Number(dims.satisfaction ?? 0) * 0.25
            + Number(dims.latency ?? 0) * 0.1
          ) * 10) / 10;
          const pendingCapabilities = (row.declared_skills ?? [])
            .filter((name) => !(row.installed_skills ?? []).includes(name))
            .map((name) => `技能：${name}`);
          return {
            agentId: row.agent_id,
            roleTitle: row.role_title,
            totalScore,
            passed: row.passed,
            redLineHit: row.red_line_hit,
            failureReasons: row.failure_reasons ?? [],
            pendingCapabilities,
          };
        }),
      } : null,
    };
  });
}

/* ---------------- 上岗考（版本/哈希门禁：通过后才原子激活） ---------------- */
export async function onboardingExam(
  workspaceId: string,
  input: { installId: string; expectedAssemblyHash: string },
  actor: HumanActor,
): Promise<{
  examId: string;
  totalScore: number | null;
  verdict: string | null;
  passed: boolean;
  activated: boolean;
  installStatus: string;
  candidates: CandidateExamView[];
  snapshotId: string | null;
  previousBundleId: string | null;
}> {
  const binding = await serviceTx(workspaceId, async (client) => {
    const rows = await client.query<InstallRow>(
      `SELECT * FROM bundle_installs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, input.installId],
    );
    const install = rows.rows[0];
    if (!install || install.bundle_id !== "custom") throw new Error("待考的定制装配不存在");
    const current = bindingOf(install);
    if (current.hash !== input.expectedAssemblyHash) throw new Error("页面中的装配哈希已过期，请刷新后重试");
    if (install.status === "active" && install.qualified_exam_id) {
      return { current, targets: candidateExamTargets(install.assets), alreadyActiveExamId: install.qualified_exam_id };
    }
    if (install.status !== "staged") throw new Error(`装配状态为“${stateLabel(install.status)}”，不能开考`);
    await client.query(
      `UPDATE eval_exams
       SET status='failed', error='逐岗位上岗考超过 10 分钟未完成，已允许重试', finished_at=now()
       WHERE workspace_id=$1 AND target_install_id=$2 AND trigger_source='wizard'
         AND status='running' AND started_at <= now() - interval '10 minutes'`,
      [workspaceId, install.id],
    );
    const running = await client.query<{ id: string }>(
      `SELECT id FROM eval_exams
       WHERE workspace_id=$1 AND target_install_id=$2 AND trigger_source='wizard' AND status='running'
       LIMIT 1 FOR UPDATE`,
      [workspaceId, install.id],
    );
    if (running.rows[0]) throw new Error("逐岗位上岗考正在进行，请等待完成；超过 10 分钟后可安全重试");
    await assertMaterializedAssembly(client, workspaceId, install, "staged");
    return { current, targets: candidateExamTargets(install.assets), alreadyActiveExamId: null };
  });

  if (binding.alreadyActiveExamId) {
    const rows = await svcQuery<{
      id: string; total_score: string | null; verdict: string | null; status: string; assessment_kind: string;
    }>(
      workspaceId,
      `SELECT id, total_score, verdict, status, assessment_kind
       FROM eval_exams WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, binding.alreadyActiveExamId],
    );
    const exam = rows[0];
    if (!exam) throw new Error("已激活装配的资格考试记录缺失");
    if (exam.status !== "done" || exam.verdict !== "pass" || exam.assessment_kind !== "candidate-role") {
      throw new Error("已激活装配的资格考试不是已通过的逐岗位上岗考");
    }
    const resultRows = await svcQuery<{
      agent_id: string; role_title: string; dimension_scores: { accuracy?: number; recall?: number; latency?: number; satisfaction?: number };
      passed: boolean; red_line_hit: boolean; failure_reasons: string[];
      declared_skills: string[]; installed_skills: string[];
    }>(
      workspaceId,
      `SELECT agent_id, role_title, dimension_scores, passed, red_line_hit, failure_reasons,
              declared_skills, installed_skills
       FROM eval_candidate_results
       WHERE workspace_id=$1 AND exam_id=$2 AND install_id=$3 AND draft_id=$4
         AND assembly_version=$5 AND assembly_hash=$6
       ORDER BY created_at, agent_id`,
      [workspaceId, exam.id, binding.current.installId, binding.current.draftId, binding.current.version, binding.current.hash],
    );
    const candidates = resultRows.map((row) => {
      const dims = row.dimension_scores ?? {};
      return {
        agentId: row.agent_id,
        roleTitle: row.role_title,
        totalScore: Math.round((Number(dims.accuracy ?? 0) * 0.4 + Number(dims.recall ?? 0) * 0.25
          + Number(dims.satisfaction ?? 0) * 0.25 + Number(dims.latency ?? 0) * 0.1) * 10) / 10,
        passed: row.passed,
        redLineHit: row.red_line_hit,
        failureReasons: row.failure_reasons ?? [],
        pendingCapabilities: (row.declared_skills ?? [])
          .filter((name) => !(row.installed_skills ?? []).includes(name))
          .map((name) => `技能：${name}`),
      };
    });
    const candidateIdsMatch = JSON.stringify(candidates.map((candidate) => candidate.agentId).sort())
      === JSON.stringify(binding.targets.map((target) => target.agentId).sort());
    if (!candidateIdsMatch || candidates.some((candidate) => !candidate.passed)) {
      throw new Error("已激活装配的逐岗位考试证据不完整或包含未通过岗位");
    }
    return {
      examId: exam.id,
      totalScore: exam.total_score === null ? null : Number(exam.total_score),
      verdict: exam.verdict,
      passed: true,
      activated: true,
      installStatus: "active",
      candidates,
      snapshotId: null,
      previousBundleId: null,
    };
  }

  let exam: Awaited<ReturnType<typeof runCandidateOnboardingExam>>["exam"];
  let candidateResults: CandidateExamView[] = [];
  try {
    const result = await runCandidateOnboardingExam(workspaceId, binding.current, binding.targets);
    exam = result.exam;
    candidateResults = result.candidates.map(candidateView);
  } catch (error) {
    const message = `上岗考执行失败：${error instanceof Error ? error.message : String(error)}`;
    await svcQuery(
      workspaceId,
      `UPDATE wizard_staffing_drafts SET last_error=$2 WHERE workspace_id=$1 AND id=$3`,
      [workspaceId, message, binding.current.draftId],
    ).catch(() => undefined);
    throw new Error(message);
  }

  return serviceTx(workspaceId, async (client, scope) => {
    await client.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const installRows = await client.query<InstallRow>(
      `SELECT * FROM bundle_installs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, binding.current.installId],
    );
    const install = installRows.rows[0];
    if (!install) throw new Error("考试结束后找不到候选装配，未执行激活");
    const current = bindingOf(install);
    if (!sameExamBinding(current, binding.current) || current.hash !== input.expectedAssemblyHash) {
      throw new Error("考试期间候选装配版本或哈希发生变化，未执行激活");
    }
    const examRows = await client.query<{
      id: string; status: string; verdict: string | null; total_score: string | null; assessment_kind: string;
      target_install_id: string; target_draft_id: string; target_version: number; target_hash: string;
    }>(
      `SELECT id, status, verdict, total_score, assessment_kind,
              target_install_id, target_draft_id, target_version, target_hash
       FROM eval_exams WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, exam.id],
    );
    const storedExam = examRows.rows[0];
    if (!storedExam) throw new Error("考试记录缺失，未执行激活");
    const examBinding: ExamBinding = {
      installId: storedExam.target_install_id,
      draftId: storedExam.target_draft_id,
      version: storedExam.target_version,
      hash: storedExam.target_hash,
    };
    if (!sameExamBinding(current, examBinding)) throw new Error("考试记录绑定的版本或哈希与当前装配不一致，未执行激活");
    await assertMaterializedAssembly(client, workspaceId, install, "staged");

    const candidateIdsMatch = JSON.stringify(candidateResults.map((candidate) => candidate.agentId).sort())
      === JSON.stringify([...install.assets.preset_ids].sort());
    const allCandidatesPassed = candidateIdsMatch
      && candidateResults.length > 0
      && candidateResults.every((candidate) => candidate.passed);
    const passed = storedExam.status === "done"
      && storedExam.verdict === "pass"
      && storedExam.assessment_kind === "candidate-role"
      && allCandidatesPassed;
    if (!passed) {
      const failure = allCandidatesPassed
        ? `上岗考未通过（结论：${stateLabel(storedExam.verdict ?? storedExam.status)}），候选团队保持停用`
        : `逐岗位考试未全部通过（${candidateResults.filter((candidate) => candidate.passed).length}/${install.assets.preset_ids.length}），候选团队保持停用`;
      await client.query(
        `UPDATE wizard_staffing_drafts SET status='exam_failed', last_error=$3
         WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, current.draftId, failure],
      );
      await appendEventOn(client, scope, actor, {
        objectType: "bundle_install", objectId: current.installId, action: "wizard.exam.failed",
        after: {
          exam_id: storedExam.id,
          assembly_version: current.version,
          assembly_hash: current.hash,
          verdict: storedExam.verdict,
          candidate_passed: candidateResults.filter((candidate) => candidate.passed).length,
          candidate_total: install.assets.preset_ids.length,
        },
      });
      return {
        examId: storedExam.id,
        totalScore: storedExam.total_score === null ? null : Number(storedExam.total_score),
        verdict: storedExam.verdict,
        passed: false,
        activated: false,
        installStatus: "staged",
        candidates: candidateResults,
        snapshotId: null,
        previousBundleId: null,
      };
    }

    // 最终门禁通过后才触碰现有装配：快照、停用旧装配、启用候选与工作区指针同一事务提交。
    const activeRows = await client.query<BundleInstall & Record<string, unknown>>(
      `SELECT * FROM bundle_installs
       WHERE workspace_id=$1 AND status='active' AND id<>$2
       ORDER BY installed_at DESC FOR UPDATE`, [workspaceId, current.installId],
    );
    const previousInstall = requireAtMostOneActiveInstall(activeRows.rows, "切换");
    const snapshotId = previousInstall
      ? await captureInstallSnapshotOn(client, workspaceId, previousInstall, {
        note: "行业定制原子切换前快照，30 天内可回滚",
        reason: "atomic-switch",
      })
      : null;
    if (previousInstall) await deactivateInstallOn(client, workspaceId, previousInstall);

    await client.query(`UPDATE agents SET status='ready' WHERE workspace_id=$1 AND id=ANY($2) AND status='disabled'`, [workspaceId, install.assets.preset_ids]);
    await client.query(`UPDATE fence_rules SET status='active' WHERE workspace_id=$1 AND id=ANY($2) AND status='draft'`, [workspaceId, install.assets.fence_rule_ids]);
    await client.query(
      `UPDATE bundle_installs SET status='active', qualified_exam_id=$3, activated_at=now()
       WHERE workspace_id=$1 AND id=$2`, [workspaceId, current.installId, storedExam.id],
    );
    await client.query(
      `UPDATE wizard_staffing_drafts SET status='active', activated_at=now(), last_error=NULL
       WHERE workspace_id=$1 AND id=$2`, [workspaceId, current.draftId],
    );
    await client.query(`UPDATE workspaces SET bundle_id='custom', is_example=false WHERE id=$1`, [workspaceId]);
    await client.query(
      `UPDATE profiles SET archive=jsonb_set(archive, '{customization}', $2::jsonb, true), updated_at=now()
       WHERE workspace_id=$1`,
      [workspaceId, JSON.stringify({
        draftId: current.draftId,
        installId: current.installId,
        assemblyVersion: current.version,
        assemblyHash: current.hash,
        examId: storedExam.id,
        assessmentKind: "candidate-role",
        candidatePassed: candidateResults.length,
        pendingCapabilities: candidateResults.flatMap((candidate) => candidate.pendingCapabilities),
        previousBundleId: previousInstall?.bundle_id ?? null,
        rollbackSnapshotId: snapshotId,
        activatedAt: new Date().toISOString(),
      })],
    );
    await appendEventOn(client, scope, actor, {
      objectType: "bundle_install", objectId: current.installId, action: "wizard.staffing.activated",
      after: {
        draft_id: current.draftId,
        exam_id: storedExam.id,
        assembly_version: current.version,
        assembly_hash: current.hash,
        status: "active",
        candidate_passed: candidateResults.length,
        candidate_total: install.assets.preset_ids.length,
        pending_capabilities: candidateResults.flatMap((candidate) => candidate.pendingCapabilities),
        previous_bundle_id: previousInstall?.bundle_id ?? null,
        rollback_snapshot_id: snapshotId,
      },
    });
    return {
      examId: storedExam.id,
      totalScore: storedExam.total_score === null ? null : Number(storedExam.total_score),
      verdict: storedExam.verdict,
      passed: true,
      activated: true,
      installStatus: "active",
      candidates: candidateResults,
      snapshotId,
      previousBundleId: previousInstall?.bundle_id ?? null,
    };
  });
}
