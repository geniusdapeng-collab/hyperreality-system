/**
 * social-listening · 指标采集与阈值告警（fusion-design §4 account-ops 管线，account_metrics 时序表）
 *
 *  - 采集落账：账号/视频指标时序（播放/点赞/评论/分享/转化），夜班采集落账
 *  - 阈值告警：纯函数判定（below/above/drop_ratio），命中即写 metrics.threshold_alert 事件
 *  - 早八点战报：聚合接口 + night-shift 调度对接预留（MORNING_REPORT_CRON + 派遣模板）
 * 一切写入经 workdata 安全网关落五元事件（D16：业务行与事件同一 COMMIT）
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

interface Scope { tenantId: string; workspaceId: string }

/* ---------- 采集落账 ---------- */

export interface MetricEntry {
  platform: string;
  accountId: string;
  /** 空 = 账号级快照 */
  videoId?: string;
  capturedAt: string;
  plays?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  conversions?: number;
}

/** 事务内事件留痕（D16：调用方持有事务，与指标行同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  objectId: string,
  decision: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: "metrics-watcher", type: "system" },
  }, {
    who: { type: "system", id: "metrics-watcher" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "account_metrics", id: objectId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

/** 指标采集落账（批量同事务；一条 metrics.collected 事件汇总） */
export async function recordMetrics(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  entries: MetricEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    for (const e of entries) {
      await client.query(
        `INSERT INTO account_metrics
           (workspace_id, platform, account_id, video_id, captured_at, plays, likes, comments, shares, conversions)
         VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10)`,
        [
          scope.workspaceId, e.platform, e.accountId, e.videoId ?? null, e.capturedAt,
          e.plays ?? 0, e.likes ?? 0, e.comments ?? 0, e.shares ?? 0, e.conversions ?? 0,
        ],
      );
    }
    // D16（#1/A）：指标行与采集事件同一事务同一 COMMIT
    await emitInTx(client, scope, `${scope.workspaceId}`, {
      action: "metrics.collected",
      after: { count: entries.length, accounts: [...new Set(entries.map((e) => e.accountId))] },
      basis: ["账号/视频指标时序落账（account-ops 管线：metrics.collect 每 2h）"],
    });
    await client.query("COMMIT");
    return entries.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- 阈值告警（纯函数判定） ---------- */

export type MetricKey = "plays" | "likes" | "comments" | "shares" | "conversions";

export interface ThresholdRule {
  name: string;
  metric: MetricKey;
  /** below=低于阈值；above=高于阈值；drop_ratio=较基线跌幅超过 value（0-1） */
  kind: "below" | "above" | "drop_ratio";
  value: number;
}

export interface MetricSnapshot {
  accountId: string;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  conversions: number;
}

export interface ThresholdAlert {
  rule: string;
  accountId: string;
  metric: MetricKey;
  current: number;
  baseline?: number;
  message: string;
}

/** 阈值判定（纯函数）：current vs baseline（drop_ratio 需要；baseline 为 0 时跳过防除零误报） */
export function evalThresholds(
  current: MetricSnapshot[],
  baseline: MetricSnapshot[],
  rules: ThresholdRule[],
): ThresholdAlert[] {
  const baseByAccount = new Map(baseline.map((b) => [b.accountId, b]));
  const alerts: ThresholdAlert[] = [];
  for (const cur of current) {
    for (const rule of rules) {
      const value = cur[rule.metric];
      if (rule.kind === "below" && value < rule.value) {
        alerts.push({ rule: rule.name, accountId: cur.accountId, metric: rule.metric, current: value, message: `${rule.metric}=${value} 低于阈值 ${rule.value}` });
      } else if (rule.kind === "above" && value > rule.value) {
        alerts.push({ rule: rule.name, accountId: cur.accountId, metric: rule.metric, current: value, message: `${rule.metric}=${value} 高于阈值 ${rule.value}` });
      } else if (rule.kind === "drop_ratio") {
        const base = baseByAccount.get(cur.accountId)?.[rule.metric];
        if (base === undefined || base === 0) continue; // 无基线/基线为 0 → 不判定（防误报）
        const ratio = (base - value) / base;
        if (ratio > rule.value) {
          alerts.push({ rule: rule.name, accountId: cur.accountId, metric: rule.metric, current: value, baseline: base, message: `${rule.metric} 较基线 ${base} 跌 ${(ratio * 100).toFixed(1)}%（阈值 ${(rule.value * 100).toFixed(0)}%）` });
        }
      }
    }
  }
  return alerts;
}

/** 阈值巡检：读最近两次快照 → 判定 → 命中写 metrics.threshold_alert 事件（account-ops：threshold.check） */
export async function checkThresholds(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  rules: ThresholdRule[],
): Promise<ThresholdAlert[]> {
  const client = await app.connect();
  let current: MetricSnapshot[] = [];
  let baseline: MetricSnapshot[] = [];
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    // 账号级（video_id IS NULL）最近两次快照：current=最新，baseline=次新
    const r = await client.query<{
      account_id: string; captured_at: string;
      plays: string; likes: string; comments: string; shares: string; conversions: string;
    }>(
      `SELECT account_id, captured_at, plays, likes, comments, shares, conversions
       FROM account_metrics WHERE workspace_id=$1 AND video_id IS NULL
       ORDER BY account_id, captured_at DESC`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    const seen = new Map<string, number>();
    for (const row of r.rows) {
      const n = seen.get(row.account_id) ?? 0;
      seen.set(row.account_id, n + 1);
      const snap: MetricSnapshot = {
        accountId: row.account_id,
        plays: Number(row.plays), likes: Number(row.likes), comments: Number(row.comments),
        shares: Number(row.shares), conversions: Number(row.conversions),
      };
      if (n === 0) current.push(snap);
      else if (n === 1) baseline.push(snap);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const alerts = evalThresholds(current, baseline, rules);
  if (alerts.length > 0) {
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
      await emitInTx(client, scope, scope.workspaceId, {
        action: "metrics.threshold_alert",
        after: { alerts },
        basis: [`阈值告警 ${alerts.length} 条（account-ops 管线：threshold.check）`],
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return alerts;
}

/* ---------- 早八点战报（与 night-shift 调度对接预留） ---------- */

/** 早八点战报 cron（Asia/Shanghai，与 night-shift cronMatches 同区同口径） */
export const MORNING_REPORT_CRON = "0 8 * * *";

/**
 * night-shift 对接预留：返回可直传 upsertTrigger 的派遣模板。
 * 注册后由 trigger-engine tick 触发 → trigger.fired 事件 → runtime 装配 metrics-watcher 执行
 * buildMorningReport（account-ops 管线：早八点战报，fusion-design §4）。
 */
export function morningReportTriggerAction(scope: Scope): Record<string, unknown> {
  return {
    dispatch: "metrics-watcher",
    task: "morning_report",
    workspaceId: scope.workspaceId,
    cron: MORNING_REPORT_CRON,
  };
}

export interface MorningReportRow {
  account_id: string;
  platform: string;
  plays: string;
  likes: string;
  comments: string;
  shares: string;
  conversions: string;
}

/** 早八点战报聚合：窗口内各账号最新账号级快照 + 视频条数（纯读，越权返回空 L7.1 同源） */
export async function buildMorningReport(
  app: pg.Pool,
  scope: Scope,
  window: { from: string; to: string },
): Promise<{ rows: MorningReportRow[]; window: { from: string; to: string } }> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<MorningReportRow>(
      `SELECT DISTINCT ON (account_id) account_id, platform, plays, likes, comments, shares, conversions
       FROM account_metrics
       WHERE workspace_id=$1 AND video_id IS NULL AND captured_at >= $2::timestamptz AND captured_at <= $3::timestamptz
       ORDER BY account_id, captured_at DESC`,
      [scope.workspaceId, window.from, window.to],
    );
    await client.query("COMMIT");
    return { rows: r.rows, window };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
