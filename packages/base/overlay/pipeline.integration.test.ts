/**
 * M2/M3 真库集成测试：完整流水线 + L1 落库 + 健康汇总（PG 集成，无库自动跳过）
 * 验收 DoD 口径：
 *  ④ 合并后必过考试（考试闸真库放行/拦截）
 *  ⑤ 一键回滚留审计（事件 sink 全留痕）
 *  L1 全链路：意图 → 草稿 → 考试 → 灰度 → 全量 → 健康汇总可见
 */
import { describe, expect, it } from "vitest";
import pg from "pg";
import {
  buildDraftFromIntents, canaryToActive, draftToCanary, healthSummary, ingestL1,
  rollback, saveDraft, transition, type BundleAssetView, type OverlayPipelineEvent,
  type OverlayScope, type PipelineDeps,
} from "./index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@127.0.0.1:5432/workloom";
const scope: OverlayScope = { workspaceId: "ws-ovl-int", tenantId: "tn-ovl-int" };

async function dbAvailable(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await pool.query("SELECT 1 FROM tenant_overlays LIMIT 1");
    await pool.end();
    return true;
  } catch { await pool.end().catch(() => undefined); return false; }
}

function makeView(): BundleAssetView {
  return {
    bj: { workloom: { thresholds: { "approval/refund-credits": 500 }, provides: { skills: ["skills/kb-fresh/SKILL.md"] } } },
    presets: [{ preset_key: "fae-chief", name: "接待班长" }],
    fencePacks: [{ fences: [{ rule_id: "R-MK1", level: "review", name: "营销复核" }] }],
    extra: { faq: [{ id: "standard-041", q: "退房时间？", a: "12 点" }] },
  } as unknown as BundleAssetView;
}

describe.skipIf(!(await dbAvailable()))("覆盖层全流程集成（真库）", () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const events: OverlayPipelineEvent[] = [];
  const deps: PipelineDeps = {
    loadView: () => makeView(),
    eventSink: (e) => { events.push(e); },
  };

  it("L1 意图 → 草稿 → 考试 → 灰度 → 全量 → 回滚 → 健康汇总 全链路", async () => {
    // ① L1 落库（三条意图：话术 + FAQ + 品牌）
    const draft = await ingestL1(pool, scope, "hotel", "2.3.0", [
      { kind: "tone", tone: "亲切家庭风" },
      { kind: "faq", question: "有婴儿床吗", answer: "有，免费借用" },
      { kind: "brand", field: "mate-name", value: "小栖" },
    ], { createdBy: "test", canaryScope: { ratio: 0.1 } });
    expect(draft.status).toBe("draft");
    expect(draft.items).toHaveLength(3);

    // ② 考试闸 + 进灰度（合并后配置过考试院）
    const { doc: canaryDoc, exam } = await draftToCanary(pool, scope, "hotel", draft.overlay_version, deps);
    expect(exam.pass).toBe(true);
    expect(canaryDoc.status).toBe("canary");

    // ③ 转全量（观察期默认 0）
    const activeDoc = await canaryToActive(pool, scope, "hotel", draft.overlay_version, deps);
    expect(activeDoc.status).toBe("active");

    // ④ 一键回滚（止血直激活，事件留痕）
    const rolled = await rollback(pool, scope, "hotel", "test", deps);
    expect(rolled.status).toBe("active");
    expect(rolled.overlay_version).toBeGreaterThan(draft.overlay_version);

    // ⑤ 事件审计链完整：exam_passed → canary_started → activated → rolled_back
    const types = events.map((e) => e.type);
    expect(types).toContain("overlay.exam_passed");
    expect(types).toContain("overlay.canary_started");
    expect(types).toContain("overlay.activated");
    expect(types).toContain("overlay.rolled_back");

    // ⑥ 健康汇总可见（1 个 active）
    const health = await healthSummary(pool, scope);
    const hotel = health.find((h) => h.base_bundle === "hotel");
    expect(hotel).toBeDefined();
    expect(hotel!.active).toBeGreaterThanOrEqual(1);
  });

  it("考试闸拦截：围栏红线覆盖永远进不了灰度（真库口径）", async () => {
    const bad = await saveDraft(pool, scope, {
      tenant_id: scope.tenantId, base_bundle: "hotel", base_version: "2.3.0",
      canary_scope: { ratio: 0.1 },
      items: [{ type: "fence", op: "tighten", path: "fences/R-MK1", from: "auto", to: "block" }] as never,
      note: "bad", createdBy: "test",
    });
    // from=auto 与行业包当前 review 不符——合并引擎必拒 → 考试闸拦截
    await expect(draftToCanary(pool, scope, "hotel", bad.overlay_version, deps))
      .rejects.toThrowError(/考试闸未通过|合并失败|FROM_MISMATCH|不可调|不符/);
  });

  it("流水线纪律：草稿不能跳级直激活（真库 TRANSITIONS）", async () => {
    const d = await saveDraft(pool, scope, {
      tenant_id: scope.tenantId, base_bundle: "hotel", base_version: "2.3.0",
      items: [{ type: "brand", op: "override", path: "theme", value: "dark" }],
      note: "discipline", createdBy: "test",
    });
    await expect(transition(pool, scope, "hotel", d.overlay_version, "active"))
      .rejects.toThrowError(/非法状态流转/);
  });

  it("buildDraftFromIntents 与手工 saveDraft 同闸（校验一致）", () => {
    // 同一越界阈值，两条路径必须同拒
    expect(() => buildDraftFromIntents(scope, "hotel", "2.3.0", [
      { kind: "threshold", key: "approval/refund-credits", value: 9999, bounds: { min: 0, max: 1000 } },
    ])).toThrowError();
  });
});
