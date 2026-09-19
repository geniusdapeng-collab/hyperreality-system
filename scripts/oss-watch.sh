#!/usr/bin/env bash
# oss-watch · 开源组件扫描与清单维护入口（只读依赖，不改锁文件）
#
# 用法：
#   bash scripts/oss-watch.sh             # 到期组件 + 过期缓存刷新（每周例行）
#   bash scripts/oss-watch.sh --all       # 忽略周期/TTL，全量刷新（安全事件时用）
#   bash scripts/oss-watch.sh --show      # 只看当前更新计划（不扫描）
#   bash scripts/oss-watch.sh --check     # 离线门禁：清单与仓库事实是否一致
#   bash scripts/oss-watch.sh --inventory # 只重新生成清单文档（不联网）
#   bash scripts/oss-watch.sh --offline   # 用现有缓存重算清单与计划（不联网）
#
# 退出码：0=全部最新 / 2=有可用更新（提醒，非错误） / 1=执行错误
set -uo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  --show)
    if [ -f docs/oss-update-plan.md ]; then cat docs/oss-update-plan.md; else echo "（尚无更新计划，先跑 pnpm oss:watch）"; fi
    exit 0
    ;;
  --check)
    node scripts/oss-inventory.mjs --check
    exit $?
    ;;
  --inventory)
    node scripts/oss-inventory.mjs --write
    exit $?
    ;;
  --json)
    node scripts/oss-inventory.mjs --json
    exit $?
    ;;
esac

export OSS_WATCH_ORIGIN="${OSS_WATCH_ORIGIN:-manual}"
node scripts/oss-watch.mjs "$@"
