import { describe, expect, it } from "vitest";
import { activationBundleSystemText, workspaceIndustryText } from "./systemText";

describe("账号页服务端系统文案边界", () => {
  it("净化起步方案文案并保留提交所需 slug", () => {
    const bundle = activationBundleSystemText({
      slug: "hotel-internal",
      displayName: "方案 workspace_id",
      description: "Internal Server Error",
    });

    expect(bundle).toEqual({
      slug: "hotel-internal",
      displayName: "行业起步方案",
      description: "方案说明暂时无法显示。",
    });
  });

  it("行业 slug 不会直接上屏，中文行业名保持可读", () => {
    expect(workspaceIndustryText("hotel-internal")).toBe("通用经营");
    expect(workspaceIndustryText("酒店经营")).toBe("酒店经营");
  });
});
