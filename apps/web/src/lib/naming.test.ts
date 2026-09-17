import { afterEach, describe, expect, it } from "vitest";
import { displayNameOf, hydrateAliases, roleTitleOf } from "./naming";

afterEach(() => hydrateAliases([]));

describe("数字员工系统岗位名边界", () => {
  it("接受中文岗位名，拒绝混入机器字段或英文错误的岗位名", () => {
    expect(roleTitleOf("客户协作专员", "company-ceo")).toBe("客户协作专员");
    expect(roleTitleOf("岗位 workspace_id", "company-ceo")).toBe("数字总经理");
    expect(roleTitleOf("岗位 InternalServerError", "company-ceo")).toBe("数字总经理");
  });

  it("显示名仍原样保留用户设置的别名", () => {
    hydrateAliases([{ presetKey: "company-ceo", alias: "My CEO" }]);
    expect(displayNameOf({ presetKey: "company-ceo", roleName: "岗位 workspace_id" }))
      .toBe("My CEO");
  });
});
