#!/usr/bin/env bash
# WorkLoom · 三端全貌一键预览（preview:all）
#
#   PC 端 · B 端工作台        → http://localhost:3000
#   移动端 · B 端（高保真+手机壳）→ http://localhost:3001（docs/demo 导航页）
#   移动端 · C 端（AI 服务前台 H5）→ http://localhost:3002（小程序入口模拟）
#   数据/网关 server           → http://localhost:8787（tRPC /trpc/* · C 端 /c/*）
#
# Mock 模式强制启用：种子演示数据 + 离线确定性模型 + C 端演示直登，无需任何真实后端/密钥。
# 用法：pnpm preview:all（Ctrl+C 一键全部停止）
set -u
cd "$(dirname "$0")/.."

PC_PORT=3000; MB_PORT=3001; MC_PORT=3002; SERVER_PORT=8787
export SERVICE_C_DEMO_AUTH=true TOOL_UNVERIFIED_RATE=0
export WEB_PORT=$PC_PORT WEBC_PORT=$MC_PORT SERVER_PORT=$SERVER_PORT

say() { printf "\033[1;36m[preview:all]\033[0m %s\n" "$1"; }
PIDS=""
stop_port() { local P=$1 PID; PID=$(ss -tlnp 2>/dev/null | grep ":$P " | grep -oP 'pid=\K[0-9]+' | head -1 || true); [ -n "$PID" ] && kill "$PID" 2>/dev/null && say "已停掉 :$P 残留进程（PID=$PID）"; }
cleanup() { say "停止三端预览…"; for P in $PIDS; do kill "$P" 2>/dev/null; done; }
trap cleanup EXIT INT TERM

# ---------- 0. 清端口 ----------
for P in $PC_PORT $MB_PORT $MC_PORT $SERVER_PORT 5173 5176; do stop_port "$P"; done

# ---------- 1. 数据库 + 模拟数据固化（幂等） ----------
if command -v docker >/dev/null 2>&1; then
  docker start workloom-im-pg >/dev/null 2>&1 || true
  for i in $(seq 1 15); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' workloom-im-pg 2>/dev/null)" = "healthy" ] && break
    sleep 2
  done
  say "PostgreSQL：$(docker inspect -f '{{.State.Health.Status}}' workloom-im-pg 2>/dev/null || echo '未就绪') "
fi
say "应用数据库迁移…"
pnpm db:migrate >/tmp/preview-all-migrate.log 2>&1 || { echo "迁移失败 → /tmp/preview-all-migrate.log"; exit 1; }
for SEED in $(node -e "console.log(Object.keys(require('./package.json').scripts||{}).filter(s=>/^db:seed/.test(s)).join(' '))" 2>/dev/null); do
  say "注入模拟数据：pnpm $SEED"
  pnpm "$SEED" >>/tmp/preview-all-seed.log 2>&1 || { echo "种子失败 → /tmp/preview-all-seed.log"; exit 1; }
done

# ---------- 2. 起 server（Mock 模式） ----------
say "启动 server :$SERVER_PORT（Mock：离线确定性模型 + 演示直登）"
pnpm -C apps/server start >/tmp/preview-all-server.log 2>&1 &
PIDS="$PIDS $!"

# ---------- 3. 起三端 ----------
say "启动 PC 端 :$PC_PORT（apps/web）"
pnpm -C apps/web exec vite --port $PC_PORT --strictPort >/tmp/preview-all-pc.log 2>&1 &
PIDS="$PIDS $!"

say "启动 B 端移动 :$MB_PORT（docs/demo 高保真页 + 手机壳容器）"
# 生成演示页清单（index.html 存在时 http.server 不再给目录索引，自动发现依赖本清单）
node -e "
const fs=require('fs');
const files=fs.readdirSync('docs/demo').filter(f=>f.endsWith('.html')&&!['index.html','shell.html'].includes(f)).sort();
fs.writeFileSync('docs/demo/.manifest.json', JSON.stringify({files, generatedAt:new Date().toISOString()},null,1));
console.log('[preview:all] 演示页清单：'+files.length+' 页');
"
python3 -m http.server $MB_PORT --bind 127.0.0.1 -d docs/demo >/tmp/preview-all-mb.log 2>&1 &
PIDS="$PIDS $!"

say "启动 C 端 :$MC_PORT（apps/webc，小程序入口 H5 模拟）"
pnpm -C apps/webc exec vite --port $MC_PORT --strictPort >/tmp/preview-all-mc.log 2>&1 &
PIDS="$PIDS $!"

# ---------- 4. 等待就绪 ----------
for P in $SERVER_PORT $PC_PORT $MB_PORT $MC_PORT; do
  for i in $(seq 1 30); do
    curl -sf -o /dev/null "http://localhost:$P" 2>/dev/null && break
    [ "$P" = "$SERVER_PORT" ] && ss -tln 2>/dev/null | grep -q ":$P " && break
    sleep 1
  done
done

# ---------- 5. 横幅 ----------
echo
printf "\033[1;35m"
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║            WorkLoom · 三端全貌预览已就绪（Mock 数据模式）          ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  🖥  PC 端 · B 端工作台        http://localhost:3000               ║"
echo "║  📱 移动端 · B 端（手机壳）     http://localhost:3001               ║"
echo "║  📱 移动端 · C 端（服务前台）   http://localhost:3002               ║"
echo "║  ⚙️  server（tRPC + C 端网关）  http://localhost:8787               ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  Mock 数据已加载：种子演示数据集 + 离线确定性模型 + C 端演示直登     ║"
echo "║  当前预览端：PC(3000) / B移动(3001) / C移动(3002) —— Ctrl+C 停止   ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
printf "\033[0m"
echo "日志：/tmp/preview-all-{server,pc,mb,mc}.log"

wait
