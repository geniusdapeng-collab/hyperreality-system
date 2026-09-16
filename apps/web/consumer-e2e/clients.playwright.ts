import { expect, test, type Page } from "@playwright/test";

interface FirstClientFrame {
  client: string;
  documentWidth: number;
  viewportWidth: number;
}

declare global {
  interface Window {
    __workloomFirstClientFrame?: FirstClientFrame;
  }
}

async function installFirstFrameProbe(page: Page) {
  await page.addInitScript(() => {
    const capture = () => {
      if (window.__workloomFirstClientFrame) return;
      const client = document.querySelector<HTMLElement>("[data-workloom-client]");
      if (!client) return;
      window.__workloomFirstClientFrame = {
        client: client.dataset.workloomClient ?? "",
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    };
    // addInitScript 会早于 <html> 建立；直接观察 Document，避免因 documentElement
    // 尚不存在而漏掉 React 的第一次客户端提交。
    new MutationObserver(capture).observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", capture, { once: true });
  });
}

async function assertClientFrame(page: Page, client: string) {
  const firstFrame = await page.waitForFunction(() => window.__workloomFirstClientFrame)
    .then((handle) => handle.jsonValue() as Promise<FirstClientFrame>);
  expect(firstFrame.client).toBe(client);
  expect(firstFrame.documentWidth, JSON.stringify(firstFrame)).toBeLessThanOrEqual(firstFrame.viewportWidth + 2);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const stableFrame = await page.evaluate(() => {
    const root = document.documentElement;
    const clientRoot = document.querySelector<HTMLElement>("[data-workloom-client]");
    const rect = clientRoot?.getBoundingClientRect();
    return {
      documentWidth: root.scrollWidth,
      viewportWidth: root.clientWidth,
      clientLeft: rect?.left ?? Number.NaN,
      clientRight: rect?.right ?? Number.NaN,
    };
  });
  expect(stableFrame.documentWidth, JSON.stringify(stableFrame)).toBeLessThanOrEqual(stableFrame.viewportWidth + 2);
  expect(stableFrame.clientLeft, JSON.stringify(stableFrame)).toBeGreaterThanOrEqual(-2);
  expect(stableFrame.clientRight, JSON.stringify(stableFrame)).toBeLessThanOrEqual(stableFrame.viewportWidth + 2);
}

async function assertLongContentAndTextScale(page: Page) {
  const before = await page.evaluate(() => {
    const sample = document.querySelector<HTMLElement>("h1, h2, h3, p, button");
    return sample ? Number.parseFloat(getComputedStyle(sample).fontSize) : 0;
  });
  await page.evaluate(() => {
    const heading = document.querySelector<HTMLElement>("h1, h2, h3");
    const action = document.querySelector<HTMLElement>("button, [role='button']");
    if (heading) heading.textContent = "这是来自行业投影的超长中文页面标题，需要在当前内容区域内自然换行且绝不越界";
    if (action) action.textContent = "这是来自行业投影的超长中文动态操作名称，需要在当前按钮内自然换行且绝不越界";
    document.documentElement.style.fontSize = "200%";
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const report = await page.evaluate(() => {
    const sample = document.querySelector<HTMLElement>("h1, h2, h3, p, button");
    const offenders = Array.from(document.querySelectorAll<HTMLElement>(
      "h1, h2, h3, p, button, [role='button'], .wl-badge, .wl-status-chip, .wl-bottom-tabs__label",
    )).filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2;
    }).slice(0, 8).map((element) => ({
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? "").trim().slice(0, 60),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    return {
      scaledFontSize: sample ? Number.parseFloat(getComputedStyle(sample).fontSize) : 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      offenders,
    };
  });
  expect(report.documentWidth, JSON.stringify(report)).toBeLessThanOrEqual(report.viewportWidth + 2);
  expect(report.offenders, JSON.stringify(report)).toEqual([]);
  if (before > 0) expect(report.scaledFontSize).toBeGreaterThanOrEqual(before * 1.8);
}

test("B 端 PC：生产登录主入口和首帧不横向溢出", async ({ page }) => {
  await installFirstFrameProbe(page);
  await page.route("**/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  for (const width of [1024, 640]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("http://127.0.0.1:4310/login");
    await expect(page.getByRole("heading", { name: "登录 WorkLoom" })).toBeVisible();
    await page.getByRole("button", { name: "邮箱密码" }).click();
    await expect(page.getByLabel("邮箱")).toBeVisible();
    await expect(page.getByLabel("密码")).toBeVisible();
    await assertClientFrame(page, "b-pc");
    await assertLongContentAndTextScale(page);
  }
});

test("B 端移动：登录主入口和首帧不横向溢出", async ({ page }) => {
  await installFirstFrameProbe(page);
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 800 });
    await page.goto("http://127.0.0.1:4311/");
    await expect(page.getByRole("heading", { name: "登录 WorkLoom" })).toBeVisible();
    await page.getByLabel("工作区识别码").fill("consumer-smoke");
    await page.getByLabel("手机号").fill("13800000000");
    await page.getByLabel("验证码").fill("123456");
    await expect(page.getByRole("button", { name: "登录工作区" })).toBeEnabled();
    await assertClientFrame(page, "b-mobile");
    await assertLongContentAndTextScale(page);
  }
});

test("C 端移动：服务前台导航主流程和首帧不横向溢出", async ({ page }) => {
  await installFirstFrameProbe(page);
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 800 });
    await page.goto("http://127.0.0.1:4312/");
    const navigation = page.getByRole("navigation", { name: "服务前台主导航" });
    await expect(navigation).toBeVisible();
    const tabs = navigation.getByRole("button");
    expect(await tabs.count()).toBeGreaterThan(1);
    // 行业投影就绪时第二项通常是服务大厅；安全态下则是工单。
    // 两者都验证真实路由切换，同时不假设行业仓必须启用某个可选入口。
    const target = tabs.nth(1);
    await target.click();
    await expect(target).toHaveAttribute("aria-current", "page");
    await assertClientFrame(page, "c-mobile");
    await assertLongContentAndTextScale(page);
  }
});
