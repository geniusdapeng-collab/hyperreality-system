/**
 * 安全审计回归（F12 全局收尾补登）：
 *  - H-11 凭据不出现在任何提示词与事件明文（L7.3：只记引用 ID）——全库扫描
 *  - H-13 脱敏失败批次被拦截（E1.3：不降级原文上行）——注入对抗
 *  - E1.3 正向：PII 命中 → 事件落库为占位符而非明文（铁律 1 脱敏段实效）
 */
import { describe, expect, it } from "vitest";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("安全审计 PG 集成（附录 H）", async () => {
  const pg = await import("pg");
  const { gatewayAppend } = await import("./gateway.js");
  const app = new pg.default.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gw = new pg.default.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };

  /** 断言查询辅助：事务内设 RLS 上下文（与生产口径一致；池直查在 RLS 下恒 0 行，断言会假绿/假红） */
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
  const qGw = async <T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) => {
    const c = await gw.connect();
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

  it("H-11：全部事件 payload / Agent 提示词 / 技能正文均不含凭据密文（只记引用 ID）", async () => {
    const client = await app.connect();
    try {
      // 事务级上下文（不用会话级 false——会话级设置会粘附物理连接污染池，见 #22 回归用例）
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const creds = await client.query<{ id: string; secret_enc: string }>(
        `SELECT id, secret_enc FROM credentials WHERE workspace_id=$1`, [scope.workspaceId]);
      expect(creds.rows.length).toBeGreaterThan(0);

      const events = await client.query<{ event_id: string; payload: unknown }>(
        `SELECT event_id, payload FROM biz_events WHERE workspace_id=$1`, [scope.workspaceId]);
      const agents = await client.query<{ id: string; meta: unknown }>(
        `SELECT id, meta FROM agents WHERE workspace_id=$1`, [scope.workspaceId]);
      const skills = await client.query<{ id: string; body: string }>(`SELECT id, body FROM skills`);

      for (const c of creds.rows) {
        for (const e of events.rows) {
          expect(JSON.stringify(e.payload), `事件 ${e.event_id} 含凭据 ${c.id} 密文`).not.toContain(c.secret_enc);
        }
        for (const a of agents.rows) {
          expect(JSON.stringify(a.meta), `Agent ${a.id} 提示词含凭据密文`).not.toContain(c.secret_enc);
        }
        for (const s of skills.rows) {
          expect(s.body, `技能 ${s.id} 正文含凭据密文`).not.toContain(c.secret_enc);
        }
      }
      // 字段名层面的明文出口也不允许出现
      for (const e of events.rows) {
        expect(JSON.stringify(e.payload)).not.toContain("secret_enc");
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  it("H-13：不可序列化/敌对 payload 被拒写且不降级原文上行（注入对抗）", async () => {
    const marker = `h13-hostile-${Date.now().toString(36)}`;
    await expect(
      gatewayAppend(gw, { ...scope, actor: { id: "MEM-001", type: "human" } }, {
        who: { type: "human", id: "MEM-001" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
        object: { type: "store", id: marker },
        // BigInt 不可 JSON 序列化——模拟脱敏/编码失败批次
        decision: { action: "audit.probe", after: { bad: BigInt(1) } as never },
        rule_impact: [],
      }),
    ).rejects.toThrow();
    // 拦截后事件库无原文（不降级上行）
    const r = await qGw(`SELECT 1 FROM biz_events WHERE payload::text LIKE $1`, [`%${marker}%`]);
    expect(r.rows.length).toBe(0);
  });

  it("E1.3 正向：PII 明文经脱敏段落库为占位符（铁律 1 实效）", async () => {
    const phone = "13912345678";
    const r = await gatewayAppend(gw, { ...scope, actor: { id: "MEM-001", type: "human" } }, {
      who: { type: "human", id: "MEM-001" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "guest", id: `h13-pii-${Date.now().toString(36)}` },
      decision: { action: "audit.pii_probe", after: { contact: `客人电话 ${phone}` } },
      rule_impact: [],
    });
    expect(r.piiHits).toBeGreaterThan(0);
    const row = await qApp<{ payload: string }>(
      `SELECT payload::text AS payload FROM biz_events WHERE event_id=$1`, [r.eventId]);
    expect(row.rows[0]!.payload).not.toContain(phone);
    expect(row.rows[0]!.payload).toContain("[PII:PHONE:");
  });

  it("RLS 上下文纪律（#22 回归）：autocommit 下事务级 set_config 失效（fail-closed 0 行），显式事务内生效", async () => {
    // 反例固定：autocommit 单语句 set_config(...,true) 后查询 → RLS 上下文已失效 → 0 行
    // （这正是 #22 事故根因；若未来 PG 行为或封装被改回，本用例立即变红）
    const naive = await app.connect();
    try {
      // 先 RESET 清掉池物理连接上可能残留的会话级设置，保证起点干净
      await naive.query("RESET app.workspace_id");
      await naive.query("RESET app.tenant_id");
      await naive.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const r = await naive.query(`SELECT count(*) AS c FROM members WHERE workspace_id=$1`, [scope.workspaceId]);
      expect(Number(r.rows[0]!.c)).toBe(0);
    } finally {
      naive.release();
    }
    // 正例：显式事务内设置 → 可见（members 种子 3 人）
    const ok = await qApp<{ c: string }>(`SELECT count(*) AS c FROM members WHERE workspace_id=$1`, [scope.workspaceId]);
    expect(Number(ok.rows[0]!.c)).toBeGreaterThanOrEqual(3);
    // 池连接卫生：经事务封装的连接归还后不残留 RLS 上下文（无泄漏到下个借用者）
    const leaked = await app.connect();
    try {
      await leaked.query("RESET app.workspace_id");
      await leaked.query("RESET app.tenant_id");
      const r = await leaked.query(`SELECT count(*) AS c FROM members WHERE workspace_id=$1`, [scope.workspaceId]);
      expect(Number(r.rows[0]!.c)).toBe(0); // 未设上下文 → fail-closed
    } finally {
      leaked.release();
    }
  });

  it("#30 append-only 第三道防线：TRUNCATE 全角色被拒（含 owner）", async () => {
    // owner（迁移/种子账号）此前可 TRUNCATE 清空事件库——行级触发器不拦 TRUNCATE；
    // 0004 迁移后语句级触发器对全角色生效
    const owner = new pg.default.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom" });
    try {
      await expect(owner.query("TRUNCATE biz_events")).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
    // 事件库完好（种子 100 条仍在）
    const n = await qApp<{ c: string }>(`SELECT count(*) AS c FROM biz_events WHERE workspace_id=$1`, [scope.workspaceId]);
    expect(Number(n.rows[0]!.c)).toBeGreaterThanOrEqual(100);
  });

  it("#31 fence_rules 全局基线（workspace_id='*'）仅 owner 可写（F2.3 DB 收口）", async () => {
    // app 角色经工作区上下文 INSERT '*' 全局基线行 → 触发器拒（影响面=全部租户）
    await expect(
      qApp(
        `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, created_by)
         VALUES ('fr-evil-${Date.now().toString(36)}','R9','v1','*','evil','block','{}','{}','attacker')`,
      ),
    ).rejects.toThrow(/仅 owner 可写/);
    // 工作区级行写入不受影响
    const okId = `fr-ok-${Date.now().toString(36)}`;
    await qApp(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, created_by)
       VALUES ($1,'R9','v99',$2,'ok','block','{}','{}','tester')`,
      [okId, scope.workspaceId],
    );
    await qApp(`DELETE FROM fence_rules WHERE id=$1`, [okId]);
  });
});
