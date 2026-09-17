import { describe, expect, it } from "vitest";
import type { OnboardingStatus } from "../../components/SimBanner";
import { modelTestReplyText, onboardingStatusSystemText, publicationSystemText } from "./systemText";

function statusWithChecks(): OnboardingStatus {
  return {
    dataMode: "simulated",
    llm: { provider: "provider", model: "model", baseUrl: "url", real: false },
    workspace: { name: "测试工作区", events: 0, members: 0, agents: 0, memories: 0 },
    activationGate: {
      canActivate: false,
      blockers: [],
      checks: [{ key: "llm", label: "privateLabel", ok: false, detail: "检查 workspace_id" }],
    },
  };
}

describe("落地向导服务端文案边界", () => {
  it("净化激活门禁与发布渠道的名称和说明", () => {
    const status = onboardingStatusSystemText(statusWithChecks());
    const publication = publicationSystemText({
      channels: [{ label: "channel_label", detail: "Internal Server Error" }],
    });

    expect(status.activationGate?.checks[0]).toMatchObject({
      label: "运行条件",
      detail: "运行条件信息待确认",
    });
    expect(publication.channels[0]).toEqual({
      label: "服务渠道",
      detail: "渠道状态说明待确认",
    });
  });

  it("模型试调回复不透传内部文本", () => {
    expect(modelTestReplyText("连接成功，可正常回复")).toBe("连接成功，可正常回复");
    expect(modelTestReplyText("Internal Server Error workspace_id"))
      .toBe("模型已返回可验证结果。");
  });
});
