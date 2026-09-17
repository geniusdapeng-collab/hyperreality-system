/**
 * B6 测试：手势校验（L5.2）/ 角色门禁（L5.1）/ 三手势权重 / 幂等与过期（PG 集成，L5.3/E5.3）
 */
import { describe, expect, it } from "vitest";
import { ApprovalError, assertApproverRole, validateGesture } from "./approvals.js";
import { GESTURE_WEIGHT } from "@workloom/shared";

describe("手势校验（L5.2）", () => {
  it("驳回空理由被拒", () => {
    expect(() => validateGesture({ type: "reject" })).toThrow(ApprovalError);
    expect(() => validateGesture({ type: "reject", reasonEnum: "  " })).toThrow(/L5\.2/);
  });

  it("驳回原因自由文本 >200 字被拒；合法驳回放行", () => {
    expect(() =>
      validateGesture({ type: "reject", reasonEnum: "price_too_high", reasonText: "x".repeat(201) }),
    ).toThrow(/200/);
    expect(() =>
      validateGesture({ type: "reject", reasonEnum: "price_too_high", reasonText: "涨幅超出预期" }),
    ).not.toThrow();
  });

  it("编辑后采纳必须带新值；采纳无附加要求", () => {
    expect(() => validateGesture({ type: "edit" })).toThrow(/edited_after/);
    expect(() => validateGesture({ type: "edit", editedAfter: { price: 428 } })).not.toThrow();
    expect(() => validateGesture({ type: "approve" })).not.toThrow();
  });

  it("三手势权重 1/2/3（M5 口径）", () => {
    expect(GESTURE_WEIGHT).toEqual({ approve: 1, edit: 2, reject: 3 });
  });
});

