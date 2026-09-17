#!/bin/bash
# ============================================================
# start_desktop.sh - 启动沙箱虚拟桌面环境
# ============================================================

set -euo pipefail

export DISPLAY_NUM="${DISPLAY_NUM:-1}"
export WIDTH="${WIDTH:-1280}"
export HEIGHT="${HEIGHT:-800}"
export DISPLAY=":${DISPLAY_NUM}"

LOG_DIR="/tmp/desktop-logs"
mkdir -p "${LOG_DIR}"

# ---- 全局状态 ----

XVFB_PID="" ; MUTTER_PID="" ; TINT2_PID=""
VNC_PID=""  ; WEBSOCKIFY_PID="" ; BROWSER_PID=""
WM_NAME=""
VNC_PORT="${VNC_PORT:-5900}" ; NOVNC_PORT="${NOVNC_PORT:-6080}"
CDP_PORT="${CDP_PORT:-9222}"

# ===========================================================
# 函数定义
# ===========================================================

check_already_running() {
    [ -f /tmp/desktop-pids ] || return 1
    local _all_alive=true
    for _var in XVFB_PID MUTTER_PID TINT2_PID; do
        local _pid
        _pid=$(grep "^${_var}=" /tmp/desktop-pids 2>/dev/null | cut -d= -f2)
        [ -n "${_pid}" ] && kill -0 "${_pid}" 2>/dev/null || _all_alive=false
    done
    if [ "${_all_alive}" = "true" ]; then
        echo "[Desktop] 桌面已在运行中，跳过启动"
        return 0
    fi
    # 部分存活则清理
    bash "$(cd "$(dirname "$0")" && pwd)/stop_desktop.sh" 2>/dev/null || true
    return 1
}

start_xvfb() {
    echo "[Desktop] 启动 Xvfb :${DISPLAY_NUM} (${WIDTH}x${HEIGHT}x24)..."
    rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
    Xvfb ":${DISPLAY_NUM}" -screen 0 "${WIDTH}x${HEIGHT}x24" -ac -nolisten tcp \
        > "${LOG_DIR}/xvfb.log" 2>&1 &
    XVFB_PID=$!

    for i in $(seq 1 10); do
        xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1 && {
            echo "[Desktop] Xvfb 就绪 (${i}s)"; return
        }
        [ "$i" = "10" ] && { echo "[Desktop] ERROR: Xvfb 启动超时"; exit 1; }
        sleep 1
    done
}

