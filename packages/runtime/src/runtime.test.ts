/**
 * B8 测试：意图路由（F3.2 含糊反问/规则兜底/超时降级）+ 装配三要素（L3.7）+
 * Quest 循环（围栏瀑布/回执）+ replay 断点续跑幂等（H-5）
 * PG 集成仅 RUN_DB_TESTS=1 启用。
 */
import { describe, expect, it } from "vitest";
import { routeIntent, ruleBasedRoute, LlmIntentClassifier, type IntentClassifier } from "./intent.js";
// 注意：loop.js（经 tools.js 模块级常量读 TOOL_UNVERIFIED_RATE）禁止静态 import——
// 否则模块在 env 设置前加载，E3.7 随机扰动无法关闭（#25 flaky 根因）。一律动态 import。

describe("意图路由（F3.2）", () => {
  it("含糊指令反问澄清，不建任务", () => {
    expect(ruleBasedRoute("帮我看看").kind).toBe("clarify");
    expect(ruleBasedRoute("在吗？").kind).toBe("clarify");
  });

  it("三态规则兜底：问句→ask / 逐步→agent / 默认 quest", () => {
    expect(ruleBasedRoute("请问上周 OCC 多少？")).toMatchObject({ kind: "routed", mode: "ask" });
    expect(ruleBasedRoute("逐步生成三版文案，每一步给我审").mode).toBe("agent");
    expect(ruleBasedRoute("把周五雅致大床房调价 5%").mode).toBe("quest");
  });

  it("LLM 分类器输出受白名单约束；垃圾输出回落规则", async () => {
    const good: IntentClassifier = { classify: async () => ({ kind: "routed", mode: "ask", rationale: "x", via: "llm" }) };
    expect((await routeIntent("随便问问", good)).via).toBe("llm");
    const garbage = new LlmIntentClassifier(async () => "not json at all");
    const r = await routeIntent("把周五雅致大床房调价 5%", garbage);
    expect(r.via).toBe("rule");
    expect(r.kind).toBe("routed");
  });

  it("意图路由 3s 超时降级（可取消口径）", async () => {
    const slow: IntentClassifier = { classify: () => new Promise(() => setTimeout(() => undefined, 10_000)) };
    const r = await routeIntent("查一下昨天差评", slow, 50);
    expect(r.via).toBe("timeout_fallback");
    expect(r.kind).toBe("routed");
  });

  it("#27 超时 signal 接线到分类器（底层可真正取消，不再白烧 token）", async () => {
    let received: AbortSignal | undefined;
    const slow: IntentClassifier = {
      classify: (_text, signal) => {
        received = signal;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({ kind: "routed", mode: "ask", rationale: "x", via: "llm" }), 10_000);
          signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
        });
      },
    };
    const r = await routeIntent("查一下昨天差评", slow, 50);
    expect(r.via).toBe("timeout_fallback");
    expect(received).toBeDefined(); // signal 已传入分类器
    expect(received!.aborted).toBe(true); // 超时后确实触发 abort
  });
});

describe("计划模板（演示剧本）", async () => {
  process.env.TOOL_UNVERIFIED_RATE = "0"; // 见文件头注释：须在 loop.js 首次加载前设置
  const { planQuest } = await import("./loop.js");
  const fakePreset = { fenceBindings: [], tools: [], essentials: { archive: {}, stage: "stable", goal: "g" }, agentId: "a", presetKey: "pricing-agent", version: "v2.3", prompt: null };
  it("调价目标 → 3 步（采集/读取/调价）", () => {
    const steps = planQuest("周五调价 5%", fakePreset);
    expect(steps.map((s) => s.action)).toEqual(["competitor.fetch", "biz.price.read", "price.adjust"]);
  });
});

