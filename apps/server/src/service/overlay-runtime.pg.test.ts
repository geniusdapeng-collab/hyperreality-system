// 覆盖层运行时接线（HP-01 审计）：生产 deps 必须把 overlay.* 事件写进账本，且与状态变更同一事务；
// 考试闸拒收的事件必须在独立事务补写（不能被状态回滚带走）。
//
// 修复前的生产 deps 只有 loadView、没有 eventSink → 事件被静默丢弃，
// 「一键回滚留审计」只剩注释。本文件是这条接线的回归门。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  PipelineError, canaryToActive, draftToCanary, rollback, saveDraft, withOverlayTx,
  type BundleAssetView, type OverlayItem, type OverlayScope,
} from "@workloom/base/overlay";
import { overlayPipelineDeps, recordOverlayEventInOwnTx } from "./overlay-runtime.js";

const APP_URL = process.env.DATABASE_APP_URL;
const OWNER_URL = process.env.DATABASE_URL;
const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(APP_URL) && Boolean(OWNER_URL);

describe.skipIf(!RUN_DB)("覆盖层流水线事件入账本（生产 deps 接线）", () => {
  // 账本 append-only（biz_events 禁 UPDATE/DELETE），因此每次运行用独立工作区，
  // 断言只覆盖本次运行写入的事件，避免多次运行互相污染。
  const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const scope: OverlayScope = { workspaceId: `ws-hp01-ledger-${runTag}`, tenantId: `tn-hp01-ledger-${runTag}` };
  const bundle = "hotel";
  let appPool: pg.Pool;
  let ownerPool: pg.Pool;

  const view = (): BundleAssetView => ({
    bj: { workloom: { provides: { skills: ["skills/kb-fresh/SKILL.md"] } } },
    presets: [{ preset_key: "fae-chief", name: "接待班长" }],
    fencePacks: [{ fences: [{ rule_id: "R-MK1", level: "review", name: "营销内容人工复核" }] }],
    extra: { faq: [{ id: "a1", q: "退房时间？", a: "中午 12 点" }] },
  });

  const ledgerActions = async (client: pg.PoolClient): Promise<string[]> => {
    const r = await client.query<{ action: string }>(
      `SELECT payload->'decision'->>'action' AS action FROM biz_events
        WHERE workspace_id=$1 ORDER BY seq`,
      [scope.workspaceId],
    );
    return r.rows.map((row) => row.action);
  };

  const draftInput = (items: OverlayItem[], note: string) => ({
    tenant_id: scope.tenantId, base_bundle: bundle, base_version: "2.3.0",
    canary_scope: { ratio: 0.1 }, items, note, createdBy: "MEM-HP01",
  });

  beforeAll(async () => {
    appPool = new pg.Pool({ connectionString: APP_URL, connectionTimeoutMillis: 3000 });
    ownerPool = new pg.Pool({ connectionString: OWNER_URL, connectionTimeoutMillis: 3000 });
    await ownerPool.query("DELETE FROM tenant_overlay_snapshots WHERE workspace_id=$1", [scope.workspaceId]);
    await ownerPool.query("DELETE FROM tenant_overlays WHERE workspace_id=$1", [scope.workspaceId]);
  });

  afterAll(async () => {
    await ownerPool?.query("DELETE FROM tenant_overlay_snapshots WHERE workspace_id=$1", [scope.workspaceId]).catch(() => undefined);
    await ownerPool?.query("DELETE FROM tenant_overlays WHERE workspace_id=$1", [scope.workspaceId]).catch(() => undefined);
    await Promise.all([appPool?.end(), ownerPool?.end()]);
  });

  it("草稿→灰度→全量→回滚：四条 overlay.* 事件按序落账本", async () => {
    const actions = await withOverlayTx(appPool, scope, async (client) => {
      const deps = overlayPipelineDeps(() => view(), client, scope, "MEM-HP01");
      const draft = await saveDraft(client, scope, draftInput(
        [{ type: "persona", op: "override", path: "service-front/tone", value: "亲切家庭风" }], "账本接线",
      ));
      await draftToCanary(client, scope, bundle, draft.overlay_version, deps);
      await canaryToActive(client, scope, bundle, draft.overlay_version, deps);
      await rollback(client, scope, bundle, "MEM-HP01", deps);
      return ledgerActions(client);
    });
    expect(actions).toEqual([
      "overlay.exam_passed", "overlay.canary_started", "overlay.activated", "overlay.rolled_back",
    ]);
  });

  it("考试闸拒收：状态不推进，且拒收事件独立留痕", async () => {
    const version = await withOverlayTx(appPool, scope, async (client) => {
      const draft = await saveDraft(client, scope, draftInput(
        [{ type: "fence", op: "tighten", path: "fences/R-NOPE", from: "review", to: "block" }], "考试必挂",
      ));
      return draft.overlay_version;
    });

    const failure = await withOverlayTx(appPool, scope, (client) =>
      draftToCanary(client, scope, bundle, version, overlayPipelineDeps(() => view(), client, scope, "MEM-HP01")))
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(PipelineError);

    await recordOverlayEventInOwnTx(appPool, scope, "MEM-HP01", {
      type: "overlay.exam_failed", tenant_id: scope.tenantId, base_bundle: bundle,
      overlay_version: version, detail: { reason: (failure as Error).message },
    });

    const actions = await withOverlayTx(appPool, scope, (client) => ledgerActions(client));
    expect(actions).toContain("overlay.exam_failed");

    const state = await withOverlayTx(appPool, scope, (client) => client.query<{ status: string }>(
      "SELECT status FROM tenant_overlays WHERE workspace_id=$1 AND overlay_version=$2",
      [scope.workspaceId, version],
    ));
    expect(state.rows[0]?.status).toBe("draft");
  });
});
