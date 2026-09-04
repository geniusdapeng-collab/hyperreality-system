/**
 * pnpm app · 桌面客户端一键启动编排器
 *
 * 面向"客户端即产品"的形态：一条命令完成 环境检查 → web 构建/预览 →
 * Electron 原生窗口（固定比例缩放 + 系统托盘 + 单实例）。
 * server 生命周期由 Electron 主进程内嵌管理（关窗最小化到托盘，夜班持续运行）。
 *
 * 用法：
 *   pnpm app            # 生产姿态（构建 dist + vite preview，首启体验最佳）
 *   pnpm app --dev      # 开发姿态（vite dev server，带 HMR）
 *   pnpm app --smoke    # 冒烟验证：拉起后健康检查通过即退出（CI/无头环境用）
 *
 * 前置：未初始化环境时自动提示先跑 pnpm setup（幂等，已装好直接跳过）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV = process.argv.includes("--dev");
const SMOKE = process.argv.includes("--smoke");
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8787);
const WEB_PORT = Number(process.env.WEB_PORT ?? (DEV ? 5173 : 4173));

const C = { cyn: "\x1b[1;36m", yel: "\x1b[1;33m", grn: "\x1b[1;32m", red: "\x1b[1;31m", rst: "\x1b[0m" };
const say = (s: string) => console.log(`${C.cyn}[app]${C.rst} ${s}`);
const warn = (s: string) => console.log(`${C.yel}[app]${C.rst} ${s}`);

const children: ChildProcess[] = [];
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) { try { p.kill("SIGTERM"); } catch { /* 已退出 */ } }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

function run(cmd: string, args: string[], name: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
  const p = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Windows 兼容：pnpm 等命令是 .cmd 脚本，无 shell 无法执行（ENOENT）
    shell: process.platform === "win32",
  });
  p.stdout?.on("data", (d: Buffer) => process.stdout.write(`${C.cyn}[${name}]${C.rst} ${d}`));
  p.stderr?.on("data", (d: Buffer) => process.stderr.write(`${C.yel}[${name}]${C.rst} ${d}`));
  p.on("exit", (code) => {
    if (!stopping) { warn(`${name} 意外退出（code=${code}），客户端关闭`); stopAll(code ?? 1); }
  });
  children.push(p);
  return p;
}

async function waitHealth(url: string, tries = 40, gapMs = 500): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

function portBusy(port: number): boolean {
  if (process.platform === "win32") {
    // Windows：netstat -ano（无 ss）
    const r = spawnSync("netstat", ["-ano"], { encoding: "utf-8", shell: true });
    return r.stdout?.includes(`:${port} `) ?? false;
  }
  const r = spawnSync("ss", ["-tln"], { encoding: "utf-8" });
  return r.stdout?.includes(`:${port} `) ?? false;
}

