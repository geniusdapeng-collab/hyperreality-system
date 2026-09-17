#!/bin/bash
# ============================================================
# stop_desktop.sh - 停止沙箱虚拟桌面环境
# ============================================================

set -uo pipefail

# ===========================================================
# 函数定义
# ===========================================================

stop_recording() {
    [ -f /tmp/computer-use-recording.pid ] || return
    local rec_pid
    rec_pid=$(cat /tmp/computer-use-recording.pid 2>/dev/null | tr -cd '0-9')
    if [ -n "$rec_pid" ] && kill -0 "$rec_pid" 2>/dev/null; then
        kill -INT "$rec_pid" 2>/dev/null; sleep 1
        kill -0 "$rec_pid" 2>/dev/null && kill -9 "$rec_pid" 2>/dev/null || true
        echo "[Desktop] 已停止屏幕录制 PID=${rec_pid}"
    fi
    rm -f /tmp/computer-use-recording.pid
}

stop_tracked_pids() {
    [ -f /tmp/desktop-pids ] || return
    for pid_var in WEBSOCKIFY_PID VNC_PID BROWSER_PID TINT2_PID MUTTER_PID XVFB_PID; do
        local pid
        pid=$(grep "^${pid_var}=" /tmp/desktop-pids 2>/dev/null | cut -d= -f2 | tr -cd '0-9')
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null && echo "[Desktop] 已停止 ${pid_var}=${pid}"
        fi
    done
    rm -f /tmp/desktop-pids /tmp/desktop-env
}

kill_residual_processes() {
    for proc in mutter openbox tint2 x11vnc; do
        pkill -x "$proc" 2>/dev/null || true
    done
    pkill -f "websockify" 2>/dev/null || true
    pkill -x "autocutsel" 2>/dev/null || true
    pkill -f "Xvfb" 2>/dev/null || true
    pkill -f "ffmpeg.*x11grab" 2>/dev/null || true
    pkill -f "chromium.*remote-debugging-port" 2>/dev/null || true
    pkill -f "chrome.*remote-debugging-port" 2>/dev/null || true
    pkill -f "at-spi-bus-launcher" 2>/dev/null || true
    pkill -f "at-spi2-registryd" 2>/dev/null || true
}

clean_temp_files() {
    local display_num="${DISPLAY_NUM:-1}"
    rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}"
    rm -rf /tmp/computer-use-outputs/*
    rm -f /tmp/computer-use-vnc.pid /tmp/computer-use-websockify.pid
}

# ===========================================================
# 主流程
# ===========================================================

echo "[Desktop] 停止桌面环境..."

stop_recording
stop_tracked_pids
kill_residual_processes
clean_temp_files

echo "[Desktop] ✓ 桌面环境已停止"
