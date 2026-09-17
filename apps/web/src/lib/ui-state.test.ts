import { describe, expect, it } from "vitest";
import { operationFailure, toUiFailure } from "./ui-state";

describe("toUiFailure", () => {
  it("将权限错误转换为中文安全提示", () => {
    expect(toUiFailure(Object.assign(new Error("FORBIDDEN raw_field_name"), { data: { code: "FORBIDDEN" } }))).toEqual({
      kind: "forbidden",
      message: "当前角色没有执行此操作的权限。",
    });
  });

  it("不释放未知服务端错误或底层字段", () => {
    const text = operationFailure(new Error("column workspace_id does not exist at SELECT"), "保存");
    expect(text).toBe("保存未完成。服务暂时不可用，本次操作尚未确认成功，请稍后重试。");
    expect(text).not.toContain("workspace_id");
    expect(text).not.toContain("SELECT");
  });

  it("积分购买异常映射为安全结果，不透传服务端消息", () => {
    const text = operationFailure(new Error("Internal Server Error: pack_id invalid"), "购买积分");
    expect(text).toBe("购买积分未完成。服务暂时不可用，本次操作尚未确认成功，请稍后重试。");
    expect(text).not.toContain("pack_id");
  });

  it("对断网和冲突给出可恢复语义", () => {
    expect(toUiFailure(new Error("Failed to fetch")).kind).toBe("offline");
    expect(toUiFailure(Object.assign(new Error("stale"), { data: { code: "CONFLICT" } })).kind).toBe("conflict");
  });
});
