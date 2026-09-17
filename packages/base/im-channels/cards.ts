/**
 * im-channels · 审批卡片出站（D14/B11：M5 审批 IM 卡片从 inapp 本地回环升级为多通道）
 *  - 卡片 = approvals 队列项的通道投影（diff/命中规则/影响面与 P4 同源，F5.1 统一队列口径）
 *  - 出站即留痕：approval.card.sent 五元事件（G8；谁发到哪个通道哪个会话可查）
 *  - 驱动抽象 ChannelDriver：mock=内存出站盒（无凭据全流程可跑，D4 同纪律）；
 *    dsh-im 驱动（真实通道）由 server 层装配，凭据在 dsh 设置页配置、永不经事件明文（L7.3）
 *  - 原地更新语义（D7）：手势回调后由回调侧回发结果卡，通道幂等由 approvals UNIQUE(event_id,channel) 兜底
 */
import type pg from "pg";
import { gatewayAppend } from "../workdata/gateway.js";
import { getChannel, type ApprovalChannel } from "./registry.js";

/** 通道审批卡片（通道无关的中间结构；各驱动自行映射为 AI Card/富文本） */
export interface ApprovalCard {
  /** 审批单 ID（回调回传键，L5.3 幂等锚点） */
  approvalId: string;
  /** 关联动作事件（#E 编号，决策链路入口 F1.12） */
  eventId: string;
  title: string;
  /** 动作摘要（decision.action + 对象） */
  action: string;
  objectLabel: string;
  /** diff 投影（before 删线/after 高亮由通道侧渲染） */
  before?: unknown;
  after?: unknown;
  /** 命中规则（rule_id:result 列表） */
  ruleHits: string[];
  /** 三手势（F5.2；高危不自动放行 L5.4 由队列侧保证） */
  gestures: ["approve", "edit", "reject"];
  /** 快照截止（E5.3；过期卡片在回调侧拒收） */
  expiresAt: string | null;
}

export interface ApprovalCardSource {
  approval_id: string;
  event_id: string;
  payload: {
    who?: { id?: string };
    decision?: { action?: string; before?: unknown; after?: unknown; basis?: string[] };
    object?: { type?: string; id?: string; label?: string };
    rule_impact?: Array<{ rule_id: string; result: string }>;
  };
  snapshot?: { expires_at?: string } | null;
}

/** 组装审批卡片（纯函数，可单测；字段与 P4 审批卡同源投影） */
export function composeApprovalCard(row: ApprovalCardSource): ApprovalCard {
  const p = row.payload;
  const action = p.decision?.action ?? "";
  const obj = p.object?.label ?? p.object?.id ?? p.object?.type ?? "";
  return {
    approvalId: row.approval_id,
    eventId: row.event_id,
    title: `审批 ${row.approval_id} · ${action}`,
    action,
    objectLabel: String(obj),
    before: p.decision?.before,
    after: p.decision?.after,
    ruleHits: (p.rule_impact ?? []).map((r) => `${r.rule_id}:${r.result}`),
    gestures: ["approve", "edit", "reject"],
    expiresAt: row.snapshot?.expires_at ?? null,
  };
}

/** 通道驱动抽象（首版两实现：mock / dsh-im RPC；server 层装配） */
export interface ChannelDriver {
  readonly channel: ApprovalChannel;
  /** 发送审批卡片到会话；返回通道侧卡片消息 ID（原地更新锚点） */
  sendCard(target: { conversationId: string }, card: ApprovalCard): Promise<{ channelMsgId: string }>;
  /** 发送纯文本（手势回执/错误提示） */
  sendText(target: { conversationId: string }, text: string): Promise<{ channelMsgId: string }>;
}

