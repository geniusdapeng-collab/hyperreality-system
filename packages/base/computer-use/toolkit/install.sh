#!/bin/bash
# ============================================================
# install.sh - Computer Use 一键安装脚本
# 适用于: Ubuntu 20.04 / 22.04 沙箱环境
# ============================================================

set -euo pipefail

# ===========================================================
# 配置与辅助函数
# ===========================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${COMPUTER_USE_INSTALL_DIR:-/opt/computer-use}"
LOG_DIR="/tmp/desktop-logs"
OUTPUT_DIR="/tmp/computer-use-outputs"

DISPLAY_NUM="${DISPLAY_NUM:-1}"
WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-800}"
INSTALL_VNC="${INSTALL_VNC:-true}"

FORCE_MODE=false
for arg in "$@"; do
    case "$arg" in --force|-y) FORCE_MODE=true ;; esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()  { echo -e "${BLUE}[STEP]${NC}  $*"; }

confirm_or_skip() {
    { [ "${FORCE_MODE}" = "true" ] || [ ! -t 0 ]; } && return 0
    read -r -p "$1 (y/N) " confirm
    [[ "$confirm" =~ ^[yY]$ ]]
}

# apt 安装（静默失败时打印警告）
_apt() { apt-get install -y --no-install-recommends "$@" 2>/dev/null || log_warn "安装失败: $*"; }

# ===========================================================
# 安装步骤
# ===========================================================

preflight_check() {
    [ "$(id -u)" -eq 0 ] || { log_error "请以 root 用户执行: sudo bash $0"; exit 1; }
    if [ -f "${INSTALL_DIR}/VERSION" ]; then
        log_warn "检测到已有安装 (${INSTALL_DIR}/VERSION)"
        confirm_or_skip "是否覆盖安装？" || { log_info "已取消"; exit 0; }
    fi
}

install_system_deps() {
    log_step "1/4 安装系统依赖..."
    export DEBIAN_FRONTEND=noninteractive DEBIAN_PRIORITY=high
    dpkg --configure -a 2>/dev/null || true
    rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock 2>/dev/null || true
    apt-get update -qq

    # 核心：虚拟显示 + 窗口管理 + 回退 WM
    _apt xvfb mutter tint2 openbox

    # Mesa 软件渲染
    apt-get install -y --no-install-recommends \
        libgl1-mesa-dri libgl1-mesa-glx libegl1-mesa mesa-utils 2>/dev/null || \
    apt-get install -y --no-install-recommends \
        libgl1-mesa-dri libegl1-mesa 2>/dev/null || \
        log_warn "Mesa 软件渲染库不完整"

    # 交互 + 录制 + X11 基础
    _apt xdotool scrot imagemagick ffmpeg
    _apt x11-apps x11-utils xterm dbus-x11 xauth
    _apt xclip xsel
    _apt tesseract-ocr tesseract-ocr-eng
    _apt pulseaudio pulseaudio-utils
    _apt x11-xserver-utils

    # 桌面应用
    _apt pcmanfm gedit galculator xpdf
    _apt libreoffice

    # Python3
    _apt python3 python3-pip

    log_info "系统依赖安装完成"
}

install_browser() {
    BROWSER_INSTALLED=""
    for pkg in chromium chromium-browser firefox-esr; do
        if apt-get install -y --no-install-recommends "${pkg}" 2>/dev/null; then
            BROWSER_INSTALLED="${pkg}"; log_info "浏览器已安装: ${pkg}"; return
        fi
    done
    log_warn "未能安装任何浏览器"; BROWSER_INSTALLED="none"
}

install_python_deps() {
    log_info "安装 Playwright..."
    pip3 install --no-cache-dir --break-system-packages playwright 2>/dev/null || log_warn "Playwright 安装失败"

    _apt python3-gi gir1.2-atspi-2.0 at-spi2-core libatk-adaptor
}

