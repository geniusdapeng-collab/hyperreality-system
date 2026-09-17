#!/usr/bin/env bash
# WorkLoom IM 底座 · 停止（server/web 进程 + 可选停 PG）
# 用法：./scripts/stop.sh [--pg]（--pg 同时停掉 docker PG）
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== WorkLoom IM 底座 · 停止 =="

# 按端口优雅终止（避免误杀其他项目进程）
for P in 8787 5173; do
  if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -tiTCP:"$P" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null && echo "✅ 端口 $P 进程已停止"; fi
  fi
done

if [ "${1:-}" = "--pg" ]; then
  command -v docker >/dev/null 2>&1 && docker compose down && echo "✅ PG 容器已停止（数据卷保留）"
fi

echo "== 已停止 =="
