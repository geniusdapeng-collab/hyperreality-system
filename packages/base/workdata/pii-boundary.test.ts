/**
 * PII 边界回归（2026-09-28 压测实证）：
 *  ① 产物路径/文件名里的数字串不得被 Luhn 误判成银行卡（真机：`generated-20260928-131924-01.png`
 *     在账本里被写成 `generated-[PII:BANKCARD:…]`，产物取件路径被腐蚀）；
 *  ② 口径/版本/时长类数字不得被吞（视频链路实测 `wide≥20%` 被打成 `wide≥%` 一类腐蚀的上游同类问题）；
 *  ③ 真 PII 仍必须命中（收紧边界不得放宽检出）。
 */
import { describe, expect, it } from "vitest";
import { maskText } from "./pii.js";

describe("PII 脱敏边界（结构化标识不误伤）", () => {
  it("产物路径/文件名中的数字串不脱敏", () => {
    const samples = [
      "file:///Users/mac/Library/Application Support/WorkLoomVisualBridge/var/tenants/ws-geo/assets/generated-20260928-131924-01.png",
      "shot-SC-01-20260928-131924.mp4",
      "POSTER_v20260928_131924_final.png",
      "outputs/2026-09-28T08-38-46-609Z_untitled/audit.json",
    ];
    for (const sample of samples) {
      const r = maskText(sample);
      expect(r.text, sample).toBe(sample);
      expect(r.hits, sample).toBe(0);
    }
  });

  it("版本号/口径参数/时长数字不脱敏", () => {
    const samples = [
      "片型规范 v1.0.3：wide≥20%、medium≥45%、close≥35%，总时长：30秒",
      "compositor-bridge 0.2.0（headless kit from Compositor v1.0.4）",
      "sku-20260928-1319 × 12 件，单价 ¥199.00",
    ];
    for (const sample of samples) {
      const r = maskText(sample);
      expect(r.text, sample).toBe(sample);
      expect(r.hits, sample).toBe(0);
    }
  });

  it("真 PII 仍然命中（不放宽检出）", () => {
    const phone = maskText("联系电话 13800001234，请回拨");
    expect(phone.hits).toBe(1);
    expect(phone.text).toContain("[PII:PHONE:");

    const idcard = maskText("身份证号 110101199003077758 已核验");
    expect(idcard.hits).toBe(1);
    expect(idcard.text).toContain("[PII:IDCARD:");

    const card = maskText("卡号 4111 1111 1111 1111 请核对");
    expect(card.hits).toBe(1);
    expect(card.text).toContain("[PII:BANKCARD:");

    const email = maskText("发到 ops@example.com 即可");
    expect(email.hits).toBe(1);
    expect(email.text).toContain("[PII:EMAIL:");
  });
});
