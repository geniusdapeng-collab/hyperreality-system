/**
 * trpc · 租户覆盖层路由（M2-2 管理台 API）
 * 双版本设计：
 *  - 运营版（全量）：版本历史/草稿/流水线流转/回滚/导出/rebase 预检/L1 落库；
 *  - 客户简化版（my*）：只看"我的定制"当前状态与一句话摘要 + 一键回滚——
 *    客户侧不暴露版本号/状态机概念，只讲人话（"您的 3 项定制已生效"）。
 */
import { z } from "zod";
import type pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getAppPool } from "@workloom/db";
import {
  canaryToActive, detectRebase, draftToCanary, exportSnapshot, ingestL1,
  L1IntentSchema, listVersions, loadActiveOverlay, rebaseSummary, rollback,
  healthSummary, saveDraft, buildIntakePreview, extractIntentsDeterministic,
  summarizeIntent, type BundleAssetView, type CurrentState, type PipelineDeps,
  type OverlayDoc, type OverlayScope, withOverlayTx, PipelineError,
} from "@workloom/base/overlay";
import { routedLlmCall } from "../service/llm.js";
import { loadVerifiedBundleManifest } from "@workloom/base/bundles";
import { overlayPipelineDeps, recordOverlayEventInOwnTx } from "../service/overlay-runtime.js";
import { actionProcedure, protectedProcedure, router, scopeOf } from "./context.js";

/** 从磁盘行业包构建合并视图（与装配钩子 toView 同口径） */
function loadViewFromDisk(slug: string): BundleAssetView {
  const bundleRoot = join(process.cwd(), "bundles");
  const dir = join(bundleRoot, slug);
  const manifest = loadVerifiedBundleManifest(slug, bundleRoot);
  const bj = manifest as BundleAssetView["bj"];
  const presets = manifest.workloom.provides.presets
    .map((assetPath) => parseYaml(readFileSync(join(dir, assetPath), "utf-8")) as Record<string, unknown>);
  const fencePacks = manifest.workloom.provides.fences
    .map((assetPath) => parseYaml(readFileSync(join(dir, assetPath), "utf-8")) as Record<string, unknown>);
  const extra: Record<string, unknown> = {};
  const faqAsset = manifest.workloom.provides.serviceFront.find((assetPath) => assetPath.endsWith("/faq.json"));
  if (faqAsset) {
    const raw = JSON.parse(readFileSync(join(dir, faqAsset), "utf-8")) as { faqs?: unknown[] };
    extra.faq = Array.isArray(raw?.faqs) ? raw.faqs : [];
  }
  return { bj, presets, fencePacks, extra };
}

/**
 * 覆盖层 DB 访问统一入口（HP-01）：RLS 依赖事务级 GUC，
 * 裸用连接池会让策略恒 false（修复前生产环境覆盖层整体不可用）。
 */
function tx<T>(scope: OverlayScope, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withOverlayTx(getAppPool(), scope, fn);
}

/** 流水线 deps：装配视图 + 账本出口（账本出口绑定当前事务 client，与状态变更同一 COMMIT） */
function scopedDeps(client: pg.PoolClient, scope: OverlayScope, actorId: string): PipelineDeps {
  return overlayPipelineDeps((slug) => loadViewFromDisk(slug), client, scope, actorId);
}

/** 当前生效覆盖层 → 冲突检测上下文（FAQ/服务目录/营业规则/禁用表达 四本现状账） */
function currentStateFromOverlay(doc: OverlayDoc | null): CurrentState {
  const cur: CurrentState = { faq: new Map(), catalog: new Map(), rules: new Map(), forbidden: new Set() };
  if (!doc) return cur;
  for (const it of doc.items) {
    if (it.type === "kb" && it.op === "append") {
      const v = it.value as Record<string, unknown>;
      if (it.path === "faq") cur.faq!.set(String(v.q ?? "").trim(), String(v.a ?? ""));
      if (it.path === "service-catalog") cur.catalog!.set(String(v.q ?? "").trim(), (v.price as number | null) ?? null);
      if (it.path === "forbidden") cur.forbidden!.add(String(v.rule ?? v.q ?? "").trim());
    }
    if (it.type === "threshold" && it.path.startsWith("biz/")) {
      cur.rules!.set(it.path.slice(4), it.value);
    }
  }
  return cur;
}

