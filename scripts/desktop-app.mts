/**
 * pnpm app · 桌面客户端一键启动编排器
 *
 * 面向"客户端即产品"的源码开发入口：一条命令完成 环境检查 → 源码 server →
 * web 构建/预览 → Electron 原生窗口（响应式布局 + 系统托盘 + 单实例）。
 * dist-payload 只由安装包流水线消费，不是 clone/setup 后运行源码客户端的前置条件。
 *
 * 用法：
 *   pnpm app            # 生产姿态（构建 dist + vite preview，首启体验最佳）
 *   pnpm app --dev      # 开发姿态（vite dev server，带 HMR）
 *   pnpm app --smoke    # 冒烟验证：拉起后健康检查通过即退出（CI/无头环境用）
 *
 * 前置：未初始化环境时自动提示先跑 pnpm setup（幂等，已装好直接跳过）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
let smokeSupport: ReturnType<typeof createSmokeSupportDirectory> | null = null;
function cleanupSmokeSupport() {
  if (!smokeSupport) return;
  try { smokeSupport.cleanup(); } catch (error) {
    warn(`冒烟临时数据清理失败：${String((error as Error)?.message ?? error)}`);
  }
  smokeSupport = null;
}
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) { try { p.kill("SIGTERM"); } catch { /* 已退出 */ } }
  setTimeout(() => { cleanupSmokeSupport(); process.exit(code); }, 500);
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

export class ElectronExecutableMissingError extends Error {}

