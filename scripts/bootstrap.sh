#!/usr/bin/env bash
# WorkLoom · 一键安装（bootstrap）——克隆后一条命令装好系统全部能力
#
# 覆盖链路：环境检查 → .env 补全 → pnpm install → PG17+pgvector（docker compose，不存在则创建）
#           → 迁移 + 全部种子 → computer-use 桌面栈（可选）→ 汇总与下一步指引
#
# 用法：
#   bash scripts/bootstrap.sh                    # 标准安装（computer-use 按环境自动决策）
#   bash scripts/bootstrap.sh --with-computer    # 强制安装"操作电脑"桌面栈（需 Ubuntu/Debian + root/sudo）
#   bash scripts/bootstrap.sh --skip-computer    # 强制跳过桌面栈
#
# 幂等：可重复执行；已就位的步骤自动跳过。退出码 0=全绿或仅可选项跳过，1=存在阻断项。
set -u
cd "$(dirname "$0")/.."

WITH_COMPUTER=0; SKIP_COMPUTER=0
for a in "$@"; do
  case "$a" in
    --with-computer) WITH_COMPUTER=1 ;;
    --skip-computer) SKIP_COMPUTER=1 ;;
  esac
done

PASS=0; FAIL=0; SKIP=0
ok()   { printf "  ✅ %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  ❌ %s\n" "$1"; FAIL=$((FAIL+1)); }
skip() { printf "  ⏭️  %s\n" "$1"; SKIP=$((SKIP+1)); }
sec()  { printf "\n▸ %s\n" "$1"; }

echo "== WorkLoom · 一键安装（bootstrap）=="
echo "   仓库：$(basename "$(pwd)") · 时间：$(date '+%F %T')"

# ---------- 0. 环境检查 ----------
sec "0/6 环境检查"
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -ge 20 ]; then
  ok "node $(node -v)（≥20 可跑；仓库标称 ≥24，低于 24 仅警告）"
else
  bad "node 版本过低（$(node -v 2>/dev/null || echo 未安装)）→ 请安装 Node ≥ 20（推荐 24）"
fi
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
else
  bad "pnpm 未安装 → npm i -g pnpm@10 或见 https://pnpm.io/installation"
fi

# ---------- 1. .env 补全 ----------
sec "1/6 环境变量（.env）"
if [ -f .env ]; then
  ok ".env 已存在（跳过）"
elif [ -f .env.example ]; then
  cp .env.example .env && ok "已从 .env.example 复制生成 .env"
else
  bad ".env.example 缺失 → 请人工核对仓库完整性"
fi

# ---------- 2. 依赖安装 ----------
sec "2/6 依赖安装（pnpm install）"
if [ -d node_modules ]; then
  ok "node_modules 已存在（跳过；如需重装请先 rm -rf node_modules）"
else
  REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
  if pnpm install --registry="$REGISTRY" >/tmp/bootstrap-install.log 2>&1; then
    ok "pnpm install 完成（registry=$REGISTRY）"
  else
    bad "pnpm install 失败 → tail /tmp/bootstrap-install.log"
  fi
fi

# ---------- 3. 数据库（PG17 + pgvector） ----------
sec "3/6 数据库（PostgreSQL 17 + pgvector）"
PG_CONTAINER="workloom-im-pg"
if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONTAINER}$"; then
    ok "PG 容器运行中（跳过创建）"
  else
    echo "  … 创建并拉起 PG 容器（docker compose up -d postgres，首次需拉镜像）"
    docker compose up -d postgres >/tmp/bootstrap-pg.log 2>&1 || docker-compose up -d postgres >>/tmp/bootstrap-pg.log 2>&1 || true
  fi
  for i in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null)" = "healthy" ] && break
    sleep 2
  done
  ST=$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || echo "missing")
  if [ "$ST" = "healthy" ]; then
    ok "PG 容器 healthy"
  else
    bad "PG 容器状态=$ST → tail /tmp/bootstrap-pg.log；无 docker 环境可改用 bash scripts/devbox.sh"
  fi
