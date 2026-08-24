/**
 * im-channels · 手势回调（D14/B11：通道内三手势 → approvals 域写回）
 * 铁律继承（全部复用 review-console decide，不在本层重造）：
 *  - L5.2 驳回必填原因枚举；编辑必带新值（decide 内校验）
 *  - L5.3 重复回调只处理首次（approvals UNIQUE(event_id,channel) + 状态机幂等）
 *  - L5.1 readonly 无审批权（服务端 403 口径→本层抛 ChannelError.IDENTITY_UNMAPPED/FORBIDDEN）
 *  - E5.3 快照过期拒收（decide 内 EXPIRED）
 *  - F5.6 三端权限一致：通道手势与 P3/P4 手势同一 decide 入口，权重 1/2/3 语义不变
 * 身份：操作人 openid 必须经 im_openids 映射到成员（E5.2）；未映射=外部联系人无权审批
 */
import type pg from "pg";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decide, type GestureInput } from "../review-console/approvals.js";
import { ChannelError, getChannel, type ApprovalChannel } from "./registry.js";
import { resolveMemberByOpenid } from "./inbound.js";
import type { ChannelDriver } from "./cards.js";

/* ================= P0-1 通道验签 seam =================
 * 契约（与 dsh-im 桥约定）：
 *  - 头：x-channel-timestamp（秒级 Unix 时间）、x-channel-signature（hex HMAC-SHA256）
 *  - 载荷：HMAC(secret, `${timestamp}.${body}`)；body = 回调 payload 的稳定 JSON（键序无关）
 *  - secret 按渠道 env 注入：IM_CHANNEL_SECRET_DINGTALK / _WECOM / _FEISHU
 *  - 重放窗口 ±5 分钟（超时即拒，防抓包重放）
 * 降级：开发缺省 secret 时 verified=false 且 unsigned=true——调用方必须降级为
 *      「仅允许会话成员本人操作」（operatorOpenId=会话成员绑定 openid），并在响应标注 unsigned:true。
 */

/** 稳定 JSON 序列化（对象键排序；数组保序）——验签 body 的确定性口径 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** 类 Headers 结构（fetch Headers / 普通头表均可适配） */
export interface HeaderLike { get(name: string): string | null }

export interface ChannelSignatureResult {
  /** 验签通过（secret 已配置且 HMAC 比对一致、时间在重放窗口内） */
  verified: boolean;
  /** true = 开发缺省 secret，未验签（调用方走本人降级并标注 unsigned:true） */
  unsigned: boolean;
  reason?: string;
}

/** 重放窗口：±5 分钟 */
const REPLAY_WINDOW_MS = 5 * 60_000;

export function channelSecret(channel: ApprovalChannel): string | undefined {
  return process.env[`IM_CHANNEL_SECRET_${channel.toUpperCase()}`];
}

/**
 * 通道回调签名验证（P0-1 seam）
 * @param headers 请求头（x-channel-timestamp / x-channel-signature）
 * @param body    回调 payload 稳定 JSON（stableStringify(input)）
 */
export function verifyChannelSignature(
  channel: ApprovalChannel,
  headers: HeaderLike,
  body: string,
): ChannelSignatureResult {
  const secret = channelSecret(channel);
  if (!secret) {
    return { verified: false, unsigned: true, reason: `IM_CHANNEL_SECRET_${channel.toUpperCase()} 未配置（开发降级：仅允许会话成员本人操作）` };
  }
  const ts = headers.get("x-channel-timestamp");
  const sig = headers.get("x-channel-signature");
  if (!ts || !sig) return { verified: false, unsigned: false, reason: "缺少 x-channel-timestamp / x-channel-signature 头" };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t * 1000) > REPLAY_WINDOW_MS) {
    return { verified: false, unsigned: false, reason: "时间戳超出 ±5 分钟重放窗口" };
  }
  const expect = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expect, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { verified: false, unsigned: false, reason: "HMAC-SHA256 签名比对不一致" };
  }
  return { verified: true, unsigned: false };
}

export interface GestureCallback {
  channel: ApprovalChannel;
  /** 回调锚点：审批单 ID（卡片出站时的 approvalId） */
  approvalId: string;
  /** 操作人 openid（平台侧；必须可映射到本工作区成员） */
  operatorOpenId: string;
  /** 会话 ID（回执发卡目标） */
  conversationId: string;
  gesture: "approve" | "edit" | "reject";
  reasonEnum?: string;
  reasonText?: string;
  editedAfter?: unknown;
}

export interface GestureCallbackResult {
  approvalId: string;
  status: string;
  deduped: boolean;
  operator: string;
}

/**
 * 处理通道手势回调
 * @param driver 回执出站驱动（原地更新语义简化为回发结果文本，D7；真实通道的卡片原地刷新在 dsh-im 驱动侧实现）
 */
export async function handleGestureCallback(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  cb: GestureCallback,
  driver?: ChannelDriver,
): Promise<GestureCallbackResult> {
  getChannel(cb.channel);
  // E5.2/F5.6：操作人必须是本工作区成员（openid 映射），外部联系人无权审批
  const member = await resolveMemberByOpenid(app, scope, cb.channel, cb.operatorOpenId);
  if (!member) {
    throw new ChannelError(
      "IDENTITY_UNMAPPED",
      `通道 ${cb.channel} 操作人 ${cb.operatorOpenId} 未映射到本工作区成员（E5.2 im_openids），无权审批`,
    );
  }
  const gesture: GestureInput = {
    type: cb.gesture,
    reasonEnum: cb.reasonEnum,
    reasonText: cb.reasonText,
    editedAfter: cb.editedAfter,
  };
  // decide 内聚全部纪律：L5.1 角色 / L5.2 手势校验 / L5.3 幂等 / E5.3 过期 / 权重 1/2/3 / 记忆校准回流（F1.7）
  const r = await decide(
    app,
    gateway,
    scope,
    { memberNo: member.memberNo, role: member.role as never },
    cb.approvalId,
    gesture,
  );
  const result: GestureCallbackResult = {
    approvalId: r.approvalId,
    status: r.status,
    deduped: r.deduped,
    operator: member.memberNo,
  };
  // 手势回执回写通道（F5.5 手势回写口径；重复回调明示「已处理过」）
  // #21 修复：回执发送是 best-effort，失败不应让成功的审批操作「看起来失败」
  if (driver) {
    const text = r.deduped
      ? `审批 ${r.approvalId} 已处理过（当前状态 ${r.status}，L5.3 幂等），本次回调不重复生效`
      : `审批 ${r.approvalId} 已${r.status === "approved" ? "采纳" : r.status === "edited" ? "编辑后采纳" : "驳回"}（操作人 ${member.name}，通道手势与端内同权 F5.6）`;
    try {
      await driver.sendText({ conversationId: cb.conversationId }, text);
    } catch (err) {
      // 回执发送失败（IM 平台抖动）只记录日志，不影响审批操作结果
      console.warn(`[im-channels] 回执发送失败（审批 ${r.approvalId}，通道 ${cb.channel}）：`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}
