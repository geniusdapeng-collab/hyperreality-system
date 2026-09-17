/**
 * im-channels · 入站归一化（D14/B11：外部 IM 消息 → 五元事件）
 * 链路：dsh-im（L1 通道适配层）收到通道消息 → server im.inbound 转发至此 →
 *       归一化校验 → openid→成员映射（members.im_openids，E5.2 预留位）→
 *       网关三段瀑布落五元事件（G8 留痕 100%；PII 脱敏段天然覆盖通道文本）
 * 幂等：同一 (channel, channel_msg_id) 重复投递只落首条（L1.4 同口径，通道重推是常态）
 */
import type pg from "pg";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { ChannelError, getChannel, type ApprovalChannel } from "./registry.js";

/** RLS 会话上下文封装（同 review-console 口径：每个 client 连接重设 set_config，池不共享会话级设置） */
async function scoped<T>(
  pool: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 归一化入站消息（dsh-im 各渠道 runtime 输出归一到此结构；bind 时已做平台差异抹平） */
export interface InboundMessage {
  channel: ApprovalChannel;
  /** 通道侧消息唯一 ID（幂等键） */
  channelMsgId: string;
  /** 会话标识（私聊=对方 ID；群聊=群 ID） */
  conversationId: string;
  /** 群聊/私聊 */
  kind: "direct" | "group";
  /** 发送者 openid（平台侧用户标识；经 im_openids 映射成员） */
  senderOpenId: string;
  /** 文本正文（首版只接文字；富文本/附件后置） */
  text: string;
  /** 通道侧发送时间（缺省=服务端接收时间） */
  sentAt?: string;
}

/** 入站处理结果 */
export interface InboundResult {
  eventId: string | null;
  deduped: boolean;
  /** 成员映射结果：member=已映射（who=MEM-xxx）；visitor=未映射外部联系人（who.id=ext:…，只读口径） */
  identity: "member" | "visitor";
  memberNo?: string;
}

/** openid → 成员映射（E5.2：members.im_openids JSONB，形如 {"dingtalk":"ou_xxx"}；L7.1 越权返回空） */
export async function resolveMemberByOpenid(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  channel: ApprovalChannel,
  openId: string,
): Promise<{ memberNo: string; role: string; name: string } | null> {
  return scoped(app, scope, async (c) => {
    const r = await c.query<{ member_no: string; role: string; name: string }>(
      `SELECT member_no, role, name FROM members
       WHERE workspace_id=$1 AND im_openids->>$2 = $3`,
      [scope.workspaceId, channel, openId],
    );
    const row = r.rows[0];
    return row ? { memberNo: row.member_no, role: row.role, name: row.name } : null;
  });
}

/** 反向查询：会话成员在该通道绑定的 openid（P0-1 未验签降级用：仅允许本人操作） */
export async function boundOpenidOfMember(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  channel: ApprovalChannel,
  memberNo: string,
): Promise<string | null> {
  return scoped(app, scope, async (c) => {
    const r = await c.query<{ openid: string | null }>(
      `SELECT im_openids->>$2 AS openid FROM members
       WHERE workspace_id=$1 AND member_no=$3`,
      [scope.workspaceId, channel, memberNo],
    );
    return r.rows[0]?.openid ?? null;
  });
}

/** 入站归一化校验（纯函数，可单测；坏消息直接拒，不落库） */
export function validateInbound(msg: InboundMessage): void {
  getChannel(msg.channel); // 未启用/未知通道在此抛 ChannelError
  if (!msg.channelMsgId?.trim()) throw new ChannelError("INVALID_MESSAGE", "缺 channel_msg_id（幂等键必填）");
  if (!msg.conversationId?.trim()) throw new ChannelError("INVALID_MESSAGE", "缺 conversation_id");
  if (!msg.senderOpenId?.trim()) throw new ChannelError("INVALID_MESSAGE", "缺 sender_open_id");
  if (!msg.text?.trim()) throw new ChannelError("INVALID_MESSAGE", "首版仅支持文字消息（D14 口径同 dsh-im）");
  if (msg.text.length > 2000) throw new ChannelError("INVALID_MESSAGE", "通道消息 ≤2000 字");
}

/** 通道消息去重查询（L1.4 同口径：按 (channel, channel_msg_id) 查事件库投影）
 * @deprecated #29 起 ingestInbound 改走 im_inbound_dedupe 幂等键表（原子占位）；
 * 本函数仅保留作排障/审计查询，禁止再用于写入前查重（TOCTOU）。 */
export async function findInboundEvent(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  channel: ApprovalChannel,
  channelMsgId: string,
): Promise<string | null> {
  return scoped(app, scope, async (c) => {
    const r = await c.query<{ event_id: string }>(
      `SELECT event_id FROM biz_events
       WHERE workspace_id=$1
         AND payload->'decision'->>'action' = 'im.message'
         AND payload->'decision'->'after'->>'channel_msg_id' = $2
         AND payload->'context'->>'channel' = $3
       LIMIT 1`,
      [scope.workspaceId, channelMsgId, channel],
    );
    return r.rows[0]?.event_id ?? null;
  });
}

/**
 * 入站消息落五元事件（经网关三段瀑布；PII 脱敏段天然覆盖——通道文本里的手机号/身份证不落明文 F1.10）
 * 重复投递幂等：已落过即返回原 eventId，deduped=true
 *
 * #29 修复（TOCTOU）：原实现「findInboundEvent 查重 → gatewayAppend 写事件」非原子，
 * 通道并发重推（重试风暴/多实例）可双写。改用 im_inbound_dedupe 幂等键表（0003 迁移）：
 * 主键占位先行（冲突即重复投递）→ 写事件 → 回填 event_id；事件写入失败补偿删占位。
 */
export async function ingestInbound(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  msg: InboundMessage,
): Promise<InboundResult> {
  validateInbound(msg);

  // ① 幂等键占位（原子）：冲突 = 重复投递，回查原 event_id 直接返回
  const claimed = await scoped(app, scope, async (c) => {
    const ins = await c.query(
      `INSERT INTO im_inbound_dedupe (workspace_id, channel, channel_msg_id, event_id)
       VALUES ($1,$2,$3,'') ON CONFLICT DO NOTHING`,
      [scope.workspaceId, msg.channel, msg.channelMsgId],
    );
    if ((ins.rowCount ?? 0) > 0) return { claimed: true as const };
    const exist = await c.query<{ event_id: string }>(
      `SELECT event_id FROM im_inbound_dedupe WHERE workspace_id=$1 AND channel=$2 AND channel_msg_id=$3`,
      [scope.workspaceId, msg.channel, msg.channelMsgId],
    );
    return { claimed: false as const, eventId: exist.rows[0]?.event_id ?? "" };
  });
  if (!claimed.claimed) {
    // 占位已存在：event_id 已回填 → 重复投递；空串 = 历史运行窄窗口残留，按已处理口径返回
    return { eventId: claimed.eventId || null, deduped: true, identity: "visitor" };
  }

  const member = await resolveMemberByOpenid(app, scope, msg.channel, msg.senderOpenId);
  const whoId = member ? member.memberNo : `ext:${msg.channel}:${msg.senderOpenId}`;
  // D16（#1/A）：占位、事件、回填同一事务同一 COMMIT——#29 的「失败补偿删占位」
  // 由原子性天然取代（事件写失败整事务滚回，占位随之消失，通道重推可安全重试）
  const r = await scoped(app, scope, async (c) => {
    const res = await gatewayAppendOnClient(c, {
      ...scope,
      actor: { id: whoId, type: "human" },
    }, {
      who: { type: "human", id: whoId },
      context: {
        tenant_id: scope.tenantId,
        workspace_id: scope.workspaceId,
        time: msg.sentAt ?? new Date().toISOString(),
        channel: msg.channel,
      },
      object: { type: "im_conversation", id: `${msg.channel}:${msg.conversationId}` },
      decision: {
        action: "im.message",
        after: {
          text: msg.text,
          kind: msg.kind,
          channel_msg_id: msg.channelMsgId,
          sender_open_id: msg.senderOpenId,
          mapped_member: member?.memberNo ?? null,
        },
      },
      rule_impact: [],
    });
    // ② 回填 event_id（重复投递时据此返回原编号）——与事件同一事务
    await c.query(
      `UPDATE im_inbound_dedupe SET event_id=$4 WHERE workspace_id=$1 AND channel=$2 AND channel_msg_id=$3`,
      [scope.workspaceId, msg.channel, msg.channelMsgId, res.eventId],
    );
    return res;
  });
  return {
    eventId: r.eventId,
    deduped: false,
    identity: member ? "member" : "visitor",
    memberNo: member?.memberNo,
  };
}
