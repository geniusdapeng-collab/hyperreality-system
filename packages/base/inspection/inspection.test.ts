/**
 * B10 巡检测试：探针/同源聚合/严重度升级/去重键（纯函数）+
 * PG 集成：只读前置断言（L9.1）/ 异常分级事件（F9.2）/ 高优推送（G3）/ 幂等去重（L9.3）
 *        / 失败必出事件（L9.2/E9.1）/ 一键派单回链（F9.3/E9.3）/ 状态条投影（F9.4）
 */
import { describe, expect, it } from "vitest";
import {
  aggregateBySource,
  DEFAULT_CHECKS,
  runChecks,
  type Finding,
  type InspectionSnapshot,
} from "./checks.js";
import { anomalyDedupeKey } from "./scan.js";
import { escalateSeverity } from "./dispatch.js";
import { ATTENTION_MAX_ITEMS } from "./status.js";

/** 唯一后缀：同一数据库可重跑（当日幂等去重不会跨轮吞掉断言对象） */
const RUN = Date.now().toString(36);

const snapshot: InspectionSnapshot = {
  channels: [
    { channel: `携程-${RUN}`, price: 480, parity: true, status: "online" },
    { channel: `美团-${RUN}`, price: 480, parity: false, status: "online" },
    { channel: `飞猪-${RUN}`, status: "offline" },
  ],
  stateUnits: [
    { unit: `标准单元-${RUN}`, synced: true },
    { unit: `豪华单元-${RUN}`, synced: false },
  ],
  reviews: [{ id: `rv-${RUN}`, channel: "携程", score: 2 }],
  violations: [],
};

describe("巡检探针（F9.1 内置四检，确定性）", () => {
  it("渠道价格：offline 高优 / parity=false 中优 / 正常项", () => {
    const findings = runChecks(DEFAULT_CHECKS, snapshot);
    const price = findings.filter((f) => f.checkId === "chk-channel-price");
    expect(price).toHaveLength(3);
    expect(price.find((f) => f.objectId === `飞猪-${RUN}`)).toMatchObject({ status: "anomaly", severity: "high" });
    expect(price.find((f) => f.objectId === `美团-${RUN}`)).toMatchObject({ status: "anomaly", severity: "medium" });
    expect(price.find((f) => f.objectId === `携程-${RUN}`)).toMatchObject({ status: "ok" });
  });

  it("差评 ≤3 分高优；违规列表空=正常；快照缺项=nodata 不计正常", () => {
    const findings = runChecks(DEFAULT_CHECKS, snapshot);
    expect(findings.find((f) => f.objectId === `rv-${RUN}`)).toMatchObject({ status: "anomaly", severity: "high" });
    expect(findings.find((f) => f.checkId === "chk-violation")).toMatchObject({ status: "ok" });
    const nodata = runChecks(DEFAULT_CHECKS, {});
    expect(nodata.every((f) => f.status === "nodata")).toBe(true);
  });
});

describe("同源聚合（E9.2）与去重键（L9.3）", () => {
  it("同 source 异常合并为一条摘要，严重度取最高", () => {
    const groups = aggregateBySource(runChecks(DEFAULT_CHECKS, snapshot));
    const priceGroup = groups.find((g) => g.source === "channel_price");
    expect(priceGroup).toMatchObject({ count: 2, severity: "high" });
    expect(groups.find((g) => g.source === "review")).toMatchObject({ count: 1, severity: "high" });
    expect(groups.find((g) => g.source === "violation")).toBeUndefined(); // 无异常不聚合
  });

  it("去重键稳定：checkId+objectId", () => {
    const f: Finding = { checkId: "chk-review", status: "anomaly", severity: "high", summary: "s", objectType: "review", objectId: `rv-${RUN}`, source: "review" };
    expect(anomalyDedupeKey(f)).toBe(`chk-review:rv-${RUN}`);
    expect(anomalyDedupeKey({ ...f, objectId: undefined })).toBe("chk-review:-");
  });
});

describe("严重度升级（E9.3）与关注区上限（F9.2）", () => {
  it("low→medium→high，high 保持 high", () => {
    expect(escalateSeverity("low")).toBe("medium");
    expect(escalateSeverity("medium")).toBe("high");
    expect(escalateSeverity("high")).toBe("high");
  });
  it("首页需要关注区最多 5 条", () => {
    expect(ATTENTION_MAX_ITEMS).toBe(5);
  });
});

