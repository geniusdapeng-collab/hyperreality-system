/**
 * asset-cms 测试（内存 mock DB，不依赖真实 Postgres）：
 *  - 素材 sha256 幂等去重 / 版本链（register parentId → versionChain）
 *  - 渲染脚本版本链 + G8 审批联动（approve → approvals 行；非 draft 拒绝）
 *  - 成片状态机非法跃迁拒绝（draft→scheduled→published→archived）
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import { AssetError, register, versionChain, type AssetRow } from "./assets.js";
import { approve, create, listByProject, newVersion, RenderScriptError } from "./render-scripts.js";
import {
  assertContentTransition,
  contentCalendar,
  ContentTransitionError,
  registerFinalCut,
  transitionFinalCut,
} from "./cms.js";

/* ================= 内存 mock DB（覆盖本包 SQL 面 + workdata 事件链 SQL 面） ================= */

type Row = Record<string, any>;

class MockDb {
  assets: Row[] = [];
  scripts: Row[] = [];
  approvals: Row[] = [];
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
    if (/FROM biz_events WHERE tenant_id = \$1 ORDER BY seq DESC/.test(s)) {
      const tail = this.events[this.events.length - 1];
      return { rows: tail ? [{ seq: String(tail.seq), hash: tail.hash }] : [], rowCount: tail ? 1 : 0 };
    }
    if (s.includes("append_event_insert")) {
      const seq = ++this.seq;
      this.events.push({ seq, event_id: params[0], hash: params[6], payload: JSON.parse(params[4]) });
      return { rows: [{ seq: String(seq), inserted: true }], rowCount: 1 };
    }

