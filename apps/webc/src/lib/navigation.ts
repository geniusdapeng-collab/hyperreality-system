import type { BottomTabItem, IconName } from "@workloom/ui";
import type { TabKey } from "./config";

export const C_TAB_ICONS: Readonly<Record<TabKey, IconName>> = {
  chat: "chat",
  service: "service",
  tickets: "ticket",
  messages: "notice",
  me: "account",
};

export const C_TAB_LABELS: Readonly<Record<TabKey, string>> = {
  chat: "对话",
  service: "服务",
  tickets: "工单",
  messages: "消息",
  me: "我的",
};

/** 将服务配置允许的入口投影为共享 BottomTabs 数据，未读详情只进入用户可理解的标签。 */
export function cBottomTabItems(enabled: readonly TabKey[], unread: number): BottomTabItem[] {
  const safeUnread = Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : 0;
  return enabled.map((key) => ({
    id: key,
    label: C_TAB_LABELS[key],
    icon: C_TAB_ICONS[key],
    ...(key === "messages" && safeUnread > 0
      ? { badge: safeUnread > 99 ? "99+" : safeUnread, badgeLabel: `${safeUnread} 条未读` }
      : {}),
  }));
}

export function tabFromHash(hash: string, enabled: readonly TabKey[]): TabKey {
  const requested = hash.replace(/^#/, "") as TabKey;
  return enabled.includes(requested) ? requested : (enabled[0] ?? "chat");
}

export function tabUrl(pathname: string, search: string, tab: TabKey): string {
  return `${pathname}${search}#${tab}`;
}