function lstatMaybe(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Electron 官方 npm 包由 install.js 写入 path.txt；index.js 也以这个文件作为
 * 实际二进制的唯一入口。这里复用同一契约，并额外关闭越界和 symlink 跟随。
 * node_modules/electron 本身可由 pnpm 链接到内容寻址仓，但包内 dist/path.txt
 * 必须是普通目录/文件。
 */
export function resolveElectronExecutable(packageDirectory: string): string {
  const requestedPackage = resolve(packageDirectory);
  const packageStat = lstatMaybe(requestedPackage);
  if (!packageStat) throw new ElectronExecutableMissingError("未安装 Electron 依赖");
  if (!packageStat.isDirectory() && !packageStat.isSymbolicLink()) throw new Error("Electron 包路径类型异常");
  let packageRoot: string;
  try { packageRoot = realpathSync(requestedPackage); } catch {
    throw new Error("Electron 包链接无效");
  }
  if (!lstatSync(packageRoot).isDirectory()) throw new Error("Electron 包解析结果不是目录");

  const pathFile = join(packageRoot, "path.txt");
  const pathStat = lstatMaybe(pathFile);
  if (!pathStat) throw new ElectronExecutableMissingError("Electron path.txt 尚未生成");
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new Error("Electron path.txt 必须是普通文件");
  const pathEntry = readFileSync(pathFile, "utf8").trim();
  if (!pathEntry || isAbsolute(pathEntry) || pathEntry.includes("\\") || pathEntry.includes("\0")
    || /[\r\n]/u.test(pathEntry)
    || pathEntry.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Electron path.txt 内容非法");
  }

  const dist = join(packageRoot, "dist");
  const distStat = lstatMaybe(dist);
  if (!distStat) throw new ElectronExecutableMissingError("Electron dist 尚未生成");
  if (distStat.isSymbolicLink() || !distStat.isDirectory()) throw new Error("Electron dist 必须是普通目录");
  const executable = resolve(dist, pathEntry);
  if (executable === dist || !executable.startsWith(`${dist}${sep}`)) throw new Error("Electron 二进制路径逃逸出 dist");

  let cursor = dist;
  for (const part of relative(dist, executable).split(sep)) {
    if (!part || part === "." || part === "..") throw new Error("Electron 二进制相对路径非法");
    cursor = join(cursor, part);
    const stat = lstatMaybe(cursor);
    if (!stat) throw new ElectronExecutableMissingError("Electron 二进制尚未下载");
    if (stat.isSymbolicLink()) throw new Error("Electron 二进制路径不允许 symlink");
  }
  if (!lstatSync(executable).isFile()) throw new Error("Electron 二进制不是普通文件");
  return executable;
}

/** 源码工作区只校验源码入口；不得把流水线产物 dist-payload 变成启动依赖。 */
export function resolveSourceWorkspace(repoRoot: string): string {
  const root = realpathSync(resolve(repoRoot));
  for (const [relativePath, label] of [
    ["package.json", "根 package.json"],
    ["apps/server/src/index.ts", "源码 server 入口"],
    ["apps/web/package.json", "源码 web 入口"],
    ["apps/desktop/electron/main.cjs", "Electron 主进程入口"],
  ] as const) {
    const target = join(root, relativePath);
    const stat = lstatMaybe(target);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${label}缺失或类型异常：${relativePath}`);
    }
  }
  return root;
}

export function createSmokeSupportDirectory(baseDirectory = tmpdir()) {
  const root = mkdtempSync(join(baseDirectory, "workloom-app-smoke-"));
  chmodSync(root, 0o700);
  const supportDir = join(root, "user-data");
  mkdirSync(supportDir, { recursive: true, mode: 0o700 });
  let cleaned = false;
  return {
    root,
    supportDir,
    cleanup() {
      if (cleaned) return;
      rmSync(root, { recursive: true, force: true });
      cleaned = true;
    },
  };
}

export function buildElectronEnvironment({
  environment,
  webPort,
  serverPort,
  sourceRoot,
  sourceNode,
  supportDir,
  smoke,
}: {
  environment: NodeJS.ProcessEnv;
  webPort: number;
  serverPort: number;
  sourceRoot: string;
  sourceNode: string;
  supportDir?: string;
  smoke: boolean;
}): NodeJS.ProcessEnv {
  const result = {
    ...environment,
    WEB_PORT: String(webPort),
    SERVER_PORT: String(serverPort),
    WORKLOOM_WEB_PORT: String(webPort),
    WORKLOOM_SERVER_PORT: String(serverPort),
    WORKLOOM_SOURCE_MODE: "1",
    WORKLOOM_SOURCE_ROOT: sourceRoot,
    WORKLOOM_SOURCE_NODE: sourceNode,
    WORKLOOM_APP_SMOKE: smoke ? "1" : "0",
    // 源码冒烟只覆盖主进程；像素/数字人验收只能由已打包程序执行。
    WORKLOOM_RENDER_SMOKE: "0",
  };
  delete result.WORKLOOM_RESOURCES;
  delete result.WORKLOOM_WEB_URL;
  delete result.WORKLOOM_SERVER_URL;
  if (supportDir) result.WORKLOOM_SUPPORT_DIR = supportDir;
  return result;
}

/** 不依赖 ss/netstat；临时尝试占用端口，任何探测异常均按“已占用”关闭。 */
export function portBusy(port: number, serverFactory: () => Server = () => createServer()): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (busy: boolean) => {
      if (settled) return;
      settled = true;
      done(busy);
    };
    let server: Server;
    try { server = serverFactory(); } catch { finish(true); return; }
    try {
      server.unref();
      server.once("error", () => finish(true));
      server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        server.close((error) => finish(Boolean(error)));
      });
    } catch {
      finish(true);
    }
  });
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
  const electronPackage = join(ROOT, "node_modules", "electron");
  if (!lstatMaybe(electronPackage)) {
    warn("未检测到 Electron 依赖 → 请先 pnpm install");
    process.exit(1);
  }
  let electronBin: string;
  try {
    electronBin = resolveElectronExecutable(electronPackage);
  } catch (error) {
    if (!(error instanceof ElectronExecutableMissingError)) {
      warn(`Electron 安装结构异常：${String((error as Error)?.message ?? error)}`);
      process.exit(1);
    }
    say("Electron 二进制未下载（pnpm 跳过 postinstall）→ 自动补下载（npmmirror 镜像）…");
    const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "electron", "install.js")], {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/" },
    });
    try {
      electronBin = resolveElectronExecutable(electronPackage);
    } catch {
      electronBin = "";
    }
    if (r.status !== 0 || !electronBin) {
      warn("Electron 二进制下载失败——可手动执行：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js");
      process.exit(1);
    }
    say("Electron 二进制就绪 ✓");
  }

  let sourceRoot: string;
  try { sourceRoot = resolveSourceWorkspace(ROOT); } catch (error) {
    warn(String((error as Error)?.message ?? error));
    process.exit(1);
  }

  // ③ 端口冲突预检
  for (const port of [SERVER_PORT, WEB_PORT]) {
    if (await portBusy(port)) {
      warn(`端口 ${port} 已被占用——可能已有实例在运行。请先关闭或换端口（SERVER_PORT/WEB_PORT 环境变量）。`);
      process.exit(1);
    }
  }

  // ④ 源码 server 由编排器启动；正式安装包仍由 Electron bootstrap 管理内嵌运行时。
  say(`启动源码 server（:${SERVER_PORT}）…`);
  run("pnpm", ["-C", "apps/server", DEV ? "dev" : "start"], "server", { SERVER_PORT: String(SERVER_PORT) });
  if (!(await waitHealth(`http://localhost:${SERVER_PORT}/health`, 60))) {
    warn(`server ${SERVER_PORT} 未就绪`); stopAll(1); return;
  }
  say("server 就绪 ✓");

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
    // 源码冒烟验证外部源码服务与 Electron 主进程，可在 CI/无头环境执行。
    // 真实 BrowserWindow/像素/数字人由 desktop-production-release.yml 的 packaged render smoke 验证。
    say("冒烟：拉起 Electron 主进程…");
    smokeSupport = createSmokeSupportDirectory();
    const needNoSandbox = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
    const e = spawn(electronBin, [...(needNoSandbox ? ["--no-sandbox"] : []), join(ROOT, "apps/desktop/electron/main.cjs")], {
      cwd: ROOT,
      env: buildElectronEnvironment({
        environment: process.env,
        webPort: WEB_PORT,
        serverPort: SERVER_PORT,
        sourceRoot,
        sourceNode: process.execPath,
        supportDir: smokeSupport.supportDir,
        smoke: true,
      }),
      stdio: "ignore",
    });
    children.push(e);
    const exitCode = await new Promise<number | null | "timeout">((done) => {
      const timer = setTimeout(() => {
        try { e.kill("SIGTERM"); } catch { /* 已退出 */ }
        done("timeout");
      }, 15_000);
      e.once("exit", (code) => { clearTimeout(timer); done(code); });
    });
    cleanupSmokeSupport();
    if (exitCode !== 0) {
      warn(exitCode === "timeout" ? "冒烟失败：Electron 主进程 15 秒内未完成" : `冒烟失败：Electron 主进程退出码 ${String(exitCode)}`);
      stopAll(1); return;
    }
    say(`${C.grn}源码冒烟通过：server + web + Electron 主进程就绪${C.rst}`);
    stopAll(0); return;
  }

  // ⑥ 拉起 Electron 原生窗口（窗口关闭 → 主进程退出 → 收掉全部子进程）
  say(`打开桌面窗口 → http://localhost:${WEB_PORT}`);
  // Linux root（容器/服务器）需 --no-sandbox；普通桌面用户不受影响
  const needNoSandbox = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
  const electronArgs = [...(needNoSandbox ? ["--no-sandbox"] : []), join(ROOT, "apps/desktop/electron/main.cjs")];
  const e = spawn(electronBin, electronArgs, {
    cwd: ROOT,
    env: buildElectronEnvironment({
      environment: process.env,
      webPort: WEB_PORT,
      serverPort: SERVER_PORT,
      sourceRoot,
      sourceNode: process.execPath,
      smoke: false,
    }),
    stdio: "inherit",
  });
  children.push(e);
  e.on("exit", () => { say("客户端已退出，正在收拢服务…"); stopAll(0); });
  say(`${C.grn}客户端已启动：关窗 = 最小化到托盘（夜班持续运行）；托盘菜单「退出」= 彻底退出。${C.rst}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) void main();
