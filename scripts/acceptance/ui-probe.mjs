#!/usr/bin/env node
/**
 * ui-probe.mjs · L3 页面/路由层 + L4 交互入口 真机探针（RDAS v1）
 *
 * 做什么：
 *   ① 路由清单（profile.surfaces）逐条真机打开：控制台错误、空白、横向溢出、样例文本；
 *   ② 岗位档案页逐个打开（数量由 DB 决定）：身份卡/围栏卡/技能卡是否齐全，有无“声明悬空/未安装”；
 *   ③ 技能中心：中文展示名（不允许裸 id / “技能能力”回落）、安装态可见；
 *   ④ 结果与截图落盘，供 report.mjs 汇总。
 *
 * 用法：pnpm acceptance:ui [--out <dir>] [--profile <path>] [--skip-agents]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { cliArgs, findRepoRoot, loadProfile, urlsOf } from "./lib/profile.mjs";
import { loadChromium } from "./lib/playwright.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const { profile, warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath);
let WORKSPACE_ID = args.workspaceId ?? profile.workspaceId ?? "";
const OUT_DIR = resolve(args.outDir ?? join(REPO_ROOT, "outputs", "acceptance", "ui"));
const SHOT_DIR = join(OUT_DIR, "shots");
mkdirSync(SHOT_DIR, { recursive: true });

const chromium = loadChromium(REPO_ROOT);

function readEnvValue(key) {
  const path = join(REPO_ROOT, ".env");
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf-8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

function productId() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "product.manifest.json"), "utf-8")).productId ?? "workloom";
  } catch {
    return "workloom";
  }
}

/* ------------------------- 事实源（DB） ------------------------- */
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? readEnvValue("DATABASE_URL") });
await client.connect();
const workspaceRow = WORKSPACE_ID
  ? (await client.query("SELECT id, slug FROM workspaces WHERE id=$1", [WORKSPACE_ID])).rows[0]
  : (await client.query("SELECT id, slug FROM workspaces WHERE slug=$1 LIMIT 1", [profile.identity?.workspaceSlug ?? ""])).rows[0];
WORKSPACE_ID = workspaceRow?.id ?? WORKSPACE_ID;
const workspaceSlug = profile.identity?.workspaceSlug ?? workspaceRow?.slug ?? null;
if (!workspaceSlug) throw new Error(`workspace ${WORKSPACE_ID} 不存在或没有 slug：无法登录真机`);
const agentRows = (await client.query(
  `SELECT id, preset_key, name, version, fence_bindings, skills, meta FROM agents WHERE workspace_id=$1 ORDER BY preset_key`,
  [WORKSPACE_ID],
)).rows;
const skillRows = (await client.query(
  `SELECT s.id, s.name, s.description, s.version, s.bundle, s.level
   FROM skill_installs si JOIN skills s ON s.id = si.skill_id
   WHERE si.workspace_id=$1 AND s.level='official' ORDER BY s.bundle NULLS FIRST, s.name`,
  [WORKSPACE_ID],
)).rows;
await client.end();

/* ------------------------- 展示名同口径（不做词典复刻，接受两候选） ------------------------- */
function stripTechnicalTokens(value) {
  return value.replace(/[A-Za-z][A-Za-z0-9._+/-]*/g, " ").replace(/[\s·—–-]+/g, " ").trim();
}
function displayCandidates(name, description) {
  const m = /^([^（(。：:—]{2,40})[（(。：:—]/.exec((description ?? "").trim());
  const candidate = m?.[1]?.trim();
  const cleaned = candidate ? stripTechnicalTokens(candidate) : "";
  const list = [candidate, cleaned].filter((x) => x && x.length >= 2);
  return list.length ? list : [name];
}
function versionLabel(version) {
  const raw = String(version ?? "");
  const m = raw.match(/(?:^|[\/_-])v?(\d+(?:\.\d+)*)$/i) ?? raw.match(/^v?(\d+(?:\.\d+)*)$/i);
  return m?.[1] ? `第 ${m[1]} 版` : "版本待确认";
}

/* ------------------------- 浏览器 ------------------------- */
const URLs = urlsOf(profile);
const report = {
  at: new Date().toISOString(),
  spec: "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v1",
  workspaceId: WORKSPACE_ID,
  profileWarnings,
  expected: { agents: agentRows.length, officialSkills: skillRows.length },
  agents: {}, skills: {}, routes: {}, totals: {}, issues: [],
};

const browser = await chromium.launch({ headless: true });
const pcContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await pcContext.newPage();
let consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().split("\n")[0]); });
page.on("pageerror", (e) => consoleErrors.push(String(e).split("\n")[0]));

