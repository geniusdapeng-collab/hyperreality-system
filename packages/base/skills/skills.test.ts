/**
 * B10 技能/意识测试：白名单/冲突检测/资产闸门/SKILL.md 渲染/聚类/阈值校准（纯函数）+
 * PG 集成：安装绑定（F8.2）/ 幂等 / 卸载撤销（L8.3）/ 未脱敏拦截（L8.1）/ 冲突进审批（E8.1）
 *        / dry-run 前置（F8.3）/ 意识建议→确认固化→驳回校准（F8.4/E8.3）
 */
import { describe, expect, it } from "vitest";
import { detectFenceConflicts, isAssetReusable, isSignedSource, type SkillRow } from "./registry.js";
import { renderSkillMarkdown, teamSkillId } from "./forge.js";
import { actionCategory, calibratedThreshold, clusterEvents } from "./awareness.js";
import type { BusinessEvent } from "@workloom/shared";

const skillRow = (over: Partial<SkillRow>): SkillRow => ({
  id: "skill-x", level: "official", bundle: "hotel", name: "x", version: "1.0.0",
  description: "", fence_bindings: [], body: "", desensitized: false, ...over,
});

describe("签名白名单（L8.2）与资产闸门（L8.4/L8.1）", () => {
  it("official 放行；team 须 skill-t- 命名空间；industry 首版不放行", () => {
    expect(isSignedSource(skillRow({ level: "official" }), null as never)).toBe(true);
    expect(isSignedSource(skillRow({ level: "team", id: "skill-t-abc" }), null as never)).toBe(true);
    expect(isSignedSource(skillRow({ level: "team", id: "skill-foreign" }), null as never)).toBe(false);
    expect(isSignedSource(skillRow({ level: "industry", desensitized: true }), null as never)).toBe(false);
  });

  it("未 verified 资产任何入口不可批量复用；industry 层未脱敏不可复用", () => {
    expect(isAssetReusable({ share_scope: "workspace", desensitized: false, payload: {} })).toBe(false);
    expect(isAssetReusable({ share_scope: "workspace", desensitized: false, payload: { verified: true } })).toBe(true);
    expect(isAssetReusable({ share_scope: "industry", desensitized: false, payload: { verified: true } })).toBe(false);
    expect(isAssetReusable({ share_scope: "industry", desensitized: true, payload: { verified: true } })).toBe(true);
  });
});

describe("围栏冲突检测（E8.1，纯函数）", () => {
  it("绑定缺失即冲突", () => {
    expect(detectFenceConflicts(["R1", "R9"], new Set(["R1", "R2"]))).toEqual({ missing: ["R9"] });
    expect(detectFenceConflicts(["R1"], new Set(["R1"]))).toEqual({ missing: [] });
  });
});

describe("SKILL.md 渲染与 ID（F8.3/F8.1）", () => {
  it("三要素渲染：触发/步骤/边界齐全 + frontmatter", () => {
    const md = renderSkillMarkdown("收益管理", "调价方法论", { trigger: "每日 07:00", steps: ["取竞对价", "算建议价"], boundary: "不破保底价" });
    expect(md).toContain("name: 收益管理");
    expect(md).toContain("## 触发（何时用）\n每日 07:00");
    expect(md).toContain("1. 取竞对价\n2. 算建议价");
    expect(md).toContain("## 边界（什么不做）\n不破保底价");
  });
  it("team 技能 ID 落 skill-t- 命名空间（白名单标识）", () => {
    expect(teamSkillId("差评跟进 SOP", "ws-yunqi")).toBe("skill-t-ws-yunqi-差评跟进-sop");
    expect(teamSkillId("  ", "ws-yunqi")).toBe("skill-t-ws-yunqi-unnamed");
  });
});

