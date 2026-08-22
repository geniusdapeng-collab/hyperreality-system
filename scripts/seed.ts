/**
 * A5 · 演示种子数据（PRD V2.5 P 章示例场景：云栖酒店）
 * ⚠️ 底座回归专用·酒店演示集，客户演示请用 seed-video.ts / demo-video.ts
 * 用法：pnpm db:seed（读取 .env；幂等，可重复执行）
 *
 * 内容：demo 租户 / 云栖酒店工作区 / 3 人类成员 / 7 Agent preset 实例 /
 *      一店一档（含 forbidden 硬约束）/ 基线围栏 R1–R6 装载 / 3 官方技能 /
 *      2 触发器 / 昨夜夜班班次 / 100 条五元事件（哈希链）/ 审批样例 / 组织记忆
 *
 * 纪律：
 *  - 事件只经 workloom_gateway 角色写入（F1.2），其余表走 owner 种子连接（D10）；
 *  - 每条事件写入前过 safeParseBusinessEvent（附录 E 校验）；
 *  - 幂等：组织模型 ON CONFLICT DO NOTHING；事件 UNIQUE(tenant_id,event_id) 冲突丢弃（L1.4）；
 *  - 验收：写入后回读 100 条事件逐条过 zod，五元字段完整率必须 100%（附录 H-1）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import YAML from "yaml";
import { safeParseBusinessEvent } from "@workloom/shared";
// #32 修复：哈希链统一生产口径（events.ts 的 canonicalJson/eventHash）——
// 此前种子用 JSON.stringify 键序算哈希，与生产 canonicalJson 口径不一致，
// 种子 100 条事件用生产验证器重算全部不符（链上两种算法混杂）
import { eventHash } from "@workloom/base/workdata";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles/hotel");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const GATEWAY_URL =
  process.env.DATABASE_GATEWAY_URL ??
  "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

/* ================= 固定演示标识（幂等键） ================= */

const TENANT_ID = "tenant-demo";
const TENANT_NAME = "演示租户（Demo）";
const WS_ID = "ws-yunqi";
const WS_NAME = "云栖酒店";
const WS_SLUG = "yunqi-hotel";
const FENCE_VERSION = "hotel-baseline/v1";

const MEMBERS = [
  { id: "MEM-001", name: "王店长", role: "owner" },
  { id: "MEM-002", name: "陈经理", role: "manager" },
  { id: "MEM-003", name: "李前台", role: "readonly" },
] as const;

const EVENT_BASE = 8800; // 事件编号 E-8801 起（PRD 展示口径）
const EVENT_COUNT = 100;
const GENESIS_HASH = "GENESIS";

/* ================= 工具 ================= */

/** 确定性伪随机（mulberry32）：演示数据可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260816);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

function iso(d: Date): string {
  return d.toISOString();
}

/** 演示时间轴：昨天 00:00 到今天现在；夜班段额外加密（22:00–08:30，F4.1） */
function demoTimeline(): Date[] {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const span = now.getTime() - start.getTime();
  const times: Date[] = [];
  for (let i = 0; i < EVENT_COUNT; i++) {
    // 60% 落在夜班窗口（昨晚 22:00 → 今 08:30），40% 全天均匀
    let t: number;
    if (i % 5 < 3) {
      const nightStart = new Date(start); nightStart.setHours(22, 0, 0, 0);
      const nightEnd = new Date(start); nightEnd.setDate(nightEnd.getDate() + 1); nightEnd.setHours(8, 30, 0, 0);
      t = nightStart.getTime() + rand() * (nightEnd.getTime() - nightStart.getTime());
    } else {
      t = start.getTime() + rand() * span;
    }
    times.push(new Date(t));
  }
  times.sort((a, b) => a.getTime() - b.getTime());
  return times;
}

/* ================= Bundle 资产读取 ================= */

interface Preset {
  preset_key: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  readonly: boolean;
  night_shift: boolean;
  high_risk: boolean;
  fence_bindings: string[];
  skills: string[];
  tools: Array<{ name: string; access: string; desc: string }>;
  prompt: unknown;
  write_back: string[];
}

