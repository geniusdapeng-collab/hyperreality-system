import { describe, expect, it } from "vitest";
import { inboxSpeechText } from "./speechText";

describe("小织 Inbox 语音中文边界", () => {
  it("只播报通过客户端中文边界的片段", () => {
    expect(inboxSpeechText("有一项待审批", "workspace_id leaked")).toBe("有一项待审批");
    expect(inboxSpeechText("privateTitle", "请打开详情查看")).toBe("请打开详情查看");
  });

  it("标题与正文均非法时播报中性提醒", () => {
    expect(inboxSpeechText("privateTitle", "workspace_id leaked"))
      .toBe("有一条重要提醒，请打开小织查看详情");
  });
});
