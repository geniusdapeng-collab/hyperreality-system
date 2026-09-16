import { clientChineseText } from "@workloom/ui";

interface ActivationBundleSystemFields {
  displayName: string;
  description: string;
}

/** 自助开通注册表中的 Bundle 展示文案在进入页面 state 前收口。 */
export function activationBundleSystemText<T extends ActivationBundleSystemFields>(
  bundle: T,
): Omit<T, keyof ActivationBundleSystemFields> & ActivationBundleSystemFields {
  return {
    ...bundle,
    displayName: clientChineseText(bundle.displayName, "行业起步方案"),
    description: clientChineseText(bundle.description, "方案说明暂时无法显示。"),
  };
}

/** 工作区接口返回的是 Bundle 行业字段；未知 slug 不直接进入普通客户端。 */
export function workspaceIndustryText(value: unknown): string {
  return clientChineseText(value, "通用经营");
}
