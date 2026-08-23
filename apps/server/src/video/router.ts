/**
 * video/router.ts —— 视频经理 tRPC 子路由（融合设计 §3/§6/§7 服务端接线）
 *
 * 六组过程：
 *  - studio：预生产流水线启动/状态（异步工作器，G1–G7 门走 approvals 原生消息）
 *  - cms：渲染脚本 CMS（asset-cms render-scripts 服务：版本链 + G8 审批联动）
 *  - render：Seedance 提交（G8 围栏预检；无 VOLCENGINE_ARK_API_KEY 走 mock 并标注 mock:true）
 *  - publish：全平台 RPA 发布任务入队（G9 围栏预检，publish-rpa runner 执行时复核）
 *  - metrics：近 7 天 account_metrics 聚合投影
 *  - comments：待处理评论队列（G10 分流级别随行返回）
 *
 * 纪律：全部带 workspace 作用域（scopeOf + 事务级 RLS 双 GUC）；
 *      一切写入与事件留痕同一事务同一 COMMIT（D16，gatewayAppendOnClient）；
 *      越权查询返回空而非 403（L7.1）。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { makeReadableId, newId } from "@workloom/shared";
import {
  approve as approveRenderScript,
  listByProject as listRenderScripts,
  newVersion as newRenderScriptVersion,
  RenderScriptError,
  type RenderScriptRow,
} from "@workloom/base/asset-cms";
import { judge, type RuntimeRule } from "@workloom/base/fence-engine";
import { PlatformSchema } from "@workloom/base/publish-rpa";
import { protectedProcedure, router, scopeOf, writeProcedure } from "../trpc/context.js";
import { accountingRouter } from "./accounting.js";
import { dealRouter } from "./deal.js";
import { getRun, startRun, StudioWorkerError } from "./studio-worker.js";

interface Scope { tenantId: string; workspaceId: string }

/** pg.Pool 结构类型（server 不直接依赖 @types/pg，从 db 包入口推导） */
export type AppPool = ReturnType<typeof getAppPool>;

