/**
 * seed-video.ts —— 视频经理（ai-video Bundle）演示种子
 *
 * 与 scripts/seed.ts（酒店 Bundle）同构，装载：
 *  - 演示租户/工作区（industry: ai-video）
 *  - 人类成员（主理人/运营/剪辑）
 *  - bundles/ai-video 的 33 个数码员工 preset（制作 21 + 经营 12；含 fence_bindings 原样落库）
 *  - ai-video-baseline/v2 基线围栏（G1-G10 系列 15 条 + 经营扩展 G11-G16 共 21 条）
 *  - 8 个官方技能（安装即绑定围栏）
 *  - 一企一档（品牌档案 + forbidden 红线）
 *  - 自动化触发器（每 2h 数据采集 / 早八点战报 / 每 30min 评论采集）
 *  - 演示项目：1 个 video_project + 3 镜渲染脚本（v1）+ 2 条素材
 *
 * 幂等可复跑（全部 ON CONFLICT DO NOTHING / DO UPDATE）。
 * 运行：pnpm db:seed:video
 */
import pg from "pg";
import YAML from "yaml";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeParseBusinessEvent } from "@workloom/shared";
// 哈希链统一生产口径（events.ts 的 canonicalJson/eventHash），与 seed.ts 同一纪律
import { eventHash } from "@workloom/base/workdata";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles/ai-video");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const GATEWAY_URL =
  process.env.DATABASE_GATEWAY_URL ??
  "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

/* ================= 固定演示标识（幂等键） ================= */

const TENANT_ID = "tenant-demo";
const WS_ID = "ws-video";
const WS_NAME = "视频经理 · 演示工作室";
const WS_SLUG = "video-studio";
const FENCE_VERSION = "ai-video-baseline/v2";

const MEMBERS = [
  { id: "MEM-V01", name: "陈主理", role: "owner" },
  { id: "MEM-V02", name: "林运营", role: "manager" },
  { id: "MEM-V03", name: "赵剪辑", role: "manager" },
] as const;

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
  tools: unknown[];
  prompt: Record<string, unknown>;
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
  const doc = YAML.parse(
    readFileSync(join(BUNDLE_DIR, "fences/ai-video-baseline.yml"), "utf-8"),
  );
  return (doc?.rules ?? []) as FenceRule[];
}

interface SkillDoc {
  name: string;
  description: string;
  body: string;
}

/** 管线 YAML 解析校验：管线由 Quest 调度器直接消费 YAML，此处解析计数确保可解析 */
function loadPipelines(): string[] {
  const dir = join(BUNDLE_DIR, "pipelines");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .sort()
    .map((f) => {
      const doc = YAML.parse(readFileSync(join(dir, f), "utf-8"));
      return String(doc?.quest ?? f);
    });
}

function loadSkills(): SkillDoc[] {
  const dir = join(BUNDLE_DIR, "skills");
  return readdirSync(dir)
    .sort()
    .map((d) => {
      const raw = readFileSync(join(dir, d, "SKILL.md"), "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const fm = YAML.parse(m?.[1] ?? "{}");
      return {
        name: String(fm.name ?? d),
        description: String(fm.description ?? ""),
        body: (m?.[2] ?? "").trim(),
      };
    });
}

/**
 * 工艺技能库（library/）注册：203 好莱坞导演技能 + 20 营销技能 → 技能广场可见
 * 命名口径「题材_导演_运镜/情绪」（如 剧情_卡梅隆_情感手持）；营销技能直接使用文件名。
 * 以 team 级技能注册并安装到演示工作区（F8.1 三级体系；body 留摘要，全文在 Bundle library）。
 */
function loadLibrarySkills(): SkillDoc[] {
  const out: SkillDoc[] = [];
  const roots: Array<{ dir: string; tag: string }> = [
    { dir: join(BUNDLE_DIR, "library/hollywood-factory"), tag: "好莱坞工艺" },
    { dir: join(BUNDLE_DIR, "library/social-marketing"), tag: "营销工艺" },
  ];
  const walk = (dir: string, tag: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p, tag);
      } else if (entry.name.endsWith(".md")) {
        const base = entry.name.replace(/\.md$/, "");
        const parts = base.split("_");
        const genre = parts[0] ?? "通用";
        const director = parts.length >= 3 ? parts[1] : "";
        out.push({
          name: `craft-${base}`,
          description: `【${tag}·${genre}】${director ? `${director} 风格 · ` : ""}${base}（全文见 bundles/ai-video/library）`,
          body: `# ${base}\n\n> ${tag} · 由 bundles/ai-video/library 分发的工艺技能全文。`,
        });
      }
    }
  };
  for (const r of roots) {
    try {
      walk(r.dir, r.tag);
    } catch {
      /* library 可选 */
    }
  }
  return out;
}

