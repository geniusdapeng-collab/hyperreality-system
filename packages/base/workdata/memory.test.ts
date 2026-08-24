/**
 * B3 测试：Mock embedding 确定性 + 内容安全检查（纯函数）+ PG 集成（写入/检索/归因/使用记录）
 */
import { describe, expect, it } from "vitest";
import { assertMemoryContentSafe, MockEmbedder } from "./memory.js";
import { EMBEDDING_DIM } from "@workloom/shared";

describe("MockEmbedder（D4 确定性）", () => {
  const e = new MockEmbedder();

  it("维度 1536，同文本同向量", async () => {
    const a = await e.embed("周五晚大床房需求弹性高");
    const b = await e.embed("周五晚大床房需求弹性高");
    expect(a.length).toBe(EMBEDDING_DIM);
    expect(a).toEqual(b);
  });

  it("单位向量（norm=1），不同文本不同向量", async () => {
    const a = await e.embed("文本甲");
    const b = await e.embed("文本乙");
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
    expect(a).not.toEqual(b);
  });
});

describe("记忆内容安全（F1.8 禁明文 PII）", () => {
  it("含手机号判不安全；干净内容放行", () => {
    expect(assertMemoryContentSafe("客人王总电话 13812345678").safe).toBe(false);
    expect(assertMemoryContentSafe("差评回复结构：致歉→核实→改进").safe).toBe(true);
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成记忆（种子库）", async () => {
  const pg = (await import("pg")).default;
  const { upsertMemory, searchMemories, recordMemoryUsage, getMemorySources, transitionMemory } =
    await import("./memory.js");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  const embedder = new MockEmbedder();

  const RUN = Date.now().toString(36); // 唯一后缀：同一数据库可重跑（集成测试不留跨轮污染）
  const memId = `mem-b3-test-${RUN}`;
  const memContent = `B3 测试模式记忆（写入于集成测试 ${RUN}）`;

  it("写入记忆（脱敏）→ 结构化检索命中 → 语义检索有距离", async () => {
    await upsertMemory(pool, scope, {
      memoryId: memId,
      scope: "workspace",
      kind: "pattern",
      content: memContent,
      sourceEvents: ["E-SEED-8801", "E-SEED-8802"],
      confidence: 0.6,
    }, embedder);
    const byKind = await searchMemories(pool, scope, { kind: "pattern" });
    expect(byKind.some((m) => m.memory_id === memId)).toBe(true);
    const semantic = await searchMemories(pool, scope, { query: memContent, limit: 5 }, embedder);
    expect(semantic.length).toBeGreaterThan(0);
    expect(semantic[0]!.memory_id).toBe(memId); // 同文本距离 0，必居首
    expect(semantic[0]!.distance).not.toBeNull();
  });

  it("归因闭环：任一记忆可反查来源事件（验收断言）", async () => {
    await recordMemoryUsage(pool, scope, memId, "E-SEED-8803");
    const r = await getMemorySources(pool, scope, memId);
    expect(r.memory?.memory_id).toBe(memId);
    expect(r.sourceEvents.map((e) => e.event_id)).toEqual(["E-SEED-8801", "E-SEED-8802"]);
    expect(r.usedBy).toContain("E-SEED-8803");
    // 来源事件确为种子库真实事件（五元完整）
    expect(r.sourceEvents[0]!.who.type).toBe("agent");
  });

  it("M3/M4：subject_id 落库 + subjectId 过滤检索 + getMemorySources 同步", async () => {
    const agentMem = `mem-b3-agent-${RUN}`;
    await upsertMemory(pool, scope, {
      memoryId: agentMem,
      scope: "agent",
      kind: "preference",
      content: `agent 主体记忆 ${RUN}`,
      sourceEvents: [],
      subjectId: "pricing-agent",
    }, embedder);
    // subjectId 过滤命中本主体，过滤他主体不命中
    const bySubject = await searchMemories(pool, scope, { subjectId: "pricing-agent", limit: 50 });
    expect(bySubject.some((m) => m.memory_id === agentMem)).toBe(true);
    const other = await searchMemories(pool, scope, { subjectId: `other-${RUN}`, limit: 50 });
    expect(other.some((m) => m.memory_id === agentMem)).toBe(false);
    // getMemorySources 同步返回 subject_id
    const r = await getMemorySources(pool, scope, agentMem);
    expect(r.memory?.subject_id).toBe("pricing-agent");
  });

  it("M3/M4：recordMemoryUsage 校验记忆归属本工作区（跨区/不存在必拒），usage 带 workspace_id", async () => {
    const owned = `mem-b3-owned-${RUN}`;
    await upsertMemory(pool, scope, {
      memoryId: owned, scope: "workspace", kind: "sop", content: `归属校验 ${RUN}`, sourceEvents: [],
    }, embedder);
    // 本工作区正常记录
    await recordMemoryUsage(pool, scope, owned, "E-SEED-8804");
    const r = await getMemorySources(pool, scope, owned);
    expect(r.usedBy).toContain("E-SEED-8804");
    // 不存在的记忆 → 拒
    await expect(recordMemoryUsage(pool, scope, `mem-nonexist-${RUN}`, "E-SEED-8801")).rejects.toThrow(/归属/);
    // 跨工作区引用他区记忆 → 拒（防归属伪造）
    await expect(
      recordMemoryUsage(pool, { tenantId: scope.tenantId, workspaceId: "ws-other" }, owned, "E-SEED-8801"),
    ).rejects.toThrow(/归属/);
  });

  it("生命周期：active→superseded 幂等约束，重复迁移报错", async () => {
    await transitionMemory(pool, scope, memId, "superseded", "mem-occ-friday");
    await expect(transitionMemory(pool, scope, memId, "recalled")).rejects.toThrow(/非 active/);
    const after = await searchMemories(pool, scope, { kind: "pattern", status: "active" });
    expect(after.some((m) => m.memory_id === memId)).toBe(false);
  });

  it("种子记忆可归因（E-SEED-8801/E-SEED-8802 反查）", async () => {
    const r = await getMemorySources(pool, scope, "mem-review-sop");
    expect(r.sourceEvents.length).toBe(1);
    expect(r.sourceEvents[0]!.event_id).toBe("E-SEED-8802");
  });
});
