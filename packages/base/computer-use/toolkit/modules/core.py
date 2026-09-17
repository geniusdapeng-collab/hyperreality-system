"""
core.py - 常量定义、枚举、校验函数、ComputerToolBase 基类
提供截图、坐标转换、命令执行等基础能力，供所有 Mixin 继承使用。
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
from enum import Enum
from pathlib import Path
from typing import Optional
from uuid import uuid4

from .registry import register_action

# =====================================================================
# 版本（唯一事实源，ADR-003）
# =====================================================================

VERSION = "3.0.0"

# =====================================================================
# 常量定义
# =====================================================================

OUTPUT_DIR = "/tmp/computer-use-outputs"  # 截图临时文件（Agent 自用，用户不可见）
RECORDING_DIR = os.getenv("RECORDING_DIR", "/workspace/computer-use-recordings")  # 录制/音频产出物（用户可见可下载）
RECORDING_PID_FILE = "/tmp/computer-use-recording.pid"
TYPING_DELAY_MS = 12
TYPING_GROUP_SIZE = 50
SCREENSHOT_DELAY = float(os.getenv("SCREENSHOT_DELAY", "1.0"))
COMMAND_TIMEOUT = int(os.getenv("COMMAND_TIMEOUT", "10"))
MAX_TEXT_LENGTH = 10000  # type_text 最大字符数，防止 DoS
MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024  # 截图最大 5MB，超过则报错
MAX_SCROLL_AMOUNT = 100  # scroll 最大重复次数
MAX_RECORDING_DURATION = int(os.getenv("MAX_RECORDING_DURATION", "300"))  # 录制最大时长（秒），默认5分钟
MAX_RECORDING_SIZE = 100 * 1024 * 1024  # 录制文件最大 100MB
MAX_RECORDING_FILES = 10  # 最多保留录制文件数
RECORDING_FRAMERATE = int(os.getenv("RECORDING_FRAMERATE", "15"))  # 录制帧率，默认15fps

# Layer 1: Playwright CDP 配置
CDP_PORT = int(os.getenv("CDP_PORT", "9222"))
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"
BROWSER_ACTION_TIMEOUT = int(os.getenv("BROWSER_ACTION_TIMEOUT", "15"))  # 浏览器操作超时（秒）
MAX_BROWSER_LINKS = 200  # browser_links 最大返回链接数
MAX_CONTENT_LENGTH = 50000  # browser_content 最大返回字符数

# VNC 实时预览配置
VNC_PORT = int(os.getenv("VNC_PORT", "5900"))
NOVNC_PORT = int(os.getenv("NOVNC_PORT", "6080"))
VNC_PID_FILE = "/tmp/computer-use-vnc.pid"
WEBSOCKIFY_PID_FILE = "/tmp/computer-use-websockify.pid"

MAX_SCALING_TARGETS = {
    "XGA":   {"width": 1024, "height": 768},
    "WXGA":  {"width": 1280, "height": 800},
    "FWXGA": {"width": 1366, "height": 768},
}

CLICK_BUTTONS: dict[str, list[str]] = {
    "left_click":    ["1"],
    "right_click":   ["3"],
    "middle_click":  ["2"],
    "double_click":  ["--repeat", "2", "--delay", "10", "1"],
    "triple_click":  ["--repeat", "3", "--delay", "10", "1"],
}

SCROLL_DIRECTIONS = {"up": 4, "down": 5, "left": 6, "right": 7}

# 合法按键名正则：仅允许字母数字、下划线、+（组合键分隔）和连字符（不允许空格）
_VALID_KEY_PATTERN = re.compile(r"^[a-zA-Z0-9_+\-]+$")

# 合法修饰键白名单
_VALID_MODIFIER_KEYS = frozenset({
    "shift", "ctrl", "control", "alt", "meta", "super",
    "Shift", "Ctrl", "Control", "Alt", "Meta", "Super",
    "Shift_L", "Shift_R", "Control_L", "Control_R",
    "Alt_L", "Alt_R", "Super_L", "Super_R",
})


# =====================================================================
# 枚举
# =====================================================================

class CoordSource(str, Enum):
    """坐标来源枚举"""
    API = "api"        # API 传入的坐标，需转换为屏幕坐标
    SCREEN = "screen"  # 屏幕原始坐标，需转换为 API 坐标


# =====================================================================
# 校验函数
# =====================================================================

def validate_keys(keys: str) -> str:
    """校验按键参数，防止 shell 注入"""
    if not keys or not _VALID_KEY_PATTERN.match(keys):
        raise ValueError(f"Invalid key sequence: {keys!r}")
    return keys


def validate_modifier_key(key: str) -> str:
    """校验修饰键参数"""
    if key not in _VALID_MODIFIER_KEYS:
        raise ValueError(f"Invalid modifier key: {key!r}")
    return key


# =====================================================================
# ComputerToolBase 基类
# =====================================================================

class ComputerToolBase:
    """
    Computer Use Tool 基类。
    提供截图、坐标转换、命令执行等基础能力，供所有领域 Mixin 继承使用。
    """

    def __init__(self):
        super().__init__()  # 保证 MRO 协作式继承链完整
        self.width = int(os.getenv("WIDTH", "1280"))
        self.height = int(os.getenv("HEIGHT", "800"))
        self.display_num = int(os.getenv("DISPLAY_NUM", "1"))
        self._display_env = {"DISPLAY": f":{self.display_num}"}
        self._xdotool = "xdotool"
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        os.makedirs(RECORDING_DIR, exist_ok=True)

    # -----------------------------------------------------------------
    # 命令执行
    # -----------------------------------------------------------------

    def _get_env(self) -> dict:
        """获取带 DISPLAY 的环境变量"""
        env = os.environ.copy()
        env.update(self._display_env)
        return env

    async def _run(self, args: list[str]) -> tuple:
        """执行命令（参数列表模式），带超时保护"""
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._get_env(),
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=COMMAND_TIMEOUT
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return (-1, "", f"Command timed out after {COMMAND_TIMEOUT}s: {args[0] if args else 'unknown'}")
        return (
            proc.returncode,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )

    async def _run_with_timeout(self, args: list[str], timeout: float) -> tuple:
        """执行命令，使用自定义超时"""
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._get_env(),
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return (-1, "", f"Command timed out after {timeout}s")
        return (
            proc.returncode,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )

    # -----------------------------------------------------------------
    # 坐标转换
    # -----------------------------------------------------------------

    def _get_scaling_target(self):
        """根据当前分辨率选择最佳缩放目标"""
        ratio = self.width / self.height
        for target in MAX_SCALING_TARGETS.values():
            if abs(target["width"] / target["height"] - ratio) < 0.02:
                if target["width"] < self.width:
                    return target
        return None

    def scale_coordinates(self, source: CoordSource, x: int, y: int):
        """
        API坐标 ↔ 屏幕坐标 互转
        source=CoordSource.API: API坐标 → 屏幕坐标
        source=CoordSource.SCREEN: 屏幕坐标 → API坐标
        """
        target = self._get_scaling_target()
        if not target:
            return x, y
        x_factor = target["width"] / self.width
        y_factor = target["height"] / self.height
        if source == CoordSource.API:
            return round(x / x_factor), round(y / y_factor)
        else:
            return round(x * x_factor), round(y * y_factor)

    def get_display_dimensions(self):
        """返回告诉 API 的缩放尺寸"""
        target = self._get_scaling_target()
        if target:
            return target["width"], target["height"]
        return self.width, self.height

    # -----------------------------------------------------------------
    # 截图
    # -----------------------------------------------------------------

    def _cleanup_old_screenshots(self, max_age_seconds=300, max_files=50):
        """清理过期的临时截图文件，防止磁盘累积"""
        import time
        try:
            files = sorted(
                Path(OUTPUT_DIR).glob("screenshot_*.png"),
                key=lambda f: f.stat().st_mtime,
            )
            now = time.time()
            # 先删除过期文件
            for f in files:
                if now - f.stat().st_mtime > max_age_seconds:
                    f.unlink(missing_ok=True)
            # 重新获取剩余文件，按时间排序，删除超出数量限制的最旧文件
            remaining = sorted(
                Path(OUTPUT_DIR).glob("screenshot_*.png"),
                key=lambda f: f.stat().st_mtime,
            )
            if len(remaining) > max_files:
                for f in remaining[: len(remaining) - max_files]:
                    f.unlink(missing_ok=True)
        except Exception:
            pass  # 清理失败不影响主流程

    @register_action("screenshot", layer="L3",
                      desc="截取当前屏幕，返回 base64 PNG", category="基础操作")
    async def screenshot(self) -> dict:
        """截取当前屏幕截图，返回 base64 编码的 PNG"""
        path = Path(OUTPUT_DIR) / f"screenshot_{uuid4().hex}.png"

        # 清理可能残留的旧截图（防止磁盘累积）
        self._cleanup_old_screenshots()

        # 主用 scrot（不加 -p，避免兼容性问题）
        code, stdout, stderr = await self._run(["scrot", str(path)])

        # fallback: 如果 scrot 失败，使用 ImageMagick import
        if code != 0 or not path.exists():
            code, stdout, stderr = await self._run(
                ["import", "-window", "root", str(path)]
            )
            if code != 0 or not path.exists():
                return {"error": "Screenshot failed: both scrot and import methods were unable to capture the screen"}

        # 如果需要缩放
        target = self._get_scaling_target()
        if target:
            await self._run([
                "convert", str(path),
                "-resize", f"{target['width']}x{target['height']}!",
                str(path),
            ])

        # 检查截图文件大小，防止过大的图片占用过多内存
        file_size = path.stat().st_size
        if file_size > MAX_SCREENSHOT_SIZE:
            path.unlink(missing_ok=True)
            return {"error": f"Screenshot too large ({file_size} bytes), max allowed: {MAX_SCREENSHOT_SIZE} bytes"}

        b64 = base64.b64encode(path.read_bytes()).decode()
        path.unlink(missing_ok=True)
        return {"base64_image": b64}
