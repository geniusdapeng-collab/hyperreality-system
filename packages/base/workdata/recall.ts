/**
 * workdata · 事件检索（B2）：结构化过滤 + NL 入口薄自译（F1.3/E1.6）
 *
 * 口径：
 *  - 结构化检索走既有索引（idx_events_object / idx_events_action / idx_events_rule GIN /
 *    idx_events_ws_time），G1「P95 ≤3s」开发期落实机制而非数字（总纲 §6）
 *  - NL 入口：LLM 把自然语言翻译成结构化过滤器（薄自译，D7；WrenAI 停车场）
 *    翻译结果过 zod 白名单 schema——LLM 只能产出过滤器，永远接触不到 SQL（注入面归零）
 *  - 超时/失败降级（E1.6）：NL 翻译 >3s 或失败 → 返回 null，前端回落结构化表单，禁止伪造结果
 *  - 越权返回空（L7.1）：RLS + 强制 workspace 范围双保险
 */
import type pg from "pg";
import type { BusinessEvent } from "@workloom/shared";

/* ================= 结构化过滤器（白名单 schema） ================= */

export interface EventFilter {
  /** 对象类型（内置默认枚举口径；行业对象型由 bundle 扩展） */
  objectType?: string;
  objectId?: string;
  /** 决策动作（price.adjust 等） */
  action?: string;
  /** 操作者（who.id） */
  actor?: string;
  actorType?: "human" | "agent" | "system";
  /** 命中规则与判定结果 */
  ruleId?: string;
  ruleResult?: "pass" | "review" | "blocked" | "conflict";
  /** 时间范围（ISO） */
  from?: string;
  to?: string;
  /** 线程 */
  sessionId?: string;
  /** 全文片段（payload 文本包含；演示规模下 ILIKE，搜索引擎进停车场） */
  text?: string;
}

export interface SearchPage {
  events: BusinessEvent[];
  /** 下一页游标（seq；本页不满即无下一页） */
  nextCursor: string | null;
  total: number;
}

/** 防注入底线：过滤值只允许安全字符（值本身仍走参数化，双保险）
 *  #36 修复：白名单补 `+`——ISO 时间带时区偏移（如 2026-08-20T00:00:00+08:00）
 *  此前被误拒，from/to 时间检索在东八区时区格式下不可用 */
const SAFE_VALUE = /^[\w.\-:*+\u4e00-\u9fa5 ]{1,80}$/u;

function assertSafe(v: string, field: string): void {
  if (!SAFE_VALUE.test(v)) throw new Error(`检索字段 ${field} 含非法字符`);
}

/** 过滤器 → 参数化 WHERE（纯函数，可单测；返回 sql 片段与参数） */
export function buildWhere(
  filter: EventFilter,
  scope: { tenantId: string; workspaceId: string },
  cursor?: string,
): { sql: string; params: unknown[] } {
  const clauses: string[] = ["tenant_id = $1", "workspace_id = $2"];
  const params: unknown[] = [scope.tenantId, scope.workspaceId];
  const add = (clause: string, value: unknown, field: string) => {
    if (typeof value === "string") assertSafe(value, field);
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  };

  if (filter.objectType) add(`payload->'object'->>'type' = ?`, filter.objectType, "objectType");
  if (filter.objectId) add(`payload->'object'->>'id' = ?`, filter.objectId, "objectId");
  if (filter.action) add(`payload->'decision'->>'action' = ?`, filter.action, "action");
  if (filter.actor) add(`payload->'who'->>'id' = ?`, filter.actor, "actor");
  if (filter.actorType) add(`payload->'who'->>'type' = ?`, filter.actorType, "actorType");
  if (filter.ruleId) add(`payload->'rule_impact' @> jsonb_build_array(jsonb_build_object('rule_id', ?::text))`, filter.ruleId, "ruleId");
  if (filter.ruleResult) add(`payload->'rule_impact' @> jsonb_build_array(jsonb_build_object('result', ?::text))`, filter.ruleResult, "ruleResult");
  if (filter.from) add(`created_at >= ?::timestamptz`, filter.from, "from");
  if (filter.to) add(`created_at <= ?::timestamptz`, filter.to, "to");
  if (filter.sessionId) add(`session_id = ?`, filter.sessionId, "sessionId");
  if (filter.text) add(`payload::text ILIKE '%' || ?::text || '%'`, filter.text, "text");
  if (cursor) add(`seq < ?::bigint`, cursor, "cursor");

  return { sql: clauses.join(" AND "), params };
}

