import { describe, expect, it } from "vitest";
import { clientNaturalText, clientNaturalTextOrNull } from "./clientText";

describe("客户端自然语言展示边界（N-13）", () => {
  it("模型回显提示词标签时不再整段兜底（真机回归）", () => {
    const answer = "结论：当前有 4 项待审批事项。\n\n依据：<facts> 显示“当前待审批：4 项（决断队列）”。";
    const out = clientNaturalText(answer, "FALLBACK");
    expect(out).not.toBe("FALLBACK");
    expect(out).toContain("当前有 4 项待审批事项");
    expect(out).toContain("实时数据");
    expect(out).not.toContain("<facts>");
  });

  it("保留常见行业英文缩写与数字口径", () => {
    const out = clientNaturalText("本周 ROI 1.8，GEO 上榜 12 词，时长 30 秒。", "FALLBACK");
    expect(out).toContain("ROI");
    expect(out).toContain("12 词");
  });

  it("机器标识局部替换而不是丢整段", () => {
    const out = clientNaturalText("任务已按 preset_key 装配，worker_thread 完成了取数。", "FALLBACK");
    expect(out).not.toBe("FALLBACK");
    expect(out).toContain("岗位");
    expect(out).toContain("该字段");
    expect(out).toContain("完成了取数");
  });

  it("内部字段名/纯 JSON/纯英文仍然兜底（治理边界不变）", () => {
    expect(clientNaturalText("SELECT * FROM threads WHERE id=1", "FALLBACK")).toBe("FALLBACK");
    expect(clientNaturalText('{"mode":"quest","steps":3}', "FALLBACK")).toBe("FALLBACK");
    expect(clientNaturalText("Internal Server Error", "FALLBACK")).toBe("FALLBACK");
    expect(clientNaturalText(null, "FALLBACK")).toBe("FALLBACK");
    expect(clientNaturalText("   ", "FALLBACK")).toBe("FALLBACK");
  });

  it("内部字段名被译成人话而不是丢整段", () => {
    const out = clientNaturalText("事件编号 event_id 写入失败，workspace_id 不变。", "FALLBACK");
    expect(out).not.toBe("FALLBACK");
    expect(out).toContain("事件编号");
    expect(out).toContain("写入失败");
  });

  it("空语义版本返回 null", () => {
    expect(clientNaturalTextOrNull("")).toBeNull();
    expect(clientNaturalTextOrNull("有内容的中文说明")).toBe("有内容的中文说明");
  });
});
