#!/usr/bin/env python3
"""
Computer Use Tool - 沙箱版（分层感知架构 v3.0）
提供沙箱桌面环境的截图、鼠标、键盘、窗口管理、剪贴板、OCR、录制等交互能力。
支持三层感知通道：
  Layer 1 - Playwright（浏览器结构化操控，零 Token 消耗）
  Layer 2 - AXTree / AT-SPI（桌面应用语义感知，零 Token 消耗）
  Layer 3 - 截图 + 视觉模型（全桌面通用兜底）

用法:
    python3 computer_tool.py '{"action": "screenshot"}'
    python3 computer_tool.py '{"action": "left_click", "x": 512, "y": 384}'
    python3 computer_tool.py '{"action": "type", "text": "Hello"}'
    python3 computer_tool.py '{"action": "key", "keys": "ctrl+s"}'
    python3 computer_tool.py '{"action": "window_list"}'
    python3 computer_tool.py '{"action": "window_focus", "name": "Firefox"}'
    python3 computer_tool.py '{"action": "screenshot_region", "x": 100, "y": 100, "width": 400, "height": 300}'
    python3 computer_tool.py '{"action": "clipboard_get"}'
    python3 computer_tool.py '{"action": "clipboard_set", "text": "Hello"}'
    python3 computer_tool.py '{"action": "screen_text"}'
    python3 computer_tool.py '{"action": "hover", "x": 200, "y": 300, "duration": 2}'
    python3 computer_tool.py '{"action": "zoom", "direction": "in", "amount": 3}'
    python3 computer_tool.py '{"action": "zoom", "direction": "out", "x": 512, "y": 384}'
    python3 computer_tool.py '{"action": "zoom", "direction": "reset"}'
    # --- Layer 1: Playwright 浏览器操控 ---
    python3 computer_tool.py '{"action": "browser_connect"}'
    python3 computer_tool.py '{"action": "browser_goto", "url": "https://example.com"}'
    python3 computer_tool.py '{"action": "browser_url"}'
    python3 computer_tool.py '{"action": "browser_content"}'
    python3 computer_tool.py '{"action": "browser_click", "selector": "button:has-text(\"Login\")"}'
    python3 computer_tool.py '{"action": "browser_click", "selector": "#menu", "button": "right"}'
    python3 computer_tool.py '{"action": "browser_click", "selector": ".btn", "force": true}'
    python3 computer_tool.py '{"action": "browser_fill", "selector": "#username", "value": "admin"}'
    python3 computer_tool.py '{"action": "browser_get_text", "selector": "h1"}'
    python3 computer_tool.py '{"action": "browser_links", "pattern": "/video/BV"}'
    python3 computer_tool.py '{"action": "browser_wait", "selector": ".loaded", "timeout": 10}'
    python3 computer_tool.py '{"action": "browser_eval", "expression": "document.title"}'
    python3 computer_tool.py '{"action": "browser_screenshot"}'
    python3 computer_tool.py '{"action": "browser_screenshot", "format": "jpeg", "quality": 50}'
    python3 computer_tool.py '{"action": "browser_snapshot"}'
    python3 computer_tool.py '{"action": "browser_tabs"}'
    python3 computer_tool.py '{"action": "browser_new_tab", "url": "https://example.com"}'
    python3 computer_tool.py '{"action": "browser_close_tab"}'
    python3 computer_tool.py '{"action": "browser_switch_tab", "index": 0}'
    # --- 网络请求监听/等待 ---
    python3 computer_tool.py '{"action": "browser_wait_network_idle", "timeout": 10}'
    python3 computer_tool.py '{"action": "browser_wait_response", "url_pattern": "/api/data"}'
    # --- Cookie / Storage ---
    python3 computer_tool.py '{"action": "browser_cookies_get"}'
    python3 computer_tool.py '{"action": "browser_cookies_set", "cookies": "[{\"name\":\"token\",\"value\":\"abc\",\"domain\":\".example.com\",\"path\":\"/\"}]"}'
    python3 computer_tool.py '{"action": "browser_cookies_clear"}'
    python3 computer_tool.py '{"action": "browser_storage_get"}'
    python3 computer_tool.py '{"action": "browser_storage_set", "key": "theme", "value": "dark"}'
    # --- DOM 结构化快照 ---
    python3 computer_tool.py '{"action": "browser_snapshot", "interesting_only": true}'
    python3 computer_tool.py '{"action": "browser_snapshot", "root_selector": "#app"}'
    # --- iframe 操作 ---
    python3 computer_tool.py '{"action": "browser_frames"}'
    python3 computer_tool.py '{"action": "browser_switch_frame", "name": "login-frame"}'
    python3 computer_tool.py '{"action": "browser_switch_frame", "url_contains": "oauth"}'
    python3 computer_tool.py '{"action": "browser_main_frame"}'
    # --- 断线重连 ---
    python3 computer_tool.py '{"action": "browser_reconnect"}'
    # --- Layer 2: AXTree 无障碍语义感知 ---
    python3 computer_tool.py '{"action": "accessibility_tree"}'
    python3 computer_tool.py '{"action": "accessibility_tree", "app_name": "chromium"}'
    # --- Anti-Detection: 人类行为模拟 ---
    python3 computer_tool.py '{"action": "browser_human_click", "selector": "#login-btn"}'
    python3 computer_tool.py '{"action": "browser_human_type", "selector": "#username", "value": "admin"}'
    python3 computer_tool.py '{"action": "browser_random_scroll", "direction": "down", "distance": 400}'
"""