describe("意识系统聚类与校准（F8.4/E8.3，纯函数）", () => {
  const ev = (id: string, action: string, objType = "price"): BusinessEvent => ({
    event_id: id,
    who: { type: "agent", id: "pricing-agent" },
    context: { tenant_id: "t", workspace_id: "w", time: "2026-08-16T10:00:00+08:00" },
    object: { type: objType },
    decision: { action },
    rule_impact: [],
  });

  it("动作类别取前两段；系统动作不入观察", () => {
    expect(actionCategory("price.adjust")).toBe("price.adjust");
    expect(actionCategory("inspect.anomaly")).toBeNull();
    expect(actionCategory("skill.installed")).toBeNull();
    expect(actionCategory("bare")).toBeNull();
  });

  it("聚类按 对象类型×动作类别，样本 ≤5 条", () => {
    const events = [
      ev("E-1", "price.adjust"), ev("E-2", "price.adjust"), ev("E-3", "price.adjust"),
      ev("E-4", "price.adjust"), ev("E-5", "price.adjust"), ev("E-6", "price.adjust"),
      ev("E-7", "review.reply", "review"),
      ev("E-8", "inspect.anomaly", "channel"), // 系统动作不入
    ];
    const clusters = clusterEvents(events);
    expect(clusters.get("price::price.adjust")).toMatchObject({ count: 6 });
    expect(clusters.get("price::price.adjust")!.ids).toHaveLength(5);
    expect(clusters.get("review::review.reply")).toMatchObject({ count: 1 });
    expect(clusters.has("channel::inspect.anomaly")).toBe(false);
  });

  it("驳回校准：被驳回 key 阈值 ×2", () => {
    expect(calibratedThreshold(3, new Set(["a::b"]), "a::b")).toBe(6);
    expect(calibratedThreshold(3, new Set(["a::b"]), "c::d")).toBe(3);
  });
});

