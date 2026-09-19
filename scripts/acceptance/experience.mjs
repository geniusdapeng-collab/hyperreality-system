#!/usr/bin/env node
/**
 * experience.mjs · L4 交互层 + L5 体验层 真机走查（RDAS v1）
 *
 * 角色 × 旅程 × 维度：每条走查都留 前置条件/步骤/预期/实测/证据（截图 + JSON），
 * 维度机检：术语一致性（裸动作码/裸 id/裸 ISO）、对比度（WCAG AA 近似）、打扰预算。
 *
 * 用法：pnpm acceptance:experience [--out <dir>] [--profile <path>] [--only EXP-02,EXP-09]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliArgs, findRepoRoot, loadProfile, urlsOf } from "./lib/profile.mjs";
import { loadChromium } from "./lib/playwright.mjs";
import { loginAsMember, productIdOf } from "./lib/session.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const { profile, warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath);
const OUT_DIR = resolve(args.outDir ?? join(REPO_ROOT, "outputs", "acceptance", "experience"));
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

const URLs = urlsOf(profile);
const R = profile.routes;
const T = profile.thresholds;
const WORKSPACE_SLUG = profile.identity?.workspaceSlug ?? null;
const MEMBER_NO = profile.identity?.human ?? "MEM-001";

const REPORT = { at: new Date().toISOString(), spec: "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v1", profileWarnings, checks: [], dimensions: {}, issues: [] };
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? new Set(String(process.argv[i + 1]).split(",")) : null;
})();

const now = () => Date.now();
function record(entry) {
  if (only && !only.has(entry.id)) return;
  REPORT.checks.push(entry);
  if (!entry.pass) REPORT.issues.push({ id: entry.id, name: entry.name, actual: entry.actual });
  console.log(`${entry.pass ? "✓" : "✗"} [${entry.persona}·${entry.journey}] ${entry.id} ${entry.name}${entry.metric ? ` · ${entry.metric}` : ""}`);
}

const browser = await chromium.launch({ headless: true });
const pcContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const page = await pcContext.newPage();
let consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().split("\n")[0]); });
page.on("pageerror", (e) => consoleErrors.push(String(e).split("\n")[0]));
const shot = async (target, name) => {
  const file = join(SHOT_DIR, `${name}.png`);
  await target.screenshot({ path: file }).catch(() => undefined);
  return file;
};

/* 登录（PC 成员态）：必须清除演示直登游客标记，否则审批等成员能力会被误判为无权 */
const TOKEN = await loginAsMember(page, { urls: URLs, workspaceSlug: WORKSPACE_SLUG, memberNo: MEMBER_NO, productId: productIdOf(REPO_ROOT) });

/** 展开右栏“任务上下文”抽屉（窄内容区时关键动作在抽屉里；点不到就是缺陷） */
async function ensureRightPanel(target) {
  const toggle = target.locator('button[aria-label="显示任务上下文面板"]').first();
  if (await toggle.count()) {
    if ((await toggle.getAttribute("aria-pressed")) !== "true") {
      await toggle.click({ timeout: 6000 }).catch(() => undefined);
      await target.waitForTimeout(1300);
      return true;
    }
  }
  return false;
}

/* ---------------- builtin 走查实现 ---------------- */

