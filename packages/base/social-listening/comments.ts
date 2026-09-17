/**
 * social-listening · 评论采集与 G10 三级分流（fusion-design §3 G10 / §4 account-ops 管线）
 *
 * 链路：评论采集 → 意图分类（LLM 走注入的 model-router 接口，规则兜底）→ G10 三级分流
 *      （夸赞/感谢 auto；咨询/售后 review；负面/危机 review+告警；敏感词 block）
 *      → 候选回复生成 → 外发回执（comment_replies.receipt + 事件 receipt 位，L3.6/E3.7）
 * 纪律：一切写入经 workdata 安全网关落五元事件（D16：业务行与事件同一 COMMIT）；
 *      敏感词命中恒 block（优先级高于一切意图，不可降级）。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import type { FenceLevel } from "../fence-engine/judge.js";

interface Scope { tenantId: string; workspaceId: string }

export const COMMENT_INTENTS = ["praise", "query", "complaint", "crisis", "other"] as const;
export type CommentIntent = (typeof COMMENT_INTENTS)[number];

export interface CommentRow {
  id: string;
  workspace_id: string;
  platform: string;
  account_id: string;
  video_id: string | null;
  platform_comment_id: string | null;
  author: string | null;
  text: string;
  intent: CommentIntent | null;
  route_level: FenceLevel | null;
  status: "new" | "pending_review" | "replied" | "blocked" | "manual";
  collected_at: string;
}

/* ---------- G10 分流矩阵（纯函数，唯一事实源） ---------- */

export interface RouteDecision {
  level: FenceLevel;
  /** 危机/敏感词附带告警（写 comment.crisis_alert 事件） */
  alert: boolean;
  reason: string;
}

/**
 * G10 三级分流（§3 门矩阵逐字口径）：
 * 夸赞/感谢 auto；咨询/售后 review；负面 review；危机 review+告警；敏感词 block；
 * 未识别意图默认 review（宁可错挂不错放）。
 */
export function routeComment(intent: CommentIntent, text: string, sensitiveWords: string[] = []): RouteDecision {
  const hit = sensitiveWords.find((w) => w.length > 0 && text.includes(w));
  if (hit) return { level: "block", alert: true, reason: `命中敏感词（G10 block，优先级最高不可降级）` };
  switch (intent) {
    case "praise": return { level: "auto", alert: false, reason: "夸赞/感谢自动回（G10）" };
    case "query": return { level: "review", alert: false, reason: "咨询/售后转人工审批（G10）" };
    case "complaint": return { level: "review", alert: false, reason: "负面审批（G10）" };
    case "crisis": return { level: "review", alert: true, reason: "危机审批+告警（G10）" };
    default: return { level: "review", alert: false, reason: "意图未识别默认 review（宁可错挂，G10）" };
  }
}

/* ---------- 意图分类（LLM 注入 + 规则兜底） ---------- */

/**
 * LLM 意图分类 seam：由 model-router 供给（route() 装配后注入）。
 * 返回 null = 模型不可用/输出非法 → 规则兜底（禁止伪造分类，同 E1.6 降级纪律）。
 */
export interface IntentClassifier {
  classify(text: string): Promise<CommentIntent | null>;
}

/** 规则兜底分类器（确定性；关键词命中即归类，全不中 → other → 分流默认 review） */
export function classifyByRules(text: string): CommentIntent {
  if (/曝光|维权|媒体|12315|315|消协|起诉/.test(text)) return "crisis";
  if (/差|垃圾|难用|退[款货]|投诉|踩雷|失望/.test(text)) return "complaint";
  if (/怎么|如何|多少|哪里|链接|教程|[？?]/.test(text)) return "query";
  if (/好看|赞|喜欢|感谢|爱了|牛|棒|种草/.test(text)) return "praise";
  return "other";
}

