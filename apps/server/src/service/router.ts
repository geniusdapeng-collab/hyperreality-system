/**
 * service · B 端管理端点（tRPC serviceRouter，挂根 router 为 service）
 *  - kb.*：知识库管理（写操作 writeProcedure；查询 protectedProcedure + scopeOf）
 *  - kb.pendingReviews / kb.approveDocument：审核台；批准生效联动 approvals 审批台
 *    （approvals 行 + 五元事件 + 文档状态三写同一 COMMIT，围栏动作 'kb.publish'，D16）
 *  - tickets.*：B 端工单消费（complete 后 pushMessage 结果通知 C 端）
 *  - stats.overview：今日运营聚合（c_messages / c_tickets 投影）
 * 全部写操作落五元事件；LLM 调用走 model-router（llm.ts，缺 key 自动降级）。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, scopeOf, writeProcedure } from "../trpc/context.js";
import {
  createCollectionOn, listCollections, listDocuments, setDocumentStatusOn, upsertDocumentOn,
  registerSiteSourceOn, crawlAndStructure, diffScan, searchKB,
} from "./kb.js";
import { assignTicketOn, advanceTicketOn, completeTicketOn, listTickets, slaScanOn, ticketTimeline } from "./ticket.js";
import { pushMessage } from "./channels.js";
import { appendEventOn, serviceTx, svcQuery } from "./events.js";
import { llmCall } from "./llm.js";
import { ensureServiceSchema } from "./store.js";
import {
  activeInstall, clearBundle, clearPreview, generateStaffing,
  onboardingExam, rollbackSnapshot,
} from "./bundle.js";
import {
  githubPulse as aipmGithubPulse, industryRadar as aipmIndustryRadar,
  competitorScan as aipmCompetitorScan, prdForge as aipmPrdForge,
} from "./aipm.js";
import {
  getSettings as evalGetSettings, latestReport as evalLatestReport,
  listAnswers as evalListAnswers, listExams as evalListExams,
  listQuestions as evalListQuestions, runExam as evalRunExam,
  seedQuestionsIfEmpty as evalSeedQuestions, setPromotionGate as evalSetPromotionGate,
} from "./eval.js";
import {
  listTools as devListTools, refreshTools as devRefreshTools,
  listRepos as devListRepos, registerRepo as devRegisterRepo, setRepoStatus as devSetRepoStatus,
  createTask as devCreateTask, confirmTask as devConfirmTask, dispatchTask as devDispatchTask,
  rejectTask as devRejectTask, cancelTask as devCancelTask, approveRelease as devApproveRelease,
  listTasks as devListTasks, taskDetail as devTaskDetail, sessionEvents as devSessionEvents,
  listReleases as devListReleases, saveCustomTool as devSaveCustomTool,
} from "./devtools.js";
import {
  getSettings as secGetSettings, saveSettings as secSaveSettings, scan as secScan,
  inbox as secInbox, markInbox as secMarkInbox, addReminder as secAddReminder,
  listReminders as secListReminders, memoryPanel as secMemoryPanel,
  remember as secRemember, forget as secForget, chat as secChat,
} from "./secretary.js";

const kbRouter = router({
  listCollections: protectedProcedure.query(async ({ ctx }) => {
    return { collections: await listCollections({ workspaceId: scopeOf(ctx.identity).workspaceId }) };
  }),

  createCollection: writeProcedure
    .input(z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return serviceTx(scope.workspaceId, async (client, sc) => {
        // D16：建集与事件同一 client 同一 COMMIT（createCollectionOn 事务内变体，不再嵌套另开连接）
        const col = await createCollectionOn(client, { workspaceId: scope.workspaceId, name: input.name, description: input.description });
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "kb_collection", objectId: col.id, action: "kb.collection.create",
          after: { name: input.name, description: input.description ?? null },
        });
        return { collection: col };
      });
    }),

  listDocuments: protectedProcedure
    .input(z.object({ collectionId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return { documents: await listDocuments({ workspaceId: scopeOf(ctx.identity).workspaceId, collectionId: input?.collectionId }) };
    }),

  upsertDocument: writeProcedure
    .input(z.object({
      collectionId: z.string().min(1),
      title: z.string().min(1).max(200),
      sourceKind: z.string().max(20).default("manual"),
      sourceUrl: z.string().url().optional(),
      contentMd: z.string().min(1).max(100_000),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return serviceTx(scope.workspaceId, async (client, sc) => {
        const r = await upsertDocumentOn(client, { workspaceId: scope.workspaceId, ...input });
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "kb_document", objectId: r.documentId, action: "kb.document.upsert",
          after: { title: input.title, version: r.version, chunks: r.chunks, sourceKind: input.sourceKind },
        });
        return r;
      });
    }),

  setStatus: writeProcedure
    .input(z.object({ documentId: z.string(), status: z.enum(["active", "pending_review", "disabled"]) }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return serviceTx(scope.workspaceId, async (client, sc) => {
        await setDocumentStatusOn(client, { workspaceId: scope.workspaceId, documentId: input.documentId, status: input.status });
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "kb_document", objectId: input.documentId, action: "kb.document.status",
          after: { status: input.status },
        });
        return { ok: true };
      });
    }),

  registerSite: writeProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return serviceTx(scope.workspaceId, async (client, sc) => {
        const r = await registerSiteSourceOn(client, { workspaceId: scope.workspaceId, url: input.url });
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "kb_site", objectId: r.sourceId, action: "kb.site.register", after: { url: input.url },
        });
        return r;
      });
    }),

  /** 立即抓取（LLM 经 model-router 注入；缺 key 降级直存，degraded:true） */
  crawlNow: writeProcedure
    .input(z.object({ sourceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const r = await crawlAndStructure({ workspaceId: scope.workspaceId, sourceId: input.sourceId, llm: llmCall() });
      await serviceTx(scope.workspaceId, async (client, sc) => {
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "kb_site", objectId: input.sourceId, action: "kb.crawl",
          after: { documentId: r.documentId, entryCount: r.entryCount, degraded: r.degraded ?? false },
        });
      });
      return r;
    }),

  diffScan: writeProcedure
    .input(z.object({ sourceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const r = await diffScan({ workspaceId: scope.workspaceId, sourceId: input.sourceId });
      await serviceTx(scope.workspaceId, async (client, sc) => {
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "kb_site", objectId: input.sourceId, action: "kb.diff_scan",
          after: r,
        });
      });
      return r;
    }),

  search: protectedProcedure
    .input(z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() }))
    .query(async ({ ctx, input }) => {
      return { hits: await searchKB({ workspaceId: scopeOf(ctx.identity).workspaceId, query: input.query, limit: input.limit }) };
    }),

  /** 待审核文档（pending_review 列表） */
  pendingReviews: protectedProcedure.query(async ({ ctx }) => {
    await ensureServiceSchema();
    const scope = scopeOf(ctx.identity);
    const rows = await svcQuery(
      scope.workspaceId,
      `SELECT id, title, source_kind, source_url, version, created_at FROM kb_documents
       WHERE workspace_id=$1 AND status='pending_review' ORDER BY created_at DESC`,
      [scope.workspaceId],
    );
    return { documents: rows };
  }),

  /** 批准生效：文档状态 + 五元事件 + approvals 行 三写同一 COMMIT（围栏动作 'kb.publish'，审批台可见） */
  approveDocument: writeProcedure
    .input(z.object({ documentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return serviceTx(scope.workspaceId, async (client, sc) => {
        const doc = await client.query(
          `UPDATE kb_documents SET status='active'
           WHERE workspace_id=$1 AND id=$2 RETURNING title, version`,
          [scope.workspaceId, input.documentId],
        );
        if (!doc.rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `文档不存在：${input.documentId}` });
        const ev = await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "kb_document", objectId: input.documentId, action: "kb.publish",
          after: { title: (doc.rows[0] as Record<string, unknown>).title, version: (doc.rows[0] as Record<string, unknown>).version, status: "active" },
        });
        // 联动 approvals 审批台（approvals INSERT 范式：UNIQUE(event_id, channel) 冲突丢弃，L5.3）
        await client.query(
          `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
           VALUES ($1,$2,$3,$4,'inapp','pending',$5)
           ON CONFLICT (event_id, channel) DO NOTHING`,
          [`apr-${ev.eventId.toLowerCase()}`, sc.tenantId, sc.workspaceId, ev.eventId,
           JSON.stringify({ after: { documentId: input.documentId, fence_action: "kb.publish" }, high_risk: false })],
        );
        return { ok: true, eventId: ev.eventId };
      });
    }),
});

