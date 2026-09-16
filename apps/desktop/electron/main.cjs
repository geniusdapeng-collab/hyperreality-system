/**
 * WorkLoom · 桌面客户端主进程（产品级 · 完全自包含）
 *
 * 产品定义：客户端即产品本身（对标 WorkBuddy/微信桌面端），不是浏览器套壳——
 *   ① 完全自包含：应用资源内携带 Node 24 + PostgreSQL 17(+pgvector) + nats + 产品载荷，
 *      首启由 bootstrap.cjs 自动完成装配→initdb→迁移→种子（AI 产品经理示例包）→起服务，
 *      用户侧零依赖、零命令行、零外部浏览器；
 *   ② 响应式工作区：默认 1440×900，允许用户自由缩放、分屏与全屏；
 *      布局由共享 Web 壳按真实可用宽度重排，不再用整页 zoomFactor 模拟响应式；
 *   ③ 系统托盘常驻：关窗 = 最小化到托盘（夜班/自动任务持续运行），托盘菜单退出才是真退出；
 *   ④ 单实例锁：重复启动唤出已有窗口，不开第二个客户端；
 *   ⑤ 首启 Splash：初始化期间展示进度（首启约 1 分钟，之后秒开）。
 *
 * 环境变量（调试覆盖，正常分发无需设置）：
 *   WORKLOOM_RESOURCES   Resources 根目录（默认 process.resourcesPath）
 *   WORKLOOM_SOURCE_MODE 仅由 pnpm app 源码编排器设为 1；复用外部源码 server/web
 *   WORKLOOM_SUPPORT_DIR 支持目录（默认当前应用独立 userData）
 *   WORKLOOM_APP_SMOKE   设为 1 时执行后端首启冒烟后退出
 *   WORKLOOM_RENDER_SMOKE 设为 1 时创建真实窗口并验证页面/数字人/像素后退出
 *   WORKLOOM_SAFE_RENDERING 设为 1 时禁用硬件加速并使用动态矢量渲染后端
 *   WORKLOOM_WEB_PORT    Web 端口（默认 5173）
 *   WORKLOOM_SERVER_PORT 后端端口（默认 8787）
 *   WORKLOOM_PG_PORT     PostgreSQL 端口（默认 5432）
 *   WORKLOOM_NATS_PORT   NATS 端口（默认 4222）
 *   WORKLOOM_PORT_OFFSET 产品端口偏移（行业包/构建配置提供，默认 0）
 */
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// 测试/多产品实例的浏览器存储必须与运行时支持目录一致，避免 Local Storage 串包。
if (process.env.WORKLOOM_SUPPORT_DIR) {
  app.setPath("userData", path.resolve(process.env.WORKLOOM_SUPPORT_DIR));
}

// 各产品使用独立端口，避免同机多实例串连。基座不得认识任何行业仓名称：
// 偏移量只能由行业构建配置（extraMetadata.workloomPortOffset）或运行环境注入。
function readProductPortOffset() {
  let configured = process.env.WORKLOOM_PORT_OFFSET;
  if (configured === undefined) {
    try {
      const packaged = require(path.join(app.getAppPath(), "package.json"));
      configured = packaged.workloomPortOffset;
    } catch { /* 开发态缺失时使用基座默认值 */ }
  }
  const parsed = Number(configured ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 900) {
    throw new Error("WORKLOOM_PORT_OFFSET 必须是 0 到 900 的整数");
  }
  return parsed;
}
const PRODUCT_PORT_OFFSET = readProductPortOffset();
process.env.WORKLOOM_SERVER_PORT ??= String(8787 + PRODUCT_PORT_OFFSET);
process.env.WORKLOOM_WEB_PORT ??= String(5173 + PRODUCT_PORT_OFFSET);
process.env.WORKLOOM_PG_PORT ??= String(5432 + PRODUCT_PORT_OFFSET);
process.env.WORKLOOM_NATS_PORT ??= String(4222 + PRODUCT_PORT_OFFSET);
const { bootstrap } = require("./bootstrap.cjs");

