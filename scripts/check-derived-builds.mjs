#!/usr/bin/env node
/**
 * 派生构建新鲜度自检（F-A：dist 不入库，源码改了但 dist 未重建 → 运行期静默失败关闭）。
 *
 * 背景：`packages/ui/dist` 与 `packages/industry-contract/dist` 都不入库，由 `postinstall`
 * 构建。开发者/AI 会话改了 src 但没有重新安装依赖时，运行时读到的仍是旧 dist：
 *  - @workloom/ui 新增导出不可见（TypeError: xxx is not a function）；
 *  - @workloom/industry-contract 新增槽位不可见（Bundle 契约报 Unrecognized key，整个行业
 *    投影 fail-closed，首访看不到术语与场景卡）。
 * 这两类症状都表现为"功能没生效"，很难从日志归因，因此在 dev/doctor 前置一次显式检查。
 *
 * 退出码：0=新鲜（或无法判断）；1=陈旧（需要重建）。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = [
  { name: "@workloom/ui", pkg: "packages/ui", entry: "dist/index.js" },
  { name: "@workloom/industry-contract", pkg: "packages/industry-contract", entry: "dist/index.js" },
];

function newestSourceMtimeMs(dir) {
  let newest = 0;
  const walk = (current) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      if (item.name === "node_modules" || item.name === "dist") continue;
      const full = join(current, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(item.name)) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

const stale = [];
for (const target of TARGETS) {
  const pkgDir = join(root, target.pkg);
  const entry = join(pkgDir, target.entry);
  if (!existsSync(entry)) {
    stale.push(`${target.name}：缺少 ${target.entry}（先跑 pnpm install 或 pnpm -C ${target.pkg} build）`);
    continue;
  }
  const built = statSync(entry).mtimeMs;
  const newestSource = newestSourceMtimeMs(join(pkgDir, "src"));
  if (newestSource > built) stale.push(`${target.name}：src 比 ${target.entry} 新，dist 可能陈旧`);
}

if (stale.length === 0) {
  if (!process.argv.includes("--quiet")) console.log("✅ 派生构建新鲜（@workloom/ui、@workloom/industry-contract）");
  process.exit(0);
}
console.error("❌ 派生构建陈旧，运行时会读取旧产物（典型症状：行业投影 fail-closed / 新增导出不可见）");
for (const line of stale) console.error(`   - ${line}`);
console.error("   修法：pnpm install（走 postinstall），或逐个重建：");
console.error("         pnpm -C packages/ui build && pnpm -C packages/industry-contract build");
process.exit(1);
