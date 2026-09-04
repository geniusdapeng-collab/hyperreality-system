/**
 * WorkLoom · 桌面客户端主进程（产品级）
 *
 * 产品定义：客户端即产品本身（对标 WorkBuddy/微信桌面端），不是浏览器套壳——
 *   ① 内嵌 server 生命周期：启动即拉起后端，健康就绪后才开窗，退出即收拢；
 *   ② 固定逻辑画布：1440×900 设计稿分辨率，窗口任意拉伸只做等比缩放（zoomFactor），
 *      所有模块尺寸比例永久固定，绝不重排变形；setAspectRatio 双保险（macOS/Windows）；
 *   ③ 系统托盘常驻：关窗 = 最小化到托盘（夜班/自动任务持续运行），托盘菜单退出才是真退出；
 *   ④ 单实例锁：重复启动唤出已有窗口，不开第二个客户端。
 *
 * 环境变量：
 *   WORKLOOM_WEB_URL        加载地址（默认 http://localhost:4173，由编排器注入）
 *   WORKLOOM_SERVER_URL     后端健康检查地址（默认 http://localhost:8787）
 *   WORKLOOM_MANAGE_SERVER  =0 时不管 server 生命周期（外部已起好，如调试场景）
 */
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const WEB_URL = process.env.WORKLOOM_WEB_URL ?? "http://localhost:4173";
const SERVER_URL = process.env.WORKLOOM_SERVER_URL ?? "http://localhost:8787";
const MANAGE_SERVER = process.env.WORKLOOM_MANAGE_SERVER !== "0";
const TITLE = process.env.WORKLOOM_APP_TITLE ?? "WorkLoom 织元";

// 软件渲染环境（虚拟机/远程桌面/老显卡）放行 SwiftShader WebGL——
// 3D 舞台（Stage3D）在这类环境用软件渲染可用；有 GPU 的机器此开关无效果。
// 真正 WebGL 不可用时前端仍有 SVG 降级兜底（P0 webglOk 探测）。
app.commandLine.appendSwitch("enable-unsafe-swiftshader");

/** 设计稿逻辑分辨率——所有页面按此比例设计，窗口只做等比缩放 */
const BASE_W = 1440;
const BASE_H = 900;

let win = null;
let tray = null;
let serverProc = null;
let quitting = false;

/* ---------- 单实例锁：重复启动唤出已有窗口 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
}

/* ---------- 内嵌 server ---------- */
function startServer() {
  if (!MANAGE_SERVER) return;
  const repoRoot = path.resolve(__dirname, "../../..");
  serverProc = spawn("pnpm", ["-C", "apps/server", "start"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    // Windows 兼容：pnpm 是 .cmd 脚本，无 shell 无法执行（ENOENT）
    shell: process.platform === "win32",
  });
  serverProc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on("exit", (code) => {
    if (!quitting) {
      // 后端异常退出：客户端同步退出（托盘后台模式依赖后端存活，半死不活不如明确退出）
      process.stderr.write(`[desktop] server 意外退出（code=${code}），客户端关闭\n`);
      app.exit(1);
    }
  });
}

async function waitServerReady(tries = 90) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${SERVER_URL}/health`); if (r.ok) return true; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function stopServer() {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill("SIGTERM"); } catch { /* 已退出 */ }
  }
}

/* ---------- 固定比例缩放（核心：布局永不变形） ---------- */
function applyFixedZoom() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  // 等比缩放：取宽/高两个方向较小的缩放比——模块相对比例在任何窗口尺寸下恒定
  const factor = Math.min(w / BASE_W, h / BASE_H);
  win.webContents.setZoomFactor(Math.max(0.5, Math.min(factor, 2.5)));
}

/* ---------- 窗口 ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: BASE_W,
    height: BASE_H,
    minWidth: 1024,   // 低于此尺寸拒绝缩放（缩放比 <0.71 可读性受损）
    minHeight: 640,
    title: TITLE,
    icon: nativeImage.createFromPath(path.join(__dirname, "assets/icon.png")),
    autoHideMenuBar: true,
    backgroundColor: "#F8FAFC",
    show: false,      // 就绪后再显示，避免白屏闪烁
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // 宽高比锁定（macOS/Windows 生效；Linux 忽略时由等比 zoom 兜底 letterbox）
  try { win.setAspectRatio(BASE_W / BASE_H); } catch { /* 平台不支持则忽略 */ }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://localhost")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 去浏览器化（客户端即产品：无任何浏览器特征交互）
  win.webContents.on("context-menu", (e) => e.preventDefault()); // 禁右键菜单
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const key = (input.key ?? "").toLowerCase();
    // 禁缩族快捷键（Ctrl±/Ctrl+0）——固定比例由 zoomFactor 统一管辖，不许用户级缩放破坏
    if ((input.control || input.meta) && ["=", "-", "0", "+"].includes(key)) e.preventDefault();
    // 禁 F12 / Ctrl+Shift+I 开发者工具——产品没有"检查元素"
    if (key === "f12" || ((input.control || input.meta) && input.shift && ["i", "j", "c"].includes(key))) e.preventDefault();
    // 禁 Ctrl+R / F5 刷新——客户端没有"刷新页面"概念
    if (key === "f5" || ((input.control || input.meta) && key === "r")) e.preventDefault();
  });
  win.webContents.on("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }); // 禁 Ctrl+滚轮缩放（Chromium 部分版本经此通道）

  win.on("resize", applyFixedZoom);
  win.webContents.on("did-finish-load", applyFixedZoom);
  win.once("ready-to-show", () => { applyFixedZoom(); win.show(); });

  // 关窗 = 最小化到托盘（夜班/自动任务持续运行）；托盘「退出」才是真退出
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (Notification.isSupported()) {
        new Notification({
          title: TITLE,
          body: "已最小化到系统托盘——夜班与自动任务持续运行。右键托盘图标可彻底退出。",
        }).show();
      }
    }
  });
  win.on("closed", () => { win = null; });

  void win.loadURL(WEB_URL);
}

/* ---------- 系统托盘 ---------- */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets/tray.png"));
  tray = new Tray(icon);
  tray.setToolTip(`${TITLE} · 运行中`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
    { type: "separator" },
    { label: "退出 WorkLoom（停止全部服务）", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => { if (win) { win.isVisible() ? win.focus() : win.show(); } });
}

/* ---------- 生命周期 ---------- */
app.whenReady().then(async () => {
  startServer();
  const ready = await waitServerReady();
  if (!ready) {
    process.stderr.write("[desktop] server 健康检查超时（90s）——请先 pnpm setup 初始化环境\n");
    app.exit(1);
    return;
  }
  createTray();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", stopServer);
app.on("window-all-closed", () => { /* 托盘常驻——不因窗口全关而退出 */ });
