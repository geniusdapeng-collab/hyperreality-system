/**
 * overlay/hardening.test.ts —— HP-01 租户覆盖层加固回归（审计批次 HP-20260916）
 *
 * 本文件锁定的是审计中确认的 P0/P1 面，不是"功能演示"：
 *  ① 对象图安全：用户可控 path 不得污染原型（__proto__/constructor/prototype）；
 *  ② 写入侧路径闸：不可覆盖路径（账本/红线/积分底层）在 parseOverlay 即拒；
 *  ③ 阈值区间基座权威：覆盖层自带 bounds 只是"申请收窄"，未登记的阈值路径 fail-closed；
 *  ④ rebase 不再按"行业包是否声明默认值"误删阈值定制；
 *  ⑤ 真库：RLS 必须在事务级 GUC 上下文内读写（withOverlayTx），跨租户零泄漏；
 *  ⑥ 真库：并发激活只有一个 active（0035 部分唯一索引 + CAS），并发版本号不冲突。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { OverlayError, parseOverlay, type OverlayDoc, type OverlayItem } from "./model.js";
import { mergeOverlay, thresholdOf, type BundleAssetView } from "./merge.js";
import { detectRebase } from "./rebase.js";
import { buildDraftFromIntents, L1IntakeError } from "./draft-builder.js";
import { loadActiveOverlay, saveDraft, transition, withOverlayTx, type OverlayScope } from "./store.js";

/* ---------------- 单元夹具 ---------------- */

function makeView(): BundleAssetView {
  return {
    bj: {
      name: "hotel",
      workloom: {
        provides: { skills: ["skills/kb-fresh/SKILL.md", "skills/care-outreach/SKILL.md"] },
      },
    },
    presets: [{ preset_key: "fae-chief", name: "接待班长" }],
    fencePacks: [{ fences: [{ rule_id: "R-MK2", level: "review", name: "营销触达" }] }],
    extra: { faq: [{ id: "standard-041", q: "退房时间？", a: "中午 12 点" }] },
  };
}

function rawDoc(items: unknown[], patch: Partial<OverlayDoc> = {}): OverlayDoc {
  return {
    tenant_id: "t-hp01", base_bundle: "hotel", base_version: "2.3.0",
    overlay_version: 1, status: "active", items: items as OverlayItem[], ...patch,
  };
}

function doc(items: unknown[], patch: Partial<OverlayDoc> = {}): OverlayDoc {
  return parseOverlay(rawDoc(items, patch));
}

/* ---------------- ① 对象图安全 ---------------- */

