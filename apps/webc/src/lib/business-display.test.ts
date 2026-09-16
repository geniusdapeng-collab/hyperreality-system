import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { businessCardOf, businessRecordOf, catalogInfoOf, memberInfoOf } from "./business-display";

describe("C 端行业无关视图模型", () => {
  it("类型与卡片组件不认识任何行业私有字段", () => {
    const types = readFileSync(new URL("./types.ts", import.meta.url), "utf8");
    const cards = readFileSync(new URL("../components/cards.tsx", import.meta.url), "utf8");
    const forbidden = /\b(?:roomType|checkIn|checkOut|priceYuan)\b/;
    expect(types).not.toMatch(forbidden);
    expect(cards).not.toMatch(forbidden);
  });

  it("业务卡只渲染服务端展示投影，并保留客户端中文兜底", () => {
    const cards = readFileSync(new URL("../components/cards.tsx", import.meta.url), "utf8");
    expect(cards).toContain("order.statusText");
    expect(cards).toContain("order.details.map");
    expect(cards).toContain("member.metric");
    expect(cards).toContain("catalog.cardTitle");
    expect(cards).toContain("clientChineseText");
    expect(cards).toContain("clientValueText");
  });

  it("我的页面不显示内部身份主键，也不在前端翻译行业状态", () => {
    const page = readFileSync(new URL("../pages/MePage.tsx", import.meta.url), "utf8");
    expect(page).not.toContain("身份编号 ${user.memberId}");
    expect(page).not.toContain("statusLabel(o.status)");
    expect(page).toContain("o.statusText");
  });

  it("实时接口遇到不可用适配器或非法卡片时失败关闭，不把它伪装为空结果", () => {
    const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
    expect(api).toContain("response.available === false");
    expect(api).toContain("cards.length !== rawCards.length");
    expect(api).toContain("BUSINESS_PROJECTION_INVALID");
  });

  it("白名单复制通用视图，并剥离接口中的额外私有字段", () => {
    expect(businessRecordOf({
      id: "record-1",
      cardTitle: "我的业务记录",
      title: "标准服务方案",
      statusText: "已确认",
      referenceText: "业务编号 A-1001",
      details: [{ label: "服务日期", value: "2026-09-15" }],
      amountText: "¥1,176.00",
      room_type: "原始字段",
    })).toEqual({
      id: "record-1",
      cardTitle: "我的业务记录",
      title: "标准服务方案",
      statusText: "已确认",
      referenceText: "业务编号 A-1001",
      details: [{ label: "服务日期", value: "2026-09-15" }],
      amountText: "¥1,176.00",
    });
  });

  it("拒绝英文状态、底层字段标签和结构不完整的业务卡", () => {
    expect(businessRecordOf({
      id: "record-1",
      cardTitle: "我的业务记录",
      title: "标准服务方案",
      statusText: "confirmed",
      details: [],
    })).toBeNull();
    expect(businessRecordOf({
      id: "record-1",
      cardTitle: "我的业务记录",
      title: "标准服务 room_type",
      statusText: "已确认",
      details: [],
    })).toBeNull();
    expect(businessRecordOf({
      id: "record-1",
      cardTitle: "我的业务记录",
      title: "标准服务方案",
      statusText: "已确认",
      details: [{ label: "room_type", value: "标准服务" }],
    })).toBeNull();
    expect(businessCardOf({ kind: "order", data: { title: "缺少必要字段" } })).toBeNull();
  });

  it("权益与目录按同一展示边界校验", () => {
    expect(memberInfoOf({
      title: "正式用户",
      metric: { label: "当前权益值", value: "2,680" },
      benefits: ["优先服务"],
      level: "gold",
    })).toEqual({
      title: "正式用户",
      metric: { label: "当前权益值", value: "2,680" },
      benefits: ["优先服务"],
    });
    expect(catalogInfoOf({
      cardTitle: "服务方案与价格",
      items: [{ id: "sku-1", title: "标准服务方案", priceText: "¥588 / 次", details: [] }],
    })).toEqual({
      cardTitle: "服务方案与价格",
      items: [{ id: "sku-1", title: "标准服务方案", priceText: "¥588 / 次", details: [] }],
    });
    expect(memberInfoOf({ title: "Member", benefits: [] })).toBeNull();
  });
});
