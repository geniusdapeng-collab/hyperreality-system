"""
recording.py - 录制与音频 Mixin
提供屏幕录制（start/stop/status）和音频播放/捕获功能。
"""

import asyncio
import base64
import os
import re
from pathlib import Path
from typing import Optional
from uuid import uuid4

from .core import (
    ComputerToolBase,
    RECORDING_DIR,
    RECORDING_PID_FILE,
    RECORDING_FRAMERATE,
    MAX_RECORDING_DURATION,
    MAX_RECORDING_SIZE,
    MAX_RECORDING_FILES,
)
from .registry import register_action


class RecordingMixin(ComputerToolBase):
    """屏幕录制 & 音频操作"""

    def _cleanup_old_recordings(self):
        """清理过期录制文件，保留最新的 MAX_RECORDING_FILES 个"""
        try:
            files = sorted(
                Path(RECORDING_DIR).glob("recording_*.mp4"),
                key=lambda f: f.stat().st_mtime,
            )
            if len(files) > MAX_RECORDING_FILES:
                for f in files[: len(files) - MAX_RECORDING_FILES]:
                    f.unlink(missing_ok=True)
        except Exception:
            pass

    def _get_recording_pid(self) -> Optional[int]:
        """获取当前录制进程的 PID，如果不存在或已死亡返回 None"""
        pid_path = Path(RECORDING_PID_FILE)
        if not pid_path.exists():
            return None
        try:
            pid = int(pid_path.read_text().strip())
            # 检查进程是否存活
            os.kill(pid, 0)
            return pid
        except (ValueError, ProcessLookupError, PermissionError):
            pid_path.unlink(missing_ok=True)
            return None

    @register_action("start_recording", optional={"output_name": None},
                      desc="开始录制屏幕（mp4 格式）", category="屏幕录制")
    async def start_recording(self, output_name: Optional[str] = None) -> dict:
        """
        开始录制屏幕，使用 ffmpeg x11grab 采集虚拟显示。
        录制文件保存到 RECORDING_DIR，格式为 mp4。
        """
        # 检查是否已在录制
        existing_pid = self._get_recording_pid()
        if existing_pid is not None:
            return {"error": f"Recording already in progress (PID={existing_pid}). Stop it first with 'stop_recording'."}

        # 清理过期录制文件
        self._cleanup_old_recordings()

        # 生成输出文件名
        if output_name:
            # 安全校验文件名：只允许字母数字、下划线、连字符
            safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", output_name)
            filename = f"recording_{safe_name}.mp4"
        else:
            filename = f"recording_{uuid4().hex[:12]}.mp4"
        output_path = Path(RECORDING_DIR) / filename

        # 使用 ffmpeg x11grab 录制
        ffmpeg_args = [
            "ffmpeg",
            "-y",  # 覆盖已有文件
            "-f", "x11grab",
            "-framerate", str(RECORDING_FRAMERATE),
            "-video_size", f"{self.width}x{self.height}",
            "-i", f":{self.display_num}.0",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "28",
            "-pix_fmt", "yuv420p",
            "-t", str(MAX_RECORDING_DURATION),  # 最大录制时长保护
            str(output_path),
        ]

        proc = await asyncio.create_subprocess_exec(
            *ffmpeg_args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=self._get_env(),
        )

        # 等待短暂时间确认 ffmpeg 是否成功启动
        await asyncio.sleep(0.5)
        if proc.returncode is not None:
            _, stderr = await proc.communicate()
            return {"error": f"Failed to start recording: {stderr.decode('utf-8', errors='replace')[:500]}"}

        # 原子写入 PID 文件（写临时文件再 rename，避免 TOCTOU 竞态）
        pid_path = Path(RECORDING_PID_FILE)
        tmp_pid_path = pid_path.with_suffix(".tmp")
        tmp_pid_path.write_text(str(proc.pid))
        tmp_pid_path.rename(pid_path)

        return {
            "status": "recording",
            "pid": proc.pid,
            "output_file": str(output_path),
            "framerate": RECORDING_FRAMERATE,
            "max_duration": MAX_RECORDING_DURATION,
            "resolution": f"{self.width}x{self.height}",
        }

    @register_action("stop_recording",
                      desc="停止录制并返回录制文件", category="屏幕录制")
    async def stop_recording(self) -> dict:
        """
        停止当前屏幕录制。
        向 ffmpeg 发送 SIGINT（等同按 q），让它正常完成文件写入。
        返回录制文件的 base64 编码，如果文件过大则返回文件路径。
        """
        import signal

        pid = self._get_recording_pid()
        if pid is None:
            return {"error": "No active recording found."}

        # 发送 SIGINT 让 ffmpeg 正常结束（写入 moov atom）
        try:
            os.kill(pid, signal.SIGINT)
        except ProcessLookupError:
            Path(RECORDING_PID_FILE).unlink(missing_ok=True)
            return {"error": "Recording process already terminated."}

        # 等待 ffmpeg 退出（最多 10 秒）
        for _ in range(20):
            await asyncio.sleep(0.5)
            try:
                os.kill(pid, 0)  # 检查是否还存活
            except ProcessLookupError:
                break
        else:
            # 超时强制 kill
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

        Path(RECORDING_PID_FILE).unlink(missing_ok=True)

        # 查找最新的录制文件
        recordings = sorted(
            Path(RECORDING_DIR).glob("recording_*.mp4"),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
        if not recordings:
            return {"error": "Recording file not found after stopping."}

        recording_file = recordings[0]
        file_size = recording_file.stat().st_size

        if file_size == 0:
            recording_file.unlink(missing_ok=True)
            return {"error": "Recording file is empty. The recording may have failed."}

        result = {
            "status": "stopped",
            "file": str(recording_file),
            "size_bytes": file_size,
            "size_mb": round(file_size / (1024 * 1024), 2),
        }

        # 文件小于 MAX_RECORDING_SIZE 则返回 base64
        if file_size <= MAX_RECORDING_SIZE:
            b64 = base64.b64encode(recording_file.read_bytes()).decode()
            result["base64_video"] = b64
        else:
            result["note"] = f"File too large for base64 encoding ({result['size_mb']}MB). Use the file path directly."

        return result

    @register_action("recording_status",
                      desc="查询当前录制状态", category="屏幕录制")
    async def recording_status(self) -> dict:
        """查询当前录制状态"""
        pid = self._get_recording_pid()
        if pid is None:
            return {"status": "idle", "recording": False}

        # 查找当前录制的文件
        recordings = sorted(
            Path(RECORDING_DIR).glob("recording_*.mp4"),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
        current_file = str(recordings[0]) if recordings else "unknown"

        return {
            "status": "recording",
            "recording": True,
            "pid": pid,
            "current_file": current_file,
        }

    # -----------------------------------------------------------------
    # 音频
    # -----------------------------------------------------------------

    @register_action("audio_play", required=("file_path",),
                      desc="播放音频文件（需 PulseAudio）", category="音频")
    async def audio_play(self, file_path: str) -> dict:
        """
        在虚拟桌面中播放音频文件（需要 PulseAudio 虚拟声卡已配置）。
        """
        # 安全校验：先解析真实路径，再校验是否在允许的目录内
        resolved = Path(file_path).resolve()
        allowed_dirs = [Path(RECORDING_DIR).resolve(), Path("/tmp").resolve(), Path.home().resolve()]
        if not any(str(resolved).startswith(str(d)) for d in allowed_dirs):
            return {"error": f"Access denied: file must be under {', '.join(str(d) for d in allowed_dirs)}"}
        if not resolved.is_file():
            return {"error": f"Audio file not found: {file_path}"}
        # 文件名安全校验（路径穿越已通过 resolve + 白名单阻止）
        if not re.match(r"^[a-zA-Z0-9_/.\-]+$", file_path):
            return {"error": f"Invalid file path characters: {file_path!r}"}

        # 使用 paplay（PulseAudio）或 aplay（ALSA）播放
        code, stdout, stderr = await self._run(["paplay", file_path])
        if code != 0:
            # fallback: ffplay 静默播放
            code, stdout, stderr = await self._run(
                ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", file_path]
            )
            if code != 0:
                return {"error": f"Audio playback failed: {stderr[:500]}"}

        return {"status": "played", "file": file_path}

    @register_action("audio_capture", optional={"duration": 10, "output_name": None},
                      desc="录制系统音频（默认 10s，最大 60s）", category="音频")
    async def audio_capture(self, duration: float = 10, output_name: Optional[str] = None) -> dict:
        """
        捕获虚拟声卡的音频输出，保存为 wav 文件。
        duration: 录制时长（秒），最大 60 秒。
        """
        duration = max(1, min(duration, 60))

        if output_name:
            safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", output_name)
            filename = f"audio_{safe_name}.wav"
        else:
            filename = f"audio_{uuid4().hex[:12]}.wav"

        output_path = Path(RECORDING_DIR) / filename

        # 使用 ffmpeg 录制 PulseAudio 音频
        code, stdout, stderr = await self._run_with_timeout(
            [
                "ffmpeg", "-y",
                "-f", "pulse",
                "-i", "default",
                "-t", str(duration),
                "-ac", "1",
                "-ar", "44100",
                str(output_path),
            ],
            timeout=duration + 5,
        )

        if code != 0 or not output_path.exists():
            return {"error": f"Audio capture failed: {stderr[:500] if isinstance(stderr, str) else 'unknown'}"}

        file_size = output_path.stat().st_size
        if file_size == 0:
            output_path.unlink(missing_ok=True)
            return {"error": "Audio capture produced empty file. Is PulseAudio running?"}

        result = {
            "status": "captured",
            "file": str(output_path),
            "duration": duration,
            "size_bytes": file_size,
        }

        # 小于 10MB 返回 base64
        if file_size <= 10 * 1024 * 1024:
            b64 = base64.b64encode(output_path.read_bytes()).decode()
            result["base64_audio"] = b64

        return result
