/**
 * trpc · 积分账本 + 模型反馈路由（v3.0 商业化 P1 产品化）
 *
 * credits：三池余额（事件投影）/ 加油包价目 / 购买入账 / 赠送入账；
 * modelFeedback：👍/👎 质量信号（model.feedback 事件）+ 一键升级重答（升一档重新生成，24h 限免 1 次）。
 */
import { z } from "zod";
import {
  CREDIT_PACKS, GatewayEventSink, MemoryQuotaStore, escalate, grantCredits,
  ledgerOf, poolFromEnv, purchaseCredits, type Tier3,
} from "@workloom/base/model-router";
import { protectedProcedure, router, scopeOf, writeProcedure } from "./context.js";
import { getAppPool, getGatewayPool } from "@workloom/db";

/** 升级重答配额（24h 限免 1 次/问题；进程级实现，生产可换 Redis 同接口） */
const escalationQuota = new MemoryQuotaStore(1);

export const creditsRouter = router({
  /** 三池余额与近 20 条流水（事件投影，不重算） */
  balance: protectedProcedure.query(async ({ ctx }) => {
    return ledgerOf(getAppPool(), scopeOf(ctx.identity));
  }),

  /** 加油包价目（五档阶梯；单积分成本随档递减） */
  packs: protectedProcedure.query(() => {
    return { packs: CREDIT_PACKS, minPurchase: 20_000, validityDays: 180 };
  }),

  /** 购买加油包/充值本金（事件化入账；支付对接为外部职责） */
  purchase: writeProcedure
    .input(z.object({
      packId: z.string().optional(),
      amount: z.number().int().positive().optional(),
      orderRef: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return purchaseCredits(getGatewayPool(), scopeOf(ctx.identity), {
        packId: input.packId, amount: input.amount,
        orderRef: input.orderRef, by: ctx.identity.memberNo,
      });
    }),

  /** 套餐赠送/运营赠送入账（系统动作；签到/月赠/活动） */
  grant: writeProcedure
    .input(z.object({ amount: z.number().int().positive().max(1_000_000), reason: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      return grantCredits(getGatewayPool(), scopeOf(ctx.identity), {
        amount: input.amount, reason: input.reason, by: ctx.identity.memberNo,
      });
    }),
});

export const modelFeedbackRouter = router({
  /** 👍/👎 质量信号（model.feedback 事件入事件库，路由质量周报数据源） */
  submit: protectedProcedure
    .input(z.object({
      scene: z.string().min(1).max(64),
      action: z.string().min(1).max(128),
      thumbs: z.enum(["up", "down"]),
      originalTier: z.enum(["L1", "L2", "L3"]),
      escalatedTier: z.enum(["L1", "L2", "L3"]).optional(),
      adopted: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const sink = new GatewayEventSink(getGatewayPool(), scopeOf(ctx.identity));
      await sink.recordFeedback?.({
        scene: input.scene, action: input.action, thumbs: input.thumbs,
        original_tier: input.originalTier, escalated_tier: input.escalatedTier,
        adopted: input.adopted,
      });
      return { ok: true };
    }),

  /** 一键升级重答：👎 → 升一档重新生成（对比展示「原回答 vs 升级版」；24h 限免 1 次防刷） */
  escalate: protectedProcedure
    .input(z.object({
      scene: z.string().min(1).max(64),
      action: z.string().min(1).max(128),
      prompt: z.string().min(1).max(32_000),
      fromTier: z.enum(["L1", "L2", "L3"]),
      fingerprint: z.string().max(128).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const sink = new GatewayEventSink(getGatewayPool(), scope);
      const r = await escalate({
        task: {
          action: input.action, scene: input.scene,
          messages: [{ role: "user", content: input.prompt }],
        },
        fromTier: input.fromTier as Tier3,
        providers: poolFromEnv(),
        sink,
        quota: escalationQuota,
        fingerprint: input.fingerprint,
      });
      return {
        escalated: r.escalated, fromTier: r.fromTier, toTier: r.toTier,
        freeEscalation: r.freeEscalation,
        kind: r.kind, text: r.text ?? null,
        /** L3 已是天花板 → 前端引导转人工/工单（三级兜底） */
        suggestHuman: r.fromTier === "L3",
      };
    }),
});
