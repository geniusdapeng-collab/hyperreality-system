import { describe, expect, it } from "vitest";
import {
  canEditWizard,
  normalizeWizardDraftPayload,
  onboardingIdentityKey,
  replayWelcome,
  saveWelcomeProgress,
  welcomeProgress,
} from "./onboarding-continuity.js";

describe("首次欢迎服务端连续性", () => {
  it("优先按账号续播，无账号的历史成员才退回成员身份", () => {
    expect(onboardingIdentityKey("acc-1", "mem-a")).toBe("account:acc-1");
    expect(onboardingIdentityKey("acc-1", "mem-b")).toBe("account:acc-1");
    expect(onboardingIdentityKey(null, "mem-a")).toBe("member:mem-a");
  });

  it("未登录预览不读写共享数据库，也不会污染其他访客的完成态", async () => {
    const guest = { memberId: "guest", memberNo: "GUEST", role: "readonly" };
    await expect(welcomeProgress("ws-preview", guest)).resolves.toMatchObject({
      persisted: false,
      status: "not_started",
      currentStep: "start",
      shouldShow: true,
    });
    await expect(saveWelcomeProgress("ws-preview", guest, {
      status: "paused",
      currentStep: "team",
    })).resolves.toMatchObject({ persisted: false, status: "paused", currentStep: "team" });
    await expect(replayWelcome("ws-preview", guest)).resolves.toMatchObject({
      persisted: false,
      status: "not_started",
      replayCount: 0,
    });
  });
});

describe("标准落地向导草稿契约", () => {
  it("服务层只保留可续办字段，密钥、正文和未知底层字段一律不持久化", () => {
    expect(normalizeWizardDraftPayload({
      provider: "deepseek",
      model: "deepseek-chat",
      businessName: "示例企业",
      apiKey: "sk-must-not-persist",
      documentBody: "内部制度全文",
      raw_field_name: "底层字段",
      note: 42,
    })).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      businessName: "示例企业",
    });
  });

  it("责任人可编辑，所有者与管理员可接管，普通非责任人不能覆盖", () => {
    const identity = (memberId: string, role: string) => ({ memberId, memberNo: memberId, role });
    expect(canEditWizard(identity("mem-a", "staff"), "mem-a")).toBe(true);
    expect(canEditWizard(identity("mem-owner", "owner"), "mem-a")).toBe(true);
    expect(canEditWizard(identity("mem-manager", "manager"), "mem-a")).toBe(true);
    expect(canEditWizard(identity("mem-b", "staff"), "mem-a")).toBe(false);
  });
});
