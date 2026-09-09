/**
 * accounts/providers —— 外部通道 seam：短信发送 / 微信 OAuth。
 * 生产注入真实实现（云短信/微信开放平台）；开发与自包含装机默认 DevEcho 实现
 * （验证码写入 login_events.detail.devCode 并打印日志，演示可用、生产必须替换——
 * 与模型路由的 mock 档同一纪律： seam 先行，供应商可换）。
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

/** 微信未接入时的占位实现：始终返回 null（登录页提示「微信通道未配置」） */
export class NullWeChat implements WeChatOAuth {
  async exchangeOpenid(): Promise<null> { return null; }
  async createQrTicket(): Promise<never> { throw new Error("微信扫码通道未配置（WECHAT_APP_ID/SECRET）"); }
}
