/**
 * base/captain · CEO Loop 节拍引擎（D21，方案 §四/§六）
 *
 * 节拍：晨报/周会/月报/集团晨报（简报）+ L2 队列裁决（公司CEO 自主闭环）+ 目标偏差扫描（主动性）+ 自治熔断。
 * 治理守卫（§12）：disabled 全静默；shadow 完整推理但事件标 dry_run；suspended 仅简报；
 * trial/active 全真执行（trial 边界自动降档——见 charter.effectiveAutonomy）。
 * 全部写路径：app 池单事务 + 事务级双 GUC（D16 同构）；事件均带 basis（治理 §九.3 依据链强制）。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import {
  parseCharter, transition, canExecute, isShadow, isExpired,
  evalCircuitBreaker, tightenAutonomy, effectiveAutonomy, type Charter,
} from "./charter.js";
import { decideForCaptain, type QueueItem } from "./router.js";
import { generateBriefing, buildMemo, type BriefingKind } from "./briefing.js";

export interface Scope { tenantId: string; workspaceId: string }

const CEO_ACTOR = { id: "company-ceo", type: "agent" as const };

/* ================= 宪章读写 ================= */

export async function loadCharter(app: pg.Pool, scope: Scope): Promise<Charter> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ archive: Record<string, unknown> }>(
      `SELECT archive FROM profiles WHERE workspace_id=$1`, [scope.workspaceId],
    );
    await client.query("COMMIT");
    return parseCharter(r.rows[0]?.archive?.charter);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function saveCharterInTx(client: pg.PoolClient, scope: Scope, charter: Charter): Promise<void> {
  await client.query(
    `UPDATE profiles SET archive = jsonb_set(archive, '{charter}', $2::jsonb), updated_at=now() WHERE workspace_id=$1`,
    [scope.workspaceId, JSON.stringify(charter)],
  );
}