async function loginPc() {
  const res = await page.request.post(`${URLs.api}/trpc/auth.loginAs`, {
    data: { workspaceSlug, memberNo: profile.identity?.human ?? "MEM-001" },
  });
  const json = await res.json();
  const token = json?.result?.data?.token;
  if (!token) throw new Error(`登录失败（loginAs）：${JSON.stringify(json).slice(0, 200)}`);
  await page.goto(`${URLs.pc}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate((t) => {
    const keys = Object.keys(localStorage);
    const tk = keys.find((k) => k.endsWith(":access-token")) ?? "workloom:access-token";
    const gk = keys.find((k) => k.endsWith(":guest"));
    localStorage.setItem(tk, t);
    if (gk) localStorage.removeItem(gk);
  }, token);
  return token;
}

const token = await loginPc();
const shot = async (target, name) => {
  await target.screenshot({ path: join(SHOT_DIR, `${name}.png`) }).catch(() => undefined);
};

/* ① 岗位档案页 */
if (!args.has("--skip-agents")) {
  for (const agent of agentRows) {
    consoleErrors = [];
    const expectedSkills = Array.isArray(agent.skills) ? agent.skills : [];
    const expectedFences = (agent.fence_bindings ?? []).length;
    const row = { name: agent.name, bundle: agent.meta?.sourceBundleId ?? null, fences: expectedFences, skills: expectedSkills.length, ok: false };
    try {
      await page.goto(`${URLs.pc}/agents/${encodeURIComponent(agent.id)}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.body.innerText.includes("身份与归属"), null, { timeout: 20000 });
      const dom = await page.evaluate(() => {
        const text = document.body.innerText;
        const section = (title) => {
          const idx = text.indexOf(title);
          return idx < 0 ? "" : text.slice(idx, idx + 900);
        };
        return {
          identity: section("身份与归属"),
          equipped: (text.match(/已装备 · /g) ?? []).length,
          declared: (text.match(/已声明 · /g) ?? []).length,
          uninstalled: /未安装/.test(text),
          dangling: text.includes("声明悬空") || text.includes("标红"),
          notFound: text.includes("成员不存在或已停用"),
          hasHeader: /成员档案 · \S/.test(text),
        };
      });
      const identityOk = dom.hasHeader && dom.identity.includes(versionLabel(agent.version)) && dom.identity.includes("来源行业包");
      const fenceOk = !dom.dangling && (expectedFences === 0 || dom.declared >= expectedFences);
      const skillsOk = expectedSkills.length === 0 ? !dom.uninstalled : dom.equipped >= expectedSkills.length && !dom.uninstalled;
      row.ok = identityOk && fenceOk && skillsOk && !dom.notFound;
      row.detail = { identityOk, fenceOk, skillsOk, declared: dom.declared, expectedFences, equipped: dom.equipped, expectedSkills: expectedSkills.length, errors: consoleErrors.slice(0, 2) };
    } catch (err) {
      row.detail = { error: String(err).split("\n")[0], errors: consoleErrors.slice(0, 3) };
    }
    if (!row.ok) report.issues.push({ where: `agent:${agent.preset_key}`, detail: row.detail });
    report.agents[agent.preset_key] = row;
  }
  await shot(page, "agents-last");
}

