// fence-engine/hardening.test.ts —— HP-02 围栏引擎加固回归（审计批次 HP-20260916）
//
// 本文件锁定审计确认的缺陷（修复前必红）：
//  ① 写类动作分类不完整：行业工具名（pms.price.write / kb.write …）既不在写前缀白名单，
//     也无人注册 → 网关段①/段③按「只读」放行；
//  ② 未知动作 fail-open：未命中规则 + 未被判定为写 → judge 直接 auto（绕过 default_level）；
//  ③ 规则动作词表与工具名不一致：规则写 price.adjust，运行时 step.action=工具名 → 规则永不命中；
//  ④ DSL 装载器只认 rules，而出厂 ai-pm/platform 包用 fences → loadFencePack 直接抛错；
//  ⑤ 单调守卫形同虚设：无生产接线，且不检查 when/match 改写（when:"false" 即可废掉基线规则）；
//  ⑥ 规则版本不可追溯：提案一律 v-next，激活不递增、不失效旧版。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCandidateAgainstBaseline, checkMonotonic, loadFencePack } from "./dsl.js";
import { judge, type RuntimeRule } from "./judge.js";
import {
  checkPermission, checkHighRiskAuthorization, classifyAction, isReadAction, isWriteAction,
  registerReadActions, registerWriteActions,
} from "../workdata/gateway.js";
import type { EventDraft } from "../workdata/events.js";
import { activateRuleVersion, confirmDryRun, createDryRun, loadActiveRulesInTx } from "./lifecycle.js";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

const BUNDLES = join(dirname(fileURLToPath(import.meta.url)), "../../../bundles");
const hotelPackPath = join(BUNDLES, "hotel/fences/hotel-baseline.yml");
const aipmPackPath = join(BUNDLES, "ai-pm/fences/ai-pm-baseline.yml");
const platformPackPath = join(BUNDLES, "platform/fences/platform-baseline.yml");

/**
 * 本测试文件随基座分发到所有子仓，而 `bundles/**` 属行业资产（不在 base-sync 范围内）：
 * 依赖具体行业包的断言一律按存在性守卫/跳过，避免子仓出现"文件不存在"的假红灯。
 */
const hotelPack = existsSync(hotelPackPath) ? loadFencePack(readFileSync(hotelPackPath, "utf-8")) : null;
const hasHotelPack = hotelPack !== null;
/** 已被 describe.skipIf(!hasHotelPack) 守卫的用例使用；缺包时取空值，断言不会被执行。 */
const hotelPackRules: RuntimeRule[] = hotelPack?.rules ?? [];
const hotelPackDefaultLevel = hotelPack?.defaultLevel ?? "review";

function draft(action: string, who: { type: "human" | "agent" | "system"; id: string }): EventDraft {
  return {
    who,
    context: { tenant_id: "t", workspace_id: "ws" } as never,
    object: { type: "room_price", id: "RT-1" },
    decision: { action },
    rule_impact: [],
  };
}

describe("HP-02 ① 写类动作分类（行业工具名必须被识别为写）", () => {
  it("声明过 access=write 的行业工具名不再按只读放行", () => {
    // 修复前：pms.price.write 不在硬编码前缀里 → 被当作只读放行（网关段①/段③漏判）。
    // 修复后：装配期按 Bundle 声明登记为显式写；判定器对未分类动作按写兜底（default_level）。
    expect(isWriteAction("pms.price.write")).toBe(false);
    expect(classifyAction("pms.price.write")).toBe("unknown");
    registerWriteActions(["pms.price.write", "ota.price.write"]);
    expect(isWriteAction("pms.price.write")).toBe(true);
    expect(classifyAction("pms.price.write")).toBe("write");
    // 只读动词启发式（list/read/get/…）只覆盖读方向；未分类的非只读动词仍按未知（→写）
    expect(classifyAction("pms.price.read")).toBe("read");
    expect(classifyAction("pms.price.write")).toBe("write");
    expect(classifyAction("pms.price.reconcile")).toBe("unknown");
  });

  it("网关段①：未声明 fence_bindings 的 Agent 执行行业写动作被拒（F2.10）", () => {
    expect(() => checkPermission(
      { id: "pricing-agent", type: "agent", fenceBindings: [] },
      draft("pms.price.write", { type: "agent", id: "pricing-agent" }),
    )).toThrowError(/fence_bindings|禁写/);
  });

  it("网关段③：高危 Agent 执行行业写动作必须带真实审批引用（L3.5）", async () => {
    const noopDb = { query: async () => ({ rows: [] }) } as never;
    await expect(checkHighRiskAuthorization(
      noopDb,
      { tenantId: "t", workspaceId: "ws" },
      { id: "desktop-agent", type: "agent", highRisk: true },
      draft("ota.price.write", { type: "agent", id: "desktop-agent" }),
      undefined,
    )).rejects.toThrowError(/逐次授权|缺少/);
  });

  it("显式登记的只读动作仍按只读处理（不误伤巡检/采集）", () => {
    registerReadActions(["pms.price.read", "competitor.fetch"]);
    expect(isReadAction("pms.price.read")).toBe(true);
    expect(classifyAction("pms.price.read")).toBe("read");
    expect(isWriteAction("pms.price.read")).toBe(false);
  });
});

