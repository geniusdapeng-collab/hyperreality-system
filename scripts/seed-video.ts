/**
 * seed-video.ts —— 视频经理（ai-video Bundle）演示种子
 *
 * 与 scripts/seed.ts（酒店 Bundle）同构，装载：
 *  - 演示租户/工作区（industry: ai-video）
 *  - 人类成员（主理人/运营/剪辑）
 *  - bundles/ai-video 的 25 个数码员工 preset（含 fence_bindings 原样落库）
 *  - ai-video-baseline/v1 基线围栏（G1-G10 + G9a/G9b + G10a-d）
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles/ai-video");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";

/* ================= 固定演示标识（幂等键） ================= */

const TENANT_ID = "tenant-demo";
const WS_ID = "ws-video";
const WS_NAME = "视频经理 · 演示工作室";
const WS_SLUG = "video-studio";
const FENCE_VERSION = "ai-video-baseline/v1";

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
    // 数字CEO 宪章（D21，内容制作行业版，演示：试用期第 2 天）
    charter: {
      version: 1,
      mode: "trial",
      identity: { name: "公司CEO", persona: "内容经营型" },
      autonomy: { price_band: [0.85, 1.15], procurement_cap: 5000, campaign_cap: 2000 },
      escalate: ["对外公开承诺（赔偿/免费/声明）", "广告法敏感口径", "围栏规则放宽（任何放宽）", "新平台/新账号上线", "月累计投流超上限", "宪章变更"],
      briefing: { daily: "08:30", weekly: "Mon 09:00", monthly: "1st 10:00", channel: "both" },
      circuit_breaker: { window_days: 14, kpi_floor: { publish_rate: 0.8 }, tightened: false },
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
  console.log(
    `✓ Bundle 资产读取：${presets.length} preset / ${fences.length} 围栏 / ${skillsDocs.length} 技能`,
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
  console.log(`✓ 数码员工 ×${presets.length}（制作班组 21 + 经营班组 4）`);

  // 一企一档
  const archive = studioArchive();
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

  await owner.end();
  console.log("\n视频经理演示种子完成。下一步：pnpm dev 后在舰桥查看（ws-video 工作区）。");
}

main().catch((err) => {
  console.error("seed-video 失败：", err);
  process.exit(1);
});