/* ② 技能中心 */
try {
  consoleErrors = [];
  await page.goto(`${URLs.pc}/skills`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const m = document.body.innerText.match(/官方技能[^\d]{0,12}(\d+)/);
      return Boolean(m && Number(m[1]) > 0);
    },
    null,
    { timeout: 40000 },
  ).catch(() => undefined);
  await page.waitForTimeout(1500);
  const dom = await page.evaluate(() => ({
    text: document.body.innerText,
    rawFallbacks: (document.body.innerText.match(/未命名|技能能力/g) ?? []).length,
  }));
  for (const skill of skillRows) {
    const candidates = displayCandidates(skill.name, skill.description);
    const shown = candidates.some((candidate) => dom.text.includes(candidate));
    const rawIdShown = new RegExp(`(^|[^a-z0-9-])${skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`).test(dom.text);
    report.skills[skill.name] = { candidates, bundle: skill.bundle, ok: shown && !rawIdShown, rawIdShown };
    if (!shown) report.issues.push({ where: `skill:${skill.name}`, detail: `技能中心未见展示名「${candidates.join(" / ")}」` });
    if (rawIdShown) report.issues.push({ where: `skill:${skill.name}`, detail: `技能中心裸奔技术 id「${skill.name}」` });
  }
  report.skillsSummary = {
    listed: Object.values(report.skills).filter((s) => s.ok).length,
    expected: skillRows.length,
    rawFallbackHits: dom.rawFallbacks,
    errors: consoleErrors.slice(0, 2),
  };
  if (dom.rawFallbacks > 0) report.issues.push({ where: "skills-page", detail: `出现未命名/技能能力回落 ×${dom.rawFallbacks}` });
  await shot(page, "skills");
} catch (err) {
  report.issues.push({ where: "skills-page", detail: String(err).split("\n")[0] });
}

/* ③ 路由清单（PC / B 移动 / C 端） */
async function probe(target, routes, prefix, waitMs = 1800) {
  for (const route of routes) {
    consoleErrors = [];
    const key = `${prefix}:${route}`;
    try {
      await target.goto(`${prefix === "pc" ? URLs.pc : prefix === "bMobile" ? URLs.bMobile : URLs.cMobile}${route}`, { waitUntil: "domcontentloaded" });
      await target.waitForTimeout(waitMs);
      const dom = await target.evaluate(() => {
        const text = document.body.innerText || "";
        return {
          len: text.length,
          blank: text.trim().length === 0,
          internalError: /Internal Server Error|加载失败|出错了/.test(text),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
          sample: text.replace(/\s+/g, " ").slice(0, 90),
        };
      });
      report.routes[key] = { ...dom, errors: consoleErrors.slice(0, 2), ok: !dom.blank && !dom.internalError && !dom.overflowX };
    } catch (err) {
      report.routes[key] = { ok: false, error: String(err).split("\n")[0] };
    }
    if (!report.routes[key].ok) report.issues.push({ where: key, detail: report.routes[key] });
  }
}

await probe(page, profile.surfaces.pcRoutes, "pc", 2000);

