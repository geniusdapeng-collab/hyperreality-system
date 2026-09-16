import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("开发场域服务端授权边界", () => {
  it("每个端点都使用已验行业权限守卫，不依赖客户端隐藏入口", () => {
    const source = readFileSync(fileURLToPath(new URL("./router.ts", import.meta.url)), "utf8");
    const start = source.indexOf("const devtoolsRouter = router({");
    const end = source.indexOf("const secretaryRouter = router({", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    expect(block).not.toMatch(/:\s*protectedProcedure\b/);
    expect(block).not.toMatch(/:\s*writeProcedure\b/);
    expect(block.match(/navigationPermissionProcedure\("ai-pm\.development\.read"\)/g)?.length).toBe(6);
    expect(block.match(/navigationPermissionWriteProcedure\("ai-pm\.development\.read"\)/g)?.length).toBe(10);
  });
});
