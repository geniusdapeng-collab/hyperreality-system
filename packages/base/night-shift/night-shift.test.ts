/**
 * B9 测试：状态机迁移 / cron 匹配 / 决策包三段投影（纯函数）+
 * PG 集成：候选清单 / 开启夜班（围栏快照）/ 一键暂停（G5 计时+留痕）/ 决策包投递 / 触发器事件化
 */
import { describe, expect, it } from "vitest";
import { assertTransition, NightTransitionError, nightRunId } from "./scheduler.js";
import { cronMatches } from "./triggers.js";
import { projectNightPackage } from "./package.js";
import type { BusinessEvent } from "@workloom/shared";

describe("夜班状态机（F4.8）", () => {
  it("合法迁移全通；非法迁移拒绝", () => {
    expect(() => assertTransition("unconfigured", "ready")).not.toThrow();
    expect(() => assertTransition("ready", "running")).not.toThrow();
    expect(() => assertTransition("running", "paused")).not.toThrow();
    expect(() => assertTransition("paused", "running")).not.toThrow();
    expect(() => assertTransition("running", "package_generated")).not.toThrow();
    expect(() => assertTransition("package_generated", "ready")).not.toThrow();
    expect(() => assertTransition("ready", "package_generated")).toThrow(NightTransitionError);
    expect(() => assertTransition("unconfigured", "running")).toThrow(/F4\.8/);
  });
});

describe("cron 匹配（确定性）", () => {
  it("0 7 * * * 命中 07:00，不命中 07:01/22:00", () => {
    expect(cronMatches("0 7 * * *", new Date("2026-08-17T07:00:00+08:00"))).toBe(true);
    expect(cronMatches("0 7 * * *", new Date("2026-08-17T07:01:00+08:00"))).toBe(false);
    expect(cronMatches("0 7 * * *", new Date("2026-08-17T22:00:00+08:00"))).toBe(false);
  });
  it("0 22 * * * 与步进 */5", () => {
    expect(cronMatches("0 22 * * *", new Date("2026-08-16T22:00:00+08:00"))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date("2026-08-16T22:10:00+08:00"))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date("2026-08-16T22:11:00+08:00"))).toBe(false);
  });
});

