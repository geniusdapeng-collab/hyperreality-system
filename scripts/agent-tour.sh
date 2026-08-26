#!/usr/bin/env bash
# WorkLoom · Agent 能力巡游（agent-tour）
# 用途：第三方 AI Coding Agent 一键自检本仓库全部内置能力。
#       本脚本即 docs/capability-map.md 的可执行版——按清单逐项执行并打印 PASS/FAIL。
# 用法：
#   bash scripts/agent-tour.sh                # 环境层+数据层+服务层+浏览器层（约 1~3 分钟）
#   bash scripts/agent-tour.sh --full         # 追加验证层（suite*/release:gate，耗时较长）
#   bash scripts/agent-tour.sh --skip-desktop # 跳过桌面/浏览器层（无图形环境时）
# 退出码：0 = 全部 PASS；1 = 存在 FAIL
set -u
cd "$(dirname "$0")/.."

FULL=0; SKIP_DESKTOP=0
for a in "$@"; do
  case "$a" in
    --full) FULL=1 ;;
    --skip-desktop) SKIP_DESKTOP=1 ;;
  esac
done

CU_DIR="${COMPUTER_USE_DIR:-/root/.codebuddy/skills/computer-use}"
CU="$CU_DIR/scripts/computer_tool.py"
PASS=0; FAIL=0; SKIPPED=0
ok()   { printf "  ✅ %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  ❌ %s\n" "$1"; FAIL=$((FAIL+1)); }
skip() { printf "  ⏭️  %s\n" "$1"; SKIPPED=$((SKIPPED+1)); }
sec()  { printf "\n▸ %s\n" "$1"; }
has_script() { node -e "process.exit((require('./package.json').scripts||{})['$1']?0:1)" 2>/dev/null; }

echo "== WorkLoom · Agent 能力巡游 =="
echo "   仓库：$(basename "$(pwd)") · 时间：$(date '+%F %T')"

# ---------- L0 环境层：computer-use（操作电脑/浏览器） ----------
sec "L0 环境层 · computer-use 电脑/浏览器操作能力"
if [ "$SKIP_DESKTOP" = "1" ]; then
  skip "按 --skip-desktop 跳过桌面层"
elif [ ! -f "$CU_DIR/scripts/preflight_check.sh" ]; then
  bad "computer-use 技能缺失（$CU_DIR）→ 无法操作浏览器；请确认沙箱技能已安装"
else
  if bash "$CU_DIR/scripts/preflight_check.sh" >/tmp/agent-tour-preflight.log 2>&1; then
    ok "preflight 通过（Xvfb:1 · CDP:9222 · VNC:5900 · noVNC:6080）"
    CONN=$(python3 "$CU" '{"action": "browser_connect"}' 2>/dev/null || true)
    if echo "$CONN" | grep -q '"status": "connected"'; then
      ok "browser_connect 成功（CDP 已接管浏览器）"
    else
      bad "browser_connect 失败 → $CONN"
    fi
  else
    bad "preflight 失败 → 详见 /tmp/agent-tour-preflight.log"
  fi
fi

# ---------- L1 数据层：PostgreSQL ----------
sec "L1 数据层 · PostgreSQL（PG17 + pgvector）"
if command -v docker >/dev/null 2>&1; then
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^workloom-im-pg$'; then
    docker start workloom-im-pg >/dev/null 2>&1 || true
  fi
  ST=$(docker inspect -f '{{.State.Health.Status}}' workloom-im-pg 2>/dev/null || echo "missing")
  if [ "$ST" = "healthy" ]; then
    ok "workloom-im-pg 容器 healthy"
  else
    bad "PG 容器状态=$ST → docker start workloom-im-pg 或见 docker-compose.yml"
  fi
else
  skip "无 docker（非沙箱环境），请自行确认 DATABASE_URL 可达"
fi

# ---------- L2 服务层：server:8787 + web:5173 ----------
sec "L2 服务层 · pnpm dev（server:8787 / web:5173）"
WEB_PORT="${WEB_PORT:-5173}"
if [ ! -d node_modules ]; then
  bad "依赖未安装 → pnpm install（沙箱内 npm 源用 registry.npmmirror.com）"
else
  if ! curl -sf -o /dev/null "http://localhost:${WEB_PORT}" 2>/dev/null; then
    echo "  … web:${WEB_PORT} 未就绪，后台拉起 pnpm dev（日志 /tmp/agent-tour-dev.log）"
    nohup pnpm dev >/tmp/agent-tour-dev.log 2>&1 &
    for i in $(seq 1 30); do
      curl -sf -o /dev/null "http://localhost:${WEB_PORT}" 2>/dev/null && break
      sleep 2
    done
  fi
  if curl -sf -o /dev/null "http://localhost:${WEB_PORT}" 2>/dev/null; then
    ok "web:${WEB_PORT} 返回 200"
  else
    bad "web:${WEB_PORT} 未就绪 → tail /tmp/agent-tour-dev.log"
  fi
  # server 通常在 web 之后数秒就绪（tsx 启动较慢），等待而非立即判负
  for i in $(seq 1 15); do
    ss -tln 2>/dev/null | grep -q ':8787 ' && break
    sleep 2
  done
  if ss -tln 2>/dev/null | grep -q ':8787 '; then
    ok "server:8787 监听中（tRPC /trpc/*；无 /healthz，属正常）"
  else
    bad "server:8787 未监听 → tail /tmp/agent-tour-dev.log"
  fi
