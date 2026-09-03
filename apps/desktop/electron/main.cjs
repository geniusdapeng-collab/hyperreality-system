/**
 * WorkLoom · Electron 桌面壳主进程
 *
 * 职责极简：起一个原生窗口加载系统 Web 端（由 scripts/desktop-app.mts 编排器
 * 保证 server + web 已就绪后再拉起本进程）。窗口即客户端——无地址栏、无标签页。
 * 后端未就绪的窗口期由 Web 端 BackendGate 兜底渲染引导页，本壳不重复实现。
 *
 * 环境变量：
 *   WORKLOOM_WEB_URL   加载地址（默认 http://localhost:5173）
 *   WORKLOOM_APP_TITLE 窗口标题（默认 "WorkLoom 织元"）
 */
const { app, BrowserWindow, shell } = require("electron");

const WEB_URL = process.env.WORKLOOM_WEB_URL ?? "http://localhost:5173";
const TITLE = process.env.WORKLOOM_APP_TITLE ?? "WorkLoom 织元";

/** @type {import("electron").BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: TITLE,
    autoHideMenuBar: true, // 无原生菜单栏——完整客户端观感
    backgroundColor: "#F8FAFC",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false, // 渲染层就是 Web 系统本身，不开 Node 权限（安全基线）
    },
  });

  // 外部链接一律交系统浏览器，客户端窗口只承载本系统
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(WEB_URL) || url.startsWith("http://localhost")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => { win = null; });
  void win.loadURL(WEB_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(); // macOS 点 dock 重开
  });
});

// 全窗口关闭即退出——编排器收到子进程退出后收掉 server/web
app.on("window-all-closed", () => { app.quit(); });
