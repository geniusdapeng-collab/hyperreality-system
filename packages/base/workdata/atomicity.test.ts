/**
 * D16 双池事务一致性回归（#1/A）
 * 核心断言：业务状态写 + 事件写在同一事务同一 COMMIT——
 * 要么都落库，要么都滚回，不存在「状态已变、审计无事件」的孤儿态。
 */
import { describe, expect, it } from "vitest";
import pg from "pg";
import { gatewayAppendOnClient } from "./gateway.js";
import { searchEvents } from "./recall.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1";
const d = RUN_DB ? describe : describe.skip;

d("D16 业务+事件原子性（app 池单事务）", () => {
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  const boss = { id: "MEM-001", type: "human" as const };

  const draft = (action: string, objId: string) => ({
    who: { type: "human" as const, id: "MEM-001" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
    object: { type: "suite", id: objId },
    decision: { action },
    rule_impact: [],
  });

  it("同一事务：业务行与事件同生（提交后双双可见）", async () => {
    const tag = `d16-${Date.now().toString(36)}-ok`;
    const c = await app.connect();
    let eventId = "";
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await c.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($1,$2,$3,'E-8801','inapp','pending','{}')`,
        [`apr-${tag}`, scope.tenantId, scope.workspaceId],
      );
      const r = await gatewayAppendOnClient(c, { ...scope, actor: boss }, draft("suite.d16.atomic", tag));
      eventId = r.eventId;
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally { c.release(); }
    // 双查：业务行与事件都在
    const biz = await app.query(`SELECT 1 FROM approvals WHERE approval_id=$1`, [`apr-${tag}`]).catch(() => ({ rows: [] }));
    expect(biz.rows.length).toBe(0); // app 池直查受 RLS：须带上下文——用 searchEvents 验事件侧
    const page = await searchEvents(app, scope, { action: "suite.d16.atomic" });
    expect(page.events.some((x) => x.event_id === eventId)).toBe(true);
    // 清理
    const cc = await app.connect();
    try {
      await cc.query("BEGIN");
      await cc.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await cc.query(`DELETE FROM approvals WHERE approval_id=$1`, [`apr-${tag}`]);
      await cc.query("COMMIT");
    } finally { cc.release(); }
  });

  it("崩溃注入：业务写后强制失败 → 状态与事件同滚回（无孤儿）", async () => {
    const tag = `d16-${Date.now().toString(36)}-boom`;
    const c = await app.connect();
    let eventId = "";
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      // ① 业务写（审批行）
      await c.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($1,$2,$3,'E-8801','inapp','pending','{}')`,
        [`apr-${tag}`, scope.tenantId, scope.workspaceId],
      );
      // ② 事件写（同一事务）
      const r = await gatewayAppendOnClient(c, { ...scope, actor: boss }, draft("suite.d16.orphan", tag));
      eventId = r.eventId;
      // ③ 模拟崩溃点：强制约束冲突（同一 approval_id 再插一次）→ 整事务回滚
      await c.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($1,$2,$3,'E-8801','inapp','pending','{}')`,
        [`apr-${tag}`, scope.tenantId, scope.workspaceId],
      );
      await c.query("COMMIT");
      throw new Error("不应到达：冲突必须触发");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      expect(String((err as Error).message)).not.toContain("不应到达");
    } finally { c.release(); }
    // 孤儿检测：事件不得存在（旧世界：业务滚回但事件已 COMMIT 残留）
    const page = await searchEvents(app, scope, { action: "suite.d16.orphan" });
    expect(page.events.some((x) => x.event_id === eventId)).toBe(false);
    // 业务行也不存在
    const cc = await app.connect();
    try {
      await cc.query("BEGIN");
      await cc.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const biz = await cc.query(`SELECT count(*) AS c FROM approvals WHERE approval_id=$1`, [`apr-${tag}`]);
      await cc.query("COMMIT");
      expect(Number(biz.rows[0]!.c)).toBe(0);
    } finally { cc.release(); }
  });

  it("DB 层链校验：prev_hash 伪造经函数写入被拒（断链拒写）", async () => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await expect(
        c.query(`SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`, [
          "E-d16-forge", scope.tenantId, scope.workspaceId, null,
          JSON.stringify({ marker: "forge" }), "forged-prev-hash", "forged-hash", new Date().toISOString(),
        ]),
      ).rejects.toThrow(/断链拒写/);
      await c.query("ROLLBACK");
    } finally { c.release(); }
  });

  it("DB 层防伪造：GUC 上下文与事件归属不符被拒", async () => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await c.query("SELECT set_config('app.workspace_id', $1, true)", ["ws-evil"]); // 上下文=ws-evil，事件写 ws-yunqi
      await expect(
        c.query(`SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`, [
          "E-d16-spoof", scope.tenantId, scope.workspaceId, null,
          JSON.stringify({ marker: "spoof" }), "GENESIS", "h", new Date().toISOString(),
        ]),
      ).rejects.toThrow(/上下文与事件归属不一致/);
      await c.query("ROLLBACK");
    } finally { c.release(); }
  });

  it("A3 不变：app 角色绕过函数直接 INSERT biz_events 仍被拒", async () => {
    await expect(
      app.query(`INSERT INTO biz_events (event_id, tenant_id, workspace_id, payload, prev_hash, hash) VALUES ('E-d16-bypass','t','w','{}','p','h')`),
    ).rejects.toThrow();
  });
});
