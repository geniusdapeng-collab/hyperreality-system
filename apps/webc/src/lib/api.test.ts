import { describe, expect, it } from "vitest";
import { publicApiErrorMessage } from "./api";

describe("C 端错误文案脱敏", () => {
  it("按状态返回稳定中文，不依赖服务端原始错误", () => {
    expect(publicApiErrorMessage(401)).toContain("登录状态");
    expect(publicApiErrorMessage(403)).toContain("权限");
    expect(publicApiErrorMessage(409)).toContain("刷新");
    expect(publicApiErrorMessage(429)).toContain("频繁");
    expect(publicApiErrorMessage(500)).toContain("尚未确认成功");
  });

  it("断网与参数错误有可执行的恢复提示", () => {
    expect(publicApiErrorMessage(0)).toContain("检查网络");
    expect(publicApiErrorMessage(422)).toContain("检查后重试");
    expect(publicApiErrorMessage(401, "H5_ENTRY_INVALID")).toContain("服务方提供的入口");
  });
});
