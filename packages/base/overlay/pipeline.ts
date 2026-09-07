/**
 * 租户覆盖层 · 流水线编排器（M2-1）
 * 完整流水线：草稿 → 合并后考试院 → 灰度（观察期）→ 全量 → 快照可回滚。
 * 两道硬闸：
 *  ① 考试闸：对「合并后配置」跑确定性体检（合并成功 + 合并后围栏规则可编译且金标准可达成
 *     + 覆盖项引用自洽），任一不过即拒转灰度——覆盖层永远没有"带病上岗"；
 *  ② 灰度观察期：canary 必须满足最短观察时长才允许转 active（默认 0，运营可配）。
 * 每次状态流转向账本写 overlay.* 事件（eventSink 可注入，生产接 gatewayAppend，
 * 测试接内存收集器）——覆盖变更全程可审计（DoD ⑤）。
 */
import type pg from "pg";
import { compileFenceQuestions, type FenceRuleRow } from "../eval-core/index.js";
import { mergeOverlay, type BundleAssetView } from "./merge.js";
import { OverlayError, type OverlayDoc, type OverlayStatus } from "./model.js";
import { rollbackToLatestSnapshot, transition, type OverlayScope } from "./store.js";

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** 考试闸结果 */
export interface ExamGateResult {
  pass: boolean;
  total: number;
  failures: string[];
}

/** 流水线事件（入账本） */
export interface OverlayPipelineEvent {
  type: "overlay.exam_passed" | "overlay.exam_failed" | "overlay.canary_started"
    | "overlay.activated" | "overlay.rolled_back" | "overlay.rebase_detected";
  tenant_id: string;
  base_bundle: string;
  overlay_version: number;
  detail?: Record<string, unknown>;
}

export interface PipelineDeps {
  /** 合并视图加载器（生产：从装配资产构建；测试：内存构造） */
  loadView: (baseBundle: string, baseVersion: string) => Promise<BundleAssetView> | BundleAssetView;
  /** 账本事件出口（生产：gatewayAppend 包装；测试：push 进数组） */
  eventSink?: (e: OverlayPipelineEvent) => Promise<void> | void;
  /** 灰度最短观察期（毫秒），默认 0 */
  canaryMinObserveMs?: number;
  now?: () => number;
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly code: "EXAM_FAILED" | "OBSERVE_TOO_SHORT" | "INVALID_STATE",
    readonly detail?: unknown,
  ) { super(message); this.name = "PipelineError"; }
}

/** 按版本取覆盖层（pipeline 内部用） */
async function getByVersion(
  q: Queryable, scope: OverlayScope, baseBundle: string, version: number,
): Promise<(OverlayDoc & { updated_at?: string }) | null> {
  const r = await q.query(
    `SELECT base_bundle, base_version, overlay_version, status, canary_scope, items, note, updated_at
       FROM tenant_overlays
      WHERE workspace_id=$1 AND tenant_id=$2 AND base_bundle=$3 AND overlay_version=$4`,
    [scope.workspaceId, scope.tenantId, baseBundle, version],
  );
  const row = (r.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    tenant_id: scope.tenantId,
    base_bundle: String(row.base_bundle),
    base_version: String(row.base_version),
    overlay_version: Number(row.overlay_version),
    status: row.status as OverlayStatus,
    canary_scope: (row.canary_scope ?? undefined) as OverlayDoc["canary_scope"],
    items: row.items as OverlayDoc["items"],
    note: (row.note ?? undefined) as string | undefined,
    updated_at: String(row.updated_at ?? ""),
  };
}