/** 分类入口：LLM 优先，null/异常 → 规则兜底（留 source 供留痕） */
export async function classifyIntent(
  text: string,
  classifier?: IntentClassifier,
): Promise<{ intent: CommentIntent; source: "llm" | "rules" }> {
  if (classifier) {
    try {
      const intent = await classifier.classify(text);
      if (intent && (COMMENT_INTENTS as readonly string[]).includes(intent)) {
        return { intent, source: "llm" };
      }
    } catch {
      // 模型异常 → 规则兜底（降级不伪造）
    }
  }
  return { intent: classifyByRules(text), source: "rules" };
}

/* ---------- 候选回复与外发 seam ---------- */

/** 候选回复生成 seam（model-router 供给；未注入用兜底模板） */
export interface ReplyGenerator {
  generate(comment: CommentRow): Promise<string>;
}

/** 外发通道 seam（RPA/开放平台；回执必须含 synced 证据，无回执=未核实 L3.6） */
export interface ReplySender {
  send(comment: CommentRow, text: string): Promise<{ synced: boolean; receiptId?: string; evidenceUri?: string }>;
}

/** 兜底候选回复（生成器未注入/失败时的保守话术；auto 级也可用，审批级仅作草稿） */
export function fallbackReply(comment: CommentRow): string {
  return comment.intent === "praise"
    ? "感谢喜欢与支持，我们会持续带来更好的内容～"
    : "您好，留言已收到，我们会尽快核实并回复您。";
}

/* ---------- 采集与处理 ---------- */

