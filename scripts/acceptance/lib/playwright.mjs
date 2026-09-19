/**
 * playwright.mjs · 解析本仓的 Playwright（RDAS v1 执行器共用）
 *
 * 兼容三种装法：直接依赖 `playwright`、只装了 `@playwright/test`、以及 pnpm 隔离布局
 * （`node_modules/.pnpm/playwright@<版本>/node_modules/playwright`）。找不到就抛出带修复指引的错误，
 * 而不是让 L3/L4 静默跳过（静默跳过 = 未验收却写“通过”，是本规范明确禁止的）。
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function loadChromium(repoRoot) {
  const require = createRequire(join(repoRoot, "package.json"));
  const tryLoad = (spec) => {
    try {
      const mod = require(spec);
      if (mod?.chromium) return mod.chromium;
    } catch { /* 继续尝试下一个来源 */ }
    return null;
  };
  const direct = tryLoad("playwright") ?? tryLoad("@playwright/test");
  if (direct) return direct;

  const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    for (const dir of readdirSync(pnpmDir)) {
      if (!dir.startsWith("playwright@") && !dir.startsWith("@playwright+test@")) continue;
      for (const pkg of ["playwright", "@playwright/test"]) {
        const candidate = join(pnpmDir, dir, "node_modules", pkg);
        if (!existsSync(candidate)) continue;
        const chromium = tryLoad(candidate);
        if (chromium) return chromium;
      }
    }
  }
  throw new Error("未找到 playwright / @playwright/test：请在本仓执行 pnpm install（或把 playwright 加入 devDependencies）后再跑 L3/L4");
}