describe("审批人角色门禁（L5.1/L5.5）", () => {
  it("readonly 审批 → 403 语义", () => {
    try {
      assertApproverRole("readonly");
      expect.unreachable();
    } catch (e) {
      expect((e as ApprovalError).statusCode).toBe(403);
    }
  });
  it("owner/manager 放行", () => {
    expect(() => assertApproverRole("owner")).not.toThrow();
    expect(() => assertApproverRole("manager")).not.toThrow();
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成审批流（种子队列）", async () => {
  const pg = (await import("pg")).default;
  const { listQueue, decide, batchApprove, expireSweep } = await import("./approvals.js");
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gwPool = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  /** app 池断言查询辅助：事务内设 RLS 上下文（与生产口径一致；池直查在 RLS 下恒 0 行） */
  const qApp = async <T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) => {
    const c = await appPool.connect();
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

  const boss = { memberNo: "MEM-001", role: "owner" as const };

  /** gateway 池直查/直写辅助：同一连接内设会话级 RLS 上下文（池连接不共享 set_config） */
  const withGw = async <T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const c = await gwPool.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [scope.tenantId]);
      return await fn(c);
    } finally {
      c.release();
    }
  };

  it("统一队列投影（pending 含被审事件 diff/规则版本，F5.1/F5.3）", async () => {
    // 自造一条保证可重跑（种子 pending 可能已被历史运行处理）
    await makePending(`apr-b6-queue-${Date.now().toString(36)}`);
    const q = await listQueue(appPool, scope, { status: "pending" });
    expect(q.length).toBeGreaterThan(0);
    const item = q[0]!;
    expect(item.event).toBeDefined();
    expect(item.event!.rule_impact.length).toBeGreaterThan(0); // 命中规则版本可见
    expect(item.snapshot).toBeDefined(); // before/after diff 快照
  });

  /** 造 pending 审批辅助：先经网关铸一条新事件（可重跑不冲突），再挂审批（测试自备数据） */
  const makePending = async (id: string, snapshot: Record<string, unknown> = {}) => {
    const { gatewayAppend } = await import("../workdata/gateway.js");
    const ev = await gatewayAppend(gwPool, {
      ...scope,
      actor: { id: "review-agent", type: "agent", fenceBindings: ["R6"] },
    }, {
      who: { type: "agent", id: "review-agent", version: "v1.8" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
      object: { type: "review", id: `RV-TEST-${id}` },
      decision: { action: "review.reply", params: { rating: 2 }, after: { draft: "测试草稿" } },
      rule_impact: [{ rule_id: "R6", version: "hotel-baseline/v1", result: "review" }],
    });
    await withGw((c) =>
      c.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($4, $1, $2, $3, 'inapp', 'pending', $5)`,
        [scope.tenantId, scope.workspaceId, ev.eventId, id, JSON.stringify(snapshot)],
      ),
    );
    return ev.eventId;
  };

  it("三手势回写：采纳 → 事件库留痕（approval.gesture + links 溯源）", async () => {
    const id = `apr-b6-approve-${Date.now().toString(36)}`;
    await makePending(id, { expires_at: new Date(Date.now() + 864e5).toISOString() });
    const r = await decide(appPool, gwPool, scope, boss, id, { type: "approve" });
    expect(r.status).toBe("approved");
    expect(r.gestureEventId).toMatch(/^E-\d+$/);
    // 手势事件链接被审事件（决策链路 F5.3）
    const ev = await withGw((c) =>
      c.query("SELECT payload FROM biz_events WHERE tenant_id=$1 AND event_id=$2", [scope.tenantId, r.gestureEventId]),
    );
    expect(ev.rows.length).toBe(1);
  });

  it("重复回调只处理首次（L5.3）", async () => {
    const q = await listQueue(appPool, scope, {});
    const done = q.find((x) => x.status !== "pending")!;
    const r = await decide(appPool, gwPool, scope, boss, done.approval_id, { type: "approve" });
    expect(r.deduped).toBe(true);
    expect(r.status).toBe(done.status); // 状态不被覆盖
  });

  it("驳回 + 原因枚举 → rejected + 偏好模式记忆回流（F1.7）", async () => {
    const id = `apr-b6-reject-${Date.now().toString(36)}`;
    await makePending(id, { expires_at: new Date(Date.now() + 864e5).toISOString() });
    const r = await decide(appPool, gwPool, scope, boss, id, {
      type: "reject", reasonEnum: "amount_too_large", reasonText: "超出门店免赔额度",
    });
    expect(r.status).toBe("rejected");
    const mem = await qApp("SELECT kind, content FROM org_memory WHERE memory_id='mem-reject-amount_too_large'");
    expect(mem.rows.length).toBe(1);
    expect(mem.rows[0]!.kind).toBe("preference");
  });

  it("快照过期：手势被拒并标 expired（E5.3/F5.7）", async () => {
    const id = `apr-b6-expired-${Date.now().toString(36)}`;
    await makePending(id, { expires_at: new Date(Date.now() - 3600e3).toISOString() });
    await expect(
      decide(appPool, gwPool, scope, boss, id, { type: "approve" }),
    ).rejects.toThrow(/expired/);
  });

  it("超时升级扫描：高危项不自动放行（L5.4）", async () => {
    const tag = Date.now().toString(36);
    const hr = `apr-b6-hr-${tag}`;
    const normal = `apr-b6-normal-${tag}`;
    // 一条过期高危 + 一条过期普通
    await makePending(hr, { expires_at: new Date(Date.now() - 7200e3).toISOString(), high_risk: true });
    await makePending(normal, { expires_at: new Date(Date.now() - 7200e3).toISOString() });
    const r = await expireSweep(appPool, gwPool, scope);
    expect(r.keptHighRisk).toContain(hr);
    expect(r.expired).toContain(normal);
  });

  it("批量采纳：高危项跳过，普通项采纳", async () => {
    const tag = Date.now().toString(36);
    const low = `apr-b6-low-${tag}`;
    const high = `apr-b6-high-${tag}`;
    await makePending(low, { high_risk: false });
    await makePending(high, { high_risk: true });
    const r = await batchApprove(appPool, gwPool, scope, boss, [low, high]);
    expect(r.approved).toEqual([low]);
    expect(r.skipped[0]).toMatchObject({ id: high });
    expect(r.skipped[0]!.reason).toContain("高危");
  });

  it("readonly 角色审批被拒（L5.1 服务端强制）", async () => {
    const id = `apr-b6-ro-${Date.now().toString(36)}`;
    await makePending(id);
    await expect(
      decide(appPool, gwPool, scope, { memberNo: "MEM-003", role: "readonly" }, id, { type: "approve" }),
    ).rejects.toThrow(/403|无审批权限/);
  });
});