describe("HP-02 ② 未知动作与规则匹配 fail-closed", () => {
  it("未命中规则的未知写动作按 default_level 处理（不再 auto）", () => {
    const v = judge(
      { object: { type: "unknown_obj" }, action: "mystery.write", params: {} },
      [],
      "review",
    );
    expect(v.level).toBe("review");
  });

  it("未命中规则的只读动作恒 auto", () => {
    registerReadActions(["metrics.read"]);
    const v = judge({ object: { type: "metrics" }, action: "metrics.read" }, [], "review");
    expect(v.level).toBe("auto");
  });

  it.skipIf(!hasHotelPack)("规则动作词表按语义段匹配工具名（price.adjust ↔ pms.price.write）", () => {
    const v = judge(
      {
        object: { type: "room_price" }, action: "pms.price.write",
        params: {}, after: { price: 300 },
      },
      hotelPackRules,
      hotelPackDefaultLevel,
    );
    expect(v.level).toBe("block"); // R2 保底价 ¥380
    expect(v.impacts.some((i) => i.rule_id === "R2")).toBe(true);
  });

  it("求值异常仍按 block（E2.1 不变）", () => {
    const rules: RuntimeRule[] = [{
      rule_id: "R-BAD", version: "v1", name: "坏表达式", level: "auto", is_baseline: false,
      objectTypes: ["room_price"], actions: ["price.adjust"], when: "params.missing.deep > 1",
    }];
    const v = judge({ object: { type: "room_price" }, action: "price.adjust" }, rules, "auto");
    expect(v.level).toBe("block");
    expect(v.evalErrors.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasHotelPack)("HP-02 ④ DSL 装载器与出厂包一致", () => {
  it("ai-pm / platform 的 fences: 形态可装载且规则数正确", () => {
    // 本文件随基座分发到所有子仓，而 bundles/** 属行业资产（platform 包仅存在于仙女座/基座）：
    // 按包存在性守卫，缺包即跳过该包断言，避免子仓出现"文件不存在"的假红灯。
    if (existsSync(aipmPackPath)) {
      const aipm = loadFencePack(readFileSync(aipmPackPath, "utf-8"));
      expect(aipm.rules.length).toBe(14);
      expect(aipm.defaultLevel).toBe("review");
    }
    if (existsSync(platformPackPath)) {
      const platform = loadFencePack(readFileSync(platformPackPath, "utf-8"));
      expect(platform.rules.length).toBe(10);
    }
    if (!existsSync(hotelPackPath) && !existsSync(aipmPackPath) && !existsSync(platformPackPath)) {
      expect(true).toBe(true); // 该仓未随附任何示例围栏包：本用例无对象可校验（已在上面按包跳过）
    }
  });

  it("重复 rule_id 装载即拒（防 patchById 静默取最后一条）", () => {
    const dup = readFileSync(hotelPackPath, "utf-8").replace("rule_id: R3", "rule_id: R2");
    expect(() => loadFencePack(dup)).toThrowError(/重复|R2/);
  });
});

describe.skipIf(!hasHotelPack)("HP-02 ⑤ 单调守卫必须防 when/match 改写", () => {
  it("基线规则 when 被改成恒假 → 视为放宽（拒绝）", () => {
    const patch = hotelPackRules.map((r) => (r.rule_id === "R2" ? { ...r, when: "false" } : r));
    const res = checkMonotonic(hotelPackRules, patch);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.rule_id === "R2")).toBe(true);
  });

  it("基线规则 match 收窄（删掉被覆盖动作）→ 拒绝", () => {
    const patch = hotelPackRules.map((r) =>
      r.rule_id === "R3" ? { ...r, actions: ["price.adjust"] } : r);
    const res = checkMonotonic(hotelPackRules, patch);
    expect(res.ok).toBe(false);
  });

  it("patch 内重复 rule_id → 拒绝", () => {
    const res = checkMonotonic(hotelPackRules, [...hotelPackRules, { ...hotelPackRules[0]!, level: "auto" as const }]);
    expect(res.ok).toBe(false);
  });
});

describe("HP-02 ⑥ 规则动作清单注册（供装配期调用）", () => {
  it("registerWriteActions 对整段动作生效且幂等", () => {
    registerWriteActions(["inventory."]);
    expect(isWriteAction("inventory.adjust")).toBe(true);
    registerWriteActions(["inventory.", "inventory.adjust"]);
    expect(isWriteAction("inventory.adjust")).toBe(true);
  });
});

/* ================= 真库：版本可追溯 / 审批绑定 / 激活期单调守卫 ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_APP_URL) && Boolean(process.env.DATABASE_URL);

describe.skipIf(!RUN_DB || !hasHotelPack)("HP-02 真库：审批绑定与版本递增", () => {
  // ws-yunqi 的种子租户是 tenant-demo（与 runtime 夹具一致）；写错租户会在同一工作区产生
  // 第二条哈希链根（GENESIS），进而让套件的链完整性校验失败（O-15/Q-03/R-13）。
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const newRuleId = `R${(Math.floor(Math.random() * 800) + 100)}`;
  let appPool: import("pg").Pool;
  let ownerPool: import("pg").Pool;

  const rowId = (ruleId: string) => `fr-${ruleId.toLowerCase()}-vnext-${scope.workspaceId}`;

  async function withAppTx<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function insertCandidate(ruleId: string, level: "auto" | "review" | "block", when: string): Promise<void> {
    await withAppTx((client) => client.query(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,'v-next',$3,$4,$5,$6,$7,false,'pending_approval','MEM-001')
       ON CONFLICT (id) DO UPDATE SET level=EXCLUDED.level, match_spec=EXCLUDED.match_spec, status='pending_approval'`,
      [rowId(ruleId), ruleId, scope.workspaceId, `HP02 候选 ${ruleId}`,
       level, JSON.stringify({ object_types: ["room_price"], actions: ["price.adjust"], when }),
       JSON.stringify({ result: level === "auto" ? "pass" : level === "review" ? "review" : "blocked" })],
    ));
  }

  /** 造一条真实审批链：fence.rule.propose 事件 → approved 审批行 → approval.gesture 事件 */
  async function buildApprovalChain(ruleId: string, dryRunId: string): Promise<string> {
    return withAppTx(async (client) => {
      const proposal = await gatewayAppendOnClient(
        client,
        { ...scope, actor: { id: "MEM-001", type: "human" } },
        {
          who: { type: "human", id: "MEM-001" },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
          object: { type: "staff", id: ruleId },
          decision: { action: "fence.rule.propose", after: { ruleId, dryRunId } },
          rule_impact: [],
        } as never,
      );
      const approvalId = `apr-${proposal.eventId.toLowerCase()}`;
      await client.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($1,$2,$3,$4,'inapp','approved',$5)
         ON CONFLICT (approval_id) DO UPDATE SET status='approved'`,
        [approvalId, scope.tenantId, scope.workspaceId, proposal.eventId, JSON.stringify({ high_risk: true })],
      );
      const gesture = await gatewayAppendOnClient(
        client,
        { ...scope, actor: { id: "MEM-001", type: "human" } },
        {
          who: { type: "human", id: "MEM-001" },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
          object: { type: "staff", id: ruleId },
          decision: { action: "approval.gesture", after: { approvalId, gesture: "approve" } },
          rule_impact: [],
        } as never,
      );
      return gesture.eventId;
    });
  }

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    appPool = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
    ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await ownerPool.query("DELETE FROM fence_rules WHERE id=$1", [rowId(newRuleId)]);
  });

  afterAll(async () => {
    await ownerPool?.query("DELETE FROM fence_rules WHERE id=$1", [rowId(newRuleId)]).catch(() => undefined);
    await Promise.all([appPool?.end(), ownerPool?.end()]);
  });

  it("伪造审批引用被拒（审批事件必须与提案绑定且已 approved）", async () => {
    const dr = await createDryRun(appPool, scope, {
      ruleId: newRuleId, ruleVersion: "v-next", rules: hotelPackRules,
      defaultLevel: hotelPackDefaultLevel, createdBy: "MEM-001",
    });
    await confirmDryRun(appPool, scope, dr.dryRunId);
    await insertCandidate(newRuleId, "review", "after.price < 300");
    await expect(activateRuleVersion(appPool, scope, {
      ruleRowId: rowId(newRuleId), dryRunId: dr.dryRunId, approvalEventId: `E-FAKE-${suffix}`,
    })).rejects.toThrowError(/未绑定|伪造/);
  });

  it("基线规则放宽在激活期被单调守卫拒绝（level 降档）", async () => {
    const baseline = await withAppTx((client) => loadActiveRulesInTx(client, scope));
    const r2 = baseline.find((r) => r.rule_id === "R2");
    expect(r2?.is_baseline).toBe(true);
    const guard = checkCandidateAgainstBaseline(baseline, {
      rule_id: "R2", version: "v-next", name: "保底价熔断", level: "auto", is_baseline: false,
      objectTypes: r2!.objectTypes, actions: r2!.actions, when: r2!.when,
    });
    expect(guard.ok).toBe(false);
    expect(guard.violations.some((v) => /放宽/.test(v.reason))).toBe(true);
  });

  it("基线 when 被改写成恒假的候选同样被拒（HP-02 防伪装）", async () => {
    const baseline = await withAppTx((client) => loadActiveRulesInTx(client, scope));
    const r2 = baseline.find((r) => r.rule_id === "R2")!;
    const guard = checkCandidateAgainstBaseline(baseline, {
      rule_id: "R2", version: "v-next", name: "保底价熔断", level: "block", is_baseline: false,
      objectTypes: r2.objectTypes, actions: r2.actions, when: "false",
    });
    expect(guard.ok).toBe(false);
    expect(guard.violations.some((v) => /when/.test(v.reason))).toBe(true);
  });

  it("加严候选激活成功：版本递增、旧 active 同 rule_id 转 rolled_back", async () => {
    const dr = await createDryRun(appPool, scope, {
      ruleId: newRuleId, ruleVersion: "v-next", rules: hotelPackRules,
      defaultLevel: hotelPackDefaultLevel, createdBy: "MEM-001",
    });
    await confirmDryRun(appPool, scope, dr.dryRunId);
    await insertCandidate(newRuleId, "block", "after.price < 380");
    const gestureEventId = await buildApprovalChain(newRuleId, dr.dryRunId);
    const { version } = await activateRuleVersion(appPool, scope, {
      ruleRowId: rowId(newRuleId), dryRunId: dr.dryRunId, approvalEventId: gestureEventId,
    });
    expect(version).toMatch(/^v\d+$/);
    expect(version).not.toBe("v-next");
    const rows = await withAppTx((client) => client.query<{ status: string; version: string; approved_event_id: string }>(
      `SELECT status, version, approved_event_id FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 ORDER BY created_at`,
      [scope.workspaceId, newRuleId],
    ));
    expect(rows.rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect(rows.rows.find((r) => r.status === "active")?.version).toBe(version);
    expect(rows.rows.find((r) => r.status === "active")?.approved_event_id).toBe(gestureEventId);
  });
});
