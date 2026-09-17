"""
stealth.py - 反自动化检测模块
提供两层能力：
  1. Stealth init_script（注入到 Playwright context，覆盖 navigator.webdriver 等被动检测点）
  2. 人类行为模拟 action（mouse jitter、human_click、human_type 等，对抗行为分析型检测）
"""

import asyncio
import random
from typing import Optional

from .core import ComputerToolBase, BROWSER_ACTION_TIMEOUT, MAX_TEXT_LENGTH
from .registry import register_action


# ==============================================================================
# Stealth Init Script（注入到 Playwright context.add_init_script）
# ==============================================================================

STEALTH_INIT_SCRIPT = """
(() => {
    // ========================================================================
    // 0. 核心工具：伪装 native function toString（必须最先执行）
    // B 站等严格检测会用 func.toString() 检查是否被 hook
    // ========================================================================
    const _nativeToString = Function.prototype.toString;
    const _fakeNatives = new Map();

    function markAsNative(fn, nativeName) {
        _fakeNatives.set(fn, `function ${nativeName}() { [native code] }`);
    }

    // 替换 Function.prototype.toString，让被 hook 的函数看起来像原生函数
    Function.prototype.toString = function() {
        if (_fakeNatives.has(this)) return _fakeNatives.get(this);
        return _nativeToString.call(this);
    };
    // toString 自身也要伪装
    markAsNative(Function.prototype.toString, 'toString');

    // ========================================================================
    // 1. navigator.webdriver → false
    // ========================================================================
    Object.defineProperty(navigator, 'webdriver', {
        get: () => false, configurable: true
    });

    // ========================================================================
    // 2. 补全 navigator.plugins（空列表是 headless 特征）
    // ========================================================================
    const _makePlugin = (name, filename, desc, mimeTypes) => {
        const plugin = Object.create(Plugin.prototype);
        const mimes = mimeTypes.map(mt => {
            const m = Object.create(MimeType.prototype);
            Object.defineProperties(m, {
                type: { get: () => mt.type },
                suffixes: { get: () => mt.suffixes },
                description: { get: () => mt.description || '' },
                enabledPlugin: { get: () => plugin },
            });
            return m;
        });
        Object.defineProperties(plugin, {
            name: { get: () => name },
            filename: { get: () => filename },
            description: { get: () => desc },
            length: { get: () => mimes.length },
        });
        mimes.forEach((m, i) => { Object.defineProperty(plugin, i, { get: () => m }); });
        return plugin;
    };
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            const arr = [
                _makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format',
                    [{type:'application/x-google-chrome-pdf', suffixes:'pdf', description:'Portable Document Format'}]),
                _makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', '',
                    [{type:'application/pdf', suffixes:'pdf', description:''}]),
                _makePlugin('Native Client', 'internal-nacl-plugin', '',
                    [{type:'application/x-nacl', suffixes:'', description:'Native Client Executable'},
                     {type:'application/x-pnacl', suffixes:'', description:'Portable Native Client Executable'}]),
            ];
            arr.refresh = () => {};
            Object.setPrototypeOf(arr, PluginArray.prototype);
            return arr;
        }, configurable: true
    });

    // ========================================================================
    // 3. navigator.mimeTypes 补全（与 plugins 对应）
    // ========================================================================
    Object.defineProperty(navigator, 'mimeTypes', {
        get: () => {
            const arr = [
                (() => { const m = Object.create(MimeType.prototype);
                    Object.defineProperties(m, { type:{get:()=>'application/pdf'}, suffixes:{get:()=>'pdf'}, description:{get:()=>''} }); return m; })(),
                (() => { const m = Object.create(MimeType.prototype);
                    Object.defineProperties(m, { type:{get:()=>'application/x-google-chrome-pdf'}, suffixes:{get:()=>'pdf'}, description:{get:()=>'Portable Document Format'} }); return m; })(),
            ];
            Object.setPrototypeOf(arr, MimeTypeArray.prototype);
            arr.refresh = () => {};
            return arr;
        }, configurable: true
    });

    // ========================================================================
    // 4. navigator.languages
    // ========================================================================
    Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true
    });

    // ========================================================================
    // 5. 完善 window.chrome 对象（B 站检测 chrome.app, chrome.csi, chrome.loadTimes）
    // ========================================================================
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
        window.chrome.runtime = {
            connect: function(){},
            sendMessage: function(){},
            PlatformOs: {MAC:'mac',WIN:'win',ANDROID:'android',CROS:'cros',LINUX:'linux',OPENBSD:'openbsd'},
            PlatformArch: {ARM:'arm',X86_32:'x86-32',X86_64:'x86-64',MIPS:'mips',MIPS64:'mips64'},
            PlatformNaclArch: {ARM:'arm',X86_32:'x86-32',X86_64:'x86-64',MIPS:'mips',MIPS64:'mips64'},
            RequestUpdateCheckStatus: {THROTTLED:'throttled',NO_UPDATE:'no_update',UPDATE_AVAILABLE:'update_available'},
        };
    }
    if (!window.chrome.app) {
        window.chrome.app = {
            isInstalled: false,
            InstallState: {INSTALLED:'installed',NOT_INSTALLED:'not_installed',DISABLED:'disabled'},
            RunningState: {RUNNING:'running',CANNOT_RUN:'cannot_run',READY_TO_RUN:'ready_to_run'},
            getDetails: function(){},
            getIsInstalled: function(){ return false; },
        };
    }
    if (!window.chrome.csi) {
        window.chrome.csi = function(){
            return {
                onloadT: Date.now(),
                startE: Date.now(),
                pageT: performance.now(),
                tran: 15,
            };
        };
    }
    if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = function(){
            return {
                commitLoadTime: Date.now() / 1000,
                connectionInfo: 'h2',
                finishDocumentLoadTime: Date.now() / 1000,
                finishLoadTime: Date.now() / 1000,
                firstPaintAfterLoadTime: 0,
                firstPaintTime: Date.now() / 1000,
                navigationType: 'Other',
                npnNegotiatedProtocol: 'h2',
                requestTime: Date.now() / 1000 - 0.16,
                startLoadTime: Date.now() / 1000,
                wasAlternateProtocolAvailable: false,
                wasFetchedViaSpdy: true,
                wasNpnNegotiated: true,
            };
        };
    }
    // 让 chrome 的函数通过 toString 检测
    try {
        markAsNative(window.chrome.csi, 'csi');
        markAsNative(window.chrome.loadTimes, 'loadTimes');
        markAsNative(window.chrome.app.getDetails, 'getDetails');
        markAsNative(window.chrome.app.getIsInstalled, 'getIsInstalled');
    } catch(e) {}

    // ========================================================================
    // 6. 清除 CDP 注入的 cdc_ 属性
    // ========================================================================
    const cleanCdc = (obj) => {
        try {
            for (const prop of Object.keys(obj)) {
                if (/^cdc_|^\\$cdc_/.test(prop)) {
                    try { delete obj[prop]; } catch(e) {}
                }
            }
        } catch(e) {}
    };
    cleanCdc(document);
    cleanCdc(window);

    // ========================================================================
    // 7. WebGL 参数正常化
    // ========================================================================
    const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return getParameterOrig.call(this, param);
    };
    markAsNative(WebGLRenderingContext.prototype.getParameter, 'getParameter');
    if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParam2Orig = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParam2Orig.call(this, param);
        };
        markAsNative(WebGL2RenderingContext.prototype.getParameter, 'getParameter');
    }

    // ========================================================================
    // 8. Permissions API 正常化
    // ========================================================================
    const origQuery = window.Permissions && Permissions.prototype && Permissions.prototype.query;
    if (origQuery) {
        Permissions.prototype.query = function(desc) {
            if (desc && desc.name === 'notifications') {
                return Promise.resolve({ state: Notification.permission });
            }
            return origQuery.call(this, desc);
        };
        markAsNative(Permissions.prototype.query, 'query');
    }

    // ========================================================================
    // 9. 移除 Playwright/Puppeteer 全局变量 + Error.stack 清洗
    // ========================================================================
    const autoGlobals = ['__playwright', '__pw_manual', '__PW_inspect',
                         '__puppeteer_evaluation_script__', '__driver_evaluate',
                         '__webdriver_evaluate', '__selenium_evaluate',
                         '__fxdriver_evaluate', '__driver_unwrapped',
                         '__webdriver_unwrapped', '__selenium_unwrapped',
                         '__fxdriver_unwrapped', '__webdriver_script_fn',
                         '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium',
                         '__nightmare', '__phantomas', 'domAutomation',
                         'domAutomationController'];
    for (const g of autoGlobals) {
        try { delete window[g]; } catch(e) {}
    }

    // 清洗 Error.stack 中的 playwright/puppeteer 痕迹
    const _origPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = function(err, stack) {
        if (_origPrepareStackTrace) {
            const result = _origPrepareStackTrace(err, stack);
            if (typeof result === 'string') {
                return result.replace(/playwright|puppeteer|automation/gi, 'chrome-extension');
            }
            return result;
        }
        return err.stack;
    };

    // ========================================================================
    // 10. iframe contentWindow 去 Proxy 特征
    // ========================================================================
    try {
        const origHTMLIFrameElement = Object.getOwnPropertyDescriptor(
            HTMLIFrameElement.prototype, 'contentWindow'
        );
        if (origHTMLIFrameElement && origHTMLIFrameElement.get) {
            Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                get: function() {
                    const win = origHTMLIFrameElement.get.call(this);
                    if (win && !win._stealth_patched) {
                        try {
                            Object.defineProperty(win, '_stealth_patched', {
                                value: true, enumerable: false
                            });
                        } catch(e) {}
                    }
                    return win;
                }
            });
        }
    } catch(e) {}

    // ========================================================================
    // 11. Canvas 指纹随机化
    // ========================================================================
    const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
            try {
                const w = Math.min(this.width, 16), h = Math.min(this.height, 16);
                const img = ctx.getImageData(0, 0, w, h);
                const seed = (Date.now() * 9301 + 49297) % 233280;
                for (let i = 0; i < img.data.length; i += 4) {
                    const noise = ((seed * (i+1)) % 5) - 2;
                    img.data[i] = Math.max(0, Math.min(255, img.data[i] + noise));
                }
                ctx.putImageData(img, 0, 0);
            } catch(e) {}
        }
        return _origToDataURL.apply(this, arguments);
    };
    markAsNative(HTMLCanvasElement.prototype.toDataURL, 'toDataURL');

    // ========================================================================
    // 12. AudioContext 指纹随机化
    // ========================================================================
    if (typeof AudioBuffer !== 'undefined') {
        const origGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function(channel) {
            const data = origGetChannelData.call(this, channel);
            if (data.length > 0 && !this._stealth_noise) {
                this._stealth_noise = true;
                for (let i = 0; i < Math.min(data.length, 100); i++) {
                    data[i] += (Math.random() - 0.5) * 0.0001;
                }
            }
            return data;
        };
        markAsNative(AudioBuffer.prototype.getChannelData, 'getChannelData');
    }

    // ========================================================================
    // 13. 硬件信息伪造
    // ========================================================================
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64', configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });

    // ========================================================================
    // 14. 屏幕属性正常化
    // ========================================================================
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

    // ========================================================================
    // 15. 降低 performance.now() 精度（反时序指纹）
    // ========================================================================
    const _origNow = performance.now.bind(performance);
    performance.now = () => Math.round(_origNow() * 10) / 10;
    markAsNative(performance.now, 'now');

    // ========================================================================
    // 16. Connection API 正常化
    // ========================================================================
    if (!navigator.connection) {
        Object.defineProperty(navigator, 'connection', {
            get: () => ({
                effectiveType: '4g', rtt: 50, downlink: 10, saveData: false,
                onchange: null, addEventListener: function(){}, removeEventListener: function(){},
            }),
            configurable: true
        });
    }

    // ========================================================================
    // 17. Notification 构造函数正常化（某些检测会检查 Notification.toString）
    // ========================================================================
    try {
        const origNotification = window.Notification;
        if (origNotification) {
            Object.defineProperty(origNotification, 'permission', {
                get: () => 'default', configurable: true
            });
        }
    } catch(e) {}

    // ========================================================================
    // 18. 防 CDP Runtime.enable 检测（通过 document.__proto__ 检测 CDP session）
    // ========================================================================
    try {
        // 某些检测通过 eval 的 sourceURL 来判断是否有 DevTools 连接
        // 清除 Error 中可能暴露 CDP 的信息
        const origError = Error;
        const _origCaptureStackTrace = Error.captureStackTrace;
        if (_origCaptureStackTrace) {
            Error.captureStackTrace = function(obj, fn) {
                _origCaptureStackTrace.call(this, obj, fn);
                if (obj.stack) {
                    obj.stack = obj.stack.replace(/__playwright_evaluation_script__/g, '');
                }
            };
        }
    } catch(e) {}

    // ========================================================================
    // 19. 防检测 Object.getOwnPropertyDescriptor 陷阱
    // B 站会检查 navigator.webdriver 的 property descriptor 是否有 get
    // 正常浏览器 navigator.webdriver 是 value 属性而非 getter
    // ========================================================================
    try {
        const _origGetOwnPD = Object.getOwnPropertyDescriptor;
        Object.getOwnPropertyDescriptor = function(obj, prop) {
            if (obj === navigator && prop === 'webdriver') {
                return { value: false, writable: true, configurable: true, enumerable: true };
            }
            return _origGetOwnPD.call(this, obj, prop);
        };
        markAsNative(Object.getOwnPropertyDescriptor, 'getOwnPropertyDescriptor');
    } catch(e) {}
})();
"""