const ticketsRouter = router({
  list: protectedProcedure
    .input(z.object({ status: z.string().optional(), dept: z.string().optional(), cUserId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return { tickets: await listTickets({ workspaceId: scopeOf(ctx.identity).workspaceId, ...input }) };
    }),

  timeline: protectedProcedure
    .input(z.object({ ticketId: z.string() }))
    .query(async ({ ctx, input }) => {
      return { timeline: await ticketTimeline({ workspaceId: scopeOf(ctx.identity).workspaceId, ticketId: input.ticketId }) };
    }),

  assign: writeProcedure
    .input(z.object({ ticketId: z.string(), dept: z.string().optional(), assignee: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const t = await serviceTx(scope.workspaceId, async (client, sc) => {
        const t2 = await assignTicketOn(client, { workspaceId: scope.workspaceId, ...input });
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "ticket", objectId: t2.id, action: "service.ticket.assign",
          after: { dept: t2.dept, assignee: t2.assignee },
        });
        return t2;
      });
      return { ticket: t };
    }),

  advance: writeProcedure
    .input(z.object({
      ticketId: z.string(), action: z.string().min(1).max(40),
      detail: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const t = await serviceTx(scope.workspaceId, async (client, sc) => {
        const t2 = await advanceTicketOn(client, {
          workspaceId: scope.workspaceId, ticketId: input.ticketId, action: input.action,
          actorType: "staff", actorId: ctx.identity.memberNo, detail: input.detail,
        });
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "ticket", objectId: t2.id, action: "service.ticket.advance",
          after: { step: input.action, status: t2.status, detail: input.detail ?? null },
        });
        return t2;
      });
      return { ticket: t };
    }),

  /** 完结：结果通知 C 端（pushMessage；无真实通道 mock:true） */
  complete: writeProcedure
    .input(z.object({ ticketId: z.string(), result: z.string().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const t = await serviceTx(scope.workspaceId, async (client, sc) => {
        const t2 = await completeTicketOn(client, {
          workspaceId: scope.workspaceId, ticketId: input.ticketId,
          result: input.result, actorId: ctx.identity.memberNo,
        });
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "ticket", objectId: t2.id, action: "service.ticket.complete",
          after: { result: input.result },
        });
        return t2;
      });
      if (t.cUserId) {
        await pushMessage({
          workspaceId: scope.workspaceId, cUserId: t.cUserId, kind: "ticket.completed",
          payload: { ticketId: t.id, title: t.title, text: `您的工单「${t.title}」已办结：${input.result}` },
        });
      }
      return { ticket: t };
    }),

  /** SLA 扫描（超时升级；演示手动触发，生产挂定时器） */
  slaScan: writeProcedure.mutation(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const r = await serviceTx(scope.workspaceId, async (client, sc) => {
      const r2 = await slaScanOn(client, { workspaceId: scope.workspaceId });
      if (r2.escalated > 0) {
        await appendEventOn(client, sc, { id: "sla-scan", type: "system" }, {
          objectType: "ticket", objectId: "batch", action: "service.ticket.escalate",
          after: { escalated: r2.escalated },
        });
      }
      return r2;
    });
    return r;
  }),
});