start_dbus() {
    [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && return
    eval "$(dbus-launch --sh-syntax)"
    echo "[Desktop] D-Bus: ${DBUS_SESSION_BUS_ADDRESS}"
}

start_wm() {
    export LIBGL_ALWAYS_SOFTWARE=1 MESA_GL_VERSION_OVERRIDE=3.3 GALLIUM_DRIVER=llvmpipe
    for wm_cmd in "mutter --replace --sm-disable" "openbox"; do
        local wm_name="${wm_cmd%% *}"
        command -v "${wm_name}" >/dev/null 2>&1 || continue
        echo "[Desktop] 启动 ${wm_name}..."
        ${wm_cmd} > "${LOG_DIR}/${wm_name}.log" 2>&1 &
        MUTTER_PID=$!; sleep 2
        if kill -0 "${MUTTER_PID}" 2>/dev/null; then
            WM_NAME="${wm_name}"
            echo "[Desktop] ${wm_name} 启动成功 (PID=${MUTTER_PID})"; return
        fi
        echo "[Desktop] ⚠ ${wm_name} 启动失败"
    done
    MUTTER_PID=""; WM_NAME="none"
    echo "[Desktop] ⚠ 无可用窗口管理器，功能受限"
}

start_tint2() {
    tint2 > "${LOG_DIR}/tint2.log" 2>&1 &
    TINT2_PID=$!
}

start_vnc() {
    [ "${ENABLE_VNC:-true}" = "true" ] || return
    command -v x11vnc >/dev/null 2>&1 || { echo "[Desktop] ⚠ x11vnc 未安装"; return; }

    x11vnc -display ":${DISPLAY_NUM}" -forever -shared -nopw -rfbport "${VNC_PORT}" \
        -xkb -noxrecord -noxfixes -noxdamage > "${LOG_DIR}/x11vnc.log" 2>&1 &
    VNC_PID=$!; sleep 1
    kill -0 "${VNC_PID}" 2>/dev/null || { echo "[Desktop] ⚠ x11vnc 启动失败"; VNC_PID=""; return; }
    echo "[Desktop] x11vnc 就绪 (PID=${VNC_PID}, port=${VNC_PORT})"

    # 剪贴板同步
    command -v autocutsel >/dev/null 2>&1 && {
        autocutsel -s CLIPBOARD -fork > /dev/null 2>&1 || true
        autocutsel -s PRIMARY -fork > /dev/null 2>&1 || true
    }

    # websockify（有 noVNC 就托管 Web 界面，没有就纯代理）
    local _ws_cmd=""
    if python3 -m websockify --help >/dev/null 2>&1; then
        _ws_cmd="python3 -m websockify"
    elif command -v websockify >/dev/null 2>&1; then
        _ws_cmd="websockify"
    else
        echo "[Desktop] ⚠ websockify 未安装"; return
    fi
    local _ws_web=""
    if [ -d /usr/share/novnc ]; then
        _ws_web="--web /usr/share/novnc"
        # 确保自动跳转首页存在
        [ -f /usr/share/novnc/index.html ] || {
            local _asset="$(cd "$(dirname "$0")" && pwd)/assets/novnc-index.html"
            [ -f "${_asset}" ] && cp "${_asset}" /usr/share/novnc/index.html 2>/dev/null
        }
    fi
    ${_ws_cmd} ${_ws_web} "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
        > "${LOG_DIR}/websockify.log" 2>&1 &
    WEBSOCKIFY_PID=$!; sleep 1
    if kill -0 "${WEBSOCKIFY_PID}" 2>/dev/null; then
        echo "[Desktop] websockify 就绪 (PID=${WEBSOCKIFY_PID}, port=${NOVNC_PORT})"
    else
        echo "[Desktop] ⚠ websockify 启动失败"; WEBSOCKIFY_PID=""
    fi
}

start_atspi() {
    for _launcher in /usr/lib/at-spi2-core/at-spi-bus-launcher /usr/libexec/at-spi-bus-launcher; do
        [ -x "${_launcher}" ] || continue
        "${_launcher}" --launch-immediately > "${LOG_DIR}/at-spi.log" 2>&1 &
        echo "[Desktop] AT-SPI 无障碍服务已启动"; return
    done
}

_launch_browser() {
    "$1" \
        --no-first-run --no-default-browser-check \
        --disable-background-timer-throttling --disable-backgrounding-occluded-windows \
        --remote-debugging-port="${CDP_PORT}" --force-renderer-accessibility \
        --disable-gpu --no-sandbox --user-data-dir="$2" \
        --disable-blink-features=AutomationControlled \
        --disable-features=AutomationControlled,TranslateUI \
        --disable-ipc-flooding-protection --disable-popup-blocking \
        --disable-prompt-on-repost --disable-hang-monitor --disable-infobars \
        --disable-component-update --disable-default-apps --disable-extensions \
        --password-store=basic --use-mock-keychain \
        --window-size="${WIDTH},${HEIGHT}" \
        --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
        --lang=zh-CN "about:blank" \
        > "${LOG_DIR}/browser_cdp.log" 2>&1 &
    echo $!
}

start_browser() {
    [ "${AUTO_START_BROWSER:-true}" = "true" ] || return

    local browser_cmd=""
    for cmd in chromium chromium-browser google-chrome; do
        command -v "$cmd" >/dev/null 2>&1 && { browser_cmd="$cmd"; break; }
    done
    [ -n "${browser_cmd}" ] || { echo "[Desktop] ⚠ 未找到 chromium/chrome"; return; }

    local profile="/tmp/chromium-cdp-profile"; mkdir -p "${profile}"
    echo "[Desktop] 启动 ${browser_cmd} (CDP port=${CDP_PORT})..."
    BROWSER_PID=$(_launch_browser "${browser_cmd}" "${profile}")

    for _i in $(seq 1 15); do
        if ! kill -0 "${BROWSER_PID}" 2>/dev/null; then
            BROWSER_PID=$(_launch_browser "${browser_cmd}" "${profile}"); sleep 1; continue
        fi
        lsof -i ":${CDP_PORT}" -sTCP:LISTEN >/dev/null 2>&1 && {
            echo "[Desktop] 浏览器 CDP 就绪 (PID=${BROWSER_PID}, ${_i}s)"; return
        }
        sleep 1
    done
    echo "[Desktop] ⚠ CDP 端口 ${CDP_PORT} 未就绪（15s 超时）"
}

save_state() {
    rm -f /tmp/desktop-pids /tmp/desktop-env
    cat > /tmp/desktop-pids << EOF
XVFB_PID=${XVFB_PID}
MUTTER_PID=${MUTTER_PID:-}
TINT2_PID=${TINT2_PID}
VNC_PID=${VNC_PID}
WEBSOCKIFY_PID=${WEBSOCKIFY_PID}
BROWSER_PID=${BROWSER_PID:-}
WM_NAME=${WM_NAME}
DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}
CDP_PORT=${CDP_PORT}
VNC_PORT=${VNC_PORT}
NOVNC_PORT=${NOVNC_PORT}
EOF
    chmod 600 /tmp/desktop-pids

    cat > /tmp/desktop-env << EOF
export DISPLAY=:${DISPLAY_NUM}
export DISPLAY_NUM=${DISPLAY_NUM}
export WIDTH=${WIDTH}
export HEIGHT=${HEIGHT}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}
export WM_NAME=${WM_NAME}
export CDP_PORT=${CDP_PORT}
export VNC_PORT=${VNC_PORT}
export NOVNC_PORT=${NOVNC_PORT}
EOF
    chmod 600 /tmp/desktop-env
}

# ===========================================================
# 主流程
# ===========================================================

check_already_running && exit 0

start_xvfb
start_dbus
start_wm
start_tint2
start_vnc
start_atspi
start_browser
save_state

echo "[Desktop] ✓ 桌面就绪 | Display=:${DISPLAY_NUM} | ${WIDTH}x${HEIGHT} | WM=${WM_NAME} | CDP=:${CDP_PORT} | VNC=:${VNC_PORT} | noVNC=:${NOVNC_PORT}"
echo "[Desktop]   PIDs: xvfb=${XVFB_PID} wm(${WM_NAME})=${MUTTER_PID:-none} tint2=${TINT2_PID} vnc=${VNC_PID:-none} websockify=${WEBSOCKIFY_PID:-none} browser=${BROWSER_PID:-none}"