/** 装载生效围栏规则（与 packages/runtime/src/loop.ts loadActiveRules 同口径：工作区 + '*' 基线） */
export async function loadActiveRules(
  app: AppPool,
  scope: Scope,
): Promise<{ rules: RuntimeRule[]; defaultLevel: "auto" | "review" | "block" }> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{
      rule_id: string; version: string; name: string; level: "auto" | "review" | "block";
      is_baseline: boolean; match_spec: { object_types: string[]; actions: string[]; when: string };
    }>(
      `SELECT rule_id, version, name, level, is_baseline, match_spec
       FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    return {
      rules: r.rows.map((row) => ({
        rule_id: row.rule_id, version: row.version, name: row.name, level: row.level,
        is_baseline: row.is_baseline, objectTypes: row.match_spec.object_types,
        actions: row.match_spec.actions, when: row.match_spec.when,
      })),
      defaultLevel: "review", // §3 门矩阵默认级别（写类动作无命中按 review，宁可错挂）
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** pg QueryResultRow 同形约束（server 不直接依赖 @types/pg；any 值位与 pg 原生一致） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryRow = { [column: string]: any };

/** scoped 只读（L7.1：RLS + workspace 谓词双保险，越权返回空） */
export async function scopedQuery<T extends QueryRow>(
  app: AppPool,
  scope: Scope,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function renderScriptRethrow(err: unknown): never {
  if (err instanceof RenderScriptError) {
    throw new TRPCError({
      code: err.code === "NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST",
      message: err.message,
    });
  }
  throw err;
}

/* ================= studio：预生产流水线 ================= */

const studioRouter = router({
  /** 启动预生产（异步；projectId 缺省按 VID-nnn 口径生成；LLM 未配置明确拒绝） */
  start: writeProcedure
    .input(z.object({
      projectId: z.string().min(1).optional(),
      intent: z.string().min(1).max(2000),
      metadata: z.record(z.string(), z.unknown()).optional(),
      isMarketing: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      let projectId: string;
      try {
        // D16（#1/A）：项目行与建档事件同一事务同一 COMMIT（模仿 threads.dispatch 口径）
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        if (input.projectId) {
          projectId = input.projectId;
        } else {
          const max = await client.query<{ n: number }>(
            `SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\\D', '', 'g'), '')::int), 0) AS n
             FROM video_projects WHERE workspace_id=$1 AND id ~ '^VID-\\d+$'`,
            [scope.workspaceId],
          );
          projectId = makeReadableId("VID", (max.rows[0]?.n ?? 0) + 1);
        }
        const kind = input.isMarketing ? "marketing" : "narrative";
        await client.query(
          `INSERT INTO video_projects (id, workspace_id, title, kind, created_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [projectId, scope.workspaceId, input.intent.slice(0, 200), kind, ctx.identity.memberNo],
        );
        await gatewayAppendOnClient(client, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" },
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: {
            tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
            time: new Date().toISOString(), channel: "inapp",
          },
          object: { type: "video_project", id: projectId },
          decision: {
            action: "video.project.create",
            after: { projectId, kind, intent: input.intent.slice(0, 500) },
            basis: ["视频项目建档（§5：一部片子/一个营销 Campaign）"],
          },
          rule_impact: [],
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      try {
        const runId = startRun(scope, {
          projectId: projectId!,
          intent: input.intent,
          metadata: input.metadata,
          isMarketing: input.isMarketing,
        });
        return { runId, projectId: projectId! };
      } catch (err) {
        if (err instanceof StudioWorkerError && err.code === "LLM_MISSING") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
        }
        throw err;
      }
    }),

  /** 运行状态投影（run 注册表 + 当前待审批门；L7.1 跨工作区返回 null） */
  status: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ ctx, input }) => {
      const entry = getRun(input.runId, scopeOf(ctx.identity).workspaceId);
      if (!entry) return null;
      return {
        runId: entry.runId,
        projectId: entry.projectId,
        status: entry.status,
        currentGate: entry.currentGate,
        pendingApprovalId: entry.pendingApprovalId,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        error: entry.error,
        resultSummary: entry.resultSummary,
      };
    }),
});

/* ================= cms：渲染脚本 CMS（§6） ================= */

