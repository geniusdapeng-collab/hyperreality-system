/**
 * 织伴小秘书 · 纯函数单测（第四/五轮实测补卡）
 * X-10：提醒时间解析必须容忍「23 点」这类带空格的中文输入。
 */
import { describe, expect, it } from "vitest";
import { parseDueAt } from "./secretary.js";

const at = (iso: string) => new Date(iso);

describe("parseDueAt（X-10 空格容忍）", () => {
  const now = at("2026-09-29T06:00:00+08:00"); // 本地 06:00

  it("数字与「点」之间允许空格（真机失败样例）", () => {
    const due = parseDueAt("今晚 23 点提醒我过审批", now);
    expect(due).toBeTruthy();
    expect(new Date(due!).getHours()).toBe(23);
  });

  it("中文数字 + 空格 + 半/全角变体", () => {
    expect(new Date(parseDueAt("明早 8 点提醒我", now)!).getHours()).toBe(8);
    expect(new Date(parseDueAt("下午 3 点半提醒我", now)!).getHours()).toBe(15);
    expect(new Date(parseDueAt("下午3点30分提醒我", now)!).getMinutes()).toBe(30);
  });

  it("无空格/冒号形态继续可用（不回退）", () => {
    expect(new Date(parseDueAt("今晚23点提醒我", now)!).getHours()).toBe(23);
    expect(new Date(parseDueAt("明天 14:30 开会", now)!).getHours()).toBe(14);
  });

  it("解析不出时间返回 null（不乱猜）", () => {
    expect(parseDueAt("提醒我过审批", now)).toBeNull();
    expect(parseDueAt("过一会儿提醒我", now)).toBeNull();
  });
});
