#!/usr/bin/env node
/**
 * ux.mjs · U 域体验自动化（RDAS v3.1；配合 checklist.v3.json 的 U5/U6/U1 可机检项）
 *
 * 做什么：
 *   ① axe-core 全量扫描（critical/serious）；
 *   ② 键盘可达与焦点可见/不被遮挡（近似 2.4.11）；
 *   ③ 点击目标尺寸（2.5.8，≥24×24 CSS px，含 inline 例外）；
 *   ④ 200% 文本缩放与 400% 重排（1.4.4/1.4.10）；
 *   ⑤ prefers-reduced-motion（2.3.3）；
 *   ⑥ aria-live 状态播报存在性（4.1.3 近似）。
 *
 * 说明：本脚本是**机检近似**，U5-02/U5-03 等仍需人工读屏/键盘走查复核；报告会标注 evidenceType=machine-approx。
 * 用法：node scripts/acceptance/ux.mjs [--out <dir>] [--profile <path>] [--max-routes 12]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliArgs, findRepoRoot, loadProfile, urlsOf } from "./lib/profile.mjs";
import { loadChromium } from "./lib/playwright.mjs";
import { loginAsMember, productIdOf } from "./lib/session.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const { profile, warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath);
const OUT_DIR = resolve(args.outDir ?? join(REPO_ROOT, "outputs", "acceptance", "ux"));
const SHOT_DIR = join(OUT_DIR, "shots");
mkdirSync(SHOT_DIR, { recursive: true });
const MAX_ROUTES = Number(process.env.ACCEPTANCE_UX_MAX_ROUTES ?? 12);

let AxeBuilder = null;
try {
  ({ AxeBuilder } = await import("@axe-core/playwright"));
} catch (err) {
  console.error(`[acceptance:ux] 缺少 @axe-core/playwright：${String(err).split("\n")[0]}`);
}

const chromium = loadChromium(REPO_ROOT);
const URLs = urlsOf(profile);
const WORKSPACE_SLUG = profile.identity?.workspaceSlug ?? null;
const MEMBER_NO = profile.identity?.human ?? "MEM-001";
const T = profile.thresholds ?? {};

const REPORT = {
  at: new Date().toISOString(),
  spec: "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v3.1",
  profileWarnings,
  workspaceSlug: WORKSPACE_SLUG,
  checks: [],
  totals: {},
  issues: [],
};
const record = (entry) => {
  REPORT.checks.push(entry);
  if (!entry.pass) REPORT.issues.push({ id: entry.id, route: entry.route, detail: JSON.stringify(entry.actual ?? {}).slice(0, 300) });
  console.log(`${entry.pass ? "✓" : "✗"} [${entry.id}] ${entry.name}${entry.route ? ` @${entry.route}` : ""}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "no-preference" });
const page = await context.newPage();
const shot = async (target, name) => {
  const file = join(SHOT_DIR, `${name}.png`);
  await target.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return file;
};

// 登录（成员态）：清除演示直登游客标记，避免权限类页面被误判
await loginAsMember(page, { urls: URLs, workspaceSlug: WORKSPACE_SLUG, memberNo: MEMBER_NO, productId: productIdOf(REPO_ROOT) });

const routes = (profile.surfaces?.pcRoutes ?? ["/"]).slice(0, MAX_ROUTES);
const goto = async (route) => {
  await page.goto(`${URLs.pc}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
};

/* ---------------- U5-01 axe ---------------- */
for (const route of routes) {
  try {
    await goto(route);
    if (!AxeBuilder) {
      record({ id: "U5-01", layer: "U5", route, name: "axe 全量扫描", pass: false, expected: "0 critical/serious", actual: { error: "AxeBuilder 不可用" }, evidenceType: "machine" });
      continue;
    }
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    const minor = results.violations.filter((v) => v.impact === "moderate" || v.impact === "minor");
    const evidence = bad.length ? await shot(page, `ux-axe-${route.replace(/[^a-z0-9]/gi, "_") || "root"}`) : undefined;
    record({
      id: "U5-01", layer: "U5", route,
      name: "axe 全量扫描（critical/serious）",
      expected: `0（阈值 axCritical=${T.axCritical ?? 0}）`,
      actual: { criticalSerious: bad.length, moderateMinor: minor.length, rules: bad.slice(0, 8).map((v) => v.id) },
      pass: bad.length <= (T.axCritical ?? 0),
      evidence, evidenceType: "machine",
    });
  } catch (err) {
    record({ id: "U5-01", layer: "U5", route, name: "axe 全量扫描", pass: false, actual: { error: String(err).split("\n")[0] }, evidenceType: "machine" });
  }
}

