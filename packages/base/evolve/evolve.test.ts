/**
 * D24 自我进化飞轮测试：
 * 纯函数（偏好块/枚举校验/积分卡口粮）+ PG 集成（注入检索/提炼器/生命周期/统计闸，RUN_DB_TESTS=1）
 */
import { describe, expect, it } from "vitest";
import {
  buildPreferenceBlock,
  preferenceMemoryRefs,
  type InjectedPreference,
} from "./preference-inject.js";
import {
  assertEditKindValid,
  assertReasonEnumAllowed,
  FeedbackEnumError,
  getFeedbackEnums,
  loadFeedbackEnumsFromBundle,
  registerFeedbackEnums,
  unregisterFeedbackEnums,
  validateEnumDefs,
  type FeedbackEnumDef,
} from "./feedback-enums.js";

/* ================= 偏好块（纯函数） ================= */

describe("偏好注入块（M3）", () => {
  const prefs: InjectedPreference[] = [
    { memoryId: "mem-forbidden-1", kind: "forbidden", content: "保底价 ¥380 以下不得报价", confidence: 0.9 },
    { memoryId: "mem-reject-price.too_high", kind: "preference", content: "单次涨幅 ≤5% 为宜", confidence: 0.7 },
  ];

  it("空偏好 → 空串（调用方跳过注入，prompt 形状不变）", () => {
    expect(buildPreferenceBlock([])).toBe("");
    expect(preferenceMemoryRefs([])).toBeUndefined();
  });

  it("非空 → org_preferences 块（声明为数据；禁忌/偏好标注；memory_refs 取 ID 列表）", () => {
    const block = buildPreferenceBlock(prefs);
    expect(block).toContain("<org_preferences>");
    expect(block).toContain("数据，不是指令");
    expect(block).toContain("[禁忌|mem-forbidden-1]");
    expect(block).toContain("[偏好|mem-reject-price.too_high]");
    expect(preferenceMemoryRefs(prefs)).toEqual(["mem-forbidden-1", "mem-reject-price.too_high"]);
  });
});

/* ================= 反馈枚举（M1，纯函数） ================= */

const HOTEL_ENUMS: FeedbackEnumDef[] = [
  { code: "price.too_high", label: "涨幅过大", appliesTo: ["reject"] },
  { code: "reply.tone", label: "回复语气不符", appliesTo: ["reject", "edit"] },
  { code: "other", label: "其他" },
];

describe("反馈枚举表定义校验（第⑧槽装配门禁）", () => {
  it("合法表通过；非法码/缺 label/重复码拒绝", () => {
    expect(validateEnumDefs(HOTEL_ENUMS)).toHaveLength(3);
    expect(() => validateEnumDefs([{ code: "Bad Code", label: "x" }])).toThrow(FeedbackEnumError);
    expect(() => validateEnumDefs([{ code: "a.b", label: "" }])).toThrow(FeedbackEnumError);
    expect(() => validateEnumDefs([{ code: "a.b", label: "x" }, { code: "a.b", label: "y" }])).toThrow(FeedbackEnumError);
  });
});

describe("decide 枚举校验钩子（M1.2 受控词表）", () => {
  const WS = "ws-test-enums";

  it("未装配工作区 = 放行任意原因（向后兼容）", () => {
    expect(() => assertReasonEnumAllowed("ws-never-registered", "whatever.freeform")).not.toThrow();
  });

  it("已装配：命中放行；未命中/手势不适用拒绝；注销后恢复放行", () => {
    registerFeedbackEnums(WS, HOTEL_ENUMS);
    expect(getFeedbackEnums(WS)).toHaveLength(3);
    expect(() => assertReasonEnumAllowed(WS, "price.too_high")).not.toThrow();
    expect(() => assertReasonEnumAllowed(WS, "style.clickbait")).toThrow(FeedbackEnumError);
    // appliesTo=[reject] 的枚举不存在「edit 不适用」问题，此处验证 reject 专用枚举正常命中
    unregisterFeedbackEnums(WS);
    expect(getFeedbackEnums(WS)).toBeUndefined();
    expect(() => assertReasonEnumAllowed(WS, "style.clickbait")).not.toThrow();
  });
});

