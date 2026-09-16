import { describe, expect, it } from "vitest";
import { feedbackReasonLabels, memoryImpactSystemText } from "./systemText";

describe("组织记忆系统文案边界", () => {
  it("净化服务端原因展示名和影响预览系统字段", () => {
    const labels = feedbackReasonLabels([
      { code: "other", label: "其他业务原因" },
      { code: "private", label: "原因 workspace_id" },
    ]);
    const impact = memoryImpactSystemText({
      affectedMemoryIds: ["memory-1"],
      agents: [{ id: "agent-1", name: "agentInternalName" }],
      rules: [{ id: "rule-1", name: "围栏 privateField" }],
      activeTasks: [{ id: "task-1", title: "Keep customer SKU_X", status: "active" }],
      futureTaskPolicy: "Policy workspace_id",
    });

    expect(labels).toEqual({ other: "其他业务原因", private: "其他原因" });
    expect(impact.agents[0]?.name).toBe("数字员工");
    expect(impact.rules[0]?.name).toBe("关联围栏");
    expect(impact.futureTaskPolicy).toBe("后续任务将按当前规则重新评估。");
    expect(impact.activeTasks[0]?.title).toBe("Keep customer SKU_X");
  });
});
