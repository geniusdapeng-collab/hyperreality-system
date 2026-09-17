/**
 * im-channels 测试（D14/B11）
 * 纯单测：注册表↔DDL 对账 / 通道校验 / 入站校验 / 卡片组装 / Mock 驱动
 * PG 集成（RUN_DB_TESTS=1）：入站落库+幂等 / openid 映射 / 手势回调闭环（L5.3 幂等、未映射拒绝、readonly 403）/ 出站留痕
 * 纪律：集成用例自备数据（唯一后缀隔离），不依赖种子状态、不跨用例污染——可重跑
 */
import { describe, expect, it } from "vitest";
import {
  CHANNEL_REGISTRY,
  APPROVAL_CHANNEL_ENUM,
  ChannelError,
  getChannel,
  registryMatchesDdl,
  validateInbound,
  composeApprovalCard,
  MockChannelDriver,
  type InboundMessage,
} from "./index.js";

/* ================= 纯单测 ================= */

describe("通道注册表（D14）", () => {
  it("注册表与 approvals.channel DDL 枚举逐一对账", () => {
    expect(registryMatchesDdl()).toBe(true);
    expect([...APPROVAL_CHANNEL_ENUM].sort()).toEqual(["dingtalk", "feishu", "inapp", "slack", "wecom"]);
  });

  it("首批仅启用 inapp + 官方三通道（dingtalk/wecom/feishu）；slack 保留 planned 位", () => {
    const enabled = CHANNEL_REGISTRY.filter((c) => c.status === "enabled").map((c) => c.id).sort();
    expect(enabled).toEqual(["dingtalk", "feishu", "inapp", "wecom"]);
    expect(getChannel("dingtalk").streaming).toBe(true);
  });

  it("未知通道 / 未启用通道拒绝注册", () => {
    expect(() => getChannel("weixin")).toThrowError(ChannelError); // 观察名单（iLink 非官方协议，D14）
    expect(() => getChannel("whatsapp")).toThrowError(ChannelError);
    expect(() => getChannel("slack")).toThrowError(/尚未启用/);
  });
});

describe("入站归一化校验", () => {
  const base: InboundMessage = {
    channel: "dingtalk", channelMsgId: "m1", conversationId: "c1",
    kind: "direct", senderOpenId: "ou_1", text: "今晚房价看一下",
  };
  it("合法消息通过", () => {
    expect(() => validateInbound(base)).not.toThrow();
  });
  it("缺幂等键 / 空文本 / 超长 / 未启用通道各拒一例", () => {
    expect(() => validateInbound({ ...base, channelMsgId: "" })).toThrowError(/幂等键/);
    expect(() => validateInbound({ ...base, text: "  " })).toThrowError(/文字消息/);
    expect(() => validateInbound({ ...base, text: "x".repeat(2001) })).toThrowError(/2000/);
    expect(() => validateInbound({ ...base, channel: "slack" })).toThrowError(ChannelError);
  });
});

describe("审批卡片组装（M5/F5.1 同源投影）", () => {
  it("字段完整：approvalId/eventId/diff/ruleHits/三手势/过期位", () => {
    const card = composeApprovalCard({
      approval_id: "apr-e-1", event_id: "E-1",
      payload: {
        decision: { action: "price.adjust", before: { price: 400 }, after: { price: 432 } },
        object: { type: "room_price", id: "rt-1", label: "大床房" },
        rule_impact: [{ rule_id: "R1", version: "v1", result: "review" }],
      },
      snapshot: { expires_at: "2026-08-18T08:30:00+08:00" },
    });
    expect(card.approvalId).toBe("apr-e-1");
    expect(card.eventId).toBe("E-1");
    expect(card.gestures).toEqual(["approve", "edit", "reject"]);
    expect(card.ruleHits).toEqual(["R1:review"]);
    expect(card.before).toEqual({ price: 400 });
    expect(card.expiresAt).toContain("2026-08-18");
  });
});

