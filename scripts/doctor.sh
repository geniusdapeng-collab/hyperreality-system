#!/usr/bin/env bash
# WorkLoom IM 底座 · 一屏环境自检（E2；对齐 dsh-TUI /doctor 清单 D13② + 本项目侧检查）
# 覆盖：Node 版本/架构 · 模型（LLM provider/Key 状态）· 工作目录 · 凭据状态 · 会话存储（PG 连通/迁移版本/RLS/种子完整性）
#      · node-pty 原生模块 · Xcode CLT（仅 macOS）· 端口占用
# 用法：bash scripts/doctor.sh    （退出码：0=无阻断项；1=存在 ❌ 阻断项）
set -u
cd "$(dirname "$0")/.."

FAIL=0
ok()   { printf "  ✅ %s\n" "$1"; }
warn() { printf "  ⚠️  %s\n" "$1"; }
bad()  { printf "  ❌ %s\n" "$1"; FAIL=1; }
sec()  { printf "\n▸ %s\n" "$1"; }

echo "== WorkLoom IM 底座 · doctor 一屏自检 =="

# ---------- 运行时（dsh-TUI /doctor：Node 版本与架构） ----------
sec "运行时"
if command -v node >/dev/null 2>&1; then
  NV=$(node -v | sed 's/v//'); MAJOR=${NV%%.*}; ARCH=$(node -p "process.arch" 2>/dev/null || echo "?")
  if [ "$MAJOR" -ge 24 ]; then ok "node v$NV · ${ARCH}（≥24 LTS）"; else bad "node v$NV 低于 24 LTS → nvm install 24"; fi
else
  bad "未安装 node → brew install nvm && nvm install 24"
