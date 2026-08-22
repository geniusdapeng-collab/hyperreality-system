#!/usr/bin/env bash
# WorkLoom IM 底座 · 数据重置（演示剧本前置：回到干净的云栖酒店数据集）
# 注意：biz_events 为 append-only（触发器禁 DELETE，L1.1），
#      因此重置 = 整库重建（drop schema）→ 迁移 → 种子，而非清表。
# 用法：./scripts/reset.sh [--yes]（--yes/-y 跳过交互确认，供 pnpm demo 等脚本调用）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== WorkLoom IM 底座 · 重置演示数据 =="
echo "⚠️  将删除本地 workloom 库全部数据（append-only 事件库只能整库重建）"
case "${1:-}" in --yes|-y) ;; *) [ -t 0 ] && { read -r -p "确认继续？[y/N] " a; [ "$a" = "y" ] || exit 0; } ;; esac

DB_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)
# docker 通道仅在容器真实存在时启用；否则回退本机 psql（D24 修复：有 docker 守护进程但无 workloom-im-pg 容器时不再误走 docker exec）
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
   && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'workloom-im-pg'; then
  docker exec workloom-im-pg psql postgres://postgres:workloom@localhost:5432/workloom -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
else
  psql "$DB_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
fi
echo "✅ schema 已重建"

pnpm db:migrate
pnpm db:seed
echo "== 重置完成：云栖酒店演示数据集（含「昨夜」夜班数据）已就绪 =="
