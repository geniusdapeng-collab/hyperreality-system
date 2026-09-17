/**
 * B4 测试：表达式求值器 / 判定器语义 / 单调守卫 / dry-run 回放 / 对象写锁
 * PG 集成（dry-run 入库/激活门禁/写锁超时）仅 RUN_DB_TESTS=1 启用。
 */
import { describe, expect, it } from "vitest";
import { evalCondition, FenceEvalError } from "./expr.js";
import { judge, judgeSubCall, type RuntimeRule } from "./judge.js";
import { checkMonotonic, loadFencePack } from "./dsl.js";
import { fenceActivationFromProposal, fenceRuleRowId } from "./lifecycle.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_YML = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../bundles/hotel/fences/hotel-baseline.yml",
);

describe("表达式求值器（L2.5 沙箱）", () => {
  it("算术与比较：R1 涨幅公式", () => {
    const scope = { before: { price: 400 }, after: { price: 420 } };
    expect(evalCondition("abs(after.price - before.price) / before.price <= 0.08", scope)).toBe(true);
    expect(evalCondition("abs(after.price - before.price) / before.price <= 0.08", {
      before: { price: 400 }, after: { price: 460 },
    })).toBe(false);
  });

  it("保底价/阈值/布尔与逻辑", () => {
    expect(evalCondition("after.price < 380", { after: { price: 368 } })).toBe(true);
    expect(evalCondition("params.amount >= 500", { params: { amount: 500 } })).toBe(true);
    expect(evalCondition("context.channel_new == true", { context: { channel_new: true } })).toBe(true);
    expect(evalCondition("params.rating <= 3 and params.rating > 0", { params: { rating: 2 } })).toBe(true);
    expect(evalCondition("not (params.rating <= 3)", { params: { rating: 5 } })).toBe(true);
  });

  it("非法输入抛 FenceEvalError（除零/未知路径/类型错误）", () => {
    expect(() => evalCondition("after.price / 0 > 1", { after: { price: 1 } })).toThrow(FenceEvalError);
    expect(() => evalCondition("after.nope > 1", { after: {} })).toThrow(FenceEvalError);
    expect(() => evalCondition("process.exit(1)", {})).toThrow(FenceEvalError);
    expect(() => evalCondition("'a' + 1 > 0", {})).toThrow(FenceEvalError);
  });

  it("空条件恒命中", () => {
    expect(evalCondition("", {})).toBe(true);
  });
});

describe("判定器（F2.1/E2.1/E2.2，真实基线包）", () => {
  const pack = loadFencePack(readFileSync(BUNDLE_YML, "utf-8"));

  it("R1 涨幅 ≤8% → auto 放行；>8% 无命中 → default review", () => {
    const ok = judge(
      { object: { type: "room_price" }, action: "price.adjust", before: { price: 400 }, after: { price: 420 }, context: { channel_new: false } },
      pack.rules, pack.defaultLevel,
    );
    expect(ok.level).toBe("auto");
    expect(ok.impacts[0]).toMatchObject({ rule_id: "R1", result: "pass" });

    const over = judge(
      { object: { type: "room_price" }, action: "price.adjust", before: { price: 400 }, after: { price: 460 }, context: { channel_new: false } },
      pack.rules, pack.defaultLevel,
    );
    expect(over.level).toBe("review"); // default_level
  });

  it("R2 保底价熔断 → block（即便 R1 也命中，deny 优先并集 E2.2）", () => {
    const v = judge(
      { object: { type: "room_price" }, action: "price.adjust", before: { price: 398 }, after: { price: 368 } },
      pack.rules, pack.defaultLevel,
    );
    expect(v.level).toBe("block");
    expect(v.impacts).toContainEqual({ rule_id: "R2", version: pack.version, result: "blocked" });
  });

  it("R6 差评必审 → review", () => {
    const v = judge(
      { object: { type: "review" }, action: "review.reply", params: { rating: 2 } },
      pack.rules, pack.defaultLevel,
    );
    expect(v.level).toBe("review");
    expect(v.impacts[0]!.rule_id).toBe("R6");
  });

  it("求值异常按 block（E2.1）", () => {
    const weird: RuntimeRule = {
      rule_id: "R9", version: "test", name: "故意异常", level: "review", is_baseline: false,
      objectTypes: ["order"], actions: ["order.reconcile"], when: "params.missing.deep > 1",
    };
    const v = judge({ object: { type: "order" }, action: "order.reconcile", params: {} }, [weird], "auto");
    expect(v.level).toBe("block");
    expect(v.evalErrors.length).toBe(1);
  });

  it("子调用同瀑布（H-4）：同输入同判定，无后门", () => {
    const input = {
      object: { type: "order" }, action: "order.refund",
      params: { amount: 800 },
    };
    const a = judge(input, pack.rules, pack.defaultLevel);
    const b = judgeSubCall(input, pack.rules, pack.defaultLevel);
    expect(b.level).toBe(a.level);
    expect(b.impacts).toEqual(a.impacts);
    expect(a.level).toBe("review"); // R4 大额退款
  });
});

