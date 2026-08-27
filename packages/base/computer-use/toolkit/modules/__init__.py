"""
Computer Use Tool - 分层模块包
按领域拆分为独立 Mixin，由 computer_tool.py 组合使用。
Action 注册表在各 Mixin 导入时自动填充（ADR-001）。
"""

# registry 必须最先导入（其他模块依赖它）
from .registry import (
    register_action,
    get_registry,
    get_action_spec,
    get_all_action_names,
    ActionSpec,
)

from .core import (
    VERSION,
    ComputerToolBase,
    CoordSource,
    OUTPUT_DIR,
    RECORDING_DIR,
    RECORDING_PID_FILE,
    TYPING_DELAY_MS,
    TYPING_GROUP_SIZE,
    SCREENSHOT_DELAY,
    COMMAND_TIMEOUT,
    MAX_TEXT_LENGTH,
    MAX_SCREENSHOT_SIZE,
    MAX_SCROLL_AMOUNT,
    MAX_RECORDING_DURATION,
    MAX_RECORDING_SIZE,
    MAX_RECORDING_FILES,
    RECORDING_FRAMERATE,
    CDP_PORT,
    CDP_URL,
    BROWSER_ACTION_TIMEOUT,
    MAX_BROWSER_LINKS,
    MAX_CONTENT_LENGTH,
    MAX_SCALING_TARGETS,
    CLICK_BUTTONS,
    SCROLL_DIRECTIONS,
    validate_keys,
    validate_modifier_key,
    VNC_PORT,
    NOVNC_PORT,
    VNC_PID_FILE,
    WEBSOCKIFY_PID_FILE,
)
from .input import InputMixin
from .window import WindowMixin
from .recording import RecordingMixin
from .screen import ScreenMixin
from .browser import BrowserMixin
from .accessibility import AccessibilityMixin
from .vnc import VncMixin

__all__ = [
    # 注册表
    "register_action",
    "get_registry",
    "get_action_spec",
    "get_all_action_names",
    "ActionSpec",
    # 核心
    "VERSION",
    "ComputerToolBase",
    "CoordSource",
    "InputMixin",
    "WindowMixin",
    "RecordingMixin",
    "ScreenMixin",
    "BrowserMixin",
    "AccessibilityMixin",
    "VncMixin",
    # 常量
    "OUTPUT_DIR",
    "RECORDING_DIR",
    "RECORDING_PID_FILE",
    "TYPING_DELAY_MS",
    "TYPING_GROUP_SIZE",
    "SCREENSHOT_DELAY",
    "COMMAND_TIMEOUT",
    "MAX_TEXT_LENGTH",
    "MAX_SCREENSHOT_SIZE",
    "MAX_SCROLL_AMOUNT",
    "MAX_RECORDING_DURATION",
    "MAX_RECORDING_SIZE",
    "MAX_RECORDING_FILES",
    "RECORDING_FRAMERATE",
    "CDP_PORT",
    "CDP_URL",
    "BROWSER_ACTION_TIMEOUT",
    "MAX_BROWSER_LINKS",
    "MAX_CONTENT_LENGTH",
    "MAX_SCALING_TARGETS",
    "CLICK_BUTTONS",
    "SCROLL_DIRECTIONS",
    "validate_keys",
    "validate_modifier_key",
    "VNC_PORT",
    "NOVNC_PORT",
    "VNC_PID_FILE",
    "WEBSOCKIFY_PID_FILE",
]