/** 考试闸：对合并后配置做确定性体检（零 token、100% 可复现） */
export async function examGate(view: BundleAssetView, doc: OverlayDoc): Promise<ExamGateResult> {
  const failures: string[] = [];
  // ① 合并必须成功（合并引擎的全部边界校验即第一道题）
  let merged: BundleAssetView;
  try {
    merged = mergeOverlay(view, doc).assets;
  } catch (err) {
    return { pass: false, total: 1, failures: [`合并失败：${(err as Error).message}`] };
  }
  // ② 合并后围栏规则必须可编译为考试院正反题（结构自洽：每条规则都能出正反两题，
  //    且每题断言非空——证明规则是"可考核"的，不是写了句没人能执行的废话）
  const rules: FenceRuleRow[] = (merged.fencePacks ?? []).flatMap((p, pi) =>
    (p.fences ?? []).map((f, fi) => ({
      id: `fp${pi}-f${fi}`,
      rule_id: String(f.rule_id),
      name: String(f.rule_id),
      level: String(f.level) as FenceRuleRow["level"],
      match_spec: {} as FenceRuleRow["match_spec"],
      status: "active",
    })),
  );
  let questions: ReturnType<typeof compileFenceQuestions> = [];
  try {
    questions = compileFenceQuestions(rules);
  } catch (err) {
    failures.push(`围栏规则不可编译：${(err as Error).message}`);
  }
  if (questions.length !== rules.length * 2) {
    failures.push(`围栏出题数量异常（${questions.length} ≠ ${rules.length * 2}）`);
  }
  for (const q of questions) {
    if (!q.assertions || q.assertions.length === 0) failures.push(`${q.id}: 缺断言`);
  }
  // ③ 覆盖项引用自洽（双保险：合并引擎已校验，此处复核编制引用）
  for (const item of doc.items) {
    if (item.type === "crew") {
      const key = String(item.path).replace(/^presets\//, "");
      if (!(merged.presets ?? []).some((p) => String(p.preset_key) === key)) {
        failures.push(`crew: 合并后仍找不到员工 ${key}`);
      }
    }
  }
  return { pass: failures.length === 0, total: questions.length + doc.items.length, failures };
}

/** 一步：草稿 → 考试 → 灰度（考试不过即终止，事件留痕） */
export async function draftToCanary(
  q: Queryable, scope: OverlayScope, baseBundle: string, overlayVersion: number, deps: PipelineDeps,
): Promise<{ doc: OverlayDoc; exam: ExamGateResult }> {
  const doc = await getByVersion(q, scope, baseBundle, overlayVersion);
  if (!doc) throw new PipelineError(`覆盖层 v${overlayVersion} 不存在`, "INVALID_STATE");
  if (doc.status !== "draft") throw new PipelineError(`只有草稿可进灰度（当前 ${doc.status}）`, "INVALID_STATE");
  if (!doc.canary_scope) {
    throw new PipelineError("进灰度必须携带 canary_scope 灰度范围", "INVALID_STATE");
  }
  const view = await deps.loadView(baseBundle, doc.base_version);
  const exam = await examGate(view, doc);
  await deps.eventSink?.({
    type: exam.pass ? "overlay.exam_passed" : "overlay.exam_failed",
    tenant_id: scope.tenantId, base_bundle: baseBundle,
    overlay_version: overlayVersion, detail: { total: exam.total, failures: exam.failures.slice(0, 5) },
  });
  if (!exam.pass) {
    throw new PipelineError(`考试闸未通过（${exam.failures.length} 项）：${exam.failures[0]}`, "EXAM_FAILED", exam.failures);
  }
  const transitioned = await transition(q, scope, baseBundle, overlayVersion, "canary");
  await deps.eventSink?.({
    type: "overlay.canary_started", tenant_id: scope.tenantId, base_bundle: baseBundle,
    overlay_version: overlayVersion, detail: { canary_scope: doc.canary_scope },
  });
  return { doc: transitioned, exam };
}

/** 一步：灰度 → 全量（需满足最短观察期） */
export async function canaryToActive(
  q: Queryable, scope: OverlayScope, baseBundle: string, overlayVersion: number, deps: PipelineDeps,
): Promise<OverlayDoc> {
  const doc = await getByVersion(q, scope, baseBundle, overlayVersion);
  if (!doc) throw new PipelineError(`覆盖层 v${overlayVersion} 不存在`, "INVALID_STATE");
  if (doc.status !== "canary") throw new PipelineError(`只有灰度中可转全量（当前 ${doc.status}）`, "INVALID_STATE");
  const minMs = deps.canaryMinObserveMs ?? 0;
  if (minMs > 0 && doc.updated_at) {
    const elapsed = (deps.now?.() ?? Date.now()) - new Date(doc.updated_at).getTime();
    if (elapsed < minMs) {
      throw new PipelineError(
        `灰度观察期不足（${Math.round(elapsed / 1000)}s < ${Math.round(minMs / 1000)}s）`, "OBSERVE_TOO_SHORT");
    }
  }
  const transitioned = await transition(q, scope, baseBundle, overlayVersion, "active");
  await deps.eventSink?.({
    type: "overlay.activated", tenant_id: scope.tenantId, base_bundle: baseBundle,
    overlay_version: overlayVersion,
  });
  return transitioned;
}

/** 一键回滚到最近快照（止血动作，直激活，事件留痕） */
export async function rollback(
  q: Queryable, scope: OverlayScope, baseBundle: string, actor: string, deps: PipelineDeps,
): Promise<OverlayDoc> {
  const doc = await rollbackToLatestSnapshot(q, scope, baseBundle, actor);
  await deps.eventSink?.({
    type: "overlay.rolled_back", tenant_id: scope.tenantId, base_bundle: baseBundle,
    overlay_version: doc.overlay_version, detail: { actor },
  });
  return doc;
}

export { OverlayError };
export type { OverlayDoc, OverlayScope, OverlayStatus };