/* B 端移动：token 在 sessionStorage，键名含 productId */
{
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  // 存储键默认按本仓 productId 推导；跨实例/跨仓冒烟时可用 profile.storage.bMobileTokenKey 覆盖
  const key = profile.storage?.bMobileTokenKey ?? `workloom:${productId()}:b-mobile:access-token`;
  await mobileContext.addInitScript(({ t, slug, k }) => {
    sessionStorage.setItem(k, t);
    localStorage.setItem(k.replace("access-token", "workspace"), slug);
    localStorage.removeItem(k.replace("access-token", "guest"));
  }, { t: token, slug: workspaceSlug, k: key });
  const mobilePage = await mobileContext.newPage();
  mobilePage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().split("\n")[0]); });
  mobilePage.on("pageerror", (e) => consoleErrors.push(String(e).split("\n")[0]));
  for (const route of profile.surfaces.bMobileRoutes) {
    consoleErrors = [];
    const routeKey = `bMobile:${route}`;
    try {
      await mobilePage.goto(`${URLs.bMobile}${route}`, { waitUntil: "domcontentloaded" });
      await mobilePage.waitForFunction(
        () => {
          const t = document.body.innerText;
          return t.length > 500 && !/正在恢复工作区|正在确认身份|正在确认访问范围/.test(t);
        },
        null,
        { timeout: 20000 },
      ).catch(() => undefined);
      await mobilePage.waitForTimeout(800);
      const dom = await mobilePage.evaluate(() => {
        const text = document.body.innerText || "";
        return {
          len: text.length,
          authPage: text.includes("B 端移动工作台") && text.includes("验证码"),
          restoring: /正在恢复工作区|正在确认身份/.test(text),
          internalError: /加载失败|出错了|Internal Server Error/.test(text),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
          sample: text.replace(/\s+/g, " ").slice(0, 80),
        };
      });
      report.routes[routeKey] = { ...dom, errors: consoleErrors.slice(0, 2), ok: !dom.authPage && !dom.restoring && !dom.internalError && !dom.overflowX && dom.len > 40 };
    } catch (err) {
      report.routes[routeKey] = { ok: false, error: String(err).split("\n")[0] };
    }
    if (!report.routes[routeKey].ok) report.issues.push({ where: routeKey, detail: report.routes[routeKey] });
  }
  await shot(mobilePage, "b-mobile");
  await mobileContext.close();
}

/* C 端：哈希式 Tab */
{
  const cContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const cPage = await cContext.newPage();
  cPage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().split("\n")[0]); });
  cPage.on("pageerror", (e) => consoleErrors.push(String(e).split("\n")[0]));
  for (const hash of profile.surfaces.cRoutes) {
    consoleErrors = [];
    const routeKey = `cMobile:${hash}`;
    try {
      await cPage.goto(`${URLs.cMobile}/${hash}`, { waitUntil: "domcontentloaded" });
      await cPage.waitForTimeout(1800);
      const dom = await cPage.evaluate(() => {
        const text = document.body.innerText || "";
        return {
          len: text.length,
          internalError: /加载失败|出错了|Internal Server Error/.test(text),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
          sample: text.replace(/\s+/g, " ").slice(0, 80),
        };
      });
      report.routes[routeKey] = { ...dom, errors: consoleErrors.slice(0, 2), ok: !dom.internalError && !dom.overflowX && dom.len > 40 };
    } catch (err) {
      report.routes[routeKey] = { ok: false, error: String(err).split("\n")[0] };
    }
    if (!report.routes[routeKey].ok) report.issues.push({ where: routeKey, detail: report.routes[routeKey] });
  }
  await shot(cPage, "c-mobile");
  await cContext.close();
}

await browser.close();

report.totals = {
  agentsChecked: Object.keys(report.agents).length,
  agentsOk: Object.values(report.agents).filter((a) => a.ok).length,
  skillsChecked: Object.keys(report.skills).length,
  skillsOk: Object.values(report.skills).filter((s) => s.ok).length,
  routesChecked: Object.keys(report.routes).length,
  routesOk: Object.values(report.routes).filter((r) => r.ok).length,
  issues: report.issues.length,
  profileWarnings: profileWarnings.length,
};

writeFileSync(join(OUT_DIR, "ui-probe.json"), JSON.stringify(report, null, 1));
console.log(`[acceptance:ui] 档案页 ${report.totals.agentsOk}/${report.totals.agentsChecked}；技能卡 ${report.totals.skillsOk}/${report.totals.skillsChecked}；路由 ${report.totals.routesOk}/${report.totals.routesChecked}；问题 ${report.totals.issues}`);
for (const warning of profileWarnings) console.log(`  ⚠ profile：${warning}`);
for (const issue of report.issues.slice(0, 12)) console.log(`  ✗ ${issue.where}：${JSON.stringify(issue.detail).slice(0, 200)}`);
console.log(`[acceptance:ui] 输出：${OUT_DIR}/ui-probe.json`);
if (report.totals.issues > 0) process.exitCode = 1;