/* ---------- PG 集成（RUN_DB_TESTS=1 时跑；复用 migrate+seed 后的演示库） ---------- */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("巡检 PG 集成（M9 铁律）", async () => {
  const pg = await import("pg");
  const { runInspectionScan, inspectionStatusBar, dispatchFromAnomaly, resolveAnomaly } = await import("./index.js");
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


  it("L9.1 只读前置通过 + F9.2 异常分级事件 + G3 高优推送 + F9.4 状态条", async () => {
    const report = await runInspectionScan(app, gw, scope, { snapshot });
    expect(report.ok).toBe(true);
    expect(report.anomalies.filter((a) => !a.deduped)).toHaveLength(4); // 飞猪/美团/豪华单元/差评
    expect(report.notifyEventIds.length).toBeGreaterThanOrEqual(2); // channel_price 源 + review 源各一条摘要
    expect(report.okCount).toBe(3); // 携程/标准单元/违规

    const bar = await inspectionStatusBar(app, scope);
    expect(bar.lastRunAt).not.toBeNull();
    expect(bar.lastRunFailed).toBe(false);
    expect(bar.totalChecks).toBe(report.totalChecks);
    expect(bar.attention.length).toBeLessThanOrEqual(5);
    expect(bar.attention[0]?.severity).toBe("high"); // 按严重度排序
  });

  it("L9.3 幂等：当日重跑同快照，未解决异常不重复写不重复推送", async () => {
    const again = await runInspectionScan(app, gw, scope, { snapshot });
    expect(again.ok).toBe(true);
    expect(again.anomalies.every((a) => a.deduped === true)).toBe(true);
    expect(again.notifyEventIds).toHaveLength(0);
  });

  it("L9.2/E9.1 探针抛错：重试后写 inspect.run.failed 告警（不静默）", async () => {
    const boom = () => { throw new Error("探针被目标平台封禁"); };
    const report = await runInspectionScan(app, gw, scope, {
      snapshot,
      retries: 1,
      probes: { channel_price: boom, state_sync: boom, review: boom, violation: boom },
    });
    expect(report.ok).toBe(false);
    expect(report.attempts).toBe(2);
    expect(report.failedEventId).toMatch(/^E-\d+$/);
    const r = await qApp(
      `SELECT payload->'decision'->'after'->>'level' AS level FROM biz_events WHERE event_id=$1`,
      [report.failedEventId],
    );
    expect(r.rows[0]?.level).toBe("p0");
  });

  it("F9.3 一键派单：异常事件 → 建单回链；重复派单幂等；处理失败升级+转需介入（E9.3）", async () => {
    const ev = await qApp<{ event_id: string }>(
      `SELECT event_id FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action'='inspect.anomaly'
         AND payload->'decision'->'after'->>'dedupeKey'=$2
       ORDER BY seq DESC LIMIT 1`,
      [scope.workspaceId, `chk-review:rv-${RUN}`],
    );
    const anomalyId = ev.rows[0]!.event_id;

    const d1 = await dispatchFromAnomaly(app, gw, scope, { anomalyEventId: anomalyId, presetKey: "review-agent", by: "MEM-001" });
    expect(d1.deduped).toBe(false);
    expect(d1.threadId).toMatch(/^T-\d+$/);
    const th = await qApp(`SELECT status, agent_id FROM threads WHERE id=$1`, [d1.threadId]);
    expect(th.rows[0]).toMatchObject({ status: "queued", agent_id: "review-agent" });

    const d2 = await dispatchFromAnomaly(app, gw, scope, { anomalyEventId: anomalyId, presetKey: "review-agent", by: "MEM-001" });
    expect(d2.deduped).toBe(true);
    expect(d2.threadId).toBe(d1.threadId); // 不重复建单

    const r1 = await resolveAnomaly(app, gw, scope, { anomalyEventId: anomalyId, threadId: d1.threadId, ok: false, by: "MEM-001", note: "回复被渠道驳回" });
    expect(r1.deduped).toBe(false);
    expect(r1.escalatedTo).toBe("high"); // high 保持 high 且转需介入
    const r2 = await resolveAnomaly(app, gw, scope, { anomalyEventId: anomalyId, threadId: d1.threadId, ok: false, by: "MEM-001" });
    expect(r2.deduped).toBe(true); // 重复回链只处理首次

    // 回链后状态条不再点名该异常
    const bar = await inspectionStatusBar(app, scope);
    expect(bar.attention.find((a) => a.eventId === anomalyId)).toBeUndefined();
  });
});
