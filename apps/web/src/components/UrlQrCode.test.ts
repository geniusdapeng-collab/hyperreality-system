import { describe, expect, it } from "vitest";
import { buildUrlQrMatrix, formatBitsForLowCorrection, URL_QR_MAX_BYTES } from "./UrlQrCode";

describe("客户服务 URL 二维码", () => {
  it("生成符合 Version 5 尺寸的确定性矩阵与三个定位图形", () => {
    const value = "https://service.example.com/entry";
    const first = buildUrlQrMatrix(value);
    const second = buildUrlQrMatrix(value);
    expect(first).toEqual(second);
    expect(first).toHaveLength(37);
    expect(first.every((row) => row.length === 37 && row.every((cell) => typeof cell === "boolean"))).toBe(true);
    const finders: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 30], [30, 0]];
    for (const [row, col] of finders) {
      expect(first[row]![col]).toBe(true);
      expect(first[row + 1]![col + 1]).toBe(false);
      expect(first[row + 3]![col + 3]).toBe(true);
    }
  });

  it("使用标准 L 级纠错、掩码 0 的格式信息", () => {
    expect(formatBitsForLowCorrection(0)).toBe(0x77c4);
  });

  it("容量边界明确，超长链接不会生成伪二维码", () => {
    expect(() => buildUrlQrMatrix("x".repeat(URL_QR_MAX_BYTES))).not.toThrow();
    expect(() => buildUrlQrMatrix("x".repeat(URL_QR_MAX_BYTES + 1))).toThrow(/链接过长/);
  });

  it("不同地址产生不同数据矩阵", () => {
    expect(buildUrlQrMatrix("https://a.example.com")).not.toEqual(buildUrlQrMatrix("https://b.example.com"));
  });
});
