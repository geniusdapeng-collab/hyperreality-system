// pack-nm-merge.mjs —— 合并 monorepo 运行期直接依赖为单一 package.json
// 用途：pack-windows.sh 在其输出目录执行 npm install，得到扁平无链接的 node_modules
//      （pnpm 的 symlink 布局无法经受 Windows zip 打包-解压往返，见 v2.0.8 冒烟实证）
// 规则：
//   收集 root.dependencies + apps/server.dependencies + packages/{shared,db,base,runtime}.dependencies
//   + 运行期工具：tsx（启动器执行 .ts）、vite（preview 静态服务）
//   过滤：workspace:* 协议（内部包，源码随包）/ electron* / playwright*（运行期不需要）
//   冲突：后写覆盖先写并告警（monorepo 版本基本对齐，运行期可容忍）
// 用法：node scripts/pack-nm-merge.mjs <输出 package.json 路径>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2];
if (!OUT) { console.error("用法：node scripts/pack-nm-merge.mjs <输出路径>"); process.exit(1); }

const SKIP_VALUE = (v) => typeof v === "string" && v.startsWith("workspace:");
const SKIP_NAME = (n) => /^(electron|electron-builder|@electron|playwright|@playwright)/.test(n);

const sources = [
  ["package.json", ["dependencies"]],
  ["apps/server/package.json", ["dependencies"]],
  ["packages/shared/package.json", ["dependencies"]],
  ["packages/db/package.json", ["dependencies"]],
  ["packages/base/package.json", ["dependencies"]],
  ["packages/runtime/package.json", ["dependencies"]],
  // 运行期工具（来自 devDependencies，仅取这两个）
  ["package.json", ["devDependencies"], ["tsx"]],
  ["apps/web/package.json", ["devDependencies"], ["vite", "@tailwindcss/vite", "@vitejs/plugin-react"]],
];

const deps = {};
for (const [file, fields, only] of sources) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(ROOT, file), "utf8")); }
  catch { console.warn(`⚠️ 缺 ${file}，跳过`); continue; }
  for (const field of fields) {
    for (const [name, ver] of Object.entries(pkg[field] ?? {})) {
      if (SKIP_NAME(name) || SKIP_VALUE(ver)) continue;
      if (only && !only.includes(name)) continue;
      if (deps[name] && deps[name] !== ver) console.warn(`⚠️ 版本冲突 ${name}: ${deps[name]} → ${ver}（${file}，后者生效）`);
      deps[name] = ver;
    }
  }
}

const merged = {
  name: "workloom-runtime-payload",
  private: true,
  version: "0.0.0",
  description: "pack-windows 运行期依赖合成（npm 扁平化安装用，自动生成勿手改）",
  dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(merged, null, 2) + "\n");
console.log(`✅ 合成 ${OUT}：${Object.keys(deps).length} 个直接依赖`);