const TITLE = process.env.WORKLOOM_APP_TITLE ?? app.getName();
const APP_SMOKE = process.env.WORKLOOM_APP_SMOKE === "1";
const RENDER_SMOKE = process.env.WORKLOOM_RENDER_SMOKE === "1";
const SOURCE_MODE = process.env.WORKLOOM_SOURCE_MODE === "1";
const SAFE_RENDERING = process.env.WORKLOOM_SAFE_RENDERING === "1" || process.argv.includes("--safe-rendering");
const WEB_PORT = Number(process.env.WORKLOOM_WEB_PORT || 5173);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

// 渲染验收必须使用隔离的 Chromium 配置，否则开发机上“已看过欢迎页”的 localStorage
// 会让冒烟绕过首装流程；CI 与本地执行因此保持完全相同的干净首启条件。
if (RENDER_SMOKE && process.env.WORKLOOM_SUPPORT_DIR) {
  app.setPath("userData", path.resolve(process.env.WORKLOOM_SUPPORT_DIR));
}

// Live2D/Pixi 和团队 Three.js 舞台以 WebGL 为正式渲染后端，硬件加速必须默认开启。
// 只有显式安全模式才关闭 GPU；renderer 会通过 ?render=vector2d 选择完整动态 SVG 后端。
if (SAFE_RENDERING) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

/** 默认窗口尺寸；不是固定逻辑画布，用户可自由调整。 */
const DEFAULT_W = 1440;
const DEFAULT_H = 900;
const MIN_W = 960;
const MIN_H = 640;

let win = null;
let splash = null;
let tray = null;
let handle = null; // bootstrap 返回的 { stop, webUrl }
let quitting = false;
let supportDirResolved = null;
let bootstrapRunning = false;
let bootstrapStartedAt = 0;
let retryBootstrap = null;
let lastBootstrapError = null;
let lastBootstrapReference = null;

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

function resetWindowAndLayout() {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  win.setSize(DEFAULT_W, DEFAULT_H, true);
  win.center();
  win.webContents.setZoomFactor(1);
  void win.webContents.executeJavaScript(
    "window.dispatchEvent(new CustomEvent('workloom:reset-layout'))",
    true,
  );
}

/* ---------- 首启 Splash（初始化阶段与诊断可视） ---------- */
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function publicStartupError(error) {
  const value = String(error ?? "");
  if (/ENOSPC|no space|磁盘/i.test(value)) return "可用磁盘空间不足，运行环境未完成安装。请释放空间后重试。";
  if (/EACCES|EPERM|permission|权限/i.test(value)) return "应用数据目录不可写，运行环境未完成安装。请检查目录权限后重试。";
  if (/EADDRINUSE|端口|90s 内未就绪|服务.*未就绪/i.test(value)) return "本机服务未能在限定时间内启动，可能存在端口冲突或服务异常。";
  if (/数据库|PostgreSQL|initdb|迁移/i.test(value)) return "本地数据库初始化或升级未完成，现有数据没有被标记为可用。";
  if (/载荷|PAYLOAD|runtime|tsx/i.test(value)) return "安装文件缺失或校验未通过，运行环境未完成装配。";
  if (/页面加载|render|渲染/i.test(value)) return "工作台页面未能安全加载，后台服务已停止或保持在安全状态。";
  return "启动未完成。系统已停止本次启动流程，没有把未就绪状态显示为可用。";
}

