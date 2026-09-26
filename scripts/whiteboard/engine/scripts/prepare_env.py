#!/usr/bin/env python3
"""
流式笔迹动画 - 环境引导脚本

职责：
  1. 在 skill 目录下建立隔离的 Python 虚拟环境（已存在则复用）
  2. 核对运行所需的第三方库是否可导入
  3. 自动补齐缺失的库
  4. 末行打印 ENV_PY=<解释器路径>，供上层调用方捕获

用法：
  python prepare_env.py          # 建环境 + 补依赖，输出 ENV_PY
  python prepare_env.py --check  # 仅探测，缺东西就以非零码退出

本地补丁（2026-09-27，T-2026-0926-0020，见 vendor/srt-whiteboard/VENDOR.md）：
  ① 增加解释器版本闸（>= 3.10）：上游未判版本，3.8/3.9 上建立 venv 后才在装依赖阶段
     失败，报错信息与根因不匹配（PyAV / numpy 2.x 的 cp310+ wheel 是硬约束）；
  ② 支持 `WHITEBOARD_PYPI_INDEX` 指定 pip index（内网 / 镜像源部署）；
  ③ `--check` 同时报告解释器版本与 venv 是否存在，便于上层给出一句话修复建议。
"""
from __future__ import annotations

import os
import subprocess
import sys
import venv
from pathlib import Path

# skill 根目录 = 本脚本向上两级
SKILL_ROOT = Path(__file__).resolve().parent.parent
VENV_ROOT = SKILL_ROOT / ".venv"

# 依赖闭包要求的最低解释器版本（PyAV / numpy 2.x 无 cp39- 的 macOS arm64 wheel）
MIN_PYTHON = (3, 10)

# 解释器导入名 -> pip 安装名
DEPS: dict[str, str] = {
    "cv2": "opencv-python",
    "numpy": "numpy",
    "av": "av",  # PyAV：纯 pip 安装的 H.264 编码，无需系统 ffmpeg
    "PIL": "Pillow",  # render_annotation_preview.py 画区域编号预览图（含中文标签）
}


def interpreter_path() -> Path:
    """虚拟环境里的 python 可执行文件位置（跨平台）。"""
    if sys.platform.startswith("win"):
        return VENV_ROOT / "Scripts" / "python.exe"
    return VENV_ROOT / "bin" / "python"


def ensure_venv(check_only: bool) -> Path:
    py = interpreter_path()
    if VENV_ROOT.exists() and py.exists():
        print(f"[ok] 复用现有虚拟环境: {VENV_ROOT}")
        return py

    if check_only:
        print(f"[err] 虚拟环境尚未建立: {VENV_ROOT}")
        sys.exit(1)

    print(f"[..] 建立虚拟环境: {VENV_ROOT}")
    venv.create(str(VENV_ROOT), with_pip=True)
    print("[ok] 虚拟环境就绪")
    return py


def check_python_version() -> bool:
    """建 venv 之前先判解释器版本——3.9 及以下装依赖必然失败，提前给出可执行的修复建议。"""
    if sys.version_info >= MIN_PYTHON:
        print(f"[ok] Python {sys.version.split()[0]}（要求 >= {MIN_PYTHON[0]}.{MIN_PYTHON[1]}）")
        return True
    print(
        f"[err] 当前解释器 Python {sys.version.split()[0]} 低于要求 "
        f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]}：PyAV / numpy 2.x 没有对应的 macOS(libc++) wheel。\n"
        f"      请改用 Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ 重跑："
        f"<python3.12> {Path(__file__).name}",
        file=sys.stderr,
    )
    return False


def can_import(py: Path, import_name: str) -> bool:
    probe = subprocess.run(
        [str(py), "-c", f"import {import_name}"],
        capture_output=True,
    )
    return probe.returncode == 0


def install(py: Path, packages: list[str]) -> bool:
    if not packages:
        return True
    print(f"[..] 安装依赖: {', '.join(packages)}")
    index_url = os.environ.get("WHITEBOARD_PYPI_INDEX", "").strip()
    res = subprocess.run(
        [
            str(py), "-m", "pip", "install", "--quiet",
            *(["--index-url", index_url] if index_url else []),
            *packages,
        ],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        print(f"[err] 安装失败:\n{res.stderr}")
        return False
    print("[ok] 依赖安装完成")
    return True


def main() -> None:
    check_only = "--check" in sys.argv

    if not check_python_version():
        sys.exit(1)

    py = ensure_venv(check_only)

    missing: list[str] = []
    for import_name, pip_name in DEPS.items():
        if can_import(py, import_name):
            print(f"[ok] {pip_name}")
        else:
            print(f"[miss] {pip_name}")
            missing.append(pip_name)

    if missing:
        if check_only:
            print(f"\n缺 {len(missing)} 个依赖: {', '.join(missing)}")
            sys.exit(1)
        if not install(py, missing):
            sys.exit(1)

    # 末行：供调用方捕获的约定输出
    print(f"\nENV_PY={py}")


if __name__ == "__main__":
    main()
