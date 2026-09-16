import { describe, expect, it } from "vitest";
import { ServiceWorkspaceRoutingError, selectServiceWorkspaceId } from "./workspace-routing.js";

describe("C 端工作区可信路由", () => {
  it("单租户固定配置优先", () => {
    expect(selectServiceWorkspaceId({
      fixedWorkspaceId: " ws-fixed ",
      workspaceMap: JSON.stringify({ site: "ws-mapped" }),
      workspaceKey: "site",
    })).toBe("ws-fixed");
  });

  it("多站点只按明确 workspaceKey 映射", () => {
    expect(selectServiceWorkspaceId({
      workspaceMap: JSON.stringify({ public: "ws-public", partner: "ws-partner" }),
      workspaceKey: "partner",
    })).toBe("ws-partner");
  });

  it.each([
    {},
    { workspaceMap: "{}", workspaceKey: "missing" },
    { workspaceMap: "not-json", workspaceKey: "public" },
    { workspaceMap: "[]", workspaceKey: "public" },
  ])("配置不可信时 fail closed：%j", (input) => {
    expect(() => selectServiceWorkspaceId(input)).toThrow(ServiceWorkspaceRoutingError);
  });
});
