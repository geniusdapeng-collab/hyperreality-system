/**
 * 行业组合根回归：真实 tRPC caller、真实 PostgreSQL/RLS 和五元事件链。
 * 成员权威读取与审批失败用模拟夹具；提案/网关/事件和正常审批 SQL 均运行生产实现。
 * 只有显式 RUN_DB_TESTS=1 且提供隔离测试库地址才执行；不连接经营库。
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";

const authority = vi.hoisted(() => vi.fn());
const fault = vi.hoisted(() => ({ approval: false }));
vi.mock("../service/access-authority.js", async (original) => ({
  ...await original<typeof import("../service/access-authority.js")>(),
  currentMemberAuthority: authority,
}));
vi.mock("@workloom/db", async (original) => {
  const actual = await original<typeof import("@workloom/db")>();
  return { ...actual, getAppPool: (...args: Parameters<typeof actual.getAppPool>) => {
    const pool = actual.getAppPool(...args);
    if (!fault.approval) return pool;
    return new Proxy(pool, { get(target, key) {
      if (key === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, property) {
          if (property === "query") return (...queryArgs: unknown[]) => {
            if (fault.approval && typeof queryArgs[0] === "string" && /INSERT INTO approvals/.test(queryArgs[0])) {
              throw new Error("模拟审批写入失败");
            }
            return Reflect.apply(connection.query, connection, queryArgs);
          };
          const value = Reflect.get(connection, property);
          return typeof value === "function" ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } };
});
import { appRouter } from "./router.js";
import { closeAllPools } from "@workloom/db";

const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("围栏提案真实事务回归（模拟成员，隔离 PG）", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const tenantId = `tenant-proposal-${suffix}`;
  const workspaceId = `ws-proposal-${suffix}`;
  const foreignWorkspace = `ws-proposal-other-${suffix}`;
  const identity: Identity = {
    kind: "member", memberId: `mem-proposal-${suffix}`, memberNo: "MEM-001",
    name: "模拟提案负责人", role: "owner", plan: "pro", tenantId, workspaceId,
  };
  const context = { session: identity, identity, partnerIdentity: null, headers: new Headers() };
  const caller = appRouter.createCaller(context);
  let sequence = 0;
  const rule = (ruleId: string, extra: Record<string, unknown> = {}) => ({
    ruleId, name: "模拟围栏规则", level: "review" as const,
    objectTypes: ["staff"], actions: ["staff.update"], when: "true", ...extra,
  });
  async function dryRun(ruleId: string, ws = workspaceId, status = "pending") {
    const id = `dr-proposal-${suffix}-${++sequence}`;
    await owner.query(
      `INSERT INTO fence_dry_runs (id,workspace_id,rule_id,rule_version,report,status,created_by)
       VALUES ($1,$2,$3,'v-next','{}',$4,'MEM-001')`, [id, ws, ruleId, status],
    );
    return id;
  }
  async function activeRule(ruleId: string, level = "review", version = "v1", status = "active") {
    await owner.query(
      `INSERT INTO fence_rules (id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by)
       VALUES ($1,$2,$3,$4,'模拟当前规则',$5,$6,'{}',false,$7,'MEM-001')`,
      [`fr-${ruleId.toLowerCase()}-${version}-${workspaceId}`, ruleId, version, workspaceId, level,
        JSON.stringify({ object_types: ["staff"], actions: ["staff.update"], when: "true" }), status],
    );
  }
  async function state(dryRunId: string, ruleId: string) {
    const dry = await owner.query(`SELECT status FROM fence_dry_runs WHERE id=$1`, [dryRunId]);
    const rows = await owner.query(`SELECT id,version,status FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 ORDER BY version`, [workspaceId, ruleId]);
    return { dry: dry.rows[0]?.status, rows: rows.rows };
  }
  beforeAll(async () => {
    authority.mockImplementation(async (current: Identity) => ({ identity: current, permissions: {} }));
    await owner.query(`INSERT INTO tenants (id,name,plan) VALUES ($1,'模拟提案租户','pro')`, [tenantId]);
    for (const ws of [workspaceId, foreignWorkspace]) {
      await owner.query(`INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'模拟提案工作区',$1,'general')`, [ws, tenantId]);
    }
  });
  afterAll(async () => {
    // append-only 事件夹具留在隔离库，不通过删账本伪造测试清理。
    await closeAllPools();
    await owner.end();
  });

  it("连续提案分配 v2/v3，事件和审批绑定各自行 ID", async () => {
    const id = `R-${suffix}-repeat`;
    await activeRule(id);
    const results = [];
    for (let i = 0; i < 2; i += 1) {
      results.push(await caller.fence.confirmDryRun({ dryRunId: await dryRun(id), rule: rule(id) }));
    }
    const rows = await owner.query(`SELECT id,version FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 ORDER BY version`, [workspaceId, id]);
    expect(rows.rows.map(r => r.version)).toEqual(["v1", "v2", "v3"]);
    for (const [index, result] of results.entries()) {
      const event = await owner.query(`SELECT payload FROM biz_events WHERE tenant_id=$1 AND event_id=$2`, [tenantId, result.eventId]);
      const after = event.rows[0].payload.decision.after;
      expect(after).toMatchObject({ ruleRowId: rows.rows[index + 1].id, version: `v${index + 2}` });
      const approval = await owner.query(`SELECT status,snapshot FROM approvals WHERE event_id=$1`, [result.eventId]);
      expect(approval.rows[0]).toMatchObject({ status: "pending", snapshot: { ruleRowId: after.ruleRowId, version: after.version, high_risk: true } });
    }
  });
  it("rolled_back 的历史最高版本仍参与递增", async () => {
    const id = `R-${suffix}-history`;
    await activeRule(id, "review", "v9", "rolled_back");
    const dr = await dryRun(id);
    await caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) });
    expect((await state(dr, id)).rows.map(r => r.version)).toContain("v10");
  });
  it("已确认 dry-run 重放被拒，没有重复提案", async () => {
    const id = `R-${suffix}-replay`, dr = await dryRun(id);
    await caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) });
    await expect(caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await state(dr, id)).rows).toHaveLength(1);
  });
  it("跨工作区 dry-run 被拒，外部 pending 未被消耗", async () => {
    const id = `R-${suffix}-foreign`, dr = await dryRun(id, foreignWorkspace);
    await expect(caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await state(dr, id)).toEqual({ dry: "pending", rows: [] });
  });
  it("不同规则的 dry-run 不可借用", async () => {
    const id = `R-${suffix}-mismatch`, dr = await dryRun(`${id}-other`);
    await expect(caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await state(dr, id)).toEqual({ dry: "pending", rows: [] });
  });
  it.each(["confirmed", "rejected"])("%s 状态不可再次确认", async (status) => {
    const id = `R-${suffix}-${status}`, dr = await dryRun(id, workspaceId, status);
    await expect(caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await state(dr, id)).rows).toHaveLength(0);
  });
  it.each([
    ["降低等级", { level: "auto" }],
    ["收窄对象", { objectTypes: [] }],
    ["收窄动作", { actions: [] }],
    ["改写条件", { when: "false" }],
  ])("%s 被基线守卫拒绝，修正后可用原 pending 重试", async (_label, patch) => {
    const id = `R-${suffix}-${++sequence}`, dr = await dryRun(id);
    await activeRule(id);
    await expect(caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id, patch) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await state(dr, id)).dry).toBe("pending");
    await caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) });
    expect((await state(dr, id)).dry).toBe("confirmed");
  });
  it("明确条件放行事实随提案事件保留", async () => {
    const id = `R-${suffix}-when`, dr = await dryRun(id);
    await activeRule(id);
    const result = await caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id, { when: "false" }), allowWhenChange: true });
    const event = await owner.query(`SELECT payload FROM biz_events WHERE event_id=$1`, [result.eventId]);
    expect(event.rows[0].payload.decision.after).toMatchObject({ allowWhenChange: true, when: "false" });
  });
  it("两个并发提案落不同版本，均有真实事件回执", async () => {
    const id = `R-${suffix}-parallel`;
    const dry = await Promise.all([dryRun(id), dryRun(id)]);
    const result = await Promise.all(dry.map(dr => caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })));
    expect(new Set(result.map(r => r.eventId)).size).toBe(2);
    expect((await state(dry[0]!, id)).rows.map(r => r.version)).toEqual(["v1", "v2"]);
  });
  it("同一 dry-run 并发只确认一次", async () => {
    const id = `R-${suffix}-same`, dr = await dryRun(id);
    const results = await Promise.allSettled([0, 1].map(() => caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await state(dr, id)).rows).toHaveLength(1);
  });
  it("审批写入失败时 dry-run、提案行与已追加事件一起回滚", async () => {
    const id = `R-${suffix}-rollback`, dr = await dryRun(id);
    const count = await owner.query(`SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1`, [workspaceId]);
    fault.approval = true;
    try {
      await expect(caller.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })).rejects.toThrow("模拟审批写入失败");
      expect(await state(dr, id)).toEqual({ dry: "pending", rows: [] });
      const after = await owner.query(`SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1`, [workspaceId]);
      expect(after.rows[0].n).toBe(count.rows[0].n);
    } finally {
      fault.approval = false;
    }
  });
  it("未认证和只读成员不能提出规则变更", async () => {
    const id = `R-${suffix}-denied`, dr = await dryRun(id);
    const anonymous = appRouter.createCaller({ session: null, identity: null, partnerIdentity: null, headers: new Headers() });
    await expect(anonymous.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const readonly = { ...identity, role: "readonly" as const };
    const restricted = appRouter.createCaller({ ...context, identity: readonly, session: readonly });
    await expect(restricted.fence.confirmDryRun({ dryRunId: dr, rule: rule(id) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await state(dr, id)).toEqual({ dry: "pending", rows: [] });
  });
});
