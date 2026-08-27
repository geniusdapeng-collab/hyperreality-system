#!/bin/bash
# ============================================================
# preflight_check.sh - Computer Use 前置依赖检查与自动修复
#
# 每次执行 computer_tool.py 前必须运行此脚本，确保桌面环境就绪。
# 检查顺序：安装 → Xvfb → 窗口管理器 → x11vnc → websockify → 截图(含xdotool) → 浏览器/CDP
# 未运行的服务会自动启动；不可恢复的错误返回非 0。
#
# 返回码:
#   0 = 全部就绪
#   1 = 存在不可恢复的错误
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- 环境变量（与 start_desktop.sh 保持一致）----
export DISPLAY_NUM="${DISPLAY_NUM:-1}"
export DISPLAY=":${DISPLAY_NUM}"
export WIDTH="${WIDTH:-1280}"
export HEIGHT="${HEIGHT:-800}"

VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

LOG_DIR="/tmp/desktop-logs"
mkdir -p "${LOG_DIR}"

ERRORS=0

# ===========================================================
# 辅助函数
# ===========================================================

log_ok()   { echo "[Preflight] ✓ $1"; }
log_fail() { echo "[Preflight] ✗ $1"; }
log_info() { echo "[Preflight] → $1"; }

# ===========================================================
# 1. 检查并确保安装（首次运行）
# ===========================================================

ensure_installed() {
    if [ ! -f "${COMPUTER_USE_INSTALL_DIR:-/opt/computer-use}/VERSION" ]; then
        log_info "首次运行，执行安装..."
        if sudo bash "${SCRIPT_DIR}/install.sh" --force; then
            log_ok "安装完成"
        else
            log_fail "安装失败（不可恢复）"
            ERRORS=$((ERRORS + 1))
            return 1
        fi
    fi
    return 0
}

# ===========================================================
# 2. 检查 Xvfb（核心依赖，无 Xvfb 则启动整个桌面环境）
# ===========================================================

ensure_xvfb() {
    if xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then
        log_ok "Xvfb 显示服务正在运行"
        return 0
    fi

    log_info "Xvfb 未运行，启动完整桌面环境..."
    if bash "${SCRIPT_DIR}/start_desktop.sh"; then
        # start_desktop.sh 会启动所有服务，验证 Xvfb 是否就绪
        if xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then
            log_ok "桌面环境启动成功（含 Xvfb）"
            return 0
        fi
    fi

    log_fail "Xvfb 启动失败（不可恢复）"
    ERRORS=$((ERRORS + 1))
    return 1
}

# ===========================================================
# 3. 检查窗口管理器
# ===========================================================

ensure_wm() {
    for wm in mutter openbox; do
        if pgrep -x "${wm}" >/dev/null 2>&1; then
            log_ok "窗口管理器 (${wm}) 正在运行"
            return 0
        fi
    done

    # 窗口管理器不在运行，尝试启动 mutter 或 openbox
    log_info "窗口管理器未运行，尝试启动..."
    export LIBGL_ALWAYS_SOFTWARE=1 MESA_GL_VERSION_OVERRIDE=3.3 GALLIUM_DRIVER=llvmpipe
    for wm_cmd in "mutter --replace --sm-disable" "openbox"; do
        local wm_name="${wm_cmd%% *}"
        command -v "${wm_name}" >/dev/null 2>&1 || continue
        ${wm_cmd} > "${LOG_DIR}/${wm_name}.log" 2>&1 &
        sleep 2
        if pgrep -x "${wm_name}" >/dev/null 2>&1; then
            log_ok "窗口管理器 (${wm_name}) 已启动"
            return 0
        fi
    done

    # 窗口管理器是非核心组件，缺失时降级运行
    log_info "窗口管理器不可用（降级运行，不影响核心功能）"
    return 0
}

# ===========================================================
# 4. 检查 x11vnc
# ===========================================================

ensure_x11vnc() {
    [ "${ENABLE_VNC:-true}" = "true" ] || { log_info "VNC 已禁用 (ENABLE_VNC=false)，跳过 x11vnc"; return 0; }
    if pgrep -x x11vnc >/dev/null 2>&1; then
        log_ok "x11vnc 正在运行"
        return 0
    fi

    command -v x11vnc >/dev/null 2>&1 || {
        log_fail "x11vnc 未安装（不可恢复）"
        ERRORS=$((ERRORS + 1))
        return 1
    }

    log_info "x11vnc 未运行，启动中..."
    x11vnc -display ":${DISPLAY_NUM}" -forever -shared -nopw -rfbport "${VNC_PORT}" \
        -xkb -noxrecord -noxfixes -noxdamage > "${LOG_DIR}/x11vnc.log" 2>&1 &
    local vnc_pid=$!
    sleep 1

    if kill -0 "${vnc_pid}" 2>/dev/null; then
        log_ok "x11vnc 已启动 (PID=${vnc_pid}, port=${VNC_PORT})"
        # 启动剪贴板同步（可选）
        command -v autocutsel >/dev/null 2>&1 && {
            autocutsel -s CLIPBOARD -fork > /dev/null 2>&1 || true
            autocutsel -s PRIMARY -fork > /dev/null 2>&1 || true
        }
        return 0
    fi

    log_fail "x11vnc 启动失败（不可恢复）"
    ERRORS=$((ERRORS + 1))
    return 1
}

# ===========================================================
# 5. 检查 websockify
# ===========================================================

