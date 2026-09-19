#!/usr/bin/env node
/**
 * soak.mjs · O5 长跑采样器（RDAS v3.0）
 *
 * 按固定间隔采样：/health、端口、threads 成功/失败增量、事件增量、时间戳。
 * 支持小数小时（本地冒烟测试），产出 soak-report.{json,md}。
 * 用法：node scripts/acceptance/soak.mjs [--hours 24] [--interval-s 60] [--out <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { cliArgs, findRepoRoot, loadProfile, urlsOf } from "./lib/profile.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const { profile } = loadProfile(REPO_ROOT, args.profilePath);
const OUT_DIR = resolve(args.outDir ?? join(REPO_ROOT, "outputs", "acceptance", "soak"));
mkdirSync(OUT_DIR, { recursive: true });
const HOURS = Number(process.env.ACCEPTANCE_SOAK_HOURS ?? (args.has("--hours") ? process.argv[process.argv.indexOf("--hours") + 1] : 24));
const INTERVAL_S = Math.max(2, Number(process.env.ACCEPTANCE_SOAK_INTERVAL_S ?? (args.has("--interval-s") ? process.argv[process.argv.indexOf("--interval-s") + 1] : 60)));
const URLS = urlsOf(profile);
const readEnvValue = (key) => { const p = join(REPO_ROOT, ".env"); if (!existsSync(p)) return undefined; const l = readFileSync(p, "utf-8").split("\n").find((x) => x.startsWith(`${key}=`)); return l ? l.slice(key.length + 1).trim() : undefined; };
const DB_URL = process.env.DATABASE_URL ?? readEnvValue("DATABASE_URL");
const client = new pg.Client({ connectionString: DB_URL });
await client.connect();
const ws = profile.workspaceId
  ? (await client.query("SELECT id FROM workspaces WHERE id=$1", [profile.workspaceId])).rows[0]
  : (await client.query("SELECT id FROM workspaces WHERE slug=$1 LIMIT 1", [profile.identity?.workspaceSlug ?? ""])).rows[0];
if (!ws) throw new Error("找不到工作区");

const deadline = Date.now() + HOURS * 3600_000;
const samples = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`[acceptance:soak] 开始：${HOURS}h，间隔 ${INTERVAL_S}s（deadline=${new Date(deadline).toISOString()}）`);
while (Date.now() < deadline) {
  const t = Date.now();
  const sample = { at: new Date().toISOString() };
  try {
    const res = await fetch(`${URLS.api}/health`);
    sample.health = { status: res.status, ok: (await res.json().catch(() => ({})))?.ok ?? null, ms: Date.now() - t };
  } catch (err) { sample.health = { status: 0, ok: false, error: String(err).split("\n")[0] }; }
  try {
    const r = await client.query(
      `SELECT
         count(*) FILTER (WHERE status='completed')::int AS completed,
         count(*) FILTER (WHERE status='failed')::int AS failed,
         count(*) FILTER (WHERE status='paused')::int AS paused
       FROM threads WHERE workspace_id=$1`,
      [ws.id],
    );
    sample.threads = r.rows[0];
    const e = await client.query("SELECT count(*)::int AS events FROM biz_events WHERE workspace_id=$1", [ws.id]);
    sample.events = e.rows[0].events;
  } catch (err) { sample.dbError = String(err).split("\n")[0]; }
  samples.push(sample);
  writeFileSync(join(OUT_DIR, "soak-samples.jsonl"), `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`);
  console.log(`  ${sample.at} health=${sample.health?.status} completed=${sample.threads?.completed ?? "?"} failed=${sample.threads?.failed ?? "?"}`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) break;
  await sleep(Math.min(INTERVAL_S * 1000, remaining));
}
const first = samples[0], last = samples[samples.length - 1];
const report = {
  at: new Date().toISOString(), spec: "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v3.0",
  hours: HOURS, intervalS: INTERVAL_S, samples,
  summary: {
    samples: samples.length,
    healthOk: samples.filter((s) => s.health?.status === 200).length,
    healthFail: samples.filter((s) => s.health?.status !== 200).length,
    completedDelta: (last?.threads?.completed ?? 0) - (first?.threads?.completed ?? 0),
    failedDelta: (last?.threads?.failed ?? 0) - (first?.threads?.failed ?? 0),
    eventsDelta: (last?.events ?? 0) - (first?.events ?? 0),
  },
};
writeFileSync(join(OUT_DIR, "soak-report.json"), JSON.stringify(report, null, 1));
writeFileSync(join(OUT_DIR, "soak-report.md"), `# O5 长跑报告（RDAS v3.0）\n\n- 时长 ${HOURS}h；样本 ${report.summary.samples}；health 失败 ${report.summary.healthFail}\n- completed Δ${report.summary.completedDelta}；failed Δ${report.summary.failedDelta}；events Δ${report.summary.eventsDelta}\n\n> 长跑只证明“采样窗口内未观察到系统性异常”，不替代 7d/28d 完整长跑。\n`);
await client.end().catch(() => undefined);
console.log(`[acceptance:soak] 完成：样本 ${report.summary.samples}；health 失败 ${report.summary.healthFail}；输出 ${OUT_DIR}`);
if (report.summary.healthFail > 0) process.exitCode = 1;
