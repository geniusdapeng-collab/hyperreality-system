/**
 * night-shift · 18:00 候选清单（F4.1）：扫描「今日未完成 + 可夜间推进」的只读任务
 * 每项字段：任务名 / 类型 / 预估积分（峰谷价）/ 命中围栏摘要
 * 「开启夜班」为人类命令，不经模型轮次（见 scheduler.ts confirmNight）
 *
 * 扫描源：
 *  - 待审批积压（review 队列 pending 数 → 夜班可推进项）
 *  - 当前 Bundle 声明为可夜间运行的数字员工
 * 预估积分 = Mock 计量口径 × 谷时折扣（F4.6/G9）
 */
import type pg from "pg";
import { OFF_PEAK_RATE_RATIO } from "@workloom/shared";

export interface CandidateItem {
  id: string;
  name: string;
  /** 任务类型；行业专属类型由 Bundle 投影提供 */
  type: string;
  /** 预估积分（谷时价） */
  estCredits: number;
  /** 命中围栏摘要 */
  fenceSummary: string;
  /** 建议 preset */
  presetKey: string;
}

function positiveCredits(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
}

function visibleAgentName(value: string): string {
  const name = value.trim();
  return /[\u3400-\u9fff]/u.test(name) ? name : "值守员工";
}

/** 生成候选清单：Bundle 声明的夜班员工例行任务 + 积压项动态折算 */
export async function buildCandidateList(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
): Promise<CandidateItem[]> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 夜班型 preset（meta.night_shift=true 且 ready）
    const ag = await client.query<{ preset_key: string; name: string; meta: Record<string, unknown> | null }>(
      `SELECT preset_key, name, meta FROM agents WHERE workspace_id=$1 AND status='ready'
       AND (meta->>'night_shift')::boolean = true`,
      [scope.workspaceId],
    );
    // 待审批积压 → 追加动态候选
    const pend = await client.query<{ c: string }>(
      `SELECT count(*) AS c FROM approvals WHERE workspace_id=$1 AND status='pending'`,
      [scope.workspaceId],
    );
    const items: CandidateItem[] = ag.rows.map((agent) => ({
      id: `nt-${agent.preset_key}`,
      name: `${visibleAgentName(agent.name)}的夜间例行任务`,
      type: "例行任务",
      estCredits: positiveCredits(agent.meta?.night_est_credits),
      fenceSummary: "按当前生效围栏执行；越界动作转人工审批",
      presetKey: agent.preset_key,
    }));
    const pendingCount = Number(pend.rows[0]?.c ?? 0);
    const firstNightAgent = ag.rows[0];
    if (pendingCount > 0 && firstNightAgent) {
      items.push({
        id: "nt-backlog",
        name: `待审批事项复核提示（${pendingCount} 条）`,
        type: "审批复核",
        estCredits: pendingCount * 2,
        fenceSummary: "沿用事项创建时锁定的规则版本",
        presetKey: firstNightAgent.preset_key,
      });
    }
    // 谷时价折算（F4.6：预估积分按峰谷价展示）
    const out = items.map((i) => ({ ...i, estCredits: Math.max(1, Math.round(i.estCredits * OFF_PEAK_RATE_RATIO)) }));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