async function inTx<T>(app: pg.Pool, scope: Scope, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function emitCeoEvent(
  client: pg.PoolClient, scope: Scope, action: string,
  decision: { params?: Record<string, unknown>; after?: Record<string, unknown>; basis: string[] },
  opts?: { dryRun?: boolean },
): Promise<string> {
  const res = await gatewayAppendOnClient(client, {
    ...scope, actor: CEO_ACTOR, sessionId: `ceo-${scope.workspaceId}`,
  }, {
    who: { type: "agent", id: CEO_ACTOR.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
    object: { type: "company_ceo", id: scope.workspaceId },
    decision: {
      action,
      params: { ...(decision.params ?? {}), ...(opts?.dryRun ? { dry_run: true } : {}) },
      after: decision.after ?? {},
      basis: decision.basis,
    },
    rule_impact: [],
    model_trace: { model_id: process.env.LLM_MODEL || "mock-001", tier: "standard", credits: 1 },
  });
  return res.eventId;
}

/* ================= 到期自动降级（所有节拍前置） ================= */

async function applyExpiryIfDue(app: pg.Pool, scope: Scope, charter: Charter): Promise<Charter> {
  if (!isExpired(charter)) return charter;
  const next = transition(charter, { kind: "expire" });
  await inTx(app, scope, async (c) => {
    await saveCharterInTx(c, scope, next);
    await emitCeoEvent(c, scope, "captain.mode_change", {
      params: { from: charter.mode, to: "suspended", reason: "试用/保留期到期自动降级（绝不自动续期，§12 铁律）" },
      basis: [`试用截止 ${charter.grant?.trial_ends_at ?? charter.grant?.retain_until}`],
    });
  });
  return next;
}

/* ================= 节拍①：简报（晨报/周会/月报/集团晨报） ================= */

export async function runBriefingBeat(
  app: pg.Pool, scope: Scope, kind: BriefingKind,
  opts: { llmCall?: (prompt: string) => Promise<string> } = {},
): Promise<{ eventId: string; via: string; skipped?: string }> {
  let charter = await loadCharter(app, scope);
  charter = await applyExpiryIfDue(app, scope, charter);
  if (charter.mode === "disabled") return { eventId: "", via: "rule", skipped: "disabled：未授权，全静默（§12 默认关闭）" };
  const dryRun = isShadow(charter.mode);
  const b = await generateBriefing(app, scope, kind, { name: charter.identity.name, llmCall: opts.llmCall });
  const eventId = await inTx(app, scope, (c) =>
    emitCeoEvent(c, scope, "ceo.briefing", {
      params: { kind, via: b.via, mode: charter.mode },
      after: { text: b.text },
      basis: [`事实取数：${b.facts.actionsTop.length} 类动作/待审分层/断点统计`, `合成通道：${b.via}`],
    }, { dryRun }));
  return { eventId, via: b.via };
}

/* ================= 节拍②：L2 队列裁决（公司CEO 自主闭环） ================= */

export async function runQueueBeat(
  app: pg.Pool, scope: Scope,
): Promise<{ decided: number; escalated: number; skipped?: string }> {
  let charter = await loadCharter(app, scope);
  charter = await applyExpiryIfDue(app, scope, charter);
  const dryRun = isShadow(charter.mode);
  if (!canExecute(charter.mode) && !dryRun) {
    return { decided: 0, escalated: 0, skipped: `${charter.mode}：无执行权（suspended 仅汇报 / disabled 静默）` };
  }
  const rows = await inTx(app, scope, async (c) => {
    const r = await c.query<{
      approval_id: string; event_id: string; snapshot: Record<string, unknown>;
    }>(
      `SELECT a.approval_id, a.event_id, a.snapshot
       FROM approvals a WHERE a.workspace_id=$1 AND a.status='pending' AND a.tier='l2_captain'
       ORDER BY a.approval_id LIMIT 20`,
      [scope.workspaceId],
    );
    return r.rows;
  });
  let decided = 0, escalated = 0;
  for (const row of rows) {
    const snap = (row.snapshot ?? {}) as Record<string, unknown>;
    const params = (snap.params ?? {}) as Record<string, unknown>;
    const item: QueueItem = {
      approvalId: row.approval_id, eventId: row.event_id,
      action: String(snap.action ?? ""), params,
      ruleIds: Array.isArray(snap.rule_ids) ? (snap.rule_ids as string[]) : [],
      priceCtx: { afterPrice: Number(params.price ?? NaN) || undefined, basePrice: Number(snap.base_price ?? 458) || undefined },
      amountCtx: { amount: Number(params.amount ?? NaN) || undefined },
      title: String(snap.title ?? row.event_id),
    };
    const verdict = decideForCaptain(charter, item);
    await inTx(app, scope, async (c) => {
      if (verdict.kind === "escalate") {
        await c.query(
          `UPDATE approvals SET tier='l4_chairman', snapshot = snapshot || $3::jsonb WHERE approval_id=$1 AND workspace_id=$2`,
          [row.approval_id, scope.workspaceId, JSON.stringify({ ceo_escalated: true, ceo_rationale: verdict.rationale })],
        );
        escalated++;
      } else if (!dryRun) {
        await c.query(
          `UPDATE approvals SET status=$3, gesture=$4::jsonb, decided_by=$5, decided_at=now()
           WHERE approval_id=$1 AND workspace_id=$2`,
          [row.approval_id, scope.workspaceId, verdict.kind === "approve" ? "approved" : "rejected",
           JSON.stringify({ type: verdict.kind, weight: 1, reason_text: verdict.rationale }), CEO_ACTOR.id],
        );
        decided++;
      } else {
        decided++; // shadow：完整推理但不落审批状态
      }
      const memo = buildMemo({
        title: `裁决 ${item.action}（${item.title}）`,
        situation: `L2 审批 ${row.approval_id}：${item.action}，参数 ${JSON.stringify(params).slice(0, 120)}`,
        options: [
          { label: "批准执行", recommended: verdict.kind === "approve" },
          { label: "驳回", recommended: verdict.kind === "reject" },
          { label: "上浮董事长", recommended: verdict.kind === "escalate" },
        ],
        recommendation: verdict.rationale,
        basis: [`宪章自治边界：${JSON.stringify(effectiveAutonomy(charter))}`, "裁决策略：router.decideForCaptain"],
      });
      await emitCeoEvent(c, scope, "ceo.decision", {
        params: { approval_id: row.approval_id, verdict: verdict.kind, mode: charter.mode },
        after: { memo },
        basis: memo.basis,
      }, { dryRun });
    });
  }
  return { decided, escalated };
}

/* ================= 节拍③：目标偏差扫描（主动性源头） ================= */

export async function runDeviationBeat(
  app: pg.Pool, scope: Scope,
): Promise<{ initiatives: number; skipped?: string }> {
  let charter = await loadCharter(app, scope);
  charter = await applyExpiryIfDue(app, scope, charter);
  if (!canExecute(charter.mode) && !isShadow(charter.mode)) {
    return { initiatives: 0, skipped: `${charter.mode}：无执行权` };
  }
  const track = await inTx(app, scope, async (c) => {
    const r = await c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='goal.tracking'
       ORDER BY seq DESC LIMIT 1`,
      [scope.workspaceId],
    );
    return r.rows[0]?.payload ?? null;
  });
  if (!track) return { initiatives: 0, skipped: "无 goal.tracking 数据" };
  const after = ((track.decision as Record<string, unknown>)?.after ?? {}) as Record<string, unknown>;
  const deviation = Number(after.deviation_pt ?? 0); // 行业事实面约定：偏差（百分点，负=落后）
  const threshold = 5;
  if (Math.abs(deviation) < threshold) return { initiatives: 0 };
  const dryRun = isShadow(charter.mode);
  await inTx(app, scope, async (c) => {
    await emitCeoEvent(c, scope, "initiative.launch", {
      params: { trigger: "goal_deviation", deviation_pt: deviation, threshold, mode: charter.mode },
      after: {
        title: `偏差专项：目标落后 ${Math.abs(deviation)}pt`,
        plan: deviation < 0 ? "启动补救举措池（调价建议/渠道加投/内容补强），逐路过围栏与宪章" : "超目标运行，固化打法入组织记忆",
      },
      basis: [`goal.tracking 最新偏差 ${deviation}pt，阈值 ±${threshold}pt（方案 §五 偏差触发器）`],
    }, { dryRun });
  });
  return { initiatives: 1 };
}

/* ================= 节拍④：自治熔断（方案 §六 Circuit Breaker） ================= */

export async function runBreakerBeat(
  app: pg.Pool, scope: Scope,
): Promise<{ tripped: boolean; tightened: boolean; skipped?: string }> {
  let charter = await loadCharter(app, scope);
  charter = await applyExpiryIfDue(app, scope, charter);
  if (!canExecute(charter.mode)) return { tripped: false, tightened: false, skipped: `${charter.mode}：熔断器仅在执行态生效` };
  const kpi = await inTx(app, scope, async (c) => {
    const r = await c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='store.daily.summary'
       ORDER BY seq DESC LIMIT 1`,
      [scope.workspaceId],
    );
    const after = ((r.rows[0]?.payload?.decision as Record<string, unknown> | undefined)?.after ?? {}) as Record<string, unknown>;
    return { occ: Number(after.occ ?? NaN), adr: Number(after.adr ?? NaN) };
  });
  const verdict = evalCircuitBreaker(charter, kpi as Record<string, number>);
  if (!verdict.tripped || verdict.alreadyTightened) {
    return { tripped: verdict.tripped, tightened: verdict.alreadyTightened };
  }
  const tightened = tightenAutonomy(charter);
  await inTx(app, scope, async (c) => {
    await saveCharterInTx(c, scope, tightened);
    await emitCeoEvent(c, scope, "ceo.circuit_breaker", {
      params: { metric: verdict.metric, actual: verdict.actual, floor: verdict.floor },
      after: { tightened_to: tightened.autonomy },
      basis: [
        `自治期 KPI ${verdict.metric}=${verdict.actual} 跌破宪章下限 ${verdict.floor}（窗口 ${charter.circuit_breaker.window_days} 天）`,
        "自治边界自动收紧一档并通知董事长（方案 §六：自治权是挣来的，也会被收回）",
      ],
    });
  });
  return { tripped: true, tightened: true };
}