# 极简版本，用于导航后快速补偿（覆盖最关键的检测点）
STEALTH_QUICK_PATCH = (
    "Object.defineProperty(navigator, 'webdriver', {get: () => false, configurable: true})"
)


# ==============================================================================
# 人类行为模拟 Mixin（Layer 1 扩展）
# ==============================================================================

class StealthMixin(ComputerToolBase):
    """反自动化检测 + 人类行为模拟 action"""

    # -----------------------------------------------------------------
    # 内部工具方法
    # -----------------------------------------------------------------

    @staticmethod
    def _human_delay(min_ms: float = 50, max_ms: float = 300):
        """返回一个模拟人类反应时间的随机延迟（秒）"""
        return random.uniform(min_ms / 1000.0, max_ms / 1000.0)

    @staticmethod
    def _jitter(value: float, amplitude: float = 3.0) -> float:
        """给坐标加微量随机偏移，模拟人手不稳定"""
        return value + random.uniform(-amplitude, amplitude)

    # -----------------------------------------------------------------
    # 注册的 action
    # -----------------------------------------------------------------

    @register_action(
        "browser_human_click", required=("selector",),
        optional={"steps": 15, "delay_before_click": 0.1},
        layer="L1",
        desc="模拟人类鼠标轨迹点击（反行为分析检测）",
        category="Layer 1: Playwright 浏览器操控"
    )
    async def browser_human_click(
        self, selector: str,
        steps: int = 15,
        delay_before_click: float = 0.1
    ) -> dict:
        """
        模拟人类点击：先分多步移动鼠标到目标区域（带随机偏移），
        短暂停顿后点击。用于对抗行为分析型检测。
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_human_click")

        try:
            element = await page.query_selector(selector)
            if not element:
                return {"error": f"元素不存在: {selector}"}

            box = await element.bounding_box()
            if not box:
                return {"error": f"元素不可见（无 bounding box）: {selector}"}

            # 目标中心 + 随机偏移（模拟人手精度）
            target_x = self._jitter(box["x"] + box["width"] / 2, amplitude=box["width"] * 0.15)
            target_y = self._jitter(box["y"] + box["height"] / 2, amplitude=box["height"] * 0.15)

            # 分多步移动鼠标（模拟人手轨迹）
            steps = max(5, min(steps, 50))
            await page.mouse.move(target_x, target_y, steps=steps)

            # 点击前短暂停顿（模拟人类反应延迟）
            delay = max(0.02, min(delay_before_click, 2.0))
            await asyncio.sleep(delay + random.uniform(0, 0.08))

            # 点击
            await page.mouse.click(target_x, target_y)

            # 点击后自然停顿
            await asyncio.sleep(self._human_delay(100, 400))

            await page.wait_for_load_state("domcontentloaded", timeout=5000)
            return {
                "clicked": selector,
                "position": {"x": round(target_x), "y": round(target_y)},
                "url": page.url,
                "title": await page.title(),
            }
        except Exception as e:
            return {"error": f"人类模拟点击失败 ({selector}): {str(e)[:300]}"}

    @register_action(
        "browser_human_type", required=("selector", "value"),
        optional={"min_char_delay": 50, "max_char_delay": 150},
        layer="L1",
        desc="模拟人类逐字输入（反行为分析检测）",
        category="Layer 1: Playwright 浏览器操控"
    )
    async def browser_human_type(
        self, selector: str, value: str,
        min_char_delay: int = 50, max_char_delay: int = 150
    ) -> dict:
        """
        模拟人类逐字输入：先点击输入框，然后逐字符输入，
        每个字符间有随机延迟。用于对抗行为分析型检测。
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_human_type")

        if len(value) > MAX_TEXT_LENGTH:
            return {"error": f"值过长 ({len(value)} chars), 最大: {MAX_TEXT_LENGTH}"}

        # 限制延迟范围
        min_char_delay = max(10, min(min_char_delay, 500))
        max_char_delay = max(min_char_delay + 10, min(max_char_delay, 1000))

        try:
            # 先点击目标输入框
            await page.click(selector, timeout=BROWSER_ACTION_TIMEOUT * 1000)
            await asyncio.sleep(self._human_delay(200, 500))

            # 逐字符输入
            for char in value:
                await page.keyboard.press(char) if len(char) > 1 else await page.keyboard.type(char)
                await asyncio.sleep(random.uniform(min_char_delay / 1000.0, max_char_delay / 1000.0))
                # 偶尔出现更长的停顿（模拟思考）
                if random.random() < 0.05:
                    await asyncio.sleep(random.uniform(0.3, 0.8))

            return {"typed": selector, "length": len(value)}
        except Exception as e:
            return {"error": f"人类模拟输入失败 ({selector}): {str(e)[:300]}"}

    @register_action(
        "browser_random_scroll", optional={"direction": "down", "distance": 300},
        layer="L1",
        desc="模拟人类自然滚动（反行为分析检测）",
        category="Layer 1: Playwright 浏览器操控"
    )
    async def browser_random_scroll(
        self, direction: str = "down", distance: int = 300
    ) -> dict:
        """
        模拟人类自然滚动：带随机距离偏移和平滑步进。
        direction: "up" 或 "down"
        distance: 基础滚动距离（px），实际会加随机偏移
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_random_scroll")

        distance = max(50, min(distance, 2000))
        actual_distance = distance + random.randint(-50, 50)
        if direction == "up":
            actual_distance = -abs(actual_distance)
        else:
            actual_distance = abs(actual_distance)

        try:
            # 分多步滚动（模拟鼠标滚轮的离散感）
            steps = random.randint(3, 8)
            step_distance = actual_distance / steps
            for _ in range(steps):
                await page.mouse.wheel(0, step_distance)
                await asyncio.sleep(random.uniform(0.02, 0.08))

            # 滚动后自然停顿
            await asyncio.sleep(self._human_delay(200, 600))

            scroll_y = await page.evaluate("window.scrollY")
            return {
                "scrolled": actual_distance,
                "direction": direction,
                "current_scroll_y": scroll_y,
            }
        except Exception as e:
            return {"error": f"模拟滚动失败: {str(e)[:300]}"}
