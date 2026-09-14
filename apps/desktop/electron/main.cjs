/**
 * WorkLoom · 桌面客户端主进程（产品级 · 完全自包含）
 *
 * 产品定义：客户端即产品本身（对标 WorkBuddy/微信桌面端），不是浏览器套壳——
 *   ① 完全自包含：应用资源内携带 Node 24 + PostgreSQL 17(+pgvector) + nats + 产品载荷，
 *      首启由 bootstrap.cjs 自动完成装配→initdb→迁移→种子（AI 产品经理示例包）→起服务，
 *      用户侧零依赖、零命令行、零外部浏览器；
 *   ② 固定逻辑画布：1440×900 设计稿分辨率，窗口任意拉伸只做等比缩放（zoomFactor），
 *      所有模块尺寸比例永久固定，绝不重排变形；setAspectRatio 双保险（macOS/Windows）；
 *   ③ 系统托盘常驻：关窗 = 最小化到托盘（夜班/自动任务持续运行），托盘菜单退出才是真退出；
 *   ④ 单实例锁：重复启动唤出已有窗口，不开第二个客户端；
 *   ⑤ 首启 Splash：初始化期间展示进度（首启约 1 分钟，之后秒开）。
 *
 * 环境变量（调试覆盖，正常分发无需设置）：
 *   WORKLOOM_RESOURCES   Resources 根目录（默认 process.resourcesPath）
 *   WORKLOOM_SUPPORT_DIR 支持目录（默认当前应用独立 userData）
 *   WORKLOOM_APP_SMOKE   设为 1 时执行真实应用首启冒烟后退出
 *   WORKLOOM_ENABLE_GPU  macOS 上设为 1 时重新启用硬件加速（默认软件合成，避免黑屏）
 *   WORKLOOM_WEB_PORT    Web 端口（默认 5173）
 *   WORKLOOM_SERVER_PORT 后端端口（默认 8787）
 *   WORKLOOM_PG_PORT     PostgreSQL 端口（默认 5432）
 *   WORKLOOM_NATS_PORT   NATS 端口（默认 4222）
 */
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, dialog } = require("electron");
const path = require("node:path");

// 各产品使用独立端口，避免同一台机器上多个行业版互相连接到错误的
// PostgreSQL / server / web / NATS。打包时 extraMetadata.name 提供稳定产品键。
const PRODUCT_PORT_OFFSET = {
  "workloom-im": 0,
  "panda-cineforge": 10,
  "workroom-tiger": 20,
  "workroom-andromeda": 30,
  "workroom-eagle": 40,
  "workloom-geo": 50,
  "workroom-fox": 60,
  "hyperreality-system": 70,
  "workloom-hotel": 80,
}[app.getName()] ?? 0;
process.env.WORKLOOM_SERVER_PORT ??= String(8787 + PRODUCT_PORT_OFFSET);
process.env.WORKLOOM_WEB_PORT ??= String(5173 + PRODUCT_PORT_OFFSET);
process.env.WORKLOOM_PG_PORT ??= String(5432 + PRODUCT_PORT_OFFSET);
process.env.WORKLOOM_NATS_PORT ??= String(4222 + PRODUCT_PORT_OFFSET);
const { bootstrap } = require("./bootstrap.cjs");

const TITLE = process.env.WORKLOOM_APP_TITLE ?? app.getName();
const APP_SMOKE = process.env.WORKLOOM_APP_SMOKE === "1";
const WEB_PORT = Number(process.env.WORKLOOM_WEB_PORT || 5173);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

// Electron/Chromium 在部分 macOS + Apple Silicon 组合上会出现：DOM 已完整渲染，
// 但 GPU 合成后整个 BrowserWindow 只有黑色像素。为保证分发包稳定，macOS
// 默认使用 Chromium 软件合成；已确认 GPU 兼容的机器可用环境变量显式开启。
if (process.platform === "darwin" && process.env.WORKLOOM_ENABLE_GPU !== "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// 软件渲染时保留 SwiftShader WebGL，让 3D 舞台（Stage3D）仍可用。
app.commandLine.appendSwitch("enable-unsafe-swiftshader");

/** 设计稿逻辑分辨率——所有页面按此比例设计，窗口只做等比缩放 */
const BASE_W = 1440;
const BASE_H = 900;

let win = null;
let splash = null;
let tray = null;
let handle = null; // bootstrap 返回的 { stop, webUrl }
let quitting = false;

/* ---------- 单实例锁：重复启动唤出已有窗口 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const target = win || splash;
    if (target) { if (target.isMinimized()) target.restore(); target.show(); target.focus(); }
  });
}

/* ---------- 固定比例缩放（核心：布局永不变形） ---------- */
function applyFixedZoom() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const factor = Math.min(w / BASE_W, h / BASE_H);
  win.webContents.setZoomFactor(Math.max(0.5, Math.min(factor, 2.5)));
}

