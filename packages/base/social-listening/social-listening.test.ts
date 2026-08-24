/**
 * social-listening 测试（内存 mock DB，不依赖真实 Postgres）：
 * G10 分流矩阵——夸赞 auto / 咨询 review / 危机 review+alert / 敏感词 block（优先级最高）
 * 另覆盖：规则兜底分类、采集幂等、外发回执落事件 receipt 位
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  classifyByRules,
  ingestComments,
  processComment,
  routeComment,
  type CommentIntent,
  type CommentRow,
  type IntentClassifier,
  type ReplySender,
} from "./comments.js";

/* ================= 内存 mock DB ================= */

type Row = Record<string, any>;

class MockDb {
  comments: Row[] = [];
  replies: Row[] = [];
  events: Array<{ seq: number; event_id: string; hash: string; payload: any }> = [];
  private seq = 8800;

  query(sql: string, params: any[] = []): { rows: Row[]; rowCount: number } {
    const s = sql.replace(/\s+/g, " ").trim();
    const ok = { rows: [], rowCount: 0 };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return ok;
    if (s.includes("set_config") || s.includes("pg_advisory")) return ok;

    // ---- biz_events（workdata events.ts 写入段） ----
    if (/FROM biz_events WHERE tenant_id = \$1 AND event_id = \$2/.test(s)) {
      const e = this.events.find((x) => x.event_id === params[1]);
      return { rows: e ? [{ seq: String(e.seq), hash: e.hash }] : [], rowCount: e ? 1 : 0 };
    }
    if (/FROM biz_events WHERE tenant_id = \$1( AND workspace_id = \$\d+)? ORDER BY seq DESC/.test(s)) {
      const tail = this.events[this.events.length - 1];
      return { rows: tail ? [{ seq: String(tail.seq), hash: tail.hash }] : [], rowCount: tail ? 1 : 0 };
    }
        // P0-3 契约：event_id 由全局序列分配——mock nextval 返回递增计数
    if (/nextval\('biz_events_eid_seq'\)/.test(s)) {
      this._eidSeq = (this._eidSeq ?? 9100) + 1;
      return { rows: [{ v: String(this._eidSeq) }], rowCount: 1 };
    }
if (s.includes("append_event_insert")) {
      const seq = ++this.seq;
      this.events.push({ seq, event_id: params[0], hash: params[6], payload: JSON.parse(params[4]) });
      return { rows: [{ seq: String(seq), inserted: true }], rowCount: 1 };
    }

    // ---- comments ----
    if (/INSERT INTO comments/.test(s)) {
      const dup = this.comments.find(
        (x) => x.workspace_id === params[1] && x.platform === params[2] && x.platform_comment_id === params[5],
      );
      if (dup) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
      const row: Row = {
        id: params[0], workspace_id: params[1], platform: params[2], account_id: params[3],
        video_id: params[4], platform_comment_id: params[5], author: params[6], text: params[7],
        intent: null, route_level: null, status: "new", collected_at: new Date().toISOString(),
      };
      this.comments.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE comments SET intent=\$3/.test(s)) {
      const row = this.comments.find((x) => x.workspace_id === params[0] && x.id === params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      row.intent = params[2];
      row.route_level = params[3];
      row.status = params[4];
      return { rows: [], rowCount: 1 };
    }
    if (/FROM comments WHERE workspace_id=\$1 AND id=\$2/.test(s)) {
      const rows = this.comments.filter((x) => x.workspace_id === params[0] && x.id === params[1]);
      return { rows, rowCount: rows.length };
    }

    // ---- comment_replies ----
    if (/INSERT INTO comment_replies/.test(s)) {
      const row: Row = {
        id: params[0], workspace_id: params[1], comment_id: params[2], text: params[3],
        channel: "rpa", status: params[4], receipt: params[5] ? JSON.parse(params[5]) : null,
        created_by: "comment-operator", created_at: new Date().toISOString(),
      };
      this.replies.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // ---- 事件号源函数（D29：appendEventInTx 号尾查询，SECURITY DEFINER 全租户口径） ----
    if (/biz_events_max_event_no/.test(s)) {
      return { rows: [{ n: "9900" }], rowCount: 1 };
    }

    throw new Error(`mock 未覆盖 SQL: ${s}`);
  }
}

function poolOf(db: MockDb): pg.Pool {
  const client = {
    query: (sql: string, p?: any[]) => Promise.resolve(db.query(sql, p)),
    release: () => undefined,
  };
  return { connect: async () => client, query: client.query } as unknown as pg.Pool;
}

/* ================= 夹具 ================= */

const scope = { tenantId: "tenant-demo", workspaceId: "ws-video" };

function fixture(text: string, id = "cm-1") {
  const db = new MockDb();
  db.comments.push({
    id, workspace_id: scope.workspaceId, platform: "douyin", account_id: "acc-1",
    video_id: "v-1", platform_comment_id: `pc-${id}`, author: "user-x", text,
    intent: null, route_level: null, status: "new", collected_at: new Date().toISOString(),
  });
  return { db, app: poolOf(db), gateway: poolOf(db) };
}

const classifierOf = (intent: CommentIntent | null): IntentClassifier => ({
  classify: () => Promise.resolve(intent),
});

class FakeSender implements ReplySender {
  sent: Array<{ text: string }> = [];
  send(_c: CommentRow, text: string) {
    this.sent.push({ text });
    return Promise.resolve({ synced: true, receiptId: "rc-1", evidenceUri: "rpa-evidence://reply/1" });
  }
}

/* ================= G10 分流矩阵 ================= */

describe("G10 三级分流矩阵", () => {
  it("分流矩阵纯函数：夸赞 auto / 咨询 review / 负面 review / 危机 review+alert / 敏感词 block", () => {
    expect(routeComment("praise", "太好看了").level).toBe("auto");
    expect(routeComment("query", "多少钱").level).toBe("review");
    expect(routeComment("complaint", "质量差").level).toBe("review");
    const crisis = routeComment("crisis", "我要曝光你们");
    expect(crisis.level).toBe("review");
    expect(crisis.alert).toBe(true);
    const blocked = routeComment("praise", "包含违禁词的夸赞", ["违禁词"]);
    expect(blocked.level).toBe("block"); // 敏感词优先级高于意图
    expect(blocked.alert).toBe(true);
    expect(routeComment("other", "嗯").level).toBe("review"); // 未识别默认 review（宁可错挂）
  });

  it("夸赞（LLM praise）→ auto：候选回复外发 + 回执落事件 receipt 位 + 状态 replied", async () => {
    const { db, app, gateway } = fixture("这个也太好看了吧，已下单");
    const sender = new FakeSender();
    const r = await processComment(app, gateway, scope, "cm-1", {
      classifier: classifierOf("praise"), sender,
    });
    expect(r!.decision.level).toBe("auto");
    expect(r!.classifySource).toBe("llm");
    expect(sender.sent.length).toBe(1);
    expect(db.comments[0]!.status).toBe("replied");
    expect(db.replies[0]!.status).toBe("sent");
    expect(db.replies[0]!.receipt).toMatchObject({ synced: true });
    const ev = db.events.find((e) => e.payload.decision.action === "comment.replied")!;
    expect(ev.payload.receipt).toMatchObject({ synced: true });
    expect(db.events.some((e) => e.payload.decision.action === "comment.crisis_alert")).toBe(false);
  });

  it("咨询（LLM query）→ review：生成候选回复挂起待审，不外发", async () => {
    const { db, app, gateway } = fixture("这个多少钱？怎么买");
    const sender = new FakeSender();
    const r = await processComment(app, gateway, scope, "cm-1", {
      classifier: classifierOf("query"), sender,
    });
    expect(r!.decision.level).toBe("review");
    expect(r!.decision.alert).toBe(false);
    expect(sender.sent.length).toBe(0); // 审批前不外发
    expect(db.comments[0]!.status).toBe("pending_review");
    expect(db.replies[0]!.status).toBe("candidate"); // 候选回复已生成
    expect(db.events.some((e) => e.payload.decision.action === "comment.reply_review")).toBe(true);
  });

  it("危机（LLM crisis）→ review + alert：挂起待审且写 comment.crisis_alert 告警事件", async () => {
    const { db, app, gateway } = fixture("我要找媒体曝光你们");
    const r = await processComment(app, gateway, scope, "cm-1", {
      classifier: classifierOf("crisis"), sender: new FakeSender(),
    });
    expect(r!.decision.level).toBe("review");
    expect(r!.decision.alert).toBe(true);
    expect(db.comments[0]!.status).toBe("pending_review");
    const alert = db.events.find((e) => e.payload.decision.action === "comment.crisis_alert")!;
    expect(alert.payload.decision.after.level).toBe("p1");
  });

  it("敏感词 → block：即使 LLM 判 praise 也熔断，不生成候选回复不外发 + 告警", async () => {
    const { db, app, gateway } = fixture("太赞了，顺便说说违禁词");
    const sender = new FakeSender();
    const r = await processComment(app, gateway, scope, "cm-1", {
      classifier: classifierOf("praise"), sender, sensitiveWords: ["违禁词"],
    });
    expect(r!.decision.level).toBe("block");
    expect(sender.sent.length).toBe(0);
    expect(db.comments[0]!.status).toBe("blocked");
    expect(db.replies.length).toBe(0); // block 不生成候选回复
    expect(db.events.some((e) => e.payload.decision.action === "comment.blocked")).toBe(true);
    expect(db.events.some((e) => e.payload.decision.action === "comment.crisis_alert")).toBe(true);
  });
});

describe("意图分类与采集", () => {
  it("LLM 不可用（返回 null）→ 规则兜底：疑问句归 query → review", async () => {
    const { db, app, gateway } = fixture("这个怎么使用？");
    const r = await processComment(app, gateway, scope, "cm-1", { classifier: classifierOf(null) });
    expect(r!.intent).toBe("query");
    expect(r!.classifySource).toBe("rules");
    expect(r!.decision.level).toBe("review");
    expect(db.comments[0]!.intent).toBe("query");
  });

  it("规则兜底关键词：危机/负面/夸赞/其他", () => {
    expect(classifyByRules("我要向 12315 投诉维权")).toBe("crisis");
    expect(classifyByRules("质量太差，要求退款")).toBe("complaint");
    expect(classifyByRules("在哪里买？求链接")).toBe("query");
    expect(classifyByRules("太好看了，种草了")).toBe("praise");
    expect(classifyByRules("哦")).toBe("other");
  });

  it("采集幂等：同平台评论 ID 重复采集丢弃不报错（L1.4 同源）", async () => {
    const { db, app, gateway } = fixture("占位");
    db.comments.length = 0;
    const items = [
      { id: "cm-a", platform: "douyin", accountId: "acc-1", platformCommentId: "pc-1", text: "好看" },
      { id: "cm-b", platform: "douyin", accountId: "acc-1", platformCommentId: "pc-1", text: "好看（重复）" },
      { id: "cm-c", platform: "douyin", accountId: "acc-1", platformCommentId: "pc-2", text: "多少钱" },
    ];
    const first = await ingestComments(app, gateway, scope, items);
    expect(first).toBe(2); // 同 platform_comment_id 去重
    const second = await ingestComments(app, gateway, scope, items);
    expect(second).toBe(0); // 重复采集全部幂等丢弃
    expect(db.comments.length).toBe(2);
    expect(db.events.filter((e) => e.payload.decision.action === "comments.collected").length).toBe(2);
  });
});