async function main() {
  say("WorkLoom · 桌面客户端启动中…");

  // ① 环境前置：.env 缺失 = 从未初始化——直接指引（bootstrap 幂等，客户复制即跑）
  if (!existsSync(join(ROOT, ".env"))) {
    warn("检测到本机尚未初始化环境（缺 .env）。请先执行：");
    console.log(`\n    ${C.grn}pnpm setup${C.rst}     # 一键安装（环境/依赖/数据库/迁移/种子，幂等）\n`);
    console.log(`    完成后再执行 ${C.grn}pnpm app${C.rst}。\n`);
    process.exit(1);
  }

  // ② Electron 可用性（含自愈：pnpm 默认不跑依赖 postinstall，二进制可能未下载）
  const electronBin = join(ROOT, "node_modules", ".bin", "electron");
  if (!existsSync(electronBin)) {
    warn("未检测到 Electron 依赖 → 请先 pnpm install");
    process.exit(1);
  }
  const electronDist = join(ROOT, "node_modules", "electron", "dist",
    process.platform === "win32" ? "electron.exe" : "electron");
  if (!existsSync(electronDist)) {
    say("Electron 二进制未下载（pnpm 跳过 postinstall）→ 自动补下载（npmmirror 镜像）…");
    const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "electron", "install.js")], {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/" },
    });
    if (r.status !== 0 || !existsSync(electronDist)) {
      warn("Electron 二进制下载失败——可手动执行：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js");
      process.exit(1);
    }
    say("Electron 二进制就绪 ✓");
  }

  // ③ 端口冲突预检
  for (const port of [SERVER_PORT, WEB_PORT]) {
    if (portBusy(port)) {
      warn(`端口 ${port} 已被占用——可能已有实例在运行。请先关闭或换端口（SERVER_PORT/WEB_PORT 环境变量）。`);
      process.exit(1);
    }
  }

  // ④ server 不由编排器启动——Electron 主进程内嵌管理其生命周期（产品级客户端口径）

  // ⑤ 起 web（生产=构建+preview；开发=vite dev）
  if (!DEV) {
    say("构建 web 生产包（首次约 1-2 分钟）…");
    const build = spawnSync("pnpm", ["-C", "apps/web", "build"], { cwd: ROOT, stdio: "inherit", env: process.env, shell: process.platform === "win32" });
    if (build.status !== 0) { warn("web 构建失败"); stopAll(1); return; }
    say(`启动 web 预览（:${WEB_PORT}）…`);
    run("pnpm", ["-C", "apps/web", "preview"], "web", { WEB_PORT: String(WEB_PORT), SERVER_PORT: String(SERVER_PORT) });
  } else {
    say(`启动 web dev server（:${WEB_PORT}，HMR）…`);
    run("pnpm", ["-C", "apps/web", "dev"], "web", { WEB_PORT: String(WEB_PORT), SERVER_PORT: String(SERVER_PORT) });
  }
  if (!(await waitHealth(`http://localhost:${WEB_PORT}/`, 30))) {
    warn(`web ${WEB_PORT} 未就绪`); stopAll(1); return;
  }
  say("web 就绪 ✓");

  if (SMOKE) {
    // 冒烟：拉起 Electron（主进程内嵌起 server）→ 验证 server 健康 + 窗口渲染
    const hasDisplay = !!process.env.DISPLAY || process.platform === "darwin" || process.platform === "win32";
    say("冒烟：拉起 Electron（主进程内嵌管理 server）…");
    const needNoSandbox = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
    const e = spawn(electronBin, [...(needNoSandbox ? ["--no-sandbox"] : []), join(ROOT, "apps/desktop/electron/main.cjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        WORKLOOM_WEB_URL: `http://localhost:${WEB_PORT}`,
        WORKLOOM_SERVER_URL: `http://localhost:${SERVER_PORT}`,
        SERVER_PORT: String(SERVER_PORT),
      },
      stdio: "ignore",
    });
    children.push(e);
    const serverOk = await waitHealth(`http://localhost:${SERVER_PORT}/health`, 60);
    if (!serverOk) { warn("冒烟失败：主进程内嵌 server 未就绪"); stopAll(1); return; }
    say("内嵌 server 就绪 ✓");
    if (hasDisplay) await new Promise((r) => setTimeout(r, 6000)); // 给窗口渲染时间
    e.kill("SIGTERM");
    say(`${C.grn}冒烟通过：内嵌 server + web + Electron 窗口全链路就绪${C.rst}`);
    stopAll(0); return;
  }

  // ⑥ 拉起 Electron 原生窗口（窗口关闭 → 主进程退出 → 收掉全部子进程）
  say(`打开桌面窗口 → http://localhost:${WEB_PORT}`);
  // Linux root（容器/服务器）需 --no-sandbox；普通桌面用户不受影响
  const needNoSandbox = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
  const electronArgs = [...(needNoSandbox ? ["--no-sandbox"] : []), join(ROOT, "apps/desktop/electron/main.cjs")];
  const e = spawn(electronBin, electronArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKLOOM_WEB_URL: `http://localhost:${WEB_PORT}`,
      WORKLOOM_SERVER_URL: `http://localhost:${SERVER_PORT}`,
      SERVER_PORT: String(SERVER_PORT),
    },
    stdio: "inherit",
  });
  children.push(e);
  e.on("exit", () => { say("客户端已退出，正在收拢服务…"); stopAll(0); });
  say(`${C.grn}客户端已启动：关窗 = 最小化到托盘（夜班持续运行）；托盘菜单「退出」= 彻底退出。${C.rst}`);
}

void main();
