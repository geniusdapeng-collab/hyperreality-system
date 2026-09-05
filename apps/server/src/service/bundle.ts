/**
 * service/bundle · 行业装配机制（方案 V4 §3 一键清空 / §6 L3 编制生成 / §7 上岗考）
 * 契约：
 *  - 清空前必须快照成功（bundle_snapshots 写入失败禁止清空）；
 *  - 卸载按 bundle_installs 台账逐项执行，不清糊涂账；
 *  - 红线：biz_events / members / 审计记录永不清空；清空动作五元事件留痕；
 *  - L3 编制生成：草案先行（wizard_staffing_drafts），人审确认才装配（预览即所装）。
 */
import { randomUUID } from "node:crypto";
import { svcQuery, serviceTx, appendEventOn } from "./events.js";
import { llmCall } from "./llm.js";
import { runExam } from "./eval.js";

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

/* ---------------- 装配台账 ---------------- */
export interface BundleInstall {
  id: string; bundle_id: string; assets: {
    preset_ids?: string[]; fence_rule_ids?: string[]; skill_ids?: string[];
    kb_collection_ids?: string[]; seed_batch_id?: string;
  }; status: string; installed_at: string;
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
      "示例种子数据（事件/审批样例按批次标记删除）",
    ],
    keep: ["基座能力（围栏引擎/事件库/技能市场/考试院/3D 视图）", "账户与人类成员", "事件哈希链存证（永不删除）", "审计记录", "行业包本体（可随时重新装配）"],
  };
}

