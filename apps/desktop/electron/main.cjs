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
 *   WORKLOOM_RESOURCES   载荷目录（默认打包内 resources/payload）
 *   WORKLOOM_WEB_PORT    Web 端口（默认 5173）
 *   WORKLOOM_SERVER_PORT 后端端口（默认 8787）
 */
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, dialog } = require("electron");
const path = require("node:path");
const { bootstrap } = require("./bootstrap.cjs");

const TITLE = process.env.WORKLOOM_APP_TITLE ?? "WorkLoom 织元";
const WEB_PORT = Number(process.env.WORKLOOM_WEB_PORT || 5173);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

// 软件渲染环境（虚拟机/远程桌面/老显卡）放行 SwiftShader WebGL——
// 3D 舞台（Stage3D）在这类环境用软件渲染可用；有 GPU 的机器此开关无效果。
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
    : path.join(process.resourcesPath, "payload");
  const supportDir = app.getPath("userData");

  showSplash("正在准备运行环境…");
  try {
    handle = await bootstrap({
      resourcesDir,
      supportDir,
      onStatus: (msg) => { if (splash) showSplash(msg); },
    });
  } catch (e) {
    closeSplash();
    dialog.showErrorBox("WorkLoom 启动失败", `${e.message}\n\n日志目录：${path.join(supportDir, "logs")}`);
    app.exit(1);
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
