/**
 * workloom-fence 插件 · 规则源与 fail-closed 语义（MC-105 回归）
 *
 * 背景：dsh 插件此前只认 rulesUrl，且把 404 错误体当规则数组（`for (const r of rules)` 抛错），
 * 规则源不可用时工具层不是被拒绝、而是整体炸掉；acceptance/live 链路声明的
 * `rulesFile` 装配也从未被插件读取。
 * 口径：规则命中 → auto/review/block；规则源不可用/非数组 → deny（fail-closed，E2.1）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "./workloom-fence.plugin.js";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
  vi.restoreAllMocks();
});

/** 挂载插件并取出 tools/pre-execute 瀑布处理器 */
function mount(config) {
  let handler = null;
  const ctx = { on: (event, fn) => { if (event === "tools/pre-execute") handler = fn; } };
  apply(ctx, config);
  expect(handler, "插件未挂载 tools/pre-execute").toBeTypeOf("function");
  return handler;
}

function rulesFileWith(rules) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-fence-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "rules.json");
  writeFileSync(file, JSON.stringify(rules));
  return file;
}

const nextOk = async () => ({ kind: "next-ok" });

describe("workloom-fence 插件规则源", () => {
  it("rulesFile 命中 block 规则 → deny", async () => {
    const file = rulesFileWith([
      { rule_id: "R2", level: "block", match: { actions: ["price.adjust"] } },
      { rule_id: "R1", level: "auto", match: { actions: ["price.adjust"] } },
    ]);
    const handler = mount({ rulesFile: file });
    const verdict = await handler({ name: "price.adjust" }, nextOk);
    expect(verdict).toMatchObject({ kind: "deny" });
  });

  it("rulesFile 命中 review 规则 → ask", async () => {
    const file = rulesFileWith([{ rule_id: "R3", level: "review", actions: ["content.publish"] }]);
    const handler = mount({ rulesFile: file });
    const verdict = await handler({ name: "content.publish" }, nextOk);
    expect(verdict).toMatchObject({ kind: "ask" });
  });

  it("rulesFile 缺失 → deny（fail-closed，不再抛错）", async () => {
    const handler = mount({ rulesFile: "/definitely/missing/rules.json" });
    const verdict = await handler({ name: "price.adjust" }, nextOk);
    expect(verdict).toMatchObject({ kind: "deny" });
  });

  it("rulesUrl 返回 tRPC 信封（fence.activeRules 形状）→ 按规则判定", async () => {
    vi.stubGlobal("fetch", async () => ({
      json: async () => ({ result: { data: [{ rule_id: "R4", level: "block", match: { actions: ["order.refund"] } }] } }),
    }));
    const handler = mount({ rulesUrl: "http://127.0.0.1:8787/trpc/fence.activeRules" });
    expect(await handler({ name: "order.refund" }, nextOk)).toMatchObject({ kind: "deny" });
  });

  it("rulesUrl 返回 404 错误体（历史缺陷场景）→ deny 而不是抛错", async () => {
    vi.stubGlobal("fetch", async () => ({
      json: async () => ({ error: { message: 'No procedure found on path "fence.activeRules"' } }),
    }));
    const handler = mount({ rulesUrl: "http://127.0.0.1:8787/trpc/fence.activeRules" });
    const verdict = await handler({ name: "price.adjust" }, nextOk);
    expect(verdict).toMatchObject({ kind: "deny" });
  });

  it("规则源不可用时不消耗 next（拒绝先于放行）", async () => {
    let called = 0;
    const handler = mount({});
    await handler({ name: "price.adjust" }, async () => { called += 1; return { kind: "next-ok" }; });
    expect(called).toBe(0);
  });
});