fi

# ---------- L3 浏览器层：自动打开并验证运行中的系统 ----------
sec "L3 浏览器层 · 自动操作运行中的 WorkLoom"
if [ "$SKIP_DESKTOP" = "1" ] || [ ! -f "$CU" ]; then
  skip "跳过浏览器层"
elif ! curl -sf -o /dev/null "http://localhost:${WEB_PORT}" 2>/dev/null; then
  skip "web 未就绪，跳过浏览器层"
else
  GOTO=$(python3 "$CU" "{\"action\": \"browser_goto\", \"url\": \"http://localhost:${WEB_PORT}\"}" 2>/dev/null || true)
  if echo "$GOTO" | grep -q '"status": 200'; then
    ok "browser_goto http://localhost:${WEB_PORT} → 200"
    sleep 2
    SNAP=$(python3 "$CU" '{"action": "browser_snapshot"}' 2>/dev/null || true)
    if [ "${#SNAP}" -gt 500 ]; then
      ok "browser_snapshot 读到页面结构（${#SNAP} 字符，零 token 感知）"
    else
      bad "browser_snapshot 内容异常（${#SNAP} 字符）→ 页面可能未渲染"
    fi
    SHOT=/tmp/agent-tour-$(date +%H%M%S).png
    python3 "$CU" '{"action": "screenshot"}' 2>/dev/null | \
      node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);require('fs').writeFileSync('$SHOT',Buffer.from(j.base64_image,'base64'));console.log('ok')}catch(e){console.log('fail')}})" | grep -q ok \
      && ok "screenshot 取证成功 → $SHOT" || bad "screenshot 失败"
  else
    bad "browser_goto 失败 → $GOTO"
  fi
fi

# ---------- L4 验证层（--full） ----------
if [ "$FULL" = "1" ]; then
  sec "L4 验证层 · 测试套件与发布门禁"
  # 纪律：跑套件前必须停掉 dev 服务——残留 8787/5173 会致 E2E 打错库，
  # 且 dev 侧夜班/扩编等后台节拍会产生提案/事件，污染套件断言（实测 R-26 误报）。
  for P in 8787 "$WEB_PORT"; do
    PID=$(ss -tlnp 2>/dev/null | grep ":$P " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    [ -n "$PID" ] && kill "$PID" 2>/dev/null && echo "  … 已停掉 :$P 残留服务（PID=$PID），避免污染套件"
  done
  sleep 1
  # 各域套件依赖对应种子就位（suite:geo 需要 GEO 工作区、release:gate 需要 video 域 preset 等），
  # 依次执行仓库内所有 db:seed* 脚本（幂等），再进套件。
  for SEED in $(node -e "console.log(Object.keys(require('./package.json').scripts||{}).filter(s=>/^db:seed/.test(s)).join(' '))" 2>/dev/null); do
    if pnpm "$SEED" >/tmp/agent-tour-seed.log 2>&1; then
      ok "pnpm $SEED 种子就位"
    else
      bad "pnpm $SEED 失败 → tail /tmp/agent-tour-seed.log"
    fi
  done
  for S in suite suite:geo suite:hotel; do
    if has_script "$S"; then
      if pnpm "$S" >/tmp/agent-tour-$S.log 2>&1; then
        ok "pnpm $S 全绿（日志 /tmp/agent-tour-$S.log）"
      else
        bad "pnpm $S 未过 → tail /tmp/agent-tour-$S.log（若库被 dev 运行态污染：重建库 → pnpm db:migrate && pnpm db:seed 后重跑）"
      fi
    fi
  done
  if has_script "release:gate"; then
    if pnpm release:gate >/tmp/agent-tour-gate.log 2>&1; then
      ok "pnpm release:gate 发布门禁全过"
    else
      bad "release:gate 未全过（禁止发布）→ tail /tmp/agent-tour-gate.log"
    fi
  fi
  if has_script "db:verify-chain"; then
    pnpm db:verify-chain >/tmp/agent-tour-chain.log 2>&1 \
      && ok "db:verify-chain 五元事件验链通过" || bad "验链失败 → tail /tmp/agent-tour-chain.log"
  fi
else
  sec "L4 验证层"
  skip "未加 --full，跳过 suite/release:gate（发布前必须跑全量）"
fi

# ---------- 汇总 ----------
sec "巡游结果"
echo "  PASS=$PASS · FAIL=$FAIL · SKIP=$SKIPPED"
echo "  能力地图详见 docs/capability-map.md；浏览器操作详见 docs/agent-computer-guide.md"
[ "$FAIL" = "0" ] && echo "  → 全部能力可用，Agent 可正式开工" || echo "  → 存在 FAIL 项，先修复再继续"
exit "$([ "$FAIL" = "0" ] && echo 0 || echo 1)"
