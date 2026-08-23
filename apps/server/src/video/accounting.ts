/**
 * video/accounting.ts —— 爆款会计学 tRPC 子路由（纯读查询）
 *
 * 三组聚合：topicHitRate（选题命中率）/ unitEconomics（单条经济账）/ roiReview（投入产出复盘）。
 * 纪律：protectedProcedure 只读；scoped 事务级 RLS（越权返回空 L7.1）；无数据返回空集/null 比率（不伪造）。
 */
import { z } from "zod";
import { getAppPool } from "@workloom/db";
import { roiReview, topicHitRate, unitEconomics } from "@workloom/base/social-listening";
import { protectedProcedure, router, scopeOf } from "../trpc/context.js";

export const accountingRouter = router({
  /** 选题命中率：选题卡 → 发布 → 数据回溯（expected.plays vs 实际播放） */
  topicHitRate: protectedProcedure.query(async ({ ctx }) => {
    return topicHitRate(getAppPool(), scopeOf(ctx.identity));
  }),

  /** 单条经济账：成本（budget_ledger meta.video_id）vs 播放/转化 */
  unitEconomics: protectedProcedure
    .input(z.object({ projectId: z.string().min(1).optional() }))
    .query(async ({ ctx, input }) => {
      return unitEconomics(getAppPool(), scopeOf(ctx.identity), { projectId: input.projectId });
    }),

  /** 投入产出复盘：渲染+投放成本 vs 商单回款（按项目归集） */
  roiReview: protectedProcedure.query(async ({ ctx }) => {
    return roiReview(getAppPool(), scopeOf(ctx.identity));
  }),
});
