/**
 * evolve · 进化积分卡（自我进化飞轮 M5，D24）
 *
 * 全部从既有表投影（approvals / org_memory / memory_usage / biz_events），零新数据源：
 *  - 北极星：审批一次通过率（approved / 已裁决）——Agent 越来越懂这家企业的直接口径；
 *  - 过程：人类修改率、驳回原因分布（结构化枚举才能聚类，M1.2 的价值出口）；
 *  - 趋势：近 8 周一次通过率周序列（飞轮效果看斜率不看绝对值）；
 *  - 记忆：active 记忆分布、近 30 天引用次数（M3 注入生效量）、memory.calibrate 次数（进化活动量）。
 */
import type pg from "pg";

interface Scope {
  tenantId: string;
  workspaceId: string;
}

export interface EvolutionScorecard {
  totals: {
    decided: number;
    approved: number;
    edited: number;
    rejected: number;
    /** 北极星：一次通过率（无裁决样本时为 null） */
    firstPassRate: number | null;
    editRate: number | null;
  };
  /** 近 8 周一次通过率（week_start 升序；样本为 0 的周 firstPassRate=null） */
  weekly: Array<{ weekStart: string; decided: number; firstPassRate: number | null }>;
  /** 驳回原因分布（reason_enum → 次数，降序） */
  rejectReasons: Array<{ reasonEnum: string; count: number }>;
  memory: {
    activeByKind: Record<string, number>;
    /** 近 30 天记忆被引用次数（偏好注入生效量） */
    usages30d: number;
    /** 近 30 天 memory.calibrate 事件数（进化活动量） */
    calibrations30d: number;
  };
}

export async function buildEvolutionScorecard(
  app: pg.Pool,
  scope: Scope,
): Promise<EvolutionScorecard> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);

    const totals = await client.query<{
      decided: string; approved: string; edited: string; rejected: string;
    }>(
      `SELECT count(*) FILTER (WHERE status IN ('approved','edited','rejected'))::text AS decided,
              count(*) FILTER (WHERE status='approved')::text AS approved,
              count(*) FILTER (WHERE status='edited')::text AS edited,
              count(*) FILTER (WHERE status='rejected')::text AS rejected
       FROM approvals WHERE tenant_id=$1 AND workspace_id=$2`,
      [scope.tenantId, scope.workspaceId],
    );

    const weekly = await client.query<{ week_start: string; decided: string; approved: string }>(
      `SELECT date_trunc('week', decided_at)::date::text AS week_start,
              count(*)::text AS decided,
              count(*) FILTER (WHERE status='approved')::text AS approved
       FROM approvals
       WHERE tenant_id=$1 AND workspace_id=$2
         AND status IN ('approved','edited','rejected')
         AND decided_at > now() - interval '8 weeks'
       GROUP BY 1 ORDER BY 1`,
      [scope.tenantId, scope.workspaceId],
    );

    const reasons = await client.query<{ reason_enum: string; n: string }>(
      `SELECT gesture->>'reason_enum' AS reason_enum, count(*)::text AS n
       FROM approvals
       WHERE tenant_id=$1 AND workspace_id=$2 AND status='rejected'
         AND gesture->>'reason_enum' IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [scope.tenantId, scope.workspaceId],
    );

    const memKinds = await client.query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM org_memory
       WHERE tenant_id=$1 AND workspace_id=$2 AND status='active' GROUP BY 1`,
      [scope.tenantId, scope.workspaceId],
    );

    const usages = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memory_usage
       WHERE workspace_id=$1 AND used_at > now() - interval '30 days'`,
      [scope.workspaceId],
    );

    const calibrations = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM biz_events
       WHERE tenant_id=$1 AND workspace_id=$2
         AND payload->'decision'->>'action' = 'memory.calibrate'
         AND created_at > now() - interval '30 days'`,
      [scope.tenantId, scope.workspaceId],
    );

    await client.query("COMMIT");

    const t = totals.rows[0]!;
    const decided = Number(t.decided);
    const approved = Number(t.approved);
    const edited = Number(t.edited);
    return {
      totals: {
        decided,
        approved,
        edited,
        rejected: Number(t.rejected),
        firstPassRate: decided > 0 ? approved / decided : null,
        editRate: decided > 0 ? edited / decided : null,
      },
      weekly: weekly.rows.map((w) => {
        const d = Number(w.decided);
        return { weekStart: w.week_start, decided: d, firstPassRate: d > 0 ? Number(w.approved) / d : null };
      }),
      rejectReasons: reasons.rows
        .filter((r) => r.reason_enum)
        .map((r) => ({ reasonEnum: r.reason_enum, count: Number(r.n) })),
      memory: {
        activeByKind: Object.fromEntries(memKinds.rows.map((k) => [k.kind, Number(k.n)])),
        usages30d: Number(usages.rows[0]?.n ?? 0),
        calibrations30d: Number(calibrations.rows[0]?.n ?? 0),
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
