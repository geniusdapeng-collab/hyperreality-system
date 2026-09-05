/**
 * seed-aipm · AI 产品经理行业示例包种子（方案 V4 §12/P0）
 * 用法：DATABASE_URL=... tsx scripts/seed-aipm.ts
 * 内容：demo 租户 / 「织元产品部」工作区（is_example=true）/ 3 人类成员 /
 *      ai-pm 8 preset 实例 / R-PM1-7 基线围栏 / 8 技能安装 /
 *      业务种子（需求池/竞档/指标/反馈/文档进知识库）/ 审批样例 / 晨报 /
 *      夜班编排 / bundle_installs 装配台账登记（一键清空依据）
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import YAML from "yaml";

import { fileURLToPath } from "node:url";
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles/ai-pm");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";

const TENANT_ID = "demo";
const WS_ID = "ws-aipm-demo";
const WS_SLUG = "ai-pm-demo";
const WS_NAME = "织元产品部（AI 产品经理示例团队）";

interface Preset {
  preset_key: string; name: string; version: string; kind: string;
  description: string; readonly: boolean; night_shift: boolean; high_risk: boolean;
  fence_bindings: string[]; skills: string[];
  tools: Array<{ name: string; access: string; desc: string }>;
  prompt: Record<string, unknown>;
}
interface FenceRule { rule_id: string; name: string; level: string; match: Record<string, unknown>; when?: Record<string, unknown>; note?: string }
interface SkillDoc { name: string; description: string; body: string; fenceBindings: string[] }

function loadPresets(): Preset[] {
  const dir = join(BUNDLE_DIR, "presets");
  return readdirSync(dir).filter((f) => f.endsWith(".yml")).map((f) => YAML.parse(readFileSync(join(dir, f), "utf-8")) as Preset);
}
function loadFences(): FenceRule[] {
  const file = readdirSync(join(BUNDLE_DIR, "fences")).find((f) => f.endsWith(".yml"))!;
  const doc = YAML.parse(readFileSync(join(BUNDLE_DIR, "fences", file), "utf-8")) as { fences: FenceRule[] };
  return doc.fences;
}
function loadSkills(): SkillDoc[] {
  const dir = join(BUNDLE_DIR, "skills");
  return readdirSync(dir).map((d) => {
    const raw = readFileSync(join(dir, d, "SKILL.md"), "utf-8");
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    const fm = m ? (YAML.parse(m[1]!) as { name: string; description: string }) : { name: d, description: "" };
    return { name: fm.name, description: fm.description, body: raw, fenceBindings: [] };
  });
}
function loadSeed<T>(file: string): T {
  return JSON.parse(readFileSync(join(BUNDLE_DIR, "seeds", file), "utf-8")) as T;
}

const MEMBERS = [
  { id: "MEM-001", name: "董事长", role: "owner" },
  { id: "MEM-002", name: "产品负责人", role: "manager" },
  { id: "MEM-003", name: "运营同学", role: "readonly" },
];

async function main(): Promise<void> {
  const presets = loadPresets();
  const fences = loadFences();
  const skillsDocs = loadSkills();
  console.log(`✓ ai-pm Bundle 资产：${presets.length} preset / ${fences.length} 围栏 / ${skillsDocs.length} 技能`);

  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  const q = (text: string, params: unknown[]) => owner.query(text, params);

  await q(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING`, [TENANT_ID, "织元演示租户"]);
  await q(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config, bundle_id, is_example)
     VALUES ($1,$2,$3,$4,'ai-pm','stable',$5,'ai-pm',true) ON CONFLICT (id) DO UPDATE SET bundle_id='ai-pm', is_example=true`,
    [WS_ID, TENANT_ID, WS_NAME, WS_SLUG, JSON.stringify({ enabled: true, candidateTime: "18:00", startTime: "22:00", packageTime: "08:30", timezone: "Asia/Shanghai" })],
  );
  console.log(`✓ 租户与工作区：demo / ${WS_NAME}（is_example=true）`);

  for (const m of MEMBERS) {
    await q(
      `INSERT INTO members (id, workspace_id, member_no, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, member_no) DO NOTHING`,
      [`${m.id.toLowerCase()}-${WS_ID}-id`, WS_ID, m.id, m.name, m.role],
    );
  }
  console.log(`✓ 人类成员 ×${MEMBERS.length}`);

  for (const p of presets) {
    await q(
      `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)
       ON CONFLICT (id) DO NOTHING`,
      [`agt-${p.preset_key}`, WS_ID, p.preset_key, p.name, p.version, p.kind, p.readonly,
       JSON.stringify(p.fence_bindings), JSON.stringify(p.skills),
       JSON.stringify({ description: p.description, night_shift: p.night_shift, high_risk: p.high_risk, tools: p.tools, prompt: p.prompt })],
    );
  }
  console.log(`✓ Agent 实例 ×${presets.length}（AI 产品经理团队 8 员）`);

  for (const r of fences) {
    await q(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,'v1',$3,$4,$5,$6,$7,false,'active','system:seed')
       ON CONFLICT (rule_id, version, workspace_id) DO NOTHING`,
      [`fr-${r.rule_id.toLowerCase()}-v1-${WS_ID}`, r.rule_id, WS_ID, r.name, r.level,
       JSON.stringify(r.match), JSON.stringify({ result: r.level === "auto" ? "pass" : r.level === "review" ? "review" : "blocked" })],
    );
  }
  console.log(`✓ 基线围栏 ×${fences.length}（active）`);

  for (const s of skillsDocs) {
    const skillId = `skill-${s.name}`;
    await q(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'official','ai-pm',$2,'1.0.0',$3,'[]',$4,false)
       ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body, version=EXCLUDED.version
       WHERE skills.version IS DISTINCT FROM EXCLUDED.version`,
      [skillId, s.name, s.description, s.body],
    );
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
       SELECT s.id, $2, 'MEM-001', s.fence_bindings, s.version FROM skills s WHERE s.id=$1
       ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
      [skillId, WS_ID],
    );
  }
  console.log(`✓ 技能 ×${skillsDocs.length} 已安装`);

  // —— 业务种子进知识库（需求池/竞档/指标/反馈/文档） ——
  const colDefs: Array<{ name: string; desc: string; file: string; titleOf: (x: Record<string, unknown>, i: number) => string; items: (d: unknown) => Array<Record<string, unknown>> }> = [
    { name: "需求池", desc: "产品需求分诊台账", file: "requirements.json",
      items: (d) => (d as { items: Array<Record<string, unknown>> }).items,
      titleOf: (x) => `${x.id} ${x.title}` },
    { name: "竞品档案", desc: "竞品追踪与对比报告", file: "competitors.json",
      items: (d) => (d as { competitors: Array<Record<string, unknown>> }).competitors,
      titleOf: (x) => `${x.name}（${x.track}）威胁:${x.threat}` },
    { name: "用户反馈", desc: "反馈聚类与情绪", file: "feedback.json",
      items: (d) => (d as { items: Array<Record<string, unknown>> }).items,
      titleOf: (x) => `${x.id} [${x.type}] ${x.text}` },
    { name: "产出档案", desc: "PRD/报告/发布说明", file: "documents.json",
      items: (d) => (d as { documents: Array<Record<string, unknown>> }).documents,
      titleOf: (x) => `${x.title}` },
  ];
  for (const col of colDefs) {
    const colId = `kc-${WS_ID}-${col.name}`;
    await q(
      `INSERT INTO kb_collections (id, workspace_id, name, description) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [colId, WS_ID, col.name, col.desc],
    );
    const data = loadSeed<unknown>(col.file);
    const items = col.items(data);
    for (const [i, item] of items.entries()) {
      const title = col.titleOf(item, i);
      await q(
        `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
         VALUES ($1,$2,$3,$4,'manual',NULL,1,'active',$5,$6,now())
         ON CONFLICT (id) DO NOTHING`,
        [`kd-${WS_ID}-${col.name}-${i}`, WS_ID, colId, title, JSON.stringify(item, null, 1), `seedhash-${col.name}-${i}`],
      );
    }
    console.log(`✓ 知识集「${col.name}」×${items.length}`);
  }

  // —— 审批样例（方案 §12 approvals.json） ——
  const approvals = loadSeed<{ items: Array<{ title: string; from: string; kind: string }> }>("approvals.json");
  for (const [i, a] of approvals.items.entries()) {
    const evId = `ev-seed-aipm-apr-${i}`;
    await q(
      `INSERT INTO biz_events (event_id, tenant_id, workspace_id, seq, payload, prev_hash, hash)
       VALUES ($1,$2,$3,(SELECT COALESCE(MAX(seq),0)+1 FROM biz_events WHERE workspace_id=$3),$4,'',$5)
       ON CONFLICT DO NOTHING`,
      [evId, TENANT_ID, WS_ID,
       JSON.stringify({
         who: { type: "agent", id: a.from },
         context: { tenant_id: TENANT_ID, workspace_id: WS_ID, time: new Date().toISOString(), channel: "inapp" },
         object: { type: "approval", id: `apr-seed-aipm-${i}` },
         decision: { action: a.kind, after: { title: a.title } },
         rule_impact: [{ result: "review" }],
       }),
       `seedhash-${evId}`],
    );
    await q(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, gesture, snapshot, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,'inapp','pending',NULL,$5,NULL,NULL)
       ON CONFLICT (event_id, channel) DO NOTHING`,
      [`apr-seed-aipm-${i}`, TENANT_ID, WS_ID, evId,
       JSON.stringify({ action: a.kind, after: { title: a.title }, expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })],
    );
  }
  console.log(`✓ 审批样例 ×${approvals.items.length}（pending）`);

  // 晨报由夜班节拍运行时真实生成（night-shift/captain，系统无静态晨报表）——不在种子内伪造
  console.log("✓ 晨报：运行时夜班生成（种子不伪造）");

  // —— 行业考题（考试院 ai-pm 科目；eval/questions.json → eval_questions） ——
  try {
    const evalPack = JSON.parse(readFileSync(join(BUNDLE_DIR, "eval/questions.json"), "utf-8")) as { questions: Array<Record<string, unknown>> };
    for (const [i, qu] of evalPack.questions.entries()) {
      await q(
        `INSERT INTO eval_questions
           (id, workspace_id, subject, structure, primary_dimensions, red_line, difficulty, source, tags, scenario, assertions, judge_rubric, holdout)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'seed',$8,$9,$10,$11,false)
         ON CONFLICT (id) DO NOTHING`,
        [
          `evq-aipm-seed-${i}`, WS_ID, qu.subject, qu.structure,
          JSON.stringify(qu.primary_dimensions), qu.red_line, qu.difficulty,
          JSON.stringify(qu.tags ?? []), JSON.stringify(qu.scenario),
          JSON.stringify(qu.assertions ?? []), qu.judgeRubric ? JSON.stringify(qu.judgeRubric) : null,
        ],
      );
    }
    console.log(`✓ 行业考题 ×${evalPack.questions.length}`);
  } catch (e) {
    console.log("  （行业考题注入跳过：", (e as Error).message.slice(0, 60), "）");
  }

  // —— bundle_installs 装配台账（一键清空的精确卸载依据，方案 V4 §3） ——
  await q(
    `INSERT INTO bundle_installs (id, workspace_id, bundle_id, assets, status)
     VALUES ($1,$2,'ai-pm',$3,'active')
     ON CONFLICT (id) DO NOTHING`,
    [`bi-${WS_ID}-ai-pm`, WS_ID,
     JSON.stringify({
       preset_ids: presets.map((p) => `agt-${p.preset_key}`),
       fence_rule_ids: fences.map((r) => `fr-${r.rule_id.toLowerCase()}-v1-${WS_ID}`),
       skill_ids: skillsDocs.map((s) => `skill-${s.name}`),
       kb_collection_ids: colDefs.map((c) => `kc-${WS_ID}-${c.name}`),
       seed_batch_id: `seed-aipm-${WS_ID}`,
     })],
  );
  console.log("✓ 装配台账登记（bundle_installs，清空可精确卸载）");

  await owner.end();
  console.log(`\n✅ ai-pm 示例包装配完成：${WS_NAME}——打开客户端即见 AI 产品经理团队在岗`);
}

main().catch((e) => { console.error("seed-aipm 失败:", e); process.exit(1); });
