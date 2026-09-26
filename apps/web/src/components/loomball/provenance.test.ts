/**
 * 品牌边界闸（规格书验收 5 的精确化版本）：
 * 「Grok」只允许出现在 vendor 目录（上游源码与署名）——业务代码、页面、组件一律不得出现。
 * 这样既守住商标纪律，又不误伤 MIT 要求的原文保留。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));          // apps/web/src/components/loomball
const SRC = resolve(HERE, "../../");                            // apps/web/src

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "vendor") continue;                          // vendor 目录整体豁免（上游原文）
      walk(path, out);
    } else if (/\.(ts|tsx|css|html)$/.test(entry)) {
      // 测试文件本身要断言"门面被删除"，会写到上游全局名；产品代码才是扫描对象
      if (/\.test\.(ts|tsx)$/.test(entry)) continue;
      out.push(path);
    }
  }
  return out;
}

describe("织球品牌边界", () => {
  it("apps/web/src 业务代码（vendor 之外）不出现上游商标字样", () => {
    const hits = walk(SRC)
      .filter((path) => /grok/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(hits).toEqual([]);
  });
});