describe("HP-01 ① 覆盖路径不得触碰原型链", () => {
  it("parseOverlay 在写入侧拒绝 __proto__ / constructor / prototype 段", () => {
    for (const path of ["__proto__/polluted", "service-front/__proto__/x", "constructor/prototype/y"]) {
      expect(() => doc([{ type: "persona", op: "override", path, value: "x" }]))
        .toThrowError(/原型链/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("绕过校验层伪造的文档：合并引擎仍拒绝，且 Object.prototype 不被污染", () => {
    const forged = rawDoc([{ type: "persona", op: "override", path: "__proto__/polluted", value: "yes" }]);
    expect(() => mergeOverlay(makeView(), forged)).toThrowError(OverlayError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const forgedThreshold = rawDoc([
      { type: "threshold", op: "override", path: "__proto__/polluted", value: 1, bounds: { min: 0, max: 1 } },
    ]);
    expect(() => mergeOverlay(makeView(), forgedThreshold)).toThrowError(OverlayError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/* ---------------- ② 写入侧路径闸 ---------------- */

describe("HP-01 ② 不可覆盖路径在写入侧即拒", () => {
  it("账本/积分底层/同步机制/平台红线路径 parseOverlay 直接拒绝", () => {
    for (const path of ["ledger/rules", "credits/pool-rate", "sync/base-scope", "fences/R-PL4"]) {
      expect(() => doc([{ type: "persona", op: "override", path, value: "x" }]))
        .toThrowError(/不可覆盖/);
    }
  });
});

/* ---------------- ③ 阈值区间的基座权威 ---------------- */

describe("HP-01 ③ 阈值区间由基座红线目录裁决", () => {
  it("覆盖层自带超大区间被拒（不能自我授权放宽）", () => {
    expect(() => mergeOverlay(makeView(), doc([{
      type: "threshold", op: "override", path: "approval/refund-credits",
      value: 5_000_000, bounds: { min: 0, max: 10_000_000 },
    }]))).toThrowError(/不得放宽|超出基座允许区间/);
  });

  it("未登记的阈值路径一律拒绝（fail-closed）", () => {
    expect(() => mergeOverlay(makeView(), doc([{
      type: "threshold", op: "override", path: "secret/whatever",
      value: 1, bounds: { min: 0, max: 2 },
    }]))).toThrowError(/未在基座红线目录|不可覆盖/);
  });

  it("在基座区间内收窄可用，审计留痕带基座允许区间", () => {
    const r = mergeOverlay(makeView(), doc([{
      type: "threshold", op: "override", path: "approval/refund-credits",
      value: 500, bounds: { min: 100, max: 1000 },
    }]));
    expect(thresholdOf(r.assets, "approval/refund-credits")).toBe(500);
    expect(r.audit.find((a) => a.action === "threshold.override")?.detail).toContain("基座允许 [0, 2000]");
  });

  it("行业包显式声明更严区间时取交集（更严者胜）", () => {
    const view = makeView();
    (view.bj.workloom as Record<string, unknown>).threshold_bounds = {
      "approval/refund-credits": { min: 100, max: 300 },
    };
    expect(() => mergeOverlay(view, doc([{
      type: "threshold", op: "override", path: "approval/refund-credits",
      value: 200, bounds: { min: 0, max: 1000 },
    }]))).toThrowError(/不得放宽/);
    const tightened = mergeOverlay(view, doc([{
      type: "threshold", op: "override", path: "approval/refund-credits",
      value: 200, bounds: { min: 100, max: 300 },
    }]));
    expect(thresholdOf(tightened.assets, "approval/refund-credits")).toBe(200);
  });

  it("biz/ 前缀租户营业参数受基座上限约束", () => {
    expect(() => mergeOverlay(makeView(), doc([{
      type: "threshold", op: "override", path: "biz/room-upgrade-price",
      value: 200_000, bounds: { min: 0, max: 1_000_000 },
    }]))).toThrowError(/不得放宽/);
    const ok = mergeOverlay(makeView(), doc([{
      type: "threshold", op: "override", path: "biz/room-upgrade-price",
      value: 200, bounds: { min: 0, max: 1000 },
    }]));
    expect(thresholdOf(ok.assets, "biz/room-upgrade-price")).toBe(200);
  });
});

/* ---------------- ④ rebase 不再误删阈值定制 ---------------- */

describe("HP-01 ④ rebase 的阈值裁决", () => {
  it("行业包未声明阈值默认值时，定制仍判 compatible（按基座允许区间裁决）", () => {
    const active = doc([{
      type: "threshold", op: "override", path: "approval/refund-credits",
      value: 800, bounds: { min: 0, max: 1000 },
    }]);
    const report = detectRebase(active, makeView(), "2.4.0");
    expect(report.autoFallback).toBe(0);
    expect(report.compatible).toBe(1);
    expect(report.rebasedItems).toHaveLength(1);
  });

  it("允许区间被撤销的历史定制判 auto_fallback（不静默保留无效项）", () => {
    const legacy = rawDoc([{
      type: "threshold", op: "override", path: "legacy/param",
      value: 1, bounds: { min: 0, max: 2 },
    }]);
    const report = detectRebase(legacy, makeView(), "2.4.0");
    expect(report.autoFallback).toBe(1);
    expect(report.rebasedItems).toHaveLength(0);
  });

  it("红线收紧导致申请区间越界 → 待裁决（不静默改动）", () => {
    const active = doc([{
      type: "threshold", op: "override", path: "approval/refund-credits",
      value: 800, bounds: { min: 0, max: 1000 },
    }]);
    const tightened = makeView();
    (tightened.bj.workloom as Record<string, unknown>).threshold_bounds = {
      "approval/refund-credits": { min: 0, max: 300 },
    };
    const report = detectRebase(active, tightened, "2.4.0");
    expect(report.needsDecision).toBe(1);
    expect(report.autoFallback).toBe(0);
  });
});

/* ---------------- ④b L1 录入通道：阈值意图写入前对齐基座红线 ---------------- */

describe("HP-01 ④b L1 阈值意图的基座对齐", () => {
  const scope: OverlayScope = { workspaceId: "ws-hp01-l1", tenantId: "tn-hp01-l1" };

  it("申请的区间比基座宽时自动收窄到基座允许区间", () => {
    const draft = buildDraftFromIntents(scope, "hotel", "2.3.0", [
      { kind: "threshold", key: "approval/refund-credits", value: 800, bounds: { min: 0, max: 100_000 } },
    ]);
    const item = draft.items[0] as Extract<OverlayItem, { type: "threshold" }>;
    expect(item.bounds).toEqual({ min: 0, max: 2000 });
    expect(item.value).toBe(800);
  });

  it("申请值本身越界即拒（录入侧早拒，不留给考试闸）", () => {
    expect(() => buildDraftFromIntents(scope, "hotel", "2.3.0", [
      { kind: "threshold", key: "approval/refund-credits", value: 500_000, bounds: { min: 0, max: 1_000_000 } },
    ])).toThrowError(L1IntakeError);
  });

  it("未登记的阈值键在录入侧即拒", () => {
    expect(() => buildDraftFromIntents(scope, "hotel", "2.3.0", [
      { kind: "threshold", key: "secret/toggle", value: 1, bounds: { min: 0, max: 2 } },
    ])).toThrowError(/未在基座红线目录登记/);
  });
});

/* ---------------- ⑤⑥ 真库：RLS / 单 active / 并发 ---------------- */

const APP_URL = process.env.DATABASE_APP_URL;
const OWNER_URL = process.env.DATABASE_URL;
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(APP_URL) && Boolean(OWNER_URL);

describe.skipIf(!RUN_DB)("HP-01 ⑤⑥ 真库：RLS 事务上下文与单 active", () => {
  const scope: OverlayScope = { workspaceId: "ws-hp01-hardening", tenantId: "tn-hp01-hardening" };
  const otherScope: OverlayScope = { workspaceId: "ws-hp01-other", tenantId: "tn-hp01-other" };
  const bundle = "hotel";
  let appPool: pg.Pool;
  let ownerPool: pg.Pool;

  beforeAll(async () => {
    appPool = new pg.Pool({ connectionString: APP_URL, connectionTimeoutMillis: 3000 });
    ownerPool = new pg.Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 3000 });
    for (const s of [scope, otherScope]) {
      await ownerPool.query("DELETE FROM tenant_overlay_snapshots WHERE workspace_id=$1", [s.workspaceId]);
      await ownerPool.query("DELETE FROM tenant_overlays WHERE workspace_id=$1", [s.workspaceId]);
    }
  });

  afterAll(async () => {
    for (const s of [scope, otherScope]) {
      await ownerPool?.query("DELETE FROM tenant_overlay_snapshots WHERE workspace_id=$1", [s.workspaceId]).catch(() => undefined);
      await ownerPool?.query("DELETE FROM tenant_overlays WHERE workspace_id=$1", [s.workspaceId]).catch(() => undefined);
    }
    await Promise.all([appPool?.end(), ownerPool?.end()]);
  });

  const baseInput = (note: string) => ({
    tenant_id: scope.tenantId, base_bundle: bundle, base_version: "2.3.0",
    items: [{ type: "persona", op: "override", path: "service-front/tone", value: "亲切家庭风" }] as OverlayItem[],
    note, createdBy: "MEM-HP01",
  });

  it("池直查（无事务级 GUC）在 RLS 下读不到任何行；withOverlayTx 内可正常读写", async () => {
    // 直接走应用池（跳过 withOverlayTx）——这正是修复前 overlay-router 的做法：
    // RLS 打开后 GUC 为空 → 恒 0 行（fail-closed），功能实际不可用。
    const blind = await appPool.query("SELECT count(*)::int AS c FROM tenant_overlays");
    expect(blind.rows[0]!.c).toBe(0);

    const saved = await withOverlayTx(appPool, scope, (client) => saveDraft(client, scope, baseInput("RLS 上下文")));
    expect(saved.overlay_version).toBe(1);

    const seen = await withOverlayTx(appPool, scope, (client) => loadActiveOverlay(client, scope, bundle));
    expect(seen).toBeNull(); // draft 未激活

    // 跨租户：另一个工作区看同一行业包，零命中
    const cross = await withOverlayTx(appPool, otherScope, (client) => loadActiveOverlay(client, otherScope, bundle));
    expect(cross).toBeNull();

    // 池上直接按 workspace 过滤也读不到（GUC 缺失 → 策略恒 false）
    const stillBlind = await appPool.query("SELECT count(*)::int AS c FROM tenant_overlays WHERE workspace_id=$1", [scope.workspaceId]);
    expect(stillBlind.rows[0]!.c).toBe(0);
  });

  it("并发创建草稿：版本号唯一且不报唯一约束错", async () => {
    const created = await Promise.all([0, 1, 2, 3].map((i) =>
      withOverlayTx(appPool, scope, (client) => saveDraft(client, scope, baseInput(`并发草稿 ${i}`)))));
    const versions = created.map((d) => d.overlay_version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("并发激活：任何时刻只有一个 active（部分唯一索引 + CAS）", async () => {
    const a = await withOverlayTx(appPool, scope, (client) =>
      saveDraft(client, scope, { ...baseInput("灰度 A"), canary_scope: { ratio: 0.1 } }));
    const b = await withOverlayTx(appPool, scope, (client) =>
      saveDraft(client, scope, { ...baseInput("灰度 B"), canary_scope: { ratio: 0.2 } }));
    await withOverlayTx(appPool, scope, (client) => transition(client, scope, bundle, a.overlay_version, "canary"));
    await withOverlayTx(appPool, scope, (client) => transition(client, scope, bundle, b.overlay_version, "canary"));

    const results = await Promise.allSettled([
      withOverlayTx(appPool, scope, (client) => transition(client, scope, bundle, a.overlay_version, "active")),
      withOverlayTx(appPool, scope, (client) => transition(client, scope, bundle, b.overlay_version, "active")),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    const active = await withOverlayTx(appPool, scope, (client) => client.query<{ overlay_version: number }>(
      `SELECT overlay_version FROM tenant_overlays
        WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND status='active'`,
      [scope.workspaceId, scope.tenantId, bundle],
    ));
    expect(active.rows).toHaveLength(1);

    // 0035 部分唯一索引必须存在（数据库层兜底，而不是只靠应用层自觉）
    const idx = await withOverlayTx(appPool, scope, (client) => client.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname='uq_tenant_overlays_one_active'",
    ));
    expect(idx.rows).toHaveLength(1);
  });

  it("回滚留下快照并以新版本号激活", async () => {
    const rolled = await withOverlayTx(appPool, scope, (client) =>
      (async () => {
        const { rollbackToLatestSnapshot } = await import("./store.js");
        return rollbackToLatestSnapshot(client, scope, bundle, "MEM-HP01");
      })());
    expect(rolled.status).toBe("active");
    const active = await withOverlayTx(appPool, scope, (client) => loadActiveOverlay(client, scope, bundle));
    expect(active?.overlay_version).toBe(rolled.overlay_version);
  });
});
