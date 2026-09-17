import { describe, expect, it } from "vitest";
import { mateScriptOf, type BundleWelcomeProjection } from "./welcomeScripts";

describe("mateScriptOf 客户端中文边界", () => {
  it("过滤行业投影中的内部字段和纯英文文案", () => {
    const script = mateScriptOf({
      system: ["财务团队已就位", "workspace_id", "Internal Server Error"],
      keywords: ["经营可追溯", "privateField", ""],
    });

    expect(script.system).toEqual(["财务团队已就位"]);
    expect(script.keywords).toEqual(["经营可追溯"]);
  });

  it("投影全部非法或结构异常时回到中性默认话术", () => {
    const invalid = { system: ["workspace_id"], keywords: ["privateField"] } as BundleWelcomeProjection;
    const malformed = { system: "raw_system", keywords: null } as unknown as BundleWelcomeProjection;

    expect(mateScriptOf(invalid).system).toEqual(mateScriptOf().system);
    expect(mateScriptOf(invalid).keywords).toEqual(mateScriptOf().keywords);
    expect(mateScriptOf(malformed).system).toEqual(mateScriptOf().system);
    expect(mateScriptOf(malformed).keywords).toEqual(mateScriptOf().keywords);
  });
});
