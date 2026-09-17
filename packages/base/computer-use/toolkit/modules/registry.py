"""
registry.py - Action 注册表（ADR-001）

声明式 action 分发，替代 if-elif 链。
使用 @register_action 装饰器在 Mixin 方法定义处声明 action 名，
运行时自动收集，execute() 通过注册表查找并分发。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Optional, Tuple


@dataclass(frozen=True)
class ActionSpec:
    """Action 元数据（不可变）"""
    name: str
    method_name: str
    required_params: Tuple[str, ...] = ()
    optional_params: Dict[str, object] = field(default_factory=dict)
    layer: str = "L3"
    description: str = ""
    category: str = ""

    def __repr__(self) -> str:
        return f"ActionSpec({self.name!r}, method={self.method_name!r}, layer={self.layer!r})"


# 全局注册表（模块加载时自动填充）
_ACTION_REGISTRY: Dict[str, ActionSpec] = {}


def register_action(
    name: str,
    *,
    required: Tuple[str, ...] = (),
    optional: Optional[Dict[str, object]] = None,
    layer: str = "L3",
    desc: str = "",
    category: str = "",
) -> Callable:
    """
    装饰器：将方法注册为 action handler。

    用法:
        @register_action("screenshot", layer="L3", desc="截取当前屏幕", category="基础操作")
        async def screenshot(self) -> dict: ...

        @register_action("left_click", optional={"x": None, "y": None, "key": None},
                          desc="左键单击（可带修饰键）", category="基础操作")
        async def click_left(self, x=None, y=None, key=None) -> dict: ...
    """
    def decorator(method: Callable) -> Callable:
        # 自动从 docstring 提取描述（如果 desc 未显式提供）
        resolved_desc = desc or (method.__doc__ or "").strip().split("\n")[0]
        spec = ActionSpec(
            name=name,
            method_name=method.__name__,
            required_params=required,
            optional_params=optional or {},
            layer=layer,
            description=resolved_desc,
            category=category,
        )
        if name in _ACTION_REGISTRY:
            raise ValueError(
                f"Duplicate action '{name}': "
                f"already registered to {_ACTION_REGISTRY[name].method_name}, "
                f"conflict with {method.__name__}"
            )
        _ACTION_REGISTRY[name] = spec
        method._action_spec = spec
        return method
    return decorator


def get_registry() -> Dict[str, ActionSpec]:
    """返回注册表浅拷贝（ActionSpec 自身为 frozen，无需深拷贝）"""
    return dict(_ACTION_REGISTRY)


def get_action_spec(name: str) -> Optional[ActionSpec]:
    """按名称查找 action 规格"""
    return _ACTION_REGISTRY.get(name)


def get_all_action_names() -> frozenset:
    """返回所有已注册 action 名称"""
    return frozenset(_ACTION_REGISTRY.keys())


def _reset_registry() -> None:
    """
    清空注册表（仅供测试使用）。
    WARNING: 生产代码不应调用此方法。
    """
    _ACTION_REGISTRY.clear()