import asyncio
import json
import sys

# 确保 modules 包可被导入（支持直接 python3 computer_tool.py 调用）
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from modules.core import ComputerToolBase
from modules.input import InputMixin
from modules.window import WindowMixin
from modules.recording import RecordingMixin
from modules.screen import ScreenMixin
from modules.browser import BrowserMixin
from modules.accessibility import AccessibilityMixin
from modules.stealth import StealthMixin
from modules.vnc import VncMixin
from modules.registry import get_action_spec


class ComputerTool(
    InputMixin,
    WindowMixin,
    RecordingMixin,
    ScreenMixin,
    BrowserMixin,
    AccessibilityMixin,
    StealthMixin,
    VncMixin,
    ComputerToolBase,
):
    """
    Computer Use Tool - 组合所有领域 Mixin 的最终类。
    通过 Python MRO（方法解析顺序）组合各领域能力，
    ComputerToolBase 放在最后确保 __init__ 和基础方法的正确继承。
    Action 分发由注册表驱动（ADR-001），无需维护 if-elif 链。
    """

    async def execute(self, action: str, **kwargs) -> dict:
        """统一 action 分发入口 - 注册表驱动（ADR-001）"""
        spec = get_action_spec(action)
        if spec is None:
            return {"error": f"Unknown action: {action}"}

        try:
            # 参数校验：必选参数检查
            missing = [p for p in spec.required_params if p not in kwargs]
            if missing:
                return {"error": f"Missing required parameter(s): {', '.join(missing)}"}

            # 参数校验：未声明参数检查（防止多余参数透传导致 TypeError）
            allowed = set(spec.required_params) | set(spec.optional_params.keys())
            unexpected = set(kwargs.keys()) - allowed
            if unexpected:
                return {"error": f"Unexpected parameter(s) for action '{action}': {', '.join(sorted(unexpected))}"}

            # 填充可选参数默认值
            for param, default in spec.optional_params.items():
                kwargs.setdefault(param, default)

            # 分发到方法
            method = getattr(self, spec.method_name)
            return await method(**kwargs)
        except ValueError as e:
            return {"error": f"Invalid parameter: {e}"}
        except Exception as e:
            return {"error": f"Internal error in action '{action}': {type(e).__name__}: {str(e)[:500]}"}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {"error": "Usage: computer_tool.py '<action_json>'"}
            )
        )
        sys.exit(1)

    try:
        action_data = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    if "action" not in action_data:
        print(json.dumps({"error": "Missing 'action' field in input JSON"}))
        sys.exit(1)

    action = action_data.pop("action")
    tool = ComputerTool()
    result = asyncio.run(tool.execute(action, **action_data))
    print(json.dumps(result))
