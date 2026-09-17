/**
 * publish-rpa · 执行器（fusion-design §7，G9 围栏预检）
 *
 * 流程：任务领取（pending→running）→ 围栏预检（G9：publish.execute，非 auto 即挂起待审，
 *      适配器根本不执行）→ 单账号日上限检查（默认 5）→ 登录态检测（未登录转人工）
 *      → 适配器执行（upload → receiptProbe）→ 回执落事件（publish.executed，receipt 位）
 *      → 任一失败挂起转人工（status=manual + publish.failed 事件，异常即挂起转人工纪律）
 * 一切状态写与事件写同一 COMMIT（D16）；适配器只经 BrowserDriver seam，不碰真实浏览器。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import type { JudgeInput, JudgeVerdict, RuleImpact } from "../fence-engine/judge.js";
import type { BrowserDriver, PublishAdapter } from "./adapters/base.js";
import type { Platform, PublishReceipt, PublishTask } from "./types.js";

interface Scope { tenantId: string; workspaceId: string }

/** 单账号日上限默认 5（风控纪律：模拟人工节奏外的硬闸） */
export const DAILY_LIMIT_DEFAULT = 5;

export interface RunnerDeps {
  /** 平台 → 适配器（未配置的平台任务直接转人工） */
  adapters: Partial<Record<Platform, PublishAdapter>>;
  /** 浏览器驱动（桌包包注入 Playwright 实现；测试注入 fake） */
  driver: BrowserDriver;
  /** G9 围栏预检（fence-engine judge 注入；write 动作无命中按行业包 default_level） */
  fencePrecheck: (input: JudgeInput) => JudgeVerdict;
  /** 单账号日上限（默认 DAILY_LIMIT_DEFAULT） */
  dailyLimit?: number;
  now?: Date;
}

export type PublishRunKind =
  | "executed"        // 已执行且回执落事件
  | "held_fence"      // 围栏未放行（G9 review/block）→ pending_review，适配器未执行
  | "held_daily_limit"// 单日上限 → 退回 pending 等次日
  | "manual"          // 未登录/执行失败/无适配器 → 转人工
  | "not_claimable";  // 任务不存在或非 pending（幂等领取失败）

export interface PublishRunResult {
  kind: PublishRunKind;
  taskId: string;
  level?: JudgeVerdict["level"];
  receipt?: PublishReceipt;
  error?: string;
}

/** 事务内事件留痕（D16：调用方持有事务，与任务状态写同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  taskId: string,
  decision: Record<string, unknown>,
  opts: { receipt?: PublishReceipt; ruleImpact?: RuleImpact[] } = {},
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: "publish-rpa", type: "system" },
  }, {
    who: { type: "system", id: "publish-rpa" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "publish_task", id: taskId },
    decision: decision as never,
    rule_impact: opts.ruleImpact ?? [],
    receipt: opts.receipt
      ? { synced: opts.receipt.synced, snapshot_uri: opts.receipt.evidenceUri, verified_at: opts.receipt.verifiedAt }
      : undefined,
  });
  return r.eventId;
}

/** 东八区当日窗口（日上限口径与 night-shift/cron 同区） */
export function shanghaiDayBounds(now: Date): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = `${get("year")}-${get("month").padStart(2, "0")}-${get("day").padStart(2, "0")}`;
  return { from: `${day}T00:00:00+08:00`, to: `${day}T23:59:59.999+08:00` };
}

