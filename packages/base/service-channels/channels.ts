/**
 * service-channels · 渠道注册表（wechat-mini / alipay / h5）
 * pushDriver 为推送实现键（push.ts 按此选驱动；真实接口预留，缺省 mock）。
 */

export const CHANNELS = ["wechat-mini", "alipay", "h5"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ChannelMeta {
  key: Channel;
  name: string;
  /** 推送驱动键：wechat-subscribe（微信订阅消息）/ alipay-notify（支付宝服务通知）/ mock */
  pushDriver: "wechat-subscribe" | "alipay-notify" | "mock";
}

export const CHANNEL_REGISTRY: Record<Channel, ChannelMeta> = {
  "wechat-mini": { key: "wechat-mini", name: "微信小程序", pushDriver: "wechat-subscribe" },
  alipay: { key: "alipay", name: "支付宝小程序", pushDriver: "alipay-notify" },
  h5: { key: "h5", name: "H5 网页", pushDriver: "mock" },
};

export function assertChannel(channel: string): asserts channel is Channel {
  if (!(CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`非法渠道「${channel}」（仅 ${CHANNELS.join("/")}）`);
  }
}