describe("决策包三段投影（F4.4/H-7 纯函数）", () => {
  const ev = (over: Partial<BusinessEvent>): BusinessEvent => ({
    event_id: "E-9001",
    who: { type: "agent", id: "reconcile-agent", version: "v2.0" },
    context: { tenant_id: "t", workspace_id: "w", time: "2026-08-16T23:00:00+08:00" },
    object: { type: "order" },
    decision: { action: "order.reconcile" },
    rule_impact: [],
    ...over,
  });

  it("已完成/待审批/需介入三分 + 无回执标未核实", () => {
    const pkg = projectNightPackage([
      ev({ event_id: "E-1", receipt: { synced: true, snapshot_uri: "s.png" } }),
      ev({ event_id: "E-2", rule_impact: [{ rule_id: "R4", version: "v1", result: "review" }] }),
      ev({ event_id: "E-3", rule_impact: [{ rule_id: "R2", version: "v1", result: "blocked" }] }),
      ev({ event_id: "E-4", receipt: undefined, rule_impact: [{ rule_id: "R1", version: "v1", result: "pass" }] }),
    ]);
    expect(pkg.done.map((i) => i.eventId)).toEqual(["E-1"]);
    expect(pkg.pending.map((i) => i.eventId)).toEqual(["E-2"]);
    expect(pkg.needHuman.map((i) => i.eventId).sort()).toEqual(["E-3", "E-4"]);
    expect(pkg.needHuman.find((i) => i.eventId === "E-4")!.summary).toContain("未核实");
    expect(pkg.stats.credits_used).toBe(0);
  });

  it("整包 ≤20 条按严重度截断（G6）", () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      ev({ event_id: `E-${i}`, receipt: { synced: true } }));
    const pkg = projectNightPackage(events);
    expect(pkg.done.length + pkg.pending.length + pkg.needHuman.length).toBe(20);
    expect(pkg.truncated).toBe(5);
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成夜班闭环（种子库）", async () => {
  const pg = (await import("pg")).default;
  const { buildCandidateList } = await import("./candidates.js");
  const { confirmNight, ensureReady, pauseAll, resumeNight } = await import("./scheduler.js");
  const { deliverPackage } = await import("./package.js");
  const { upsertTrigger, setTriggerEnabled, tickTriggers } = await import("./triggers.js");
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  const runDate = `test-${Date.now().toString(36)}`;
  // 0013 口径：nr-<workspaceId>-<runDate>（PK 已改 (workspace_id, run_date)，id 保留唯一约束兼容旧查询）
  const runId = nightRunId(scope.workspaceId, runDate);
  expect(runId).toBe(`nr-ws-yunqi-${runDate}`);

  it("18:00 候选清单：夜班 preset 覆盖 3 项 + 谷时价 + 围栏摘要", async () => {
    const list = await buildCandidateList(app, scope);
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.every((i) => i.estCredits >= 1 && i.fenceSummary.length > 0)).toBe(true);
    expect(list.some((i) => i.type === "对账")).toBe(true);
  });

  it("开启夜班：ready→running + 围栏快照 hotel-baseline/v1（F2.6）+ 留痕", async () => {
    await ensureReady(app, gw, scope, runDate);
    await confirmNight(app, gw, scope, runId, "MEM-001", ["nt-reconcile", "nt-review"]);
    const c = await app.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const r = await c.query(`SELECT status, fence_snapshot_version, candidate_count FROM night_runs WHERE id=$1`, [runId]);
      expect(r.rows[0]).toMatchObject({ status: "running", fence_snapshot_version: "hotel-baseline/v1", candidate_count: 2 });
    } finally { c.release(); }
  });

  it("一键暂停：≤60s 计时留痕 + running 线程挂起（G5）", async () => {
    const r = await pauseAll(app, gw, scope, runId, { memberNo: "MEM-001", channel: "mobile" });
    expect(r.withinSla).toBe(true);
    expect(r.elapsedMs).toBeLessThan(60_000);
    const c = await app.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const run = await c.query(`SELECT status FROM night_runs WHERE id=$1`, [runId]);
      expect(run.rows[0].status).toBe("paused");
    } finally { c.release(); }
    // 留痕事件可查（night.pause_all）
    const q = await import("../workdata/recall.js");
    const page = await q.searchEvents(app, scope, { action: "night.pause_all" }, { limit: 5 });
    expect(page.events.length).toBeGreaterThan(0);
  });

  it("恢复 → running（断点续跑锚点保留）", async () => {
    await resumeNight(app, gw, scope, runId, "MEM-001");
    const c = await app.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const r = await c.query(`SELECT status FROM night_runs WHERE id=$1`, [runId]);
      expect(r.rows[0].status).toBe("running");
    } finally { c.release(); }
  });

  it("pauseAll 对不存在班次抛错（拒绝空班次操作）", async () => {
    await expect(
      pauseAll(app, gw, scope, `nr-ws-yunqi-missing-${Date.now().toString(36)}`, { memberNo: "MEM-001", channel: "mobile" }),
    ).rejects.toThrow(/不存在/);
  });

  it("08:30 决策包：夜间窗口事件三段投影 + 状态 package_generated + 投递留痕", async () => {
    const now = new Date();
    const from = new Date(now); from.setDate(from.getDate() - 2);
    const pkg = await deliverPackage(app, gw, scope, runId, { from: from.toISOString(), to: now.toISOString() });
    // G6：整包 ≤20 条；超出按严重度截断（窗口含种子+测试事件，截断必然发生）
    const included = pkg.stats.done + pkg.stats.pending + pkg.stats.need_human;
    expect(included).toBeGreaterThan(0);
    expect(included).toBeLessThanOrEqual(20);
    expect(pkg.truncated).toBeGreaterThanOrEqual(0);
    const c = await app.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const r = await c.query(`SELECT status, stats FROM night_runs WHERE id=$1`, [runId]);
      expect(r.rows[0].status).toBe("package_generated");
      expect(r.rows[0].stats.done).toBe(pkg.stats.done);
      // 重复投递幂等：UPDATE rowCount=0 → 不重写 night.package.deliver 事件
      const before = await c.query<{ c: string }>(
        `SELECT count(*) AS c FROM biz_events
         WHERE workspace_id=$1 AND payload->'decision'->>'action'='night.package.deliver'
           AND payload->'decision'->'after'->>'runId'=$2`,
        [scope.workspaceId, runId],
      );
      const again = await deliverPackage(app, gw, scope, runId, { from: from.toISOString(), to: now.toISOString() });
      expect(again.stats).toEqual(pkg.stats);
      const after = await c.query<{ c: string }>(
        `SELECT count(*) AS c FROM biz_events
         WHERE workspace_id=$1 AND payload->'decision'->>'action'='night.package.deliver'
           AND payload->'decision'->'after'->>'runId'=$2`,
        [scope.workspaceId, runId],
      );
      expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
      expect(Number(before.rows[0]!.c)).toBe(1);
    } finally { c.release(); }
  });

  it("触发器：CRUD/启停事件化（L4.4）+ cron tick 命中触发 + 同分钟幂等", async () => {
    const id = `tg-test-${Date.now().toString(36)}`;
    const at = new Date("2026-08-17T07:00:00+08:00");
    await upsertTrigger(app, gw, scope, { id, name: "测试触发器", kind: "cron", schedule: "0 7 * * *", action: { dispatch: "inspection-agent" }, createdBy: "MEM-001" });
    await setTriggerEnabled(app, gw, scope, id, false, "MEM-001");
    // 停用时 tick 不触发
    let fired = await tickTriggers(app, gw, scope, at);
    expect(fired.some((f) => f.id === id)).toBe(false);
    await setTriggerEnabled(app, gw, scope, id, true, "MEM-001");
    fired = await tickTriggers(app, gw, scope, at);
    expect(fired.some((f) => f.id === id)).toBe(true);
    // 幂等：同 trigger 同分钟重复 tick → trigger_fires 占位冲突 → 跳过不重触发（多副本/重试安全）
    const dup = await tickTriggers(app, gw, scope, at);
    expect(dup.some((f) => f.id === id)).toBe(false);
    // 账本落库可查
    const c = await app.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const ledger = await c.query(`SELECT fire_minute FROM trigger_fires WHERE trigger_id=$1`, [id]);
      expect(ledger.rows.length).toBe(1);
    } finally { c.release(); }
    // 事件化留痕可查
    const q = await import("../workdata/recall.js");
    for (const action of ["trigger.upsert", "trigger.disable", "trigger.enable", "trigger.fired"]) {
      const page = await q.searchEvents(app, scope, { action }, { limit: 5 });
      expect(page.events.length).toBeGreaterThan(0);
    }
  });
});
