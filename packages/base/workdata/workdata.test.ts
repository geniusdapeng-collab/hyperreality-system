/**
 * B1 测试：纯函数单测（PII/权限段/高风险段/哈希链规范化）+ PG 集成（幂等/链序/门禁）
 * 集成用例仅在 RUN_DB_TESTS=1 且 DATABASE_GATEWAY_URL 可达时运行（CI/沙箱实测口径），
 * 否则自动跳过——单元用例永远全量跑。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { maskDeep, maskText } from "./pii.js";
import {
  checkHighRiskAuthorization,
  checkPermission,
  GatewayReject,
  isWriteAction,
  SYSTEM_ACTOR_WHITELIST,
  type GatewayQueryable,
} from "./gateway.js";
import { canonicalJson, eventHash, GENESIS_HASH, isReplayEventId } from "./events.js";

const draft = (action: string, whoId = "pricing-agent") => ({
  who: { type: "agent" as const, id: whoId, version: "v2.3" },
  context: { tenant_id: "tenant-demo", workspace_id: "ws-yunqi", time: "2026-08-16T22:10:00+08:00" },
  object: { type: "room_price", id: "RT-DLX-KING" },
  decision: { action },
  rule_impact: [],
});

describe("PII 脱敏（瀑布段②）", () => {
  it("手机号/身份证/邮箱命中占位符协议，同值同占位", () => {
    const a = maskText("客人电话 13812345678，邮箱 a.b@c.com");
    expect(a.hits).toBe(2);
    expect(a.text).not.toContain("13812345678");
    expect(a.text).toMatch(/\[PII:PHONE:[0-9a-f]{12}\]/);
    const b = maskText("回访 13812345678");
    // 同值同占位（可关联、无明文）
    expect(b.text).toContain(a.text.match(/\[PII:PHONE:[0-9a-f]{12}\]/)![0]);
  });

  it("M2-PII：占位符为 HMAC-SHA256（≥12 hex，带盐不可彩虹表反推）", () => {
    const r = maskText("电话 13812345678");
    const m = r.text.match(/\[PII:PHONE:([0-9a-f]+)\]/)!;
    expect(m[1]!.length).toBeGreaterThanOrEqual(12);
    // 无盐 sha256 前缀不得命中（旧协议 8 位 hex 直散列已被 HMAC 取代）
    expect(m[1]).not.toBe(createHash("sha256").update("13812345678", "utf-8").digest("hex").slice(0, 12));
  });

  it("M2-PII：分段手机号（138 0000 0000）与分隔符证件号命中", () => {
    const p = maskText("客人留电 138 0000 0000 请回拨");
    expect(p.hits).toBe(1);
    expect(p.text).not.toContain("0000 0000");
    expect(p.text).toMatch(/\[PII:PHONE:[0-9a-f]{12}\]/);
    const d = maskText("证件 110101 19900307 7758 登记");
    expect(d.text).toMatch(/\[PII:IDCARD:[0-9a-f]{12}\]/);
    expect(d.text).not.toContain("19900307");
  });

  it("身份证号优先于银行卡，不误伤价格数字", () => {
    const r = maskText("身份证 110101199003077758，担保卡 6222021001114329，退款金额 500");
    expect(r.text).toContain("[PII:IDCARD:");
    expect(r.text).toContain("退款金额 500"); // 纯业务数字不误伤
  });

  it("maskDeep 递归到嵌套叶子", () => {
    const r = maskDeep({ decision: { after: { note: "联系 13900001111" }, basis: ["OCC 0.78"] } });
    expect(r.hits).toBe(1);
    expect(JSON.stringify(r.value)).not.toContain("13900001111");
  });
});

describe("权限段①（F2.10/L9.1 复查位）", () => {
  it("未声明 fence_bindings 的 Agent 写动作被拒", () => {
    expect(() =>
      checkPermission({ id: "rogue", type: "agent", fenceBindings: [] }, draft("price.adjust", "rogue")),
    ).toThrow(GatewayReject);
  });

  it("只读 preset 写动作被拒（L9.1）", () => {
    expect(() =>
      checkPermission({ id: "inspection-agent", type: "agent", readonly: true, fenceBindings: [] }, draft("price.adjust", "inspection-agent")),
    ).toThrow(/L9\.1/);
  });

  it("声明了围栏的 Agent 写动作放行；只读动作不受限", () => {
    expect(() =>
      checkPermission({ id: "pricing-agent", type: "agent", fenceBindings: ["R1", "R2"] }, draft("price.adjust")),
    ).not.toThrow();
    expect(() => checkPermission({ id: "inspection-agent", type: "agent", readonly: true }, draft("inspection.scan", "inspection-agent"))).not.toThrow();
  });

  it("M5：白名单系统组件豁免段①；未知 system 身份按普通身份走全检查", () => {
    const sysDraft = (whoId: string) => ({
      ...draft("price.adjust", whoId),
      who: { type: "system" as const, id: whoId },
    });
    // 白名单内已知系统组件（night-shift/captain/service-c 等）走系统通道
    expect(SYSTEM_ACTOR_WHITELIST).toEqual(
      expect.arrayContaining(["system", "model-router", "im-channels", "review-console", "night-shift", "captain", "service-c"]),
    );
    expect(() => checkPermission({ id: "night-shift", type: "system" }, sysDraft("night-shift"))).not.toThrow();
    // 伪造 system 身份（不在白名单）写动作：按普通身份全检查——无 fence_bindings 必拒
    expect(() => checkPermission({ id: "evil-system", type: "system" }, sysDraft("evil-system"))).toThrow(/fence_bindings/);
    // 只读动作仍放行（全检查中的只读豁免）
    const roDraft = { ...draft("inspection.scan", "evil-system"), who: { type: "system" as const, id: "evil-system" } };
    expect(() => checkPermission({ id: "evil-system", type: "system" }, roDraft)).not.toThrow();
  });
});

describe("高风险授权段③（L3.5 + P1-8 验真）", () => {
  const desktop = { id: "desktop-agent", type: "agent" as const, highRisk: true, fenceBindings: ["R2"] };
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  /** 审批表桩：模拟 approvals 查询结果（P1-8 段③已改为查表验真） */
  const stubDb = (rows: Array<{ status: string; snapshot: unknown }>) =>
    ({ query: async () => ({ rows }) }) as unknown as GatewayQueryable;
  const d = () => draft("desktop.gui", "desktop-agent");

  it("缺授权引用被拒（L3.5）", async () => {
    await expect(checkHighRiskAuthorization(stubDb([]), scope, desktop, d())).rejects.toThrow(/L3\.5/);
  });

  it("伪造引用查无此行被拒（P1-8）", async () => {
    await expect(checkHighRiskAuthorization(stubDb([]), scope, desktop, d(), "apr-forged")).rejects.toThrow(/不存在/);
  });

  it("非 approved 状态被拒（pending/rejected 均不放行）", async () => {
    await expect(
      checkHighRiskAuthorization(stubDb([{ status: "pending", snapshot: {} }]), scope, desktop, d(), "apr-1"),
    ).rejects.toThrow(/非 approved/);
  });

  it("已过期审批被拒（snapshot.expires_at 已过）", async () => {
    const snapshot = { expires_at: "2020-01-01T00:00:00.000Z" };
    await expect(
      checkHighRiskAuthorization(stubDb([{ status: "approved", snapshot }]), scope, desktop, d(), "apr-1"),
    ).rejects.toThrow(/过期/);
  });

  it("绑定对象/动作不符被拒；相符或通用授权（无绑定字段）放行", async () => {
    await expect(
      checkHighRiskAuthorization(stubDb([{ status: "approved", snapshot: { object_type: "order" } }]), scope, desktop, d(), "apr-1"),
    ).rejects.toThrow(/不符/);
    await expect(
      checkHighRiskAuthorization(
        stubDb([{ status: "approved", snapshot: { object_type: "room_price", action: "desktop.gui" } }]),
        scope, desktop, d(), "apr-1",
      ),
    ).resolves.toBeUndefined();
    await expect(
      checkHighRiskAuthorization(stubDb([{ status: "approved", snapshot: {} }]), scope, desktop, d(), "apr-1"),
    ).resolves.toBeUndefined();
  });

  it("非高危身份不查库直接放行", async () => {
    const human = { id: "MEM-001", type: "human" as const };
    const hDraft = { ...draft("price.adjust", "MEM-001"), who: { type: "human" as const, id: "MEM-001" } };
    await expect(checkHighRiskAuthorization(stubDb([]), scope, human, hDraft)).resolves.toBeUndefined();
  });
});