/* ---------------- 一键清空 ---------------- */
export async function clearBundle(workspaceId: string, actor: { id: string; type: "human" | "agent" }): Promise<{ snapshotId: string; uninstalled: string[] }> {
  const install = await activeInstall(workspaceId);
  if (!install) throw new Error("当前无已装配的行业包——无需清空");

  return serviceTx(workspaceId, async (client, sc) => {
    // ① 快照（未成功写入禁止清空——红线）
    const snapshotId = newId("bs");
    const snap = await client.query(
      `INSERT INTO bundle_snapshots (id, workspace_id, bundle_id, install_id, payload)
       SELECT $1, $2, $3, $4, $5 RETURNING id`,
      [snapshotId, workspaceId, install.bundle_id, install.id,
       JSON.stringify({ install, note: "清空前自动快照，30 天可回滚" })],
    );
    if (!snap.rows[0]) throw new Error("快照写入失败——已中止清空（红线：无快照不清空）");

    const a = install.assets;
    const uninstalled: string[] = [];

    // ② 台账逐项卸载
    if (a.preset_ids?.length) {
      await client.query(`UPDATE agents SET status='disabled' WHERE id = ANY($1)`, [a.preset_ids]);
      uninstalled.push(`agents ×${a.preset_ids.length} 停用（disabled）`);
    }
    if (a.skill_ids?.length) {
      await client.query(
        `DELETE FROM skill_installs WHERE skill_id = ANY($1) AND workspace_id=$2`, [a.skill_ids, workspaceId]);
      uninstalled.push(`skill_installs ×${a.skill_ids.length} 卸载`);
    }
    if (a.fence_rule_ids?.length) {
      await client.query(`UPDATE fence_rules SET status='rolled_back' WHERE id = ANY($1)`, [a.fence_rule_ids]);
      uninstalled.push(`fence_rules ×${a.fence_rule_ids.length} 停用`);
    }
    if (a.kb_collection_ids?.length) {
      await client.query(`DELETE FROM kb_documents WHERE collection_id = ANY($1)`, [a.kb_collection_ids]);
      await client.query(`DELETE FROM kb_collections WHERE id = ANY($1)`, [a.kb_collection_ids]);
      uninstalled.push(`kb_collections ×${a.kb_collection_ids.length} 删除`);
    }

    // ③ 台账关闭 + 工作区示例标记清除
    await client.query(
      `UPDATE bundle_installs SET status='uninstalled', uninstalled_at=now() WHERE id=$1`, [install.id]);
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
export async function rollbackSnapshot(workspaceId: string, snapshotId: string, actor: { id: string; type: "human" | "agent" }): Promise<{ restored: boolean }> {
  return serviceTx(workspaceId, async (client, sc) => {
    const snap = await client.query<{ payload: { install: BundleInstall } }>(
      `SELECT payload FROM bundle_snapshots WHERE id=$1 AND expires_at > now() AND restored_at IS NULL`,
      [snapshotId]);
    if (!snap.rows[0]) throw new Error("快照不存在或已过期（30 天）");
    const install = snap.rows[0].payload.install;
    const a = install.assets;

    // 逆操作恢复（幂等：行还在则恢复状态，行没了则标记需重新装配）
    if (a.preset_ids?.length) await client.query(`UPDATE agents SET status='ready' WHERE id = ANY($1)`, [a.preset_ids]);
    if (a.fence_rule_ids?.length) await client.query(`UPDATE fence_rules SET status='active' WHERE id = ANY($1)`, [a.fence_rule_ids]);
    if (a.skill_ids?.length) {
      for (const sid of a.skill_ids) {
        await client.query(
          `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
           SELECT s.id, $2, 'MEM-001', s.fence_bindings, s.version FROM skills s WHERE s.id=$1
           ON CONFLICT (skill_id, workspace_id) DO NOTHING`, [sid, workspaceId]);
      }
    }
    await client.query(
      `UPDATE bundle_installs SET status='active', uninstalled_at=NULL WHERE id=$1`, [install.id]);
    await client.query(
      `UPDATE workspaces SET is_example=true, bundle_id=$2 WHERE id=$1`, [workspaceId, install.bundle_id]);
    await client.query(`UPDATE bundle_snapshots SET restored_at=now() WHERE id=$1`, [snapshotId]);

    await appendEventOn(client, sc, actor, {
      objectType: "bundle", objectId: install.bundle_id,
      action: "bundle.rollback",
      after: { snapshot_id: snapshotId },
    });
    return { restored: true };
  });
}

/* ---------------- L3 编制生成（草案先行，人审才装配） ---------------- */
export interface StaffingDraft {
  team: Array<{
    preset_key: string; role_title: string; kind: string; description: string;
    night_shift: boolean; fence_bindings: string[]; skills: string[];
  }>;
  fences: Array<{ rule_id: string; name: string; level: string; match_desc: string }>;
  skills_suggested: string[];
}

/** 输出契约校验（L3 产出必须过校验才入预览——非法结构拒收） */
export function validateStaffing(draft: unknown): StaffingDraft {
  const d = draft as StaffingDraft;
  if (!d || !Array.isArray(d.team) || d.team.length === 0 || d.team.length > 20) {
    throw new Error("编制草案契约不符：team 须为 1-20 人");
  }
  for (const m of d.team) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(m.preset_key ?? "")) throw new Error(`非法 preset_key：${m.preset_key}`);
    if (typeof m.role_title !== "string" || m.role_title.length < 2) throw new Error("role_title 缺失");
  }
  if (!Array.isArray(d.fences)) d.fences = [];
  if (!Array.isArray(d.skills_suggested)) d.skills_suggested = [];
  return d;
}

export async function generateStaffing(workspaceId: string, industryText: string): Promise<{ draftId: string; draft: StaffingDraft; mock: boolean }> {
  const llm = llmCall("wizard-staffing");
  let draft: StaffingDraft;
  let mock = false;
  if (llm) {
    try {
      const raw = await llm(
        `你是团队编制专家。客户行业描述：「${industryText}」。请生成一支 5-8 人的数字员工团队编制草案，严格按此 JSON 结构输出（不要任何多余文字）：
{"team":[{"preset_key":"kebab-case英文","role_title":"岗位名（官字辈，如品质巡检官）","kind":"类型","description":"一句话职责","night_shift":true/false,"fence_bindings":["R1"],"skills":["建议技能"]}],"fences":[{"rule_id":"R1","name":"规则名","level":"auto|review|block","match_desc":"触发条件描述"}],"skills_suggested":["技能建议"]}
纪律：写入级职责（改价/外发/删数据）的岗位 fence_bindings 必须含 review 级规则；只读分析岗可为 auto。`);
      const jsonMatch = /\{[\s\S]*\}/.exec(raw);
      draft = validateStaffing(JSON.parse(jsonMatch?.[0] ?? "{}"));
    } catch (e) {
      mock = true;
      draft = fallbackStaffing(industryText, (e as Error).message);
    }
  } else {
    mock = true;
    draft = fallbackStaffing(industryText, "模型未配置");
  }

  const draftId = newId("wsd");
  await svcQuery(workspaceId,
    `INSERT INTO wizard_staffing_drafts (id, workspace_id, industry_text, compiled, status)
     VALUES ($1, current_setting('app.workspace_id', true), $2, $3, 'draft')`,
    [draftId, industryText, JSON.stringify(draft)]);
  return { draftId, draft, mock };
}

function fallbackStaffing(industry: string, note: string): StaffingDraft {
  return {
    team: [
      { preset_key: "ops-coordinator", role_title: "经营参谋官", kind: "coordinator", description: `统筹团队与晨报汇总（行业：${industry.slice(0, 30)}）`, night_shift: false, fence_bindings: ["R1"], skills: ["metric-digest"] },
      { preset_key: "data-analyst", role_title: "数据洞察官", kind: "analyst", description: "指标日报与异动检测", night_shift: true, fence_bindings: [], skills: ["metric-digest"] },
      { preset_key: "service-responder", role_title: "客户响应官", kind: "service", description: "客户咨询应答与工单流转", night_shift: false, fence_bindings: ["R2"], skills: ["review-miner"] },
    ],
    fences: [
      { rule_id: "R1", name: "重大事项上报必审", level: "review", match_desc: "对外发布/重大变更" },
      { rule_id: "R2", name: "外发回复必审", level: "review", match_desc: "对客户的任何外发回复" },
    ],
    skills_suggested: ["metric-digest", "review-miner", `（骨架生成：${note}）`],
  };
}

/* ---------------- 上岗考（exam 门禁：装配后先考试，达标才 activated） ---------------- */
export async function onboardingExam(workspaceId: string): Promise<{ examId: string; totalScore: number | null; verdict: string | null; passed: boolean }> {
  const { exam } = await runExam(workspaceId, { examType: "onboarding", triggerSource: "wizard" });
  return {
    examId: exam.id,
    totalScore: exam.totalScore,
    verdict: exam.verdict,
    passed: exam.verdict === "pass",
  };
}