describe("LLM 任务规划（B9 planQuestSmart）", async () => {
  const { planQuestSmart } = await import("./loop.js");
  const fakePreset = { fenceBindings: [], tools: [], essentials: { archive: {}, stage: "stable", goal: "g" }, agentId: "a", presetKey: "pricing-agent", version: "v2.3", prompt: null };

  it("合法规划被采用，且价格类步骤自动数据水合（before/after/context 防 E2.1 误熔断）", async () => {
    const llm = async () => JSON.stringify([
      { action: "biz.price.read", objectType: "room_price", tool: "biz.price.read", params: {}, label: "读价" },
      { action: "price.adjust", objectType: "room_price", tool: "biz.price.write", params: { price: 468 }, label: "调价" },
    ]);
    const steps = await planQuestSmart("调价", fakePreset as never, llm);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ before: { price: 458 }, after: { price: 468 } });
    expect(steps[1]?.context).toMatchObject({ night_shift: false });
  });

  it("垃圾 JSON / 越白名单工具 / 步数越界 → 一律回退确定性模板（D4）", async () => {
    const garbage = await planQuestSmart("周五调价 5%", fakePreset as never, async () => "not json");
    expect(garbage.map((s) => s.action)).toEqual(["competitor.fetch", "biz.price.read", "price.adjust"]);
    const evil = await planQuestSmart("周五调价 5%", fakePreset as never, async () =>
      JSON.stringify([{ action: "x", objectType: "room", tool: "shell.exec", params: {}, label: "越权" }]));
    expect(evil.map((s) => s.action)).toEqual(["competitor.fetch", "biz.price.read", "price.adjust"]);
    const tooMany = await planQuestSmart("周五调价 5%", fakePreset as never, async () =>
      JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ action: "a" + i, objectType: "room", tool: "order.list", params: {}, label: "s" }))));
    expect(tooMany).toHaveLength(3);
  });

  it("未配置 llmCall → 直接走模板（mock 默认口径）", async () => {
    const steps = await planQuestSmart("周五调价 5%", fakePreset as never, undefined);
    expect(steps.map((s) => s.action)).toEqual(["competitor.fetch", "biz.price.read", "price.adjust"]);
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成 Quest 循环（种子库）", async () => {
  // #25 修复：demo 工具 10% 随机 synced:false 会让全流程测试概率性转 failed（E3.7 未核实），
  // 集成测试关闭随机扰动保证可重跑；须在动态 import loop.js（链至 tools.js 模块级常量）之前设置
  process.env.TOOL_UNVERIFIED_RATE = "0";
  const pg = (await import("pg")).default;
  const { runQuest } = await import("./loop.js");
  const { assemblePreset, AssemblyReject } = await import("./assembly.js");
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };

  const newThread = async (title: string) => {
    const id = `T-${Date.now().toString(36)}-${Math.floor(Math.random() * 999)}`;
    const c = await app.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [scope.tenantId]);
      await c.query(
        `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by)
         VALUES ($1,$2,$3,$4,'quest','queued','MEM-001')`,
        [id, scope.tenantId, scope.workspaceId, title],
      );
    } finally { c.release(); }
    return id;
  };

  const threadEvents = async (threadId: string) => {
    const c = await gw.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const r = await c.query<{ payload: import('@workloom/shared').BusinessEvent }>(
        `SELECT payload FROM biz_events WHERE tenant_id=$1 AND session_id=$2 ORDER BY seq`,
        [scope.tenantId, threadId],
      );
      return r.rows.map((x) => x.payload);
    } finally { c.release(); }
  };

  it("L3.7 三要素缺一拒绝（目标缺失）", async () => {
    await expect(
      assemblePreset(app, scope, { workspaceId: scope.workspaceId, presetKey: "pricing-agent", goal: "" }),
    ).rejects.toThrow(AssemblyReject);
  });

  it("调价 Quest 全流程：3 步自动执行 → completed，事件带 step_id+回执", async () => {
    const tid = await newThread("周五雅致大床房调价");
    const r = await runQuest(app, gw, scope, { threadId: tid, goal: "周五调价 2%", presetKey: "pricing-agent" });
    expect(r.status).toBe("completed");
    expect(r.stepsDone).toBe(3);
    const evs = await threadEvents(tid);
    expect(evs.map((e) => e.decision.step_id)).toEqual(["s1", "s2", "s3"]);
    const adjust = evs.find((e) => e.decision.action === "price.adjust")!;
    expect((adjust.rule_impact as Array<{ rule_id: string }>)[0]!.rule_id).toBe("R1"); // 涨幅≤8% auto
    expect(adjust.receipt).toBeDefined(); // 回执位（L3.6）
  });

  it("差评 Quest：R6 越围栏挂起 → pending_review + 审批行", async () => {
    const tid = await newThread("回复差评");
    const r = await runQuest(app, gw, scope, { threadId: tid, goal: "回复差评", presetKey: "review-agent" });
    expect(r.status).toBe("pending_review");
    expect(r.pendingApprovalId).toBeDefined();
    const c = await app.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const a = await c.query(`SELECT status FROM approvals WHERE approval_id=$1`, [r.pendingApprovalId]);
      expect(a.rows[0].status).toBe("pending");
    } finally { c.release(); }
  });

  it("#34 审批通过 → replay 恢复执行：挂起步骤带授权引用完成，Quest 闭环 completed", async () => {
    const { decide } = await import("@workloom/base/review-console");
    const tid = await newThread("回复差评求恢复");
    const r1 = await runQuest(app, gw, scope, { threadId: tid, goal: "回复差评", presetKey: "review-agent" });
    expect(r1.status).toBe("pending_review");
    const approvalId = r1.pendingApprovalId!;
    // 修复前：审批通过后 replay 会再次挂起（死循环，Quest 永远卡 pending_review）
    await decide(app, gw, scope, { memberNo: "MEM-001", role: "owner" }, approvalId, { type: "approve" });
    const r2 = await runQuest(app, gw, scope, { threadId: tid, goal: "回复差评", presetKey: "review-agent" });
    expect(r2.status).toBe("completed");
    expect(r2.stepsDone).toBe(2); // s1（已完成跳过）+ s2（批准执行）
    const evs = await threadEvents(tid);
    const resumed = evs.find((e) => e.decision.action === "review.reply" && Array.isArray(e.decision.basis) && (e.decision.basis as string[]).some((b) => b.includes("经审批")));
    expect(resumed).toBeTruthy(); // 执行事件带「经审批 <id> 批准执行」留痕
    expect((resumed!.decision.basis as string[])[0]).toContain(approvalId);
    // 恢复执行不产生新审批行（同线程审批数不变）
    const c = await app.connect();
    try {
      await c.query("SELECT set_config('app.workspace_id', $1, false)", [scope.workspaceId]);
      const n = await c.query<{ c: string }>(
        `SELECT count(*) AS c FROM approvals a JOIN biz_events e ON e.event_id=a.event_id WHERE e.session_id=$1`,
        [tid],
      );
      expect(Number(n.rows[0]!.c)).toBe(1); // 仅最初挂起产生的那一条
    } finally { c.release(); }
    // 再次 replay 幂等：不产生新事件
    const n1 = evs.length;
    await runQuest(app, gw, scope, { threadId: tid, goal: "回复差评", presetKey: "review-agent" });
    expect((await threadEvents(tid)).length).toBe(n1);
  });

  it("H-5 replay 断点续跑幂等：重复运行不产生重复事件", async () => {
    const tid = await newThread("对账任务");
    const r1 = await runQuest(app, gw, scope, { threadId: tid, goal: "夜间对账", presetKey: "reconcile-agent" });
    expect(r1.status).toBe("completed");
    const n1 = (await threadEvents(tid)).length;
    // 模拟 kill -9 后重放：再跑一次同一线程
    const r2 = await runQuest(app, gw, scope, { threadId: tid, goal: "夜间对账", presetKey: "reconcile-agent" });
    const n2 = (await threadEvents(tid)).length;
    expect(n2).toBe(n1); // 幂等：零新增事件
    expect(r2.stepsDone).toBe(r1.stepsDone);
  });

  it("#24 装配围栏并集：安装技能绑定进装配声明（F8.2/L8.3），卸载即收缩", async () => {
    const { installSkill, uninstallSkill, listSkills } = await import("@workloom/base/skills");
    const revenue = (await listSkills(app, scope, { level: "official" })).find((s) => s.name === "revenue-manager")!;
    // 从「未安装」态开始（重跑安全）
    await uninstallSkill(app, gw, scope, { skillId: revenue.id, by: "MEM-001" }).catch(() => undefined);
    const before = await assemblePreset(app, scope, { workspaceId: scope.workspaceId, presetKey: "content-agent", goal: "装配并集探针" });
    // 0013 契约：seed 安装行落真实快照——review-crisis(R6)、channel-reconciler(R4/R5) 在装，
    // 并集 = content-agent 自身声明 R3 ∪ 全部在装技能快照
    expect(before.fenceBindings).toEqual(["R3", "R4", "R5", "R6"]);
    // 安装即绑定：装配声明并入技能 fence_bindings 快照
    await installSkill(app, gw, scope, { skillId: revenue.id, by: "MEM-001" });
    const after = await assemblePreset(app, scope, { workspaceId: scope.workspaceId, presetKey: "content-agent", goal: "装配并集探针" });
    expect(after.fenceBindings).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]); // preset 声明 ∪ 技能快照
    // 卸载即撤销：并集收缩
    await uninstallSkill(app, gw, scope, { skillId: revenue.id, by: "MEM-001" });
    const revoked = await assemblePreset(app, scope, { workspaceId: scope.workspaceId, presetKey: "content-agent", goal: "装配并集探针" });
    expect(revoked.fenceBindings).toEqual(["R3", "R4", "R5", "R6"]);
  });
});