fi
if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm -v)"; else bad "未安装 pnpm → corepack enable && corepack prepare pnpm@10.14.0 --activate"; fi
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || bad "未安装 git"
UNAME=$(uname -s)
if [ "$UNAME" = "Darwin" ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode CLT 已安装（node-pty 原生构建前置）"; else warn "Xcode CLT 缺失 → xcode-select --install（node-pty 构建需要）"; fi
fi

# ---------- 工作目录（dsh-TUI /doctor：工作目录状态） ----------
sec "工作目录"
ok "仓库根：$(pwd)"
[ -f .env ] && ok ".env 在位" || warn ".env 缺失 → cp .env.example .env（start.sh 会自动补）"
[ -d node_modules ] && ok "依赖已安装（node_modules 在位）" || warn "依赖未安装 → pnpm install"
[ -d vendor/dsh ] && ok "vendor/dsh 锁版 fork 在位（rc.6 只读基线，D12）" || bad "vendor/dsh 缺失（仓库不完整，重新克隆）"

# ---------- 模型（dsh-TUI /doctor：模型配置；D4 口径 mock 离线可跑） ----------
sec "模型（LLM）"
if [ -f .env ]; then
  LLM_PROVIDER=$(grep -E '^LLM_PROVIDER=' .env | cut -d= -f2- || true)
  LLM_API_KEY=$(grep -E '^LLM_API_KEY=' .env | cut -d= -f2- || true)
  LLM_PROVIDER=${LLM_PROVIDER:-mock}
  if [ "$LLM_PROVIDER" = "mock" ]; then
    ok "LLM_PROVIDER=mock（确定性 Mock，无 Key 全流程可跑，D4）"
  elif [ -n "$LLM_API_KEY" ]; then
    ok "LLM_PROVIDER=$LLM_PROVIDER · Key 已配置（尾号 …${LLM_API_KEY: -4}）"
  else
    warn "LLM_PROVIDER=$LLM_PROVIDER 但 LLM_API_KEY 为空 → 将回退 mock 或调用失败"
  fi
else
  warn "无 .env，LLM 默认 mock"
fi

# ---------- 凭据状态（dsh-TUI /doctor：凭据；L7.3 凭据引用不出提示词） ----------
sec "凭据状态"
if [ -f .env ]; then
  JWT=$(grep -E '^JWT_SECRET=' .env | cut -d= -f2- || true)
  if [ "$JWT" = "workloom-dev-secret-change-me" ]; then warn "JWT_SECRET 为演示默认值（生产必须更换）"; else ok "JWT_SECRET 已自定义"; fi
  IM=$(grep -E '^IM_DRIVER=' .env | cut -d= -f2- || true)
  ok "IM_DRIVER=${IM:-mock}（真实通道凭据在 dsh 设置页自配，D14）"
fi

# ---------- 会话存储 / 数据层（dsh-TUI /doctor：会话存储；本项目侧 PG 检查） ----------
sec "会话存储（PostgreSQL 17 + pgvector）"
DB_URL=$(grep -E '^DATABASE_URL=' .env 2>/dev/null | cut -d= -f2- || true)
DB_URL=${DB_URL:-postgres://postgres:workloom@localhost:5432/workloom}
PSQL=""
if command -v psql >/dev/null 2>&1; then PSQL="psql"; elif [ -x /tmp/pgroot/usr/lib/postgresql/17/bin/psql ]; then PSQL="/tmp/pgroot/usr/lib/postgresql/17/bin/psql"; fi
if [ -z "$PSQL" ]; then
  warn "psql 不在 PATH（brew postgresql@17 或 docker compose up -d 后容器内可查）——数据层检查跳过"
else
  if "$PSQL" "$DB_URL" -tAc "SELECT 1" >/dev/null 2>&1; then
    ok "PG 连通（${DB_URL}）"
    PGV=$("$PSQL" "$DB_URL" -tAc "SHOW server_version" 2>/dev/null || echo "?")
    case "$PGV" in 17*) ok "PG 版本 $PGV";; *) warn "PG 版本 ${PGV}（总纲 pin 17）";; esac
    VEC=$("$PSQL" "$DB_URL" -tAc "SELECT count(*) FROM pg_extension WHERE extname='vector'" 2>/dev/null || echo 0)
    [ "$VEC" = "1" ] && ok "pgvector 扩展在位" || bad "pgvector 缺失 → CREATE EXTENSION vector（D3）"
    # 迁移版本（D9 手写 SQL 账本）
    MIG=$("$PSQL" "$DB_URL" -tAc "SELECT count(*) FROM _migrations" 2>/dev/null || echo "-")
    if [ "$MIG" = "-" ]; then warn "未迁移（_migrations 账本不存在）→ pnpm db:migrate"; else ok "迁移已应用 $MIG 个（最新：$("$PSQL" "$DB_URL" -tAc "SELECT name FROM _migrations ORDER BY name DESC LIMIT 1" 2>/dev/null)）"; fi
    # 种子完整性（H-1 口径抽查：五元字段完整率 + 组织模型计数）
    if [ "$MIG" != "-" ]; then
      CNT=$("$PSQL" "$DB_URL" -tAc "SELECT count(*) FROM biz_events" 2>/dev/null || echo 0)
      if [ "$CNT" = "0" ]; then
        warn "事件库为空 → pnpm db:seed（或 pnpm demo 一键重置）"
      else
        FULL=$("$PSQL" "$DB_URL" -tAc "SELECT round(100.0*count(*) FILTER (WHERE payload ? 'who' AND payload ? 'context' AND payload ? 'object' AND payload ? 'decision' AND payload ? 'rule_impact')/count(*),1) FROM biz_events" 2>/dev/null || echo "?")
        [ "$FULL" = "100.0" ] && ok "种子完整性：biz_events $CNT 条 · 五元完整率 $FULL%（H-1）" || bad "五元完整率 $FULL% < 100%（H-1 不达标）→ ./scripts/reset.sh --yes 重建"
        ORG=$("$PSQL" "$DB_URL" -tAc "SELECT (SELECT count(*) FROM members) || '/' || (SELECT count(*) FROM agents WHERE status='ready' OR status IS NOT NULL) || '/' || (SELECT count(*) FROM fence_rules WHERE status='active')" 2>/dev/null || echo "?")
        ok "组织模型：成员/Agent/生效围栏 = $ORG"
      fi
      # RLS 双保险实测（L7.1：不设/错设 workspace 上下文 → 0 行）
      APP_URL=$(grep -E '^DATABASE_APP_URL=' .env 2>/dev/null | cut -d= -f2- || true)
      APP_URL=${APP_URL:-postgres://workloom_app:workloom_dev_app@localhost:5432/workloom}
      R0=$("$PSQL" "$APP_URL" -tAc "SELECT count(*) FROM biz_events" 2>/dev/null || echo "-")
      if [ "$R0" = "0" ]; then ok "RLS：未设 workspace 上下文查询返回 0 行（L7.1）"; elif [ "$R0" = "-" ]; then warn "RLS 实测跳过（app 角色连接失败）"; else bad "RLS 失效？未设上下文竟返回 $R0 行"; fi
      GWR=$("$PSQL" "$APP_URL" -tAc "INSERT INTO biz_events(tenant_id,workspace_id,event_id,payload,prev_hash,hash) VALUES('t','w','doctor-probe','{}','','')" 2>&1 || true)
      echo "$GWR" | grep -qi "permission denied" && ok "旁路直写防控：app 角色 INSERT biz_events 被拒（F1.2）" || warn "旁路直写防控未能验证（${GWR}）"
    fi
  else
    bad "PG 不可连通 → docker compose up -d（或 brew services start postgresql@17；沙箱 bash scripts/devbox.sh）"
  fi
fi
if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 && ok "docker 守护进程运行中（compose 可起 PG）" || warn "docker 已安装但守护进程未启动（打开 Docker Desktop / OrbStack）"
else
  [ -z "$PSQL" ] && warn "docker 与 psql 均不可用——数据层无着落" || ok "docker 不可用但本机 PG 可用（备选路径成立）"
fi

# ---------- 原生模块（dsh 地基依赖） ----------
sec "原生模块"
PTY=$(find node_modules/.pnpm -maxdepth 6 -name "pty.node" 2>/dev/null | head -1)
if [ -n "$PTY" ]; then ok "node-pty 已构建（${PTY}）"; else warn "node-pty 未构建（dsh web/headless 需要）→ pnpm rebuild node-pty"; fi

# ---------- 端口占用 ----------
sec "端口"
if command -v lsof >/dev/null 2>&1; then
  for P in 5432 8787 5173; do
    if lsof -iTCP:"$P" -sTCP:LISTEN >/dev/null 2>&1; then warn "端口 $P 占用中（$([ "$P" = "5432" ] && echo "应为 PG" || echo "start.sh 前请先 stop.sh 或确认占用方")）"; else ok "端口 $P 空闲"; fi
  done
else
  warn "lsof 不可用，端口检查跳过"
fi

# ---------- 汇总 ----------
echo
if [ "$FAIL" = "0" ]; then
  echo "== 自检完成：无阻断项（⚠️ 为建议项，不影响启动）=="
else
  echo "== 自检完成：存在 ❌ 阻断项，按上方提示修复后重跑 =="
fi
exit "$FAIL"