    // ---- video_assets ----
    if (/INSERT INTO video_assets/.test(s)) {
      const row: Row = {
        id: params[0], workspace_id: params[1], project_id: params[2], chain_id: params[3],
        kind: params[4], version: params[5], parent_id: params[6], source_url: params[7],
        provenance: JSON.parse(params[8]), license_risk: params[9], hero_image_id: params[10],
        sha256: params[11], meta: JSON.parse(params[12]), status: params[13], created_by: params[14],
        publish_at: null, created_at: new Date().toISOString(),
      };
      this.assets.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE video_assets SET status=\$3, publish_at=\$4/.test(s)) {
      const row = this.assets.find((x) => x.workspace_id === params[0] && x.id === params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = params[2];
      row.publish_at = params[3];
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM video_assets WHERE workspace_id=\$1 AND sha256=\$2/.test(s)) {
      const rows = this.assets.filter((x) => x.workspace_id === params[0] && x.sha256 === params[1]);
      return { rows, rowCount: rows.length };
    }
    if (/FROM video_assets WHERE workspace_id=\$1 AND chain_id=\$2/.test(s)) {
      const rows = this.assets
        .filter((x) => x.workspace_id === params[0] && x.chain_id === params[1])
        .sort((a, b) => a.version - b.version);
      return { rows, rowCount: rows.length };
    }
    if (/FROM video_assets WHERE workspace_id=\$1 AND id=\$2/.test(s)) {
      const rows = this.assets.filter((x) => x.workspace_id === params[0] && x.id === params[1]);
      return { rows, rowCount: rows.length };
    }
    if (/FROM video_assets WHERE workspace_id=\$1 AND kind='final_cut' AND publish_at/.test(s)) {
      const rows = this.assets
        .filter((x) => x.workspace_id === params[0] && x.kind === "final_cut" && x.publish_at
          && x.publish_at >= params[1] && x.publish_at <= params[2])
        .sort((a, b) => String(a.publish_at).localeCompare(String(b.publish_at)));
      return { rows, rowCount: rows.length };
    }

    // ---- render_scripts ----
    if (/INSERT INTO render_scripts/.test(s)) {
      const isNewVersion = s.includes("diff_summary");
      const row: Row = isNewVersion
        ? {
            id: params[0], workspace_id: params[1], project_id: params[2], shot_id: params[3],
            script_key: params[4], version: params[5], parent_version: params[6], status: "draft",
            md: params[7], fields: JSON.parse(params[8]), char_check: JSON.parse(params[9]),
            diff_summary: params[10], created_by: params[11],
            approved_event_id: null, created_at: new Date().toISOString(),
          }
        : {
            id: params[0], workspace_id: params[1], project_id: params[2], shot_id: params[3],
            script_key: params[4], version: 1, parent_version: null, status: "draft",
            md: params[5], fields: JSON.parse(params[6]), char_check: JSON.parse(params[7]),
            diff_summary: null, created_by: params[8],
            approved_event_id: null, created_at: new Date().toISOString(),
          };
      this.scripts.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE render_scripts SET status='approved'/.test(s)) {
      const row = this.scripts.find(
        (x) => x.workspace_id === params[0] && x.script_key === params[1] && x.version === params[2],
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "approved";
      row.approved_event_id = params[3];
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM render_scripts WHERE workspace_id=\$1 AND script_key=\$2 AND version=\$3/.test(s)) {
      const rows = this.scripts.filter(
        (x) => x.workspace_id === params[0] && x.script_key === params[1] && x.version === params[2],
      );
      return { rows, rowCount: rows.length };
    }
    if (/FROM render_scripts WHERE workspace_id=\$1 AND script_key=\$2 ORDER BY version DESC/.test(s)) {
      const rows = this.scripts
        .filter((x) => x.workspace_id === params[0] && x.script_key === params[1])
        .sort((a, b) => b.version - a.version);
      return { rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) };
    }
    if (/FROM render_scripts WHERE workspace_id=\$1 AND project_id=\$2/.test(s)) {
      const rows = this.scripts
        .filter((x) => x.workspace_id === params[0] && x.project_id === params[1])
        .sort((a, b) => a.script_key.localeCompare(b.script_key) || a.version - b.version);
      return { rows, rowCount: rows.length };
    }

    // ---- approvals（G8 联动） ----
    if (/INSERT INTO approvals/.test(s)) {
      const row: Row = {
        approval_id: params[0], tenant_id: params[1], workspace_id: params[2], event_id: params[3],
        channel: "inapp", status: "approved", snapshot: JSON.parse(params[4]), decided_by: params[5],
      };
      this.approvals.push(row);
      return { rows: [row], rowCount: 1 };
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

const scope = { tenantId: "tenant-demo", workspaceId: "ws-video" };

function fixture() {
  const db = new MockDb();
  return { db, app: poolOf(db), gateway: poolOf(db) };
}

/* ================= 素材：sha256 幂等去重 + 版本链 ================= */

describe("素材服务（sha256 幂等去重 / 版本链）", () => {
  it("同 sha256 重复注册 → 返回已有行 deduped=true，不重复写行不写事件（L1.4 同源）", async () => {
    const { db, app, gateway } = fixture();
    const first = await register(app, gateway, scope, {
      id: "va-1", kind: "product_image", sourceUrl: "oss://img/1.png", sha256: "a".repeat(64), by: "asset-cms",
    });
    expect(first.deduped).toBe(false);
    const second = await register(app, gateway, scope, {
      id: "va-2", kind: "product_image", sourceUrl: "oss://img/1-copy.png", sha256: "a".repeat(64), by: "asset-cms",
    });
    expect(second.deduped).toBe(true);
    expect(second.asset.id).toBe("va-1");
    expect(db.assets.length).toBe(1);
    expect(db.events.length).toBe(1);
    expect(db.events[0]!.payload.decision.action).toBe("asset.register");
  });

  it("parentId 注册推进版本链：v1→v2→v3，versionChain 有序返回", async () => {
    const { app, gateway } = fixture();
    const v1 = await register(app, gateway, scope, {
      id: "va-p1", kind: "portrait", sourceUrl: "oss://portrait/1.png", sha256: "b".repeat(64), by: "asset-cms",
    });
    const v2 = await register(app, gateway, scope, {
      id: "va-p2", kind: "portrait", sourceUrl: "oss://portrait/2.png", sha256: "c".repeat(64),
      parentId: "va-p1", by: "asset-cms",
    });
    const v3 = await register(app, gateway, scope, {
      id: "va-p3", kind: "portrait", sourceUrl: "oss://portrait/3.png", sha256: "d".repeat(64),
      parentId: "va-p2", by: "asset-cms",
    });
    expect([v1.asset.version, v2.asset.version, v3.asset.version]).toEqual([1, 2, 3]);
    expect(v2.asset.chain_id).toBe("va-p1");
    expect(v3.asset.parent_id).toBe("va-p2");
    const chain = await versionChain(app, scope, "va-p2");
    expect(chain.map((r: AssetRow) => r.id)).toEqual(["va-p1", "va-p2", "va-p3"]);
  });

  it("版本链类型不一致拒绝（parent=portrait vs new=clip）", async () => {
    const { app, gateway } = fixture();
    await register(app, gateway, scope, {
      id: "va-m1", kind: "portrait", sourceUrl: "oss://x/1.png", sha256: "e".repeat(64), by: "asset-cms",
    });
    await expect(register(app, gateway, scope, {
      id: "va-m2", kind: "clip", sourceUrl: "oss://x/2.mp4", sha256: "f".repeat(64),
      parentId: "va-m1", by: "asset-cms",
    })).rejects.toThrow(AssetError);
  });
});

/* ================= 渲染脚本：版本链 + G8 审批联动 ================= */

describe("渲染脚本管理（版本即审批对象，G8 联动）", () => {
  it("create v1 → newVersion v2（parent_version 链 + diff 摘要）→ approve 落 G8 审批记录", async () => {
    const { db, app, gateway } = fixture();
    const v1 = await create(app, gateway, scope, {
      scriptKey: "rs-shot01", projectId: "vp-1", shotId: "shot-01", md: "# 镜头一", by: "render-operator",
    });
    expect(v1.version).toBe(1);
    expect(v1.status).toBe("draft");
    const v2 = await newVersion(app, gateway, scope, "rs-shot01", {
      md: "# 镜头一（修订）", diffSummary: "片头字段 3 处修改", by: "render-operator",
    });
    expect(v2.version).toBe(2);
    expect(v2.parent_version).toBe(1);
    expect(v2.status).toBe("draft"); // approved 不继承（版本即审批对象）
    const { approvalId } = await approve(app, gateway, scope, "rs-shot01", 2, { by: "MEM-001" });
    expect(approvalId).toMatch(/^apr-e-\d+$/);
    const script = db.scripts.find((x) => x.script_key === "rs-shot01" && x.version === 2)!;
    expect(script.status).toBe("approved");
    expect(script.approved_event_id).toMatch(/^E-\d+$/);
    expect(db.approvals.length).toBe(1);
    expect(db.approvals[0]!.snapshot).toMatchObject({ kind: "render_script", scriptKey: "rs-shot01", version: 2 });
    const list = await listByProject(app, scope, "vp-1");
    expect(list.map((r) => r.version)).toEqual([1, 2]);
  });

  it("非 draft 版本审批拒绝（NOT_DRAFT）；不存在脚本 newVersion 拒绝（NOT_FOUND）", async () => {
    const { app, gateway } = fixture();
    await create(app, gateway, scope, {
      scriptKey: "rs-shot02", projectId: "vp-1", shotId: "shot-02", md: "# x", by: "render-operator",
    });
    await approve(app, gateway, scope, "rs-shot02", 1, { by: "MEM-001" });
    await expect(approve(app, gateway, scope, "rs-shot02", 1, { by: "MEM-001" }))
      .rejects.toThrow(RenderScriptError);
    await expect(newVersion(app, gateway, scope, "rs-ghost", { md: "#", diffSummary: "d", by: "x" }))
      .rejects.toThrow(RenderScriptError);
  });
});

/* ================= 成片：状态机 + 内容日历 ================= */

describe("成片库状态机（draft→scheduled→published→archived）", () => {
  it("非法跃迁纯函数拒绝", () => {
    expect(() => assertContentTransition("draft", "scheduled")).not.toThrow();
    expect(() => assertContentTransition("scheduled", "published")).not.toThrow();
    expect(() => assertContentTransition("published", "archived")).not.toThrow();
    expect(() => assertContentTransition("scheduled", "draft")).not.toThrow(); // 取消排期
    expect(() => assertContentTransition("draft", "published")).toThrow(ContentTransitionError);
    expect(() => assertContentTransition("archived", "draft")).toThrow(ContentTransitionError);
    expect(() => assertContentTransition("published", "scheduled")).toThrow(ContentTransitionError);
  });

  it("全链路：入库 draft → 排期 → 发布 → 归档；draft 直跳 published 拒绝且不落库", async () => {
    const { db, app, gateway } = fixture();
    const fc = await registerFinalCut(app, gateway, scope, {
      id: "fc-1", sourceUrl: "oss://final/1.mp4", sha256: "0".repeat(64),
      platforms: ["douyin", "bilibili"], durationSeconds: 95, prdId: "prd-1", shotPackageVersion: "v3",
      by: "asset-cms",
    });
    expect(fc.asset.status).toBe("draft");
    expect(fc.asset.meta).toMatchObject({ durationSeconds: 95, prdId: "prd-1" });

    const eventsBefore = db.events.length;
    await expect(transitionFinalCut(app, gateway, scope, "fc-1", "published", { by: "asset-cms" }))
      .rejects.toThrow(ContentTransitionError);
    expect(db.events.length).toBe(eventsBefore); // 非法跃迁不留痕
    expect(db.assets.find((x) => x.id === "fc-1")!.status).toBe("draft");

    const scheduled = await transitionFinalCut(app, gateway, scope, "fc-1", "scheduled", {
      by: "asset-cms", publishAt: "2026-08-23T12:00:00+08:00",
    });
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.publish_at).toBe("2026-08-23T12:00:00+08:00");

    const cal = await contentCalendar(app, scope, { from: "2026-08-23T00:00:00+08:00", to: "2026-08-24T00:00:00+08:00" });
    expect(cal.map((r) => r.id)).toEqual(["fc-1"]);

    const published = await transitionFinalCut(app, gateway, scope, "fc-1", "published", { by: "asset-cms" });
    expect(published.status).toBe("published");
    const archived = await transitionFinalCut(app, gateway, scope, "fc-1", "archived", { by: "asset-cms" });
    expect(archived.status).toBe("archived");
    await expect(transitionFinalCut(app, gateway, scope, "fc-1", "draft", { by: "asset-cms" }))
      .rejects.toThrow(ContentTransitionError);
    // 每次合法迁移均有五元事件留痕
    const transitions = db.events.filter((e) => e.payload.decision.action === "content.transition");
    expect(transitions.map((e) => e.payload.decision.after.to)).toEqual(["scheduled", "published", "archived"]);
  });
});