else
  bad "无 docker → 两条路：①安装 docker 后重跑本脚本；②bash scripts/devbox.sh（用户态重建，无需 root/docker）"
fi

# ---------- 4. 迁移 + 种子 ----------
sec "4/6 数据库迁移与演示种子"
if pnpm db:migrate >/tmp/bootstrap-migrate.log 2>&1; then
  ok "db:migrate 迁移完成"
else
  bad "db:migrate 失败 → tail /tmp/bootstrap-migrate.log"
fi
for SEED in $(node -e "console.log(Object.keys(require('./package.json').scripts||{}).filter(s=>/^db:seed/.test(s)).join(' '))" 2>/dev/null); do
  if pnpm "$SEED" >>/tmp/bootstrap-seed.log 2>&1; then
    ok "pnpm $SEED 种子就位"
  else
    bad "pnpm $SEED 失败 → tail /tmp/bootstrap-seed.log"
  fi
done

# ---------- 5. computer-use 桌面栈（操作电脑能力） ----------
sec "5/6 computer-use 桌面栈（操作电脑能力，可选但强烈建议）"
TOOLKIT="packages/base/computer-use/toolkit"
INSTALL_MARKER="${COMPUTER_USE_INSTALL_DIR:-/opt/computer-use}/VERSION"
decide_computer() {
  [ "$SKIP_COMPUTER" = "1" ] && return 1
  [ "$WITH_COMPUTER" = "1" ] && return 0
  [ -n "${CI:-}" ] && return 1                       # CI 默认跳过
  command -v apt-get >/dev/null 2>&1 || return 1     # 非 Debian/Ubuntu 跳过
  [ -f "$INSTALL_MARKER" ] && return 0               # 已装过→走 preflight
  { [ "$(id -u)" = "0" ] || command -v sudo >/dev/null 2>&1; } && return 0
  return 1
}
if [ ! -d "$TOOLKIT" ]; then
  bad "仓内 toolkit 缺失（$TOOLKIT）→ 请确认仓库完整克隆"
elif decide_computer; then
  SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"
  if [ -f "$INSTALL_MARKER" ]; then
    ok "桌面栈已安装（跳过 install，直接预检）"
  else
    echo "  … 安装桌面栈（Xvfb/Chromium/AT-SPI/xdotool/OCR，约 1–3 分钟）"
    if $SUDO bash "$TOOLKIT/install.sh" --force >/tmp/bootstrap-computer.log 2>&1; then
      ok "桌面栈安装完成"
    else
      bad "桌面栈安装失败 → tail /tmp/bootstrap-computer.log（不影响应用本体，可稍后用 --with-computer 重装）"
    fi
  fi
  if pnpm computer:preflight >/tmp/bootstrap-preflight.log 2>&1; then
    ok "computer:preflight 通过（Xvfb · CDP:9222 · VNC:5900 · noVNC:6080）"
  else
    bad "computer:preflight 未过 → tail /tmp/bootstrap-preflight.log"
  fi
else
  skip "按环境决策跳过（非 Ubuntu/Debian、无 root/sudo、CI 或 --skip-computer）"
  echo "      说明：应用本体不受影响；完整「操作电脑」能力建议 Ubuntu 工作站一键安装——见 docs/computer-use-production.md"
fi

# ---------- 6. 汇总 ----------
sec "6/6 安装汇总"
echo "  PASS=$PASS · FAIL=$FAIL · SKIP=$SKIP"
if [ "$FAIL" = "0" ]; then
  cat <<'EOF'

  🎉 安装完成！下一步（照抄即可）：

    pnpm preview:all        # 一键拉起三端全貌（PC:3000 / B移动:3001 / C移动:3002，Mock 已固化）
    pnpm computer:smoke     # 操作电脑能力 12 项端到端自检（已装桌面栈时）
    pnpm agent:tour         # Agent 能力巡游（全量能力可执行自检）

  🤖 AI Coding Agent：请读 AGENTS.md 与 .ai-prompt
EOF
  exit 0
else
  echo "  → 存在阻断项，按上面 ❌ 的指引修复后重跑本脚本（幂等）"
  exit 1
fi
