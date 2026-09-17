#!/usr/bin/env bash
# WorkLoom IM 底座 · 一键启动（macOS / Linux）
# 步骤：环境自检 → 起 PG → 迁移 → 种子 → server+web 并行
# 用法：./scripts/start.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== WorkLoom IM 底座 · 启动 =="

# 0. 前置检查（缺依赖给出友好提示，不抛栈）
command -v node >/dev/null 2>&1 || { echo "❌ 未安装 node 24（brew install nvm && nvm install 24）"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ 未安装 pnpm（corepack enable && corepack prepare pnpm@10.14.0 --activate）"; exit 1; }
[ -f .env ] || { echo "→ 未发现 .env，已从 .env.example 复制"; cp .env.example .env; }

# 1. 起 PG（优先 docker compose；无 docker 则检测本机 5432）
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose up -d
  echo "→ 等待 PG 就绪…"
  for i in $(seq 1 30); do
    docker exec workloom-im-pg pg_isready -U postgres -d workloom >/dev/null 2>&1 && break
    sleep 1
  done
  echo "✅ PG17+pgvector 已就绪（docker）"
else
  echo "⚠️  docker 不可用，假定本机 PG 已运行（brew postgresql@17，端口 5432）"
fi

# 2. 依赖（幂等）
[ -d node_modules ] || pnpm install

# 3. 迁移 + 种子（均幂等）
pnpm db:migrate
pnpm db:seed

# 4. 起前后端（端口占用检测）
for P in 8787 5173; do
  if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$P" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "❌ 端口 $P 已被占用，请先 ./scripts/stop.sh 或释放端口"; exit 1
  fi
done

echo "== 启动 server(8787) + web(5173) =="
echo "   浏览器打开 http://localhost:5173 （P1 主甲板可见 tRPC 握手状态）"
exec pnpm dev