function loadPresets(): Preset[] {
  const dir = join(BUNDLE_DIR, "presets");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .sort()
    .map((f) => YAML.parse(readFileSync(join(dir, f), "utf-8")) as Preset);
}

interface FenceRule {
  rule_id: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline: boolean;
  match: { object_types: string[]; actions: string[] };
  when: string;
  note?: string;
}

function loadFences(): FenceRule[] {
  const doc = YAML.parse(readFileSync(join(BUNDLE_DIR, "fences/hotel-baseline.yml"), "utf-8"));
  return (doc?.rules ?? []) as FenceRule[];
}

interface SkillDoc {
  name: string;
  description: string;
  body: string;
  fenceBindings: string[];
}

function loadSkills(): SkillDoc[] {
  const dir = join(BUNDLE_DIR, "skills");
  return readdirSync(dir)
    .sort()
    .map((d) => {
      const raw = readFileSync(join(dir, d, "SKILL.md"), "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const fm = YAML.parse(m?.[1] ?? "{}");
      const bindMap: Record<string, string[]> = {
        "revenue-manager": ["R1", "R2"],
        "review-crisis": ["R6"],
        "channel-reconciler": ["R4", "R5"],
      };
      return {
        name: String(fm.name ?? d),
        description: String(fm.description ?? ""),
        body: (m?.[2] ?? "").trim(),
        fenceBindings: bindMap[String(fm.name ?? d)] ?? [],
      };
    });
}

/** 一店一档（bundles/hotel/schemas/archive.schema.json 对齐；保底价 ¥380 与 R2 同源） */
function yunqiArchive(): Record<string, unknown> {
  return {
    property: { name: WS_NAME, city: "杭州", rooms: 86, star: "四钻" },
    brand_guideline: {
      tone: "真诚克制，不夸大、不承诺档案外补偿",
      banned_words: ["最低价全网保证", "百分百满意"],
      image_rules: "首图实拍、无水印、16:9",
    },
    competitors: [
      { name: "西湖云舍酒店", channels: ["美团", "携程"], price_band: [420, 680] },
      { name: "溪上云居民宿", channels: ["美团"], price_band: [360, 520] },
      { name: "云栖轻奢酒店", channels: ["携程", "飞猪"], price_band: [460, 760] },
    ],
    audience: { 商旅客: 0.55, 亲子: 0.25, 情侣: 0.2 },
    history_curve: {
      "2026-06": { occ: 0.71, adr: 468, revpar: 332 },
      "2026-07": { occ: 0.83, adr: 512, revpar: 425 },
      "2026-08": { occ: 0.78, adr: 496, revpar: 387 },
    },
    sop: ["差评 24h 内响应", "调价须附竞对依据", "夜间对账三轮比对"],
    // 巡检只读快照（M9/F9.1 探针输入；E1 补登：07:00 巡检真实检出——高危差评 + 中危价格/房态异常）
    inspection: {
      channels: [
        { channel: "美团", price: 458, parity: true, status: "online" },
        { channel: "携程", price: 458, parity: true, status: "online" },
        { channel: "飞猪", price: 438, parity: false, status: "online" },
      ],
      roomStates: [
        { roomType: "大床房", synced: true },
        { roomType: "双床房", synced: true },
        { roomType: "亲子房", synced: false },
      ],
      reviews: [
        { id: "rv-ctrip-9901", channel: "携程", score: 5 },
        { id: "rv-meituan-1032", channel: "美团", score: 2 },
      ],
      violations: [],
    },
    forbidden: [
      { rule: "美团大床房不低于 ¥380", scope: "room_price" },
      { rule: "不承诺档案之外的补偿金额", scope: "review" },
    ],
  };
}

/* ================= 事件剧本生成 ================= */

interface SeedEvent {
  event_id: string;
  who: { type: "human" | "agent" | "system"; id: string; version?: string };
  context: {
    tenant_id: string;
    workspace_id: string;
    time: string;
    channel?: string;
    stage?: string;
    store?: string;
    [k: string]: unknown;
  };
  object: { type: string; id?: string; [k: string]: unknown };
  decision: {
    action: string;
    before?: unknown;
    after?: unknown;
    basis?: string[];
    memory_refs?: string[];
    [k: string]: unknown;
  };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  receipt?: { synced?: boolean; snapshot_uri?: string; verified_at?: string };
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  links?: string[];
  [k: string]: unknown;
}

const ROOM_TYPES = [
  { id: "RT-DLX-KING", label: "雅致大床房", base: 458 },
  { id: "RT-FAM-TWIN", label: "亲子双床房", base: 528 },
  { id: "RT-BIZ-KING", label: "商旅大床房", base: 398 },
] as const;
const CHANNELS = ["美团", "携程", "飞猪"] as const;

/** 生成一条剧本事件（按序号轮转场景，保证 R1–R6 均有命中样本） */
function makeEvent(i: number, time: Date, presets: Preset[]): SeedEvent {
  const id = `E-${EVENT_BASE + i}`;
  const scene = i % 10;
  const baseCtx = {
    tenant_id: TENANT_ID,
    workspace_id: WS_ID,
    time: iso(time),
    stage: "stable",
    store: WS_NAME,
  };
  const hour = time.getHours();
  const window = hour >= 22 || hour < 8 ? "off-peak" : "peak";
  const mt = (tier: "standard" | "flagship") => ({
    model_id: "mock-hotel-001",
    tier,
    window,
    credits: tier === "flagship" ? 2 : 1,
  });
  const receipt = (t: Date) => ({
    synced: true,
    snapshot_uri: `data/snapshots/${id.toLowerCase()}.png`,
    verified_at: iso(new Date(t.getTime() + 45_000)),
  });
  const agentWho = (key: string) => {
    const p = presets.find((x) => x.preset_key === key)!;
    return { type: "agent" as const, id: p.preset_key, version: p.version };
  };

  switch (scene) {
    case 0: {
      // R1 自动调价：涨幅 ≤8%（pass）
      const rt = pick(ROOM_TYPES);
      const before = rt.base + int(-10, 10);
      const after = Math.round(before * (1 + rand() * 0.07));
      return {
        event_id: id,
        who: agentWho("pricing-agent"),
        context: { ...baseCtx, channel: pick(CHANNELS) },
        object: { type: "room_price", id: rt.id, label: rt.label },
        decision: {
          action: "price.adjust",
          before: { price: before },
          after: { price: after },
          basis: ["竞对西湖云舍同房型 ¥" + (after + int(10, 40)), "近 7 日 OCC 0.78"],
        },
        rule_impact: [{ rule_id: "R1", version: FENCE_VERSION, result: "pass" }],
        receipt: receipt(time),
        model_trace: mt("standard"),
      };
    }
    case 1: {
      // R6 差评必审（review → 挂起）
      return {
        event_id: id,
        who: agentWho("review-agent"),
        context: { ...baseCtx, channel: pick(CHANNELS) },
        object: { type: "review", id: `RV-${int(10000, 99999)}` },
        decision: {
          action: "review.reply",
          params: { rating: int(1, 3) },
          after: { draft: "非常抱歉给您带来不好的体验，我们已核实空调异响问题并安排检修……" },
          basis: ["品牌规范致歉结构", "档案 forbidden 已核对"],
        },
        rule_impact: [{ rule_id: "R6", version: FENCE_VERSION, result: "review" }],
        model_trace: mt("standard"),
      };
    }
    case 2: {
      // 夜班对账：无差异通过（留痕 G8）
      return {
        event_id: id,
        who: agentWho("reconcile-agent"),
        context: { ...baseCtx, channel: "夜班" },
        object: { type: "order", id: `OD-${int(100000, 999999)}` },
        decision: {
          action: "order.reconcile",
          params: { guarantee_anomaly: false },
          after: { diff: 0, rounds: 3 },
          basis: ["订单流水 × 渠道结算 × 担保核验三轮比对一致"],
        },
        rule_impact: [{ rule_id: "R5", version: FENCE_VERSION, result: "pass" }],
        model_trace: mt("standard"),
      };
    }
    case 3: {
      // 竞对采集（只读子调用，数据卡供调价引用）
      return {
        event_id: id,
        who: agentWho("competitor-agent"),
        context: { ...baseCtx, channel: "夜班" },
        object: { type: "channel", id: pick(CHANNELS) },
        decision: {
          action: "competitor.fetch",
          after: {
            card: pick(["西湖云舍酒店", "溪上云居民宿", "云栖轻奢酒店"]),
            price: int(360, 760),
          },
          basis: ["频次自律：请求间隔 ≥3s（L3.3）"],
        },
        rule_impact: [],
        model_trace: mt("standard"),
      };
    }
    case 4: {
      // 人类审批手势（王店长 批准差评回复）
      return {
        event_id: id,
        who: { type: "human", id: "MEM-001" },
        context: { ...baseCtx, channel: "inapp" },
        object: { type: "review", id: `RV-${int(10000, 99999)}` },
        decision: {
          action: "approval.gesture",
          after: { gesture: "approve", weight: 1 },
          basis: ["回复符合品牌规范，无档案外补偿承诺"],
        },
        rule_impact: [],
      };
    }
    case 5: {
      // R4 大额退款必审（review）
      return {
        event_id: id,
        who: agentWho("reconcile-agent"),
        context: { ...baseCtx, channel: pick(CHANNELS) },
        object: { type: "order", id: `OD-${int(100000, 999999)}` },
        decision: {
          action: "order.refund",
          params: { amount: int(500, 1200) },
          basis: ["客人到店无房，协商全额退款"],
        },
        rule_impact: [{ rule_id: "R4", version: FENCE_VERSION, result: "review" }],
        model_trace: mt("standard"),
      };
    }
    case 6: {
      // 巡检：07:00 只读巡检，P2 级异常（L9.2 不静默）
      return {
        event_id: id,
        who: agentWho("inspection-agent"),
        context: { ...baseCtx, channel: "巡检" },
        object: { type: "channel", id: pick(CHANNELS) },
        decision: {
          action: "inspection.scan",
          after: { level: "p2", finding: "飞猪渠道房态同步延迟 12 分钟" },
          basis: ["渠道状态探针"],
        },
        rule_impact: [],
        model_trace: mt("standard"),
      };
    }
    case 7: {
      // R2 保底价熔断演示（blocked）：试图调至 ¥368 < ¥380
      const rt = ROOM_TYPES[0];
      return {
        event_id: id,
        who: agentWho("pricing-agent"),
        context: { ...baseCtx, channel: "美团" },
        object: { type: "room_price", id: rt.id, label: rt.label },
        decision: {
          action: "price.adjust",
          before: { price: rt.base },
          after: { price: 368 },
          basis: ["竞对溪上云居降至 ¥366（未核对档案 forbidden）"],
        },
        rule_impact: [{ rule_id: "R2", version: FENCE_VERSION, result: "blocked" }],
        model_trace: mt("standard"),
      };
    }
    case 8: {
      // 内容发布：老渠道发布（auto 通过）
      return {
        event_id: id,
        who: agentWho("content-agent"),
        context: { ...baseCtx, channel: pick(CHANNELS), channel_new: false },
        object: { type: "content", id: `CT-${int(1000, 9999)}` },
        decision: {
          action: "content.publish",
          after: { title: "秋日云栖·亲子双床房套餐上线" },
          basis: ["品牌规范首图 16:9 实拍", "已核对禁用表达清单"],
        },
        rule_impact: [{ rule_id: "R3", version: FENCE_VERSION, result: "pass" }],
        receipt: receipt(time),
        model_trace: mt("flagship"),
      };
    }
    default: {
      // 系统事件：夜班状态机迁移 / 记忆固化
      return {
        event_id: id,
        who: { type: "system", id: "night-shift" },
        context: { ...baseCtx, channel: "夜班" },
        object: { type: "store", id: WS_ID },
        decision: {
          action: pick(["night.run.start", "night.package.deliver", "memory.consolidate"]),
          after: { note: "夜班状态机推进（F4.8）" },
        },
        rule_impact: [],
      };
    }
  }
}

/* ================= 主流程 ================= */

async function main(): Promise<void> {
  const presets = loadPresets();
  const fences = loadFences();
  const skillsDocs = loadSkills();
  console.log(`✓ Bundle 资产读取：${presets.length} preset / ${fences.length} 围栏 / ${skillsDocs.length} 技能`);

  // —— 组织模型走 owner 连接（种子/迁移账号，RLS 对其不生效；见 0001_init.sql 注记）
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();

  const q = (text: string, params: unknown[]) => owner.query(text, params);

  // 租户 / 工作区
  await q(
    `INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID, TENANT_NAME],
  );
  await q(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config)
     VALUES ($1,$2,$3,$4,'hotel','stable',$5) ON CONFLICT (id) DO NOTHING`,
    [
      WS_ID,
      TENANT_ID,
      WS_NAME,
      WS_SLUG,
      JSON.stringify({
        enabled: true,
        candidateTime: "18:00",
        startTime: "22:00",
        packageTime: "08:30",
        timezone: "Asia/Shanghai",
      }),
    ],
  );
  console.log("✓ 租户与工作区：demo / 云栖酒店");

  // 人类成员（王店长 owner / 陈经理 manager / 李前台 readonly，F5.6）
  for (const m of MEMBERS) {
    await q(
      `INSERT INTO members (id, workspace_id, member_no, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, member_no) DO NOTHING`,
      [`${m.id.toLowerCase()}-id`, WS_ID, m.id, m.name, m.role],
    );
  }
  console.log(`✓ 人类成员 ×${MEMBERS.length}（${MEMBERS.map((m) => `${m.name}/${m.role}`).join("、")}）`);

  // Agent preset 实例（IM.5；F2.10 fence_bindings 原样落库）
  for (const p of presets) {
    await q(
      `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        `agt-${p.preset_key}`,
        WS_ID,
        p.preset_key,
        p.name,
        p.version,
        p.kind,
        p.readonly,
        JSON.stringify(p.fence_bindings),
        JSON.stringify(p.skills),
        JSON.stringify({
          description: p.description,
          night_shift: p.night_shift,
          high_risk: p.high_risk,
          tools: p.tools,
          prompt: p.prompt,
          write_back: p.write_back,
        }),
      ],
    );
  }
  console.log(`✓ Agent 实例 ×${presets.length}（含只读 preset：巡检/竞对，L9.1）`);

  // 一店一档（槽①；forbidden 双写：archive 内 + 独立列，L1.6）
  const archive = yunqiArchive();
  await q(
    `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
     VALUES ($1,$2,'hotel',$3,$4,NULL)
     ON CONFLICT (workspace_id) DO UPDATE SET archive = EXCLUDED.archive, forbidden = EXCLUDED.forbidden, updated_at = now()`,
    [WS_ID, TENANT_ID, JSON.stringify(archive), JSON.stringify(archive.forbidden)],
  );
  console.log("✓ 一店一档（含 forbidden 硬约束 ×2，保底价 ¥380 与 R2 同源）");

  // 基线围栏装载（R1–R6，active；单调守卫 F2.3 由阶段二 B4 判定器执行）
  for (const r of fences) {
    await q(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','system:seed')
       ON CONFLICT (rule_id, version, workspace_id) DO NOTHING`,
      [
        `fr-${r.rule_id.toLowerCase()}-v1-${WS_ID}`,
        r.rule_id,
        FENCE_VERSION,
        WS_ID,
        r.name,
        r.level,
        JSON.stringify({ ...r.match, when: r.when }),
        JSON.stringify({ result: r.level === "auto" ? "pass" : r.level === "review" ? "review" : "blocked", note: r.note ?? "" }),
        r.is_baseline,
      ],
    );
  }
  console.log(`✓ 基线围栏装载 ×${fences.length}（${FENCE_VERSION}，active）`);

  // 官方技能 + 安装绑定（F8.1/F8.2）
  for (const s of skillsDocs) {
    const skillId = `skill-${s.name}`;
    await q(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'official','hotel',$2,'1.0.0',$3,$4,$5,false)
       ON CONFLICT (id) DO NOTHING`,
      [skillId, s.name, s.description, JSON.stringify(s.fenceBindings), s.body],
    );
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by)
       VALUES ($1,$2,'MEM-001') ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
      [skillId, WS_ID],
    );
  }
  console.log(`✓ 官方技能 ×${skillsDocs.length} 已安装（围栏绑定随安装生效）`);

  // 团队技能 + 行业共享技能（P6 装备库三区演示数据；F8.1 三级体系；幂等 ON CONFLICT）
  await q(
    `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
     VALUES ('skill-t-ws-yunqi-weekly-ops-review','team','hotel','周一经营复盘','1.2.0',
             '每周一 08:00 自动汇总上周经营：入住率/RevPAR/差评闭环/调价采纳率，产出复盘报告草稿（本工作区自建，F8.3 三要素零代码锻造）。',
             '[]',
             '# 周一经营复盘\n\n## 触发（何时用）\n每周一 08:00 定时触发。\n\n## 步骤（怎么做）\n1. 汇总上周入住率与 RevPAR 曲线（只读）。\n2. 汇总差评闭环与调价采纳率。\n3. 产出复盘报告草稿进 P4 待审。\n\n## 边界（什么不做）\n不直接改价、不直接回评价。',
             false)
     ON CONFLICT (id) DO NOTHING`,
  );
  await q(
    `INSERT INTO skill_installs (skill_id, workspace_id, installed_by)
     VALUES ('skill-t-ws-yunqi-weekly-ops-review',$1,'MEM-002') ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
    [WS_ID],
  );
  await q(
    `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
     VALUES ('skill-i-peak-season-sprint','industry','east-china-hotel-alliance','旺季满房冲刺包','2.1.0',
             '华东酒店联盟共享：旺季满房冲刺打法包（竞对盯价+满房溢价节奏+差评快反 SOP），326 店在用；上架前已脱敏（L8.1 ✓）。',
             '["R1","R2"]',
             '# 旺季满房冲刺包\n\n## 触发（何时用）\n旺季/节假日满房冲刺期。\n\n## 步骤（怎么做）\n1. 竞对盯价：同档房型价差 >5% 提醒。\n2. 满房溢价节奏建议（单日涨幅 ≤8%，R1 管辖）。\n3. 差评快反 SOP（R6 必审）。\n\n## 边界（什么不做）\n不低于保底价（R2 红线）。',
             true)
     ON CONFLICT (id) DO NOTHING`,
  );
  console.log(`✓ 团队技能 ×1（已装）+ 行业共享技能 ×1（已脱敏待装）`);

  // 触发器（F4.7：07:00 巡检 / 22:00 夜班出征）
  const triggers = [
    { id: "tg-inspection-0700", name: "每日 07:00 只读巡检", kind: "cron", schedule: "0 7 * * *", action: { dispatch: "inspection-agent", template: "inspection.daily" } },
    { id: "tg-night-2200", name: "夜班 22:00 战队出征", kind: "cron", schedule: "0 22 * * *", action: { dispatch: "night-shift", template: "night.run.start" } },
  ];
  for (const t of triggers) {
    await q(
      `INSERT INTO triggers (id, workspace_id, name, kind, schedule, action, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,'MEM-001') ON CONFLICT (id) DO NOTHING`,
      [t.id, WS_ID, t.name, t.kind, t.schedule, JSON.stringify(t.action)],
    );
  }
  console.log("✓ 触发器 ×2（巡检 07:00 / 夜班 22:00）");

  // 演示线程（P1/P2 有数据可投影）
  const threads = [
    { id: "T-101", title: "周五旺季调价（大床房/双床房）", mode: "quest", status: "completed", done: 6, total: 6, agent: "agt-pricing-agent", by: "MEM-001" },
    { id: "T-102", title: "差评应急回复（携程 2 分评价）", mode: "quest", status: "pending_review", done: 3, total: 5, agent: "agt-review-agent", by: "MEM-001" },
    { id: "T-103", title: "飞猪渠道新客首图发布", mode: "agent", status: "running", done: 1, total: 4, agent: "agt-content-agent", by: "MEM-002" },
  ];
  for (const t of threads) {
    await q(
      `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total, created_by, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [t.id, TENANT_ID, WS_ID, t.title, t.mode, t.status, t.done, t.total, t.by, t.agent],
    );
  }
  console.log(`✓ 演示线程 ×${threads.length}（completed / pending_review / running）`);

  // 凭据引用占位（F7.7/L7.3：演示环境密文为占位串，真实加密阶段二实现）
  for (const c of [
    { id: "cred-ota-meituan", provider: "ota-meituan", ref_key: "yunqi/meituan" },
    { id: "cred-ota-ctrip", provider: "ota-ctrip", ref_key: "yunqi/ctrip" },
  ]) {
    await q(
      `INSERT INTO credentials (id, workspace_id, provider, ref_key, secret_enc, scopes, health)
       VALUES ($1,$2,$3,$4,'demo-placeholder-ciphertext',$5,'unknown') ON CONFLICT (id) DO NOTHING`,
      [c.id, WS_ID, c.provider, c.ref_key, JSON.stringify(["read", "write"])],
    );
  }
  console.log("✓ 凭据引用 ×2（占位密文，事件只记引用 ID）");

  // —— 事件写入：切 gateway 角色（F1.2 唯一可 INSERT biz_events）
  await owner.end();
  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("SELECT set_config('app.workspace_id', $1, false)", [WS_ID]);
  await gw.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_ID]);

  // 哈希链续接（幂等重跑时接在已有链尾之后；链内已存在的事件靠 UNIQUE 丢弃）
  const last = await gw.query(
    `SELECT hash FROM biz_events WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1`,
    [TENANT_ID],
  );
  let prevHash = (last.rows[0]?.hash as string) ?? GENESIS_HASH;

  const times = demoTimeline();
  // 线程归属：调价/差评/内容场景挂对应线程，其余挂夜班会话
  const sessionOf = (scene: number): string | null =>
    scene === 0 || scene === 7 ? "T-101" : scene === 1 || scene === 4 ? "T-102" : scene === 8 ? "T-103" : null;

  let inserted = 0;
  let dupSkipped = 0;
  for (let i = 1; i <= EVENT_COUNT; i++) {
    const ev = makeEvent(i, times[i - 1] as Date, presets);
    const checked = safeParseBusinessEvent(ev);
    if (!checked.success) {
      throw new Error(`种子事件 ${ev.event_id} 未过附录 E 校验：${checked.error.message}`);
    }
    // #32：哈希输入与存库 payload 均为 zod parse 后的 checked.data（与 appendEvent 逐字节一致）
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query(
      `INSERT INTO biz_events (event_id, tenant_id, workspace_id, session_id, payload, prev_hash, hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, event_id) DO NOTHING
       RETURNING seq`,
      [ev.event_id, TENANT_ID, WS_ID, sessionOf(i % 10), payload, prevHash, hash, ev.context.time],
    );
    if (res.rowCount && res.rowCount > 0) {
      prevHash = hash; // 只有真实落库的事件才进链
      inserted += 1;
    } else {
      dupSkipped += 1;
    }
  }
  console.log(`✓ 五元事件：新写入 ${inserted} 条，幂等丢弃 ${dupSkipped} 条（L1.4）`);

  // 审批样例：取最近两条 review 结果事件挂审批（一 pending 一 approved）
  const reviewEvents = await gw.query(
    `SELECT event_id, payload FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2
       AND payload->'rule_impact' @> '[{"result":"review"}]'::jsonb
     ORDER BY seq DESC LIMIT 2`,
    [TENANT_ID, WS_ID],
  );
  for (const [idx, row] of reviewEvents.rows.entries()) {
    const p = row.payload as SeedEvent;
    const status = idx === 0 ? "pending" : "approved";
    await gw.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, gesture, snapshot, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,'inapp',$5,$6,$7,$8,$9)
       ON CONFLICT (event_id, channel) DO NOTHING`,
      [
        `apr-${row.event_id.toLowerCase()}`,
        TENANT_ID,
        WS_ID,
        row.event_id,
        status,
        status === "approved"
          ? JSON.stringify({ type: "approve", weight: 1 })
          : null,
        JSON.stringify({
          before: p.decision.before ?? null,
          after: p.decision.after ?? null,
          expires_at: iso(new Date(Date.now() + 24 * 3600 * 1000)), // G6：24h
        }),
        status === "approved" ? "MEM-001" : null,
        status === "approved" ? new Date().toISOString() : null,
      ],
    );
  }
  console.log(`✓ 审批样例 ×${reviewEvents.rows.length}（pending/approved 各一，UNIQUE(event_id,channel) 幂等）`);

  // 昨夜夜班班次（package_generated，决策包统计三栏）
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const runDate = yesterday.toISOString().slice(0, 10);
  await gw.query(
    `INSERT INTO night_runs (id, workspace_id, run_date, status, fence_snapshot_version, candidate_count, stats, started_at, package_event_id)
     VALUES ($1,$2,$3,'package_generated',$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO NOTHING`,
    [
      `nr-${runDate}`,
      WS_ID,
      runDate,
      FENCE_VERSION,
      14,
      JSON.stringify({ done: 9, pending: 3, need_human: 2, credits_used: 96, credits_est: 118 }),
      new Date(yesterday.setHours(22, 0, 0, 0)).toISOString(),
      `E-${EVENT_BASE + EVENT_COUNT}`,
    ],
  );
  console.log(`✓ 夜班班次 nr-${runDate}（package_generated，围栏快照 ${FENCE_VERSION}）`);

  // 组织记忆 + 归因（F1.4）
  const memories = [
    { id: "mem-occ-friday", kind: "pattern", content: "周五晚大床房需求弹性高，18:00 前提价转化损失最小", source: ["E-8801"] },
    { id: "mem-review-sop", kind: "sop", content: "差评回复结构：致歉→核实→已采取措施→改进承诺，不承诺档案外补偿", source: ["E-8802"] },
  ];
  for (const m of memories) {
    await gw.query(
      `INSERT INTO org_memory (memory_id, tenant_id, workspace_id, scope, kind, content, source_events, confidence)
       VALUES ($1,$2,$3,'workspace',$4,$5,$6,0.6)
       ON CONFLICT (memory_id) DO NOTHING`,
      [m.id, TENANT_ID, WS_ID, m.kind, m.content, m.source],
    );
    await gw.query(
      `INSERT INTO memory_usage (memory_id, event_id) VALUES ($1,$2)
       ON CONFLICT (memory_id, event_id) DO NOTHING`,
      [m.id, m.source[0]],
    );
  }
  console.log(`✓ 组织记忆 ×${memories.length}（含来源事件归因）`);

  // —— 验收（附录 H-1）：回读本批次 100 条，逐条过 zod，五元完整率必须 100%
  const check = await gw.query(
    `SELECT payload FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2 AND event_id >= $3 AND event_id <= $4
     ORDER BY seq`,
    [TENANT_ID, WS_ID, `E-${EVENT_BASE + 1}`, `E-${EVENT_BASE + EVENT_COUNT}`],
  );
  let valid = 0;
  for (const row of check.rows) {
    if (safeParseBusinessEvent(row.payload).success) valid += 1;
  }
  const rate = check.rowCount ? valid / check.rowCount : 0;
  console.log(`✓ 验收（H-1）：回读 ${check.rowCount} 条，五元字段完整 ${valid} 条，完整率 ${(rate * 100).toFixed(1)}%`);
  if (check.rowCount !== EVENT_COUNT || rate !== 1) {
    throw new Error(`验收失败：期望 ${EVENT_COUNT} 条且完整率 100%（实际 ${check.rowCount} 条 / ${(rate * 100).toFixed(1)}%）`);
  }

  await gw.end();
  console.log("种子数据完成 ✅（云栖酒店演示数据集就绪）");
}

main().catch((err) => {
  console.error("seed 失败：", err?.message ?? err);
  process.exit(1);
});
