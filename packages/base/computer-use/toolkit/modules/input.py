"""
input.py - 输入操控 Mixin
提供鼠标点击、拖拽、键盘输入、滚动、悬停、缩放等交互操作。
"""

import asyncio
from typing import Optional

from .core import (
    ComputerToolBase,
    CoordSource,
    CLICK_BUTTONS,
    SCROLL_DIRECTIONS,
    SCREENSHOT_DELAY,
    TYPING_DELAY_MS,
    TYPING_GROUP_SIZE,
    MAX_TEXT_LENGTH,
    MAX_SCROLL_AMOUNT,
    validate_keys,
    validate_modifier_key,
)
from .registry import register_action


class InputMixin(ComputerToolBase):
    """鼠标、键盘、滚动、缩放等输入操控"""

    async def click(
        self,
        action: str,
        x: Optional[int] = None,
        y: Optional[int] = None,
        key: Optional[str] = None,
    ) -> dict:
        """鼠标点击操作（内部方法，由各 click action wrapper 调用）"""
        args = [self._xdotool]
        if x is not None and y is not None:
            sx, sy = self.scale_coordinates(CoordSource.API, x, y)
            args.extend(["mousemove", "--sync", str(sx), str(sy)])
        if key:
            key = validate_modifier_key(key)
            args.extend(["keydown", key])
        args.extend(["click"] + CLICK_BUTTONS[action])
        if key:
            args.extend(["keyup", key])
        code, stdout, stderr = await self._run(args)
        await asyncio.sleep(SCREENSHOT_DELAY)
        ss = await self.screenshot()
        return {"output": stdout, "error": stderr if code != 0 else None, **ss}

    @register_action("left_click", optional={"x": None, "y": None, "key": None},
                      desc="左键单击（可带修饰键）", category="基础操作")
    async def click_left(self, x=None, y=None, key=None) -> dict:
        return await self.click("left_click", x, y, key)

    @register_action("right_click", optional={"x": None, "y": None, "key": None},
                      desc="右键单击", category="基础操作")
    async def click_right(self, x=None, y=None, key=None) -> dict:
        return await self.click("right_click", x, y, key)

    @register_action("double_click", optional={"x": None, "y": None, "key": None},
                      desc="左键双击", category="基础操作")
    async def click_double(self, x=None, y=None, key=None) -> dict:
        return await self.click("double_click", x, y, key)

    @register_action("triple_click", optional={"x": None, "y": None, "key": None},
                      desc="左键三击（全选行）", category="基础操作")
    async def click_triple(self, x=None, y=None, key=None) -> dict:
        return await self.click("triple_click", x, y, key)

    @register_action("middle_click", optional={"x": None, "y": None, "key": None},
                      desc="中键单击", category="基础操作")
    async def click_middle(self, x=None, y=None, key=None) -> dict:
        return await self.click("middle_click", x, y, key)

    @register_action("mouse_move", required=("x", "y"),
                      desc="移动鼠标到指定位置", category="基础操作")
    async def mouse_move(self, x: int, y: int) -> dict:
        """移动鼠标到指定位置"""
        sx, sy = self.scale_coordinates(CoordSource.API, x, y)
        code, stdout, stderr = await self._run(
            [self._xdotool, "mousemove", "--sync", str(sx), str(sy)]
        )
        await asyncio.sleep(SCREENSHOT_DELAY)
        ss = await self.screenshot()
        return {"output": stdout, **ss}

    @register_action("left_click_drag", required=("start_x", "start_y", "end_x", "end_y"),
                      desc="拖拽操作", category="基础操作")
    async def drag(
        self, start_x: int, start_y: int, end_x: int, end_y: int
    ) -> dict:
        """拖拽操作"""
        sx, sy = self.scale_coordinates(CoordSource.API, start_x, start_y)
        ex, ey = self.scale_coordinates(CoordSource.API, end_x, end_y)
        args = [
            self._xdotool,
            "mousemove", "--sync", str(sx), str(sy),
            "mousedown", "1",
            "mousemove", "--sync", str(ex), str(ey),
            "mouseup", "1",
        ]
        code, stdout, stderr = await self._run(args)
        await asyncio.sleep(SCREENSHOT_DELAY)
        ss = await self.screenshot()
        return {"output": stdout, **ss}

    @register_action("type", required=("text",),
                      desc="输入文本内容", category="基础操作")
    async def type_text(self, text: str) -> dict:
        """分块输入文本（50字符/块）"""
        if len(text) > MAX_TEXT_LENGTH:
            return {"error": f"Text too long ({len(text)} chars), max allowed: {MAX_TEXT_LENGTH}"}
        chunks = [
            text[i : i + TYPING_GROUP_SIZE]
            for i in range(0, len(text), TYPING_GROUP_SIZE)
        ]
        for chunk in chunks:
            args = [
                self._xdotool, "type",
                "--delay", str(TYPING_DELAY_MS),
                "--", chunk,
            ]
            await self._run(args)
        ss = await self.screenshot()
        return {"output": "typed", **ss}

    @register_action("key", required=("keys",),
                      desc="按键/组合键（如 ctrl+s, Return, alt+Tab）", category="基础操作")
    async def key_press(self, keys: str) -> dict:
        """按键/组合键"""
        keys = validate_keys(keys)
        args = [self._xdotool, "key", "--", keys]
        code, stdout, stderr = await self._run(args)
        await asyncio.sleep(SCREENSHOT_DELAY)
        ss = await self.screenshot()
        return {"output": stdout, **ss}

    @register_action("scroll", required=("direction",), optional={"amount": 3, "x": None, "y": None},
                      desc="滚动（up/down/left/right）", category="基础操作")
    async def scroll(
        self,
        direction: str,
        amount: int = 3,
        x: Optional[int] = None,
        y: Optional[int] = None,
    ) -> dict:
        """滚动操作（支持上下左右4方向）"""
        if direction not in SCROLL_DIRECTIONS:
            return {"error": f"Invalid scroll direction: {direction!r}. Must be one of: {', '.join(SCROLL_DIRECTIONS)}"}
        amount = max(1, min(amount, MAX_SCROLL_AMOUNT))
        args = [self._xdotool]
        if x is not None and y is not None:
            sx, sy = self.scale_coordinates(CoordSource.API, x, y)
            args.extend(["mousemove", "--sync", str(sx), str(sy)])
        args.extend([
            "click", "--repeat", str(amount), str(SCROLL_DIRECTIONS[direction])
        ])
        code, stdout, stderr = await self._run(args)
        await asyncio.sleep(SCREENSHOT_DELAY)
        ss = await self.screenshot()
        return {"output": stdout, **ss}

    @register_action("wait", optional={"duration": 2},
                      desc="等待指定秒数（最大 30s）", category="基础操作")
    async def wait(self, duration: float) -> dict:
        """等待指定时间（最大30秒）"""
        duration = max(0, min(duration, 30))
        await asyncio.sleep(duration)
        return await self.screenshot()

    @register_action("cursor_position",
                      desc="获取当前鼠标坐标", category="基础操作")
    async def cursor_position(self) -> dict:
        """获取当前鼠标坐标"""
        code, stdout, _ = await self._run(
            [self._xdotool, "getmouselocation", "--shell"]
        )
        if code == 0:
            try:
                lines = stdout.strip().split("\n")
                x_vals = [line.split("=")[1] for line in lines if line.startswith("X=")]
                y_vals = [line.split("=")[1] for line in lines if line.startswith("Y=")]
                if not x_vals or not y_vals:
                    return {"error": f"Unexpected xdotool output format: {stdout[:200]}"}
                raw_x = int(x_vals[0])
                raw_y = int(y_vals[0])
            except (IndexError, ValueError) as e:
                return {"error": f"Failed to parse cursor position: {e}, output: {stdout[:200]}"}
            sx, sy = self.scale_coordinates(CoordSource.SCREEN, raw_x, raw_y)
            return {"x": sx, "y": sy}
        return {"error": "Failed to get cursor position"}

    @register_action("mouse_hold", required=("x", "y"), optional={"duration": 1, "button": 1},
                      desc="长按鼠标（默认左键 1s）", category="基础操作")
    async def mouse_hold(self, x: int, y: int, duration: float = 1, button: int = 1) -> dict:
        """
        在指定位置长按鼠标。
        button: 1=左键, 2=中键, 3=右键
        duration: 长按时长（秒），最大 10 秒
        """
        duration = max(0.1, min(duration, 10))
        button = max(1, min(button, 3))
        sx, sy = self.scale_coordinates(CoordSource.API, x, y)

        # 移动 → 按下
        code, _, stderr = await self._run(
            [self._xdotool, "mousemove", "--sync", str(sx), str(sy),
             "mousedown", str(button)]
        )
        if code != 0:
            return {"error": f"Mouse hold failed: {stderr}"}

        # 等待
        await asyncio.sleep(duration)

        # 释放
        code, _, stderr = await self._run(
            [self._xdotool, "mouseup", str(button)]
        )

        await asyncio.sleep(SCREENSHOT_DELAY)
        ss = await self.screenshot()
        return {"output": "held", "duration": duration, "button": button, **ss}

    @register_action("hover", required=("x", "y"), optional={"duration": 2},
                      desc="悬停触发 tooltip/hover 效果（默认 2s）", category="基础操作")
    async def hover(self, x: int, y: int, duration: float = 2) -> dict:
        """
        移动鼠标到指定位置并悬停指定时长，用于触发 tooltip/hover 效果。
        duration: 悬停时长（秒），最大 10 秒
        """
        duration = max(0.5, min(duration, 10))
        sx, sy = self.scale_coordinates(CoordSource.API, x, y)

        code, _, stderr = await self._run(
            [self._xdotool, "mousemove", "--sync", str(sx), str(sy)]
        )
        if code != 0:
            return {"error": f"Hover move failed: {stderr}"}

        # 悬停等待
        await asyncio.sleep(duration)

        ss = await self.screenshot()
        return {"output": "hovered", "duration": duration, **ss}

    @register_action("zoom", required=("direction",), optional={"amount": 3, "x": None, "y": None, "method": "scroll"},
                      desc="缩放操作（in/out/reset，默认 Ctrl+滚轮）", category="基础操作")
    async def zoom(self, direction: str, amount: int = 3,
                   x: Optional[int] = None, y: Optional[int] = None,
                   method: str = "scroll") -> dict:
        """
        缩放操作，支持多种方式：
        - method="scroll"（默认）: 使用 Ctrl+鼠标滚轮，适用于浏览器、地图、图片查看器等
        - method="key": 使用 Ctrl+加号/Ctrl+减号键盘快捷键
        direction: "in" 放大, "out" 缩小, "reset" 重置缩放（仅 key 模式）
        amount: 缩放次数（默认 3）
        x, y: 缩放中心点坐标（仅 scroll 模式有效，不指定则在当前鼠标位置）
        """
        if direction not in ("in", "out", "reset"):
            return {"error": f"Invalid zoom direction: {direction!r}. Must be 'in', 'out', or 'reset'"}

        amount = max(1, min(amount, 20))

        if direction == "reset":
            # Ctrl+0 重置缩放
            code, stdout, stderr = await self._run(
                [self._xdotool, "key", "--", "ctrl+0"]
            )
            await asyncio.sleep(SCREENSHOT_DELAY)
            ss = await self.screenshot()
            return {"output": "zoom reset", "error": stderr if code != 0 else None, **ss}

        if method == "key":
            # 使用键盘快捷键 Ctrl+plus / Ctrl+minus
            key_name = "ctrl+plus" if direction == "in" else "ctrl+minus"
            args = [
                self._xdotool, "key", "--repeat", str(amount),
                "--delay", "100", "--", key_name,
            ]
            code, stdout, stderr = await self._run(args)
            await asyncio.sleep(SCREENSHOT_DELAY)
            ss = await self.screenshot()
            return {"output": f"zoom {direction} x{amount} (key)", "error": stderr if code != 0 else None, **ss}

        # method == "scroll": Ctrl + 鼠标滚轮
        args = [self._xdotool]

        # 如果指定了中心点，先移动鼠标
        if x is not None and y is not None:
            sx, sy = self.scale_coordinates(CoordSource.API, x, y)
            args.extend(["mousemove", "--sync", str(sx), str(sy)])

        # 按下 Ctrl
        args.extend(["keydown", "ctrl"])

        # 滚轮方向：放大=向上滚(4)，缩小=向下滚(5)
        scroll_button = "4" if direction == "in" else "5"
        args.extend(["click", "--repeat", str(amount), "--delay", "50", scroll_button])

        # 释放 Ctrl
        args.extend(["keyup", "ctrl"])

        code, stdout, stderr = await self._run(args)
        await asyncio.sleep(SCREENSHOT_DELAY)
        ss = await self.screenshot()
        return {"output": f"zoom {direction} x{amount} (scroll)", "error": stderr if code != 0 else None, **ss}
