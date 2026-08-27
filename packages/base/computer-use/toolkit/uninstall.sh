#!/bin/bash
# ============================================================
# uninstall.sh - Computer Use 一键卸载脚本
# ============================================================

set -uo pipefail

INSTALL_DIR="${COMPUTER_USE_INSTALL_DIR:-/opt/computer-use}"

FORCE_MODE=false
for arg in "$@"; do
    case "$arg" in --force|-y) FORCE_MODE=true ;; esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }

confirm_or_skip() {
    { [ "${FORCE_MODE}" = "true" ] || [ ! -t 0 ]; } && return 0
    read -r -p "$1 (y/N) " confirm
    [[ "$confirm" =~ ^[yY]$ ]]
}

# ===========================================================
# 卸载步骤
# ===========================================================

preflight_check() {
    [ "$(id -u)" -eq 0 ] || { echo -e "${RED}[ERROR]${NC} 请以 root 用户执行: sudo bash $0"; exit 1; }

    echo "=========================================="
    echo " Computer Use 卸载程序"
    echo "=========================================="
    echo ""

    if [ ! -d "${INSTALL_DIR}" ]; then
        log_warn "未检测到安装目录 ${INSTALL_DIR}"
        confirm_or_skip "是否仍然继续清理？" || { echo "已取消"; exit 0; }
    else
        [ -f "${INSTALL_DIR}/VERSION" ] && { echo "当前安装信息:"; sed 's/^/  /' "${INSTALL_DIR}/VERSION"; echo ""; }
        confirm_or_skip "确定要完全卸载？" || { echo "已取消"; exit 0; }
    fi
}

stop_services() {
    log_step "1/5 停止运行中的桌面服务..."
    if [ -f /tmp/desktop-pids ]; then
        for pid_var in VNC_PID TINT2_PID MUTTER_PID XVFB_PID; do
            local pid
            pid=$(grep "^${pid_var}=" /tmp/desktop-pids 2>/dev/null | cut -d= -f2 | tr -cd '0-9')
            [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null && log_info "已停止 ${pid_var}=${pid}"
        done
    fi

    for proc in mutter tint2 x11vnc; do
        pkill -x "$proc" 2>/dev/null || true
    done
    pkill -f "websockify" 2>/dev/null || true
    pkill -f "Xvfb" 2>/dev/null || true
    sleep 1
    log_info "桌面服务已停止"
}

remove_install_dir() {
    log_step "2/5 移除安装目录..."
    [ -d "${INSTALL_DIR}" ] && rm -rf "${INSTALL_DIR}" && log_info "已移除 ${INSTALL_DIR}"
}

clean_temp_files() {
    log_step "3/5 清理临时文件和配置..."

    rm -f /tmp/desktop-pids /tmp/desktop-env
    rm -f /tmp/computer-use-vnc.pid /tmp/computer-use-websockify.pid
    rm -rf /tmp/desktop-logs /tmp/computer-use-outputs

    for i in $(seq 0 5); do
        rm -f "/tmp/.X${i}-lock" "/tmp/.X11-unix/X${i}" 2>/dev/null || true
    done

    # Firefox profile
    rm -rf "${HOME}/.mozilla/firefox/sandbox.default"
    if grep -q "sandbox.default" "${HOME}/.mozilla/firefox/profiles.ini" 2>/dev/null; then
        rm -f "${HOME}/.mozilla/firefox/profiles.ini"
        log_info "已移除 Firefox sandbox profile"
    fi

    [ -d /opt/noVNC ] && rm -rf /opt/noVNC && log_info "已移除 noVNC"
    log_info "清理完成"
}

remove_packages() {
    log_step "4/5 卸载系统包..."
    confirm_or_skip "确认卸载系统包？" || { log_warn "跳过系统包卸载"; return; }

    apt-get purge -y \
        xvfb mutter tint2 xdotool scrot imagemagick \
        x11-apps x11-utils xterm dbus-x11 xauth \
        firefox-esr pcmanfm gedit galculator xpdf \
        x11vnc 2>/dev/null || true

    apt-get autoremove -y 2>/dev/null || true
    apt-get clean 2>/dev/null || true
    rm -rf /var/lib/apt/lists/*
    log_info "系统包已卸载"
}

verify_uninstall() {
    log_step "5/5 验证卸载结果..."
    local remain=0
    for cmd in xvfb-run mutter tint2 xdotool scrot; do
        command -v "$cmd" >/dev/null 2>&1 && { log_warn "残留: ${cmd}"; ((remain++)); }
    done
    [ -d "${INSTALL_DIR}" ] && { log_warn "残留目录: ${INSTALL_DIR}"; ((remain++)); }

    echo ""
    echo "=========================================="
    if [ "${remain}" -eq 0 ]; then
        echo -e "${GREEN} Computer Use 已完全卸载 ✓${NC}"
    else
        echo -e "${YELLOW} 卸载完成，${remain} 项残留${NC}"
    fi
    echo "=========================================="
}

# ===========================================================
# 主流程
# ===========================================================

preflight_check
stop_services
remove_install_dir
clean_temp_files
remove_packages
verify_uninstall
