"""
accessibility.py - Layer 2: AXTree 无障碍语义感知 Mixin
提供桌面应用的无障碍语义树查询（AT-SPI / Playwright Accessibility）。
"""

from typing import Optional, Protocol, runtime_checkable

from .core import ComputerToolBase
from .registry import register_action


@runtime_checkable
class PlaywrightCapable(Protocol):
    """协议类型：声明 BrowserMixin 提供的 Playwright 能力"""
    async def _ensure_playwright(self) -> tuple: ...


class AccessibilityMixin(ComputerToolBase):
    """Layer 2: AXTree 无障碍语义感知（零 Token 消耗）"""

    @register_action("accessibility_tree", optional={"app_name": None, "max_depth": 5, "max_nodes": 200}, layer="L2",
                      desc="获取应用的无障碍语义树", category="Layer 2: AXTree 语义感知")
    async def accessibility_tree(self, app_name: Optional[str] = None,
                                 max_depth: int = 5,
                                 max_nodes: int = 200) -> dict:
        """
        获取桌面应用的无障碍语义树（AT-SPI / AXTree）。
        可覆盖浏览器和非浏览器 GUI 应用（gedit、文件管理器等）。
        app_name: 可选，指定应用名（如 "chromium", "gedit"），不指定则获取所有
        max_depth: 最大遍历深度（防止树过大）
        max_nodes: 最大返回节点数
        """
        # 优先尝试 Playwright 的 accessibility 快照（浏览器场景，更精准）
        if app_name and app_name.lower() in ("chromium", "chrome", "firefox", "browser"):
            # 通过 Protocol 类型检查确认 BrowserMixin 能力可用
            if isinstance(self, PlaywrightCapable):
                browser, context, page = await self._ensure_playwright()
                if page is not None:
                    try:
                        snapshot = await page.accessibility.snapshot()
                        if snapshot:
                            return {
                                "source": "playwright_accessibility",
                                "app": app_name,
                                "tree": self._truncate_ax_tree(snapshot, max_depth, max_nodes),
                            }
                    except Exception:
                        pass  # fallback 到 AT-SPI

        # AT-SPI 方式（系统级，覆盖所有 GUI 应用）
        try:
            import gi
            gi.require_version('Atspi', '2.0')
            from gi.repository import Atspi
        except (ImportError, ValueError):
            return {
                "error": "AT-SPI 不可用。请确认已安装: python3-gi, gir1.2-atspi-2.0, at-spi2-core"
            }

        try:
            desktop = Atspi.get_desktop(0)
            child_count = desktop.get_child_count()
            apps = []

            for i in range(child_count):
                app = desktop.get_child_at_index(i)
                if app is None:
                    continue
                name = app.get_name() or ""
                if app_name and app_name.lower() not in name.lower():
                    continue
                tree = self._atspi_node_to_dict(app, max_depth=max_depth,
                                                 remaining=[max_nodes])
                apps.append({"name": name, "tree": tree})

            if not apps:
                msg = f"未找到应用 '{app_name}'" if app_name else "未找到任何可访问应用"
                return {"error": msg, "hint": "确认应用已启动且支持 AT-SPI"}

            return {"source": "atspi", "apps": apps}
        except Exception as e:
            return {"error": f"AT-SPI 查询失败: {str(e)[:500]}"}

    def _atspi_node_to_dict(self, node, depth: int = 0, max_depth: int = 5,
                            remaining: list = None) -> Optional[dict]:
        """递归将 AT-SPI 节点转为字典"""
        if remaining is None:
            remaining = [200]
        if depth > max_depth or remaining[0] <= 0:
            return None
        remaining[0] -= 1

        try:
            import gi
            gi.require_version('Atspi', '2.0')
            from gi.repository import Atspi

            role = node.get_role_name() or "unknown"
            name = node.get_name() or ""
            description = node.get_description() or ""

            result = {"role": role}
            if name:
                result["name"] = name
            if description:
                result["description"] = description

            # 获取状态
            try:
                state_set = node.get_state_set()
                states = []
                for state in [Atspi.StateType.FOCUSED, Atspi.StateType.CHECKED,
                              Atspi.StateType.SELECTED, Atspi.StateType.ENABLED,
                              Atspi.StateType.VISIBLE, Atspi.StateType.EDITABLE]:
                    if state_set.contains(state):
                        states.append(Atspi.StateType.get_name(state))
                if states:
                    result["states"] = states
            except Exception:
                pass

            # 获取值（如输入框当前值）
            try:
                value_iface = node.get_value()
                if value_iface:
                    result["value"] = value_iface.get_current_value()
            except Exception:
                pass

            # 获取文本（如果是文本节点）
            try:
                text_iface = node.get_text()
                if text_iface:
                    char_count = text_iface.get_character_count()
                    if 0 < char_count <= 500:
                        result["text"] = text_iface.get_text(0, char_count)
            except Exception:
                pass

            # 递归子节点
            child_count = node.get_child_count()
            if child_count > 0 and depth < max_depth:
                children = []
                for i in range(min(child_count, 50)):  # 限制子节点数
                    child = node.get_child_at_index(i)
                    if child:
                        child_dict = self._atspi_node_to_dict(
                            child, depth + 1, max_depth, remaining)
                        if child_dict:
                            children.append(child_dict)
                if children:
                    result["children"] = children

            return result
        except Exception:
            return None

    def _truncate_ax_tree(self, tree: dict, max_depth: int = 5,
                          max_nodes: int = 200) -> dict:
        """截断 Playwright 返回的 accessibility 树，防止过大"""
        count = [0]

        def _truncate(node, depth):
            if count[0] >= max_nodes or depth > max_depth:
                return None
            count[0] += 1
            result = {k: v for k, v in node.items() if k != "children"}
            if "children" in node and depth < max_depth:
                children = []
                for child in node["children"]:
                    truncated = _truncate(child, depth + 1)
                    if truncated:
                        children.append(truncated)
                if children:
                    result["children"] = children
            return result

        return _truncate(tree, 0)