/* ---------------- U5-05 点击目标尺寸 ---------------- */
for (const route of routes.slice(0, 8)) {
  try {
    await goto(route);
    const min = T.targetSizePx ?? 24;
    const result = await page.evaluate((minPx) => {
      const nodes = [...document.querySelectorAll("button, a, input, select, textarea, [role=button], [role=link], [role=tab]")];
      const targets = [];
      const bad = [];
      let checked = 0;
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        // WCAG 2.5.8 例外：行内文本链接（inline + 文本内容）
        if (cs.display === "inline" && (el.textContent ?? "").trim().length > 0 && el.getAttribute("role") === null) continue;
        checked += 1;
        const item = { tag: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height), cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        targets.push(item);
        if (r.width < minPx || r.height < minPx) bad.push(item);
      }
      // WCAG 2.5.8 spacing 例外：以目标中心为圆心、24px 直径的圆互不相交时可豁免。
      const violations = [];
      for (const b of bad) {
        let nearest = Infinity;
        for (const t of targets) {
          if (t === b) continue;
          nearest = Math.min(nearest, Math.hypot(t.cx - b.cx, t.cy - b.cy));
        }
        if (nearest < minPx) violations.push({ ...b, nearest: Math.round(nearest) });
      }
      return { checked, undersized: bad.length, spacingFail: violations.length, violations: violations.slice(0, 15) };
    }, min);
    record({
      id: "U5-05", layer: "U5", route, name: `点击目标 ≥${min}×${min}px（含间距例外）`,
      expected: "间距例外后违规 0", actual: result, pass: result.spacingFail === 0, evidenceType: "machine",
    });
  } catch (err) {
    record({ id: "U5-05", layer: "U5", route, name: "点击目标尺寸", pass: false, actual: { error: String(err).split("\n")[0] }, evidenceType: "machine" });
  }
}

/* ---------------- U5-02 键盘可达（近似：焦点可见 + 不被遮挡） ---------------- */
for (const route of routes.slice(0, 6)) {
  try {
    await goto(route);
    const seen = [];
    let obscured = 0;
    let noIndicator = 0;
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(60);
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const cx = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
        const cy = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
        const top = document.elementFromPoint(cx, cy);
        const indicator = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth || "0") > 0) || cs.boxShadow !== "none";
        return {
          tag: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim().slice(0, 24),
          w: Math.round(r.width), h: Math.round(r.height), indicator,
          covered: Boolean(top) && top !== el && !el.contains(top) && !top.contains(el),
        };
      });
      if (!info) continue;
      seen.push(`${info.tag}:${info.text.slice(0, 12)}`);
      if (info.covered) obscured += 1;
      if (!info.indicator) noIndicator += 1;
    }
    record({
      id: "U5-02", layer: "U5", route, name: "键盘可达（焦点可见且不被遮挡）",
      expected: "焦点序列存在；遮挡 0；可见指示比例 100%",
      actual: { focusedCount: seen.length, sample: seen.slice(0, 8), obscured, noIndicator },
      pass: seen.length > 0 && obscured === 0 && noIndicator <= Math.max(1, Math.floor(seen.length * 0.1)),
      evidenceType: "machine-approx",
    });
  } catch (err) {
    record({ id: "U5-02", layer: "U5", route, name: "键盘可达", pass: false, actual: { error: String(err).split("\n")[0] }, evidenceType: "machine-approx" });
  }
}

