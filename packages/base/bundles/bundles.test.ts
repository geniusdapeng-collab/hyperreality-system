/**
 * F11 行业装配测试（P7 舰船换装坞）：
 * 纯函数/文件：草稿骨架 scaffold（五要素 §2.3）/  slug 校验 / 草稿保护移除
 * PG 集成：hotel profile 六槽全装配 + 五项校验全绿（F2.10）/ 校验留痕（P7E3）/
 *          激活幂等（bundle.activate 事件）/ 草稿校验失败拒绝激活（不静默 L9.2）
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BundleError, REGISTERED_PAGES, computeAssembly, listProfileSlugs, scaffoldDraft, removeDraft,
} from "./assembly.js";

describe("草稿骨架与校验（P7E5/§2.3，文件级）", () => {
  it("五要素向导产出草稿骨架：五槽目录 + bundle.json status=draft（不进分发）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    scaffoldDraft({
      slug: "retail", displayName: "零售版", version: "0.1.0",
      changelog: "首版草稿", fenceRef: "hotel-baseline/v1", ownerMemberNo: "MEM-001",
    }, root);
    for (const sub of ["schemas", "presets", "fences", "skills", "ui"]) {
      expect(existsSync(join(root, "retail", sub))).toBe(true);
    }
    const bj = JSON.parse(readFileSync(join(root, "retail/bundle.json"), "utf-8"));
    expect(bj.workloom.status).toBe("draft");
    expect(bj.workloom.owner).toBe("MEM-001");
    // v3.0 第⑦槽：草稿自带 model-policy.yml 骨架（默认继承底座策略）
    expect(existsSync(join(root, "retail", "model-policy.yml"))).toBe(true);
    expect(listProfileSlugs(root)).toEqual(["retail"]);
    // 草稿可移除；移除后注册表为空
    removeDraft("retail", root);
    expect(listProfileSlugs(root)).toEqual([]);
  });

  it("slug 非法拒绝；重复 slug 拒绝（幂等键保护）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    const bad = { slug: "Retail!!", displayName: "x", version: "0.1.0", changelog: "x", fenceRef: "f", ownerMemberNo: "MEM-001" };
    expect(() => scaffoldDraft(bad, root)).toThrowError(BundleError);
    const good = { ...bad, slug: "retail" };
    scaffoldDraft(good, root);
    expect(() => scaffoldDraft(good, root)).toThrowError(/已存在/);
  });

  it("已激活/已分发 profile 不可移除（§2.3 保护）", () => {
    // hotel 非草稿（真实仓库 bundles/hotel）
    expect(() => removeDraft("hotel")).toThrowError(/仅草稿态/);
  });

  it("页面注册表覆盖九大页（UI 用例同步校验基准）", () => {
    expect(REGISTERED_PAGES).toContain("p7");
    expect(REGISTERED_PAGES.length).toBe(9);
  });
});

/* ---------------- PG 集成（同一数据库可重跑） ---------------- */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("行业装配 PG 集成（F2.10 铁律）", async () => {
  const pg = await import("pg");
  const {
    activateBundle, recheckBundle, createBundleDraft,
  } = await import("./assembly.js");
  const app = new pg.default.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gw = new pg.default.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
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


  it("hotel profile：七槽 7/7 已装配 + 起飞前检查单六项全绿（F2.10 + v3.0 第⑦槽）", async () => {
    const p = await computeAssembly(app, scope, "hotel");
    expect(p.status).toBe("active");
    expect(p.filledCount).toBe(7);
    expect(p.checks.map((c) => c.ok)).toEqual([true, true, true, true, true, true]);
    expect(p.canActivate).toBe(true);
    // 班组卡：7 preset 全注册且围栏绑定合法（P7E2）
    expect(p.agents.length).toBe(7);
    expect(p.agents.every((a) => a.fenceOk)).toBe(true);
    // 槽摘要口径：档案 7 字段组 · forbidden 硬约束 2 条；UI 6 页 · 42 条；第⑦槽路由策略合法
    expect(p.slots[0]!.summary).toContain("字段组");
    expect(p.slots[5]!.summary).toBe("6 页 · 状态用例 42 条同步");
    expect(p.slots[6]!.id).toBe("model-policy");
    expect(p.slots[6]!.summary).toContain("model-policy.yml");
  });

  it("校验留痕：recheck 写 bundle.check_run 事件（P7E3 留痕可查）", async () => {
    const r = await recheckBundle(app, gw, scope, "hotel", "MEM-001");
    expect(r.eventId).toMatch(/^E-\d+$/);
    const ev = await qApp(
      `SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE event_id=$1`, [r.eventId]);
    expect(ev.rows[0]!.action).toBe("bundle.check_run");
  });

  it("激活幂等：hotel 已激活仍可重激活并留痕 bundle.activate", async () => {
    const r = await activateBundle(app, gw, scope, "hotel", "MEM-001");
    expect(r.eventId).toMatch(/^E-\d+$/);
    const ind = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    expect(ind.rows[0]!.industry).toBe("hotel");
  });

  it("H-15 第三行业五要素填充即可运行：填满五槽 → 6/6 全绿 → 激活切换 → 底座代码零改动（§2.3/§2.4）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-h15-"));
    // 五要素填充 = 复制 hotel 实物资产作为第三行业草稿内容（演示口径：资产由行业方提供，非底座代码）
    // #25 修复：用 import.meta.url 定位仓库根（原 process.cwd() 相对路径仅在包目录下跑测试才成立）
    const hotelDir = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(hotelDir, join(root, "copycat"), { recursive: true });
    const bjPath = join(root, "copycat", "bundle.json");
    const bj = JSON.parse(readFileSync(bjPath, "utf-8"));
    bj.name = "@workloom/copycat"; bj.workloom.industry = "copycat"; bj.workloom.status = "draft";
    writeFileSync(bjPath, `${JSON.stringify(bj, null, 2)}\n`, "utf-8");

    // finally 还原演示工作区（hotel）：断言中断也不残留 industry 污染（测试纪律：不跨用例污染）
    try {
      const p0 = await computeAssembly(app, scope, "copycat", root);
      expect(p0.status).toBe("draft");
      expect(p0.filledCount).toBe(7); // 五要素填满 + 第⑦槽 model-policy.yml（随 hotel 资产复制） → 七槽全装配
      expect(p0.canActivate).toBe(true); // 检查单六项全绿

      const act = await activateBundle(app, gw, scope, "copycat", "MEM-001", root);
      expect(act.eventId).toMatch(/^E-\d+$/);
      const ind = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
      expect(ind.rows[0]!.industry).toBe("copycat"); // profile 切换生效（§2.3）

      // 激活态复核：档案/阶段一致性校验同样全绿（isActive 分支）
      const p1 = await computeAssembly(app, scope, "copycat", root);
      expect(p1.status).toBe("active");
      expect(p1.checks.every((c) => c.ok)).toBe(true);
    } finally {
      await activateBundle(app, gw, scope, "hotel", "MEM-001"); // 还原演示工作区
    }
    const back = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    expect(back.rows[0]!.industry).toBe("hotel");
  }, 20000);

  it("草稿 Bundle：六槽待填充 + 校验五项全红（第⑦槽骨架自带不阻断）+ 拒绝激活（F2.10 不静默 L9.2）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    const slug = `draft-${Date.now().toString(36)}`;
    const created = await createBundleDraft(gw, scope, {
      slug, displayName: "草稿行业", version: "0.1.0",
      changelog: "测试草稿", fenceRef: "hotel-baseline/v1", ownerMemberNo: "MEM-002",
    }, "MEM-002", root);
    expect(created.eventId).toMatch(/^E-\d+$/);

    const p = await computeAssembly(app, scope, slug, root);
    expect(p.status).toBe("draft");
    // v3.0：草稿自带第⑦槽 model-policy.yml 骨架（filled=1）；其余六槽待填充
    expect(p.filledCount).toBe(1);
    expect(p.canActivate).toBe(false);
    const failed = p.checks.filter((c) => !c.ok);
    expect(failed.length).toBe(5); // 五项铁律校验全红
    expect(failed.every((c) => c.fix)).toBe(true); // 每项失败都带修复指引（FixList）
    expect(p.checks.find((c) => c.key === "model_policy")?.ok).toBe(true); // 第⑦槽骨架即合法（非阻断）

    await expect(activateBundle(app, gw, scope, slug, "MEM-002", root))
      .rejects.toMatchObject({ code: "ASSEMBLY_CHECK_FAILED" });
  }, 20000);
});