describe("单调守卫（F2.3/H-3）", () => {
  const pack = loadFencePack(readFileSync(BUNDLE_YML, "utf-8"));

  it("放宽基线被拒且留痕（R2 block→review 降级）", () => {
    const patch = pack.rules.map((r) =>
      r.rule_id === "R2" ? { ...r, level: "review" as const } : r,
    );
    const r = checkMonotonic(pack.rules, patch);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.reason).toContain("放宽");
  });

  it("删除基线被拒；加严放行", () => {
    const deleted = checkMonotonic(pack.rules, pack.rules.filter((r) => r.rule_id !== "R6"));
    expect(deleted.ok).toBe(false);

    const stricter = checkMonotonic(
      pack.rules,
      pack.rules.map((r) => (r.rule_id === "R1" ? { ...r, level: "review" as const } : r)),
    );
    expect(stricter.ok).toBe(true);
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成（dry-run / 激活门禁 / 对象写锁）", async () => {
  const pg = (await import("pg")).default;
  const { createDryRun, confirmDryRun, activateRuleVersion, withObjectLock, ObjectLockTimeout } =
    await import("./lifecycle.js");
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gwPool = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
  const pack = loadFencePack(readFileSync(BUNDLE_YML, "utf-8"));

  it("dry-run 回放最近 10 条 → 报告入库 pending（F2.5）", async () => {
    const r = await createDryRun(appPool, scope, {
      ruleId: "R1", ruleVersion: "hotel-baseline/v1", rules: pack.rules,
      defaultLevel: pack.defaultLevel, createdBy: "MEM-001",
    });
    expect(r.report.replayed).toBe(10);
    expect(r.report.wouldBlock.length + r.report.wouldReview.length + r.report.unchanged).toBe(10);
  });

  it("未确认 dry-run 禁止激活（L2.4）", async () => {
    const dr = await createDryRun(appPool, scope, {
      ruleId: "R2", ruleVersion: "hotel-baseline/v1", rules: pack.rules,
      defaultLevel: pack.defaultLevel, createdBy: "MEM-001",
    });
    await expect(
      activateRuleVersion(appPool, scope, { ruleRowId: "fr-r2-v1-ws-yunqi", dryRunId: dr.dryRunId, approvalEventId: "E-8804" }),
    ).rejects.toThrow(/未确认/);
  });

  it("对象写锁：持锁期间他人超时转「需介入」（E2.5）", async () => {
    await expect(
      withObjectLock(gwPool, "room_price:RT-DLX-KING", async (hold) => {
        // 持锁期间，另一个连接尝试同对象 → 500ms 超时
        await expect(
          withObjectLock(gwPool, "room_price:RT-DLX-KING", async () => "never", 500),
        ).rejects.toThrow(ObjectLockTimeout);
        // 不真正写库，仅验证锁语义
        await hold.query("SELECT 1");
      }),
    ).resolves.toBeUndefined();
  });

  it("confirmDryRun 幂等约束：重复确认报错", async () => {
    const dr = await createDryRun(appPool, scope, {
      ruleId: "R3", ruleVersion: "hotel-baseline/v1", rules: pack.rules,
      defaultLevel: pack.defaultLevel, createdBy: "MEM-001",
    });
    await confirmDryRun(appPool, scope, dr.dryRunId);
    await expect(confirmDryRun(appPool, scope, dr.dryRunId)).rejects.toThrow(/非 pending/);
  });
});

/* ================= E1 联调接线：审批 → 激活参数提取（纯函数，PF.5/F2.4） ================= */

describe("fenceActivationFromProposal（E1 审批→激活接线）", () => {
  const WS = "ws-yunqi";

  it("fenceRuleRowId 生成口径稳定（与 confirmDryRun 入库一致）", () => {
    expect(fenceRuleRowId("R7", WS)).toBe("fr-r7-vnext-ws-yunqi");
  });

  it("fence.rule.propose 事件 → 提取 ruleRowId + dryRunId", () => {
    const payload = {
      decision: { action: "fence.rule.propose", after: { ruleId: "R7", dryRunId: "fdr-r7-abc" } },
    };
    expect(fenceActivationFromProposal(payload, WS)).toEqual({
      ruleRowId: "fr-r7-vnext-ws-yunqi",
      dryRunId: "fdr-r7-abc",
    });
  });

  it("非提案事件 / 缺字段 → null（不激活）", () => {
    expect(fenceActivationFromProposal({ decision: { action: "price.adjust" } }, WS)).toBeNull();
    expect(fenceActivationFromProposal({ decision: { action: "fence.rule.propose", after: { ruleId: "R7" } } }, WS)).toBeNull();
    expect(fenceActivationFromProposal(null, WS)).toBeNull();
    expect(fenceActivationFromProposal({}, WS)).toBeNull();
  });
});
