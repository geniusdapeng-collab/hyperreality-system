import { clientChineseText } from "@workloom/ui";
import type { OnboardingStatus } from "../../components/SimBanner";

interface PublicationSystemText {
  channels: Array<{ label: string; detail: string }>;
}

/** onboarding.status 中由服务端生成的门禁文案入 state 前收口。 */
export function onboardingStatusSystemText(status: OnboardingStatus): OnboardingStatus {
  if (!status.activationGate) return status;
  return {
    ...status,
    activationGate: {
      ...status.activationGate,
      checks: status.activationGate.checks.map((check) => ({
        ...check,
        label: clientChineseText(check.label, "运行条件"),
        detail: clientChineseText(check.detail, "运行条件信息待确认"),
      })),
    },
  };
}

/** 服务前台发布状态中的动态渠道文案入 state 前收口。 */
export function publicationSystemText<T extends PublicationSystemText>(publication: T): T {
  return {
    ...publication,
    channels: publication.channels.map((channel) => ({
      ...channel,
      label: clientChineseText(channel.label, "服务渠道"),
      detail: clientChineseText(channel.detail, "渠道状态说明待确认"),
    })),
  };
}

export function modelTestReplyText(value: unknown): string {
  return clientChineseText(value, "模型已返回可验证结果。");
}
