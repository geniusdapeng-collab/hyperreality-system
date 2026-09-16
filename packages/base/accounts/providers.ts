/**
 * accounts/providers —— 外部通道 seam：短信发送 / 微信 OAuth。
 * 生产注入真实实现（云短信/微信开放平台）。DevEcho 只允许在明确配置的
 * 非生产开发/演示环境启用；未接入真实供应商时必须失败关闭，不能向客户端
 * 返回“已发送”这类虚假成功。
 */
export interface SmsSender {
  send(target: string, text: string): Promise<void>;
}

export interface WeChatOAuth {
  /** 扫码 ticket → 换取 openid（轮询回调） */
  exchangeOpenid(qrTicket: string): Promise<{ openid: string; nickname?: string } | null>;
  /** 生成扫码链接/ticket */
  createQrTicket(scene: string): Promise<{ ticket: string; url: string }>;
}

/** 开发/演示通道：不真发短信，验证码通过返回值与事件留痕透出 */
export class DevEchoSms implements SmsSender {
  sent: Array<{ target: string; text: string }> = [];
  async send(target: string, text: string): Promise<void> {
    this.sent.push({ target, text });
    console.warn(`[accounts][dev-sms] → ${target}: ${text}`);
  }
}

/** 未配置通道：显式失败，供 API 把真实状态呈现给用户。 */
export class UnavailableSms implements SmsSender {
  constructor(private readonly reason = "短信通道未配置，请联系管理员完成配置") {}

  async send(): Promise<never> {
    throw new Error(this.reason);
  }
}

export interface SmsSenderConfig {
  driver?: string;
  nodeEnv?: string;
}

/**
 * 账号短信通道装配门禁。
 * - dev：仅非 production 可用，且必须显式配置；
 * - 其他驱动：在真实适配器被注入前一律失败关闭；
 * - 未配置：失败关闭。
 */
export function createSmsSender(config: SmsSenderConfig): SmsSender {
  const driver = config.driver?.trim().toLowerCase();
  if (driver === "dev" && config.nodeEnv !== "production") return new DevEchoSms();
  if (driver === "dev") {
    return new UnavailableSms("生产环境禁止使用开发短信通道，请配置真实短信服务商");
  }
  if (driver) {
    return new UnavailableSms(`短信通道“${driver}”尚未安装可用适配器，请联系管理员`);
  }
  return new UnavailableSms();
}

/** 微信未接入时的占位实现：始终返回 null（登录页提示「微信通道未配置」） */
export class NullWeChat implements WeChatOAuth {
  async exchangeOpenid(): Promise<null> { return null; }
  async createQrTicket(): Promise<never> { throw new Error("微信扫码通道未配置（WECHAT_APP_ID/SECRET）"); }
}
