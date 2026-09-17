/**
 * publish-rpa 测试（内存 mock DB + fake BrowserDriver，不依赖真实 Postgres/Playwright）：
 *  - G9 围栏未放行（review/block）→ 适配器不执行，任务挂起 pending_review
 *  - 单账号日上限（默认 5）→ 退回 pending 等次日
 *  - 执行失败/未登录 → 挂起转人工（status=manual）
 *  - 成功路径：真实 douyin 适配器骨架 + fake driver → 回执落事件
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { JudgeVerdict } from "../fence-engine/judge.js";
import { createDouyinAdapter } from "./adapters/douyin.js";
import { createTiktokAdapter } from "./adapters/tiktok.js";
import type { BrowserDriver, PublishAdapter } from "./adapters/base.js";
import { DAILY_LIMIT_DEFAULT, runPublishTask, shanghaiDayBounds, type RunnerDeps } from "./runner.js";

/* ================= 内存 mock DB ================= */

type Row = Record<string, any>;

class MockDb {
  tasks: Row[] = [];
  events: Array<{ seq: number; event_id: string; hash: string; payload: any }> = [];
  private seq = 8800;

  query(sql: string, params: any[] = []): { rows: Row[]; rowCount: number } {
    const s = sql.replace(/\s+/g, " ").trim();
    const ok = { rows: [], rowCount: 0 };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return ok;
    if (s.includes("set_config") || s.includes("pg_advisory")) return ok;

    // ---- biz_events（workdata events.ts 写入段） ----
    if (/FROM biz_events WHERE tenant_id = \$1 AND event_id = \$2/.test(s)) {
      const e = this.events.find((x) => x.event_id === params[1]);
      return { rows: e ? [{ seq: String(e.seq), hash: e.hash }] : [], rowCount: e ? 1 : 0 };
    }
    if (/FROM biz_events WHERE tenant_id = \$1( AND workspace_id = \$\d+)? ORDER BY seq DESC/.test(s)) {
      const tail = this.events[this.events.length - 1];
      return { rows: tail ? [{ seq: String(tail.seq), hash: tail.hash }] : [], rowCount: tail ? 1 : 0 };
    }
        // P0-3 契约：event_id 由全局序列分配——mock nextval 返回递增计数
    if (/nextval\('biz_events_eid_seq'\)/.test(s)) {
      this._eidSeq = (this._eidSeq ?? 9100) + 1;
      return { rows: [{ v: String(this._eidSeq) }], rowCount: 1 };
    }
if (s.includes("append_event_insert")) {
      const seq = ++this.seq;
      this.events.push({ seq, event_id: params[0], hash: params[6], payload: JSON.parse(params[4]) });
      return { rows: [{ seq: String(seq), inserted: true }], rowCount: 1 };
    }

    // ---- publish_tasks ----
    if (/UPDATE publish_tasks SET status='running'/.test(s)) {
      const row = this.tasks.find(
        (x) => x.workspace_id === params[0] && x.id === params[1] && x.status === "pending",
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "running";
      return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE publish_tasks SET status=\$3/.test(s)) {
      const row = this.tasks.find((x) => x.workspace_id === params[0] && x.id === params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = params[2];
      row.error = params[3];
      if (params[4]) row.receipt = JSON.parse(params[4]);
      if (params[2] === "succeeded") row.executed_at = new Date().toISOString();
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT count\(\*\) AS c FROM publish_tasks/.test(s)) {
      const c = this.tasks.filter(
        (x) => x.workspace_id === params[0] && x.account_id === params[1] && x.status === "succeeded"
          && x.executed_at && x.executed_at >= params[2] && x.executed_at <= params[3],
      ).length;
      return { rows: [{ c: String(c) }], rowCount: 1 };
    }

    // ---- 事件号源函数（D29：appendEventInTx 号尾查询，SECURITY DEFINER 全租户口径） ----
    if (/biz_events_max_event_no/.test(s)) {
      return { rows: [{ n: "9900" }], rowCount: 1 };
    }

    throw new Error(`mock 未覆盖 SQL: ${s}`);
  }
}

function poolOf(db: MockDb): pg.Pool {
  const client = {
    query: (sql: string, p?: any[]) => Promise.resolve(db.query(sql, p)),
    release: () => undefined,
  };
  return { connect: async () => client, query: client.query } as unknown as pg.Pool;
}

/* ================= fake BrowserDriver（记录调用，证明围栏未放行时零浏览器动作） ================= */

class FakeDriver implements BrowserDriver {
  calls: Array<{ method: string; args: unknown[] }> = [];
  loggedIn = true;
  private record(method: string, args: unknown[]) { this.calls.push({ method, args }); }
  goto(url: string) { this.record("goto", [url]); return Promise.resolve(); }
  isLoggedIn(url: string, sel: string) { this.record("isLoggedIn", [url, sel]); return Promise.resolve(this.loggedIn); }
  uploadFile(sel: string, path: string) { this.record("uploadFile", [sel, path]); return Promise.resolve(); }
  typeText(sel: string, text: string) { this.record("typeText", [sel, text]); return Promise.resolve(); }
  click(sel: string) { this.record("click", [sel]); return Promise.resolve(); }
  waitForSelector(sel: string) { this.record("waitForSelector", [sel]); return Promise.resolve(true); }
  wait(ms: number) { this.record("wait", [ms]); return Promise.resolve(); }
}

/* ================= 夹具 ================= */

const scope = { tenantId: "tenant-demo", workspaceId: "ws-video" };
const NOW = new Date("2026-08-22T10:00:00+08:00");

function makeTask(over: Partial<Row> = {}): Row {
  return {
    id: "pt-1", workspace_id: scope.workspaceId, platform: "douyin", account_id: "acc-1",
    asset_id: "fc-1", video_path: "/tmp/final.mp4", cover_path: "/tmp/cover.png",
    caption: "夏日新品开箱", tags: ["数码", "开箱"], schedule_at: null,
    status: "pending", receipt: null, error: null, executed_at: null,
    created_by: "publish-operator", created_at: NOW.toISOString(),
    ...over,
  };
}

const AUTO_VERDICT: JudgeVerdict = { level: "auto", impacts: [], triggeredBy: [], evalErrors: [] };
const REVIEW_VERDICT: JudgeVerdict = {
  level: "review",
  impacts: [{ rule_id: "G9", version: "v1", result: "review" }],
  triggeredBy: ["公网发布必审基线"],
  evalErrors: [],
};

function fixture(task: Row, verdict: JudgeVerdict = AUTO_VERDICT, adapter?: PublishAdapter) {
  const db = new MockDb();
  db.tasks.push(task);
  const driver = new FakeDriver();
  const deps: RunnerDeps = {
    adapters: { douyin: adapter ?? createDouyinAdapter() },
    driver,
    fencePrecheck: () => verdict,
    now: NOW,
  };
  return { db, driver, deps, app: poolOf(db), gateway: poolOf(db) };
}

/* ================= 用例 ================= */

describe("执行器：G9 围栏预检", () => {
  it("围栏 review → 适配器不执行（零浏览器动作），任务挂起 pending_review + 留痕", async () => {
    const { db, driver, deps, app, gateway } = fixture(makeTask(), REVIEW_VERDICT);
    const r = await runPublishTask(app, gateway, scope, "pt-1", deps);
    expect(r.kind).toBe("held_fence");
    expect(r.level).toBe("review");
    expect(driver.calls.length).toBe(0); // 未放行不执行
    expect(db.tasks[0]!.status).toBe("pending_review");
    const ev = db.events.find((e) => e.payload.decision.action === "publish.fence_hold")!;
    expect(ev.payload.rule_impact).toEqual([{ rule_id: "G9", version: "v1", result: "review" }]);
    expect(ev.payload.object).toMatchObject({ type: "publish_task", id: "pt-1" });
  });

  it("非 pending 任务幂等退出（not_claimable）", async () => {
    const { deps, app, gateway } = fixture(makeTask({ status: "succeeded" }));
    const r = await runPublishTask(app, gateway, scope, "pt-1", deps);
    expect(r.kind).toBe("not_claimable");
  });
});

describe("执行器：单账号日上限（默认 5）", () => {
  it("当日已 5 条 succeeded → 退回 pending + publish.daily_limit 事件，适配器不执行", async () => {
    const { db, driver, deps, app, gateway } = fixture(makeTask());
    const bounds = shanghaiDayBounds(NOW);
    for (let i = 0; i < DAILY_LIMIT_DEFAULT; i++) {
      db.tasks.push(makeTask({
        id: `pt-done-${i}`, status: "succeeded",
        executed_at: bounds.from.replace("T00:00:00", `T0${i + 1}:00:00`),
      }));
    }
    const r = await runPublishTask(app, gateway, scope, "pt-1", deps);
    expect(r.kind).toBe("held_daily_limit");
    expect(driver.calls.length).toBe(0);
    expect(db.tasks.find((t) => t.id === "pt-1")!.status).toBe("pending");
    expect(db.events.some((e) => e.payload.decision.action === "publish.daily_limit")).toBe(true);
  });

  it("当日 4 条 succeeded → 放行执行", async () => {
    const { db, deps, app, gateway } = fixture(makeTask());
    const bounds = shanghaiDayBounds(NOW);
    for (let i = 0; i < DAILY_LIMIT_DEFAULT - 1; i++) {
      db.tasks.push(makeTask({
        id: `pt-done-${i}`, status: "succeeded",
        executed_at: bounds.from.replace("T00:00:00", `T0${i + 1}:00:00`),
      }));
    }
    const r = await runPublishTask(app, gateway, scope, "pt-1", deps);
    expect(r.kind).toBe("executed");
  });
});

describe("执行器：失败挂起转人工 / 成功回执落事件", () => {
  it("上传异常 → status=manual + publish.failed 事件（异常即挂起转人工）", async () => {
    const failing: PublishAdapter = {
      profile: createDouyinAdapter().profile,
      loginCheck: () => Promise.resolve(true),
      upload: () => Promise.reject(new Error("网络超时")),
      receiptProbe: createDouyinAdapter().receiptProbe,
    };
    const { db, deps, app, gateway } = fixture(makeTask(), AUTO_VERDICT, failing);
    const r = await runPublishTask(app, gateway, scope, "pt-1", deps);
    expect(r.kind).toBe("manual");
    expect(r.error).toBe("网络超时");
    expect(db.tasks[0]!.status).toBe("manual");
    expect(db.tasks[0]!.error).toBe("网络超时");
    expect(db.events.some((e) => e.payload.decision.action === "publish.failed")).toBe(true);
  });

  it("未登录 → LOGIN_REQUIRED 转人工（登录态由用户本人在桌面包完成）", async () => {
    const { db, driver, deps, app, gateway } = fixture(makeTask());
    driver.loggedIn = false;
    const r = await runPublishTask(app, gateway, scope, "pt-1", deps);
    expect(r.kind).toBe("manual");
    expect(r.error).toBe("LOGIN_REQUIRED");
    expect(db.tasks[0]!.status).toBe("manual");
    expect(driver.calls.some((c) => c.method === "uploadFile")).toBe(false);
  });

  it("成功路径：douyin 骨架适配器 + fake driver → succeeded + publish.executed 回执落事件", async () => {
    const { db, driver, deps, app, gateway } = fixture(makeTask());
    const r = await runPublishTask(app, gateway, scope, "pt-1", deps);
    expect(r.kind).toBe("executed");
    expect(r.receipt?.synced).toBe(true);
    expect(db.tasks[0]!.status).toBe("succeeded");
    expect(db.tasks[0]!.receipt).toMatchObject({ platform: "douyin", synced: true });
    // 骨架流程确实走过：传视频 → 传封面 → 文案 → 发布
    const methods = driver.calls.map((c) => c.method);
    expect(methods).toContain("uploadFile");
    expect(methods).toContain("typeText");
    expect(methods).toContain("click");
    const ev = db.events.find((e) => e.payload.decision.action === "publish.executed")!;
    expect(ev.payload.receipt).toMatchObject({ synced: true });
  });

  it("tiktok 占位适配器：未联调恒未登录 → 转人工；upload 直接调用抛「需真实账号环境联调」", async () => {
    const { db, deps, app, gateway } = fixture(makeTask({ platform: "tiktok" }));
    deps.adapters.tiktok = createTiktokAdapter();
    const r = await runPublishTask(app, gateway, scope, "pt-1", deps);
    expect(r.kind).toBe("manual");
    expect(r.error).toBe("LOGIN_REQUIRED");
    expect(db.tasks[0]!.status).toBe("manual");
    await expect(
      createTiktokAdapter().upload(new FakeDriver(), { videoPath: "/v.mp4", caption: "", tags: [] }),
    ).rejects.toThrow("需真实账号环境联调");
  });
});
