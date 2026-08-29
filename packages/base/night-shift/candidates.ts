/**
 * night-shift · 18:00 候选清单（F4.1）：扫描「今日未完成 + 可夜间推进」的只读任务
 * 每项字段：任务名 / 类型（行业包定义）/ 预估积分（峰谷价）/ 命中围栏摘要
 * 「开启夜班」为人类命令，不经模型轮次（见 scheduler.ts confirmNight）
 *
 * 首版扫描源（演示口径）：
 *  - 待审批积压（review 队列 pending 数 → 夜班可推进项）
 *  - 夜班型 preset 覆盖的例行任务模板（结算对账/数据复核/发布准备——社媒营销域例行子集 F3.5）
 * 预估积分 = Mock 计量口径 × 谷时折扣（F4.6/G9）
 */
import type pg from "pg";
import { OFF_PEAK_RATE_RATIO } from "@workloom/shared";

export interface CandidateItem {
  id: string;
  name: string;
  /** 行业包任务类型（对账/数据/发布…） */
  type: string;
  /** 预估积分（谷时价） */
  estCredits: number;
  /** 命中围栏摘要 */
  fenceSummary: string;
  /** 建议 preset */
  presetKey: string;
}

/** 夜班例行任务模板（社媒营销域；presetKey 与 bundles/ai-video 夜班型 preset 对齐） */
export const NIGHT_TASK_TEMPLATES: CandidateItem[] = [
  { id: "nt-reconcile", name: "夜间结算对账（商单×投流×平台三轮）", type: "对账", estCredits: 12, fenceSummary: "按原规则版本复核（围栏快照同源）", presetKey: "settlement-clerk" },
  { id: "nt-review", name: "负面评论跟进（起草回复，必审挂起）", type: "评论", estCredits: 8, fenceSummary: "负面评论必审挂起", presetKey: "metrics-watcher" },
  { id: "nt-price", name: "次日发布准备（竞对账号采集+排期建议单）", type: "发布", estCredits: 15, fenceSummary: "G9 公网发布必审 / G9a 新平台首发必审", presetKey: "metrics-watcher" },
];

/** 生成候选清单：例行模板（按夜班 preset 覆盖过滤）+ 积压项动态折算 */
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
    const ag = await client.query<{ preset_key: string }>(
      `SELECT preset_key FROM agents WHERE workspace_id=$1 AND status='ready'
       AND (meta->>'night_shift')::boolean = true`,
      [scope.workspaceId],
    );
    const nightPresets = new Set(ag.rows.map((r) => r.preset_key));
    // 待审批积压 → 追加动态候选
    const pend = await client.query<{ c: string }>(
      `SELECT count(*) AS c FROM approvals WHERE workspace_id=$1 AND status='pending'`,
      [scope.workspaceId],
    );
    const items = NIGHT_TASK_TEMPLATES.filter((t) => nightPresets.has(t.presetKey));
    const pendingCount = Number(pend.rows[0]?.c ?? 0);
    if (pendingCount > 0) {
      items.push({
        id: "nt-backlog",
        name: `待审批积压清理（${pendingCount} 条复核提示）`,
        type: "对账",
        estCredits: Math.ceil(pendingCount * 2 * OFF_PEAK_RATE_RATIO),
        fenceSummary: "按原规则版本复核（F2.6 快照）",
        presetKey: "reconcile-agent",
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