ensure_websockify() {
    [ "${ENABLE_VNC:-true}" = "true" ] || { log_info "VNC 已禁用 (ENABLE_VNC=false)，跳过 websockify"; return 0; }
    if pgrep -f "websockify" >/dev/null 2>&1; then
        log_ok "websockify 正在运行"
        return 0
    fi

    # 确定 websockify 命令
    local ws_cmd=""
    if python3 -m websockify --help >/dev/null 2>&1; then
        ws_cmd="python3 -m websockify"
    elif command -v websockify >/dev/null 2>&1; then
        ws_cmd="websockify"
    else
        log_fail "websockify 未安装（不可恢复）"
        ERRORS=$((ERRORS + 1))
        return 1
    fi

    log_info "websockify 未运行，启动中..."

    # 如果有 noVNC Web 资源，挂载 Web 目录
    local ws_web=""
    if [ -d /usr/share/novnc ]; then
        ws_web="--web /usr/share/novnc"
        # 确保自动跳转首页存在
        if [ ! -f /usr/share/novnc/index.html ]; then
            local asset="${SCRIPT_DIR}/assets/novnc-index.html"
            [ -f "${asset}" ] && cp "${asset}" /usr/share/novnc/index.html 2>/dev/null
        fi
    fi

    ${ws_cmd} ${ws_web} "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
        > "${LOG_DIR}/websockify.log" 2>&1 &
    local ws_pid=$!
    sleep 1

    if kill -0 "${ws_pid}" 2>/dev/null; then
        log_ok "websockify 已启动 (PID=${ws_pid}, port=${NOVNC_PORT})"
        return 0
    fi

    log_fail "websockify 启动失败（不可恢复）"
    ERRORS=$((ERRORS + 1))
    return 1
}

# ===========================================================
# 6. 检查截图功能（含 xdotool —— L3 核心依赖）
# ===========================================================

ensure_screenshot() {
    command -v xdotool >/dev/null 2>&1 || {
        log_fail "xdotool 未安装，L3 鼠标/键盘操控不可用（不可恢复）"
        ERRORS=$((ERRORS + 1))
        return 1
    }

    command -v scrot >/dev/null 2>&1 || {
        log_fail "scrot 未安装，截图不可用（不可恢复）"
        ERRORS=$((ERRORS + 1))
        return 1
    }

    local tmpfile="/tmp/.preflight_screenshot_test.png"
    rm -f "${tmpfile}"

    if DISPLAY=":${DISPLAY_NUM}" scrot "${tmpfile}" 2>/dev/null && [ -s "${tmpfile}" ]; then
        log_ok "截图功能正常"
        rm -f "${tmpfile}"
        return 0
    fi

    log_fail "截图功能异常（Xvfb 可能未正确运行）"
    rm -f "${tmpfile}"
    ERRORS=$((ERRORS + 1))
    return 1
}

# ===========================================================
# 7. 检查浏览器和 CDP 端口（WARNING 级别，非阻断）
# ===========================================================

ensure_browser() {
    # 尊重 AUTO_START_BROWSER 环境变量
    [ "${AUTO_START_BROWSER:-true}" = "true" ] || { log_info "浏览器自动启动已禁用 (AUTO_START_BROWSER=false)"; return 0; }

    local cdp_port="${CDP_PORT:-9222}"

    # 检查浏览器进程是否在运行
    local browser_running=false
    for proc in chromium chromium-browser google-chrome; do
        if pgrep -f "${proc}" >/dev/null 2>&1; then
            browser_running=true
            break
        fi
    done

    if [ "${browser_running}" = "false" ]; then
        log_info "⚠ 浏览器未运行（L1 Playwright CDP 不可用，降级到 L2/L3）"
        log_info "  提示: 运行 bash ${SCRIPT_DIR}/start_desktop.sh 可自动启动浏览器"
        return 0
    fi

    # 浏览器进程在，检查 CDP 端口是否监听
    if command -v curl >/dev/null 2>&1; then
        if curl -s --max-time 2 "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
            log_ok "浏览器 CDP 就绪 (port=${cdp_port})"
            return 0
        fi
    elif command -v lsof >/dev/null 2>&1; then
        if lsof -i ":${cdp_port}" -sTCP:LISTEN >/dev/null 2>&1; then
            log_ok "浏览器 CDP 端口监听中 (port=${cdp_port})"
            return 0
        fi
    fi

    log_info "⚠ 浏览器进程在运行但 CDP 端口 ${cdp_port} 未就绪（L1 降级到 L2/L3）"
    return 0
}

# ===========================================================
# 主流程
# ===========================================================

echo "[Preflight] === Computer Use 前置检查开始 ==="
echo ""

# 按依赖顺序逐项检查，核心依赖失败立即终止
ensure_installed || { echo "[Preflight] === 安装失败，终止 ==="; exit 1; }
ensure_xvfb     || { echo "[Preflight] === Xvfb 启动失败，终止 ==="; exit 1; }
ensure_wm
ensure_x11vnc
ensure_websockify
ensure_screenshot
ensure_browser

echo ""
if [ "${ERRORS}" -eq 0 ]; then
    echo "[Preflight] === 全部就绪 ✓ ==="
    exit 0
else
    echo "[Preflight] === ${ERRORS} 项不可恢复的错误 ✗ ==="
    echo "[Preflight] 建议: 运行 bash ${SCRIPT_DIR}/stop_desktop.sh 后重试"
    exit 1
fi
