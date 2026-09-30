/**
 * C 端壳布局契约（静态守卫 · 2026-09-29 T-2026-0929-0100）。
 *
 * 背景（真机实测）：`apps/webc/src/styles/tokens.css#.phone-shell` 曾声明
 * `display:flex; flex-direction:column;`，与共享壳
 * `.wl-app-shell{display:grid; grid-template-rows:auto minmax(0,1fr) auto}` 同特异性，
 * 且在**构建产物 CSS 中更晚出现**（实测字节位 65065 vs 31441）→ 覆盖 grid：
 * 底栏脱离三段式回到普通文档流，430×932 下底栏底边停在 689px（差 243px、26% 空白）。
 * 该缺陷经 fanout/整包复制扩散到全部子仓（11 仓同源，已全量修复）。
 *
 * 本测试锁定「根因不在静态层面复发」：
 *  ① `.phone-shell` 不得声明 display / flex-direction（三段式归共享壳 grid）；
 *  ② `.phone-shell` 必须给出 height / min-height（视口高度来源，grid 行高才有确定高度）；
 *  ③ `.phone-shell` 必须仍挂在共享 `AppShell` 上（规则不落空）；
 *  ④ 产物级复算：`apps/webc/dist` 存在时，`.phone-shell` 的 display 不得为 flex
 *     （防线二：即使源码被绕过，产物也不得再出现该覆盖）。
 *
 * 真机几何由各仓 `scripts/check-shell-layout.mjs`（需要浏览器，非 CI 阻断）量测。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_PATH = join(REPO_ROOT, "apps/webc/src/styles/tokens.css");
const APP_PATH = join(REPO_ROOT, "apps/webc/src/App.tsx");
const DIST_ASSETS = join(REPO_ROOT, "apps/webc/dist/assets");

/**
 * 取出某个类选择器的首个规则体（本文件规则无嵌套，单层花括号足够）。
 * 兼容两种写法：源码 `选中器 {`（带空格）与构建产物压缩写法 `选中器{`。
 */
function ruleBody(css, selector) {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const match = pattern.exec(css);
  assert.ok(match, `未找到规则 ${selector}`);
  const start = match.index;
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

test("① .phone-shell 不得声明 display / flex-direction（三段式归共享壳 grid）", () => {
  const css = readFileSync(TOKENS_PATH, "utf8");
  const body = ruleBody(css, ".phone-shell");
  assert.doesNotMatch(body, /display\s*:\s*flex/, ".phone-shell 不得写 display:flex（会覆盖共享壳 grid）");
  assert.doesNotMatch(body, /flex-direction\s*:/, ".phone-shell 不得写 flex-direction（三段式由 grid 行模板负责）");
});

test("② .phone-shell 必须给出 height / min-height（视口高度来源）", () => {
  const css = readFileSync(TOKENS_PATH, "utf8");
  const body = ruleBody(css, ".phone-shell");
  assert.match(body, /height\s*:\s*var\(--app-height/, ".phone-shell 需要 height: var(--app-height, …)");
  assert.match(body, /min-height\s*:\s*var\(--app-height/, ".phone-shell 需要 min-height: var(--app-height, …)");
});

test("③ .phone-shell 仍挂在共享 AppShell 上（规则不落空）", () => {
  const app = readFileSync(APP_PATH, "utf8");
  assert.match(app, /className="phone-shell"/, "App.tsx 必须把 .phone-shell 交给共享 AppShell");
  assert.match(app, /AppShell/, "App.tsx 必须使用共享 AppShell");
});

test("④ 产物级复算：dist 存在时 .phone-shell 的 display 不得为 flex", () => {
  if (!existsSync(DIST_ASSETS)) {
    assert.ok(true, "dist 不存在（未构建）——源码级三道断言已覆盖；构建后本项自动生效");
    return;
  }
  const cssFile = readdirSync(DIST_ASSETS).find((name) => name.endsWith(".css"));
  assert.ok(cssFile, "dist/assets 下应有构建产物 CSS");
  const bundled = readFileSync(join(DIST_ASSETS, cssFile), "utf8");
  const body = ruleBody(bundled, ".phone-shell");
  assert.doesNotMatch(body, /display\s*:\s*flex/, "构建产物里 .phone-shell 不得出现 display:flex（防线二）");
});