/** 任务领取 + 全链执行（单任务入口；批量调度由 night-shift triggers 派遣） */
export async function runPublishTask(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  taskId: string,
  deps: RunnerDeps,
): Promise<PublishRunResult> {
  /* ---- ① 领取（pending → running；非 pending 幂等退出） ---- */
  let task: PublishTask | null = null;
  {
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const r = await client.query<PublishTask>(
        `UPDATE publish_tasks SET status='running'
         WHERE workspace_id=$1 AND id=$2 AND status='pending' RETURNING *`,
        [scope.workspaceId, taskId],
      );
      task = r.rows[0] ?? null;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  if (!task) return { kind: "not_claimable", taskId };

  /** 状态收尾 + 事件留痕（同一 COMMIT） */
  const finalize = async (
    status: "pending" | "pending_review" | "succeeded" | "failed" | "manual",
    decision: Record<string, unknown>,
    opts: { receipt?: PublishReceipt; ruleImpact?: RuleImpact[]; error?: string } = {},
  ): Promise<void> => {
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
      await client.query(
        `UPDATE publish_tasks SET status=$3, error=$4,
           receipt=COALESCE($5::jsonb, receipt),
           executed_at=CASE WHEN $3='succeeded' THEN now() ELSE executed_at END
         WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, taskId, status, opts.error ?? null,
          opts.receipt ? JSON.stringify(opts.receipt) : null],
      );
      await emitInTx(client, scope, taskId, decision, opts);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  /* ---- ② 围栏预检（G9：publish.execute；非 auto 即挂起待审，适配器不执行） ---- */
  const verdict = deps.fencePrecheck({
    object: { type: "publish_task", id: taskId },
    action: "publish.execute",
    params: { platform: task.platform, accountId: task.account_id, scheduleAt: task.schedule_at },
  });
  if (verdict.level !== "auto") {
    await finalize("pending_review", {
      action: "publish.fence_hold",
      after: { taskId, platform: task.platform, level: verdict.level, triggeredBy: verdict.triggeredBy },
      basis: [`G9 围栏预检 ${verdict.level}（公网发布必审基线）：${verdict.triggeredBy.join("；")}`],
    }, { ruleImpact: verdict.impacts });
    return { kind: "held_fence", taskId, level: verdict.level };
  }

  /* ---- ③ 单账号日上限（默认 5；超限退回 pending 等次日，不算失败） ---- */
  const limit = deps.dailyLimit ?? DAILY_LIMIT_DEFAULT;
  {
    const bounds = shanghaiDayBounds(deps.now ?? new Date());
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const r = await client.query<{ c: string }>(
        `SELECT count(*) AS c FROM publish_tasks
         WHERE workspace_id=$1 AND account_id=$2 AND status='succeeded'
           AND executed_at >= $3::timestamptz AND executed_at <= $4::timestamptz`,
        [scope.workspaceId, task.account_id, bounds.from, bounds.to],
      );
      await client.query("COMMIT");
      if (Number(r.rows[0]?.c ?? 0) >= limit) {
        await finalize("pending", {
          action: "publish.daily_limit",
          after: { taskId, accountId: task.account_id, limit, day: bounds.from.slice(0, 10) },
          basis: [`单账号日上限 ${limit}（风控纪律）：当日已达上限，退回 pending 等次日`],
        });
        return { kind: "held_daily_limit", taskId };
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /* ---- ④ 适配器执行（未登录/异常/无适配器 → 转人工） ---- */
  const adapter = deps.adapters[task.platform];
  if (!adapter) {
    await finalize("manual", {
      action: "publish.failed",
      after: { taskId, platform: task.platform, reason: "NO_ADAPTER" },
      basis: ["平台适配器未配置（tiktok/shipinhao 为占位，需真实账号环境联调），转人工"],
    }, { error: "NO_ADAPTER" });
    return { kind: "manual", taskId, error: "NO_ADAPTER" };
  }
  try {
    if (!(await adapter.loginCheck(deps.driver))) {
      await finalize("manual", {
        action: "publish.failed",
        after: { taskId, platform: task.platform, reason: "LOGIN_REQUIRED" },
        basis: ["登录态失效：登录由用户本人在桌面包完成（凭据只存本机），转人工接管"],
      }, { error: "LOGIN_REQUIRED" });
      return { kind: "manual", taskId, error: "LOGIN_REQUIRED" };
    }
    const upload = await adapter.upload(deps.driver, {
      videoPath: task.video_path,
      coverPath: task.cover_path ?? undefined,
      caption: task.caption,
      tags: task.tags,
      scheduleAt: task.schedule_at ?? undefined,
    });
    const receipt = await adapter.receiptProbe(deps.driver, { taskId, upload });
    await finalize("succeeded", {
      action: "publish.executed",
      after: { taskId, platform: task.platform, platformPostId: receipt.platformPostId ?? null, url: receipt.url ?? null },
      basis: ["RPA 模拟人工上传完成，回执落事件 receipt 位（L3.6/E3.7）"],
    }, { receipt });
    return { kind: "executed", taskId, receipt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalize("manual", {
      action: "publish.failed",
      after: { taskId, platform: task.platform, reason: message },
      basis: ["执行异常即挂起转人工（§7 风控纪律：人工接管点）"],
    }, { error: message });
    return { kind: "manual", taskId, error: message };
  }
}
