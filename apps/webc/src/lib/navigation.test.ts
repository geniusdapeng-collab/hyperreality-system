import { describe, expect, it } from "vitest";
import { cBottomTabItems, tabFromHash, tabUrl } from "./navigation";

describe("C 端导航历史契约", () => {
  const enabled = ["chat", "tickets", "me"] as const;

  it("只恢复当前配置允许的入口", () => {
    expect(tabFromHash("#tickets", enabled)).toBe("tickets");
    expect(tabFromHash("#internal_raw_page", enabled)).toBe("chat");
  });

  it("生成可被浏览器前进后退恢复的地址", () => {
    expect(tabUrl("/service", "?site=public", "me")).toBe("/service?site=public#me");
  });

  it("把配置入口安全映射为共享底栏，并限制视觉角标", () => {
    expect(cBottomTabItems(["chat", "messages", "me"], 128)).toEqual([
      { id: "chat", label: "对话", icon: "chat" },
      { id: "messages", label: "消息", icon: "notice", badge: "99+", badgeLabel: "128 条未读" },
      { id: "me", label: "我的", icon: "account" },
    ]);
    expect(cBottomTabItems(["messages"], Number.NaN)[0]).not.toHaveProperty("badge");
  });
});