/** 一企一档（品牌档案；forbidden 红线双写，L1.6 同源纪律） */
function studioArchive(): Record<string, unknown> {
  return {
    brand: "演示品牌·星芒好物",
    // 数字CEO 宪章（D21，内容行业语义三变体：默认账号制；项目制/合同制模板见 archive.variants）
    charter: {
      version: 2,
      mode: "trial",
      identity: { name: "公司CEO", persona: "内容经营型" },
      autonomy: {
        publish_per_day_cap: 3,
        boost_budget_per_post: 500,
        price_quote_band: [0.9, 1.2],
        reply_auto_scope: ["夸赞", "感谢"],
      },
      escalate: ["对外公开承诺（赔偿/免费/声明）", "广告法敏感口径", "围栏规则放宽（任何放宽）", "新平台/新账号上线", "月累计投流超上限", "低于底价报价让步", "投放加投（G12 必审）", "宪章变更"],
      briefing: { daily: "08:30", weekly: "Mon 09:00", monthly: "1st 10:00", channel: "both" },
      circuit_breaker: { window_days: 14, kpi_floor: { completion_rate: 0.25, follower_growth_7d: -0.02 }, tightened: false },
      grant: {
        event_id: "E-GRANT-VDEMO1", granted_by: "MEM-001",
        granted_at: new Date(Date.now() - 9 * 86400e3).toISOString(),
        disclosure_version: "risk-v1",
        clauses: ["自主调价", "自主采购", "自主对外回复", "试用降档规则", "AI 非法律责任主体·授权人承担经营决策责任"],
        shadow_days: 3, trial_days: 7,
        trial_ends_at: new Date(Date.now() + 5 * 86400e3).toISOString(),
        retain_until: null,
      },
      updated_at: new Date().toISOString(),
    },
    // 宪章变体模板（切换经营模式时整体替换 autonomy/circuit_breaker，grant 六步授权结构不变）
    variants: [
      {
        key: "project",
        name: "项目制（单剧/单项目核算）",
        autonomy: { render_budget_per_episode: 300, render_retry_cap: 5 },
        circuit_breaker: { kpi_floor: { roi_iaa: 0.98, scrap_rate: 0.85 } },
      },
      {
        key: "contract",
        name: "合同制（商单履约 SLA）",
        autonomy: { publish_per_day_cap: 2, content_reject_rounds_cap: 3, response_time_slo_hours: 4 },
        circuit_breaker: { kpi_floor: { sla_hit_rate: 0.9 } },
      },
    ],
    platforms: ["douyin", "xiaohongshu", "bilibili", "shipinhao", "tiktok", "youtube"],
    accounts: [
      { platform: "douyin", handle: "@星芒好物", daily_publish_limit: 5 },
      { platform: "xiaohongshu", handle: "@星芒好物研究所", daily_publish_limit: 3 },
    ],
    forbidden: [
      "禁止使用广告法极限词（最/第一/国家级等）",
      "禁止宣称超出官方口径的功效",
      "禁止虚构商品外观与参数",
    ],
    fact_red_lines: ["宣称不得超出官方口径", "创意前提必须与产品真实使用前提自洽"],
  };
}

/* ================= 主流程 ================= */