const SPLASH_HTML = ({ message, error = "", reference = "", startedAt = Date.now(), progress = {} }) => {
  const failed = Boolean(error);
  const safeMessage = escapeHtml(message);
  const safeError = escapeHtml(error);
  const percent = Math.max(0, Math.min(100, Number.isFinite(Number(progress.percent)) ? Math.round(Number(progress.percent)) : 0));
  const etaSeconds = Math.max(0, Number.isFinite(Number(progress.etaSeconds)) ? Math.round(Number(progress.etaSeconds)) : 0);
  const progressText = etaSeconds > 0 ? `已完成 ${percent}% · 预计还需约 ${etaSeconds} 秒` : `已完成 ${percent}%`;
  const actions = failed ? `<div class="actions">
    <a class="primary" href="workloom-action://retry">重试启动</a>
    <a href="workloom-action://logs">打开日志目录</a>
    <a href="workloom-action://export">导出诊断</a>
    <a href="workloom-action://exit">安全退出</a>
  </div>` : "";
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorkLoom 启动</title></head><body>
  <main aria-live="polite">
    <div class="brand">WorkLoom <span>织元</span></div>
    <div class="subtitle">企业数字员工 IM · ${failed ? "启动需要处理" : "正在准备工作区"}</div>
    ${failed ? `<div class="failure" role="alert"><strong>本次启动未完成</strong><p>${safeError}</p>${reference ? `<p>支持参考：${escapeHtml(reference)}</p>` : ""}</div>` : `<div role="progressbar" aria-label="正在初始化" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${escapeHtml(`${progressText}，${message}`)}" class="progress"><i style="width:${percent}%"></i></div>`}
    <p class="stage">${safeMessage}</p>
    ${failed ? "" : `<p class="elapsed"><strong>${progressText}</strong><br>已用时 <span id="elapsed">0 秒</span> · 进度按已完成的启动检查点更新</p>`}
    ${failed ? actions : `<div class="actions"><a href="workloom-action://logs">查看启动日志</a><a href="workloom-action://export">导出诊断</a><a href="workloom-action://exit">安全退出</a></div>`}
    <p class="hint">${failed ? "重试前可先导出诊断；所有动作都不会清除业务数据。" : "请勿重复启动多个实例；若失败，页面会保留原因、重试和诊断入口。"}</p>
  </main>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#0B1220;color:#E2E8F0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;min-height:100vh;display:grid;place-items:center;padding:28px}main{width:min(100%,390px);text-align:center}.brand{font-size:28px;font-weight:700;letter-spacing:2px}.brand span{color:#C9A227}.subtitle{margin-top:10px;font-size:14px;color:#94A3B8}.progress{margin:28px auto 0;width:min(100%,280px);height:6px;background:#1E293B;border-radius:999px;overflow:hidden}.progress i{display:block;height:100%;min-width:2px;background:#C9A227;border-radius:inherit;transition:width .25s ease}.stage,.failure p{overflow-wrap:anywhere;word-break:break-word}.stage{margin:18px auto 0;font-size:14px;line-height:1.6;color:#CBD5E1;max-width:360px}.elapsed,.hint{margin:10px auto 0;font-size:14px;line-height:1.6;color:#94A3B8}.elapsed strong{color:#E2E8F0}.failure{margin-top:24px;padding:14px;border:1px solid #7F1D1D;border-radius:10px;background:#2B1018;text-align:left}.failure strong{color:#FCA5A5}.failure p{margin:8px 0 0;color:#FECACA;font-size:14px;line-height:1.55;max-height:112px;overflow:auto}.actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:18px}.actions a{align-items:center;display:flex;justify-content:center;min-height:44px;min-width:0;padding:9px 10px;border:1px solid #475569;border-radius:8px;color:#E2E8F0;text-decoration:none;font-size:14px;overflow-wrap:anywhere}.actions a:focus-visible{outline:3px solid #FACC15;outline-offset:2px}.actions .primary{background:#C9A227;border-color:#C9A227;color:#111827;font-weight:700}@media(prefers-reduced-motion:reduce){.progress i{transition:none}}
  </style>
  ${failed ? "" : `<script>const startedAt=${Number(startedAt)};const tick=()=>{const el=document.getElementById('elapsed');if(el)el.textContent=Math.max(0,Math.floor((Date.now()-startedAt)/1000))+' 秒'};tick();setInterval(tick,1000)</script>`}
</body></html>`)}`;
};

function showSplash(message, error = "", reference = lastBootstrapReference ?? "", progress = {}) {
  if (!splash) {
    splash = new BrowserWindow({
      width: 520, height: 420, minWidth: 440, minHeight: 340, resizable: Boolean(error), frame: false,
      backgroundColor: "#0B1220", show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    splash.once("ready-to-show", () => splash && splash.show());
    splash.on("closed", () => { splash = null; });
    splash.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("workloom-action://")) return;
      event.preventDefault();
      void handleSplashAction(url.slice("workloom-action://".length).replace(/\/$/, ""));
    });
  }
  splash.setResizable(Boolean(error));
  void splash.loadURL(SPLASH_HTML({ message, error, reference, startedAt: bootstrapStartedAt || Date.now(), progress }));
}

