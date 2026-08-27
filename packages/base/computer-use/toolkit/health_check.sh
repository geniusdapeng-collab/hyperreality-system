#!/bin/bash
# ============================================================
# health_check.sh - Computer Use 桌面环境健康检查
# 返回: 0=全部通过, 1=有 CRITICAL 失败, 2=仅 WARNING
# ============================================================

DISPLAY_NUM="${DISPLAY_NUM:-1}"
CRITICAL_ERRORS=0
WARNINGS=0

# ===========================================================
# 检查辅助函数
# ===========================================================

check_critical() {
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then
        echo "  ✓ [CRITICAL] ${name}"
    else
        echo "  ✗ [CRITICAL] ${name}"
        ((CRITICAL_ERRORS++))
    fi
}

check_warning() {
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then
        echo "  ✓ [WARNING]  ${name}"
    else
        echo "  ⚠ [WARNING]  ${name} — 降级可用"
        ((WARNINGS++))
    fi
}

# ===========================================================
# 检查组
# ===========================================================

check_core() {
    echo "--- 核心组件 (CRITICAL) ---"
    check_critical "Xvfb 显示服务"   xdpyinfo -display ":${DISPLAY_NUM}"
    check_critical "xdotool 交互"    command -v xdotool
    check_critical "scrot 截图"      command -v scrot
    check_critical "Python3"         command -v python3

    local tmpfile="/tmp/.health_check_screenshot.png"
    if DISPLAY=":${DISPLAY_NUM}" scrot "${tmpfile}" 2>/dev/null && [ -s "${tmpfile}" ]; then
        echo "  ✓ [CRITICAL] 截图功能"
        rm -f "${tmpfile}"
    else
        echo "  ✗ [CRITICAL] 截图功能"
        ((CRITICAL_ERRORS++))
    fi
}

check_wm() {
    for wm in mutter openbox; do
        if pgrep -x "${wm}" >/dev/null 2>&1; then
            echo "  ✓ [WARNING]  窗口管理器 (${wm})"
            WM_RUNNING=true; return
        fi
    done
    echo "  ⚠ [WARNING]  窗口管理器 — 未运行"
    ((WARNINGS++))
}

check_tools() {
    check_warning "Tint2 任务栏"     pgrep -x tint2
    check_warning "ImageMagick"      command -v convert
    check_warning "ffmpeg 录制"      command -v ffmpeg
    check_warning "xclip 剪贴板"     command -v xclip
    check_warning "tesseract OCR"    command -v tesseract
    check_warning "xrandr 分辨率"    command -v xrandr
}

check_layer1() {
    if python3 -c "import playwright" 2>/dev/null; then
        echo "  ✓ [WARNING]  Playwright (Layer 1 浏览器操控)"
    else
        echo "  ⚠ [WARNING]  Playwright — 未安装"
        ((WARNINGS++))
    fi

    local cdp_port="${CDP_PORT:-9222}"
    if curl -s --max-time 2 "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
        echo "  ✓ [WARNING]  浏览器 CDP (port=${cdp_port})"
    else
        echo "  ⚠ [WARNING]  浏览器 CDP — 未连接 (port=${cdp_port})"
        ((WARNINGS++))
    fi
}

check_layer2() {
    if python3 -c "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi" 2>/dev/null; then
        echo "  ✓ [WARNING]  AT-SPI (Layer 2 语义感知)"
    else
        echo "  ⚠ [WARNING]  AT-SPI — 不可用"
        ((WARNINGS++))
    fi
}

check_vnc() {
    local vnc_port="${VNC_PORT:-5900}" novnc_port="${NOVNC_PORT:-6080}"
    check_warning "x11vnc 安装"    command -v x11vnc
    check_warning "x11vnc 服务"    pgrep -x x11vnc
    check_warning "websockify"     pgrep -f "websockify"
    if [ -d /usr/share/novnc ]; then
        echo "  ✓ [WARNING]  noVNC Web 客户端"
    else
        echo "  ⚠ [WARNING]  noVNC — 未安装（可选）"
        ((WARNINGS++))
    fi
}

print_summary() {
    echo ""
    if [ "${CRITICAL_ERRORS}" -eq 0 ] && [ "${WARNINGS}" -eq 0 ]; then
        echo "=== 全部检查通过 ✓ ==="
        echo "  Display: :${DISPLAY_NUM}"
        echo "  Resolution: $(xdpyinfo -display ":${DISPLAY_NUM}" 2>/dev/null | grep dimensions | awk '{print $2}')"
        exit 0
    elif [ "${CRITICAL_ERRORS}" -eq 0 ]; then
        echo "=== 核心功能正常，${WARNINGS} 项辅助组件降级 ⚠ ==="
        echo "  提示: 降级组件不影响截图、点击、键盘输入等核心操作"
        exit 2
    else
        echo "=== ${CRITICAL_ERRORS} 项核心检查失败 ✗ (${WARNINGS} 项警告) ==="
        echo "  建议: bash <skill-directory>/scripts/stop_desktop.sh && bash <skill-directory>/scripts/start_desktop.sh"
        exit 1
    fi
}

# ===========================================================
# 主流程
# ===========================================================

WM_RUNNING=false

echo "=== Computer Use 健康检查 ==="
echo ""
check_core
echo ""
echo "--- 辅助组件 (WARNING) ---"
check_wm
check_tools
check_layer1
check_layer2
check_vnc
print_summary