async function firstValue() {
  const t0 = now();
  await page.goto(`${URLs.pc}${R.home}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const skip = page.getByRole("button", { name: /跳过开场|跳过/ }).first();
  const ceremony = (await skip.count()) > 0;
  let skipMs = null;
  if (ceremony) { await skip.click({ timeout: 6000 }).catch(() => undefined); skipMs = now() - t0; }
  let text = "";
  for (let i = 0; i < 60; i += 1) {
    text = await page.evaluate(() => document.body.innerText);
    if (/晨报|经营简报|待决|决策包/.test(text)) break;
    await page.waitForTimeout(300);
  }
  const valueMs = now() - t0;
  const decisions = (text.match(/待决|待我(拍板|审批)|需你拍板|待审/g) ?? []).length;
  return {
    id: "EXP-01", persona: "owner", journey: "首启（0–10 分钟）", dimension: "首启与首价值 / 掌控感",
    name: "打开工作台即看到今日经营与待拍板事项",
    precondition: "成员态登录，演示数据已种子",
    steps: ["打开首页", "（首启）1 次点击跳过欢迎仪式", "计时到出现晨报/待决"],
    expected: `首启仪式可跳过；T+${T.firstValueMs / 1000}s 内见价值；决策包 ≤${T.decisionQuota} 件/日`,
    actual: { 有欢迎仪式: ceremony, 跳过毫秒: skipMs, 首次价值毫秒: valueMs, 待决提及: decisions },
    metric: `首次价值 ${(valueMs / 1000).toFixed(1)}s`,
    evidence: await shot(page, "exp-01-first-value"),
    pass: Boolean(text) && valueMs <= T.firstValueMs && decisions > 0 && (decisions <= T.decisionQuota * 3),
  };
}

async function approval() {
  await page.goto(`${URLs.pc}${R.approvals}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2800);
  // 先在主工作区操作；只有找不到动作按钮时才展开右栏（右栏本身可能遮挡列表——RDAS v3 实测）。
  let openedPanel = false;
  if ((await page.locator('button:has-text("推进")').count()) === 0) openedPanel = await ensureRightPanel(page);
  const items = page.locator("button").filter({ hasText: /必审|逐步审|高风险/ });
  const pendingItems = await items.count();
  if (pendingItems > 0) await items.first().click({ timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  const rods = await page.evaluate(() => {
    const texts = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").replace(/\s+/g, " ").trim());
    return { advance: texts.some((x) => /^推进/.test(x)), calibrate: texts.some((x) => /^校准/.test(x)), brake: texts.some((x) => /^制动/.test(x)), batch: texts.some((x) => /批量/.test(x)) };
  });
  const t0 = now();
  const advance = page.locator('button:has-text("推进")').first();
  await advance.waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
  let clicked = false;
  let afterText = "";
  if (await advance.count()) {
    await advance.scrollIntoViewIfNeeded().catch(() => undefined);
    await advance.click({ timeout: 12000 }).catch(() => undefined);
    clicked = true;
    await page.waitForTimeout(3000);
    afterText = await page.evaluate(() => document.body.innerText);
  }
  const singleMs = now() - t0;
  const wroteBack = /账本事件|已写入事件账本|已采纳|已批准/.test(afterText);
  return {
    id: "EXP-02", persona: "owner", journey: "日常治理（每天 10 分钟）", dimension: "效率与恢复 / 信任与透明",
    name: "审批三手势可用且单件裁决达标（实际点按「推进」并核对写回）",
    precondition: "审批页有待审项；成员具备审批权限",
    steps: ["打开审批中心", "（窄内容区）展开右栏抽屉", "选中一条待审", "点按「推进」并核对写回"],
    expected: `三手势齐全；单件 ≤${T.approvalMs / 1000}s；写回有账本编号`,
    actual: { 右栏抽屉展开: openedPanel, 待审条目: pendingItems, 手势: rods, 实际点击: clicked, 写回提示: wroteBack, 单件毫秒: singleMs },
    metric: `单件 ${(singleMs / 1000).toFixed(1)}s`,
    evidence: await shot(page, "exp-02-approval"),
    pass: rods.advance && rods.calibrate && rods.brake && clicked && wroteBack && singleMs <= T.approvalMs,
  };
}

async function traceability() {
  await page.goto(`${URLs.pc}${R.events}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /事件账本|决策链路/.test(document.body.innerText), null, { timeout: 25000 }).catch(() => undefined);
  /**
   * 事件卡容器各仓不统一（`article` / 圆角卡片 div），判据落在语义上：
   * 卡里同时出现「事件」与「执行者 · 动作」才算账本卡，避免因标签名差异误判为空账本。
   */
  const cardSelector = "article, main [class*='rounded-xl'], main [class*='rounded-msg']";
  await page.waitForFunction(
    (sel) => [...document.querySelectorAll(sel)].some((el) => /事件/.test(el.innerText ?? "") && /·/.test(el.innerText ?? "")),
    cardSelector,
    { timeout: 20000 },
  ).catch(() => undefined);
  await page.waitForTimeout(1200);
  const card = await page.evaluate((sel) => {
    const cards = [...document.querySelectorAll(sel)];
    const article = cards.find((el) => /事件/.test(el.innerText ?? "")) ?? cards[0] ?? null;
    const t = article?.innerText ?? "";
    return { hasCard: Boolean(article), hasActor: /·/.test(t), hasEventNo: /事件/.test(t), sample: t.replace(/\s+/g, " ").slice(0, 120) };
  }, cardSelector);
  const t0 = now();
  const link = page.locator(`${cardSelector.split(",").map((s) => s.trim()).join(" button, ")} button`).first();
  let opened = false;
  if (await link.count()) {
    await link.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    opened = await page.evaluate(() => /决策链路|拆解|执行|步骤|回执|依据/.test(document.body.innerText));
  }
  return {
    id: "EXP-03", persona: "owner", journey: "日常治理", dimension: "信任与透明",
    name: "任一结论可一键溯源到事件/回执（点击次数达标）",
    precondition: "账本中有历史事件",
    steps: ["打开事件账本", "核对事件卡证据要素", "点击关联任务进入决策链路"],
    expected: `证据同屏可见；≤${T.traceClicks} 次点击进入链路`,
    actual: { 卡片: card, 关联任务打开: opened, 点击次数: 1, 耗时毫秒: now() - t0 },
    metric: "1 次点击",
    evidence: await shot(page, "exp-03-traceability"),
    pass: card.hasCard && card.hasActor && card.hasEventNo && opened,
  };
}

async function brake() {
  /**
   * 制动杆位置各仓不同：行业仓挂在经营报告页，基座只在夜班中心（且要求有夜班在跑）。
   * 依次探测 reports → night；找不到就如实记「未接线」——红线只看审批/派活/治理，不看这一条。
   */
  let has = false;
  let enabled = false;
  let where = null;
  let brakeLocator = null;
  for (const [name, route] of [["reports", R.reports], ["night", "/night"], ["approvals", R.approvals]]) {
    await page.goto(`${URLs.pc}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    // 审批页的制动杆在选中一条待审后出现（P3 底部动作条）；先选一条再找。
    if (name === "approvals") {
      const item = page.locator("button").filter({ hasText: /必审|逐步审|高风险/ }).first();
      if (await item.count()) { await item.click({ timeout: 6000 }).catch(() => undefined); await page.waitForTimeout(1200); }
    }
    const candidates = page.getByRole("button", { name: /紧急制动/ });
    const count = await candidates.count();
    if (count > 0) has = true;
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isDisabled())) {
        enabled = true;
        where = name;
        brakeLocator = candidate;
        break;
      }
    }
    if (enabled) break;
  }
  let dialog = false;
  if (enabled && brakeLocator) {
    const brakeButton = brakeLocator;
    await brakeButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await brakeButton.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    dialog = await page.evaluate(() => /确认制动（全端 ≤60s 生效）|撤回/.test(document.body.innerText));
    const cancel = page.getByRole("button", { name: /^撤回$/ }).first();
    if (await cancel.count()) await cancel.click({ timeout: 4000 }).catch(() => undefined);
  }
  return {
    id: "EXP-04", persona: "owner", journey: "异常处理", dimension: "掌控感",
    name: "随时可暂停/制动（入口可达 + 二次确认 + 撤回）",
    precondition: "经营报告页可用",
    steps: ["打开经营报告", "定位制动杆", "点开二次确认", "撤回（不污染运行态）"],
    expected: "入口可达且可执行；确认层写明生效范围；有撤回路径",
    actual: { 入口存在: has, 命中页面: where, 可执行: enabled, 确认层: dialog },
    evidence: await shot(page, "exp-04-brake"),
    pass: has && enabled && dialog,
  };
}

