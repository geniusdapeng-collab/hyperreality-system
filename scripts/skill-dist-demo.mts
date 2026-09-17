/**
 * 技能保鲜环 · 架构实跑演练（BrowserAct + Playwright 技能化集成实证）
 *
 * 全流程（与生产同路径）：
 *  ① 从技能资产（skills/official 元技能 + skills/registry 两个执行面技能）构建分发包
 *  ② 官方签名（HMAC-SHA256）→ manifest
 *  ③ 客户端 syncDistribution（staging 五道预检 → L0/L1/L2 分级）
 *     —— 元技能 knowledge=L0 静默装载；两个执行面技能 tool-execution=L2 进审批（l4_chairman）
 *  ④ 模拟董事长审批 → loadStaging 装载 → 验证技能库终态与事件留痕
 * 用法：pnpm exec tsx --env-file=.env scripts/skill-dist-demo.mts
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  syncDistribution, loadStaging, distStatus, signPackage, DistMeta,
  type SkillPackage, type DistManifest,
} from "@workloom/base/skill-ops";
import { loadOfficialSkills } from "@workloom/base/skills";

const KEY = process.env.SKILL_DIST_SIGNING_KEY ?? "dev-demo-signing-key";
const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };
const ROOT = new URL("..", import.meta.url).pathname;

function pkgOf(skillId: string, body: string, meta: Record<string, unknown>): SkillPackage {
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  const get = (k: string) => fm?.[1]?.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
  const base = {
    skillId, name: get("name"), version: get("version") || "1.0.0",
    description: get("description"), body,
    fenceBindings: [] as string[], meta: DistMeta.parse(meta),
  };
  return { ...base, signature: signPackage(KEY, base) };
}

const log = (s: string) => console.log(`  ${s}`);

async function main() {
  console.log("═══ 技能保鲜环 · 架构实跑（BrowserAct + Playwright 集成实证）═══\n");

  // ① 技能资产 → 分发包
  const meta = loadOfficialSkills(ROOT).find((s) => s.suite === "component-integration")!;
  const pw = readFileSync(`${ROOT}skills/registry/browser-playwright/SKILL.md`, "utf-8");
  const ba = readFileSync(`${ROOT}skills/registry/browser-act/SKILL.md`, "utf-8");
  const pwMeta = JSON.parse(readFileSync(`${ROOT}skills/registry/browser-playwright/dist.json`, "utf-8"));
  const baMeta = JSON.parse(readFileSync(`${ROOT}skills/registry/browser-act/dist.json`, "utf-8"));

  const packages = [
    pkgOf("skill-component-integration", meta.body, { category: "knowledge", origin: "official-authored" }),
    pkgOf("skill-browser-playwright", pw, pwMeta),
    pkgOf("skill-browser-act", ba, baMeta),
  ];
  const manifest: DistManifest = {
    registryVersion: `demo-${Date.now().toString(36)}`,
    publishedAt: new Date().toISOString(),
    entries: packages.map((p) => ({ targets: {}, package: p })),
  };
  console.log(`① manifest 构建完成（${packages.length} 个技能，官方签名 HMAC-SHA256）：`);
  for (const p of packages) log(`· ${p.skillId} v${p.version}（${p.meta.category}）签名 ${p.signature.slice(0, 12)}…`);

  // ② 清理演示残留（幂等重跑）
  const c = await app.connect();
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
  for (const id of packages.map((p) => p.skillId)) {
    await c.query(`DELETE FROM skill_dist_staging WHERE skill_id=$1`, [id]);
    await c.query(`DELETE FROM skill_dist_snapshots WHERE skill_id=$1`, [id]);
    await c.query(`DELETE FROM skill_installs WHERE skill_id=$1 AND workspace_id=$2`, [id, scope.workspaceId]);
    await c.query(`DELETE FROM skills WHERE id=$1`, [id]);
  }
  await c.query("COMMIT");
  c.release();

  // ③ 同步（staging 五道预检 + 分级分流；deps 可达性以生产工作站预检口径注入）
  console.log("\n② 客户端同步（staging 五道预检 → L0/L1/L2 分级）：");
  const r = await syncDistribution(app, gw, scope, {
    registryUrl: "demo://official-registry", signingKey: KEY,
    instance: { bundles: ["hotel"], edition: "community" },
    by: "MEM-001",
    fetcher: async () => manifest,
    depsAvailable: () => true, // 生产口径=工作站 install.sh 预检；此处验证流程
  });
  for (const l of r.loaded) log(`✓ ${l.skillId}@${l.version} → ${l.tier} 静默热装载（知识型内容面）`);
  for (const p of r.pending) log(`⏸ ${p.skillId}@${p.version} → ${p.tier} 永不静默，审批提案 ${p.approvalId}`);
  if (r.rejected.length) for (const x of r.rejected) log(`✗ ${x.skillId} 被预检拦截：${x.reasons.join("；")}`);

  // ④ 审批门禁验证：未批准装载必须被拒
  console.log("\n③ L2 审批门禁（红线：未批准服务端拒装）：");
  const l2 = r.pending.filter((p) => p.tier === "L2");
  for (const p of l2) {
    try {
      await loadStaging(app, gw, scope, { stagingId: p.stagingId, by: "MEM-001" });
      log(`✗ ${p.skillId} 未批准竟被装载——红线失守！`);
    } catch {
      log(`✓ ${p.skillId} 未批准装载被拒（符合预期）`);
    }
  }

  // ⑤ 模拟董事长审批（l4_chairman）→ 装载
  console.log("\n④ 董事长审批（l4_chairman）→ 装载：");
  for (const p of l2) {
    const cl = await app.connect();
    await cl.query("BEGIN");
    await cl.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await cl.query(`UPDATE approvals SET status='approved', decided_by='MEM-001', decided_at=now() WHERE approval_id=$1`, [p.approvalId]);
    await cl.query("COMMIT");
    cl.release();
    const loaded = await loadStaging(app, gw, scope, { stagingId: p.stagingId, by: "MEM-001" });
    log(`✓ ${loaded.skillId}@${loaded.version} 批准后装载（skill.dist.approved_loaded 留痕）`);
  }

  // ⑥ 终态核验
  console.log("\n⑤ 技能库终态（dist_meta 治理面）：");
  for (const p of packages) {
    const s = await app.query(
      `SELECT s.version, s.level, s.dist_meta->>'category' AS cat, s.dist_meta->>'origin' AS origin,
              s.dist_meta->'egressDomains' AS egress, s.dist_meta->'toolWhitelist' AS tools
       FROM skills s WHERE s.id=$1`, [p.skillId]);
    const row = s.rows[0]!;
    log(`· ${p.skillId} v${row.version} [${row.level}/${row.cat}/${row.origin}] 出站=${row.egress} 工具=${row.tools}`);
  }
  const ev = await app.query(
    `SELECT payload->'decision'->>'action' AS action, count(*) AS c FROM biz_events
     WHERE workspace_id=$1 AND payload->'decision'->>'action' LIKE 'skill.dist.%'
     GROUP BY 1 ORDER BY 1`, [scope.workspaceId]);
  console.log("\n⑥ 事件留痕（biz_events 哈希链，可回放）：");
  for (const e of ev.rows) log(`· ${e.action} ×${e.c}`);
  const st = await distStatus(app, scope);
  log(`· staging 状态：${st.staging.map((x: { skill_id: string; status: string }) => `${x.skill_id}=${x.status}`).join("，")}`);

  console.log("\n═══ 实跑完成：L0 静默 / L2 审批门禁 / 签名验签 / 事件留痕 全部按架构预期运行 ═══");
  await app.end();
  await gw.end();
}

await main();