const baseInput = z.object({ baseBundle: z.string().min(1).max(50) });
const versionInput = baseInput.extend({ overlayVersion: z.number().int().positive() });

export const overlayRouter = router({
  /* ================= 运营版（全量） ================= */

  /** 版本历史（管理台时间线） */
  versions: protectedProcedure.input(baseInput).query(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    return tx(scope, (client) => listVersions(client, scope, input.baseBundle));
  }),

  /** 当前生效的覆盖层（无则 null） */
  active: protectedProcedure.input(baseInput).query(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    return tx(scope, (client) => loadActiveOverlay(client, scope, input.baseBundle));
  }),

  /** 存草稿（运营手工编辑入口） */
  saveDraft: actionProcedure("workspace.configure")
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
      const scope = scopeOf(ctx.identity);
      return tx(scope, (client) => saveDraft(client, scope, {
        tenant_id: ctx.identity.tenantId,
        base_bundle: input.baseBundle,
        base_version: input.baseVersion,
        items: input.items as never,
        note: input.note,
        canary_scope: input.canaryScope,
        createdBy: ctx.identity.memberNo,
      }));
    }),

  /** 流水线：草稿 → 考试 → 灰度（考试闸不过即拒，事件留痕） */
  toCanary: actionProcedure("workspace.configure").input(versionInput).mutation(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    try {
      return await tx(scope, (client) => draftToCanary(
        client, scope, input.baseBundle, input.overlayVersion,
        scopedDeps(client, scope, ctx.identity.memberNo),
      ));
    } catch (err) {
      // 考试闸拒收：状态变更已随事务回滚，拒收原因必须独立留痕（L4.2 需介入事件）
      if (err instanceof PipelineError && err.code === "EXAM_FAILED") {
        await recordOverlayEventInOwnTx(getAppPool(), scope, ctx.identity.memberNo, {
          type: "overlay.exam_failed",
          tenant_id: ctx.identity.tenantId,
          base_bundle: input.baseBundle,
          overlay_version: input.overlayVersion,
          detail: { reason: err.message, failures: err.detail ?? null },
        });
      }
      throw err;
    }
  }),

  /** 流水线：灰度 → 全量（观察期纪律） */
  toActive: actionProcedure("workspace.configure").input(versionInput).mutation(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    return tx(scope, (client) => canaryToActive(
      client, scope, input.baseBundle, input.overlayVersion,
      scopedDeps(client, scope, ctx.identity.memberNo),
    ));
  }),

  /** 一键回滚（止血，直激活） */
  rollback: actionProcedure("workspace.configure").input(baseInput).mutation(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    return tx(scope, (client) => rollback(
      client, scope, input.baseBundle, ctx.identity.memberNo, scopedDeps(client, scope, ctx.identity.memberNo),
    ));
  }),

  /** 导出快照（资产归属叙事：客户的定制可一键导出带走） */
  export: protectedProcedure.input(baseInput).query(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    return tx(scope, (client) => exportSnapshot(client, scope, input.baseBundle));
  }),

  /** Rebase 预检：行业包升级前，先出《兼容报告》（运营评审用） */
  rebasePreview: protectedProcedure
    .input(baseInput.extend({ toVersion: z.string().min(1).max(50) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const doc = await tx(scope, (client) => loadActiveOverlay(client, scope, input.baseBundle));
      if (!doc) return { report: null, summary: "当前无生效定制，升级零影响" };
      const report = detectRebase(doc, loadViewFromDisk(input.baseBundle), input.toVersion);
      return { report, summary: rebaseSummary(report) };
    }),

  /* ================= L1 配置层（AI 结构化意图落库） ================= */

  /** L1 自然语言录入：意图 → 校验 → 草稿（接待班/小织调用） */
  l1Intake: actionProcedure("workspace.configure")
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
      const scope = scopeOf(ctx.identity);
      return tx(scope, (client) => ingestL1(client, scope, input.baseBundle, input.baseVersion,
        input.intents, { note: input.note, createdBy: ctx.identity.memberNo, canaryScope: input.canaryScope }));
    }),

  /* ================= P0-2 配置录入管线（对话/文档 → 意图卡 → 草稿） ================= */

  /**
   * 对话录入·结构化预览（不落库）：一段人话 → 意图卡清单（客户逐张确认后走 l1Intake 落库）。
   * LLM 可用时走 LLM 增强（routedLlmCall，scene=kb-extract，真实计量留痕）；
   * mock/无配置 → 确定性抽取兜底，via=rule 标注——两条路径同一道 L1IntentSchema 闸。
   */
  l1Structurize: protectedProcedure
    .input(z.object({
      text: z.string().min(2).max(4000),
      useLlm: z.boolean().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const doc = { kind: "txt" as const, blocks: input.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), rows: [] };
      let intents = extractIntentsDeterministic(doc).intents;
      let via: "llm" | "rule" = "rule";
      if (input.useLlm !== false) {
        const llm = routedLlmCall({ gateway: getAppPool(), scope, scene: "kb-extract" });
        if (llm) {
          const { extractIntentsWithLlm } = await import("@workloom/base/overlay");
          const r = await extractIntentsWithLlm(input.text, llm);
          if (r) { intents = r; via = "llm"; }
        }
      }
      return {
        via,
        cards: intents.map((intent, i) => ({ id: `chat-${i}`, intent, summary: summarizeIntent(intent) })),
      };
    }),

  /**
   * 文档导入·预览（不落库）：上传文件 → 解析 → 抽取 → 冲突检测 → 意图卡清单。
   * 冲突来自与当前生效覆盖层的比对（同题 FAQ 不同答/同名不同价/规则改值/禁用重复）。
   */
  docIntakePreview: actionProcedure("workspace.configure")
    .input(z.object({
      baseBundle: z.string().min(1).max(50),
      filename: z.string().min(1).max(200),
      /** base64 文件内容（≤3MB） */
      contentBase64: z.string().max(4_200_000),
      useLlm: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const buf = Buffer.from(input.contentBase64, "base64");
      if (buf.length > 3_000_000) throw new Error("文件超过 3MB 上限");
      const active = await tx(scope, (client) => loadActiveOverlay(client, scope, input.baseBundle));
      const llm = input.useLlm === false ? undefined
        : routedLlmCall({ gateway: getAppPool(), scope, scene: "kb-extract" });
      return buildIntakePreview(input.filename, buf, {
        current: currentStateFromOverlay(active),
        llm,
      });
    }),

  /**
   * 文档导入·提交：客户在意图卡清单上勾选确认后，整批进覆盖层草稿（source: l1-intake + 批次溯源）。
   * 生效仍走流水线（考试→灰度→全量），整批可回滚。
   */
  docIntakeCommit: actionProcedure("workspace.configure")
    .input(z.object({
      baseBundle: z.string().min(1).max(50),
      baseVersion: z.string().min(1).max(50),
      batchId: z.string().min(1).max(40),
      filename: z.string().max(200).optional(),
      intents: z.array(L1IntentSchema).min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return tx(scope, (client) => ingestL1(client, scope, input.baseBundle, input.baseVersion,
        input.intents, {
          note: `文档导入批次 ${input.batchId}${input.filename ? `（${input.filename}）` : ""} · ${input.intents.length} 条意图`,
          createdBy: ctx.identity.memberNo,
        }));
    }),

  /** 健康汇总（晨报/健康分数据源：滞留草稿/超龄灰度预警） */
  health: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    return tx(scope, (client) => healthSummary(client, scope));
  }),

  /* ================= 客户简化版（只说人话） ================= */

  /** 我的定制：一句话状态（"您的 3 项定制已生效 / 2 项待裁决"） */
  myStatus: protectedProcedure.input(baseInput).query(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    const doc = await tx(scope, (client) => loadActiveOverlay(client, scope, input.baseBundle));
    if (!doc) return { hasOverlay: false, summary: "您还没有专属定制，当前使用行业标准配置" };
    return {
      hasOverlay: true,
      itemCount: doc.items.length,
      note: doc.note,
      summary: `您的 ${doc.items.length} 项专属定制已生效`,
    };
  }),

  /** 我的定制：一键恢复原样（客户侧唯一动作，不暴露版本概念） */
  myRollback: actionProcedure("workspace.configure").input(baseInput).mutation(async ({ ctx, input }) => {
    const scope = scopeOf(ctx.identity);
    const doc = await tx(scope, (client) => rollback(
      client, scope, input.baseBundle, ctx.identity.memberNo, scopedDeps(client, scope, ctx.identity.memberNo),
    ));
    return { ok: true, summary: `已恢复上一版定制（共 ${doc.items.length} 项）` };
  }),
});
