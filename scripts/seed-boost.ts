/**
 * scripts/seed-boost.ts · 视频内容工厂全管线运行态增强包（客群：品牌电商/连锁商家）（SALES-DEMO）
 * 用法：pnpm db:seed:boost（幂等：事件存在即跳过、审批同 ID 跳过）
 */
import pg from "pg";
import { eventHash, safeParseReplayAwareEvent } from "@workloom/base/workdata";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/hyperreality";
const GATEWAY_URL = process.env.DATABASE_GATEWAY_URL ?? "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/hyperreality";
const TENANT_ID = "tenant-demo";
const WS_ID = "ws-video";
const WS_NAME = "星芒好物";
const FENCE_VERSION = "ai-video-baseline/v2";
const GENESIS_HASH = "GENESIS";

const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const who = (id: string, version = "v3.0") => ({ type: "agent" as const, id, version });
const ctx = (time: string) => ({ tenant_id: TENANT_ID, workspace_id: WS_ID, time, stage: "stable", store: WS_NAME });
const mt = { model_id: "mock-001", tier: "standard", window: "peak", credits: 1 };
const receipt = (time: string) => ({ synced: true, snapshot_uri: "data/snapshots/boost.png", verified_at: time });
const ri = (rule_id: string, result = "pass") => [{ rule_id, version: FENCE_VERSION, result }];