const cmsRouter = router({
  /** 按项目列出全部脚本版本（片库·脚本页数据源） */
  listScripts: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return listRenderScripts(getAppPool(), scopeOf(ctx.identity), input.projectId);
    }),

  /** 单版本详情（MD 正文 + 字段 JSON + 字符数校验快照；L7.1 越权返回 null） */
  getScript: protectedProcedure
    .input(z.object({ scriptId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const rows = await scopedQuery<RenderScriptRow>(
        getAppPool(), scope,
        `SELECT * FROM render_scripts WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, input.scriptId],
      );
      return rows[0] ?? null;
    }),

  /** 保存即新版本（§6 本地编辑纪律：parent_version 链 + diff 摘要；事件随版本行同一 COMMIT） */
  saveScriptVersion: writeProcedure
    .input(z.object({
      scriptKey: z.string().min(1),
      md: z.string().min(1),
      fields: z.record(z.string(), z.unknown()).optional(),
      charCheck: z.record(z.string(), z.unknown()).optional(),
      diffSummary: z.string().default("工作台手工编辑"),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await newRenderScriptVersion(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), input.scriptKey, {
          md: input.md,
          fields: input.fields,
          charCheck: input.charCheck,
          diffSummary: input.diffSummary,
          by: ctx.identity.memberNo,
        });
      } catch (err) {
        renderScriptRethrow(err);
      }
    }),

  /** G8 审批联动（版本即审批对象：draft → approved + approvals 行，服务内同一 COMMIT） */
  approveScript: writeProcedure
    .input(z.object({ scriptKey: z.string().min(1), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await approveRenderScript(
          getAppPool(), getGatewayPool(), scopeOf(ctx.identity),
          input.scriptKey, input.version, { by: ctx.identity.memberNo },
        );
      } catch (err) {
        renderScriptRethrow(err);
      }
    }),
});

/* ================= render：Seedance 提交（G8 围栏） ================= */

const renderRouter = router({
  /**
   * 渲染提交（§6 三档模式 manual/batch/auto；G8 烧额度门）：
   * 围栏 block → 403；review → 须脚本已过 cms.approveScript（approved）；auto → 放行
   * 无 VOLCENGINE_ARK_API_KEY → mock 提交（task_id 前缀 mock-，返回 mock:true 明确标注）
   */
  submit: writeProcedure
    .input(z.object({
      scriptId: z.string().min(1),
      mode: z.enum(["manual", "batch", "auto"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const scripts = await scopedQuery<RenderScriptRow>(
        app, scope,
        `SELECT * FROM render_scripts WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, input.scriptId],
      );
      const script = scripts[0];
      if (!script) throw new TRPCError({ code: "NOT_FOUND", message: `渲染脚本 ${input.scriptId} 不存在` });

      // G8 围栏预检（纯函数判定；impacts 随事件落库）
      const { rules, defaultLevel } = await loadActiveRules(app, scope);
      const verdict = judge({
        object: { type: "render_script", id: script.id },
        action: "render.submit",
        params: { mode: input.mode, scriptKey: script.script_key, version: script.version },
      }, rules, defaultLevel);
      if (verdict.level === "block") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `G8 围栏熔断：${verdict.triggeredBy.join("；") || "render.submit 命中 block 规则"}`,
        });
      }
      if (verdict.level === "review" && script.status !== "approved") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `G8：渲染提交烧额度前置门——脚本 ${script.script_key} v${script.version} 须先经 video.cms.approveScript 审批（当前 ${script.status}；版本即审批对象）`,
        });
      }

      const mock = !process.env.VOLCENGINE_ARK_API_KEY;
      const taskId = mock ? `mock-${newId("seedance")}` : null;
      const jobId = newId("RJ");
      const client = await app.connect();
      try {
        // D16（#1/A）：render_jobs 行、脚本状态推进、提交事件同一事务同一 COMMIT
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await client.query(
          `INSERT INTO render_jobs (id, workspace_id, project_id, script_id, script_version, task_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,'submitted')`,
          [jobId, scope.workspaceId, script.project_id, script.id, script.version, taskId],
        );
        await client.query(
          `UPDATE render_scripts SET status='submitted' WHERE workspace_id=$1 AND id=$2`,
          [scope.workspaceId, script.id],
        );
        await gatewayAppendOnClient(client, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" },
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: {
            tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
            time: new Date().toISOString(), channel: "inapp",
          },
          object: { type: "render_script", id: script.id },
          decision: {
            action: "render.submit",
            after: {
              jobId, taskId, mock, mode: input.mode,
              scriptKey: script.script_key, version: script.version, projectId: script.project_id,
            },
            basis: [mock
              ? "G8 已过，Seedance 提交（mock：无 VOLCENGINE_ARK_API_KEY，不触真实渲染不烧额度）"
              : "G8 已过，Seedance 提交（§6 渲染提交，烧额度门已审）"],
          },
          rule_impact: verdict.impacts,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return { jobId, taskId, mock, level: verdict.level };
    }),
});

/* ================= publish：全平台 RPA 发布（§7，G9） ================= */

