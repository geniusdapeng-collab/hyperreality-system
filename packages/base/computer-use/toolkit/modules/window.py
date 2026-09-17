"""
window.py - 窗口管理 Mixin
提供窗口列表、聚焦、调整大小、移动、最小化、关闭等操作。
"""

import asyncio
from typing import Optional

from .core import ComputerToolBase, SCREENSHOT_DELAY
from .registry import register_action


class WindowMixin(ComputerToolBase):
    """窗口管理操作"""

    @register_action("window_list",
                      desc="列出所有可见窗口（ID、标题、位置、尺寸）", category="窗口管理")
    async def window_list(self) -> dict:
        """列出所有可见窗口，返回窗口 ID、标题、位置和尺寸"""
        code, stdout, stderr = await self._run(
            [self._xdotool, "search", "--onlyvisible", "--name", ""]
        )
        if code != 0 and not stdout.strip():
            return {"windows": []}

        windows = []
        for wid in stdout.strip().split("\n"):
            wid = wid.strip()
            if not wid:
                continue
            # 获取窗口名称
            _, name_out, _ = await self._run(
                [self._xdotool, "getwindowname", wid]
            )
            # 获取窗口几何信息（包含位置和尺寸）
            _, geo_out, _ = await self._run(
                [self._xdotool, "getwindowgeometry", "--shell", wid]
            )
            geo = {}
            for line in geo_out.strip().split("\n"):
                if "=" in line:
                    k, v = line.split("=", 1)
                    geo[k.strip()] = v.strip()
            windows.append({
                "id": wid,
                "name": name_out.strip(),
                "x": int(geo.get("X", 0)),
                "y": int(geo.get("Y", 0)),
                "width": int(geo.get("WIDTH", 0)),
                "height": int(geo.get("HEIGHT", 0)),
            })
        return {"windows": windows}

    @register_action("window_focus", optional={"window_id": None, "name": None},
                      desc="聚焦窗口（按 ID 或标题搜索）", category="窗口管理")
    async def window_focus(self, window_id: Optional[str] = None, name: Optional[str] = None) -> dict:
        """聚焦指定窗口（通过 ID 或标题名称搜索）"""
        if window_id:
            code, stdout, stderr = await self._run(
                [self._xdotool, "windowactivate", "--sync", window_id]
            )
        elif name:
            code, stdout, stderr = await self._run(
                [self._xdotool, "search", "--name", name, "windowactivate", "--sync"]
            )
        else:
            return {"error": "Must provide 'window_id' or 'name'"}
        await asyncio.sleep(0.5)
        ss = await self.screenshot()
        return {"output": stdout.strip() if code == 0 else None, "error": stderr if code != 0 else None, **ss}

    @register_action("window_resize", required=("window_id", "width", "height"),
                      desc="调整窗口尺寸", category="窗口管理")
    async def window_resize(self, window_id: str, width: int, height: int) -> dict:
        """调整指定窗口的尺寸"""
        code, stdout, stderr = await self._run(
            [self._xdotool, "windowsize", "--sync", window_id, str(width), str(height)]
        )
        await asyncio.sleep(0.5)
        ss = await self.screenshot()
        return {"output": stdout.strip() if code == 0 else None, "error": stderr if code != 0 else None, **ss}

    @register_action("window_move", required=("window_id", "x", "y"),
                      desc="移动窗口到指定位置", category="窗口管理")
    async def window_move(self, window_id: str, x: int, y: int) -> dict:
        """移动指定窗口到屏幕上的指定位置"""
        code, stdout, stderr = await self._run(
            [self._xdotool, "windowmove", "--sync", window_id, str(x), str(y)]
        )
        await asyncio.sleep(0.5)
        ss = await self.screenshot()
        return {"output": stdout.strip() if code == 0 else None, "error": stderr if code != 0 else None, **ss}

    @register_action("window_minimize", required=("window_id",),
                      desc="最小化窗口", category="窗口管理")
    async def window_minimize(self, window_id: str) -> dict:
        """最小化指定窗口"""
        code, stdout, stderr = await self._run(
            [self._xdotool, "windowminimize", window_id]
        )
        await asyncio.sleep(0.5)
        ss = await self.screenshot()
        return {"output": stdout.strip() if code == 0 else None, "error": stderr if code != 0 else None, **ss}

    @register_action("window_close", optional={"window_id": None, "name": None},
                      desc="关闭窗口（按 ID 或标题）", category="窗口管理")
    async def window_close(self, window_id: Optional[str] = None, name: Optional[str] = None) -> dict:
        """关闭指定窗口"""
        if window_id:
            code, stdout, stderr = await self._run(
                [self._xdotool, "windowclose", window_id]
            )
        elif name:
            # 先搜索再关闭
            code, stdout, stderr = await self._run(
                [self._xdotool, "search", "--name", name, "windowclose"]
            )
        else:
            return {"error": "Must provide 'window_id' or 'name'"}
        await asyncio.sleep(0.5)
        ss = await self.screenshot()
        return {"output": "closed", "error": stderr if code != 0 else None, **ss}
