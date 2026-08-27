"""
screen.py - 屏幕感知 Mixin
提供区域截图、OCR 文字识别、剪贴板操作、等待条件、分辨率调整、legacy Web 导航辅助。
"""

import asyncio
import base64
import re
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin
from uuid import uuid4

from .core import (
    ComputerToolBase,
    CoordSource,
    OUTPUT_DIR,
    COMMAND_TIMEOUT,
    MAX_TEXT_LENGTH,
    MAX_SCREENSHOT_SIZE,
    SCREENSHOT_DELAY,
)
from .registry import register_action


class ScreenMixin(ComputerToolBase):
    """屏幕感知：区域截图、OCR、剪贴板、等待条件、分辨率、Web 导航辅助"""

    # -----------------------------------------------------------------
    # 区域截图
    # -----------------------------------------------------------------

    @register_action("screenshot_region", required=("x", "y", "width", "height"), layer="L3",
                      desc="截取指定矩形区域，减少 token 消耗", category="基础操作")
    async def screenshot_region(self, x: int, y: int, width: int, height: int) -> dict:
        """截取指定矩形区域的截图，减少 token 消耗，提高识别精度"""
        # 坐标与尺寸非负校验
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            return {"error": f"Invalid region: x={x}, y={y}, width={width}, height={height}. "
                    "All must be non-negative, width/height must be positive."}

        # 先截全屏，再裁剪（更可靠，避免 scrot -a 兼容问题）
        full_path = Path(OUTPUT_DIR) / f"screenshot_{uuid4().hex}.png"
        crop_path = Path(OUTPUT_DIR) / f"screenshot_region_{uuid4().hex}.png"

        self._cleanup_old_screenshots()

        # 截全屏
        code, _, stderr = await self._run(["scrot", str(full_path)])
        if code != 0 or not full_path.exists():
            code, _, stderr = await self._run(
                ["import", "-window", "root", str(full_path)]
            )
            if code != 0 or not full_path.exists():
                return {"error": "Screenshot failed"}

        # API 坐标转屏幕坐标
        sx, sy = self.scale_coordinates(CoordSource.API, x, y)
        # 宽高也需要按比例转换
        target = self._get_scaling_target()
        if target:
            sw = round(width / (target["width"] / self.width))
            sh = round(height / (target["height"] / self.height))
        else:
            sw, sh = width, height

        # 确保不越界
        sw = max(1, min(sw, self.width - sx))
        sh = max(1, min(sh, self.height - sy))

        # 裁剪
        code, _, stderr = await self._run([
            "convert", str(full_path),
            "-crop", f"{sw}x{sh}+{sx}+{sy}", "+repage",
            str(crop_path),
        ])
        full_path.unlink(missing_ok=True)

        if code != 0 or not crop_path.exists():
            return {"error": f"Crop failed: {stderr}"}

        file_size = crop_path.stat().st_size
        if file_size > MAX_SCREENSHOT_SIZE:
            crop_path.unlink(missing_ok=True)
            return {"error": f"Cropped image too large ({file_size} bytes)"}

        b64 = base64.b64encode(crop_path.read_bytes()).decode()
        crop_path.unlink(missing_ok=True)
        return {"base64_image": b64, "region": {"x": x, "y": y, "width": width, "height": height}}

    # -----------------------------------------------------------------
    # 剪贴板操作
    # -----------------------------------------------------------------

    @register_action("clipboard_get",
                      desc="获取系统剪贴板内容", category="剪贴板")
    async def clipboard_get(self) -> dict:
        """获取系统剪贴板内容"""
        code, stdout, stderr = await self._run(
            ["xclip", "-selection", "clipboard", "-o"]
        )
        if code != 0:
            # fallback: 尝试 xsel
            code, stdout, stderr = await self._run(
                ["xsel", "--clipboard", "--output"]
            )
        if code != 0:
            return {"error": f"Failed to get clipboard: {stderr}"}
        return {"content": stdout}

    @register_action("clipboard_set", required=("text",),
                      desc="设置系统剪贴板内容", category="剪贴板")
    async def clipboard_set(self, text: str) -> dict:
        """设置系统剪贴板内容"""
        if len(text) > MAX_TEXT_LENGTH:
            return {"error": f"Text too long ({len(text)} chars), max: {MAX_TEXT_LENGTH}"}

        # 使用 xclip 写入剪贴板
        proc = await asyncio.create_subprocess_exec(
            "xclip", "-selection", "clipboard",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._get_env(),
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=text.encode("utf-8")),
                timeout=COMMAND_TIMEOUT,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return {"error": "Clipboard write timed out"}

        if proc.returncode != 0:
            # fallback: xsel
            proc2 = await asyncio.create_subprocess_exec(
                "xsel", "--clipboard", "--input",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._get_env(),
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc2.communicate(input=text.encode("utf-8")),
                    timeout=COMMAND_TIMEOUT,
                )
            except asyncio.TimeoutError:
                proc2.kill()
                await proc2.wait()
                return {"error": "Clipboard write timed out (xsel)"}
            if proc2.returncode != 0:
                return {"error": f"Failed to set clipboard: {stderr.decode('utf-8', errors='replace')}"}

        return {"status": "ok", "length": len(text)}

    # -----------------------------------------------------------------
    # 等待条件
    # -----------------------------------------------------------------

    @register_action("wait_for_window", required=("name",), optional={"timeout": 30},
                      desc="等待指定标题的窗口出现（默认 30s）", category="等待条件")
    async def wait_for_window(self, name: str, timeout: float = 30) -> dict:
        """等待指定标题的窗口出现，最多等待 timeout 秒"""
        timeout = max(1, min(timeout, 60))
        # xdotool search --sync 会阻塞直到找到窗口
        code, stdout, stderr = await self._run_with_timeout(
            [self._xdotool, "search", "--sync", "--name", name],
            timeout=timeout,
        )
        if code == -1:  # 超时
            return {"found": False, "error": f"Window '{name}' not found within {timeout}s"}
        if code == 0 and stdout.strip():
            wid = stdout.strip().split("\n")[0]
            ss = await self.screenshot()
            return {"found": True, "window_id": wid, **ss}
        return {"found": False, "error": f"Window '{name}' not found"}

    @register_action("wait_for_text", required=("text",), optional={"timeout": 30, "interval": 2},
                      desc="等待屏幕出现指定文本（OCR，默认 30s）", category="等待条件")
    async def wait_for_text(self, text: str, timeout: float = 30, interval: float = 2) -> dict:
        """等待屏幕上出现指定文本（通过 OCR），最多等待 timeout 秒"""
        timeout = max(1, min(timeout, 120))
        interval = max(0.5, min(interval, 10))
        import time
        start = time.time()
        while time.time() - start < timeout:
            result = await self.screen_text()
            if "error" not in result and text.lower() in result.get("text", "").lower():
                ss = await self.screenshot()
                return {"found": True, "text": text, **ss}
            await asyncio.sleep(interval)
        return {"found": False, "error": f"Text '{text}' not found on screen within {timeout}s"}

    # -----------------------------------------------------------------
    # OCR 文字识别
    # -----------------------------------------------------------------

    @register_action("screen_text", optional={"x": None, "y": None, "width": None, "height": None, "lang": "eng"},
                      desc="对屏幕或指定区域 OCR，返回识别文字", category="OCR 文字识别")
    async def screen_text(self, x: Optional[int] = None, y: Optional[int] = None,
                          width: Optional[int] = None, height: Optional[int] = None,
                          lang: str = "eng") -> dict:
        """
        对当前屏幕（或指定区域）进行 OCR 文字识别。
        可选指定区域 (x, y, width, height)，如果不指定则对全屏 OCR。
        lang: tesseract 语言包，默认 eng，可设为 chi_sim+eng 等。
        """
        # 安全校验 lang 参数
        if not re.match(r"^[a-zA-Z0-9_+]+$", lang):
            return {"error": f"Invalid language parameter: {lang!r}"}

        # 先截图
        path = Path(OUTPUT_DIR) / f"ocr_{uuid4().hex}.png"
        code, _, stderr = await self._run(["scrot", str(path)])
        if code != 0 or not path.exists():
            code, _, stderr = await self._run(["import", "-window", "root", str(path)])
            if code != 0 or not path.exists():
                return {"error": "Screenshot for OCR failed"}

        try:
            # 如果指定了区域，先裁剪
            if all(v is not None for v in [x, y, width, height]):
                sx, sy = self.scale_coordinates(CoordSource.API, x, y)
                target = self._get_scaling_target()
                if target:
                    sw = round(width / (target["width"] / self.width))
                    sh = round(height / (target["height"] / self.height))
                else:
                    sw, sh = width, height
                sw = max(1, min(sw, self.width - sx))
                sh = max(1, min(sh, self.height - sy))

                crop_path = Path(OUTPUT_DIR) / f"ocr_crop_{uuid4().hex}.png"
                await self._run([
                    "convert", str(path),
                    "-crop", f"{sw}x{sh}+{sx}+{sy}", "+repage",
                    str(crop_path),
                ])
                path.unlink(missing_ok=True)
                path = crop_path

            # 执行 OCR
            out_base = Path(OUTPUT_DIR) / f"ocr_result_{uuid4().hex}"
            code, stdout, stderr = await self._run([
                "tesseract", str(path), str(out_base), "-l", lang,
            ])

            result_file = Path(f"{out_base}.txt")
            if code != 0 or not result_file.exists():
                return {"error": f"OCR failed: {stderr[:500]}"}

            text = result_file.read_text(encoding="utf-8", errors="replace").strip()
            result_file.unlink(missing_ok=True)
            return {"text": text, "lang": lang}
        finally:
            # 确保异常路径也清理临时文件
            path.unlink(missing_ok=True)

    # -----------------------------------------------------------------
    # 分辨率动态调整
    # -----------------------------------------------------------------

    @register_action("set_resolution", required=("width", "height"),
                      desc="动态调整虚拟显示分辨率（640-3840 x 480-2160）", category="分辨率")
    async def set_resolution(self, width: int, height: int) -> dict:
        """
        动态调整虚拟显示分辨率。
        通过 xrandr 添加并切换模式，无需重启 Xvfb。
        """
        if not (640 <= width <= 3840 and 480 <= height <= 2160):
            return {"error": f"Invalid resolution: {width}x{height}. Range: 640-3840 x 480-2160"}

        display = f":{self.display_num}"

        # 生成 modeline
        code, modeline_out, stderr = await self._run(
            ["cvt", str(width), str(height), "60"]
        )
        if code != 0:
            return {"error": f"cvt failed: {stderr}"}

        # 解析 modeline，例如：Modeline "1280x800_60.00"  83.46  ...
        modeline_line = ""
        for line in modeline_out.strip().split("\n"):
            if line.strip().startswith("Modeline"):
                modeline_line = line.strip()
                break

        if not modeline_line:
            return {"error": "Failed to parse cvt modeline output"}

        # 提取模式名和参数
        parts = modeline_line.split(None, 2)  # ['Modeline', '"name"', 'params...']
        if len(parts) < 3:
            return {"error": f"Unexpected modeline format: {modeline_line}"}

        mode_name = parts[1].strip('"')
        mode_params = parts[2]

        # xrandr --newmode
        newmode_args = ["xrandr", "--newmode", mode_name] + mode_params.split()
        await self._run(newmode_args)  # 如果已存在会失败，忽略

        # 获取当前输出名（通常是 screen 或 default）
        code, xrandr_out, _ = await self._run(["xrandr", "--query"])
        output_name = "default"
        if code == 0:
            for line in xrandr_out.split("\n"):
                if " connected" in line:
                    output_name = line.split()[0]
                    break

        # xrandr --addmode
        await self._run(["xrandr", "--addmode", output_name, mode_name])

        # xrandr --output ... --mode
        code, stdout, stderr = await self._run(
            ["xrandr", "--output", output_name, "--mode", mode_name]
        )

        if code != 0:
            # fallback: 使用 xrandr -s 简单模式
            code, stdout, stderr = await self._run(
                ["xrandr", "-s", f"{width}x{height}"]
            )
            if code != 0:
                return {"error": f"Resolution change failed: {stderr}"}

        # 更新内部尺寸
        self.width = width
        self.height = height

        await asyncio.sleep(1)
        ss = await self.screenshot()
        return {
            "status": "ok",
            "resolution": f"{width}x{height}",
            "note": "Resolution changed. Window positions may need adjustment.",
            **ss,
        }

    # -----------------------------------------------------------------
    # Web 导航辅助（Legacy，低 Token 消耗）
    # -----------------------------------------------------------------

    @register_action("get_browser_url",
                      desc="通过窗口标题推断当前浏览器 URL（零 token，Legacy）", category="Web 导航辅助（Legacy）")
    async def get_browser_url(self) -> dict:
        """
        通过窗口标题推断当前浏览器页面信息。
        零视觉 token 消耗，用于导航后验证是否到达目标页面。
        大多数网站的标题格式为: "页面标题 - 网站名" 或 "页面标题"。
        """
        # 获取当前活动窗口标题
        code, stdout, stderr = await self._run(
            [self._xdotool, "getactivewindow", "getwindowname"]
        )
        active_title = stdout.strip() if code == 0 else ""

        # 搜索所有浏览器窗口
        browser_names = ["chromium", "chrome", "firefox", "Chromium", "Chrome", "Firefox"]
        browser_windows = []

        code, stdout, _ = await self._run(
            [self._xdotool, "search", "--onlyvisible", "--name", ""]
        )
        if code == 0 and stdout.strip():
            for wid in stdout.strip().split("\n"):
                wid = wid.strip()
                if not wid:
                    continue
                _, name_out, _ = await self._run(
                    [self._xdotool, "getwindowname", wid]
                )
                title = name_out.strip()
                # 浏览器窗口标题通常以 "- Chromium" / "- Google Chrome" / "- Firefox" 结尾
                is_browser = any(bn.lower() in title.lower() for bn in browser_names)
                if is_browser:
                    browser_windows.append({"id": wid, "title": title})

        # 同时尝试通过剪贴板获取 URL（Ctrl+L → Ctrl+C → 读取）
        # 注意：这会改变焦点和剪贴板，所以只在有浏览器窗口时才做
        url_from_clipboard = None
        if browser_windows:
            # 保存当前剪贴板内容
            old_clipboard = await self.clipboard_get()
            old_content = old_clipboard.get("content", "")

            # Ctrl+L 跳到地址栏 → Ctrl+A 全选 → Ctrl+C 复制
            await self._run([self._xdotool, "key", "--", "ctrl+l"])
            await asyncio.sleep(0.3)
            await self._run([self._xdotool, "key", "--", "ctrl+a"])
            await asyncio.sleep(0.1)
            await self._run([self._xdotool, "key", "--", "ctrl+c"])
            await asyncio.sleep(0.3)

            # 读取剪贴板
            cb_result = await self.clipboard_get()
            cb_content = cb_result.get("content", "")

            # 恢复地址栏状态（按 Escape）
            await self._run([self._xdotool, "key", "--", "Escape"])

            # 判断是否为 URL
            if cb_content and (cb_content.startswith("http://") or cb_content.startswith("https://")):
                url_from_clipboard = cb_content.strip()

            # 恢复旧剪贴板内容
            if old_content and old_content != cb_content:
                await self.clipboard_set(old_content)

        result = {
            "active_window_title": active_title,
            "browser_windows": browser_windows,
        }
        if url_from_clipboard:
            result["current_url"] = url_from_clipboard

        return result

    @register_action("get_page_links", required=("url",), optional={"pattern": None, "max_links": 20},
                      desc="纯文本提取页面链接（不消耗视觉 token，Legacy）", category="Web 导航辅助（Legacy）")
    async def get_page_links(self, url: str, pattern: Optional[str] = None,
                             max_links: int = 20) -> dict:
        """
        使用 curl 抓取指定 URL 的 HTML，提取所有链接。
        纯文本操作，零视觉 token 消耗。用于导航前获取目标 URL。

        url: 要抓取的页面 URL
        pattern: 可选，只返回包含此子串的链接（如 "/video/BV"）
        max_links: 最多返回链接数（默认 20）
        """
        # 安全校验 URL
        if not url or not (url.startswith("http://") or url.startswith("https://")):
            return {"error": f"Invalid URL: {url!r}. Must start with http:// or https://"}

        # SSRF 防护：阻止访问内网/本地地址
        from urllib.parse import urlparse
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        blocked_prefixes = ("127.", "10.", "192.168.", "172.16.", "172.17.", "172.18.",
                            "172.19.", "172.20.", "172.21.", "172.22.", "172.23.",
                            "172.24.", "172.25.", "172.26.", "172.27.", "172.28.",
                            "172.29.", "172.30.", "172.31.", "169.254.", "0.")
        blocked_hosts = ("localhost", "metadata.google.internal", "[::1]")
        if hostname in blocked_hosts or hostname.startswith(tuple(blocked_prefixes)):
            return {"error": f"Access denied: cannot fetch internal/local URL: {hostname}"}

        max_links = max(1, min(max_links, 100))

        # 使用 curl 抓取页面（带浏览器 User-Agent，防止被拒）
        proc = await asyncio.create_subprocess_exec(
            "curl", "-sL", "--max-time", "10",
            "-H", "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return {"error": "curl timed out fetching the page"}

        if proc.returncode != 0:
            return {"error": f"curl failed: {stderr.decode('utf-8', errors='replace')[:300]}"}

        html = stdout.decode("utf-8", errors="replace")

        # 提取 href 属性中的链接
        href_pattern = re.compile(r'href=["\']([^"\']+)["\']')
        all_links = href_pattern.findall(html)

        # 去重并保持顺序
        seen = set()
        unique_links = []
        for link in all_links:
            if link not in seen:
                seen.add(link)
                unique_links.append(link)

        # 如果有 pattern 过滤
        if pattern:
            unique_links = [l for l in unique_links if pattern in l]

        # 补全相对链接
        full_links = []
        for link in unique_links[:max_links]:
            if link.startswith("http://") or link.startswith("https://"):
                full_links.append(link)
            elif link.startswith("//"):
                full_links.append("https:" + link)
            elif link.startswith("/"):
                full_links.append(urljoin(url, link))
            else:
                full_links.append(link)  # 保留原始（如 javascript: 等）

        return {
            "links": full_links,
            "count": len(full_links),
            "total_found": len(unique_links),
            "pattern": pattern,
        }