function diagnosticText() {
  const logDir = path.join(supportDirResolved ?? app.getPath("userData"), "logs");
  const sections = [
    "WorkLoom 启动诊断",
    `导出时间：${new Date().toISOString()}`,
    `应用版本：${app.getVersion()}`,
    `系统：${process.platform} ${process.arch}`,
    `支持参考：${lastBootstrapReference ?? "无"}`,
    `最近错误：${lastBootstrapError ?? "无"}`,
  ];
  try {
    const files = fs.readdirSync(logDir).filter((name) => /\.(?:log|json)$/i.test(name)).sort().slice(-12);
    for (const name of files) {
      const file = path.join(logDir, name);
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - 200_000);
      const fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      fs.closeSync(fd);
      sections.push(`\n===== ${name}（末尾 ${buffer.length} 字节）=====\n${buffer.toString("utf8")}`);
    }
  } catch (error) {
    sections.push(`\n日志读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return sections.join("\n")
    .replace(/(JWT_SECRET|PII_SALT|API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN)\s*[:=]\s*[^\s,}\]]+/gi, "$1=[已脱敏]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已脱敏]");
}

async function handleSplashAction(action) {
  if (action === "retry") {
    if (!bootstrapRunning && retryBootstrap) await retryBootstrap();
    return;
  }
  if (action === "logs") {
    await shell.openPath(path.join(supportDirResolved ?? app.getPath("userData"), "logs"));
    return;
  }
  if (action === "export") {
    const options = {
      title: "导出 WorkLoom 启动诊断",
      defaultPath: path.join(app.getPath("documents"), `WorkLoom-启动诊断-${Date.now()}.txt`),
      filters: [{ name: "文本诊断", extensions: ["txt"] }],
    };
    const result = splash
      ? await dialog.showSaveDialog(splash, options)
      : await dialog.showSaveDialog(options);
    if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, diagnosticText(), { mode: 0o600 });
    return;
  }
  if (action === "exit") {
    quitting = true;
    if (handle) await handle.stop().catch(() => undefined);
    handle = null;
    app.quit();
  }
}

function closeSplash() {
  if (splash) { splash.close(); splash = null; }
}

/* ---------- 主窗口 ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: DEFAULT_W,
    height: DEFAULT_H,
    minWidth: MIN_W,
    minHeight: MIN_H,
    title: TITLE,
    icon: nativeImage.createFromPath(path.join(__dirname, "assets/icon.png")),
    autoHideMenuBar: true,
    backgroundColor: "#F8FAFC",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 去浏览器化（客户端即产品），但保留系统缩放与无障碍能力。
  win.webContents.on("context-menu", (e) => e.preventDefault());
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const key = (input.key ?? "").toLowerCase();
    if (key === "f11") {
      e.preventDefault();
      win?.setFullScreen(!win.isFullScreen());
      return;
    }
    if ((input.control || input.meta) && input.shift && key === "0") {
      e.preventDefault();
      resetWindowAndLayout();
      return;
    }
    if (key === "f12" || ((input.control || input.meta) && input.shift && ["i", "j", "c"].includes(key))) e.preventDefault();
    if (key === "f5" || ((input.control || input.meta) && key === "r")) e.preventDefault();
  });
  void win.webContents.setVisualZoomLevelLimits(1, 3).catch(() => undefined);
  win.webContents.on("render-process-gone", (_event, details) => {
    const logDir = path.join(supportDirResolved ?? app.getPath("userData"), "logs");
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, "renderer-health.log"), `${new Date().toISOString()} renderer gone: ${JSON.stringify(details)}\n`);
    } catch { /* 日志失败不影响退出流程 */ }
  });
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 用户取消导航
    lastBootstrapError = `工作台页面加载失败（${description || code}）`;
    lastBootstrapReference = `启动-${Date.now().toString(36).toUpperCase()}`;
    showSplash("服务仍在安全停止中；可随后重试或导出诊断。", publicStartupError(lastBootstrapError), lastBootstrapReference);
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  });
  win.once("ready-to-show", () => { closeSplash(); win.show(); });

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

  const renderUrl = SAFE_RENDERING ? `${WEB_URL}?render=vector2d` : WEB_URL;
  void win.loadURL(renderUrl);
}

function pixelHealth(image) {
  const bitmap = image.toBitmap(); // Electron BGRA
  const pixelCount = Math.floor(bitmap.length / 4);
  const step = Math.max(1, Math.floor(pixelCount / 45000));
  let n = 0, sum = 0, sumSq = 0, visible = 0;
  for (let i = 0; i < pixelCount; i += step) {
    const p = i * 4;
    const lum = (bitmap[p] + bitmap[p + 1] + bitmap[p + 2]) / 3;
    n++; sum += lum; sumSq += lum * lum;
    if (lum > 18) visible++;
  }
  const mean = sum / Math.max(1, n);
  const variance = sumSq / Math.max(1, n) - mean * mean;
  return { mean: Number(mean.toFixed(2)), variance: Number(variance.toFixed(2)), visibleRatio: Number((visible / Math.max(1, n)).toFixed(4)) };
}

async function runRenderSmoke() {
  const logDir = path.join(supportDirResolved, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const deadline = Date.now() + 60000;
  let probe = null;
  while (Date.now() < deadline && win && !win.isDestroyed()) {
    probe = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('[data-product-ready="true"]');
      const welcome = document.querySelector('[aria-label^="织伴开场介绍"]');
      const avatar = welcome?.querySelector('[data-avatar-ready="true"]') || null;
      const canvas = document.createElement('canvas');
      const webgl = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
      return {
        productReady: !!root,
        welcomeReady: !!welcome,
        bundle: root?.getAttribute('data-product-bundle') || null,
        actorCount: Number(root?.getAttribute('data-product-actors') || 0),
        avatarReady: !!avatar,
        renderMode: avatar?.getAttribute('data-render-mode') || null,
        ceremonyMode: document.querySelector('[data-ceremony-render-mode]')?.getAttribute('data-ceremony-render-mode') || null,
        webgl,
        title: document.title,
        bodyText: document.body.innerText.slice(0, 1200)
      };
    })()`, true).catch((error) => ({ error: String(error) }));
    if (probe?.productReady && probe?.avatarReady) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!win || win.isDestroyed()) throw new Error("渲染窗口提前退出");
  const shot = await win.webContents.capturePage();
  const screenshotPath = path.join(logDir, SAFE_RENDERING ? "render-safe.png" : "render-default.png");
  fs.writeFileSync(screenshotPath, shot.toPNG());
  const pixels = pixelHealth(shot);
  const report = { ...probe, pixels, safeRendering: SAFE_RENDERING, screenshotPath, checkedAt: new Date().toISOString() };
  const reportPath = path.join(logDir, SAFE_RENDERING ? "render-safe.json" : "render-default.json");
  const saveReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  saveReport();
  const expectedMode = SAFE_RENDERING ? "vector2d" : "live2d-webgl";
  if (!report.productReady) throw new Error(`产品页面未就绪：${JSON.stringify(report)}`);
  if (!report.avatarReady || report.renderMode !== expectedMode) throw new Error(`数字人后端不符合契约（期望 ${expectedMode}）：${JSON.stringify(report)}`);
  if (Number(report.actorCount) < 2) throw new Error(`团队编制未加载：${JSON.stringify(report)}`);
  if (report.bundle === "ai-pm" && Number(report.actorCount) !== 14) throw new Error(`AI 产品经理 Bundle 编制应为 14 人：${JSON.stringify(report)}`);
  if (pixels.variance < 35 || pixels.visibleRatio < 0.015) throw new Error(`画面疑似纯黑/纯色：${JSON.stringify(report)}`);

  // 驱动的仍是正式口型参数、眨眼状态机和正式 motion group；只替代 CI 中不可预测的系统 TTS boundary。
  const exercised = await win.webContents.executeJavaScript(`typeof window.__loommateExercise === 'function' && (window.__loommateExercise(), true)`, true);
  if (!exercised) throw new Error("数字人动作验收探针不可用");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const avatarTelemetry = await win.webContents.executeJavaScript(`window.__loommateTelemetry ? JSON.parse(JSON.stringify(window.__loommateTelemetry)) : null`, true);
  report.avatarTelemetry = avatarTelemetry;
  saveReport();
  if (!avatarTelemetry || avatarTelemetry.mouthPeak < 0.25 || avatarTelemetry.lipStarts < 1) {
    throw new Error(`数字人口型没有实际变化：${JSON.stringify(report)}`);
  }
  if (avatarTelemetry.blinkCount < 1) throw new Error(`数字人没有完成眨眼：${JSON.stringify(report)}`);
  if (avatarTelemetry.gestureCount < 1) throw new Error(`数字人手势动作组没有真正启动：${JSON.stringify(report)}`);
  if (avatarTelemetry.backend === "live2d-webgl" && (avatarTelemetry.parameterWrites < 1 || avatarTelemetry.parameterWriteFailures > 0)) {
    throw new Error(`Live2D 参数写入失败：${JSON.stringify(report)}`);
  }

  // 完整走真实用户流程：逐段点击欢迎舞台，必须经过 bridge -> exiting -> entrance。
  // 禁止直接 setPhase("dance")，否则会再次漏掉退场定时器被 cleanup 清除一类的状态机错误。
  const transitionTrace = [];
  for (let i = 0; i < 9; i++) {
    const state = await win.webContents.executeJavaScript(`(() => {
      const ceremony = document.querySelector('[data-welcome-phase]');
      const welcome = document.querySelector('[aria-label^="织伴开场介绍"]');
      return {
        phase: ceremony?.getAttribute('data-welcome-phase') || null,
        segment: welcome?.getAttribute('data-welcome-segment') || null,
        exiting: welcome?.getAttribute('data-welcome-exiting') || null
      };
    })()`, true);
    transitionTrace.push(state);
    if (state.phase && state.phase !== "mate") break;
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const welcome = document.querySelector('[aria-label^="织伴开场介绍"]');
      if (!welcome) return false;
      welcome.click();
      return true;
    })()`, true);
    if (!clicked) break;
    await new Promise((resolve) => setTimeout(resolve, state.exiting === "true" ? 1350 : state.segment === "bridge" ? 120 : 260));
  }
  report.transitionTrace = transitionTrace;
  saveReport();
  if (!transitionTrace.some((state) => state.segment === "bridge")) throw new Error(`真实流程没有到达 bridge：${JSON.stringify(report)}`);
  if (!transitionTrace.some((state) => state.exiting === "true")) throw new Error(`真实流程没有经过 exiting：${JSON.stringify(report)}`);

  const teamDeadline = Date.now() + 20000;
  let teamProbe = null;
  while (Date.now() < teamDeadline) {
    teamProbe = await win.webContents.executeJavaScript(`(() => {
      const stage = document.querySelector('[data-ceremony-ready="true"]');
      return { ready: !!stage, mode: stage?.getAttribute('data-ceremony-render-mode') || null, actors: Number(stage?.getAttribute('data-ceremony-actors') || 0), text: document.body.innerText.slice(-500) };
    })()`, true);
    if (teamProbe?.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  // 等待 CSS 动画与 Chromium 合成至少提交一帧，截图不能沿用上一阶段的纹理。
  if (teamProbe?.ready) await new Promise((resolve) => setTimeout(resolve, 700));
  const teamShot = await win.webContents.capturePage();
  const teamScreenshotPath = path.join(logDir, SAFE_RENDERING ? "team-safe.png" : "team-default.png");
  fs.writeFileSync(teamScreenshotPath, teamShot.toPNG());
  const teamPixels = pixelHealth(teamShot);
  const expectedTeamMode = "vector2d";
  Object.assign(report, { team: { ...teamProbe, pixels: teamPixels, screenshotPath: teamScreenshotPath } });
  saveReport();
  if (!teamProbe?.ready || teamProbe.mode !== expectedTeamMode) throw new Error(`团队仪式后端不符合契约（期望 ${expectedTeamMode}）：${JSON.stringify(report)}`);
  if (report.bundle === "ai-pm" && teamProbe.actors !== Number(report.actorCount) + 1) throw new Error(`AI 产品经理团队仪式名单不完整：${JSON.stringify(report)}`);
  if (teamPixels.variance < 35 || teamPixels.visibleRatio < 0.015) throw new Error(`团队仪式画面疑似纯黑/纯色：${JSON.stringify(report)}`);

  // 仪式通过并不代表正式产品页可交付。必须真正退出仪式，依次验收职场与舞台 3D：
  // 画面非黑、团队完整、默认标签只含岗位名（系统内置人名不能泄漏到 HUD）。
  const enteredSystem = await win.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const skip = buttons.find((button) => button.textContent?.includes('跳过仪式'));
    skip?.click();
    return !!skip;
  })()`, true);
  if (!enteredSystem) throw new Error(`无法退出团队仪式：${JSON.stringify(report)}`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const confirmedSystem = await win.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const enter = buttons.find((button) => button.textContent?.includes('进入系统'));
    enter?.click();
    return !!enter;
  })()`, true);
  if (!confirmedSystem) throw new Error(`无法确认进入系统：${JSON.stringify(report)}`);

  async function captureProductScene(sceneName, fileStem) {
    const sceneDeadline = Date.now() + 15000;
    let sceneProbe = null;
    while (Date.now() < sceneDeadline) {
      sceneProbe = await win.webContents.executeJavaScript(`(() => {
        const scene = document.querySelector('[data-product-scene="${sceneName}"]');
        return {
          ready: !!scene,
          actors: Number(scene?.getAttribute('data-product-scene-actors') || 0),
          labels: scene ? [...document.querySelectorAll('[data-product-nameplate]')].map((node) => node.textContent?.trim() || '').filter(Boolean) : [],
        };
      })()`, true);
      if (sceneProbe?.ready) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    await new Promise((resolve) => setTimeout(resolve, 3600));
    const sceneShot = await win.webContents.capturePage();
    const sceneScreenshotPath = path.join(logDir, `${fileStem}-${SAFE_RENDERING ? "safe" : "default"}.png`);
    fs.writeFileSync(sceneScreenshotPath, sceneShot.toPNG());
    const scenePixels = pixelHealth(sceneShot);
    const sceneReport = { ...sceneProbe, pixels: scenePixels, screenshotPath: sceneScreenshotPath };
    if (!sceneProbe?.ready) throw new Error(`${sceneName} 未就绪：${JSON.stringify(sceneReport)}`);
    if (report.bundle === "ai-pm" && Number(sceneProbe.actors) !== Number(report.actorCount) + (sceneName.startsWith("report-stage-") ? 1 : 0)) {
      throw new Error(`${sceneName} 团队人数不完整：${JSON.stringify(sceneReport)}`);
    }
    if (scenePixels.variance < 35 || scenePixels.visibleRatio < 0.015) throw new Error(`${sceneName} 画面疑似纯黑/纯色：${JSON.stringify(sceneReport)}`);
    const builtInNames = ['顾云峥', '高明珏', '程既明', '任知遥', '叶言之', '唐亦舟', '万见庭', '陆闻秋', '祁含章', '祁清晏', '许诠宁'];
    if ((sceneProbe.labels || []).some((label) => builtInNames.some((name) => label.includes(name)))) {
      throw new Error(`${sceneName} 默认 HUD 泄漏系统内置人名：${JSON.stringify(sceneReport)}`);
    }
    const maxIdleLabels = sceneName === "workplace-3d" ? 4 : 1;
    if ((sceneProbe.labels || []).length > maxIdleLabels) {
      throw new Error(`${sceneName} 空闲态名牌过密：${JSON.stringify(sceneReport)}`);
    }
    return sceneReport;
  }

  const workplaceScene = SAFE_RENDERING ? "workplace-2d" : "workplace-3d";
  const reportStageScene = SAFE_RENDERING ? "report-stage-2d" : "report-stage-3d";
  report.workplace = await captureProductScene(workplaceScene, "workplace");
  const switchedStage = await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === '舞台');
    button?.click();
    return !!button;
  })()`, true);
  if (!switchedStage) throw new Error(`无法切换到舞台视图：${JSON.stringify(report)}`);
  report.reportStage = await captureProductScene(reportStageScene, "stage");
  saveReport();
  console.log(`WorkLoom 渲染冒烟通过：${JSON.stringify(report)}`);
}

