/**
 * service-channels · 推送（pushMessage）
 *
 * 驱动分层：微信订阅消息 / 支付宝服务通知为「接口预留」（未配凭据时调用即抛，不静默假成功）；
 * 内置 MockPushDriver 投递到内存通知箱（演示/单测用）——mock 投递同样必落 c_notifications 可查，
 * 与真实投递同留痕纪律（L6.1 禁止静默换链路：落库行的 driver 字段如实标注）。
 */
import type { Queryable } from "../service-kb/kb.js";
import { CHANNEL_REGISTRY, type Channel } from "./channels.js";

export type NotificationKind = "ticket_update" | "message" | "system";

export interface PushInput {
  workspaceId: string;
  cUserId: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
}

export interface PushDriver {
  readonly driverKey: string;
  deliver(msg: {
    channel: Channel;
    openid: string;
    kind: NotificationKind;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/** Mock 驱动：投递到内存通知箱（box 可注入，便于跨调用查阅/断言） */
export class MockPushDriver implements PushDriver {
  readonly driverKey = "mock";
  constructor(public readonly box: Array<Record<string, unknown>> = []) {}
  async deliver(msg: {
    channel: Channel; openid: string; kind: NotificationKind; payload: Record<string, unknown>;
  }): Promise<void> {
    this.box.push({ ...msg, deliveredAt: new Date().toISOString() });
  }
}

/** 真实驱动发送 seam（凭据与 HTTP 由 server 层注入） */
export type RemoteSender = (msg: {
  openid: string; kind: NotificationKind; payload: Record<string, unknown>;
}) => Promise<void>;

/** 微信订阅消息（接口预留：未注入 sender 即抛，绝不静默假成功） */
export class WechatSubscribePushDriver implements PushDriver {
  readonly driverKey = "wechat-subscribe";
  constructor(private readonly sender?: RemoteSender) {}
  async deliver(msg: { channel: Channel; openid: string; kind: NotificationKind; payload: Record<string, unknown> }): Promise<void> {
    if (!this.sender) throw new Error("微信订阅消息接口未配置（预留位）：请注入 RemoteSender");
    await this.sender(msg);
  }
}

/** 支付宝服务通知（接口预留，同上） */
export class AlipayNotifyPushDriver implements PushDriver {
  readonly driverKey = "alipay-notify";
  constructor(private readonly sender?: RemoteSender) {}
  async deliver(msg: { channel: Channel; openid: string; kind: NotificationKind; payload: Record<string, unknown> }): Promise<void> {
    if (!this.sender) throw new Error("支付宝服务通知接口未配置（预留位）：请注入 RemoteSender");
    await this.sender(msg);
  }
}

export interface PushResult {
  notificationId: number;
  driver: string;
  status: string;
  /** true = 走内置 mock 驱动（演示路径，已落库可查） */
  mock: boolean;
}

/** 共享默认 mock 通知箱（未注入驱动时的演示投递去向） */
export const defaultMockBox: Array<Record<string, unknown>> = [];

export async function pushMessage(
  db: Queryable,
  input: PushInput,
  opts: { drivers?: Partial<Record<string, PushDriver>> } = {},
): Promise<PushResult> {
  const u = await db.query<{ channel: Channel; openid: string } & Record<string, unknown>>(
    `SELECT channel, openid FROM c_users WHERE id=$1 AND workspace_id=$2`,
    [input.cUserId, input.workspaceId],
  );
  const user = u.rows[0];
  if (!user) throw new Error(`C 端用户 ${input.cUserId} 不存在`);
  const meta = CHANNEL_REGISTRY[user.channel];
  const driver = opts.drivers?.[meta.pushDriver]
    ?? opts.drivers?.["mock"]
    ?? new MockPushDriver(defaultMockBox);

  await driver.deliver({
    channel: user.channel, openid: user.openid, kind: input.kind, payload: input.payload,
  });

  // mock 投递必落库可查（与真实投递同纪律；driver 字段如实标注链路）
  const ins = await db.query<{ id: number } & Record<string, unknown>>(
    `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status)
     VALUES ($1,$2,$3,$4,$5,$6,'delivered') RETURNING id`,
    [input.workspaceId, input.cUserId, user.channel, input.kind,
      JSON.stringify(input.payload), driver.driverKey],
  );
  return {
    notificationId: Number(ins.rows[0]!["id"]),
    driver: driver.driverKey,
    status: "delivered",
    mock: driver.driverKey === "mock",
  };
}
