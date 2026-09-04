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
  getSettings as evalGetSettings, latestReport as evalLatestReport,
  listAnswers as evalListAnswers, listExams as evalListExams,
  listQuestions as evalListQuestions, runExam as evalRunExam,
  seedQuestionsIfEmpty as evalSeedQuestions, setPromotionGate as evalSetPromotionGate,
} from "./eval.js";

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

export const serviceRouter = router({
  kb: kbRouter,
  tickets: ticketsRouter,
  stats: statsRouter,
  eval: evalRouter,
});