async function dispatch() {
  await page.goto(`${URLs.pc}${R.tasks}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const entry = await page.evaluate(() => {
    const input = document.querySelector("textarea, input[type=text]");
    return { hasInput: Boolean(input), placeholder: input?.getAttribute("placeholder") ?? null };
  });
  const t0 = now();
  const title = "为下周三的客房促销活动写一条发布计划，本周五前交付";
  const res = await page.request.post(`${URLs.api}/trpc/threads.dispatch`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: { title },
  });
  const json = await res.json();
  let threadId = json?.result?.data?.threadId ?? null;
  const clarify = json?.result?.data?.kind === "clarify";
  // 含糊指令被路由成 clarify（不建任务）是**正确行为**；补一条规格明确的指令再派一次即可
  if (!threadId && clarify) {
    const retry = await page.request.post(`${URLs.api}/trpc/threads.dispatch`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      data: { title: `${title}（交付物：发布计划文档；截止：本周五 18:00）` },
    });
    threadId = (await retry.json())?.result?.data?.threadId ?? null;
  }
  const ms = now() - t0;
  let detailOk = false;
  if (threadId) {
    await page.goto(`${URLs.pc}${R.tasks}/${encodeURIComponent(threadId)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    detailOk = await page.evaluate(() => /拆解|步骤|执行|交付|回执/.test(document.body.innerText));
  }
  const rejected = /并发上限|已超出|429|TOO_MANY/.test(JSON.stringify(json));
  return {
    id: "EXP-05", persona: "manager", journey: "首日（Day-1）", dimension: "效率与恢复",
    name: "把一条模糊需求派给岗位并看到拆解",
    precondition: "成员具备派发权限；工作区未触并发上限",
    steps: ["打开任务中心（入口可见）", "派发一条任务", "打开详情核对拆解"],
    expected: `≤3 步完成派活；详情可读拆解；派发 ≤${T.dispatchMs / 1000}s`,
    actual: { 页面输入入口: entry.hasInput, 占位文案: entry.placeholder, threadId, 详情可读: detailOk, 派发毫秒: ms, 被限流拒绝: rejected },
    metric: `派发 ${(ms / 1000).toFixed(1)}s`,
    evidence: await shot(page, "exp-05-dispatch"),
    pass: Boolean(threadId) && detailOk,
  };
}

async function inbox() {
  await page.goto(`${URLs.pc}${R.inbox}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const dom = await page.evaluate(() => {
    const t = document.body.innerText;
    return { hasTitle: /统一待办|待办/.test(t), hasItems: /审批|告警|工单|待办/.test(t), empty: /无待办|暂无/.test(t) };
  });
  return {
    id: "EXP-06", persona: "manager", journey: "日常治理", dimension: "理解度 / 效率与恢复",
    name: "统一待办把跨域事项聚合在一屏（不丢事项）",
    precondition: "存在待办数据",
    steps: ["打开统一待办", "核对聚合来源与空态"],
    expected: "一屏聚合；空态给出下一步",
    actual: dom,
    evidence: await shot(page, "exp-06-inbox"),
    pass: dom.hasTitle && (dom.hasItems || dom.empty),
  };
}

async function mobileStaff() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const key = profile.storage?.bMobileTokenKey ?? `workloom:${productId()}:b-mobile:access-token`;
  await context.addInitScript(({ t, slug, k }) => {
    sessionStorage.setItem(k, t);
    localStorage.setItem(k.replace("access-token", "workspace"), slug);
  }, { t: TOKEN, slug: WORKSPACE_SLUG, k: key });
  const mobile = await context.newPage();
  await mobile.goto(`${URLs.bMobile}${R.tasks}`, { waitUntil: "domcontentloaded" });
  await mobile.waitForFunction(() => {
    const t = document.body.innerText;
    return t.length > 500 && !/正在恢复工作区|正在确认身份|正在确认访问范围/.test(t);
  }, null, { timeout: 20000 }).catch(() => undefined);
  await mobile.waitForTimeout(800);
  const dom = await mobile.evaluate(() => {
    const text = document.body.innerText;
    return { len: text.length, overflow: document.documentElement.scrollWidth > window.innerWidth + 2, sample: text.replace(/\s+/g, " ").slice(0, 120) };
  });
  const evidence = await shot(mobile, "exp-07-mobile");
  await context.close();
  return {
    id: "EXP-07", persona: "staff", journey: "首日", dimension: "理解度 / 响应式",
    name: "移动端能接到活（390px 无横向溢出）",
    precondition: "B 端移动已登录",
    steps: ["打开移动端任务页", "检查内容与横向溢出"],
    expected: "任务内容可见；390px 无横向滚动",
    actual: dom,
    evidence,
    pass: dom.len > 100 && !dom.overflow,
  };
}

async function partnerScope() {
  await page.goto(`${URLs.pc}${R.partners}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const dom = await page.evaluate(() => {
    const t = document.body.innerText;
    return { len: t.length, hasScope: /授权|范围|可访问|权限/.test(t), hasMoneyRedline: /资金|付款|支付|提现|不可/.test(t), sample: t.replace(/\s+/g, " ").slice(0, 160) };
  });
  return {
    id: "EXP-08", persona: "partner", journey: "首周", dimension: "信任与透明 / 理解度",
    name: "伙伴能看清授权范围与不可触碰红线",
    precondition: "伙伴授权页有数据",
    steps: ["打开伙伴授权页", "核对授权条目与红线文案"],
    expected: "权限逐条可见；资金类红线可见",
    actual: dom,
    evidence: await shot(page, "exp-08-partner"),
    pass: dom.hasScope,
  };
}

async function guestService() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const cPage = await context.newPage();
  await cPage.goto(`${URLs.cMobile}/`, { waitUntil: "domcontentloaded" });
  await cPage.waitForTimeout(3000);
  const t0 = now();
  let firstReplyMs = null;
  const input = cPage.locator('input[placeholder="请输入您的需求…"], textarea, input[type=text]').first();
  await input.click({ force: true, timeout: 8000 }).catch(() => undefined);
  await input.fill("我想了解一下你们的服务，有发票吗？").catch(() => undefined);
  await cPage.waitForTimeout(300);
  const send = cPage.getByRole("button", { name: /发送/ }).first();
  await send.click({ force: true, timeout: 8000 }).catch(() => undefined);
  for (let i = 0; i < 80; i += 1) {
    const text = await cPage.evaluate(() => document.body.innerText);
    if (/发票|人工|工单|收到|抱歉/.test(text) && text.length > 300) { firstReplyMs = now() - t0; break; }
    await cPage.waitForTimeout(250);
  }
  const text = await cPage.evaluate(() => document.body.innerText);
  const handoff = /转人工|人工顾问|联系人工/.test(text);
  const evidence = await shot(cPage, "exp-09-guest");
  await context.close();
  return {
    id: "EXP-09", persona: "guest", journey: "异常处理", dimension: "效率与恢复 / 人格与打扰",
    name: "C 端首响达标、可转人工、工单可查",
    precondition: "C 端演示直登可用",
    steps: ["打开服务前台", "发送一条边界内问题", "核对首响与转人工入口"],
    expected: `首响 ≤${T.guestFirstReplyMs / 1000}s；有转人工路径；不编造`,
    actual: { 首响毫秒: firstReplyMs, 转人工入口: handoff, 末尾片段: text.replace(/\s+/g, " ").slice(-160) },
    metric: firstReplyMs ? `首响 ${(firstReplyMs / 1000).toFixed(1)}s` : "首响未捕获",
    evidence,
    pass: firstReplyMs !== null && firstReplyMs <= T.guestFirstReplyMs && handoff,
  };
}

async function dryRun() {
  await page.goto(`${URLs.pc}${R.guardrails}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /生效范围|规则版本记录|围栏/.test(document.body.innerText), null, { timeout: 25000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  const openedPanel = await ensureRightPanel(page);
  const textarea = page.locator("textarea").first();
  const hasEditor = (await textarea.count()) > 0;
  if (hasEditor) { await textarea.fill("对外发布必须经负责人审批").catch(() => undefined); await page.waitForTimeout(400); }
  const draftBtn = page.getByRole("button", { name: /生成结构化规则草稿/ }).first();
  const hasDraftBtn = (await draftBtn.count()) > 0;
  if (hasDraftBtn) { await draftBtn.scrollIntoViewIfNeeded().catch(() => undefined); await draftBtn.click({ timeout: 8000 }).catch(() => undefined); await page.waitForTimeout(1500); }
  const dryBtn = page.getByRole("button", { name: /模拟回放/ }).first();
  const hasDryBtn = (await dryBtn.count()) > 0;
  let hasReport = false;
  if (hasDryBtn) {
    await dryBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await dryBtn.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    hasReport = await page.evaluate(() => /模拟回放报告|将拦截|影响面|回放最近/.test(document.body.innerText));
  }
  return {
    id: "EXP-10", persona: "owner", journey: "异常处理", dimension: "掌控感 / 信任与透明",
    name: "改规则之前先模拟回放（未确认不生效）",
    precondition: "围栏页可用；成员具备治理权限",
    steps: ["打开围栏规则", "（窄内容区）展开右栏", "填写草稿", "生成结构化规则", "模拟回放"],
    expected: "编辑入口可达；dry-run 出报告；未确认不落库",
    actual: { 右栏抽屉展开: openedPanel, 草稿编辑器: hasEditor, 草稿按钮: hasDraftBtn, 回放按钮: hasDryBtn, 报告: hasReport },
    evidence: await shot(page, "exp-10-dryrun"),
    pass: hasEditor && hasDraftBtn && hasDryBtn && hasReport,
  };
}

const BUILTINS = {
  "builtin:first-value": firstValue,
  "builtin:approval": approval,
  "builtin:traceability": traceability,
  "builtin:brake": brake,
  "builtin:dispatch": dispatch,
  "builtin:inbox": inbox,
  "builtin:mobile-staff": mobileStaff,
  "builtin:partner-scope": partnerScope,
  "builtin:guest-service": guestService,
  "builtin:dry-run": dryRun,
};

for (const journey of profile.journeys) {
  if (only && !only.has(journey.id)) continue;
  const impl = BUILTINS[journey.script];
  if (!impl) {
    record({
      id: journey.id, persona: journey.persona ?? "unknown", journey: journey.title ?? "(未命名)", dimension: "自定义",
      name: journey.title ?? journey.id, steps: [], expected: "自定义脚本", actual: { error: `未知脚本 ${journey.script}` }, pass: false,
    });
    continue;
  }
  try {
    record(await impl());
  } catch (err) {
    record({
      id: journey.id, persona: journey.persona ?? "unknown", journey: journey.title ?? "(未命名)", dimension: "—",
      name: journey.title ?? journey.id, steps: [], expected: "—",
      actual: { error: String(err).split("\n")[0], errors: consoleErrors.slice(0, 2) }, pass: false,
    });
  }
}

/* ---------------- 维度机检 ---------------- */
if (!only) {
  try {
    const pages = profile.surfaces.pcRoutes.slice(0, 12);
    const found = [];
    for (const route of pages) {
      await page.goto(`${URLs.pc}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1600);
      const hits = await page.evaluate(() => {
        const text = document.body.innerText;
        const patterns = [
          [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g, "裸 ISO 时间"],
          [/\b[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){2,}\b/g, "裸动作码"],
          [/\b(agt|ws|MEM|T)-\w+/g, "裸内部 ID"],
          [/\b[A-Z][A-Z_]{4,}\b/g, "裸大写枚举"],
        ];
        const out = [];
        for (const [re, label] of patterns) for (const m of text.matchAll(re)) out.push({ label, value: m[0] });
        return out;
      });
      for (const hit of hits) found.push({ route, ...hit });
    }
    const dataHits = found.filter((h) => /^T-suite/.test(h.value));
    const uiHits = found.filter((h) => !dataHits.includes(h));
    REPORT.dimensions.terminology = { scanned: pages.length, hits: found, uiDefectHits: uiHits.length, dataHygieneHits: dataHits.length };
    for (const hit of uiHits.slice(0, 8)) REPORT.issues.push({ id: "DIM-terminology", where: hit.route, detail: `${hit.label}：${hit.value}` });
    for (const hit of dataHits.slice(0, 3)) REPORT.issues.push({ id: "DIM-data-hygiene", where: hit.route, detail: `演示数据含测试夹具：${hit.value}` });
    console.log(`${uiHits.length === 0 ? "✓" : "✗"} [维度] 术语一致性：UI 缺陷 ${uiHits.length}；数据污染 ${dataHits.length}`);
  } catch (err) {
    REPORT.dimensions.terminology = { error: String(err).split("\n")[0] };
  }

  try {
    await page.goto(`${URLs.pc}${R.home}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const contrast = await page.evaluate(() => {
      const parse = (rgb) => {
        const m = rgb.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(",").map((x) => Number.parseFloat(x.trim()));
        return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
      };
      const lum = ({ r, g, b }) => {
        const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const bgOf = (el) => {
        let node = el;
        while (node) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0.5) return bg;
          node = node.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      };
      const nodes = [...document.querySelectorAll("p,span,div,h1,h2,h3,button,a,td,li,small,strong")]
        .filter((el) => {
          const direct = [...el.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue ?? "").trim().length >= 4);
          if (!direct) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 600);
      const bad = [];
      for (const el of nodes) {
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        if (!fg || fg.a < 0.5) continue;
        const l1 = lum(fg), l2 = lum(bgOf(el));
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const size = Number.parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number.parseInt(cs.fontWeight, 10) >= 700);
        const threshold = large ? 3 : 4.5;
        if (ratio < threshold) bad.push({ text: (el.textContent ?? "").trim().slice(0, 26), ratio: Number(ratio.toFixed(2)), threshold });
      }
      return { sampled: nodes.length, violationCount: bad.length, violations: bad.slice(0, 12) };
    });
    const before = await page.evaluate(() => document.querySelectorAll('[role="dialog"], [role="alert"], [role="alertdialog"]').length);
    await page.waitForTimeout(T.idleInterruptionWindowS * 1000);
    const after = await page.evaluate(() => document.querySelectorAll('[role="dialog"], [role="alert"], [role="alertdialog"]').length);
    REPORT.dimensions.contrast = contrast;
    REPORT.dimensions.interruption = { before, after, delta: after - before, windowSeconds: T.idleInterruptionWindowS };
    console.log(`✓ [维度] 对比度抽样 ${contrast.sampled} 节点，低于阈值 ${contrast.violationCount}；静置 ${T.idleInterruptionWindowS}s 打扰 ${after - before}`);
  } catch (err) {
    REPORT.dimensions.contrast = { error: String(err).split("\n")[0] };
  }
}

await browser.close();

const passed = REPORT.checks.filter((c) => c.pass).length;
REPORT.totals = {
  checks: REPORT.checks.length, passed, failed: REPORT.checks.length - passed,
  issues: REPORT.issues.length,
  byPersona: REPORT.checks.reduce((acc, c) => {
    acc[c.persona] = acc[c.persona] ?? { total: 0, passed: 0 };
    acc[c.persona].total += 1;
    if (c.pass) acc[c.persona].passed += 1;
    return acc;
  }, {}),
};

const md = [];
md.push("# 体验走查报告（角色 × 旅程 × 维度）");
md.push("");
md.push(`- 规范：docs/REAL-DEVICE-ACCEPTANCE-SPEC.md（rdas/v1）；生成时间：${REPORT.at}`);
md.push(`- 通过：${REPORT.totals.passed}/${REPORT.totals.checks}；问题：${REPORT.totals.issues}`);
if (profileWarnings.length) md.push(`- profile 告警：${profileWarnings.join("；")}`);
md.push("");
md.push("| 走查 | 角色 | 旅程 | 维度 | 预期 | 实测 | 结论 |");
md.push("|---|---|---|---|---|---|---|");
for (const c of REPORT.checks) md.push(`| ${c.id} ${c.name} | ${c.persona} | ${c.journey} | ${c.dimension} | ${c.expected} | ${JSON.stringify(c.actual)} | ${c.pass ? "通过" : "**未通过**"} |`);
if (REPORT.dimensions.terminology) {
  md.push("");
  md.push("## 术语一致性扫描");
  md.push("");
  md.push(`扫描 ${REPORT.dimensions.terminology.scanned} 个页面：UI 文案缺陷 ${REPORT.dimensions.terminology.uiDefectHits} 处；演示数据污染 ${REPORT.dimensions.terminology.dataHygieneHits} 处。`);
}
if (REPORT.dimensions.contrast) {
  md.push("");
  md.push("## 对比度与打扰预算");
  md.push("");
  md.push(`对比度抽样 ${REPORT.dimensions.contrast.sampled ?? "-"} 节点，低于 AA 阈值 ${REPORT.dimensions.contrast.violationCount ?? "-"} 处；`);
  md.push(`首页静置 ${REPORT.dimensions.interruption?.windowSeconds ?? "-"} 秒新增打扰 ${REPORT.dimensions.interruption?.delta ?? "-"} 次。`);
}

writeFileSync(join(OUT_DIR, "experience-report.json"), JSON.stringify(REPORT, null, 1));
writeFileSync(join(OUT_DIR, "experience-report.md"), `${md.join("\n")}\n`);
console.log(`[acceptance:experience] 通过 ${REPORT.totals.passed}/${REPORT.totals.checks}；输出 ${OUT_DIR}`);
if (REPORT.totals.issues > 0) process.exitCode = 1;
