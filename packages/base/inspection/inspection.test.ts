/**
 * B10 巡检测试：探针/同源聚合/严重度升级/去重键（纯函数）+
 * PG 集成：只读前置断言（L9.1）/ 异常分级事件（F9.2）/ 高优推送（G3）/ 幂等去重（L9.3）
 *        / 失败必出事件（L9.2/E9.1）/ 一键派单回链（F9.3/E9.3）/ 状态条投影（F9.4）
 */
import { describe, expect, it } from "vitest";
import {
  aggregateBySource,
  InspectionConfigurationError,
  runChecks,
  type Finding,
  type InspectionAdapter,
  type InspectionSnapshot,
  type Probe,
} from "./checks.js";
import { anomalyDedupeKey } from "./scan.js";
import { escalateSeverity } from "./dispatch.js";
import { ATTENTION_MAX_ITEMS } from "./status.js";

/** 唯一后缀：同一数据库可重跑（当日幂等去重不会跨轮吞掉断言对象） */
const RUN = Date.now().toString(36);

const TEST_CHECKS = [{ id: "chk-runtime-signal", kind: "test.runtime-signal", name: "运行信号" }] as const;
const runtimeSignalProbe: Probe = (check, input) => {
  const signals = Array.isArray(input.signals)
    ? input.signals as Array<{ id: string; state: "ok" | "medium" | "high" }>
    : null;
  if (!signals) {
    return [{ checkId: check.id, status: "nodata", summary: "无测试信号", objectType: "test-signal", source: "test.runtime-signal" }];
  }
  return signals.map((signal): Finding => signal.state === "ok"
    ? { checkId: check.id, status: "ok", summary: "测试信号正常", objectType: "test-signal", objectId: signal.id, source: "test.runtime-signal" }
    : { checkId: check.id, status: "anomaly", severity: signal.state, summary: "测试信号异常", objectType: "test-signal", objectId: signal.id, source: "test.runtime-signal" });
};
const TEST_ADAPTER: InspectionAdapter = {
  id: "test.inspection-v1",
  presetKey: "inspection-agent",
  checks: TEST_CHECKS,
  probes: { "test.runtime-signal": runtimeSignalProbe },
};
const snapshot: InspectionSnapshot = {
  signals: [
    { id: `ok-${RUN}`, state: "ok" },
    { id: `medium-${RUN}`, state: "medium" },
    { id: `high-${RUN}`, state: "high" },
  ],
};

describe("巡检通用执行器（F9.1）", () => {
  it("只执行调用方显式登记的检项与探针", () => {
    const findings = runChecks(TEST_CHECKS, snapshot, TEST_ADAPTER.probes);
    expect(findings).toHaveLength(3);
    expect(findings.find((finding) => finding.objectId === `high-${RUN}`)).toMatchObject({ status: "anomaly", severity: "high" });
    expect(findings.find((finding) => finding.objectId === `medium-${RUN}`)).toMatchObject({ status: "anomaly", severity: "medium" });
    expect(findings.find((finding) => finding.objectId === `ok-${RUN}`)).toMatchObject({ status: "ok" });
    expect(runChecks(TEST_CHECKS, {}, TEST_ADAPTER.probes).every((finding) => finding.status === "nodata")).toBe(true);
  });

  it("无行业检项或缺少探针均失败关闭", () => {
    expect(() => runChecks([], {}, {})).toThrow(InspectionConfigurationError);
    expect(() => runChecks(TEST_CHECKS, {}, {})).toThrow(/没有已登记探针/);
  });
});

describe("同源聚合（E9.2）与去重键（L9.3）", () => {
  it("同 source 异常合并为一条摘要，严重度取最高", () => {
    const groups = aggregateBySource(runChecks(TEST_CHECKS, snapshot, TEST_ADAPTER.probes));
    expect(groups.find((group) => group.source === "test.runtime-signal")).toMatchObject({ count: 2, severity: "high" });
  });

  it("去重键稳定：checkId+objectId", () => {
    const f: Finding = { checkId: "chk-runtime-signal", status: "anomaly", severity: "high", summary: "s", objectType: "test-signal", objectId: `signal-${RUN}`, source: "test.runtime-signal" };
    expect(anomalyDedupeKey(f)).toBe(`chk-runtime-signal:signal-${RUN}`);
    expect(anomalyDedupeKey({ ...f, objectId: undefined })).toBe("chk-runtime-signal:-");
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
    const report = await runInspectionScan(app, gw, scope, { adapter: TEST_ADAPTER, snapshot });
    expect(report.ok).toBe(true);
    expect(report.anomalies.filter((a) => !a.deduped)).toHaveLength(2);
    expect(report.notifyEventIds.length).toBeGreaterThanOrEqual(1);
    expect(report.okCount).toBe(1);

    const bar = await inspectionStatusBar(app, scope);
    expect(bar.lastRunAt).not.toBeNull();
    expect(bar.lastRunFailed).toBe(false);
    expect(bar.totalChecks).toBe(report.totalChecks);
    expect(bar.attention.length).toBeLessThanOrEqual(5);
    expect(bar.attention[0]?.severity).toBe("high"); // 按严重度排序
  });

  it("L9.3 幂等：当日重跑同快照，未解决异常不重复写不重复推送", async () => {
    const again = await runInspectionScan(app, gw, scope, { adapter: TEST_ADAPTER, snapshot });
    expect(again.ok).toBe(true);
    expect(again.anomalies.every((a) => a.deduped === true)).toBe(true);
    expect(again.notifyEventIds).toHaveLength(0);
  });

  it("L9.2/E9.1 探针抛错：重试后写 inspect.run.failed 告警（不静默）", async () => {
    const boom = () => { throw new Error("探针被目标平台封禁"); };
    const report = await runInspectionScan(app, gw, scope, {
      snapshot,
      retries: 1,
      adapter: { ...TEST_ADAPTER, probes: { "test.runtime-signal": boom } },
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

  it("未提供已验证行业适配器时失败关闭并留失败事件", async () => {
    const report = await runInspectionScan(app, gw, scope, { adapter: null, retries: 0 });
    expect(report).toMatchObject({ ok: false, totalChecks: 0, okCount: 0, attempts: 1 });
    expect(report.failedEventId).toMatch(/^E-\d+$/);
  });

  it("F9.3 一键派单：异常事件 → 建单回链；重复派单幂等；处理失败升级+转需介入（E9.3）", async () => {
    const ev = await qApp<{ event_id: string }>(
      `SELECT event_id FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action'='inspect.anomaly'
         AND payload->'decision'->'after'->>'dedupeKey'=$2
       ORDER BY seq DESC LIMIT 1`,
      [scope.workspaceId, `chk-runtime-signal:high-${RUN}`],
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
