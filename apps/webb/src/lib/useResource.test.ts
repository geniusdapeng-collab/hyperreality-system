import { describe, expect, it } from "vitest";
import { safeErrorKind, safeMessage } from "./useResource";

describe("B端移动错误展示", () => {
  it("不会把服务端技术错误直接释放给客户端", () => {
    expect(safeMessage(new Error("ECONNREFUSED postgres://secret"))).toBe("服务暂时不可用，数据未被当作空结果处理。");
  });

  it("身份和权限错误使用明确中文", () => {
    expect(safeMessage(new Error("UNAUTHORIZED"))).toBe("登录已失效，请重新登录。");
    expect(safeMessage(new Error("FORBIDDEN"))).toBe("当前角色没有执行此操作的权限。");
    expect(safeErrorKind(new Error("FORBIDDEN"))).toBe("forbidden");
    expect(safeErrorKind(new Error("UNAUTHORIZED"))).toBe("unauthorized");
  });
});