/** 结构化检索（读侧：workloom_app 角色即可，biz_events SELECT 已授权） */
export async function searchEvents(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  filter: EventFilter,
  opts: { limit?: number; cursor?: string } = {},
): Promise<SearchPage> {
  const limit = Math.min(opts.limit ?? 50, 200); // 机制默认值（演示规模）；G1 达标依赖索引覆盖
  const { sql, params } = buildWhere(filter, scope, opts.cursor);
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const rows = await client.query<{ seq: string; payload: BusinessEvent }>(
      `SELECT seq, payload FROM biz_events WHERE ${sql} ORDER BY seq DESC LIMIT ${limit + 1}`,
      params,
    );
    const count = await client.query<{ c: string }>(
      `SELECT count(*) AS c FROM biz_events WHERE ${sql.replace(/ AND seq < \$\d+::bigint/, "")}`,
      params.slice(0, opts.cursor ? -1 : undefined),
    );
    await client.query("COMMIT");
    const hasMore = rows.rows.length > limit;
    const pageRows = hasMore ? rows.rows.slice(0, limit) : rows.rows;
    return {
      events: pageRows.map((r) => r.payload),
      nextCursor: hasMore ? String(pageRows[pageRows.length - 1]!.seq) : null,
      total: Number(count.rows[0]?.c ?? 0),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= NL 入口（薄自译 + 超时降级） ================= */

/** NL 翻译器接口（B7 model-router 接管真实路由；此处为 seam 定义 + 两个实现） */
export interface NlTranslator {
  translate(query: string, scope: { tenantId: string; workspaceId: string }): Promise<EventFilter>;
}

/** NL 翻译超时（E1.6 降级口径，与 P1 意图路由同机制：>3s 放弃 NL，回落表单） */
export const NL_TRANSLATE_TIMEOUT_MS = 3_000;

/**
 * Mock 翻译器（D4：无 Key 可演示全流程）。
 * 规则直译演示剧本高频问法；零外部依赖、确定性输出。
 */
export class MockNlTranslator implements NlTranslator {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async translate(query: string, _scope?: { tenantId: string; workspaceId: string }): Promise<EventFilter> {
    const f: EventFilter = {};
    // 对象类型直译（内置默认枚举口径）
    if (/差评|评价/.test(query)) f.objectType = "review";
    else if (/房价|售价|调价|价格/.test(query)) f.objectType = "room_price";
    else if (/订单|退款|对账/.test(query)) f.objectType = "order";
    else if (/内容|首图|文案/.test(query)) f.objectType = "content";
    else if (/渠道/.test(query)) f.objectType = "channel";
    // 动作直译
    if (/退款/.test(query)) f.action = "order.refund";
    else if (/调价/.test(query)) f.action = "price.adjust";
    else if (/回复/.test(query)) f.action = "review.reply";
    // 规则与结果直译
    const rm = query.match(/R[1-6]/);
    if (rm) f.ruleId = rm[0];
    if (/熔断|被拦|block/i.test(query)) f.ruleResult = "blocked";
    else if (/待审|挂起|审批/.test(query)) f.ruleResult = "review";
    // 时间直译（演示剧本：昨天/今天/夜班窗口）
    const now = new Date();
    if (/昨天/.test(query)) {
      const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0);
      const e = new Date(d); e.setHours(23, 59, 59, 999);
      f.from = d.toISOString(); f.to = e.toISOString();
    } else if (/夜班|昨夜/.test(query)) {
      const s = new Date(now); s.setDate(s.getDate() - 1); s.setHours(22, 0, 0, 0);
      const e = new Date(now); e.setHours(8, 30, 0, 0);
      f.from = s.toISOString(); f.to = e.toISOString();
    }
    return f;
  }
}

/** OpenAI 兼容翻译器（有 Key 时启用；输出受 EventFilter 白名单约束） */
export class OpenAiNlTranslator implements NlTranslator {
  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; model: string },
  ) {}

  async translate(query: string): Promise<EventFilter> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是检索翻译器。把用户自然语言翻译成事件检索过滤器 JSON，只允许这些键：" +
              "objectType, objectId, action, actor, actorType(human|agent|system), " +
              "ruleId(R1-R6), ruleResult(pass|review|blocked|conflict), from, to(ISO 时间), sessionId, text。" +
              "不确定的键不要产出。只输出 JSON。",
          },
          { role: "user", content: query },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM 翻译失败：HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // 白名单收敛：只认 EventFilter 键，值类型强校验（LLM 输出不可信）
    const allowed = ["objectType", "objectId", "action", "actor", "actorType", "ruleId", "ruleResult", "from", "to", "sessionId", "text"];
    const filter: EventFilter = {};
    for (const k of allowed) {
      const v = parsed[k];
      if (typeof v === "string" && v.length > 0) (filter as Record<string, unknown>)[k] = v;
    }
    return filter;
  }
}

/**
 * NL 检索入口：翻译（带超时降级）→ 结构化检索
 * 降级语义（E1.6）：翻译超时/失败 → { degraded: true, page: null }，调用方展示结构化表单
 */
export async function nlSearchEvents(
  app: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  query: string,
  translator: NlTranslator,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<{ degraded: boolean; filter?: EventFilter; page: SearchPage | null }> {
  const timeoutMs = opts.timeoutMs ?? NL_TRANSLATE_TIMEOUT_MS;
  let filter: EventFilter;
  try {
    filter = await Promise.race([
      translator.translate(query, scope),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("NL 翻译超时")), timeoutMs),
      ),
    ]);
  } catch {
    return { degraded: true, page: null };
  }
  const page = await searchEvents(app, scope, filter, { limit: opts.limit });
  return { degraded: false, filter, page };
}