async function main() {
  const presets = loadPresets();
  const fences = loadFences();
  const skillsDocs = loadSkills();
  const pipelines = loadPipelines();
  console.log(
    `✓ Bundle 资产读取：${presets.length} preset / ${fences.length} 围栏 / ${skillsDocs.length} 技能 / ${pipelines.length} 管线（${pipelines.join("、")}）`,
  );

  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  const q = (text: string, params: unknown[]) => owner.query(text, params);

  // 租户 / 工作区
  await q(
    `INSERT INTO tenants (id, name, plan) VALUES ($1,'视频经理演示租户','pro') ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID],
  );
  await q(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config)
     VALUES ($1,$2,$3,$4,'ai-video','stable',$5) ON CONFLICT (id) DO NOTHING`,
    [
      WS_ID,
      TENANT_ID,
      WS_NAME,
      WS_SLUG,
      JSON.stringify({
        enabled: true,
        candidateTime: "18:00",
        startTime: "22:00",
        packageTime: "08:00",
        timezone: "Asia/Shanghai",
      }),
    ],
  );
  console.log(`✓ 租户与工作区：demo / ${WS_NAME}`);

  // 人类成员
  for (const m of MEMBERS) {
    await q(
      `INSERT INTO members (id, workspace_id, member_no, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, member_no) DO NOTHING`,
      [`${m.id.toLowerCase()}-id`, WS_ID, m.id, m.name, m.role],
    );
  }
  console.log(`✓ 人类成员 ×${MEMBERS.length}（${MEMBERS.map((m) => m.name).join("、")}）`);

  // 数码员工 preset 实例（人机混编通讯录 IM.5；fence_bindings 原样落库 F2.10）
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
  console.log(`✓ 数码员工 ×${presets.length}（制作班组 21 + 经营班组 12）`);

  // 一企一档（dataMode=simulated：D24 落地向导横幅事实源——种子库即「全模拟运行态」，向导启用真实模式后翻转）
  const archive = { ...studioArchive(), dataMode: "simulated" };
  await q(
    `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
     VALUES ($1,$2,'ai-video',$3,$4,NULL)
     ON CONFLICT (workspace_id) DO UPDATE SET archive = EXCLUDED.archive, forbidden = EXCLUDED.forbidden, updated_at = now()`,
    [WS_ID, TENANT_ID, JSON.stringify(archive), JSON.stringify(archive.forbidden)],
  );
  console.log("✓ 一企一档（含 forbidden 红线 ×3）");

  // 基线围栏装载（G1-G10 系列，active）
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
        JSON.stringify({
          result: r.level === "auto" ? "pass" : r.level === "review" ? "review" : "blocked",
          note: r.note ?? "",
        }),
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
       VALUES ($1,'official','ai-video',$2,'1.0.0',$3,'[]',$4,false)
       ON CONFLICT (id) DO NOTHING`,
      [skillId, s.name, s.description, s.body],
    );
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by)
       VALUES ($1,$2,'MEM-V01') ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
      [skillId, WS_ID],
    );
  }
  console.log(`✓ 官方技能 ×${skillsDocs.length} 已安装`);

  // 工艺技能库注册（203 好莱坞 + 20 营销 → 技能广场可见；team 级已装）
  const craftSkills = loadLibrarySkills();
  for (const s of craftSkills) {
    const skillId = `skill-t-${s.name}`.slice(0, 120);
    await q(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'team','ai-video',$2,'1.0.0',$3,'[]',$4,false)
       ON CONFLICT (id) DO NOTHING`,
      [skillId, s.name, s.description, s.body],
    );
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by)
       VALUES ($1,$2,'MEM-V01') ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
      [skillId, WS_ID],
    );
  }
  console.log(`✓ 工艺技能库 ×${craftSkills.length} 已注册并安装（技能广场可见）`);

  // 自动化触发器（account-ops 管线：采集/战报/评论监听）
  const triggers = [
    {
      id: "tg-metrics-2h",
      name: "账号数据每 2 小时采集",
      kind: "cron",
      schedule: "7 */2 * * *",
      action: { dispatch: "metrics-watcher", template: "metrics.collect" },
    },
    {
      id: "tg-morning-0800",
      name: "早八点经营战报",
      kind: "cron",
      schedule: "0 8 * * *",
      action: { dispatch: "metrics-watcher", template: "report.morning" },
    },
    {
      id: "tg-comments-30m",
      name: "评论每 30 分钟采集分流",
      kind: "cron",
      schedule: "*/30 * * * *",
      action: { dispatch: "comment-operator", template: "comments.ingest" },
    },
    // 数字CEO 节拍（D21：CEO Loop；调度器消费前经治理守卫校验 charter.mode）
    { id: "tg-ceo-brief-0830", name: "公司CEO 晨报 08:30", kind: "cron", schedule: "30 8 * * *", action: { beat: "daily" } },
    { id: "tg-ceo-queue-2h", name: "公司CEO 裁决巡检 2h", kind: "cron", schedule: "7 */2 * * *", action: { beat: "queue" } },
    { id: "tg-ceo-deviation", name: "公司CEO 目标偏差扫描", kind: "cron", schedule: "15 */4 * * *", action: { beat: "deviation" } },
    { id: "tg-ceo-breaker", name: "公司CEO 自治熔断巡检", kind: "cron", schedule: "45 23 * * *", action: { beat: "breaker" } },
  ];
  for (const t of triggers) {
    await q(
      `INSERT INTO triggers (id, workspace_id, name, kind, schedule, action, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,'system:seed') ON CONFLICT (id) DO NOTHING`,
      [t.id, WS_ID, t.name, t.kind, t.schedule, JSON.stringify(t.action)],
    );
  }
  console.log(`✓ 自动化触发器 ×${triggers.length}`);

  // 演示项目 + 渲染脚本（v1）+ 素材（列口径对齐 0009_video_studio.sql）
  await q(
    `INSERT INTO video_projects (id, workspace_id, title, kind, status, created_by)
     VALUES ('vp-demo-001',$1,'星芒保温杯·抖音种草片','marketing','production','MEM-V01')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );
  const demoShots = [
    { shot: "S00", type: "opening", dur: 3, title: "片头·悬念钩子" },
    { shot: "S01", type: "establishing", dur: 8, title: "通勤场景·痛点呈现" },
    { shot: "S02", type: "emotional_climax", dur: 10, title: "24h 保温实测·卖点爆发" },
  ];
  for (const s of demoShots) {
    const md = `# 渲染脚本 · ${s.shot}\n\n- 场景类型: ${s.type}\n- 时长: ${s.dur}s\n\n## 镜头提示词\n\n01.【语言约束】全片中文\n02.【场景】${s.title}\n03.【台词】[00:01] 主角 拿起保温杯, 惊喜 说:"到下午还是烫的！"\n（演示占位字段，正式产出由提示词工程师交付 25/30 字段全量）`;
    await q(
      `INSERT INTO render_scripts (id, workspace_id, project_id, shot_id, script_key, version, status, md, fields, char_check, created_by)
       VALUES ($1,$2,'vp-demo-001',$3,$4,1,'draft',$5,'{}',$6,'MEM-V01')
       ON CONFLICT (id) DO NOTHING`,
      [
        `rs-demo-${s.shot.toLowerCase()}-v1`,
        WS_ID,
        s.shot,
        `rs-demo-${s.shot.toLowerCase()}`,
        md,
        JSON.stringify({ charCount: md.length, withinSpec: true }),
      ],
    );
  }
  await q(
    `INSERT INTO video_assets (id, workspace_id, project_id, chain_id, kind, version, source_url, provenance, license_risk, hero_image_id, sha256, created_by)
     VALUES
       ('va-demo-hero',$1,'vp-demo-001','va-demo-hero','product_image',1,'https://example.invalid/hero.jpg','{"source":"官方旗舰店","verified":true}','low','BRAND-HERO-001','demo-sha-hero-001','MEM-V01'),
       ('va-demo-ref',$1,'vp-demo-001','va-demo-ref','reference_image',1,'https://example.invalid/ref45.jpg','{"source":"官网","verified":true}','low',NULL,'demo-sha-ref-001','MEM-V01')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );
  console.log("✓ 演示项目 vp-demo-001：3 镜渲染脚本 + 2 条素材");

  /* ================= 运行态剧本（饱满演示运行态：事件链/线程/审批/夜班/指标/评论/商单） ================= */

  // —— 演示线程（P1/P2 投影） ——
  const threads = [
    { id: "T-V01", title: "保温杯种草片·三镜渲染", mode: "quest", status: "running", done: 14, total: 19, agent: "agt-director", by: "MEM-V01" },
    { id: "T-V02", title: "抖音评论区差评分流", mode: "agent", status: "pending_review", done: 3, total: 5, agent: "agt-comment-operator", by: "MEM-V02" },
    { id: "T-V03", title: "早八点账号战报", mode: "ask", status: "completed", done: 5, total: 5, agent: "agt-metrics-watcher", by: "MEM-V01" },
  ];
  for (const t of threads) {
    await q(
      `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total, created_by, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [t.id, TENANT_ID, WS_ID, t.title, t.mode, t.status, t.done, t.total, t.by, t.agent],
    );
  }
  console.log(`✓ 演示线程 ×${threads.length}（running / pending_review / completed）`);

  // —— 夜班班次（昨夜：✓14 ◆2 ▲1，清晨决策包已生成） ——
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const runDate = yesterday.toISOString().slice(0, 10);
  await q(
    `INSERT INTO night_runs (id, workspace_id, run_date, status, fence_snapshot_version, candidate_count, stats, started_at, package_event_id)
     VALUES ($1,$2,$3,'package_generated',$4,14,$5,$6,NULL)
     ON CONFLICT (id) DO NOTHING`,
    [
      `nr-video-${runDate}`, WS_ID, runDate, FENCE_VERSION,
      JSON.stringify({ done: 14, pending: 2, alerts: 1, note: "评论分流 47 条 / 数据采集 12 轮 / 谷时渲染 S00 完成 / 早八点战报已生成" }),
      new Date(yesterday.setHours(22, 0, 0, 0)).toISOString(),
    ],
  );
  console.log("✓ 夜班班次（✓14 ◆2 ▲1，清晨决策包已生成）");

  // —— 账号指标时序（近 7 天 × 2 账号） ——
  const metricRows: unknown[][] = [];
  for (let d = 7; d >= 1; d--) {
    const day = new Date(); day.setDate(day.getDate() - d); day.setHours(20, 0, 0, 0);
    const base = 140000 + (7 - d) * 26000;
    metricRows.push([WS_ID, "douyin", "@星芒好物", null, day.toISOString(), base, Math.round(base * 0.031), Math.round(base * 0.012), Math.round(base * 0.008), 420 + (7 - d) * 130]);
    metricRows.push([WS_ID, "xiaohongshu", "@星芒好物研究所", null, day.toISOString(), Math.round(base * 0.22), Math.round(base * 0.011), Math.round(base * 0.02), Math.round(base * 0.006), 96 + (7 - d) * 22]);
  }
  // id 为自增 bigint：按（platform+account_id+captured_at）幂等——已存在同日快照则跳过
  for (const m of metricRows) {
    await q(
      `INSERT INTO account_metrics (workspace_id, platform, account_id, video_id, captured_at, plays, likes, comments, shares, conversions)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
       WHERE NOT EXISTS (SELECT 1 FROM account_metrics WHERE workspace_id=$1 AND platform=$2 AND account_id=$3 AND captured_at=$5)`,
      m as never,
    );
  }
  console.log(`✓ 账号指标时序 ×${metricRows.length}（7 天 × 2 账号）`);

  // —— 评论与回复（17 条：夸赞自动回/咨询待审/危机告警/敏感隔离） ——
  const cmts = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `cm-p${i}`, intent: "praise", body: ["这个颜值真的绝了，已下单！", "保温杯质感超出预期", "跟着博主买准没错"][i % 3], auto: true })),
    { id: "cm-q1", intent: "query", body: "真的能保温 24 小时吗？求实测", auto: false },
    { id: "cm-q2", intent: "query", body: "316 和 304 不锈钢有啥区别？", auto: false },
    { id: "cm-c1", intent: "crisis", body: "用了两周杯盖有点漏水，怎么回事？？", auto: false },
    { id: "cm-s1", intent: "other", body: "（含不当言论，已隔离）", auto: false },
    { id: "cm-s2", intent: "other", body: "（疑似引流广告，已隔离）", auto: false },
  ];
  for (const [i, c] of cmts.entries()) {
    await q(
      `INSERT INTO comments (id, workspace_id, platform, account_id, video_id, platform_comment_id, author, text, intent, route_level, status, collected_at)
       VALUES ($1,$2,'douyin','@星芒好物','vid-s01',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        c.id, WS_ID, `pc-${c.id}`, `user_${i}`, c.body, c.intent,
        c.intent === "praise" ? "auto" : c.intent === "other" ? "block" : "review",
        c.auto ? "replied" : c.intent === "other" ? "blocked" : "pending_review",
        new Date(Date.now() - i * 47 * 60000).toISOString(),
      ],
    );
    if (c.auto) {
      await q(
        `INSERT INTO comment_replies (id, workspace_id, comment_id, text, channel, status, receipt, created_by, created_at)
         VALUES ($1,$2,$3,'谢谢喜欢～记得装温水先温杯，保温更久哦🧡','auto','sent','{"delivered":true}','agt-comment-operator',$4) ON CONFLICT (id) DO NOTHING`,
        [`cr-${c.id}`, WS_ID, c.id, new Date(Date.now() - i * 47 * 60000 + 300000).toISOString()],
      );
    }
  }
  console.log(`✓ 评论 ×${cmts.length}（夸赞自动回 12 / 咨询待审 2 / 危机告警 1 / 敏感隔离 2）`);

  // —— 渲染任务（S00 完成 / S01 排队 / S02 排队）+ 成本台账 ——
  await q(
    `INSERT INTO render_jobs (id, workspace_id, project_id, script_id, script_version, task_id, cost, status, result_url)
     VALUES
       ('rj-s00',$1,'vp-demo-001','rs-demo-s00-v1',1,'sd-task-88210',1.8,'done','https://example.invalid/clips/s00.mp4'),
       ('rj-s01',$1,'vp-demo-001','rs-demo-s01-v1',1,'sd-task-88211',2.1,'submitted',NULL),
       ('rj-s02',$1,'vp-demo-001','rs-demo-s02-v1',1,'sd-task-88212',2.6,'submitted',NULL)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );
  for (const [i, b] of [
    ["bl-s00", "vp-demo-001", "E01", "S00", "render", 1.8],
    ["bl-s01", "vp-demo-001", "E01", "S01", "render", 2.1],
    ["bl-s02", "vp-demo-001", "E01", "S02", "render", 2.6],
  ].entries()) {
    await q(
      `INSERT INTO budget_ledger (workspace_id, project_id, episode, shot_id, cost_kind, amount, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [WS_ID, b[1], b[2], b[3], b[4], b[5], `seed-${b[0]}`],
    );
  }
  console.log("✓ 渲染任务 ×3 + 成本台账 ×3（S00 已交付 / S01·S02 排队）");

  // —— 商单样本（履约中 ×1 + 报价请示 ×1） ——
  await q(
    `INSERT INTO deal_orders (id, workspace_id, brand, contact, amount, quote_band, channel, lead_comment_id, project_id, status, payment_terms, created_by)
     VALUES
       ('do-demo-001',$1,'星芒家居','王 PR',88000,'[0.9,1.2]','dm',NULL,'vp-demo-001','fulfilling','{"net30":true}','agt-deal-manager'),
       ('do-demo-002',$1,'山岚户外','陈媒介',45000,'[0.9,1.2]','dm',NULL,NULL,'quoting','{}','agt-deal-manager')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );
  await q(
    `INSERT INTO deal_milestones (id, workspace_id, order_id, kind, due_at, status, created_by)
     VALUES
       ('dm-001',$1,'do-demo-001','draft_v1',$2,'done','agt-deal-manager'),
       ('dm-002',$1,'do-demo-001','acceptance',$3,'pending','agt-deal-manager'),
       ('dm-003',$1,'do-demo-001','payment',$4,'pending','agt-deal-manager')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 86400e3).toISOString(), new Date(Date.now() + 2 * 86400e3).toISOString(), new Date(Date.now() + 25 * 86400e3).toISOString()],
  );
  console.log("✓ 商单样本 ×2（履约中 ¥88,000 / 报价请示中 ¥45,000）");

  // —— 五元事件链（gateway 角色写入；100 条，60% 落夜班窗口） ——
  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT_ID]);
  await gw.query("SELECT set_config('app.workspace_id', $1, false)", [WS_ID]);

  const agentWho = (key: string) => {
    const p = presets.find((x) => x.preset_key === key);
    return { type: "agent" as const, id: key, version: p?.version ?? "v1.0" };
  };
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const times: Date[] = [];
  for (let i = 0; i < 100; i++) {
    let t: number;
    if (i % 5 < 3) {
      const ns = new Date(dayStart); ns.setDate(ns.getDate() - 1); ns.setHours(22, 0, 0, 0);
      const ne = new Date(dayStart); ne.setHours(8, 30, 0, 0);
      t = ns.getTime() + ((i * 7919) % 1000) / 1000 * (ne.getTime() - ns.getTime());
    } else {
      t = dayStart.getTime() - 86400e3 + ((i * 104729) % 1000) / 1000 * (now - (dayStart.getTime() - 86400e3));
    }
    times.push(new Date(t));
  }
  times.sort((a, b) => a.getTime() - b.getTime());

  const EVENT_BASE_V = 6600;
  const mkEvent = (i: number, time: Date) => {
    const id = `E-${EVENT_BASE_V + i}`;
    const scene = i % 10;
    const ctx = { tenant_id: TENANT_ID, workspace_id: WS_ID, time: time.toISOString(), stage: "stable", store: WS_NAME };
    const receipt = { synced: true, snapshot_uri: `data/snapshots/${id.toLowerCase()}.png`, verified_at: new Date(time.getTime() + 45000).toISOString() };
    const mt = { model_id: "mock-video-001", tier: "standard", window: time.getHours() >= 22 || time.getHours() < 8 ? "off-peak" : "peak", credits: 1 };
    switch (scene) {
      case 0: return { event_id: id, who: agentWho("render-operator"), context: ctx, object: { type: "render_job", id: "rj-s01", label: "S01 通勤痛点" }, decision: { action: "render.submit", after: { taskId: "sd-task-88211", cost: 2.1 }, basis: ["G8 审批通过（E-6605）", "谷时窗口费率 ≤20%"] }, rule_impact: [{ rule_id: "G8", version: FENCE_VERSION, result: "pass" }], receipt, model_trace: mt };
      case 1: return { event_id: id, who: agentWho("comment-operator"), context: ctx, object: { type: "comment", id: `cm-p${i % 12}`, label: "夸赞评论" }, decision: { action: "comment.reply", after: { mode: "auto" }, basis: ["G10a 夸赞/感谢类自动回复"] }, rule_impact: [{ rule_id: "G10a", version: FENCE_VERSION, result: "pass" }], receipt, model_trace: mt };
      case 2: return { event_id: id, who: agentWho("metrics-watcher"), context: ctx, object: { type: "account_metric", id: `am-dy-${(i % 7) + 1}`, label: "抖音账号快照" }, decision: { action: "metrics.collect", after: { plays: 328000, finishes: 0.384 }, basis: ["每 2h 定时采集"] }, rule_impact: [], receipt, model_trace: mt };
      case 3: return { event_id: id, who: agentWho("publish-operator"), context: ctx, object: { type: "publish_task", id: "pt-douyin-001", label: "保温杯切片·抖音" }, decision: { action: "publish.execute", after: { platform: "douyin", url: "https://example.invalid/p/001" }, basis: ["G9 审批通过", "模拟人工节奏"] }, rule_impact: [{ rule_id: "G9", version: FENCE_VERSION, result: "pass" }], receipt, model_trace: mt };
      case 4: return { event_id: id, who: agentWho("captain"), context: ctx, object: { type: "video_project", id: "vp-demo-001", label: "星芒保温杯种草片" }, decision: { action: "ceo.decision", after: { tier: "l2_captain", topic: "发布排期错峰调整", expected: "黄金时段 CTR +8%" }, basis: ["宪章自治边界内", "近 7 日 20:00 档 CTR 最高"] }, rule_impact: [], receipt, model_trace: mt };
      case 5: return { event_id: id, who: agentWho("captain"), context: ctx, object: { type: "workspace", id: WS_ID, label: WS_NAME }, decision: { action: "ceo.briefing", after: { text: "董事长，早报已备：昨日我裁决 14 件（L2 下沉率 86%），全平台播放 32.8w（▲18.2%）；2 件谨慎上浮请您定——年度商单框架、Dou+ 加投超营销上限。试用期第 2 天，边界降一档执行中。" }, basis: ["CEO Loop 日频晨报 08:30"] }, rule_impact: [], receipt, model_trace: mt };
      case 6: return { event_id: id, who: agentWho("creative-planner"), context: ctx, object: { type: "theme", id: "theme-001", label: "早八地铁烫嘴实录" }, decision: { action: "theme.confirm", after: { approved: true }, basis: ["G2 审批通过", "情报档案 E-6601 证据锚点"] }, rule_impact: [{ rule_id: "G2", version: FENCE_VERSION, result: "pass" }], receipt, model_trace: mt };
      case 7: return { event_id: id, who: agentWho("prompt-fuser"), context: ctx, object: { type: "prompt_package", id: "pp-s01", label: "S01 镜头提示词包" }, decision: { action: "prompt.confirm", after: { approved: true, score: 4.6 }, basis: ["G6 审批通过", "导演评审 5 维 4.5/5"] }, rule_impact: [{ rule_id: "G6", version: FENCE_VERSION, result: "pass" }], receipt, model_trace: mt };
      case 8: return { event_id: id, who: agentWho("metrics-watcher"), context: ctx, object: { type: "account_metric", id: "alert-001", label: "小红书收藏率告警" }, decision: { action: "threshold.check", after: { level: "P1", metric: "save_rate", drop: "1.8%→0.9%" }, basis: ["阈值 1.2% drop_ratio 触发"] }, rule_impact: [], receipt, model_trace: mt };
      default: return { event_id: id, who: agentWho("comment-operator"), context: ctx, object: { type: "comment", id: "cm-c1", label: "漏水投诉评论" }, decision: { action: "comment.escalate", after: { level: "review+alert" }, basis: ["G10c 负面/投诉必审+告警"] }, rule_impact: [{ rule_id: "G10c", version: FENCE_VERSION, result: "review" }], receipt, model_trace: mt };
    }
  };

  const lastHash = await gw.query(`SELECT hash FROM biz_events WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1`, [TENANT_ID]);
  let prevHash = (lastHash.rows[0]?.hash as string) ?? "GENESIS";
  const sessionOf = (scene: number) => (scene === 0 || scene === 6 || scene === 7 ? "T-V01" : scene === 1 || scene === 9 ? "T-V02" : scene === 5 || scene === 2 || scene === 8 ? "T-V03" : null);
  let inserted = 0;
  for (let i = 1; i <= 100; i++) {
    const ev = mkEvent(i, times[i - 1] as Date);
    const checked = safeParseBusinessEvent(ev);
    if (!checked.success) throw new Error(`种子事件 ${ev.event_id} 未过校验：${checked.error.message}`);
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query(
      `INSERT INTO biz_events (event_id, tenant_id, workspace_id, session_id, payload, prev_hash, hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING seq`,
      [ev.event_id, TENANT_ID, WS_ID, sessionOf(i % 10), payload, prevHash, hash, (ev.context as { time: string }).time],
    );
    if (res.rowCount && res.rowCount > 0) { prevHash = hash; inserted++; }
  }
  console.log(`✓ 五元事件链 ×${inserted}（哈希链续接，可验链）`);

  // —— 待批请示（P4 决断队列 / P21 董事长视图 / 剧场聚光灯） ——
  const approvalsSeed = [
    { aid: "apr-v-001", eid: `E-${EVENT_BASE_V + 10}`, tier: "l2_captain", title: "提交渲染任务", snapshot: { title: "S01 镜提交渲染", action: "render.submit", params: { shotId: "S01", estimate_credits: 3, estimate_cost: 2.1 }, gate: "G8", ceo_rationale: "导演评审 4.5/5 已通过，谷时窗口成本最优", contentMd: "# 渲染请示 · S01\n\n预计消耗 3 积分（约 ¥2.1），谷时窗口。" } },
    { aid: "apr-v-002", eid: `E-${EVENT_BASE_V + 20}`, tier: "l4_chairman", title: "签订年度框架商单", snapshot: { title: "签订年度框架商单 · 需要你拍板", action: "deal.quote", params: { brand: "星芒家居", amount: 88000, term: "12个月" }, gate: "G15", ceo_rationale: "报价已按 deal-flow 完成锚定，履约排期与产能无冲突，建议批准——金额超采购上限，谨慎上浮请您定。" } },
    { aid: "apr-v-003", eid: `E-${EVENT_BASE_V + 30}`, tier: "l4_chairman", title: "Dou+ 加投 ¥3,000", snapshot: { title: "Dou+ 加投 ¥3,000 · 需要你拍板", action: "ads.boost", params: { video: "通勤痛点切片", amount: 3000, window: "24h" }, gate: "G12", ceo_rationale: "切片正处推荐池爬升期（4.1w→12.6w），加投 ROI 预估 1:3.2；但超试用期营销上限，请您定。" } },
  ];
  for (const a of approvalsSeed) {
    await q(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, tier, snapshot)
       VALUES ($1,$2,$3,$4,'inapp','pending',$5,$6)
       ON CONFLICT (event_id, channel) DO NOTHING`,
      [a.aid, TENANT_ID, WS_ID, a.eid, a.tier, JSON.stringify(a.snapshot)],
    );
  }
  console.log("✓ 待批请示 ×3（L2 渲染 ×1 + L4 董事长 ×2）");

  await gw.end();
  console.log("✓ 运行态剧本完成（剧场/职场/晨报/实况/审批/评论/商单全量有数）");

  // ============ AI 服务前台 · 星芒好物 C 端运行态 ============
  const svcQ = (text: string, params: unknown[]) => owner.query(text, params);
  await svcQ(
    `INSERT INTO c_users (id, workspace_id, channel, openid, nickname, member_id, created_at)
     VALUES ('cu-chenxiaoyu', $1, 'wechat-mini', 'openid-chenxiaoyu', '陈小予', 'M-XM-6688', $2)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 15 * 86400000).toISOString()],
  );
  await svcQ(
    `INSERT INTO kb_collections (id, workspace_id, name, description)
     VALUES ('kbc-after-sale', $1, '售后服务政策', '星芒好物退换货、质保与物流政策')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );
  const afterSaleMd = `# 星芒好物售后服务政策\n\n## 退换货\n签收后 7 天无理由退换（保温杯需未使用、包装完好）；质量问题 30 天内免费换新。\n\n## 质保\n保温杯整机质保 2 年，杯盖密封圈等易损件 1 年免费补发。\n\n## 物流\n默认顺丰，16:00 前下单当日发；新疆西藏时效 +3 天。`;
  await svcQ(
    `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, version, status, content_md, hash, created_at)
     VALUES ('kbd-after-sale', $1, 'kbc-after-sale', '售后服务政策', 'manual', 1, 'active', $2, 'seed-hash-aftersale', $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, afterSaleMd, new Date(Date.now() - 10 * 86400000).toISOString()],
  );
  const asChunks: [number, string, string][] = [
    [0, '退换货', '签收后 7 天无理由退换（保温杯需未使用、包装完好）；质量问题 30 天内免费换新。'],
    [1, '质保', '保温杯整机质保 2 年，杯盖密封圈等易损件 1 年免费补发。'],
    [2, '物流', '默认顺丰，16:00 前下单当日发；新疆西藏时效 +3 天。'],
  ];
  for (const [idx, heading, content] of asChunks) {
    await svcQ(
      `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content)
       SELECT $1,'kbd-after-sale',$2,$3,$4
       WHERE NOT EXISTS (SELECT 1 FROM kb_chunks WHERE document_id='kbd-after-sale' AND chunk_index=$2)`,
      [WS_ID, idx, heading, content],
    );
  }
  await svcQ(
    `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel, status, created_at, last_message_at)
     VALUES ('cv-xm-001', $1, 'cu-chenxiaoyu', 'wechat-mini', 'open', $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 5 * 3600000).toISOString(), new Date(Date.now() - 5 * 3600000 + 60000).toISOString()],
  );
  const xmMsgs: [string, string, string, number, string, number][] = [
    ['user', '保温杯用了两周就不保温了，能换吗？', '', 0, '[]', 0],
    ['assistant', '【质保】可以。保温杯整机质保 2 年，不保温属质量问题，30 天内免费换新。我可以直接为您生成换新工单，您看可以吗？', 'kb_qa', 0.94, JSON.stringify([{ documentTitle: '售后服务政策', heading: '质保', content: '整机质保 2 年，质量问题 30 天内免费换新。' }]), 23],
  ];
  for (let i = 0; i < xmMsgs.length; i++) {
    const m = xmMsgs[i]!;
    await svcQ(
      `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms, created_at)
       SELECT $1,'cv-xm-001',$2,$3,$4,$5,$6::jsonb,$7,$8
       WHERE NOT EXISTS (SELECT 1 FROM c_messages WHERE conversation_id='cv-xm-001' AND content=$3)`,
      [WS_ID, m[0], m[1], m[2] || null, m[3] || null, m[4], m[5] || null, new Date(Date.now() - 5 * 3600000 + i * 30000).toISOString()],
    );
  }
  const xmTickets: [string, string, string, string, string, string, string | null, number][] = [
    ['tck-xm-001', 'cu-chenxiaoyu', 'cv-xm-001', 'repair', '保温杯不保温·申请换新', 'processing', 'high', '售后部', 5],
    ['tck-xm-002', 'cu-chenxiaoyu', null, 'other', '发票补开（订单 XM-20771）', 'done', 'normal', '财务部', 26],
  ];
  for (const t of xmTickets) {
    await svcQ(
      `INSERT INTO c_tickets (id, workspace_id, c_user_id, conversation_id, kind, title, payload, status, priority, dept, sla_due_at, result, idempotency_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8,$9,$10,$11,$12,$13,$13)
       ON CONFLICT (id) DO NOTHING`,
      [t[0], WS_ID, t[1], t[2], t[3], t[4], t[5], t[6], t[7],
       new Date(Date.now() + 4 * 3600000).toISOString(),
       t[5] === 'done' ? JSON.stringify({ text: '电子发票已发送至您的微信卡包，请查收。', rating: { score: 5 } }) : null,
       `seed-${t[0]}`, new Date(Date.now() - t[8] * 3600000).toISOString()],
    );
  }
  const xmTl: [string, string, string, string, string, number][] = [
    ['tck-xm-001', 'create', 'c_user', 'cu-chenxiaoyu', '对话中确认换新', 300],
    ['tck-xm-001', 'assign', 'agent', 'agt-service-desk', '智能分派 → 售后部', 299],
    ['tck-xm-001', 'start', 'staff', '售后-小赵', '已核对订单，安排换新发出', 240],
    ['tck-xm-002', 'create', 'c_user', 'cu-chenxiaoyu', '自助提交', 1560],
    ['tck-xm-002', 'complete', 'staff', '财务-小钱', '电子发票已开具并推送', 1500],
  ];
  for (const e of xmTl) {
    await svcQ(
      `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail, created_at)
       SELECT $1,$2,$3,$4,$5,$6::jsonb,$7
       WHERE NOT EXISTS (SELECT 1 FROM c_ticket_events WHERE ticket_id=$2 AND action=$3 AND actor_id=$4)`,
      [WS_ID, e[0], e[1], e[2], e[3], JSON.stringify({ note: e[4] }), new Date(Date.now() - e[5] * 60000).toISOString()],
    );
  }
  await svcQ(
    `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status, created_at)
     SELECT $1,'cu-chenxiaoyu','wechat-mini','ticket.accepted',$2::jsonb,'mock','delivered',$3
     WHERE NOT EXISTS (SELECT 1 FROM c_notifications WHERE c_user_id='cu-chenxiaoyu' AND kind='ticket.accepted')`,
    [WS_ID, JSON.stringify({ text: '您的换新工单「保温杯不保温·申请换新」已受理，售后部处理中。', mock: true }), new Date(Date.now() - 299 * 60000).toISOString()],
  );
  console.log("✓ AI 服务前台运行态（星芒好物）：用户/售后政策知识库/会话/工单×2/时间线/通知");

  await owner.end();
  console.log("\n视频经理演示种子完成。下一步：pnpm dev 后在舰桥查看（ws-video 工作区）。");
}

main().catch((err) => {
  console.error("seed-video 失败：", err);
  process.exit(1);
});