/* ---------- 系统托盘 ---------- */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets/tray.png"));
  tray = new Tray(icon);
  tray.setToolTip(`${TITLE} · 运行中`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
    { label: "全屏 / 退出全屏", click: () => { if (win) { win.show(); win.setFullScreen(!win.isFullScreen()); } } },
    { label: "恢复默认窗口与布局", click: resetWindowAndLayout },
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
  supportDirResolved = supportDir;

  retryBootstrap = async () => {
    if (bootstrapRunning) return;
    bootstrapRunning = true;
    bootstrapStartedAt = Date.now();
    lastBootstrapError = null;
    lastBootstrapReference = null;
    if (!APP_SMOKE) showSplash("正在准备运行环境…", "", "", { phase: "starting", percent: 1, etaSeconds: 150 });
    try {
      if (handle) {
        await handle.stop();
        handle = null;
      }
      if (SOURCE_MODE) {
        if (app.isPackaged) {
          throw new Error("正式安装包禁止源码模式，必须从签名 Resources 装配完整载荷");
        }
        if (RENDER_SMOKE) {
          throw new Error("源码模式禁止执行发布渲染冒烟；请对已打包程序运行 WORKLOOM_RENDER_SMOKE=1");
        }
        const sourceRoot = process.env.WORKLOOM_SOURCE_ROOT;
        const sourceNode = process.env.WORKLOOM_SOURCE_NODE;
        if (!sourceRoot || !sourceNode || !path.isAbsolute(sourceRoot) || !path.isAbsolute(sourceNode)) {
          throw new Error("源码启动上下文不完整，请通过 pnpm app 启动");
        }
        const sourceMain = fs.realpathSync(path.join(sourceRoot, "apps", "desktop", "electron", "main.cjs"));
        if (sourceMain !== fs.realpathSync(__filename) || !fs.statSync(sourceNode).isFile()) {
          throw new Error("源码启动上下文与当前主进程不匹配，请重新执行 pnpm app");
        }
        // 源码 server/web 由 desktop-app.mts 编排并在拉起 Electron 前完成健康检查。
        // 这里仍保留 handle 契约，让托盘退出/重试与正式安装包走相同生命周期。
        handle = { stop: async () => {}, webUrl: WEB_URL };
      } else {
        handle = await bootstrap({
          resourcesDir,
          supportDir,
          smoke: APP_SMOKE,
          onStatus: (msg, progress) => { if (splash) showSplash(msg, "", "", progress); },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastBootstrapError = message;
      lastBootstrapReference = `启动-${Date.now().toString(36).toUpperCase()}`;
      if (APP_SMOKE || RENDER_SMOKE) {
        console.error(`WorkLoom 启动失败：${message}\n日志目录：${path.join(supportDir, "logs")}`);
        app.exit(1);
      } else {
        showSplash("请处理后重试，或导出诊断交给技术支持。", publicStartupError(message), lastBootstrapReference);
      }
      return;
    } finally {
      bootstrapRunning = false;
    }
    if (APP_SMOKE) {
      await handle.stop();
      handle = null;
      app.exit(0);
      return;
    }
    if (!RENDER_SMOKE) createTray();
    createWindow();
    if (RENDER_SMOKE) {
      try {
        await runRenderSmoke();
        quitting = true;
        await handle.stop();
        handle = null;
        app.exit(0);
      } catch (error) {
        console.error(`WorkLoom 渲染冒烟失败：${error instanceof Error ? error.stack : String(error)}`);
        quitting = true;
        if (handle) await handle.stop().catch(() => undefined);
        handle = null;
        app.exit(1);
      }
    }
  };

  await retryBootstrap();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && handle) createWindow(); });
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", (e) => {
  if (handle) {
    e.preventDefault();
    void handle.stop().finally(() => { handle = null; app.exit(0); });
  }
});
app.on("window-all-closed", () => { /* 托盘常驻——不因窗口全关而退出 */ });
