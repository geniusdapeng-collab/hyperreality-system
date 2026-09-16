import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ruleBasedIntent } from "./intents.js";
import { bizToolFor, ticketKindForServiceRequest } from "./dialog.js";

describe("服务对话基座行业中立门禁", () => {
  it("基座实现不内置酒店及固定商业对象词表", () => {
    const intents = readFileSync(new URL("./intents.ts", import.meta.url), "utf8");
    const dialog = readFileSync(new URL("./dialog.ts", import.meta.url), "utf8");
    const forbidden = /酒店|房型|客房|退房|入住|矿泉水|我的订单|我的会员|biz\.query_orders|biz\.query_member/;
    expect(intents).not.toMatch(forbidden);
    expect(dialog).not.toMatch(forbidden);
  });

  it("未注入行业扩展时不猜测行业意图、工具或工单类型", () => {
    expect(ruleBasedIntent("查询我的订单")).toBeNull();
    expect(ruleBasedIntent("查看我的会员权益")).toBeNull();
    expect(bizToolFor("查询我的订单", "customer-1")).toBeNull();
    expect(ticketKindForServiceRequest("设备故障需要维修")).toBe("other");
  });
});