/* ---------- 首启 Splash（初始化进度可视） ---------- */
const SPLASH_HTML = (msg) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#0B1220;color:#E2E8F0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;user-select:none;cursor:default">
  <div style="font-size:28px;font-weight:700;letter-spacing:2px">WorkLoom <span style="color:#C9A227">织元</span></div>
  <div style="margin-top:10px;font-size:13px;color:#94A3B8">企业数字员工 IM · 首次启动初始化中</div>
  <div style="margin-top:28px;width:280px;height:4px;background:#1E293B;border-radius:2px;overflow:hidden"><div style="width:40%;height:100%;background:#C9A227;border-radius:2px;animation:slide 1.2s ease-in-out infinite alternate"></div></div>
  <div style="margin-top:18px;font-size:12px;color:#64748B;max-width:80%;text-align:center">${msg}</div>
  <style>@keyframes slide{from{transform:translateX(-60%)}to{transform:translateX(260%)}}</style>
</body></html>`)}`;

function showSplash(msg) {
  if (!splash) {
    splash = new BrowserWindow({
      width: 480, height: 360, resizable: false, frame: false,
      backgroundColor: "#0B1220", show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    splash.once("ready-to-show", () => splash && splash.show());
    splash.on("closed", () => { splash = null; });
  }
  void splash.loadURL(SPLASH_HTML(msg));
}

function closeSplash() {
  if (splash) { splash.close(); splash = null; }
}

/* ---------- 主窗口 ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: BASE_W,
    height: BASE_H,
    minWidth: 1024,
    minHeight: 640,
    title: TITLE,
    icon: nativeImage.createFromPath(path.join(__dirname, "assets/icon.png")),
    autoHideMenuBar: true,
    backgroundColor: "#F8FAFC",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try { win.setAspectRatio(BASE_W / BASE_H); } catch { /* 平台不支持则忽略 */ }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 去浏览器化（客户端即产品：无任何浏览器特征交互）
  win.webContents.on("context-menu", (e) => e.preventDefault());
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const key = (input.key ?? "").toLowerCase();
    if ((input.control || input.meta) && ["=", "-", "0", "+"].includes(key)) e.preventDefault();
    if (key === "f12" || ((input.control || input.meta) && input.shift && ["i", "j", "c"].includes(key))) e.preventDefault();
    if (key === "f5" || ((input.control || input.meta) && key === "r")) e.preventDefault();
  });
  win.webContents.on("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); });

  win.on("resize", applyFixedZoom);
  win.webContents.on("did-finish-load", applyFixedZoom);
  win.once("ready-to-show", () => { applyFixedZoom(); closeSplash(); win.show(); });

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
  const resourcesDir = process.env.WORKLOOM_RESOURCES
    ? path.resolve(process.env.WORKLOOM_RESOURCES)
    : process.resourcesPath;
  const supportDir = process.env.WORKLOOM_SUPPORT_DIR
    ? path.resolve(process.env.WORKLOOM_SUPPORT_DIR)
    : app.getPath("userData");

  if (!APP_SMOKE) showSplash("正在准备运行环境…");
  try {
    handle = await bootstrap({
      resourcesDir,
      supportDir,
      smoke: APP_SMOKE,
      onStatus: (msg) => { if (splash) showSplash(msg); },
    });
  } catch (e) {
    closeSplash();
    if (APP_SMOKE) console.error(`WorkLoom 启动失败：${e.message}\n日志目录：${path.join(supportDir, "logs")}`);
    else dialog.showErrorBox("WorkLoom 启动失败", `${e.message}\n\n日志目录：${path.join(supportDir, "logs")}`);
    app.exit(1);
    return;
  }
  if (APP_SMOKE) {
    await handle.stop();
    handle = null;
    app.exit(0);
    return;
  }
  createTray();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", (e) => {
  if (handle) {
    e.preventDefault();
    void handle.stop().finally(() => { handle = null; app.exit(0); });
  }
});
app.on("window-all-closed", () => { /* 托盘常驻——不因窗口全关而退出 */ });
