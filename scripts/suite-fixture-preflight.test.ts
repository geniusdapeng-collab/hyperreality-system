import { describe, expect, it } from "vitest";
import { assertGovernanceFixtureContract } from "./suite-fixture-preflight.js";

const repairHint = "重新播种测试夹具";
const requirements = {
  mode: "trial" as const,
  ranges: { "generic-ratio": { lower: 0.8, anchor: 1, upper: 1.2 } },
  caps: { "generic-limit": 1000 },
  repairHint,
};

const currentFixture = () => ({
  mode: "trial",
  autonomy: {
    ranges: {
      "generic-ratio": { label: "通用比例", lower: 0.8, anchor: 1, upper: 1.2 },
    },
    caps: {
      "generic-limit": { label: "通用上限", limit: 1000 },
    },
  },
});

describe("主套件治理夹具前置检查", () => {
  it("接受满足声明要求的当前通用 ranges/caps 契约", () => {
    expect(() => assertGovernanceFixtureContract(currentFixture(), requirements)).not.toThrow();
  });

  it("旧结构在套件运行前一次性失败，并给出重新播种提示", () => {
    expect(() => assertGovernanceFixtureContract({
      mode: "trial",
      autonomy: { legacy_range: [0.8, 1.2], legacy_cap: 1000 },
    }, requirements)).toThrow(/治理夹具契约不兼容.*重新播种测试夹具/);
  });

  it("当前结构缺少套件声明的边界时失败，不拖成多个业务用例故障", () => {
    const fixture = currentFixture();
    fixture.autonomy.caps["generic-limit"].limit = 999;
    expect(() => assertGovernanceFixtureContract(fixture, requirements)).toThrow(
      /治理夹具上限 generic-limit 不符合当前基线.*重新播种测试夹具/,
    );
  });
});
