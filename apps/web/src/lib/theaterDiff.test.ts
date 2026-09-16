import { describe, expect, it } from "vitest";
import type { FloorAgent } from "../pages/p0/Floor";
import { askingDirectorEvent, tickerDirectorEvent } from "./theaterDiff";

function askingAgent(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: "agent-1",
    presetKey: "frontdesk-agent",
    name: "客户协作专员",
    state: "asking",
    stationId: null,
    currentThread: null,
    pendingTier: "l2_manager",
    approvalId: "approval-1",
    statusLine: "有一项事务需要您确认",
    ...overrides,
  };
}

describe("theaterDiff 导演事件中文边界", () => {
  it("请示事件在创建时净化岗位名和状态文案", () => {
    const event = askingDirectorEvent(1, askingAgent({
      name: "frontdesk-agent",
      statusLine: "处理 workspace_id",
    }));

    expect(event.agentName).toBe("数字员工");
    expect(event.text).toBe("数字员工 向您请示");
    expect(JSON.stringify(event)).not.toContain("workspace_id");
    expect(JSON.stringify(event)).not.toContain("frontdesk-agent");
  });

  it("ticker 事件只展示动作字典文案与安全岗位名", () => {
    const fuse = tickerDirectorEvent(2, {
      event_id: "event-2",
      action: "fence.block",
      who: "reconcile-agent",
    });
    const cheer = tickerDirectorEvent(3, {
      event_id: "event-3",
      action: "thread.complete",
      who: "财务专员",
    });

    expect(fuse).toMatchObject({ kind: "fuse", agentName: "数字员工", text: "围栏熔断：系统操作" });
    expect(JSON.stringify(fuse)).not.toContain("fence.block");
    expect(cheer).toMatchObject({ kind: "cheer", agentName: "财务专员", text: "捷报：办结" });
  });
});