install_vnc() {
    [ "${INSTALL_VNC}" = "true" ] || { log_info "跳过 VNC 安装"; return; }
    log_info "安装 VNC 实时预览工具..."

    _apt x11vnc net-tools netcat-openbsd autocutsel

    # websockify（不装 apt 的 novnc，避免 v1.3.0 和自定义 index.html 不兼容）
    _apt python3-websockify || pip3 install --no-cache-dir --break-system-packages websockify 2>/dev/null || {
        log_error "websockify 安装失败，VNC Web 预览不可用"
    }

    # noVNC v1.5.0（自定义 index.html 依赖此版本的 core/rfb.js）
    local novnc_dir="/usr/share/novnc"
    _apt git
    # 清掉可能被 apt 装的 v1.3.0，确保用 v1.5.0
    if [ -d "${novnc_dir}" ] && ! grep -q "1\.5" "${novnc_dir}/package.json" 2>/dev/null; then
        rm -rf "${novnc_dir}"
    fi
    if [ ! -d "${novnc_dir}" ]; then
        git clone --depth 1 --branch v1.5.0 https://github.com/novnc/noVNC.git "${novnc_dir}" 2>/dev/null || {
            log_warn "noVNC v1.5.0 clone 失败，VNC 将以纯代理模式运行"
        }
    fi
    # 安装自定义首页（自动连接，无需点击 Connect）
    [ -d "${novnc_dir}" ] && cp "${SCRIPT_DIR}/assets/novnc-index.html" "${novnc_dir}/index.html"

    log_info "VNC 实时预览工具安装完成"
}

cleanup_apt() {
    apt-get clean; rm -rf /var/lib/apt/lists/*
}

create_directories() {
    log_step "2/4 创建目录结构..."
    mkdir -p "${INSTALL_DIR}" "${LOG_DIR}" "${OUTPUT_DIR}"
}

configure_browser() {
    log_step "3/4 配置浏览器..."
    [ "${BROWSER_INSTALLED}" = "firefox-esr" ] || { log_info "跳过 Firefox 配置"; return; }

    local profile_dir="${HOME}/.mozilla/firefox/sandbox.default"
    mkdir -p "${profile_dir}"

    cat > "${profile_dir}/user.js" << 'EOF'
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("browser.newtabpage.activity-stream.feeds.telemetry", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("signon.rememberSignons", false);
user_pref("browser.formfill.enable", false);
user_pref("geo.enabled", false);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.startup.page", 0);
EOF

    cat > "${HOME}/.mozilla/firefox/profiles.ini" << 'EOF'
[Profile0]
Name=sandbox
IsRelative=1
Path=sandbox.default
Default=1

[General]
StartWithLastProfile=1
EOF
    log_info "Firefox 配置完成"
}

write_version() {
    log_step "4/4 写入版本信息..."
    local version
    version=$(sed -n 's/^VERSION *=.*"\([^"]*\)".*/\1/p' "${SCRIPT_DIR}/modules/core.py" 2>/dev/null || echo "unknown")

    cat > "${INSTALL_DIR}/VERSION" << EOF
version=${version}
installed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
display_num=${DISPLAY_NUM}
resolution=${WIDTH}x${HEIGHT}
vnc_installed=${INSTALL_VNC}
browser=${BROWSER_INSTALLED}
features=window_mgmt,region_screenshot,clipboard,ocr,audio,resolution,hover,wm_fallback,playwright_cdp,accessibility_tree,libreoffice,vnc_preview
EOF
}

print_done() {
    echo ""
    echo -e "==========================================${NC}"
    echo -e "${GREEN} Computer Use 安装完成 ✓${NC}"
    echo "=========================================="
    echo ""
    echo "  安装路径: ${INSTALL_DIR}"
    echo "  分辨率:   ${WIDTH}x${HEIGHT}"
    echo "  Display:  :${DISPLAY_NUM}"
    echo ""
    echo "下一步："
    echo "  1. bash ${SCRIPT_DIR}/start_desktop.sh"
    echo "  2. bash ${SCRIPT_DIR}/health_check.sh"
    echo ""
}

# ===========================================================
# 主流程
# ===========================================================

preflight_check
install_system_deps
install_browser
install_python_deps
install_vnc
cleanup_apt
create_directories
configure_browser
write_version
print_done