const EVENTS: unknown[] = [
  { event_id: "E-SEED-BT-0301", who: who("script-writer"), context: ctx(at(2800)), object: { type: "content", id: "sc-331", label: "脚本起草 ×3" },
    decision: { action: "script.draft", after: {"scripts": ["保温杯焖烧实测", "通勤包 21 个口袋", "办公室养生壶横评"], "avg_score": 8.4}, basis: ["双域内容工厂"] },
    rule_impact: [], receipt: receipt(at(2800)), model_trace: mt },
  { event_id: "E-SEED-BT-0302", who: who("renderer"), context: ctx(at(2700)), object: { type: "video_asset", id: "vd-332", label: "渲染提交 ×2" },
    decision: { action: "render.submit", after: {"videos": 2, "queue": "渲染队列 3 个任务", "eta_min": 22}, basis: ["渲染管线"] },
    rule_impact: [], receipt: receipt(at(2700)), model_trace: mt },
  { event_id: "E-SEED-BT-0303", who: who("director"), context: ctx(at(2600)), object: { type: "video_asset", id: "vd-330", label: "渲染审片" },
    decision: { action: "render.review", after: {"video": "保温杯焖烧实测 60s", "score": 8.7, "notes": "第 3 镜重渲（蒸汽特写不够）"}, basis: ["质量门"] },
    rule_impact: [], receipt: receipt(at(2600)), model_trace: mt },
  { event_id: "E-SEED-BT-0304", who: who("publisher"), context: ctx(at(2400)), object: { type: "content", id: "pb-101", label: "四平台发布" },
    decision: { action: "content.publish", after: {"video": "通勤包 21 个口袋", "channels": ["douyin", "xiaohongshu", "bilibili", "shipinhao"], "mode": "RPA 拟人发布"}, basis: ["publish-rpa"] },
    rule_impact: [], receipt: receipt(at(2400)), model_trace: mt },
  { event_id: "E-SEED-BT-0305", who: who("publisher"), context: ctx(at(2350)), object: { type: "content", id: "pb-102", label: "发布回执" },
    decision: { action: "publish.post", after: {"douyin": {"plays_2h": 18600, "likes": 1240}, "xiaohongshu": {"plays_2h": 6200, "collects": 480}}, basis: ["回执探测"] },
    rule_impact: [], receipt: receipt(at(2350)), model_trace: mt },
  { event_id: "E-SEED-BT-0306", who: who("publisher"), context: ctx(at(2300)), object: { type: "content", id: "pb-103", label: "发布回执" },
    decision: { action: "publish.post", after: {"bilibili": {"plays_2h": 4100, "coins": 210}, "shipinhao": {"plays_2h": 9800, "forwards": 320}}, basis: ["回执探测"] },
    rule_impact: [], receipt: receipt(at(2300)), model_trace: mt },
  { event_id: "E-SEED-BT-0307", who: who("channel-watcher"), context: ctx(at(2200)), object: { type: "intent_signal", id: "cm-88", label: "评论区监控" },
    decision: { action: "comment.monitor", after: {"comments": 342, "intent_high": 17, "topics": ["怎么买 42条", "链接 28条", "材质 15条"], "auto_reply": 342}, basis: ["询盘雷达"] },
    rule_impact: [], receipt: receipt(at(2200)), model_trace: mt },
  { event_id: "E-SEED-BT-0308", who: who("ai-receptionist"), context: ctx(at(2100)), object: { type: "intent_signal", id: "cm-89", label: "询盘秒回" },
    decision: { action: "ask.answer", after: {"q": "这个保温杯 316 还是 304 材质？给孩子用", "a": "316L 医用级不锈钢，儿童可用，附检测报告链接", "latency_s": 4}, basis: ["知识库命中"] },
    rule_impact: [], receipt: receipt(at(2100)), model_trace: mt },
  { event_id: "E-SEED-BT-0309", who: who("lead-concierge"), context: ctx(at(2000)), object: { type: "lead", id: "ld-301", label: "高意向线索" },
    decision: { action: "lead.capture", after: {"guest": "宝妈·刘女士", "intent": "问价+要链接 3 次", "level": "高", "next": "已发专属券转小店"}, basis: ["线索评分 ≥0.72"] },
    rule_impact: ri("R23","review"), receipt: receipt(at(2000)), model_trace: mt },
  { event_id: "E-SEED-BT-0310", who: who("coupon-operator"), context: ctx(at(1900)), object: { type: "booking_order", id: "od-301", label: "内容成交" },
    decision: { action: "booking.confirm", after: {"item": "保温杯焖烧杯套装 ×2", "amount": 396, "source": "douyin 视频挂车", "note": "内容直接带货"}, basis: ["转化归因"] },
    rule_impact: [], receipt: receipt(at(1900)), model_trace: mt },
  { event_id: "E-SEED-BT-0311", who: who("data-analyst"), context: ctx(at(1800)), object: { type: "conversion", id: "ana-w", label: "周度复盘" },
    decision: { action: "strategy.memo", after: {"week": {"videos": 21, "plays": 486000, "gmv": 68400, "top": "保温杯焖烧实测 12.6w"}, "insight": "实测类 > 口播类 2.3×"}, basis: ["复盘节拍"] },
    rule_impact: [], receipt: receipt(at(1800)), model_trace: mt },
  { event_id: "E-SEED-BT-0312", who: who("competitor-agent"), context: ctx(at(1600)), object: { type: "poi_store", id: "cp-1", label: "竞对内容监测" },
    decision: { action: "competitor.fetch", after: {"rival": "膳魔师官方号", "week_plays": 88000, "gap": "对方缺少实测类内容", "play": "加大实测矩阵"}, basis: ["竞对情报"] },
    rule_impact: [], receipt: receipt(at(1600)), model_trace: mt },
  { event_id: "E-SEED-BT-0313", who: who("director"), context: ctx(at(1400)), object: { type: "video_asset", id: "vd-340", label: "爆款复制" },
    decision: { action: "pipeline.started", after: {"base": "焖烧实测 12.6w", "plan": "复制 3 条变体（焖粥/焖汤/母婴辅食）", "eta": "本周"}, basis: ["爆款复制 SOP"] },
    rule_impact: [], receipt: receipt(at(1400)), model_trace: mt },
  { event_id: "E-SEED-BT-0314", who: who("night-shift"), context: ctx(at(480)), object: { type: "night_package", id: "np-h", label: "夜班日报" },
    decision: { action: "night.package.deliver", after: {"overnight": {"renders": 6, "comments": 128, "answered": 128}, "note": "夜间渲染队列全清"}, basis: ["夜班值守"] },
    rule_impact: [], receipt: receipt(at(480)), model_trace: mt },
  { event_id: "E-SEED-BT-0315", who: who("company-ceo"), context: ctx(at(60)), object: { type: "conversion", id: "brief-h", label: "CEO 晨报" },
    decision: { action: "ceo.briefing", after: {"yesterday": {"published": 4, "plays": 52800, "gmv": 9600, "leads": 17}, "week": "播放 48.6w · GMV ¥68,400"}, basis: ["晨报节拍"] },
    rule_impact: [], receipt: receipt(at(60)), model_trace: mt },
];