const statsRouter = router({
  /** 今日运营总览：会话/问答/置信度/有据率/延迟/工单/完结率/SLA/满意度（c_messages/c_tickets 聚合投影） */
  overview: protectedProcedure.query(async ({ ctx }) => {
    await ensureServiceSchema();
    const scope = scopeOf(ctx.identity);
    const msgRows = await svcQuery<{
      sessions: string; qa: string; avg_confidence: string | null; grounded: string; answered: string; avg_latency: string | null;
    }>(
      scope.workspaceId,
      `SELECT
         count(DISTINCT conversation_id) FILTER (WHERE role='user')::text AS sessions,
         count(*) FILTER (WHERE role='user')::text AS qa,
         avg(confidence) FILTER (WHERE role='assistant')::text AS avg_confidence,
         count(*) FILTER (WHERE role='assistant' AND jsonb_array_length(citations) > 0)::text AS grounded,
         count(*) FILTER (WHERE role='assistant')::text AS answered,
         avg(latency_ms) FILTER (WHERE role='assistant')::text AS avg_latency
       FROM c_messages
       WHERE workspace_id=$1 AND created_at >= date_trunc('day', now())`,
      [scope.workspaceId],
    );
    const tckRows = await svcQuery<{
      total: string; total_all: string; done: string; sla_breached: string; avg_rating: string | null;
    }>(
      scope.workspaceId,
      `SELECT
         count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::text AS total,
         count(*)::text AS total_all,
         count(*) FILTER (WHERE status='done')::text AS done,
         count(*) FILTER (WHERE sla_due_at < now() AND status NOT IN ('done','closed'))::text AS sla_breached,
         avg(COALESCE((payload->'rating'->>'score')::numeric, (result->'rating'->>'score')::numeric))::text AS avg_rating
       FROM c_tickets WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    const m = msgRows[0]!;
    const t = tckRows[0]!;
    const total = Number(t.total);
    return {
      date: new Date().toISOString().slice(0, 10),
      sessions: Number(m.sessions),
      qaCount: Number(m.qa),
      avgConfidence: m.avg_confidence === null ? null : Number(Number(m.avg_confidence).toFixed(3)),
      groundedRate: Number(m.answered) === 0 ? null : Number((Number(m.grounded) / Number(m.answered)).toFixed(3)),
      avgLatencyMs: m.avg_latency === null ? null : Math.round(Number(m.avg_latency)),
      ticketsToday: total,
      // 完结率=累计完结/累计工单（恒 ∈[0,1]；此前误用「全量完结÷今日新增」，数据量大时 >1）
      completionRate: Number(t.total_all) === 0 ? null : Number((Number(t.done) / Number(t.total_all)).toFixed(3)),
      slaBreached: Number(t.sla_breached),
      avgRating: t.avg_rating === null ? null : Number(Number(t.avg_rating).toFixed(2)),
    };
  }),
});

/**
 * 考试院（方案 V2.0）：成绩单/考试记录/题库/开考/设置
 * 全部查询 protectedProcedure；开考与授权走 writeProcedure（留痕）。
 */
const evalRouter = router({
  /** 最新成绩单（看板首页） */
  latestReport: protectedProcedure.query(async ({ ctx }) => {
    const ws = scopeOf(ctx.identity).workspaceId;
    return { report: await evalLatestReport(ws) };
  }),
  /** 考试场次列表 */
  listExams: protectedProcedure.query(async ({ ctx }) => {
    const ws = scopeOf(ctx.identity).workspaceId;
    return { exams: await evalListExams(ws) };
  }),
  /** 某场答题卡（含判卷明细） */
  listAnswers: protectedProcedure
    .input(z.object({ examId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const ws = scopeOf(ctx.identity).workspaceId;
      return { answers: await evalListAnswers(ws, input.examId) };
    }),
  /** 题库（含结构×维度双标签） */
  listQuestions: protectedProcedure.query(async ({ ctx }) => {
    const ws = scopeOf(ctx.identity).workspaceId;
    return { questions: await evalListQuestions(ws) };
  }),
  /** 开考（手动/变更触发；P0 同步执行） */
  runExam: writeProcedure
    .input(z.object({
      examType: z.enum(["on-change", "weekly", "onboarding"]).default("weekly"),
      subjectScope: z.array(z.string()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const ws = scopeOf(ctx.identity).workspaceId;
      const r = await evalRunExam(ws, { examType: input.examType, subjectScope: input.subjectScope });
      return { exam: r.exam, wrongCount: r.answers.filter((a) => !a.passed).length };
    }),
  /** 播种示例题库（空库时） */
  seedQuestions: writeProcedure.mutation(async ({ ctx }) => {
    const ws = scopeOf(ctx.identity).workspaceId;
    return { seeded: await evalSeedQuestions(ws) };
  }),
  /** 设置查询 */
  settings: protectedProcedure.query(async ({ ctx }) => {
    const ws = scopeOf(ctx.identity).workspaceId;
    return { settings: await evalGetSettings(ws) };
  }),
  /** 卡晋升授权开关（默认关；开启即留痕——授权动作写事件库） */
  setPromotionGate: writeProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const settings = await serviceTx(scope.workspaceId, async (client, sc) => {
        const s = await evalSetPromotionGate(scope.workspaceId, input.enabled);
        await appendEventOn(client, sc, { id: ctx.identity.memberNo, type: "human" }, {
          objectType: "eval_settings", objectId: scope.workspaceId,
          action: input.enabled ? "eval.promotion_gate.enable" : "eval.promotion_gate.disable",
          after: { promotion_gate: input.enabled },
        });
        return s;
      });
      return { settings };
    }),
});

/**
 * AI 产品经理技能执行面（V4 P1）：github-pulse / industry-radar / competitor-scan / prd-forge
 * 全部真实接线（真实 API/RSS/抓取/LLM）；凭据只出不进（secret 永不回传）。
 */
const aipmRouter = router({
  /** 仓库脉搏：真实 GitHub API（repos 如 ["org/repo"]） */
  githubPulse: protectedProcedure
    .input(z.object({ repos: z.array(z.string()).min(1).max(8) }))
    .mutation(async ({ ctx, input }) => {
      return aipmGithubPulse(scopeOf(ctx.identity).workspaceId, input.repos);
    }),
  /** 行业雷达：真实 RSS 聚合（可自定义源） */
  industryRadar: writeProcedure
    .input(z.object({ feeds: z.array(z.string().url()).max(8).optional() }))
    .mutation(async ({ ctx, input }) => {
      return aipmIndustryRadar(scopeOf(ctx.identity).workspaceId, input.feeds);
    }),
  /** 竞品扫描：真实抓取竞品页面对比快照 */
  competitorScan: writeProcedure
    .input(z.object({ targets: z.array(z.object({ name: z.string(), url: z.string().url() })).min(1).max(6) }))
    .mutation(async ({ ctx, input }) => {
      return aipmCompetitorScan(scopeOf(ctx.identity).workspaceId, input.targets);
    }),
  /** PRD 起草：真实 LLM 生成可导出 MD */
  prdForge: writeProcedure
    .input(z.object({ title: z.string().min(1).max(200), context: z.string().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      return aipmPrdForge(scopeOf(ctx.identity).workspaceId, input);
    }),
});

/**
 * 行业装配机制（V4 §3/§6/§7）：清空预览/一键清空/快照回滚/编制生成/上岗考
 * 全部写操作五元事件留痕；清空红线：快照未成功禁止执行。
 */
const bundleRouter = router({
  /** 当前装配台账 */
  activeInstall: protectedProcedure.query(async ({ ctx }) => {
    return { install: await activeInstall(scopeOf(ctx.identity).workspaceId) };
  }),
  /** 清空预览（明示范围：将卸什么/将留什么） */
  clearPreview: protectedProcedure.query(async ({ ctx }) => {
    return clearPreview(scopeOf(ctx.identity).workspaceId);
  }),
  /** 一键清空（快照→台账卸载→留痕；30 天可回滚） */
  clear: writeProcedure.mutation(async ({ ctx }) => {
    return clearBundle(scopeOf(ctx.identity).workspaceId, { id: ctx.identity.memberNo, type: "human" });
  }),
  /** 快照回滚 */
  rollback: writeProcedure
    .input(z.object({ snapshotId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return rollbackSnapshot(scopeOf(ctx.identity).workspaceId, input.snapshotId, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** L3 编制生成（草案先行，人审才装配） */
  generateStaffing: writeProcedure
    .input(z.object({ industryText: z.string().min(4).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      return generateStaffing(scopeOf(ctx.identity).workspaceId, input.industryText);
    }),
  /** 上岗考（exam 门禁：达标才 activated） */
  onboardingExam: writeProcedure.mutation(async ({ ctx }) => {
    return onboardingExam(scopeOf(ctx.identity).workspaceId);
  }),
});

/**
 * 开发场域（DevFabric）：设备台账 / 仓库白名单 / 任务单 / 派发 / 审计 / 发布 / 版本
 * 全部写操作五元事件留痕；派发与取消即时生效，审计与返修后台接续。
 */
const devtoolsRouter = router({
  /** 设备台账（含未安装适配器的指引——真运行态纪律） */
  tools: protectedProcedure.query(async ({ ctx }) => {
    return devListTools(scopeOf(ctx.identity).workspaceId);
  }),
  /** 重新探测本机机床（PATH 扫描+版本握手） */
  refreshTools: writeProcedure.mutation(async ({ ctx }) => {
    return devRefreshTools(scopeOf(ctx.identity).workspaceId, { id: ctx.identity.memberNo, type: "human" });
  }),
  /** 客户自行接入新机床（声明式标准协议 YAML 落盘+热加载） */
  addCustomTool: writeProcedure
    .input(z.object({
      tool_key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      display_name: z.string().min(1).max(100),
      bin: z.string().min(1).max(100),
      version_args: z.array(z.string()).max(4).optional(),
      capabilities: z.object({ headless: z.boolean().optional(), streamEvents: z.enum(["jsonl", "text"]).optional(), sessionResume: z.boolean().optional(), sandboxFlag: z.boolean().optional() }).optional(),
      args: z.array(z.string()).min(1).max(20),
      resume_args: z.array(z.string()).max(20).optional(),
      env: z.record(z.string(), z.array(z.string())).optional(),
      output: z.object({
        protocol: z.enum(["claude-stream-json", "codex-jsonl", "json-result", "text"]),
        text_map: z.object({ file_edited: z.string().optional(), command_run: z.string().optional() }).optional(),
      }),
      install_hint: z.string().max(300).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return devSaveCustomTool(scopeOf(ctx.identity).workspaceId, input, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** 仓库白名单 */
  repos: protectedProcedure.query(async ({ ctx }) => {
    return devListRepos(scopeOf(ctx.identity).workspaceId);
  }),
  registerRepo: writeProcedure
    .input(z.object({
      name: z.string().min(1).max(100), path: z.string().min(1).max(500),
      baselineBranch: z.string().max(100).optional(), allowedDirs: z.array(z.string()).max(20).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return devRegisterRepo(scopeOf(ctx.identity).workspaceId, input, { id: ctx.identity.memberNo, type: "human" });
    }),
  setRepoStatus: writeProcedure
    .input(z.object({ repoId: z.string(), status: z.enum(["active", "disabled"]) }))
    .mutation(async ({ ctx, input }) => {
      return devSetRepoStatus(scopeOf(ctx.identity).workspaceId, input.repoId, input.status, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** 任务单（S2） */
  tasks: protectedProcedure.query(async ({ ctx }) => {
    return devListTasks(scopeOf(ctx.identity).workspaceId);
  }),
  createTask: writeProcedure
    .input(z.object({
      prdRef: z.string().max(300).optional(), repoId: z.string(),
      title: z.string().min(1).max(200), prdSummary: z.string().min(1).max(8000),
      acceptance: z.array(z.string().min(1).max(500)).min(1).max(20),
      constraints: z.array(z.string().max(300)).max(20).optional(),
      changeKind: z.enum(["feat", "fix", "breaking", "chore"]).optional(),
      assignedTool: z.enum(["codex", "claude-code", "aider"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return devCreateTask(scopeOf(ctx.identity).workspaceId, input, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** S2 拆解确认（确认才进 S3） */
  confirmTask: writeProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return devConfirmTask(scopeOf(ctx.identity).workspaceId, input.taskId, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** S3 派发（异步：立即返回 sessionId，会话后台跑） */
  dispatchTask: writeProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return devDispatchTask(scopeOf(ctx.identity).workspaceId, input.taskId, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** S5 打回（一句话意见回灌重排） */
  rejectTask: writeProcedure
    .input(z.object({ taskId: z.string(), note: z.string().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      return devRejectTask(scopeOf(ctx.identity).workspaceId, input.taskId, input.note, { id: ctx.identity.memberNo, type: "human" });
    }),
  cancelTask: writeProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return devCancelTask(scopeOf(ctx.identity).workspaceId, input.taskId, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** S5 批准 → S6 版本台账（合并/tag/changelog/release 一气落库） */
  approveRelease: writeProcedure
    .input(z.object({ taskId: z.string(), version: z.string().max(40).optional(), changelog: z.string().max(4000).optional() }))
    .mutation(async ({ ctx, input }) => {
      return devApproveRelease(scopeOf(ctx.identity).workspaceId, input.taskId, input, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** 任务详情（会话/变更集/围栏留痕） */
  taskDetail: protectedProcedure
    .input(z.object({ taskId: z.string() }))
    .query(async ({ ctx, input }) => {
      return devTaskDetail(scopeOf(ctx.identity).workspaceId, input.taskId);
    }),
  /** 会话事件流（增量轮询） */
  sessionEvents: protectedProcedure
    .input(z.object({ sessionId: z.string(), afterSeq: z.number().int().min(0).default(0) }))
    .query(async ({ ctx, input }) => {
      return devSessionEvents(scopeOf(ctx.identity).workspaceId, input.sessionId, input.afterSeq);
    }),
  /** 版本台账（时间线） */
  releases: protectedProcedure.query(async ({ ctx }) => {
    return devListReleases(scopeOf(ctx.identity).workspaceId);
  }),
});

/**
 * 织伴（LoomMate）贴身小秘书：设置/事件扫描/收件箱/提醒/六层记忆/对话
 * 铁律：不替人决策、不打扰（勿扰+聚合）、不装在线；全部写操作留痕。
 */
const secretaryRouter = router({
  settings: protectedProcedure.query(async ({ ctx }) => {
    return secGetSettings(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo);
  }),
  saveSettings: writeProcedure
    .input(z.object({
      display_name: z.string().max(30).optional(),
      persona_key: z.enum(["tianmei", "yuanqi", "chenwen", "custom"]).optional(),
      persona_custom: z.object({ name: z.string().max(20).optional(), tone: z.string().max(200).optional() }).optional(),
      voice_key: z.enum(["sweet", "bright", "soft", "calm"]).optional(),
      voice_on: z.boolean().optional(),
      widget_size: z.enum(["large", "small"]).optional(),
      quiet_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      quiet_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      channels: z.object({
        im: z.object({ provider: z.string(), target: z.string() }).optional(),
        outbox_urls: z.array(z.string().url()).max(3).optional(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return secSaveSettings(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo, input, { id: ctx.identity.memberNo, type: "human" });
    }),
  /** 事件扫描（客户端 20s 轮询驱动；幂等） */
  scan: protectedProcedure.mutation(async ({ ctx }) => {
    return secScan(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo);
  }),
  inbox: protectedProcedure
    .input(z.object({ unreadOnly: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      return secInbox(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo, input?.unreadOnly ?? false);
    }),
  markInbox: writeProcedure
    .input(z.object({ ids: z.array(z.string()).min(1).max(50), status: z.enum(["read", "acted"]) }))
    .mutation(async ({ ctx, input }) => {
      return secMarkInbox(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo, input.ids, input.status);
    }),
  addReminder: writeProcedure
    .input(z.object({ text: z.string().min(1).max(200), dueAt: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return secAddReminder(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo, input.text, input.dueAt, { id: ctx.identity.memberNo, type: "human" });
    }),
  reminders: protectedProcedure.query(async ({ ctx }) => {
    return secListReminders(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo);
  }),
  memoryPanel: protectedProcedure.query(async ({ ctx }) => {
    return secMemoryPanel(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo);
  }),
  remember: writeProcedure
    .input(z.object({ layer: z.string().optional(), key: z.string().min(1).max(80), content: z.string().min(1).max(500), expiresDays: z.number().int().min(1).max(365).optional() }))
    .mutation(async ({ ctx, input }) => {
      return secRemember(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo, input, { id: ctx.identity.memberNo, type: "human" });
    }),
  forget: writeProcedure
    .input(z.object({ memoryId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return secForget(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo, input.memoryId, { id: ctx.identity.memberNo, type: "human" });
    }),
  chat: writeProcedure
    .input(z.object({ text: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      return secChat(scopeOf(ctx.identity).workspaceId, ctx.identity.memberNo, input.text, { id: ctx.identity.memberNo, type: "human" });
    }),
});

export const serviceRouter = router({
  kb: kbRouter,
  tickets: ticketsRouter,
  stats: statsRouter,
  eval: evalRouter,
  aipm: aipmRouter,
  bundle: bundleRouter,
  devtools: devtoolsRouter,
  secretary: secretaryRouter,
});
