import { describe, expect, it } from "vitest";
import { actionText, actorText, approvalGestureText, chineseDisplayName, hydrateDisplayTerminology, payloadText, skillDisplayName, versionText } from "./display";

describe("技能中文展示名（基座：技能中心不得裸奔内部 id）", () => {
  it("首段即中文短名（含破折号分隔）", () => {
    expect(skillDisplayName("dev-dispatch", "开发任务派发——选机床、建隔离 worktree、快照、启动受管会话。")).toBe("开发任务派发");
    expect(skillDisplayName("kb-fresh", "知识库保鲜巡检——过期检测（模型版本/价格/政策失效）…")).toBe("知识库保鲜巡检");
  });

  it("首段夹带技术记号时剔除后再取（PRD/eval/LLM 这类词不进技能名）", () => {
    expect(skillDisplayName("eval-forge", "评测集锻造。从 PRD/需求自动生成可执行 eval 集（30-40 案例起步）…")).toBe("评测集锻造");
    expect(chineseDisplayName("gh API 读取 issue/PR 提交节奏", "github-pulse")).toBe("读取 提交节奏");
  });

  it("实在取不到中文名才回落原 id", () => {
    expect(skillDisplayName("some-skill", "")).toBe("some-skill");
  });
});

describe("客户端版本文案", () => {
  it("只展示人类可读版本序号", () => {
    expect(versionText("v3")).toBe("第 3 版");
    expect(versionText("hotel-baseline/v1.5")).toBe("第 1.5 版");
  });

  it("不会释放内部包名或哈希", () => {
    expect(versionText("bundle_internal_sha")).toBe("版本已记录");
    expect(versionText("版本 workspace_id")).toBe("版本已记录");
    expect(versionText("版本 InternalServerError")).toBe("版本已记录");
    expect(versionText(undefined)).toBe("版本待确认");
  });
});

describe("行业术语投影", () => {
  it("只从当前 Bundle 投影读取岗位、动作和字段显示名", () => {
    hydrateDisplayTerminology({
      "actor.industry-worker": "行业执行官",
      "action.domain.process": "办理行业事项",
      "field.domain_metric": "行业指标",
    });
    expect(actorText("industry-worker")).toBe("行业执行官");
    expect(actionText("domain.process")).toBe("办理行业事项");
    expect(payloadText({ domain_metric: 8 })).toContain("行业指标：8");
    hydrateDisplayTerminology({});
  });

  it("未知代码只显示通用中文兜底", () => {
    hydrateDisplayTerminology({ "action.private.machine_code": "办理 private_field" });
    expect(actorText("private-worker-id")).toBe("系统成员");
    expect(actorText("成员 workspace_id")).toBe("系统成员");
    expect(actorText("MEM-12345")).toBe("系统成员");
    expect(actionText("private.machine_code")).toBe("系统操作");
    expect(payloadText({ private_field: "raw_machine_value" })).toBe("补充信息：信息待确认");
  });
});

describe("审批手势文案", () => {
  it("只展示受控字典文案，不直出手势码", () => {
    expect(approvalGestureText("approve")).toBe("已批准");
    expect(approvalGestureText("edit")).toBe("已修改后批准");
    expect(approvalGestureText("reject")).toBe("已驳回");
    expect(approvalGestureText("private_gesture")).toBe("审批已处理");
  });
});
