/**
 * trpc · 租户覆盖层路由（M2-2 管理台 API）
 * 双版本设计：
 *  - 运营版（全量）：版本历史/草稿/流水线流转/回滚/导出/rebase 预检/L1 落库；
 *  - 客户简化版（my*）：只看"我的定制"当前状态与一句话摘要 + 一键回滚——
 *    客户侧不暴露版本号/状态机概念，只讲人话（"您的 3 项定制已生效"）。
 */
import { z } from "zod";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getAppPool } from "@workloom/db";
import {
  canaryToActive, detectRebase, draftToCanary, exportSnapshot, ingestL1,
  L1IntentSchema, listVersions, loadActiveOverlay, rebaseSummary, rollback,
  healthSummary, saveDraft, type BundleAssetView, type PipelineDeps,
} from "@workloom/base/overlay";
import { protectedProcedure, router, scopeOf, writeProcedure } from "./context.js";

/** 从磁盘行业包构建合并视图（与装配钩子 toView 同口径） */
function loadViewFromDisk(slug: string): BundleAssetView {
  const dir = join(process.cwd(), "bundles", slug);
  const bj = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf-8")) as BundleAssetView["bj"];
  const presets = readdirSync(join(dir, "presets"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => parseYaml(readFileSync(join(dir, "presets", f), "utf-8")) as Record<string, unknown>);
  const fencePacks = readdirSync(join(dir, "fences"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => parseYaml(readFileSync(join(dir, "fences", f), "utf-8")) as Record<string, unknown>);
  const extra: Record<string, unknown> = {};
  const faqPath = join(dir, "service-front", "faq.json");
  if (existsSync(faqPath)) {
    const raw = JSON.parse(readFileSync(faqPath, "utf-8")) as { faqs?: unknown[] };
    extra.faq = Array.isArray(raw?.faqs) ? raw.faqs : [];
  }
  return { bj, presets, fencePacks, extra };
}

const deps: PipelineDeps = { loadView: (slug) => loadViewFromDisk(slug) };

const baseInput = z.object({ baseBundle: z.string().min(1).max(50) });
const versionInput = baseInput.extend({ overlayVersion: z.number().int().positive() });

export const overlayRouter = router({
  /* ================= 运营版（全量） ================= */

  /** 版本历史（管理台时间线） */
  versions: protectedProcedure.input(baseInput).query(async ({ ctx, input }) => {
    return listVersions(getAppPool(), scopeOf(ctx.identity), input.baseBundle);
  }),

  /** 当前生效的覆盖层（无则 null） */
  active: protectedProcedure.input(baseInput).query(async ({ ctx, input }) => {
    return loadActiveOverlay(getAppPool(), scopeOf(ctx.identity), input.baseBundle);
  }),

  /** 存草稿（运营手工编辑入口） */
  saveDraft: writeProcedure
    .input(z.object({
      baseBundle: z.string().min(1).max(50),
      baseVersion: z.string().min(1).max(50),
      items: z.array(z.record(z.string(), z.unknown())).min(1),
      note: z.string().max(200).optional(),
      canaryScope: z.object({
        scenes: z.array(z.string()).optional(),
        ratio: z.number().min(0).max(1).optional(),
        note: z.string().optional(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return saveDraft(getAppPool(), scopeOf(ctx.identity), {
        tenant_id: ctx.identity.tenantId,
        base_bundle: input.baseBundle,
        base_version: input.baseVersion,
        items: input.items as never,
        note: input.note,
        canary_scope: input.canaryScope,
        createdBy: ctx.identity.memberNo,
      });
    }),

  /** 流水线：草稿 → 考试 → 灰度（考试闸不过即拒，事件留痕） */
  toCanary: writeProcedure.input(versionInput).mutation(async ({ ctx, input }) => {
    return draftToCanary(getAppPool(), scopeOf(ctx.identity), input.baseBundle, input.overlayVersion, deps);
  }),

  /** 流水线：灰度 → 全量（观察期纪律） */
  toActive: writeProcedure.input(versionInput).mutation(async ({ ctx, input }) => {
    return canaryToActive(getAppPool(), scopeOf(ctx.identity), input.baseBundle, input.overlayVersion, deps);
  }),

  /** 一键回滚（止血，直激活） */
  rollback: writeProcedure.input(baseInput).mutation(async ({ ctx, input }) => {
    return rollback(getAppPool(), scopeOf(ctx.identity), input.baseBundle, ctx.identity.memberNo, deps);
  }),

  /** 导出快照（资产归属叙事：客户的定制可一键导出带走） */
  export: protectedProcedure.input(baseInput).query(async ({ ctx, input }) => {
    return exportSnapshot(getAppPool(), scopeOf(ctx.identity), input.baseBundle);
  }),

  /** Rebase 预检：行业包升级前，先出《兼容报告》（运营评审用） */
  rebasePreview: protectedProcedure
    .input(baseInput.extend({ toVersion: z.string().min(1).max(50) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const doc = await loadActiveOverlay(getAppPool(), scope, input.baseBundle);
      if (!doc) return { report: null, summary: "当前无生效定制，升级零影响" };
      const report = detectRebase(doc, loadViewFromDisk(input.baseBundle), input.toVersion);
      return { report, summary: rebaseSummary(report) };
    }),

  /* ================= L1 配置层（AI 结构化意图落库） ================= */

  /** L1 自然语言录入：意图 → 校验 → 草稿（接待班/小织调用） */
  l1Intake: writeProcedure
    .input(z.object({
      baseBundle: z.string().min(1).max(50),
      baseVersion: z.string().min(1).max(50),
      intents: z.array(L1IntentSchema).min(1).max(20),
      note: z.string().max(200).optional(),
      canaryScope: z.object({
        scenes: z.array(z.string()).optional(),
        ratio: z.number().min(0).max(1).optional(),
        note: z.string().optional(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ingestL1(getAppPool(), scopeOf(ctx.identity), input.baseBundle, input.baseVersion,
        input.intents, { note: input.note, createdBy: ctx.identity.memberNo, canaryScope: input.canaryScope });
    }),

  /** 健康汇总（晨报/健康分数据源：滞留草稿/超龄灰度预警） */
  health: protectedProcedure.query(async ({ ctx }) => {
    return healthSummary(getAppPool(), scopeOf(ctx.identity));
  }),

  /* ================= 客户简化版（只说人话） ================= */

  /** 我的定制：一句话状态（"您的 3 项定制已生效 / 2 项待裁决"） */
  myStatus: protectedProcedure.input(baseInput).query(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    const pool = getAppPool();
    const doc = await loadActiveOverlay(pool, scope, input.baseBundle);
    if (!doc) return { hasOverlay: false, summary: "您还没有专属定制，当前使用行业标准配置" };
    return {
      hasOverlay: true,
      itemCount: doc.items.length,
      note: doc.note,
      summary: `您的 ${doc.items.length} 项专属定制已生效`,
    };
  }),

  /** 我的定制：一键恢复原样（客户侧唯一动作，不暴露版本概念） */
  myRollback: writeProcedure.input(baseInput).mutation(async ({ ctx, input }) => {
    const doc = await rollback(getAppPool(), scopeOf(ctx.identity), input.baseBundle, ctx.identity.memberNo, deps);
    return { ok: true, summary: `已恢复上一版定制（共 ${doc.items.length} 项）` };
  }),
});