describe("回放通道命名空间（P0-3）", () => {
  it("E-SEED-/E-RPL- 前缀识别；普通 E-<digits> 与非 E 前缀一律不算回放 ID", () => {
    expect(isReplayEventId("E-RPL-abc")).toBe(true);
    expect(isReplayEventId("E-SEED-8801")).toBe(true);
    expect(isReplayEventId("E-8801")).toBe(false);
    expect(isReplayEventId("CUSTOM-1")).toBe(false);
  });
});

describe("哈希链工具", () => {
  it("canonicalJson 键序稳定", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("eventHash 确定性", () => {
    expect(eventHash(GENESIS_HASH, { x: 1 })).toBe(eventHash(GENESIS_HASH, { x: 1 }));
    expect(eventHash(GENESIS_HASH, { x: 1 })).not.toBe(eventHash(GENESIS_HASH, { x: 2 }));
  });
  it("写类动作判定", () => {
    expect(isWriteAction("price.adjust")).toBe(true);
    expect(isWriteAction("inspection.scan")).toBe(false);
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1 时启用） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_GATEWAY_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成（H-2/L1.4：幂等丢弃、哈希链序）", async () => {
  const pg = (await import("pg")).default;
  const { gatewayAppend, gatewayAppendIdempotent } = await import("./gateway.js");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  const ctx = { ...scope, actor: { id: "pricing-agent", type: "agent" as const, fenceBindings: ["R1", "R2"] } };

  /** 读侧辅助：RLS 要求会话级 workspace 上下文（L7.1），否则返回空 */
  const readEvent = async (eventId: string) => {
    const c = await pool.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const r = await c.query("SELECT prev_hash, hash, payload FROM biz_events WHERE tenant_id=$1 AND event_id=$2", [scope.tenantId, eventId]);
      return r.rows[0];
    } finally {
      c.release();
    }
  };

  it("网关落库 → 事件编号续接 + 哈希链推进", async () => {
    const r = await gatewayAppend(pool, ctx, draft("price.adjust"));
    expect(r.eventId).toMatch(/^E-\d+$/);
    expect(r.deduped).toBe(false);
    const row = await readEvent(r.eventId);
    expect(row.hash).toBe(r.hash);
  });

  it("#32 链可重算：网关写入与种子同口径（canonicalJson 生产口径逐条复验）", async () => {
    const { canonicalJson, eventHash, GENESIS_HASH } = await import("./events.js");
    const { createHash } = await import("node:crypto");
    const sha256 = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
    // 种子链首条必须从 GENESIS 起且可重算（#32 前：种子 stringify 口径重算全部不符）
    const c = await pool.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const rows = await c.query<{ event_id: string; payload: unknown; prev_hash: string; hash: string }>(
        `SELECT event_id, payload, prev_hash, hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq LIMIT 10`,
        [scope.tenantId, scope.workspaceId],
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      let prev = GENESIS_HASH;
      for (const row of rows.rows) {
        expect(row.prev_hash).toBe(prev);
        expect(row.hash).toBe(sha256(prev + canonicalJson(row.payload)));
        expect(row.hash).toBe(eventHash(prev, row.payload)); // 与生产 eventHash 同结果
        prev = row.hash;
      }
    } finally {
      c.release();
    }
  });

  it("重复 event_id 写入幂等丢弃不报错（L1.4；P0-3 回放前缀空间）", async () => {
    // P0-3：回放通道自选 ID 必须 E-RPL-/E-SEED- 前缀；同 payload 重复写入 deduped=true 不抛错
    const ev = { ...draft("price.adjust"), event_id: `E-RPL-${Date.now().toString(36)}` } as const;
    const r1 = await gatewayAppendIdempotent(pool, ctx, ev as never);
    expect(r1.deduped).toBe(false);
    const r2 = await gatewayAppendIdempotent(pool, ctx, ev as never);
    expect(r2.deduped).toBe(true);
    expect(r2.eventId).toBe(ev.event_id);
    // #4/M2：deduped 返回 DB 中已存在事件的真实 seq/hash（事务内回查）
    expect(r2.seq).toBe(r1.seq);
    expect(r2.hash).toBe(r1.hash);
  });

  it("P0-3：回放通道 event_id 无前缀（E-8801 等序列空间）一律拒绝", async () => {
    const ev = { ...draft("price.adjust"), event_id: "E-8801" } as const;
    await expect(gatewayAppendIdempotent(pool, ctx, ev as never)).rejects.toThrow(/前缀空间/);
  });

  it("P0-3：同 event_id 不同 payload 抢占攻击被拒（append_event_insert 比对 payload hash）", async () => {
    // 确定性构造：经回放通道（E-RPL- 前缀）以同一 event_id 写两次，第二次换 payload ——
    // DB 函数比对 payload hash 不一致 → 抢占攻击拒绝。
    // 此前用「抢注下一个全局序列号」构造：全量并行跑批时其他测试文件并发消耗
    // biz_events_eid_seq，哨兵占位号与实际分配号错位，用例随机失败；
    // 回放通道与序列分配走同一个 append_event_insert 比对逻辑，路径等价且无竞态。
    const iso = { tenantId: `tenant-t26-${Date.now().toString(36)}`, workspaceId: "ws-t26" };
    const isoCtx = { ...iso, actor: ctx.actor };
    const attackId = `E-RPL-p03-${Date.now().toString(36)}`;
    const first = { ...draft("price.adjust"), event_id: attackId } as const;
    const r1 = await gatewayAppendIdempotent(pool, isoCtx, first as never);
    expect(r1.deduped).toBe(false);
    // 同 id 不同 payload → 抢占攻击拒绝（不再静默 deduped）
    const hijack = { ...draft("order.refund"), event_id: attackId } as const;
    await expect(gatewayAppendIdempotent(pool, isoCtx, hijack as never)).rejects.toThrow(/抢占攻击/);
    // 对照：同 id 同 payload 仍是幂等丢弃——拒绝的是 payload 不一致，而非重复本身（L1.4）
    const r2 = await gatewayAppendIdempotent(pool, isoCtx, first as never);
    expect(r2.deduped).toBe(true);
  });

  it("L6：gatewayAppendIdempotent 段序统一先 zod 后权限（坏 payload 先报附录 E）", async () => {
    // actor/who 不一致（权限必拒）+ payload 残缺（zod 必拒）→ 必须先抛 zod 校验错误
    const bad = { event_id: "E-RPL-l6", who: { type: "agent", id: "someone-else" } } as never;
    await expect(gatewayAppendIdempotent(pool, ctx, bad)).rejects.toThrow(/附录 E/);
  });

  it("P1-8：伪造/状态不符/对象不符的 approvalRef 全拒；真实 approved 审批放行", async () => {
    const desktopCtx = {
      ...scope,
      actor: { id: "desktop-agent", type: "agent" as const, highRisk: true, fenceBindings: ["R2"] },
    };
    const ddraft = (objId: string) => ({
      who: { type: "agent" as const, id: "desktop-agent" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "room_price", id: objId },
      decision: { action: "desktop.gui" },
      rule_impact: [],
    });
    const tag = Date.now().toString(36);
    const insApr = async (id: string, status: string, snapshot: unknown) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await c.query(
          `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
           VALUES ($1,$2,$3,$4,'inapp',$5,$6)`,
          // approvals 有 UNIQUE(event_id, channel)：每行用独立 event_id 避免互撞
          [id, scope.tenantId, scope.workspaceId, `E-RPL-${id}`, status, JSON.stringify(snapshot)],
        );
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    };
    try {
      // 伪造引用（查无此行）→ 拒
      await expect(
        gatewayAppend(pool, { ...desktopCtx, approvalRef: `apr-p18-forged-${tag}` }, ddraft("RT-P18")),
      ).rejects.toThrow(/不存在/);
      // 真实 pending → 拒
      await insApr(`apr-p18-pending-${tag}`, "pending", {});
      await expect(
        gatewayAppend(pool, { ...desktopCtx, approvalRef: `apr-p18-pending-${tag}` }, ddraft("RT-P18")),
      ).rejects.toThrow(/非 approved/);
      // approved 但已过期 → 拒
      await insApr(`apr-p18-exp-${tag}`, "approved", { expires_at: "2020-01-01T00:00:00.000Z" });
      await expect(
        gatewayAppend(pool, { ...desktopCtx, approvalRef: `apr-p18-exp-${tag}` }, ddraft("RT-P18")),
      ).rejects.toThrow(/过期/);
      // approved 但绑定对象类型不符 → 拒
      await insApr(`apr-p18-mis-${tag}`, "approved", { object_type: "order" });
      await expect(
        gatewayAppend(pool, { ...desktopCtx, approvalRef: `apr-p18-mis-${tag}` }, ddraft("RT-P18")),
      ).rejects.toThrow(/不符/);
      // 真实 approved 且绑定相符、未过期 → 放行
      await insApr(`apr-p18-ok-${tag}`, "approved", {
        object_type: "room_price",
        action: "desktop.gui",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const ok = await gatewayAppend(pool, { ...desktopCtx, approvalRef: `apr-p18-ok-${tag}` }, ddraft("RT-P18"));
      expect(ok.deduped).toBe(false);
      expect(ok.eventId).toMatch(/^E-\d+$/);
    } finally {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await c.query(`DELETE FROM approvals WHERE approval_id LIKE 'apr-p18-%'`);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    }
  });

  it("M5：白名单系统组件写动作放行（系统通道豁免段①）", async () => {
    const sysCtx = { ...scope, actor: { id: "night-shift", type: "system" as const } };
    const sysDraft = {
      who: { type: "system" as const, id: "night-shift" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "suite", id: `m5-${Date.now().toString(36)}` },
      decision: { action: "price.adjust" },
      rule_impact: [],
    };
    const r = await gatewayAppend(pool, sysCtx, sysDraft);
    expect(r.deduped).toBe(false);
  });

  it("#35 actor 与 who 身份分叉被拒（防伪造留痕），且不落库", async () => {
    const forged = draft("price.adjust");
    (forged.who as { id: string }).id = "MEM-999"; // who 伪造他人归因，actor 仍是 pricing-agent
    await expect(gatewayAppend(pool, ctx, forged)).rejects.toThrow(/身份不一致/);
    const c = await pool.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const n = await c.query<{ c: string }>(
        `SELECT count(*) AS c FROM biz_events WHERE workspace_id=$1 AND payload->'who'->>'id'='MEM-999'`,
        [scope.workspaceId],
      );
      expect(Number(n.rows[0]!.c)).toBe(0); // 伪造事件未落库
    } finally { c.release(); }
  });

  it("脱敏落库：事件库无明文手机号（F1.10 机制位）", async () => {
    const r = await gatewayAppend(pool, ctx, {
      ...draft("price.adjust"),
      decision: { action: "price.adjust", after: { note: "客人 13812345678 要求保留房价" } },
    });
    const row = await readEvent(r.eventId);
    expect(JSON.stringify(row.payload)).not.toContain("13812345678");
    expect(JSON.stringify(row.payload)).toContain("[PII:PHONE:");
    expect(r.piiHits).toBe(1);
  });
});