export class ChannelDriverError extends Error {
  constructor(channel: string, cause: unknown) {
    super(`通道「${channel}」出站失败：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ChannelDriverError";
  }
}

/**
 * Mock 通道驱动（D4 同纪律：无真实凭据全流程可跑）
 * 出站进内存出站盒（可断言/可检索）；回调由测试/演示脚本注入
 */
export class MockChannelDriver implements ChannelDriver {
  readonly outbox: Array<{ kind: "card" | "text"; target: { conversationId: string }; card?: ApprovalCard; text?: string; channelMsgId: string }> = [];
  #seq = 0;
  constructor(readonly channel: ApprovalChannel) {}
  async sendCard(target: { conversationId: string }, card: ApprovalCard) {
    const channelMsgId = `mock-${this.channel}-${++this.#seq}`;
    this.outbox.push({ kind: "card", target, card, channelMsgId });
    return { channelMsgId };
  }
  async sendText(target: { conversationId: string }, text: string) {
    const channelMsgId = `mock-${this.channel}-${++this.#seq}`;
    this.outbox.push({ kind: "text", target, text, channelMsgId });
    return { channelMsgId };
  }
}

/**
 * 审批卡片出站（校验通道 → 驱动发送 → 留痕事件）
 *
 * 外发口径（D16 例外，先发后写）：通道外发不可撤回，必须先发送成功再写留痕事件——
 * 若反过来「先写事件后发送」，发送失败会留下「未发却已留痕」的失真。
 * 代价是「已发未留痕」窗口：事件写失败时补写补偿事件（im.outbound.unrecorded，best-effort 一次），
 * 补偿也失败则抛错——调用方据此知晓外发已发生但留痕缺失，需人工介入对账。
 *
 * @returns 通道消息 ID + 留痕事件 ID（补偿路径 compensated=true）
 */
export async function sendApprovalCard(
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  driver: ChannelDriver,
  target: { conversationId: string },
  card: ApprovalCard,
  by: string,
): Promise<{ channelMsgId: string; eventId: string; compensated?: boolean }> {
  getChannel(driver.channel); // 未启用通道在此拒绝（D14）
  let sent: { channelMsgId: string };
  try {
    sent = await driver.sendCard(target, card);
  } catch (err) {
    throw new ChannelDriverError(driver.channel, err);
  }
  const actor = { id: "im-channels", type: "system" as const };
  const base = {
    who: { type: "system" as const, id: "im-channels" },
    context: {
      tenant_id: scope.tenantId,
      workspace_id: scope.workspaceId,
      time: new Date().toISOString(),
      channel: driver.channel,
    },
    rule_impact: [] as never[],
  };
  try {
    const ev = await gatewayAppend(gateway, { ...scope, actor }, {
      ...base,
      object: { type: "approval", id: card.approvalId },
      decision: {
        action: "approval.card.sent",
        after: {
          approval_id: card.approvalId, event_id: card.eventId,
          conversation_id: target.conversationId, channel_msg_id: sent.channelMsgId,
          title: card.title, rule_hits: card.ruleHits,
        },
        basis: [`由 ${by} 触发推送`],
      },
    });
    return { channelMsgId: sent.channelMsgId, eventId: ev.eventId };
  } catch (err) {
    // 已发未留痕：补写补偿事件（best-effort 一次；失败则抛错交人工对账）
    console.warn(`[im-channels] approval.card.sent 留痕写失败（审批 ${card.approvalId} 已外发 ${sent.channelMsgId}），补写补偿事件：`, err instanceof Error ? err.message : err);
    const comp = await gatewayAppend(gateway, { ...scope, actor }, {
      ...base,
      object: { type: "approval", id: card.approvalId },
      decision: {
        action: "im.outbound.unrecorded",
        after: {
          original_action: "approval.card.sent",
          approval_id: card.approvalId, event_id: card.eventId,
          conversation_id: target.conversationId, channel_msg_id: sent.channelMsgId,
          send_error: err instanceof Error ? err.message : String(err),
        },
        basis: ["补偿事件：卡片已外发但 approval.card.sent 留痕写失败（外发不可撤回，先发后写口径）"],
      },
    });
    return { channelMsgId: sent.channelMsgId, eventId: comp.eventId, compensated: true };
  }
}
