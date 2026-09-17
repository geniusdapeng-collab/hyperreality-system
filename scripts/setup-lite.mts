/**
 * setup-lite · 跨平台一键安装（Windows 原生可用，无需 bash/WSL）
 *
 * 覆盖 bootstrap.sh 的核心链路（幂等，可重复执行）：
 *   环境检查 → .env 补全 → pnpm install → PG17+pgvector（docker compose）
 *   → 迁移（migrate.ts）→ 种子（seed.ts）→ 汇总指引
 *
 * 用法：pnpm setup:lite（Windows 原生 / macOS / Linux 均可；bash 用户仍可用 pnpm setup）
 */
import { existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const SHELL = WIN; // Windows 上执行 pnpm/docker 等 .cmd 需要 shell

let pass = 0, fail = 0, skip = 0;
const ok = (m: string) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m: string) => { console.log(`  ❌ ${m}`); fail++; };
const skipIt = (m: string) => { console.log(`  ⏭️  ${m}`); skip++; };
const sec = (m: string) => console.log(`\n▸ ${m}`);

function run(cmd: string, args: string[], opts: { quiet?: boolean } = {}): boolean {
  const r = spawnSync(cmd, args, {
    cwd: ROOT, shell: SHELL, encoding: "utf-8",
    stdio: opts.quiet ? "pipe" : "inherit",
  });
  return r.status === 0;
}
function has(cmd: string, args = ["--version"]): boolean {
  const r = spawnSync(cmd, args, { shell: SHELL, stdio: "pipe" });
  return r.status === 0;
}

console.log("== WorkLoom · 一键安装（setup-lite，跨平台）==");

// 0/5 环境检查
sec("0/5 环境检查");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) ok(`node ${process.version}`);
else bad(`node 版本过低（${process.version}）→ 请安装 Node ≥ 20（推荐 24）`);
if (has("pnpm")) ok("pnpm 已安装");
else bad("pnpm 未安装 → npm i -g pnpm@10");

// 1/5 .env 补全
sec("1/5 环境变量（.env）");
if (existsSync(join(ROOT, ".env"))) ok(".env 已存在（跳过）");
else if (existsSync(join(ROOT, ".env.example"))) {
  copyFileSync(join(ROOT, ".env.example"), join(ROOT, ".env"));
  ok("已从 .env.example 复制生成 .env");
} else bad(".env.example 缺失");

// 2/5 依赖安装
sec("2/5 依赖安装（pnpm install）");
if (existsSync(join(ROOT, "node_modules"))) ok("node_modules 已存在（跳过）");
else {
  const reg = process.env.NPM_REGISTRY ?? "https://registry.npmmirror.com";
  if (run("pnpm", ["install", "--registry", reg])) ok(`pnpm install 完成（registry=${reg}）`);
  else bad("pnpm install 失败（可设 NPM_REGISTRY 换源重试）");
}

// 3/5 数据库（PG17 + pgvector，docker compose）
sec("3/5 数据库（PG17 + pgvector）");
let dbReady = false;
if (!has("docker", ["ps"])) {
  skipIt("Docker 未安装/未启动 → 跳过 PG 容器（Windows 请装 Docker Desktop 并启动；也可自装 PG17 后改 .env 的 DATABASE_URL）");
} else {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { shell: SHELL, encoding: "utf-8" });
  if (ps.stdout?.includes("workloom-im-pg")) {
    ok("PG 容器已在运行（跳过）"); dbReady = true;
  } else {
    console.log("  … 创建并拉起 PG 容器（docker compose up -d postgres，首次需拉镜像）");
    if (run("docker", ["compose", "up", "-d", "postgres"]) || run("docker-compose", ["up", "-d", "postgres"])) {
      ok("PG 容器已拉起"); dbReady = true;
    } else bad("docker compose 拉起失败 → 检查 Docker Desktop 状态");
  }
}

// 4/5 迁移 + 种子（幂等）
sec("4/5 迁移与演示数据");
if (!dbReady) {
  skipIt("数据库未就绪 → 跳过迁移与种子（数据库可用后执行 pnpm db:migrate && pnpm db:seed）");
} else {
  const tsx = join(ROOT, "node_modules", ".bin", WIN ? "tsx.cmd" : "tsx");
  const env = { ...process.env };
  if (existsSync(tsx)) {
    if (run(tsx, ["--env-file=.env", "scripts/migrate.ts"])) ok("数据库迁移完成（幂等）");
    else bad("迁移失败 → 检查 PG 与 .env 的 DATABASE_URL");
    if (run(tsx, ["--env-file=.env", "scripts/seed.ts"])) ok("演示数据种子完成（幂等）");
    else bad("种子失败 → 检查迁移是否成功");
  } else {
    bad("tsx 未安装（node_modules/.bin/tsx 缺失）→ 先执行 pnpm install");
  }
}

// 汇总
console.log(`\n== 安装汇总：✅ ${pass} · ❌ ${fail} · ⏭️  ${skip} ==`);
if (fail === 0) {
  console.log("\n下一步：pnpm app（启动桌面客户端）\n");
  process.exit(0);
} else {
  console.log("\n存在阻断项，请按上方 ❌ 指引处理后重跑本命令（幂等）。\n");
  process.exit(1);
}