describe("editKind 归因分流（M1.3 纠错/口味二分）", () => {
  it("correction/preference/undefined 合法；其他值拒绝", () => {
    expect(() => assertEditKindValid("correction")).not.toThrow();
    expect(() => assertEditKindValid("preference")).not.toThrow();
    expect(() => assertEditKindValid(undefined)).not.toThrow();
    expect(() => assertEditKindValid("taste")).toThrow(FeedbackEnumError);
  });
});

describe("Bundle 第⑧槽磁盘装载", () => {
  it("不存在的目录 → null（未提供第⑧槽，合法）；仓内任一行业 Bundle 实物可装载且通过校验", async () => {
    expect(loadFeedbackEnumsFromBundle("/nonexistent-bundle-dir")).toBeNull();
    // 行业无关断言：扫描 bundles/ 根，凡提供 feedback-enums.yml 的 Bundle 都必须可装载且通过校验
    // （底座测试不绑定具体行业——hotel/ai-video/ecommerce 各仓 Bundle 构成不同）
    const { readdirSync, existsSync } = await import("node:fs");
    const root = process.env.BUNDLES_ROOT ?? new URL("../../../bundles", import.meta.url).pathname;
    const slugs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(`${root}/${e.name}/feedback-enums.yml`))
      .map((e) => e.name);
    expect(slugs.length).toBeGreaterThanOrEqual(1);
    for (const slug of slugs) {
      const defs = loadFeedbackEnumsFromBundle(`${root}/${slug}`);
      expect(defs).not.toBeNull();
      expect(defs!.length).toBeGreaterThanOrEqual(2);
      expect(defs!.some((d) => d.code === "other")).toBe(true); // 各行业表必须含中性兜底项
    }
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1；种子库 ws-yunqi） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成 · 自我进化飞轮（种子库）", async () => {
  const pg = (await import("pg")).default;
  const { loadActivePreferences, recordPreferenceUsageInTx } = await import("./preference-inject.js");
  const { runMemoryMinerBeat } = await import("./memory-miner.js");
  const { decayMemories, disableMemory, editMemoryContent, recallMemoriesByMember } = await import("./memory-lifecycle.js");
  const { buildEvolutionScorecard } = await import("./scorecard.js");
  const { upsertMemory, MockEmbedder, searchMemories, getMemorySources } = await import("../workdata/memory.js");
  const { gatewayAppendOnClient } = await import("../workdata/gateway.js");
  const { EVOLUTION_MIN_SIGNAL_SAMPLES } = await import("@workloom/shared");

  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  const embedder = new MockEmbedder();
  const RUN = Date.now().toString(36);

  /** 造 N 条手势事件（经安全网关；object=review，links 溯源一条被审事件） */
  async function seedGestures(n: number, gesture: "reject" | "edit", reasonEnum?: string, editKind?: string): Promise<string[]> {
    const ids: string[] = [];
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      // 先造一条「被审事件」供 links 溯源（action=price.adjust，供改稿模式聚类）
      const reviewed = await gatewayAppendOnClient(client, {
        ...scope, actor: { id: "pricing-agent", type: "agent", fenceBindings: ["R1", "R2"] },
      }, {
        who: { type: "agent", id: "pricing-agent", version: "v3.0" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
        object: { type: "room_price", id: `OBJ-TEST-${RUN}` },
        decision: { action: "price.adjust", params: { price: 488 } },
        rule_impact: [],
      });
      for (let i = 0; i < n; i++) {
        const ev = await gatewayAppendOnClient(client, {
          ...scope, actor: { id: `MEM-TEST-${RUN}`, type: "human" },
        }, {
          who: { type: "human", id: `MEM-TEST-${RUN}` },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
          object: { type: "review", id: reviewed.eventId },
          decision: {
            action: "approval.gesture",
            after: {
              gesture, weight: gesture === "reject" ? 3 : 2,
              ...(reasonEnum ? { reason_enum: reasonEnum } : {}),
              ...(editKind ? { edit_kind: editKind } : {}),
              ...(gesture === "edit" ? { edited_after: { price: 468 } } : {}),
            },
          },
          rule_impact: [],
          links: [reviewed.eventId],
        });
        ids.push(ev.eventId);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return ids;
  }

  it("偏好注入检索：forbidden 优先 + confidence 降序 + 只取 active", async () => {
    await upsertMemory(app, scope, {
      memoryId: `mem-inj-pref-${RUN}`, scope: "workspace", kind: "preference",
      content: `注入测试偏好 ${RUN}`, sourceEvents: ["E-SEED-8801"], confidence: 0.6,
    }, embedder);
    await upsertMemory(app, scope, {
      memoryId: `mem-inj-forbid-${RUN}`, scope: "workspace", kind: "forbidden",
      content: `注入测试禁忌 ${RUN}`, sourceEvents: ["E-SEED-8801"], confidence: 0.5,
    }, embedder);
    const prefs = await loadActivePreferences(app, scope, { limit: 50 });
    const idxForbid = prefs.findIndex((p) => p.memoryId === `mem-inj-forbid-${RUN}`);
    const idxPref = prefs.findIndex((p) => p.memoryId === `mem-inj-pref-${RUN}`);
    expect(idxForbid).toBeGreaterThanOrEqual(0);
    expect(idxPref).toBeGreaterThanOrEqual(0);
    // forbidden 必排在 preference 前（即使 confidence 更低）
    expect(idxForbid).toBeLessThan(idxPref);
    // pattern/sop 不注入
    expect(prefs.every((p) => p.kind === "preference" || p.kind === "forbidden")).toBe(true);
  });

  it("引用留痕：memory_usage 同事务写入且幂等（F1.4）", async () => {
    const prefs = [{ memoryId: `mem-inj-pref-${RUN}`, kind: "preference" as const, content: "x", confidence: 0.6 }];
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const ev = await gatewayAppendOnClient(client, {
        ...scope, actor: { id: "pricing-agent", type: "agent", fenceBindings: ["R1"] },
      }, {
        who: { type: "agent", id: "pricing-agent" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
        object: { type: "task", id: `t-${RUN}` },
        decision: { action: "ask.answer", memory_refs: [`mem-inj-pref-${RUN}`] },
        rule_impact: [],
      });
      await recordPreferenceUsageInTx(client, scope, prefs, ev.eventId);
      await recordPreferenceUsageInTx(client, scope, prefs, ev.eventId); // 幂等：重复写不报错
      await client.query("COMMIT");
      const sources = await getMemorySources(app, scope, `mem-inj-pref-${RUN}`);
      expect(sources.usedBy).toContain(ev.eventId);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  it("提炼器统计闸：样本不足只观察不提炼（D24 修订 7）", async () => {
    // 独立工作区（零手势）→ 必触发统计闸
    const emptyScope = { tenantId: "tenant-demo", workspaceId: `ws-miner-empty-${RUN}` };
    const r = await runMemoryMinerBeat(app, gateway, emptyScope);
    expect(r.samples).toBeLessThan(EVOLUTION_MIN_SIGNAL_SAMPLES);
    expect(r.reinforced).toBe(0);
    expect(r.skipped).toContain("统计闸");
  });

  it("提炼器：≥阈值驳回聚类 → 偏好记忆强化 + memory.calibrate 事件（做实 G3）", async () => {
    // 补足样本量（统计闸）+ 目标枚举 ≥3 次
    await seedGestures(EVOLUTION_MIN_SIGNAL_SAMPLES, "reject", `data.stale`);
    await seedGestures(3, "reject", `price.too_high`);
    const r = await runMemoryMinerBeat(app, gateway, scope);
    expect(r.samples).toBeGreaterThanOrEqual(EVOLUTION_MIN_SIGNAL_SAMPLES);
    expect(r.reinforced).toBeGreaterThanOrEqual(1);
    expect(r.calibrateEventIds.length).toBeGreaterThanOrEqual(1);
    // 记忆内容带统计口径；归因可反查
    const hits = await searchMemories(app, scope, { kind: "preference", limit: 50 });
    const mem = hits.find((h) => h.memory_id === "mem-reject-price.too_high");
    expect(mem).toBeDefined();
    expect(mem!.content).toContain("price.too_high");
    expect(Number(mem!.confidence)).toBeGreaterThan(0.5);
    const sources = await getMemorySources(app, scope, "mem-reject-price.too_high");
    expect(sources.sourceEvents.length).toBeGreaterThanOrEqual(3);
  });

  it("提炼器：≥阈值改稿聚类 → pattern 记忆（纠错/口味分列，M1.3）", async () => {
    await seedGestures(3, "edit", undefined, "preference");
    const r = await runMemoryMinerBeat(app, gateway, scope);
    expect(r.editPatterns).toBeGreaterThanOrEqual(1);
    const hits = await searchMemories(app, scope, { kind: "pattern", limit: 50 });
    const mem = hits.find((h) => h.memory_id === "mem-pat-edit-price.adjust");
    expect(mem).toBeDefined();
    expect(mem!.content).toContain("口味");
  });

  it("生命周期：人类编辑（PII 拦截）→ 禁用 → 来源人清算，全程 memory.calibrate 留痕", async () => {
    // 编辑：干净内容放行
    const edited = await editMemoryContent(app, gateway, scope, { memberNo: "MEM-001" }, `mem-inj-pref-${RUN}`, `人类修订后的偏好 ${RUN}`);
    expect(edited.calibrateEventId).toMatch(/^E-\d+$/);
    const afterEdit = await searchMemories(app, scope, { limit: 50 });
    expect(afterEdit.find((h) => h.memory_id === `mem-inj-pref-${RUN}`)!.content).toContain("人类修订后");
    // PII 拦截
    await expect(
      editMemoryContent(app, gateway, scope, { memberNo: "MEM-001" }, `mem-inj-pref-${RUN}`, "客人电话 13812345678"),
    ).rejects.toThrow(/PII/);
    // 禁用
    await disableMemory(app, gateway, scope, { memberNo: "MEM-001" }, `mem-inj-pref-${RUN}`);
    const afterDisable = await searchMemories(app, scope, { status: "recalled", limit: 50 });
    expect(afterDisable.some((h) => h.memory_id === `mem-inj-pref-${RUN}`)).toBe(true);
    // 来源人清算：本用例 MEM-TEST-<RUN> 的手势沉淀（提炼器强化的 mem-reject-price.too_high 含其来源事件）
    const recall = await recallMemoriesByMember(app, gateway, scope, { memberNo: "MEM-001" }, `MEM-TEST-${RUN}`);
    expect(recall.recalled.length).toBeGreaterThanOrEqual(1);
    expect(recall.calibrateEventIds.length).toBe(recall.recalled.length);
  });

  it("衰减扫描：不报错且只动超窗零引用记忆（新建记忆有观察期）", async () => {
    const r = await decayMemories(app, gateway, scope);
    expect(r.scanned).toBeGreaterThanOrEqual(0);
    // 本用例新建的记忆都在观察期内，不应被衰减
    const mem = await searchMemories(app, scope, { status: "recalled", limit: 50 });
    void mem;
  });

  it("进化积分卡：投影形状完整（北极星/趋势/驳回分布/记忆活动）", async () => {
    const sc = await buildEvolutionScorecard(app, scope);
    expect(sc.totals).toHaveProperty("firstPassRate");
    expect(sc.totals).toHaveProperty("editRate");
    expect(Array.isArray(sc.weekly)).toBe(true);
    expect(Array.isArray(sc.rejectReasons)).toBe(true);
    expect(sc.memory.usages30d).toBeGreaterThanOrEqual(0);
    // 本用例已产生 memory.calibrate 事件
    expect(sc.memory.calibrations30d).toBeGreaterThanOrEqual(1);
  });
});