/** 事务内事件留痕（D16：调用方持有事务，与评论/回复行同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  objectType: string,
  objectId: string,
  decision: Record<string, unknown>,
  opts: { receipt?: { synced: boolean; snapshot_uri?: string; verified_at?: string } } = {},
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: "comment-operator", type: "system" },
  }, {
    who: { type: "system", id: "comment-operator" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: objectType, id: objectId },
    decision: decision as never,
    rule_impact: [],
    receipt: opts.receipt,
  });
  return r.eventId;
}

/** 评论采集落账（UNIQUE 平台评论 ID 幂等，L1.4 同源；account-ops：评论采集每 30min） */
export async function ingestComments(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  items: Array<{
    id: string;
    platform: string;
    accountId: string;
    videoId?: string;
    platformCommentId?: string;
    author?: string;
    text: string;
  }>,
): Promise<number> {
  if (items.length === 0) return 0;
  const client = await app.connect();
  let inserted = 0;
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    for (const c of items) {
      const r = await client.query(
        `INSERT INTO comments (id, workspace_id, platform, account_id, video_id, platform_comment_id, author, text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (workspace_id, platform, platform_comment_id) DO NOTHING`,
        [c.id, scope.workspaceId, c.platform, c.accountId, c.videoId ?? null, c.platformCommentId ?? null, c.author ?? null, c.text],
      );
      inserted += r.rowCount ?? 0;
    }
    // D16（#1/A）：评论行与采集事件同一事务同一 COMMIT
    await emitInTx(client, scope, "comments", scope.workspaceId, {
      action: "comments.collected",
      after: { received: items.length, inserted },
      basis: ["评论采集落账（平台评论 ID 幂等去重）"],
    });
    await client.query("COMMIT");
    return inserted;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ProcessDeps {
  classifier?: IntentClassifier;
  generator?: ReplyGenerator;
  sender?: ReplySender;
  /** 敏感词表（G10 block 级；行业包/工作区配置供给，默认空） */
  sensitiveWords?: string[];
}

export interface ProcessResult {
  commentId: string;
  intent: CommentIntent;
  classifySource: "llm" | "rules";
  decision: RouteDecision;
  replyId?: string;
}

/**
 * 处理单条评论：分类 → G10 分流 → 候选回复 → （auto 外发带回收执 / review 挂起 / block 熔断）
 * 幂等：非 new 状态直接返回现状（重复派遣不重复外发）。
 */
export async function processComment(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  commentId: string,
  deps: ProcessDeps = {},
): Promise<ProcessResult | null> {
  /* ---- 读取 + 分类 + 分流（纯计算段，先拿行） ---- */
  let comment: CommentRow | null = null;
  {
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const r = await client.query<CommentRow>(
        `SELECT * FROM comments WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, commentId],
      );
      comment = r.rows[0] ?? null;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  if (!comment) return null;
  if (comment.status !== "new") {
    return {
      commentId,
      intent: comment.intent ?? "other",
      classifySource: "rules",
      decision: { level: comment.route_level ?? "review", alert: false, reason: "已处理，幂等返回" },
    };
  }

  const { intent, source } = await classifyIntent(comment.text, deps.classifier);
  const decision = routeComment(intent, comment.text, deps.sensitiveWords ?? []);

  /* ---- 候选回复（review/auto 都需要；block 不生成） ---- */
  let candidate: string | null = null;
  if (decision.level !== "block") {
    try {
      candidate = deps.generator ? await deps.generator.generate(comment) : fallbackReply({ ...comment, intent });
    } catch {
      candidate = fallbackReply({ ...comment, intent }); // 生成失败 → 兜底模板（降级不伪造）
    }
  }

  /* ---- auto 级外发（须 sender 注入；未注入按 review 挂起，不静默丢弃） ---- */
  let receipt: { synced: boolean; receiptId?: string; evidenceUri?: string } | null = null;
  let sendFailed: string | null = null;
  if (decision.level === "auto" && candidate !== null && deps.sender) {
    try {
      receipt = await deps.sender.send({ ...comment, intent }, candidate);
    } catch (err) {
      sendFailed = err instanceof Error ? err.message : String(err); // 外发失败 → 转人工
    }
  }
  const effective: RouteDecision = decision.level === "auto" && (!deps.sender || sendFailed)
    ? { level: "review", alert: decision.alert, reason: sendFailed ? `外发失败转人工：${sendFailed}` : "外发通道未注入，auto 降级 review 挂起（不静默丢弃）" }
    : decision;

  /* ---- 落库 + 留痕（同一 COMMIT） ---- */
  const status = effective.level === "block" ? "blocked"
    : effective.level === "review" ? "pending_review"
    : receipt?.synced ? "replied" : "manual";
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    await client.query(
      `UPDATE comments SET intent=$3, route_level=$4, status=$5 WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, commentId, intent, effective.level, status],
    );
    let replyId: string | undefined;
    if (candidate !== null) {
      replyId = `${commentId}-reply-1`;
      await client.query(
        `INSERT INTO comment_replies (id, workspace_id, comment_id, text, channel, status, receipt, created_by)
         VALUES ($1,$2,$3,$4,'rpa',$5,$6,'comment-operator')`,
        [
          replyId, scope.workspaceId, commentId, candidate,
          status === "replied" ? "sent" : "candidate",
          receipt ? JSON.stringify(receipt) : null,
        ],
      );
    }
    const action = effective.level === "block" ? "comment.blocked"
      : effective.level === "review" ? "comment.reply_review"
      : "comment.replied";
    const eventId = await emitInTx(client, scope, "comment_reply", commentId, {
      action,
      after: {
        commentId, intent, classifySource: source, routeLevel: effective.level,
        alert: effective.alert, reason: effective.reason, replyId: replyId ?? null,
        candidate: candidate ?? null, sendFailed,
      },
      basis: [effective.reason],
    }, receipt ? { receipt: { synced: receipt.synced, snapshot_uri: receipt.evidenceUri, verified_at: new Date().toISOString() } } : {});
    // 危机/敏感词附带告警事件（G10：review+alert / block+alert）
    if (effective.alert) {
      await emitInTx(client, scope, "comment_reply", commentId, {
        action: "comment.crisis_alert",
        after: { commentId, intent, routeLevel: effective.level, level: "p1", linkedEvent: eventId },
        basis: ["危机/敏感评论告警（G10：告警与分流同事务留痕）"],
      });
    }
    await client.query("COMMIT");
    return { commentId, intent, classifySource: source, decision: effective, replyId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