/* ---------- PG 集成 ---------- */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("技能/意识 PG 集成（M8 铁律）", async () => {
  const pg = await import("pg");
  const {
    installSkill, uninstallSkill, listInstalls, listSkills, resolveAgentFenceBindings, SkillError,
    createSkillDraft, dryRunSkill, detectSuggestions, confirmSuggestion, rejectSuggestion,
  } = await import("./index.js");
  const { gatewayAppend } = await import("../workdata/gateway.js");
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  /** app 池断言查询辅助：事务内设 RLS 上下文（与生产口径一致；池直查在 RLS 下恒 0 行） */
  const qApp = async <T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const r = await c.query<T>(sql, params);
      await c.query("COMMIT");
      return r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };

  const RUN = Date.now().toString(36); // 唯一后缀：同一数据库可重跑

  const appendTaskEvent = async (action: string, objType: string) => {
    await gatewayAppend(gw, { ...scope, actor: { id: "pricing-agent", type: "agent", fenceBindings: ["R1"] } }, {
      who: { type: "agent", id: "pricing-agent", version: "v2.0" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: objType },
      decision: { action },
      rule_impact: [],
    } as never);
  };

  it("F8.2/L8.3 安装即绑定→并集生效；卸载即撤销；重复安装幂等", async () => {
    const skills = await listSkills(app, scope, { level: "official" });
    const revenue = skills.find((s) => s.name === "revenue-manager");
    expect(revenue).toBeTruthy();

    // seed 已预装官方技能套件 → 先卸载清理，保证从「未安装」态开始断言
    await uninstallSkill(app, gw, scope, { skillId: revenue!.id, by: "MEM-001" }).catch(() => undefined);

    const i1 = await installSkill(app, gw, scope, { skillId: revenue!.id, by: "MEM-001" });
    expect(i1).toMatchObject({ installed: true, deduped: false, bindings: ["R1", "R2"] });

    const agent = await qApp<{ id: string }>(`SELECT id FROM agents WHERE workspace_id=$1 AND preset_key='pricing-agent'`, [scope.workspaceId]);
    const bindings = await resolveAgentFenceBindings(app, scope, agent.rows[0]!.id);
    expect(bindings).toContain("R1");
    expect(bindings).toContain("R2");

    const i2 = await installSkill(app, gw, scope, { skillId: revenue!.id, by: "MEM-001" });
    expect(i2.deduped).toBe(true); // 重复安装不报错不重复留痕

    const u = await uninstallSkill(app, gw, scope, { skillId: revenue!.id, by: "MEM-001" });
    expect(u.revokedBindings).toEqual(["R1", "R2"]); // L8.3 卸载即撤销
    const installs = await listInstalls(app, scope);
    expect(installs.find((x) => x.skill_id === revenue!.id)).toBeUndefined();
    const bindingsAfter = await resolveAgentFenceBindings(app, scope, agent.rows[0]!.id);
    // preset 自身声明仍在，技能绑定已收缩
    expect(bindingsAfter.length).toBeLessThanOrEqual(bindings.length);
  });

  it("seed 与运行时双路径安装快照同构：快照=实时绑定、版本对齐、并集一致（#17 口径回归）", async () => {
    // seed 直写路径（scripts/seed.ts）与运行时 installSkill 路径都必须落
    // fence_bindings_snapshot=安装时刻 skills.fence_bindings、installed_version=skills.version——
    // 任一路径漏写都会让运行时并集（resolveAgentFenceBindings）与卸载撤销清单（#40）口径分裂
    const rows = await qApp<{
      skill_id: string; snap: string[]; ver: string; live: string[]; live_ver: string;
    }>(
      `SELECT i.skill_id, i.fence_bindings_snapshot AS snap, i.installed_version AS ver,
              s.fence_bindings AS live, s.version AS live_ver
       FROM skill_installs i JOIN skills s ON s.id = i.skill_id
       WHERE i.workspace_id=$1
         AND NOT EXISTS (SELECT 1 FROM skill_revocations r WHERE r.skill_id = i.skill_id)`,
      [scope.workspaceId],
    );
    expect(rows.rows.length).toBeGreaterThan(0); // seed 已预装官方套件
    for (const r of rows.rows) {
      expect(r.snap, `${r.skill_id} 快照须等于 skills.fence_bindings（双路径同构）`).toEqual(r.live);
      expect(r.ver, `${r.skill_id} installed_version 须对齐 skills.version`).toBe(r.live_ver);
    }

    // 围栏并集：运行时消费点（resolveAgentFenceBindings）= preset 声明 ∪ 全部在装技能快照
    const agent = await qApp<{ id: string; fence_bindings: string[] }>(
      `SELECT id, fence_bindings FROM agents WHERE workspace_id=$1 AND preset_key='pricing-agent'`,
      [scope.workspaceId],
    );
    const union = await resolveAgentFenceBindings(app, scope, agent.rows[0]!.id);
    const expected = new Set<string>([
      ...(agent.rows[0]!.fence_bindings ?? []),
      ...rows.rows.flatMap((r) => r.snap ?? []),
    ]);
    expect(new Set(union)).toEqual(expected);
  });

  it("L8.1 未脱敏 industry 技能拦截；E8.1 绑定冲突进审批不静默放行", async () => {
    await qApp(
      `INSERT INTO skills (id, level, name, version, description, fence_bindings, body, desensitized)
       VALUES ('skill-ind-raw','industry','raw-asset','1.0.0','', '[]', '', false)
       ON CONFLICT (id) DO NOTHING`,
    );
    await expect(installSkill(app, gw, scope, { skillId: "skill-ind-raw", by: "MEM-001" }))
      .rejects.toMatchObject({ code: "NOT_DESENSITIZED" });

    await qApp(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ('skill-conflict','official','hotel','conflict-skill','1.0.0','', '["R1","R9"]', '', false)
       ON CONFLICT (id) DO UPDATE SET fence_bindings='["R1","R9"]'`,
    );
    await expect(installSkill(app, gw, scope, { skillId: "skill-conflict", by: "MEM-001" }))
      .rejects.toMatchObject({ code: "FENCE_CONFLICT" });
    const ap = await qApp(
      `SELECT status, snapshot->>'kind' AS kind FROM approvals WHERE workspace_id=$1 AND snapshot->>'skillId'='skill-conflict'`,
      [scope.workspaceId],
    );
    expect(ap.rows[0]).toMatchObject({ status: "pending", kind: "skill_fence_conflict" }); // 冲突项进审批
  });

  it("F8.3 三要素草稿 → 未 dry-run 拒装 → dry-run 预览 → 安装放行", async () => {
    const draft = await createSkillDraft(app, gw, scope, {
      name: `差评跟进打法-${RUN}`, description: "差评回复方法论",
      triplet: { trigger: "出现 ≤3 分差评", steps: ["归因", "起草回复", "挂审批"], boundary: "不承诺档案外补偿" },
      fenceBindings: ["R6"], by: "MEM-002",
    });
    expect(draft.skillId).toBe(`skill-t-ws-yunqi-差评跟进打法-${RUN}`.toLowerCase());
    expect(draft.version).toMatch(/^\d+\.\d+\.0$/); // 同名再生成版本递增（重跑安全）

    await expect(installSkill(app, gw, scope, { skillId: draft.skillId, by: "MEM-002" }))
      .rejects.toMatchObject({ code: "NEED_DRY_RUN" }); // 生效前必须 dry-run 预览

    const report = await dryRunSkill(app, gw, scope, { skillId: draft.skillId, by: "MEM-002" });
    expect(report.skillId).toBe(draft.skillId);
    expect(report.perRule[0]).toMatchObject({ ruleId: "R6" });

    const ok = await installSkill(app, gw, scope, { skillId: draft.skillId, by: "MEM-002" });
    expect(ok.installed).toBe(true);
    await uninstallSkill(app, gw, scope, { skillId: draft.skillId, by: "MEM-002" }); // 清理
  });

  it("#23 跨工作区隔离：同名技能不互覆盖 / 列表隔离 / 他区技能安装拦截", async () => {
    const scopeB = { tenantId: scope.tenantId, workspaceId: `ws-other-${RUN}` };
    const name = `同名跟进 SOP-${RUN}`;
    // 两工作区各建同名技能 → ID 不同、skills 表两行、互不影响
    const a = await createSkillDraft(app, gw, scope, {
      name, description: "A 区方法论", triplet: { trigger: "t", steps: ["s"], boundary: "b" }, fenceBindings: [], by: "MEM-001",
    });
    const b = await createSkillDraft(app, gw, scopeB, {
      name, description: "B 区方法论", triplet: { trigger: "t", steps: ["s"], boundary: "b" }, fenceBindings: [], by: "MEM-001",
    });
    expect(a.skillId).not.toBe(b.skillId);
    expect(a.skillId).toContain(scope.workspaceId);
    expect(b.skillId).toContain(scopeB.workspaceId);
    const both = await qApp<{ id: string; description: string }>(`SELECT id, description FROM skills WHERE name=$1`, [name]);
    expect(both.rows.length).toBe(2);
    expect(new Set(both.rows.map((r) => r.description)).size).toBe(2); // 无互相覆盖
    // 列表隔离：各自只看见本工作区 team 技能
    const listA = await listSkills(app, scope, { level: "team" });
    expect(listA.some((s) => s.id === a.skillId)).toBe(true);
    expect(listA.some((s) => s.id === b.skillId)).toBe(false);
    // 他区技能安装拦截（NOT_SIGNED 留痕）
    await expect(installSkill(app, gw, scope, { skillId: b.skillId, by: "MEM-001" }))
      .rejects.toMatchObject({ code: "NOT_SIGNED" });
    // 清理（直接删行：演示技能无 RLS，避免污染后续用例的版本递增断言）
    await qApp(`DELETE FROM skills WHERE id = ANY($1)`, [[a.skillId, b.skillId]]);
  });

  it("F8.4 高频检测建议 → 一键确认生成触发器 → 不再重复建议；E8.3 驳回后阈值 ×2", async () => {
    // 造 3 条同类任务事件（达到 ≥3 次/周阈值）
    for (let i = 0; i < 3; i++) await appendTaskEvent(`competitor.scan${RUN}`, "channel");
    const suggestions = await detectSuggestions(app, scope);
    const hit = suggestions.find((s) => s.key === `channel::competitor.scan${RUN}`);
    expect(hit).toBeTruthy();
    expect(hit!.count).toBeGreaterThanOrEqual(3);

    const confirmed = await confirmSuggestion(app, gw, scope, { suggestion: hit!, target: "trigger", by: "MEM-001", schedule: "0 6 * * *" });
    expect(confirmed.artifactId).toMatch(/^trg-auto-/);
    const trg = await qApp(`SELECT kind, schedule, enabled FROM triggers WHERE id=$1`, [confirmed.artifactId]);
    expect(trg.rows[0]).toMatchObject({ kind: "cron", schedule: "0 6 * * *", enabled: true });

    // 已确认 → 不再重复建议（幂等）
    const again = await detectSuggestions(app, scope);
    expect(again.find((s) => s.key === `channel::competitor.scan${RUN}`)).toBeUndefined();

    // E8.3：驳回另一类 → 该类阈值 ×2（3→6），3 次不再出建议
    for (let i = 0; i < 3; i++) await appendTaskEvent(`content.draft${RUN}`, "content");
    await rejectSuggestion(gw, scope, { key: `content::content.draft${RUN}`, by: "MEM-001", reason: "频次误判" });
    const afterReject = await detectSuggestions(app, scope);
    expect(afterReject.find((s) => s.key === `content::content.draft${RUN}`)).toBeUndefined();
    // 补足到 6 次后应再次出现（校准不是永久屏蔽）
    for (let i = 0; i < 3; i++) await appendTaskEvent(`content.draft${RUN}`, "content");
    const six = await detectSuggestions(app, scope);
    expect(six.find((s) => s.key === `content::content.draft${RUN}`)?.threshold).toBe(6);
  });
});
