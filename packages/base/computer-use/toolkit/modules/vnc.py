"""
vnc.py - VNC 实时预览 Mixin
提供 VNC 服务生命周期管理（x11vnc + websockify）。
VNC 启动后，使用 preview 技能的 notify 脚本生成外部可访问的预览 URL。

依赖: install.sh 确保 x11vnc 和 websockify (pip) 已安装。
noVNC 是可选的——有则托管 Web UI，无则 websockify 做纯 WebSocket→VNC 代理。
"""

from __future__ import annotations

import asyncio
import os
import signal
from pathlib import Path
from typing import Optional

from .core import (
    ComputerToolBase,
    VNC_PORT,
    NOVNC_PORT,
    VNC_PID_FILE,
    WEBSOCKIFY_PID_FILE,
)
from .registry import register_action


class VncMixin(ComputerToolBase):
    """VNC 实时预览服务管理"""

    # -----------------------------------------------------------------
    # PID 管理
    # -----------------------------------------------------------------

    def _read_pid_file(self, pid_file: str) -> Optional[int]:
        """读取 PID 文件并验证进程存活，返回 PID 或 None"""
        path = Path(pid_file)
        if not path.exists():
            return None
        try:
            pid = int(path.read_text().strip())
            os.kill(pid, 0)
            return pid
        except (ValueError, ProcessLookupError, PermissionError):
            path.unlink(missing_ok=True)
            return None

    def _write_pid_file(self, pid_file: str, pid: int) -> None:
        """原子写入 PID 文件"""
        path = Path(pid_file)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(str(pid))
        tmp.rename(path)

    # -----------------------------------------------------------------
    # Actions
    # -----------------------------------------------------------------

    @register_action(
        "vnc_start",
        layer="L3",
        desc="启动 VNC + websockify 服务（启动后需通过 preview 技能的 notify 生成预览 URL）",
        category="VNC 预览",
    )
    async def vnc_start(self) -> dict:
        """
        启动 VNC 实时预览服务：
        1. 检查是否已在运行（幂等）
        2. 启动 x11vnc（端口 5900）
        3. 启动 websockify（端口 6080，WebSocket→VNC 代理）
        4. 返回端口信息
        """
        vnc_pid = self._read_pid_file(VNC_PID_FILE)
        ws_pid = self._read_pid_file(WEBSOCKIFY_PID_FILE)

        if vnc_pid is not None and ws_pid is not None:
            return self._vnc_status_dict(vnc_pid, ws_pid)

        if vnc_pid is not None or ws_pid is not None:
            await self._stop_vnc_processes()

        log_dir = Path("/tmp/desktop-logs")
        log_dir.mkdir(parents=True, exist_ok=True)

        # 1. 启动 x11vnc
        vnc_proc = await asyncio.create_subprocess_exec(
            "x11vnc",
            "-display", f":{self.display_num}",
            "-forever", "-shared", "-nopw",
            "-rfbport", str(VNC_PORT),
            "-xkb", "-noxrecord", "-noxfixes", "-noxdamage",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=open(str(log_dir / "x11vnc.log"), "w"),
            env=self._get_env(),
        )

        await asyncio.sleep(1)
        if vnc_proc.returncode is not None:
            return {"error": "x11vnc failed to start. Check /tmp/desktop-logs/x11vnc.log"}

        self._write_pid_file(VNC_PID_FILE, vnc_proc.pid)

        # 2. 启动 websockify（有 noVNC 就托管 Web 界面，没有就纯代理）
        import shutil as _shutil
        novnc_dir = Path("/usr/share/novnc")
        ws_extra = []
        if novnc_dir.is_dir():
            # 确保自定义首页存在
            index = novnc_dir / "index.html"
            if not index.exists():
                asset = Path(__file__).resolve().parent.parent / "assets" / "novnc-index.html"
                if asset.exists():
                    try:
                        _shutil.copy2(str(asset), str(index))
                    except OSError:
                        pass
            ws_extra = ["--web", str(novnc_dir)]
        ws_args = ws_extra + [str(NOVNC_PORT), f"localhost:{VNC_PORT}"]

        # 优先 python3 -m websockify，fallback 到 websockify 命令
        ws_proc = None
        for cmd in (["python3", "-m", "websockify"], ["websockify"]):
            if cmd[0] == "websockify" and not _shutil.which("websockify"):
                continue
            try:
                ws_proc = await asyncio.create_subprocess_exec(
                    *cmd, *ws_args,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=open(str(log_dir / "websockify.log"), "w"),
                    env=self._get_env(),
                )
                await asyncio.sleep(1)
                if ws_proc.returncode is None:
                    break  # 启动成功
                ws_proc = None
            except FileNotFoundError:
                continue

        if ws_proc is None or ws_proc.returncode is not None:
            try:
                os.kill(vnc_proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            Path(VNC_PID_FILE).unlink(missing_ok=True)
            return {"error": "websockify failed to start. Run: pip3 install websockify"}

        self._write_pid_file(WEBSOCKIFY_PID_FILE, ws_proc.pid)
        return self._vnc_status_dict(vnc_proc.pid, ws_proc.pid)

    @register_action(
        "vnc_stop",
        layer="L3",
        desc="停止 VNC 实时预览服务",
        category="VNC 预览",
    )
    async def vnc_stop(self) -> dict:
        """停止 VNC 和 websockify 服务"""
        vnc_pid = self._read_pid_file(VNC_PID_FILE)
        ws_pid = self._read_pid_file(WEBSOCKIFY_PID_FILE)

        if vnc_pid is None and ws_pid is None:
            return {"status": "already_stopped", "message": "VNC service is not running."}

        await self._stop_vnc_processes()
        return {"status": "stopped", "message": "VNC service stopped."}

    @register_action(
        "vnc_status",
        layer="L3",
        desc="查询 VNC 服务状态",
        category="VNC 预览",
    )
    async def vnc_status(self) -> dict:
        """查询 VNC 服务运行状态"""
        vnc_pid = self._read_pid_file(VNC_PID_FILE)
        ws_pid = self._read_pid_file(WEBSOCKIFY_PID_FILE)

        if vnc_pid is None and ws_pid is None:
            return {"status": "stopped", "running": False}

        if vnc_pid is not None and ws_pid is not None:
            return self._vnc_status_dict(vnc_pid, ws_pid)

        return {
            "status": "degraded",
            "running": False,
            "x11vnc_pid": vnc_pid,
            "websockify_pid": ws_pid,
            "message": "VNC service is partially running. Use vnc_stop then vnc_start to fix.",
        }

    # -----------------------------------------------------------------
    # 内部方法
    # -----------------------------------------------------------------

    def _vnc_status_dict(self, vnc_pid: int, ws_pid: int) -> dict:
        """构建 VNC 状态返回字典"""
        return {
            "status": "running",
            "running": True,
            "vnc_port": VNC_PORT,
            "novnc_port": NOVNC_PORT,
            "x11vnc_pid": vnc_pid,
            "websockify_pid": ws_pid,
            "local_url": f"http://localhost:{NOVNC_PORT}/vnc.html?autoconnect=true&resize=remote",
            "next_step": f"Run: <preview-skill-directory>/notify {NOVNC_PORT}",
        }

    async def _stop_vnc_processes(self) -> None:
        """停止 x11vnc 和 websockify 进程"""
        for pid_file in (WEBSOCKIFY_PID_FILE, VNC_PID_FILE):
            pid = self._read_pid_file(pid_file)
            if pid is not None:
                try:
                    os.kill(pid, signal.SIGTERM)
                    for _ in range(6):
                        await asyncio.sleep(0.5)
                        try:
                            os.kill(pid, 0)
                        except ProcessLookupError:
                            break
                    else:
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                except ProcessLookupError:
                    pass
                Path(pid_file).unlink(missing_ok=True)

        # 兜底清理
        for cmd in (["pkill", "-x", "x11vnc"], ["pkill", "-f", "websockify"]):
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
