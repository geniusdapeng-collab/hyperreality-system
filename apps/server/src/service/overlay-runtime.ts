/**
 * service · 覆盖层运行时接线（HP-01 审计修复）
 *
 * 两件事必须发生在**同一个 RLS 事务**里，否则覆盖层的"可审计"承诺只剩注释：
 *  ① 状态变更（draft→canary→active / 回滚）经 store 落在 tenant_overlays；
 *  ② 流水线事件（overlay.exam_passed/exam_failed/canary_started/activated/rolled_back）
 *     经安全网关 append 落 biz_events —— 修复前 overlay-router 的 deps 只给了 loadView，
 *     eventSink 缺省为 undefined，事件被静默丢弃（DoD ⑤「一键回滚留审计」名存实亡）。
 *
 * 注意：actor 用发起操作的成员编号（human），网关段①对 human 直接放行；
 * 事件 who 与 actor 同源，满足 #35 身份一致性检查。
 */
import type pg from "pg";
import {
  withOverlayTx, type OverlayPipelineEvent, type OverlayScope, type PipelineDeps,
} from "@workloom/base/overlay";
import { appendEventOn, type ServiceScope } from "./events.js";

/** 覆盖层账本出口：把流水线事件写成 biz_events（与业务写同一 COMMIT，事务由调用方持有） */
export function overlayLedgerSink(
  client: pg.PoolClient,
  scope: ServiceScope,
  actorId: string,
): (event: OverlayPipelineEvent) => Promise<void> {
  return async (event) => {
    await appendEventOn(
      client,
      scope,
      { type: "human", id: actorId },
      {
        objectType: "tenant_overlay",
        objectId: `${event.base_bundle}@v${event.overlay_version}`,
        action: event.type,
        after: { tenant_id: event.tenant_id, base_bundle: event.base_bundle, detail: event.detail ?? null },
        channel: "inapp",
      },
    );
  };
}

/** 生产 deps：装配视图 + 账本出口（账本出口必须绑定当前事务的 client） */
export function overlayPipelineDeps(
  loadView: PipelineDeps["loadView"],
  client: pg.PoolClient,
  scope: ServiceScope,
  actorId: string,
): PipelineDeps {
  return { loadView, eventSink: overlayLedgerSink(client, scope, actorId) };
}

/**
 * 被拒事件的独立留痕（L4.2「需介入」事件口径）：
 * 考试闸失败时状态变更事务整体回滚——若拒收事件也写在同一事务里，它同样会被回滚，
 * 「谁试图上线什么、为什么被拒」就永远查不到。因此拒收留痕必须在独立事务里补写。
 */
export async function recordOverlayEventInOwnTx(
  pool: Pick<pg.Pool, "connect">,
  scope: OverlayScope,
  actorId: string,
  event: OverlayPipelineEvent,
): Promise<void> {
  await withOverlayTx(pool, scope, (client) =>
    overlayLedgerSink(client, { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, actorId)(event));
}
