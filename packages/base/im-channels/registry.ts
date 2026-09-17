/**
 * im-channels · 通道注册表（D14：IM 通道接入；B11）
 * 铁律：
 *  - 通道枚举必须与 DDL `approvals.channel` CHECK 约束对账（inapp/dingtalk/wecom/feishu/slack）——对不上即拒绝注册
 *  - 首批仅启用官方 SDK 三通道（dingtalk/wecom/feishu，经 dsh-im）；inapp=本地回环（D7 既有口径）
 *  - 微信（iLink 长轮询）/WhatsApp（baileys 非官方协议）在观察名单，不注册（D14）
 */

/** 审批通道枚举（DDL CHECK 事实源镜像；改 DDL 时此处必须同步，测试锁定对账） */
export const APPROVAL_CHANNEL_ENUM = ["inapp", "dingtalk", "wecom", "feishu", "slack"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNEL_ENUM)[number];

export interface ChannelDescriptor {
  /** 通道 ID（= approvals.channel 值） */
  id: ApprovalChannel;
  /** 中文名（UI 展示口径） */
  label: string;
  /** dsh-im 渠道 key（D14：L1 通道适配层；inapp 无对应） */
  dshImKey: "dingtalk" | "wecom" | "feishu" | null;
  /** 流式输出能力（dsh-im 口径：微信不支持——未启用；三官方通道均支持） */
  streaming: boolean;
  /** 接入方式（dsh-im：扫码 / 手动凭据 / 两者） */
  onboarding: "qr" | "credential" | "both";
  /** 状态：enabled=首批启用（D14）；planned=枚举位保留待补（slack） */
  status: "enabled" | "planned";
}

/** 通道注册表（唯一事实源；D14 首批启用三官方通道 + inapp 回环） */
export const CHANNEL_REGISTRY: readonly ChannelDescriptor[] = [
  { id: "inapp",   label: "应用内",   dshImKey: null,      streaming: false, onboarding: "credential", status: "enabled" },
  { id: "dingtalk", label: "钉钉",    dshImKey: "dingtalk", streaming: true,  onboarding: "both",       status: "enabled" },
  { id: "wecom",    label: "企业微信", dshImKey: "wecom",    streaming: true,  onboarding: "both",       status: "enabled" },
  { id: "feishu",   label: "飞书",    dshImKey: "feishu",   streaming: true,  onboarding: "both",       status: "enabled" },
  { id: "slack",    label: "Slack",   dshImKey: null,       streaming: true,  onboarding: "credential", status: "planned" },
] as const;

export class ChannelError extends Error {
  constructor(
    public readonly code: "UNKNOWN_CHANNEL" | "CHANNEL_NOT_ENABLED" | "IDENTITY_UNMAPPED" | "INVALID_MESSAGE",
    message: string,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export function getChannel(id: string): ChannelDescriptor {
  const ch = CHANNEL_REGISTRY.find((c) => c.id === id);
  if (!ch) {
    throw new ChannelError(
      "UNKNOWN_CHANNEL",
      `未知通道「${id}」——必须在 approvals.channel 枚举内（${APPROVAL_CHANNEL_ENUM.join("/")}）`,
    );
  }
  if (ch.status !== "enabled") {
    throw new ChannelError("CHANNEL_NOT_ENABLED", `通道「${id}」尚未启用（${ch.status}，D14 首批仅官方三通道）`);
  }
  return ch;
}

/** 注册表 ↔ DDL 枚举对账（测试锁定：任一漂移即失败） */
export function registryMatchesDdl(): boolean {
  const reg = CHANNEL_REGISTRY.map((c) => c.id).sort();
  const ddl = [...APPROVAL_CHANNEL_ENUM].sort();
  return reg.length === ddl.length && reg.every((id, i) => id === ddl[i]);
}

export function listChannels(): ChannelDescriptor[] {
  return [...CHANNEL_REGISTRY];
}