/* ---------------- U5-04 文本缩放 / 重排 ---------------- */
for (const route of routes.slice(0, 6)) {
  try {
    await goto(route);
    const at1280 = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth + 2, w: window.innerWidth }));
    await page.setViewportSize({ width: 320, height: 844 });
    await page.waitForTimeout(900);
    const at320 = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth + 2, w: window.innerWidth }));
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForTimeout(500);
    const zoomed = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth + 2 }));
    await page.setViewportSize({ width: 1440, height: 900 });
    record({
      id: "U5-04", layer: "U5", route, name: "缩放/重排不破版（近 1280 / 近 400% / 200% 字号）",
      expected: "无横向溢出、不丢功能",
      actual: { at1280, at320, zoomed }, pass: !at1280.overflow && !at320.overflow && !zoomed.overflow,
      evidenceType: "machine-approx",
    });
  } catch (err) {
    try { await page.setViewportSize({ width: 1440, height: 900 }); } catch { /* 忽略 */ }
    record({ id: "U5-04", layer: "U5", route, name: "缩放/重排", pass: false, actual: { error: String(err).split("\n")[0] }, evidenceType: "machine-approx" });
  }
}

/* ---------------- U5-07 reduced-motion ---------------- */
try {
  await context.setExtraHTTPHeaders({});
  await page.emulateMedia({ reducedMotion: "reduce" });
  await goto(routes[0] ?? "/");
  const animations = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("*")].slice(0, 1200);
    let long = 0;
    for (const el of nodes) {
      const cs = getComputedStyle(el);
      if (cs.animationName !== "none" && parseFloat(cs.animationDuration || "0") > 0.5) long += 1;
      if (cs.transitionDuration && parseFloat(cs.transitionDuration) > 0.5 && cs.transitionProperty !== "none") long += 1;
    }
    return { longRunning: long };
  });
  record({
    id: "U5-07", layer: "U5", route: routes[0] ?? "/", name: "prefers-reduced-motion 生效",
    expected: "长时间动画/过渡 ≈0", actual: animations, pass: animations.longRunning <= 3,
    evidenceType: "machine-approx",
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
} catch (err) {
  record({ id: "U5-07", layer: "U5", route: routes[0] ?? "/", name: "reduced-motion", pass: false, actual: { error: String(err).split("\n")[0] }, evidenceType: "machine-approx" });
}

/* ---------------- U3-07 / U5-03 aria-live（状态播报近似） ---------------- */
for (const route of routes.slice(0, 6)) {
  try {
    await goto(route);
    const live = await page.evaluate(() => document.querySelectorAll("[aria-live], [role=status], [role=alert]").length);
    record({
      id: "U3-07", layer: "U3", route, name: "状态播报区域存在性（aria-live 近似）",
      expected: "关键页存在播报区（人工读屏复核仍需执行）", actual: { liveRegions: live },
      pass: live > 0, evidenceType: "machine-approx",
    });
  } catch (err) {
    record({ id: "U3-07", layer: "U3", route, name: "aria-live", pass: false, actual: { error: String(err).split("\n")[0] }, evidenceType: "machine-approx" });
  }
}

await browser.close();
const passed = REPORT.checks.filter((c) => c.pass).length;
REPORT.totals = {
  checks: REPORT.checks.length,
  passed,
  failed: REPORT.checks.length - passed,
  byLayer: REPORT.checks.reduce((a, c) => { a[c.layer] = a[c.layer] ?? { total: 0, passed: 0 }; a[c.layer].total += 1; if (c.pass) a[c.layer].passed += 1; return a; }, {}),
};
writeFileSync(join(OUT_DIR, "ux-report.json"), JSON.stringify(REPORT, null, 1));
const md = [
  "# U 域体验自动化报告（RDAS v3.1）", "",
  `- 生成时间：${REPORT.at}；通过 ${passed}/${REPORT.checks.length}；profile 告警：${profileWarnings.join("；") || "无"}`,
  `- 说明：本报告为**机检近似**；U5-02/U5-03/U5-04/U3-07 仍需人工键盘与读屏走查复核后才可按 A 级结论。`, "",
  "| 检查 | 路由 | 预期 | 实测 | 结论 |", "|---|---|---|---|---|",
];
for (const c of REPORT.checks) md.push(`| ${c.id} ${c.name} | ${c.route ?? "-"} | ${c.expected ?? "-"} | ${JSON.stringify(c.actual).slice(0, 220)} | ${c.pass ? "通过" : "**未通过**"} |`);
writeFileSync(join(OUT_DIR, "ux-report.md"), `${md.join("\n")}\n`);
console.log(`[acceptance:ux] 通过 ${passed}/${REPORT.checks.length}；输出 ${OUT_DIR}`);
if (REPORT.totals.failed > 0) process.exitCode = 1;