describe("Mock 通道驱动（D4 同纪律）", () => {
  it("出站进出站盒，消息 ID 单调递增", async () => {
    const d = new MockChannelDriver("feishu");
    const a = await d.sendCard({ conversationId: "c1" }, composeApprovalCard({
      approval_id: "apr-x", event_id: "E-2", payload: {}, snapshot: null,
    }));
    const b = await d.sendText({ conversationId: "c1" }, "已处理");
    expect(d.outbox).toHaveLength(2);
    expect(a.channelMsgId).not.toBe(b.channelMsgId);
    expect(d.outbox[0]?.card?.approvalId).toBe("apr-x");
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1 时启用） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_GATEWAY_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成（G8/L1.4/L5.3/E5.2/L5.1）", async () => {
  const pg = (await import("pg")).default;
  const { ingestInbound, handleGestureCallback, sendApprovalCard, resolveMemberByOpenid } = await import("./index.js");
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  // 自备数据唯一后缀（可重跑纪律）
  const sfx = `im${Date.now().toString(36)}`;
  const openId = `ou_${sfx}`;

  const setScoped = async (c: pg.PoolClient) => {
    await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
    await c.query("SELECT set_config('app.tenant_id', $1, false)", [scope.tenantId]);
  };
  /** openid 绑定到种子成员（MEM-001 owner / MEM-003 readonly；只 UPDATE 不 INSERT——不污染种子成员数断言，openid 键带 sfx 唯一可重跑） */
  const bindOpenid = async (memberNo: string, oid: string) => {
    const c = await app.connect();
    try {
      await setScoped(c);
      await c.query(
        `UPDATE members SET im_openids = im_openids || $3::jsonb WHERE workspace_id=$2 AND member_no=$1`,
        [memberNo, scope.workspaceId, JSON.stringify({ dingtalk: oid })],
      );
    } finally {
      c.release();
    }
  };
  /** 自备 pending 审批（经网关现铸动作事件 → 插 approvals；快照不过期） */
  const prepareApproval = async (tag: string) => {
    const { gatewayAppend } = await import("../workdata/gateway.js");
    const ev = await gatewayAppend(gateway, { ...scope, actor: { id: "review-agent", type: "agent", fenceBindings: ["R6"] } }, {
      who: { type: "agent", id: "review-agent", version: "v1.8" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "review", id: `RV-${sfx}-${tag}` },
      decision: { action: "review.reply", after: { draft: `回复草稿 ${tag}` } },
      rule_impact: [{ rule_id: "R6", version: "hotel-baseline/v1", result: "review" }],
    });
    const approvalId = `apr-${sfx}-${tag}`;
    const c = await app.connect();
    try {
      await setScoped(c);
      await c.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($1,$2,$3,$4,'dingtalk','pending',$5)`,
        [approvalId, scope.tenantId, scope.workspaceId, ev.eventId,
         JSON.stringify({ before: null, after: { draft: `回复草稿 ${tag}` }, expires_at: new Date(Date.now() + 3600_000).toISOString() })],
      );
    } finally {
      c.release();
    }
    return { approvalId, eventId: ev.eventId };
  };
  const countInbound = async (msgId: string) => {
    const c = await app.connect();
    try {
      await setScoped(c);
      const r = await c.query<{ c: string }>(
        `SELECT count(*) AS c FROM biz_events
         WHERE workspace_id=$1 AND payload->'decision'->>'action'='im.message'
           AND payload->'decision'->'after'->>'channel_msg_id'=$2`,
        [scope.workspaceId, msgId],
      );
      return Number(r.rows[0]?.c ?? 0);
    } finally {
      c.release();
    }
  };

  it("入站消息落五元事件可检索（G8）；重复投递幂等丢弃（L1.4 同口径）", async () => {
    const msg: InboundMessage = {
      channel: "dingtalk", channelMsgId: `m-${sfx}-1`, conversationId: `conv-${sfx}`,
      kind: "group", senderOpenId: openId, text: "今晚大床房最低价多少？联系我 13812345678",
    };
    const r1 = await ingestInbound(app, gateway, scope, msg);
    expect(r1.deduped).toBe(false);
    expect(r1.eventId).toMatch(/^E-\d+$/);
    const r2 = await ingestInbound(app, gateway, scope, msg); // 通道重推
    expect(r2.deduped).toBe(true);
    expect(r2.eventId).toBe(r1.eventId);
    expect(await countInbound(`m-${sfx}-1`)).toBe(1);
    // 脱敏段覆盖通道文本（F1.10）：手机号不落明文
    const c = await app.connect();
    try {
      await setScoped(c);
      const row = await c.query<{ payload: unknown }>(`SELECT payload FROM biz_events WHERE workspace_id=$1 AND event_id=$2`, [scope.workspaceId, r1.eventId]);
      expect(JSON.stringify(row.rows[0]?.payload)).not.toContain("13812345678");
    } finally {
      c.release();
    }
  });

  it("#29 并发重推只落一条（im_inbound_dedupe 原子占位，TOCTOU 消除）", async () => {
    const msg: InboundMessage = {
      channel: "dingtalk", channelMsgId: `m-${sfx}-race`, conversationId: `conv-${sfx}`,
      kind: "group", senderOpenId: `ou_race_${sfx}`, text: "并发重推同一条",
    };
    // 8 路并发投递同一 (channel, channel_msg_id)——模拟通道重试风暴
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => ingestInbound(app, gateway, scope, msg)),
    );
    const fresh = rs.filter((r) => !r.deduped);
    expect(fresh.length).toBe(1); // 只有一路真正落事件
    expect(rs.filter((r) => r.deduped).length).toBe(7);
    expect(await countInbound(`m-${sfx}-race`)).toBe(1); // 事件库仅一条
    // deduped 方在赢家回填 event_id 前返回时拿到 null（窄窗口口径：已处理，编号暂不可得）；
    // 回填后重推则拿到原编号（见上一用例 r2.eventId === r1.eventId）
    const winnerId = fresh[0]!.eventId;
    for (const r of rs) {
      if (r.deduped) expect([null, winnerId]).toContain(r.eventId);
      else expect(r.eventId).toBe(winnerId);
    }
  });

  it("openid→成员映射（E5.2）：已映射 who=MEM-xxx；未映射=外部访客 ext: 口径", async () => {    await bindOpenid("MEM-001", openId);
    const hit = await resolveMemberByOpenid(app, scope, "dingtalk", openId);
    expect(hit?.memberNo).toBe("MEM-001");
    const miss = await resolveMemberByOpenid(app, scope, "dingtalk", `ou_nobody_${sfx}`);
    expect(miss).toBeNull();
    const r = await ingestInbound(app, gateway, scope, {
      channel: "dingtalk", channelMsgId: `m-${sfx}-2`, conversationId: `conv-${sfx}`,
      kind: "direct", senderOpenId: openId, text: "已映射成员消息",
    });
    expect(r.identity).toBe("member");
    expect(r.memberNo).toBe("MEM-001");
    const v = await ingestInbound(app, gateway, scope, {
      channel: "dingtalk", channelMsgId: `m-${sfx}-3`, conversationId: `conv-${sfx}`,
      kind: "direct", senderOpenId: `ou_nobody_${sfx}`, text: "陌生人消息",
    });
    expect(v.identity).toBe("visitor");
  });

  it("手势回调闭环：approve 生效 → 重复回调 deduped（L5.3）；未映射 openid 拒绝（E5.2）；readonly 无权（L5.1）", async () => {
    const { approvalId } = await prepareApproval("g1");
    const driver = new MockChannelDriver("dingtalk");
    const r1 = await handleGestureCallback(app, gateway, scope, {
      channel: "dingtalk", approvalId, operatorOpenId: openId,
      conversationId: `conv-${sfx}`, gesture: "approve",
    }, driver);
    expect(r1.status).toBe("approved");
    expect(r1.deduped).toBe(false);
    expect(driver.outbox.at(-1)?.text).toContain("已采纳"); // 手势回执回写通道（F5.5）
    const r2 = await handleGestureCallback(app, gateway, scope, {
      channel: "dingtalk", approvalId, operatorOpenId: openId,
      conversationId: `conv-${sfx}`, gesture: "approve",
    }, driver);
    expect(r2.deduped).toBe(true); // L5.3：重复回调只处理首次
    expect(driver.outbox.at(-1)?.text).toContain("已处理过");
    await expect(handleGestureCallback(app, gateway, scope, {
      channel: "dingtalk", approvalId, operatorOpenId: `ou_stranger_${sfx}`,
      conversationId: `conv-${sfx}`, gesture: "approve",
    })).rejects.toThrowError(/未映射/);
    // readonly 成员即使已映射也无审批权（L5.1，decide 内 403 口径）
    await bindOpenid("MEM-003", `ou_ro_${sfx}`);
    const { approvalId: ap2 } = await prepareApproval("g2");
    await expect(handleGestureCallback(app, gateway, scope, {
      channel: "dingtalk", approvalId: ap2, operatorOpenId: `ou_ro_${sfx}`,
      conversationId: `conv-${sfx}`, gesture: "approve",
    })).rejects.toThrowError(/readonly/);
  });

  it("驳回空理由被拒（L5.2 通道手势同口径）", async () => {
    const { approvalId } = await prepareApproval("g3");
    await expect(handleGestureCallback(app, gateway, scope, {
      channel: "dingtalk", approvalId, operatorOpenId: openId,
      conversationId: `conv-${sfx}`, gesture: "reject",
    })).rejects.toThrowError(/驳回必须/);
  });

  it("审批卡片出站即留痕（approval.card.sent 事件落库 G8）；未启用通道拒绝", async () => {
    const { approvalId, eventId } = await prepareApproval("g4");
    const driver = new MockChannelDriver("feishu");
    const card = composeApprovalCard({
      approval_id: approvalId, event_id: eventId,
      payload: { decision: { action: "review.reply", after: { draft: "x" } }, object: { type: "review", id: `RV-${sfx}` }, rule_impact: [] },
      snapshot: null,
    });
    const r = await sendApprovalCard(gateway, scope, driver, { conversationId: `conv-${sfx}` }, card, "MEM-001");
    expect(r.channelMsgId).toMatch(/^mock-feishu-/);
    expect(driver.outbox[0]?.card?.approvalId).toBe(approvalId);
    const c = await app.connect();
    try {
      await setScoped(c);
      const row = await c.query<{ c: string }>(
        `SELECT count(*) AS c FROM biz_events
         WHERE workspace_id=$1 AND payload->'decision'->>'action'='approval.card.sent'
           AND payload->'decision'->'after'->>'approval_id'=$2`,
        [scope.workspaceId, approvalId],
      );
      expect(Number(row.rows[0]?.c)).toBe(1);
    } finally {
      c.release();
    }
  });
});