const APPROVALS = [
  { id: "apr-boost-v1", eventRef: "E-SEED-BT-0311",
    snapshot: { action: "deal.quote", summary: "年度框架商单审批：家居品牌年框 ¥88,000（24 条定制视频）", title: "年度框架商单 ¥88,000",
      ceo_rationale: "对方为头部家居品牌，年框 24 条（¥3,666/条 高于均价 22%）；建议接受但争取产品植入升级为联名款", rule_version: "R3 ai-video-baseline/v2", gate: "必审",
      params: {"brand": "家居品牌（头部）", "amount": 88000, "videos": 24, "unit": 3666},
      before: {"pricing": "单条报价 ¥3,000"}, after: {"pricing": "年框 ¥3,666/条", "total": 88000} } },
  { id: "apr-boost-v2", eventRef: "E-SEED-BT-0307",
    snapshot: { action: "deal.quote", summary: "达人合作审批：母婴达人定制视频 ¥26,000（粉丝 86w）", title: "达人合作 ¥26,000",
      ceo_rationale: "达人画像与目标客群匹配度 91%（25-35 岁宝妈）；预估播放 50w+，CPE ¥0.52 低于行业均值 30%", rule_version: "R3 ai-video-baseline/v2", gate: "必审",
      params: {"kol": "母婴达人（86w粉）", "amount": 26000, "match": "91%", "est_plays": "50w+"},
      before: {"channel": "自投"}, after: {"channel": "自投+达人", "amount": 26000} } },
];

async function main() {
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  let aprNew = 0;
  for (const a of APPROVALS) {
    const exists = await owner.query(`SELECT 1 FROM approvals WHERE approval_id=$1`, [a.id]);
    if ((exists.rowCount ?? 0) > 0) continue;
    await owner.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot, created_at)
       VALUES ($1,$2,$3,$4,'inapp','pending','l4_chairman',$5,$6)`,
      [a.id, TENANT_ID, WS_ID, (a as unknown as { eventRef: string }).eventRef, JSON.stringify(a.snapshot), at(90)],
    );
    aprNew++;
  }
  console.log(`✓ 待审批：新写入 ${aprNew} 条（L4 董事长级）`);
  await owner.end();

  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("BEGIN");
  await gw.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
  await gw.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);
  const last = await gw.query(`SELECT hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT 1`, [TENANT_ID, WS_ID]);
  let prevHash = (last.rows[0]?.hash as string) ?? GENESIS_HASH;
  let inserted = 0, skipped = 0;
  for (const raw of EVENTS) {
    const ev = raw as { event_id: string; context: { time: string } };
    const checked = safeParseReplayAwareEvent(ev as never);
    if (!checked.success) throw new Error(`事件 ${ev.event_id} 未过校验：${checked.error.message}`);
    const dup = await gw.query(`SELECT 1 FROM biz_events WHERE tenant_id=$1 AND event_id=$2`, [TENANT_ID, ev.event_id]);
    if ((dup.rowCount ?? 0) > 0) { skipped++; continue; }
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query<{ inserted: boolean }>(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ev.event_id, TENANT_ID, WS_ID, null, payload, prevHash, hash, ev.context.time],
    );
    if (res.rows[0]?.inserted) { prevHash = hash; inserted++; } else skipped++;
  }
  await gw.query("COMMIT");
  await gw.end();
  console.log(`✓ 剧本事件：新写入 ${inserted} 条，幂等跳过 ${skipped} 条`);
  console.log("内容工厂饱满运行态就绪 ✅（脚本→渲染→四平台发布→回执→成交 · 商单¥88,000待批）");
}

main().catch((e) => { console.error(e); process.exit(1); });
