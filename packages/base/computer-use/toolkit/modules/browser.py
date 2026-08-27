"""
browser.py - Layer 1: Playwright 浏览器结构化操控 Mixin
通过 CDP 连接已运行的 Chromium，提供零 Token 消耗的结构化浏览器操作。
"""

import asyncio
import base64
import json
import re
import socket
import shutil
import subprocess
from pathlib import Path
from typing import Optional
from uuid import uuid4

from .core import (
    ComputerToolBase,
    CDP_PORT,
    CDP_URL,
    BROWSER_ACTION_TIMEOUT,
    MAX_BROWSER_LINKS,
    MAX_CONTENT_LENGTH,
    MAX_TEXT_LENGTH,
    MAX_SCREENSHOT_SIZE,
    OUTPUT_DIR,
)
from .registry import register_action
from .stealth import STEALTH_INIT_SCRIPT, STEALTH_QUICK_PATCH


class BrowserMixin(ComputerToolBase):
    """Layer 1: Playwright 浏览器结构化操控（零 Token 消耗）"""

    # Playwright 连接状态（类级默认值，避免 AttributeError）
    _pw_instance = None
    _pw_browser = None
    _pw_context = None
    _pw_page = None
    _pw_active_frame = None  # 当前活跃的 iframe（None 表示主框架）
    _pw_last_error: Optional[str] = None  # 最近一次连接失败的原因

    # -----------------------------------------------------------------
    # 诊断工具
    # -----------------------------------------------------------------

    @staticmethod
    def _check_cdp_port_open(port: int = CDP_PORT, timeout: float = 1.0) -> bool:
        """快速探测 CDP 端口是否在监听（socket 级，<1s）"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                return s.connect_ex(("127.0.0.1", port)) == 0
        except OSError:
            return False

    @staticmethod
    def _diagnose_cdp_failure() -> dict:
        """
        分级诊断 CDP 连接失败原因，返回结构化诊断信息。
        诊断顺序：Playwright 安装 → 浏览器进程 → CDP 端口 → 桌面环境
        """
        diag = {
            "playwright_installed": False,
            "browser_binary": None,
            "browser_process_running": False,
            "cdp_port_listening": False,
            "desktop_running": False,
            "suggestion": "",
        }

        # 1. Playwright 是否可导入
        try:
            import playwright  # noqa: F401
            diag["playwright_installed"] = True
        except ImportError:
            diag["suggestion"] = "Playwright 未安装。执行: pip3 install playwright"
            return diag

        # 2. 浏览器二进制是否存在
        for cmd in ("chromium", "chromium-browser", "google-chrome"):
            if shutil.which(cmd):
                diag["browser_binary"] = cmd
                break
        if not diag["browser_binary"]:
            diag["suggestion"] = (
                "未找到 chromium/chrome 浏览器。"
                "请先执行安装脚本: bash <skill-directory>/scripts/install.sh"
            )
            return diag

        # 3. 浏览器进程是否在运行
        try:
            result = subprocess.run(
                ["pgrep", "-f", f"remote-debugging-port.*{CDP_PORT}"],
                capture_output=True, timeout=3
            )
            diag["browser_process_running"] = result.returncode == 0
        except Exception:
            pass

        # 4. CDP 端口是否在监听
        diag["cdp_port_listening"] = BrowserMixin._check_cdp_port_open(CDP_PORT)

        # 5. 桌面 (Xvfb) 是否在运行
        try:
            result = subprocess.run(
                ["pgrep", "-f", "Xvfb"],
                capture_output=True, timeout=3
            )
            diag["desktop_running"] = result.returncode == 0
        except Exception:
            pass

        # 生成建议
        if not diag["desktop_running"]:
            diag["suggestion"] = (
                "虚拟桌面 (Xvfb) 未运行。"
                "请先启动桌面: bash <skill-directory>/scripts/start_desktop.sh"
            )
        elif not diag["browser_process_running"]:
            diag["suggestion"] = (
                f"浏览器未以 CDP 模式启动（端口 {CDP_PORT} 无浏览器进程）。"
                "请重启桌面环境（会自动启动浏览器）: "
                "bash <skill-directory>/scripts/stop_desktop.sh && "
                "bash <skill-directory>/scripts/start_desktop.sh"
            )
        elif not diag["cdp_port_listening"]:
            diag["suggestion"] = (
                f"浏览器进程存在但 CDP 端口 {CDP_PORT} 未监听，浏览器可能已崩溃。"
                "请重启桌面: bash <skill-directory>/scripts/stop_desktop.sh && "
                "bash <skill-directory>/scripts/start_desktop.sh"
            )
        else:
            diag["suggestion"] = (
                f"CDP 端口 {CDP_PORT} 已监听但 Playwright 连接失败，"
                "可能是 Playwright 版本不兼容。尝试: pip3 install --upgrade playwright"
            )

        return diag

    # -----------------------------------------------------------------
    # 连接管理
    # -----------------------------------------------------------------

    async def _probe_connection_alive(self) -> bool:
        """快速探测现有 Playwright 连接是否仍然有效（<100ms）"""
        try:
            if not self._pw_page or self._pw_page.is_closed():
                return False
            # 用一个轻量级的 evaluate 来探测连接是否还活着
            await self._pw_page.evaluate("1+1")
            return True
        except Exception:
            return False

    async def _force_reconnect(self):
        """强制清理旧连接并重新建立（断线重连核心逻辑）"""
        # 清理旧连接（静默处理所有异常）
        try:
            if self._pw_browser:
                await self._pw_browser.close()
        except Exception:
            pass
        self._pw_browser = None
        self._pw_context = None
        self._pw_page = None
        # 注意：保留 _pw_instance（Playwright runtime），避免重复启动

    async def _get_playwright_browser(self):
        """
        懒加载 Playwright 浏览器连接（带断线重连）。
        通过 CDP 连接已运行的 Chromium 实例（由 start_desktop.sh 启动）。
        返回 (browser, context, page) 三元组，连接失败返回 (None, None, None)。
        失败原因保存在 self._pw_last_error 供调用方使用。

        断线重连策略：
        1. 如果已有连接，先用 evaluate("1+1") 快速探测有效性
        2. 探测失败（浏览器崩溃/重启）→ 自动 cleanup 旧连接 → 重新 connect_over_cdp
        3. 最多重连 1 次，避免无限循环
        """
        self._pw_last_error = None

        # 如果已有连接，先探测有效性
        if self._pw_page and not self._pw_page.is_closed():
            if await self._probe_connection_alive():
                return self._pw_browser, self._pw_context, self._pw_page
            else:
                # 连接已死，强制清理后重连
                await self._force_reconnect()

        # 如果有 context 但 page 关了（所有 tab 被关闭），取活跃 page
        if self._pw_context:
            try:
                pages = self._pw_context.pages
                if pages:
                    self._pw_page = pages[-1]
                    if await self._probe_connection_alive():
                        return self._pw_browser, self._pw_context, self._pw_page
                    else:
                        await self._force_reconnect()
            except Exception:
                await self._force_reconnect()

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            self._pw_last_error = "playwright_not_installed"
            return None, None, None

        # 快速端口探测：避免 Playwright 15s 超时等待
        if not self._check_cdp_port_open(CDP_PORT):
            self._pw_last_error = "cdp_port_not_listening"
            return None, None, None

        try:
            if not self._pw_instance:
                self._pw_instance = await async_playwright().start()

            self._pw_browser = await self._pw_instance.chromium.connect_over_cdp(CDP_URL)
            contexts = self._pw_browser.contexts
            if contexts:
                self._pw_context = contexts[0]
                pages = self._pw_context.pages
                self._pw_page = pages[-1] if pages else await self._pw_context.new_page()
            else:
                self._pw_context = await self._pw_browser.new_context()
                self._pw_page = await self._pw_context.new_page()

            # 注入反自动化检测脚本（对所有新页面生效）
            try:
                await self._pw_context.add_init_script(STEALTH_INIT_SCRIPT)
            except Exception:
                pass  # init_script 注入失败不阻断连接
            # 对当前已加载的页面也执行一次
            try:
                await self._pw_page.evaluate(STEALTH_INIT_SCRIPT)
            except Exception:
                pass  # about:blank 等页面可能报错，忽略

            self._pw_last_error = None
            return self._pw_browser, self._pw_context, self._pw_page
        except Exception as e:
            # 连接失败（浏览器未启动、CDP 端口未开放等）
            self._pw_last_error = f"connect_failed: {str(e)[:200]}"
            self._pw_browser = None
            self._pw_context = None
            self._pw_page = None
            return None, None, None

    async def _ensure_playwright(self) -> tuple:
        """确保 Playwright 连接可用，不可用时返回错误字典"""
        browser, context, page = await self._get_playwright_browser()
        if page is None:
            return None, None, None
        return browser, context, page

    def _get_active_target(self):
        """
        获取当前操作目标：如果已切换到 iframe 则返回 frame 对象，否则返回 page。
        用于 browser_click/fill/eval 等操作自动支持 iframe。
        """
        if self._pw_active_frame is not None:
            return self._pw_active_frame
        return self._pw_page

    def _pw_error(self, action_name: str = "") -> dict:
        """生成 Playwright 不可用时的统一错误信息（含分层降级提示）"""
        reason = self._pw_last_error or "unknown"
        hint = action_name and f"（{action_name}）" or ""
        return {
            "error": f"Playwright 未连接{hint}，请先执行 browser_connect 诊断具体原因。",
            "fallback_chain": (
                "降级路径（按优先级）：\n"
                "1. Layer 2: 用 accessibility_tree(app_name='chromium') 获取页面语义结构（零 Token），"
                "结合 key/type 进行键盘导航操作\n"
                "2. Layer 3: 用 screenshot + left_click/type/key 操作浏览器（高 Token 消耗，最后手段）"
            ),
            "internal_reason": reason,
        }

    async def _cleanup_playwright(self):
        """清理 Playwright 连接"""
        try:
            if self._pw_browser:
                await self._pw_browser.close()
        except Exception:
            pass
        try:
            if self._pw_instance:
                await self._pw_instance.stop()
        except Exception:
            pass
        self._pw_browser = None
        self._pw_context = None
        self._pw_page = None
        self._pw_instance = None

    # -----------------------------------------------------------------
    # 浏览器操作
    # -----------------------------------------------------------------

    @register_action("browser_connect", layer="L1",
                      desc="连接浏览器 CDP 实例，返回所有标签页信息", category="Layer 1: Playwright 浏览器操控")
    async def browser_connect(self) -> dict:
        """
        连接浏览器 CDP 实例，返回可用的标签页信息。
        如果连接失败，自动执行分级诊断并返回具体原因和修复建议。
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            # 执行分级诊断，给出具体原因而非泛泛的错误
            diag = self._diagnose_cdp_failure()
            return {
                "error": f"无法连接浏览器 CDP (http://127.0.0.1:{CDP_PORT})",
                "diagnosis": {
                    "playwright_installed": diag["playwright_installed"],
                    "browser_binary": diag["browser_binary"],
                    "browser_process_running": diag["browser_process_running"],
                    "cdp_port_listening": diag["cdp_port_listening"],
                    "desktop_running": diag["desktop_running"],
                    "internal_error": self._pw_last_error,
                },
                "suggestion": diag["suggestion"],
                "fallback_chain": (
                    "如果无法修复 CDP 连接，按以下优先级降级：\n"
                    "1. Layer 2 (AXTree): accessibility_tree(app_name='chromium') 获取页面语义结构"
                    "（零 Token 消耗，可配合 key/type 键盘导航）\n"
                    "2. Layer 3 (截图): screenshot 定位 → left_click 点击 → type 输入 → key 快捷键"
                    "（高 Token 消耗，最后手段）"
                ),
            }
        tabs = []
        for i, p in enumerate(context.pages):
            tabs.append({"index": i, "url": p.url, "title": await p.title()})
        return {"status": "connected", "cdp_url": CDP_URL, "tabs": tabs}

    @register_action("browser_goto", required=("url",), optional={"wait_until": "domcontentloaded"}, layer="L1",
                      desc="导航到 URL（wait_until: domcontentloaded/load/networkidle）", category="Layer 1: Playwright 浏览器操控")
    async def browser_goto(self, url: str, wait_until: str = "domcontentloaded") -> dict:
        """导航到指定 URL"""
        if not url or not (url.startswith("http://") or url.startswith("https://") or url.startswith("about:")):
            return {"error": f"Invalid URL: {url!r}. Must start with http://, https://, or about:"}
        if wait_until not in ("domcontentloaded", "load", "networkidle", "commit"):
            wait_until = "domcontentloaded"

        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_goto")
        try:
            response = await page.goto(url, wait_until=wait_until,
                                       timeout=BROWSER_ACTION_TIMEOUT * 1000)
            # 导航后快速补偿反检测（覆盖时序竞争边界）
            try:
                await page.evaluate(STEALTH_QUICK_PATCH)
            except Exception:
                pass
            status = response.status if response else None
            return {
                "url": page.url,
                "title": await page.title(),
                "status": status,
            }
        except Exception as e:
            return {"error": f"Navigation failed: {str(e)[:500]}"}

    @register_action("browser_url", layer="L1",
                      desc="获取当前页面 URL 和标题（精确替代 get_browser_url）", category="Layer 1: Playwright 浏览器操控")
    async def browser_url(self) -> dict:
        """获取当前页面 URL 和标题（精确，替代 get_browser_url 的 hack 方式）"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_url")
        try:
            return {"url": page.url, "title": await page.title()}
        except Exception as e:
            return {"error": f"获取 URL 失败: {str(e)[:300]}"}

    @register_action("browser_content", optional={"selector": None}, layer="L1",
                      desc="获取页面文本内容（默认 body 全文）", category="Layer 1: Playwright 浏览器操控")
    async def browser_content(self, selector: Optional[str] = None) -> dict:
        """
        获取页面文本内容（结构化，零 Token 消耗）。
        selector: 可选 CSS 选择器，不指定则获取 body 的 innerText。
        支持 iframe：如果已通过 browser_switch_frame 切换，则获取 iframe 内的内容。
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_content")
        try:
            target = self._get_active_target()
            sel = selector or "body"
            text = await target.inner_text(sel, timeout=BROWSER_ACTION_TIMEOUT * 1000)
            if len(text) > MAX_CONTENT_LENGTH:
                text = text[:MAX_CONTENT_LENGTH] + f"\n... [truncated, total {len(text)} chars]"
            frame_info = {"in_frame": self._pw_active_frame is not None}
            return {"text": text, "selector": sel, "url": page.url, **frame_info}
        except Exception as e:
            return {"error": f"获取内容失败: {str(e)[:300]}"}

    @register_action("browser_click", required=("selector",),
                      optional={"button": "left", "force": False, "position_x": None, "position_y": None},
                      layer="L1",
                      desc="通过 CSS/Text 选择器精准点击（支持右键/中键、force 模式、位置偏移）", category="Layer 1: Playwright 浏览器操控")
    async def browser_click(self, selector: str, button: str = "left",
                            force: bool = False,
                            position_x: Optional[int] = None,
                            position_y: Optional[int] = None) -> dict:
        """
        通过 CSS/Text 选择器精准点击元素（无需坐标）。
        button: "left"（默认）、"right"、"middle"
        force: True 时跳过可操作性检查（元素被遮挡时强制点击）
        position_x/position_y: 点击元素内的特定偏移位置（相对于元素左上角）
        """
        if button not in ("left", "right", "middle"):
            return {"error": f"Invalid button: {button!r}. Must be 'left', 'right', or 'middle'"}
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_click")
        try:
            target = self._get_active_target()
            click_kwargs = {
                "timeout": BROWSER_ACTION_TIMEOUT * 1000,
                "button": button,
                "force": force,
            }
            if position_x is not None and position_y is not None:
                click_kwargs["position"] = {"x": position_x, "y": position_y}
            await target.click(selector, **click_kwargs)
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=5000)
            except Exception:
                pass  # iframe 内点击可能不触发主页面 load state 变化
            return {"clicked": selector, "button": button, "url": page.url, "title": await page.title()}
        except Exception as e:
            return {"error": f"点击失败 ({selector}): {str(e)[:300]}"}

    @register_action("browser_fill", required=("selector", "value"), layer="L1",
                      desc="填写表单输入框", category="Layer 1: Playwright 浏览器操控")
    async def browser_fill(self, selector: str, value: str) -> dict:
        """填写表单输入框（支持 iframe：如果已切换 frame 则在 frame 内操作）"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_fill")
        if len(value) > MAX_TEXT_LENGTH:
            return {"error": f"值过长 ({len(value)} chars), 最大: {MAX_TEXT_LENGTH}"}
        try:
            target = self._get_active_target()
            await target.fill(selector, value, timeout=BROWSER_ACTION_TIMEOUT * 1000)
            return {"filled": selector, "length": len(value)}
        except Exception as e:
            return {"error": f"填写失败 ({selector}): {str(e)[:300]}"}

    @register_action("browser_get_text", required=("selector",), layer="L1",
                      desc="获取指定元素的 textContent", category="Layer 1: Playwright 浏览器操控")
    async def browser_get_text(self, selector: str) -> dict:
        """获取指定元素的文本内容（支持 iframe）"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_get_text")
        try:
            target = self._get_active_target()
            text = await target.text_content(selector, timeout=BROWSER_ACTION_TIMEOUT * 1000)
            return {"text": text, "selector": selector}
        except Exception as e:
            return {"error": f"获取文本失败 ({selector}): {str(e)[:300]}"}

    @register_action("browser_links", optional={"pattern": None, "max_links": 50}, layer="L1",
                      desc="提取页面所有链接（含 role=link，支持 iframe）", category="Layer 1: Playwright 浏览器操控")
    async def browser_links(self, pattern: Optional[str] = None,
                            max_links: int = 50) -> dict:
        """
        提取当前已渲染页面中的所有链接（含 <a> 标签和 role="link" 元素）。
        支持 iframe：如果已切换 frame 则从 frame 内提取。
        pattern: 可选过滤子串
        max_links: 最多返回链接数
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_links")
        max_links = max(1, min(max_links, MAX_BROWSER_LINKS))
        try:
            target = self._get_active_target()
            links_data = await target.evaluate("""() => {
                const links = [];
                // 1. 标准 <a> 标签
                document.querySelectorAll('a[href]').forEach(a => {
                    links.push({ href: a.href, text: (a.textContent || '').trim().substring(0, 100), source: 'a' });
                });
                // 2. role="link" 元素（SPA 常用）
                document.querySelectorAll('[role="link"]').forEach(el => {
                    const href = el.getAttribute('href') || el.dataset.href || '';
                    if (href) {
                        links.push({ href: href, text: (el.textContent || '').trim().substring(0, 100), source: 'role' });
                    }
                });
                return links;
            }""")

            # 去重
            seen = set()
            unique = []
            for item in links_data:
                href = item["href"]
                if href not in seen and href and not href.startswith("javascript:"):
                    seen.add(href)
                    unique.append(item)

            # 按 pattern 过滤
            if pattern:
                unique = [l for l in unique if pattern in l["href"]]

            result_links = unique[:max_links]
            return {
                "links": result_links,
                "count": len(result_links),
                "total_found": len(unique),
                "pattern": pattern,
                "url": page.url,
            }
        except Exception as e:
            return {"error": f"提取链接失败: {str(e)[:300]}"}

    @register_action("browser_wait", required=("selector",), optional={"timeout": 10, "state": "visible"}, layer="L1",
                      desc="等待元素出现/消失（支持 iframe）", category="Layer 1: Playwright 浏览器操控")
    async def browser_wait(self, selector: str, timeout: float = 10,
                           state: str = "visible") -> dict:
        """
        等待元素出现/消失（比 wait_for_text 的 OCR 轮询高效 100 倍，支持 iframe）。
        state: "visible", "hidden", "attached", "detached"
        """
        if state not in ("visible", "hidden", "attached", "detached"):
            state = "visible"
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_wait")
        timeout = max(1, min(timeout, 60))
        try:
            target = self._get_active_target()
            await target.wait_for_selector(selector, state=state,
                                         timeout=timeout * 1000)
            return {"found": True, "selector": selector, "state": state}
        except Exception as e:
            return {"found": False, "selector": selector, "error": str(e)[:300]}

    @register_action("browser_eval", required=("expression",), layer="L1",
                      desc="执行任意 JavaScript 表达式（支持 iframe）", category="Layer 1: Playwright 浏览器操控")
    async def browser_eval(self, expression: str) -> dict:
        """在浏览器中执行任意 JavaScript 表达式（万能兜底，支持 iframe）"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_eval")
        try:
            target = self._get_active_target()
            result = await target.evaluate(expression)
            # 确保结果可序列化
            result_str = json.dumps(result, ensure_ascii=False, default=str)
            if len(result_str) > MAX_CONTENT_LENGTH:
                return {"result": result_str[:MAX_CONTENT_LENGTH] + "...[truncated]", "truncated": True}
            return {"result": result}
        except Exception as e:
            return {"error": f"JS 执行失败: {str(e)[:500]}"}

    @register_action("browser_screenshot",
                      optional={"selector": None, "full_page": False, "quality": None, "format": "png"},
                      layer="L1",
                      desc="Playwright 内置截图（支持元素级、全页、JPEG 质量控制）", category="Layer 1: Playwright 浏览器操控")
    async def browser_screenshot(self, selector: Optional[str] = None,
                                 full_page: bool = False,
                                 quality: Optional[int] = None,
                                 format: str = "png") -> dict:
        """
        使用 Playwright 内置截图（比 scrot 更精准，支持元素级截图）。
        selector: 可选，只截取指定元素
        full_page: 是否截取整个滚动页面
        quality: JPEG 质量 0-100（仅 format="jpeg" 时有效，默认 None 即最高质量）
        format: "png"（默认，无损）或 "jpeg"（有损，配合 quality 大幅减少体积/Token）
        """
        if format not in ("png", "jpeg"):
            return {"error": f"Invalid format: {format!r}. Must be 'png' or 'jpeg'"}
        if quality is not None:
            quality = max(0, min(100, int(quality)))
            if format != "jpeg":
                return {"error": "quality 参数仅在 format='jpeg' 时有效"}

        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_screenshot")
        try:
            ext = "jpg" if format == "jpeg" else "png"
            path = Path(OUTPUT_DIR) / f"browser_screenshot_{uuid4().hex}.{ext}"
            screenshot_kwargs = {"path": str(path), "type": format}
            if format == "jpeg" and quality is not None:
                screenshot_kwargs["quality"] = quality

            if selector:
                element = await page.query_selector(selector)
                if not element:
                    return {"error": f"元素不存在: {selector}"}
                await element.screenshot(**screenshot_kwargs)
            else:
                screenshot_kwargs["full_page"] = full_page
                await page.screenshot(**screenshot_kwargs)

            if not path.exists():
                return {"error": "浏览器截图失败"}

            file_size = path.stat().st_size
            if file_size > MAX_SCREENSHOT_SIZE:
                path.unlink(missing_ok=True)
                return {"error": f"截图过大 ({file_size} bytes)"}

            b64 = base64.b64encode(path.read_bytes()).decode()
            path.unlink(missing_ok=True)
            return {"base64_image": b64, "format": format, "size_bytes": file_size, "url": page.url}
        except Exception as e:
            return {"error": f"浏览器截图失败: {str(e)[:300]}"}

    # -----------------------------------------------------------------
    # 标签页管理
    # -----------------------------------------------------------------

    @register_action("browser_tabs", layer="L1",
                      desc="列出所有打开的标签页", category="Layer 1: Playwright 浏览器操控")
    async def browser_tabs(self) -> dict:
        """列出所有打开的标签页"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_tabs")
        try:
            tabs = []
            for i, p in enumerate(context.pages):
                tabs.append({
                    "index": i,
                    "url": p.url,
                    "title": await p.title(),
                    "active": p == page,
                })
            return {"tabs": tabs, "count": len(tabs)}
        except Exception as e:
            return {"error": f"获取标签页失败: {str(e)[:300]}"}

    @register_action("browser_new_tab", optional={"url": "about:blank"}, layer="L1",
                      desc="打开新标签页", category="Layer 1: Playwright 浏览器操控")
    async def browser_new_tab(self, url: str = "about:blank") -> dict:
        """打开新标签页并导航到指定 URL"""
        if url and url != "about:blank":
            if not (url.startswith("http://") or url.startswith("https://") or url.startswith("about:")):
                return {"error": f"Invalid URL: {url!r}. Must start with http://, https://, or about:"}
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_new_tab")
        try:
            new_page = await context.new_page()
            if url and url != "about:blank":
                await new_page.goto(url, wait_until="domcontentloaded",
                                    timeout=BROWSER_ACTION_TIMEOUT * 1000)
            self._pw_page = new_page  # 切换到新标签
            return {"url": new_page.url, "title": await new_page.title(),
                    "tab_count": len(context.pages)}
        except Exception as e:
            return {"error": f"新建标签页失败: {str(e)[:300]}"}

    @register_action("browser_close_tab", layer="L1",
                      desc="关闭当前标签页", category="Layer 1: Playwright 浏览器操控")
    async def browser_close_tab(self) -> dict:
        """关闭当前标签页，自动切换到上一个"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_close_tab")
        try:
            pages = context.pages
            if len(pages) <= 1:
                return {"error": "只剩最后一个标签页，无法关闭"}
            await page.close()
            self._pw_page = context.pages[-1]
            return {"closed": True, "remaining": len(context.pages),
                    "active_url": self._pw_page.url}
        except Exception as e:
            return {"error": f"关闭标签页失败: {str(e)[:300]}"}

    @register_action("browser_switch_tab", required=("index",), layer="L1",
                      desc="切换到指定标签页", category="Layer 1: Playwright 浏览器操控")
    async def browser_switch_tab(self, index: int) -> dict:
        """切换到指定索引的标签页"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_switch_tab")
        try:
            pages = context.pages
            if index < 0 or index >= len(pages):
                return {"error": f"标签页索引越界: {index}, 总共 {len(pages)} 个标签页"}
            self._pw_page = pages[index]
            await self._pw_page.bring_to_front()
            return {"index": index, "url": self._pw_page.url,
                    "title": await self._pw_page.title()}
        except Exception as e:
            return {"error": f"切换标签页失败: {str(e)[:300]}"}

    # -----------------------------------------------------------------
    # 网络请求监听/等待
    # -----------------------------------------------------------------

    @register_action("browser_wait_network_idle", optional={"timeout": 10, "idle_time": 0.5}, layer="L1",
                      desc="等待网络空闲（无 pending 请求持续 idle_time 秒）", category="Layer 1: Playwright 浏览器操控")
    async def browser_wait_network_idle(self, timeout: float = 10, idle_time: float = 0.5) -> dict:
        """
        等待页面网络空闲（所有 AJAX/fetch 请求完成）。
        比 browser_goto(wait_until="networkidle") 更灵活：可在任意时刻调用，
        适用于 SPA 页面点击后等待数据加载完成的场景。
        timeout: 最大等待时间（秒），默认 10
        idle_time: 需要持续无请求的时间（秒），默认 0.5
        """
        timeout = max(1, min(timeout, 60))
        idle_time = max(0.1, min(idle_time, 5))

        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_wait_network_idle")
        try:
            pending = [0]  # 用列表以便在闭包中修改
            idle_start = [None]

            def on_request(req):
                pending[0] += 1
                idle_start[0] = None

            def on_response(resp):
                pending[0] = max(0, pending[0] - 1)

            def on_request_failed(req):
                pending[0] = max(0, pending[0] - 1)

            page.on("request", on_request)
            page.on("response", on_response)
            page.on("requestfailed", on_request_failed)

            import time
            start = time.time()
            try:
                while time.time() - start < timeout:
                    if pending[0] == 0:
                        if idle_start[0] is None:
                            idle_start[0] = time.time()
                        elif time.time() - idle_start[0] >= idle_time:
                            return {"status": "idle", "elapsed": round(time.time() - start, 2), "url": page.url}
                    else:
                        idle_start[0] = None
                    await asyncio.sleep(0.1)
                return {"status": "timeout", "pending_requests": pending[0],
                        "elapsed": round(time.time() - start, 2), "url": page.url}
            finally:
                page.remove_listener("request", on_request)
                page.remove_listener("response", on_response)
                page.remove_listener("requestfailed", on_request_failed)
        except Exception as e:
            return {"error": f"等待网络空闲失败: {str(e)[:300]}"}

    @register_action("browser_wait_response", required=("url_pattern",),
                      optional={"timeout": 15}, layer="L1",
                      desc="等待匹配 URL 模式的网络响应", category="Layer 1: Playwright 浏览器操控")
    async def browser_wait_response(self, url_pattern: str, timeout: float = 15) -> dict:
        """
        等待匹配指定 URL 模式（子串匹配或正则）的网络响应返回。
        适用于：等待特定 API 接口返回数据后再继续操作。
        url_pattern: URL 子串或正则表达式（自动尝试子串匹配，匹配失败再尝试正则）
        timeout: 最大等待时间（秒），默认 15
        """
        timeout = max(1, min(timeout, 60))

        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_wait_response")
        try:
            # 编译正则（如果是合法正则的话）
            regex = None
            try:
                regex = re.compile(url_pattern)
            except re.error:
                pass  # 不是合法正则，走子串匹配

            def predicate(response):
                resp_url = response.url
                if url_pattern in resp_url:
                    return True
                if regex and regex.search(resp_url):
                    return True
                return False

            response = await page.wait_for_event(
                "response", predicate=predicate, timeout=timeout * 1000
            )
            # 尝试获取响应体（可能是 JSON）
            try:
                body = await response.text()
                if len(body) > MAX_CONTENT_LENGTH:
                    body = body[:MAX_CONTENT_LENGTH] + "...[truncated]"
            except Exception:
                body = None

            return {
                "matched": True,
                "url": response.url,
                "status": response.status,
                "body_preview": body,
            }
        except Exception as e:
            error_str = str(e)[:300]
            if "Timeout" in error_str or "timeout" in error_str:
                return {"matched": False, "error": f"未匹配到 URL pattern '{url_pattern}'（{timeout}s 超时）"}
            return {"error": f"等待响应失败: {error_str}"}

    # -----------------------------------------------------------------
    # Cookie / Storage 操作
    # -----------------------------------------------------------------

    @register_action("browser_cookies_get", optional={"url_filter": None}, layer="L1",
                      desc="获取浏览器 Cookie（含 HttpOnly，可按 URL 过滤）", category="Layer 1: Playwright 浏览器操控")
    async def browser_cookies_get(self, url_filter: Optional[str] = None) -> dict:
        """
        获取浏览器所有 Cookie（包括 HttpOnly，JS 无法读取的也能拿到）。
        url_filter: 可选，只返回匹配此 URL 的 cookie
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_cookies_get")
        try:
            if url_filter:
                cookies = await context.cookies(url_filter)
            else:
                cookies = await context.cookies()
            # 简化输出，只保留关键字段
            result = []
            for c in cookies:
                result.append({
                    "name": c.get("name"),
                    "value": c.get("value", "")[:500],  # 截断过长的 value
                    "domain": c.get("domain"),
                    "path": c.get("path"),
                    "httpOnly": c.get("httpOnly"),
                    "secure": c.get("secure"),
                    "expires": c.get("expires"),
                })
            return {"cookies": result, "count": len(result), "url": page.url}
        except Exception as e:
            return {"error": f"获取 Cookie 失败: {str(e)[:300]}"}

    @register_action("browser_cookies_set", required=("cookies",), layer="L1",
                      desc="批量设置浏览器 Cookie（JSON 数组）", category="Layer 1: Playwright 浏览器操控")
    async def browser_cookies_set(self, cookies: str) -> dict:
        """
        批量设置浏览器 Cookie。
        cookies: JSON 字符串，格式为 [{"name":"xx","value":"xx","domain":"xx","path":"/"}]
        每个 cookie 至少需要 name, value, domain（或 url）。
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_cookies_set")
        try:
            if isinstance(cookies, str):
                cookie_list = json.loads(cookies)
            else:
                cookie_list = cookies
            if not isinstance(cookie_list, list):
                return {"error": "cookies 必须是 JSON 数组"}
            if len(cookie_list) > 100:
                return {"error": f"一次最多设置 100 个 cookie，当前 {len(cookie_list)} 个"}
            await context.add_cookies(cookie_list)
            return {"status": "ok", "count": len(cookie_list)}
        except json.JSONDecodeError as e:
            return {"error": f"Cookie JSON 解析失败: {str(e)[:200]}"}
        except Exception as e:
            return {"error": f"设置 Cookie 失败: {str(e)[:300]}"}

    @register_action("browser_cookies_clear", layer="L1",
                      desc="清空浏览器所有 Cookie", category="Layer 1: Playwright 浏览器操控")
    async def browser_cookies_clear(self) -> dict:
        """清空浏览器当前 context 的所有 Cookie"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_cookies_clear")
        try:
            await context.clear_cookies()
            return {"status": "ok", "message": "所有 Cookie 已清空"}
        except Exception as e:
            return {"error": f"清空 Cookie 失败: {str(e)[:300]}"}

    @register_action("browser_storage_get", optional={"storage_type": "localStorage"}, layer="L1",
                      desc="获取 localStorage 或 sessionStorage 内容", category="Layer 1: Playwright 浏览器操控")
    async def browser_storage_get(self, storage_type: str = "localStorage") -> dict:
        """
        获取页面的 localStorage 或 sessionStorage 全部内容。
        storage_type: "localStorage"（默认）或 "sessionStorage"
        """
        if storage_type not in ("localStorage", "sessionStorage"):
            return {"error": f"Invalid storage_type: {storage_type!r}. Must be 'localStorage' or 'sessionStorage'"}
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_storage_get")
        try:
            data = await page.evaluate(f"""() => {{
                const storage = window.{storage_type};
                const result = {{}};
                for (let i = 0; i < storage.length; i++) {{
                    const key = storage.key(i);
                    result[key] = storage.getItem(key);
                }}
                return result;
            }}""")
            # 截断过长的值
            truncated = {}
            for k, v in data.items():
                if isinstance(v, str) and len(v) > 1000:
                    truncated[k] = v[:1000] + "...[truncated]"
                else:
                    truncated[k] = v
            return {"data": truncated, "count": len(data), "storage_type": storage_type, "url": page.url}
        except Exception as e:
            return {"error": f"获取 {storage_type} 失败: {str(e)[:300]}"}

    @register_action("browser_storage_set", required=("key", "value"),
                      optional={"storage_type": "localStorage"}, layer="L1",
                      desc="设置 localStorage 或 sessionStorage 键值", category="Layer 1: Playwright 浏览器操控")
    async def browser_storage_set(self, key: str, value: str,
                                  storage_type: str = "localStorage") -> dict:
        """
        设置 localStorage 或 sessionStorage 的键值对。
        storage_type: "localStorage"（默认）或 "sessionStorage"
        """
        if storage_type not in ("localStorage", "sessionStorage"):
            return {"error": f"Invalid storage_type: {storage_type!r}. Must be 'localStorage' or 'sessionStorage'"}
        if len(value) > MAX_TEXT_LENGTH:
            return {"error": f"值过长 ({len(value)} chars)，最大: {MAX_TEXT_LENGTH}"}
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_storage_set")
        try:
            await page.evaluate(
                f"([k, v]) => window.{storage_type}.setItem(k, v)",
                [key, value]
            )
            return {"status": "ok", "key": key, "storage_type": storage_type}
        except Exception as e:
            return {"error": f"设置 {storage_type} 失败: {str(e)[:300]}"}

    # -----------------------------------------------------------------
    # 页面滚动（Playwright L1）
    # -----------------------------------------------------------------

    @register_action("browser_scroll", optional={"direction": "down", "amount": 500, "selector": None}, layer="L1",
                      desc="页面滚动（精确像素控制）", category="Layer 1: Playwright 浏览器操控")
    async def browser_scroll(self, direction: str = "down", amount: int = 500,
                              selector: Optional[str] = None) -> dict:
        """
        L1 层页面滚动。支持整页滚动或指定元素内滚动。
        direction: up/down/left/right/top/bottom
        amount: 滚动像素数（top/bottom 时忽略）
        selector: 可选，在指定元素内滚动（如可滚动容器）
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_scroll")

        amount = max(1, min(amount, 10000))
        try:
            if direction == "top":
                await page.evaluate("(s) => (s ? document.querySelector(s) : window).scrollTo({top:0})", selector)
            elif direction == "bottom":
                await page.evaluate("""(s) => {
                    const el = s ? document.querySelector(s) : document.documentElement;
                    (s ? document.querySelector(s) : window).scrollTo({top: el.scrollHeight});
                }""", selector)
            else:
                dx, dy = 0, 0
                if direction == "down": dy = amount
                elif direction == "up": dy = -amount
                elif direction == "right": dx = amount
                elif direction == "left": dx = -amount

                if selector:
                    await page.evaluate(f"(s) => document.querySelector(s).scrollBy({dx},{dy})", selector)
                else:
                    await page.mouse.wheel(dx, dy)

            scroll_y = await page.evaluate("window.scrollY")
            scroll_x = await page.evaluate("window.scrollX")
            return {"scrolled": direction, "amount": amount, "scroll_x": scroll_x, "scroll_y": scroll_y}
        except Exception as e:
            return {"error": f"滚动失败: {str(e)[:300]}"}

    # -----------------------------------------------------------------
    # DOM 结构化返回（Accessibility Snapshot）
    # -----------------------------------------------------------------

    @register_action("browser_snapshot", optional={"interesting_only": True, "root_selector": None}, layer="L1",
                      desc="获取页面无障碍快照（结构化 DOM，零 Token 替代截图）", category="Layer 1: Playwright 浏览器操控")
    async def browser_snapshot(self, interesting_only: bool = True,
                               root_selector: Optional[str] = None) -> dict:
        """
        获取页面的 Accessibility Snapshot（结构化 DOM 树）。
        比 browser_content 保留更多结构信息（角色、名称、值、状态），
        比截图节省 Token（纯文本），是 Agent 理解页面布局的最佳选择。

        interesting_only: True（默认）只返回有意义的节点（跳过空白/装饰节点），
                         False 返回完整树
        root_selector: 可选 CSS 选择器，只获取该元素子树的快照
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_snapshot")
        try:
            target = page
            root_element = None
            if root_selector:
                root_element = await page.query_selector(root_selector)
                if not root_element:
                    return {"error": f"元素不存在: {root_selector}"}

            # 兼容不同 Playwright 版本的 accessibility API
            snapshot = None
            try:
                # Playwright >= 1.41: page.accessibility.snapshot()
                if hasattr(page, 'accessibility'):
                    if root_element:
                        snapshot = await page.accessibility.snapshot(
                            interesting_only=interesting_only,
                            root=root_element
                        )
                    else:
                        snapshot = await page.accessibility.snapshot(
                            interesting_only=interesting_only
                        )
            except (AttributeError, Exception):
                pass

            if snapshot is None:
                # Fallback: 使用 CDP 直接获取 accessibility tree
                try:
                    cdp = await page.context.new_cdp_session(page)
                    result = await cdp.send("Accessibility.getFullAXTree")
                    await cdp.detach()
                    nodes = result.get("nodes", [])
                    # 简化为可读结构
                    def _ax_node_to_dict(node):
                        d = {}
                        name_val = node.get("name", {}).get("value", "")
                        role_val = node.get("role", {}).get("value", "")
                        if role_val: d["role"] = role_val
                        if name_val: d["name"] = name_val
                        desc = node.get("description", {}).get("value", "")
                        if desc: d["description"] = desc
                        val = node.get("value", {}).get("value", "")
                        if val: d["value"] = val
                        return d
                    snapshot = {
                        "role": "RootWebArea",
                        "name": await page.title(),
                        "children": [_ax_node_to_dict(n) for n in nodes[:200] if n.get("role", {}).get("value") not in ("none", "generic", "InlineTextBox")]
                    }
                except Exception as cdp_err:
                    # 最终 fallback: 用 JS 提取页面结构
                    try:
                        snapshot = await page.evaluate("""() => {
                            function walk(el, depth) {
                                if (depth > 4 || !el) return null;
                                const tag = el.tagName?.toLowerCase() || '';
                                const role = el.getAttribute('role') || tag;
                                const name = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 80) || '';
                                const children = [];
                                for (const c of (el.children || [])) {
                                    const r = walk(c, depth + 1);
                                    if (r) children.push(r);
                                }
                                if (!name && children.length === 0) return null;
                                const node = {role, name};
                                if (children.length > 0) node.children = children.slice(0, 20);
                                return node;
                            }
                            return walk(document.body, 0);
                        }""")
                    except Exception:
                        return {"error": f"无法获取页面快照（accessibility API 不可用）: {str(cdp_err)[:200]}", "url": page.url}

            if not snapshot:
                return {"snapshot": None, "message": "页面无可访问内容（可能是空白页或加载中）", "url": page.url}

            # 序列化并检查大小
            snapshot_str = json.dumps(snapshot, ensure_ascii=False, default=str)
            if len(snapshot_str) > MAX_CONTENT_LENGTH:
                # 对过大的快照做简化：只保留前 N 层
                def _truncate_tree(node, max_depth=4, current_depth=0):
                    if not isinstance(node, dict):
                        return node
                    result = {k: v for k, v in node.items() if k != "children"}
                    if current_depth < max_depth and "children" in node:
                        result["children"] = [
                            _truncate_tree(c, max_depth, current_depth + 1)
                            for c in node["children"][:20]  # 每层最多 20 个子节点
                        ]
                        if len(node["children"]) > 20:
                            result["children"].append({"role": "note", "name": f"... +{len(node['children']) - 20} more"})
                    elif "children" in node:
                        result["children_count"] = len(node["children"])
                    return result

                snapshot = _truncate_tree(snapshot)
                return {"snapshot": snapshot, "truncated": True, "url": page.url}

            return {"snapshot": snapshot, "url": page.url}
        except Exception as e:
            return {"error": f"获取页面快照失败: {str(e)[:300]}"}

    # -----------------------------------------------------------------
    # iframe 支持
    # -----------------------------------------------------------------

    @register_action("browser_frames", layer="L1",
                      desc="列出当前页面所有 frame/iframe", category="Layer 1: Playwright 浏览器操控")
    async def browser_frames(self) -> dict:
        """列出当前页面的所有 frame/iframe（含名称、URL、层级关系）"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_frames")
        try:
            frames = []
            for i, frame in enumerate(page.frames):
                frames.append({
                    "index": i,
                    "name": frame.name or "(anonymous)",
                    "url": frame.url,
                    "is_main": frame == page.main_frame,
                    "parent_name": frame.parent_frame.name if frame.parent_frame and frame.parent_frame != page.main_frame else None,
                })
            return {"frames": frames, "count": len(frames), "url": page.url}
        except Exception as e:
            return {"error": f"获取 frame 列表失败: {str(e)[:300]}"}

    @register_action("browser_switch_frame", optional={"index": None, "name": None, "url_contains": None}, layer="L1",
                      desc="切换操作上下文到指定 iframe", category="Layer 1: Playwright 浏览器操控")
    async def browser_switch_frame(self, index: Optional[int] = None,
                                   name: Optional[str] = None,
                                   url_contains: Optional[str] = None) -> dict:
        """
        切换当前操作上下文到指定的 iframe。
        可通过 index（frame 序号）、name（frame 名称）或 url_contains（URL 子串）定位。
        切换后，browser_click/fill/eval 等操作都将作用于该 frame 内部。

        注意：Playwright 的 frame 操作不需要真正"切换"——每个 frame 都是独立对象。
        此方法通过 frame_locator 找到目标 frame，并将其 content_frame 保存为 _pw_active_frame。
        后续操作会优先使用 _pw_active_frame（如果设置了的话）。
        """
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_switch_frame")
        try:
            target_frame = None
            frames = page.frames

            if index is not None:
                if index < 0 or index >= len(frames):
                    return {"error": f"Frame 索引越界: {index}, 总共 {len(frames)} 个 frame"}
                target_frame = frames[index]
            elif name is not None:
                for f in frames:
                    if f.name == name:
                        target_frame = f
                        break
                if not target_frame:
                    return {"error": f"未找到名为 '{name}' 的 frame"}
            elif url_contains is not None:
                for f in frames:
                    if url_contains in f.url:
                        target_frame = f
                        break
                if not target_frame:
                    return {"error": f"未找到 URL 包含 '{url_contains}' 的 frame"}
            else:
                return {"error": "必须指定 index、name 或 url_contains 之一"}

            # 保存活跃 frame 引用（供后续操作使用）
            self._pw_active_frame = target_frame
            return {
                "switched": True,
                "frame_name": target_frame.name or "(anonymous)",
                "frame_url": target_frame.url,
                "is_main": target_frame == page.main_frame,
            }
        except Exception as e:
            return {"error": f"切换 frame 失败: {str(e)[:300]}"}

    @register_action("browser_main_frame", layer="L1",
                      desc="切回主框架（退出 iframe 操作上下文）", category="Layer 1: Playwright 浏览器操控")
    async def browser_main_frame(self) -> dict:
        """切换回主框架，退出当前 iframe 操作上下文"""
        browser, context, page = await self._ensure_playwright()
        if page is None:
            return self._pw_error("browser_main_frame")
        try:
            self._pw_active_frame = None
            return {"switched": True, "frame": "main", "url": page.url}
        except Exception as e:
            return {"error": f"切换主框架失败: {str(e)[:300]}"}

    # -----------------------------------------------------------------
    # 断线重连
    # -----------------------------------------------------------------

    @register_action("browser_reconnect", layer="L1",
                      desc="强制重新连接浏览器 CDP（断线恢复）", category="Layer 1: Playwright 浏览器操控")
    async def browser_reconnect(self) -> dict:
        """
        强制清理旧连接并重新建立 CDP 连接。
        适用场景：浏览器崩溃重启后、长时间空闲后连接失效、连接状态异常时。
        """
        # 强制清理所有旧状态
        await self._force_reconnect()
        self._pw_active_frame = None

        # 重新连接
        browser, context, page = await self._get_playwright_browser()
        if page is None:
            diag = self._diagnose_cdp_failure()
            return {
                "error": "重连失败",
                "diagnosis": diag,
                "suggestion": diag.get("suggestion", ""),
            }
        tabs = []
        for i, p in enumerate(context.pages):
            tabs.append({"index": i, "url": p.url, "title": await p.title()})
        return {"status": "reconnected", "cdp_url": CDP_URL, "tabs": tabs}
