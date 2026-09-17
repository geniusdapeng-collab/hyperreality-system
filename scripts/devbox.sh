#!/bin/bash
# devbox.sh —— Linux 沙箱/无 Mac 环境一键重建开发环境（用户态，无需 root/docker）
# 用途：沙箱 /tmp 被回收后 ~3 分钟恢复「Node 24 + PG 17.11 + pgvector 0.8.6 + 依赖 + 迁移 + 种子」
# 用法：bash scripts/devbox.sh && bash scripts/devbox.sh serve   # serve=起 server+web
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"   # 先解析仓库根（下方 cd /tmp 后相对路径即失效，勿后移）
cd /tmp

# 1) Node 24（官方二进制）
if [ ! -x /tmp/node24/bin/node ]; then
  curl -sL -o node.tar.xz https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz
  mkdir -p node24 && tar xJf node.tar.xz -C node24 --strip-components=1
fi
export PATH=/tmp/node24/bin:$PATH

# 2) PG 17.11 + pgvector 0.8.6（PGDG deb 用户态解包；阿里云镜像加速）
mkdir -p debs pgroot
base="https://mirrors.aliyun.com/postgresql/repos/apt/pool/main/p"
[ -f debs/pg17.deb ]      || curl -sL "$base/postgresql-17/postgresql-17_17.11-1.pgdg12%2B2_amd64.deb" -o debs/pg17.deb
[ -f debs/pgclient.deb ]  || curl -sL "$base/postgresql-17/postgresql-client-17_17.11-1.pgdg12%2B2_amd64.deb" -o debs/pgclient.deb
[ -f debs/pgvector.deb ]  || curl -sL "$base/pgvector/postgresql-17-pgvector_0.8.6-1.pgdg12%2B1_amd64.deb" -o debs/pgvector.deb
[ -f debs/libpq5.deb ]    || curl -sL "https://mirrors.aliyun.com/postgresql/repos/apt/pool/main/p/postgresql-18/libpq5_18.6-1.pgdg12%2B2_amd64.deb" -o debs/libpq5.deb
for d in pg17 pgclient pgvector libpq5; do dpkg -x "debs/$d.deb" pgroot; done
export PATH=/tmp/pgroot/usr/lib/postgresql/17/bin:$PATH
export LD_LIBRARY_PATH=/tmp/pgroot/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH

# 3) 数据目录 + 启动 + 建库 + pgvector
[ -d /tmp/pgdata ] || initdb -D /tmp/pgdata -U postgres --auth=trust -E UTF8 --locale=C > /dev/null
pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o "-p 5432 -k /tmp" start || true
sleep 2
psql -h /tmp -p 5432 -U postgres -c "CREATE DATABASE workloom" 2>/dev/null || true
psql -h /tmp -p 5432 -U postgres -d workloom -c "CREATE EXTENSION IF NOT EXISTS vector"
psql -h /tmp -p 5432 -U postgres -d workloom -c "ALTER USER postgres PASSWORD 'workloom'"

# 4) pnpm + 依赖 + 迁移 + 种子
[ -x /tmp/npm-global/bin/pnpm ] || npm i -g pnpm@10.14.0 --prefix /tmp/npm-global > /dev/null
export PATH=/tmp/npm-global/bin:$PATH
cd "$REPO"
[ -f .env ] || cp .env.example .env
pnpm install --reporter=silent
pnpm db:migrate
pnpm db:seed

echo "✅ devbox 就绪：PG :5432 / workloom 库已迁移+种子"
if [ "$1" = "serve" ]; then
  (cd apps/server && nohup pnpm dev > /tmp/server.log 2>&1 &)
  (cd apps/web && nohup pnpm dev > /tmp/vite.log 2>&1 &)
  echo "✅ server :8787 / web :5173 已后台启动（日志 /tmp/server.log /tmp/vite.log）"
fi
