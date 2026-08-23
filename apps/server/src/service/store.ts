/**
 * service · 存储引导（AI 服务前台）
 * 表结构由 packages/db 迁移（并行底座代理）落地：c_users/c_conversations/c_messages/
 * c_notifications/c_tickets/c_ticket_events/kb_collections/kb_documents/kb_chunks/
 * kb_site_sources/demo_orders/demo_members，全部带 RLS（app.workspace_id GUC）。
 * 本模块职责：
 *  - 种子演示数据（幂等：目标表为空才注入；KB 住客须知缺切块则补建）
 *  - Markdown 切块 + 检索索引重建（kb_chunks）
 * 纪律：种子走 owner 池；业务读写一律经 events.ts 的 serviceTx/svcQuery（RLS 事务上下文）。
 */
import { getOwnerPool } from "@workloom/db";

let bootstrapped: Promise<void> | null = null;

/** 幂等引导（每进程一次） */
export function ensureServiceSchema(): Promise<void> {
  if (!bootstrapped) bootstrapped = bootstrap();
  return bootstrapped;
}

interface SqlClient { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

async function bootstrap(): Promise<void> {
  const pool = getOwnerPool();
  const client = await pool.connect();
  try {
    await seedDemo(client as unknown as SqlClient);
  } finally {
    client.release();
  }
}

/** 种子：仅当目标数据缺失时注入（演示数据，幂等） */
async function seedDemo(client: SqlClient): Promise<void> {
  const ws = await client.query(`SELECT id FROM workspaces ORDER BY created_at`);
  for (const row of ws.rows) {
    const wsId = String(row.id);
    // KB 住客须知（文档缺失则建；切块缺失则补）
    let doc = (await client.query(
      `SELECT id, version, content_md FROM kb_documents WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
      [wsId, `kbd-${wsId}-notice`],
    )).rows[0];
    if (!doc) {
      const colId = `kbc-${wsId}-welcome`;
      await client.query(
        `INSERT INTO kb_collections (id, workspace_id, name, description) VALUES ($1,$2,'住客服务知识库','酒店前台常见问题与服务说明（演示种子）') ON CONFLICT (id) DO NOTHING`,
        [colId, wsId],
      );
      const md = [
        `# 云栖酒店住客服务须知`,
        ``,
        `## 退房时间`,
        `本店标准退房时间为每日中午 12:00 前。如需延迟退房，最晚可延至 14:00，视当日房态免费安排；超过 14:00 按半天房费计。`,
        ``,
        `## 早餐时间`,
        `自助早餐供应时间为每日 7:00 至 10:00，地点在一楼全日制餐厅，住客凭房卡用餐。`,
        ``,
        `## Wi-Fi`,
        `客房与公共区域均覆盖免费 Wi-Fi，网络名 Yunqi-Hotel，密码为房间号后四位。`,
        ``,
        `## 报修与服务`,
        `客房设施故障或服务需求，请直接在本小程序留言，客服将在 15 分钟内响应并生成工单跟进。`,
      ].join("\n");
      await client.query(
        `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, content_md, status)
         VALUES ($1,$2,$3,'云栖酒店住客服务须知','manual',$4,'active') ON CONFLICT (id) DO NOTHING`,
        [`kbd-${wsId}-notice`, wsId, colId, md],
      );
      doc = (await client.query(
        `SELECT id, version, content_md FROM kb_documents WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
        [wsId, `kbd-${wsId}-notice`],
      )).rows[0];
    }
    if (doc) {
      const chunks = await client.query(
        `SELECT 1 FROM kb_chunks WHERE workspace_id=$1 AND document_id=$2 LIMIT 1`,
        [wsId, String(doc.id)],
      );
      if (chunks.rows.length === 0) {
        await indexChunks(client, wsId, String(doc.id), String(doc.content_md));
      }
    }
    // 酒店演示会员/订单
    const dmEmpty = await client.query(`SELECT 1 FROM demo_members WHERE workspace_id=$1 LIMIT 1`, [wsId]);
    if (dmEmpty.rows.length === 0) {
      await client.query(
        `INSERT INTO demo_members (member_id, workspace_id, name, phone, tier, points) VALUES
           ('M-1001',$1,'张伟','13800000001','金卡',2680),
           ('M-1002',$1,'刘芳','13800000002','银卡',860)
         ON CONFLICT (member_id) DO NOTHING`,
        [wsId],
      );
      await client.query(
        `INSERT INTO demo_orders (order_id, workspace_id, member_id, room_type, check_in, check_out, amount_fen, status) VALUES
           ('O-20260820-001',$1,'M-1001','豪华大床房','2026-08-21','2026-08-23',117600,'已确认'),
           ('O-20260818-002',$1,'M-1001','行政双床房','2026-08-18','2026-08-19',68800,'已完成'),
           ('O-20260822-003',$1,'M-1002','山景大床房','2026-08-25','2026-08-26',52800,'已确认')
         ON CONFLICT (order_id) DO NOTHING`,
        [wsId],
      );
    }
  }
}

/** Markdown 切块：按二级标题分段（无标题则整体一块），供检索命中引用 */
export function splitChunks(md: string): Array<{ heading: string; content: string }> {
  const lines = md.split("\n");
  const chunks: Array<{ heading: string; content: string }> = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const content = buf.join("\n").trim();
    // 剔除纯标题空块（去掉 # 行后无正文），避免检索误命中空答案
    const body = content.replace(/^#+\s.*$/gm, "").trim();
    if (body) chunks.push({ heading, content: content.slice(0, 2000) });
    buf = [];
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.replace(/^##\s+/, "").trim();
    } else if (line.startsWith("# ")) {
      flush();
      heading = "";
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

/** 重建某文档的切块索引（同事务内调用；embedding/keywords 由底座向量化管线补，本层留空） */
export async function indexChunks(
  client: SqlClient,
  workspaceId: string,
  documentId: string,
  contentMd: string,
): Promise<number> {
  await client.query(`DELETE FROM kb_chunks WHERE workspace_id=$1 AND document_id=$2`, [workspaceId, documentId]);
  const chunks = splitChunks(contentMd);
  for (let i = 0; i < chunks.length; i++) {
    await client.query(
      `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content)
       VALUES ($1,$2,$3,$4,$5)`,
      [workspaceId, documentId, i, chunks[i]!.heading, chunks[i]!.content],
    );
  }
  return chunks.length;
}