const publishRouter = router({
  /**
   * 发布任务入队（G9 围栏预检：block 直接 403 不入队；auto/review 入队 pending——
   * 执行时由 publish-rpa runner 复核 G9，非 auto 挂起 pending_review 待审，适配器不执行）
   */
  createTask: writeProcedure
    .input(z.object({
      platform: PlatformSchema,
      accountId: z.string().min(1),
      assetId: z.string().min(1).optional(),
      videoPath: z.string().min(1),
      coverPath: z.string().min(1).optional(),
      caption: z.string().max(2000).default(""),
      tags: z.array(z.string()).default([]),
      scheduleAt: z.iso.datetime({ offset: true }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const { rules, defaultLevel } = await loadActiveRules(app, scope);
      const taskId = newId("PT");
      const verdict = judge({
        object: { type: "publish_task", id: taskId },
        action: "publish.execute",
        params: { platform: input.platform, accountId: input.accountId, scheduleAt: input.scheduleAt ?? null },
      }, rules, defaultLevel);
      if (verdict.level === "block") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `G9 围栏熔断：${verdict.triggeredBy.join("；") || "publish.execute 命中 block 规则"}（公网发布必审基线）`,
        });
      }
      const client = await app.connect();
      try {
        // D16（#1/A）：发布任务行与入队事件同一事务同一 COMMIT
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await client.query(
          `INSERT INTO publish_tasks
             (id, workspace_id, platform, account_id, asset_id, video_path, cover_path, caption, tags, schedule_at, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,'pending',$11)`,
          [
            taskId, scope.workspaceId, input.platform, input.accountId, input.assetId ?? null,
            input.videoPath, input.coverPath ?? null, input.caption,
            JSON.stringify(input.tags), input.scheduleAt ?? null, ctx.identity.memberNo,
          ],
        );
        await gatewayAppendOnClient(client, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" },
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: {
            tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
            time: new Date().toISOString(), channel: "inapp",
          },
          object: { type: "publish_task", id: taskId },
          decision: {
            action: "publish.task.create",
            after: {
              taskId, platform: input.platform, accountId: input.accountId,
              scheduleAt: input.scheduleAt ?? null, fenceLevel: verdict.level,
            },
            basis: [`发布任务入队（§7；G9 预检 ${verdict.level}，执行时 runner 复核，非 auto 挂起待审）`],
          },
          rule_impact: verdict.impacts,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return { taskId, level: verdict.level };
    }),
});

/* ================= metrics：近 7 天指标聚合 ================= */

const metricsRouter = router({
  /** 近 7 天 account_metrics 聚合（按平台+账号分组；越权返回空 L7.1） */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const rows = await scopedQuery<{
      platform: string; account_id: string;
      plays: string; likes: string; comments: string; shares: string; conversions: string;
      samples: string; last_captured_at: string;
    }>(
      getAppPool(), scope,
      `SELECT platform, account_id,
              SUM(plays)::text AS plays, SUM(likes)::text AS likes, SUM(comments)::text AS comments,
              SUM(shares)::text AS shares, SUM(conversions)::text AS conversions,
              COUNT(*)::text AS samples, MAX(captured_at) AS last_captured_at
       FROM account_metrics
       WHERE workspace_id=$1 AND captured_at >= now() - interval '7 days'
       GROUP BY platform, account_id
       ORDER BY platform, account_id`,
      [scope.workspaceId],
    );
    return { windowDays: 7, rows };
  }),
});

/* ================= comments：待处理评论队列（G10） ================= */

const commentsRouter = router({
  /** 待处理评论队列（new/pending_review）+ G10 分流级别随行（route_level） */
  pending: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return scopedQuery<{
        id: string; platform: string; account_id: string; video_id: string | null;
        author: string | null; text: string; intent: string | null;
        route_level: string | null; status: string; collected_at: string;
      }>(
        getAppPool(), scope,
        `SELECT id, platform, account_id, video_id, author, text, intent, route_level, status, collected_at
         FROM comments
         WHERE workspace_id=$1 AND status IN ('new','pending_review')
         ORDER BY collected_at DESC
         LIMIT $2`,
        [scope.workspaceId, input.limit],
      );
    }),
});

export const videoRouter = router({
  studio: studioRouter,
  cms: cmsRouter,
  render: renderRouter,
  publish: publishRouter,
  metrics: metricsRouter,
  comments: commentsRouter,
  deal: dealRouter,
  accounting: accountingRouter,
});
