#!/usr/bin/env bash
# ============================================================
# WorkLoom Electron 自包含载荷装配（desktop-production-release 流水线专用）
# 产出：dist-payload/{runtime,node,pg,nats}——由 electron-builder extraResources 打入安装包
#   runtime/  产品载荷（源码+迁移+种子+扁平 node_modules+web dist+VERSION）
#   node/     Node 24 官方二进制（按平台/架构）
#   pg/       PostgreSQL 17 + pgvector（bin/lib/share 两平台同构）
#   nats/     nats-server（JetStream 事件总线）
#
# 用法：
#   bash scripts/pack-electron-payload.sh --platform mac|win --arch arm64|x64 [--version vX.Y.Z]
# 前置：
#   - 已 pnpm install（web dist 不存在时本脚本自动 pnpm -C apps/web build）
#   - Windows：已跑 scripts/build-pgvector-win.ps1（产出 vendor/pg-win 与 vendor/pgvector-win）
#   - macOS：需在 macOS 上执行（Postgres.app 需 hdiutil 挂载）
# 下载源回退链：Node nodejs.org → npmmirror；PG(Postgres.app) GitHub Releases；nats GitHub Releases
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/release-assets.sh

PLATFORM=""
ARCH=""
VERSION="v0.0.0"
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "未知参数 $1"; exit 1 ;;
  esac
done
[ -n "$PLATFORM" ] && [ -n "$ARCH" ] || { echo "用法：--platform mac|win --arch arm64|x64"; exit 1; }
case "$PLATFORM-$ARCH" in
  mac-arm64) TARGET_OS="darwin"; TARGET_CPU="arm64" ;;
  mac-x64)   TARGET_OS="darwin"; TARGET_CPU="x64" ;;
  win-x64)   TARGET_OS="win32";  TARGET_CPU="x64" ;;
  *) echo "❌ 不支持的平台组合 $PLATFORM-$ARCH"; exit 1 ;;
esac

NODE_VER="24.19.0"
PGAPP_VER="2.9.6-17"
NATS_VER="v2.11.4"
OUT="dist-payload"
STAGE="$(mktemp -d /tmp/workloom-epayload.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

# 跨平台解引用拷贝：macOS 自带 BSD cp 无 -a（用 -pRL 跟随符号链接），GNU cp 用 -aL
# 必须 "$@" 透传——调用方有 glob 多文件展开（v2.1.1 实证 $1/$2 只拷首文件致 node.exe 丢失）
copy() {
  if cp --version 2>/dev/null | grep -q GNU; then cp -aL "$@"; else cp -pRL "$@"; fi
}

echo "== 装配 Electron 自包含载荷（${VERSION} · ${PLATFORM}-${ARCH}）=="
rm -rf "$OUT"
mkdir -p "$OUT"

# 产品边界只能来自受保护 product.manifest.json。platform-ops 属于仙女座，不能因
# 基座仓里物理残留该目录就进入 WorkLoom IM 或行业安装包。
PLATFORM_OPS_MODE="$(node scripts/payload-policy.mjs platform-ops-mode)"
PRODUCT_MANIFEST_PATH="$(node scripts/product-runtime.mjs --manifest-path)"
case "$PLATFORM_OPS_MODE" in
  include|exclude) ;;
  *) echo "❌ 无效的载荷边界策略：$PLATFORM_OPS_MODE"; exit 1 ;;
esac

# ---------- 1. 产品载荷 runtime/（与 pack-macos/pack-windows 同白名单口径） ----------
echo "→ 装配产品载荷…"
R="$OUT/runtime"
mkdir -p "$R/apps" "$R/scripts"
for f in package.json pnpm-workspace.yaml tsconfig.base.json .env.example; do
  [ -f "$f" ] && cp "$f" "$R/"
done
[ -f "$PRODUCT_MANIFEST_PATH" ] || { echo "❌ 缺受保护产品清单"; exit 1; }
cp "$PRODUCT_MANIFEST_PATH" "$R/product.manifest.json"
[ -f "$R/.env.defaults" ] || cp .env.example "$R/.env.defaults"
RUNTIME_SOURCE_DIRS=(
  apps/server apps/web/src apps/web/index.html apps/web/public apps/web/package.json
  apps/web/vite.config.ts apps/web/tsconfig.json packages bundles
)
[ "$PLATFORM_OPS_MODE" = "include" ] && RUNTIME_SOURCE_DIRS+=(platform-ops)
for d in "${RUNTIME_SOURCE_DIRS[@]}"; do
  [ -e "$d" ] || continue
  mkdir -p "$R/$(dirname "$d")"
  copy "$d" "$R/$(dirname "$d")/"
done
cp scripts/migrate.ts scripts/desktop-bootstrap-db.mjs scripts/product-runtime.mjs scripts/vite-product.mjs "$R/scripts/"
cp scripts/seed*.ts "$R/scripts/"  # 全部行业种子随包（seed/seed-aipm/seed-geo/seed-video/seed-consulting/seed-boost/seed-platform…按仓配置选用）
printf '%s\n' "$VERSION" > "$R/VERSION"
# 源码不携带 node_modules：运行期统一由下方 npm 扁平化安装的根 node_modules 提供（v2.0.8 实证）
find "$R/apps" "$R/packages" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true

# ---------- 2. web 构建产物 + 运行期依赖（npm 扁平化，无 symlink，electron-builder 友好） ----------
if [ ! -f apps/web/dist/index.html ]; then
  echo "→ 构建 web…"; pnpm -C apps/web build
fi
mkdir -p "$R/apps/web"
copy apps/web/dist "$R/apps/web/dist"
echo "→ 运行期依赖：npm 扁平化安装…"
NM_STAGE="$STAGE/nm-pkg"
NPM_REG="${NPM_REGISTRY:-https://registry.npmjs.org}"
node scripts/runtime-deps-lock.mjs stage "$NM_STAGE" --os "$TARGET_OS" --cpu "$TARGET_CPU" --registry "$NPM_REG"
copy "$NM_STAGE/node_modules" "$R/node_modules"
# 内部工作区包以实体目录入 node_modules（v2.0.14 @workloom 缺失实证）——
# 按各包 package.json 的 name 动态注册（行业仓有自定义包，如 @hyperreality/video-studio；
# 仓根级一方包 platform-ops 仅在仙女座精确身份下注册；目录存在本身不构成授权。
INTERNAL_PACKAGE_MANIFESTS=(packages/*/package.json)
[ "$PLATFORM_OPS_MODE" = "include" ] && INTERNAL_PACKAGE_MANIFESTS+=(platform-ops/package.json)
for pkgjson in "${INTERNAL_PACKAGE_MANIFESTS[@]}"; do
  [ -f "$pkgjson" ] || continue
  pname="$(node -p "try{require('./$pkgjson').name||''}catch(e){''}" 2>/dev/null)"
  [ -n "$pname" ] || continue
  pdir="$(dirname "$pkgjson")"
  mkdir -p "$R/node_modules/$(dirname "$pname")"
  copy "$pdir" "$R/node_modules/$pname"
done
find "$R/node_modules" -mindepth 2 -maxdepth 4 -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
# ⚠️ 必须 -mindepth 2：根目录本身也叫 node_modules，不带 mindepth 会整目录自毁
#（hyperreality/workloom v1.0.0 冒烟「tsx 缺失」实证）；maxdepth 4 覆盖 @scope/pkg/node_modules

# ---------- 3. Node 官方二进制（按平台/架构） ----------
echo "→ Node ${NODE_VER} ${PLATFORM}-${ARCH}…"
case "$PLATFORM-$ARCH" in
  mac-arm64) NODE_DIST="node-v${NODE_VER}-darwin-arm64.tar.gz" ;;
  mac-x64)   NODE_DIST="node-v${NODE_VER}-darwin-x64.tar.gz" ;;
  win-x64)   NODE_DIST="node-v${NODE_VER}-win-x64.zip" ;;
  *) echo "❌ 不支持的平台组合 $PLATFORM-$ARCH"; exit 1 ;;
esac
workloom_fetch_verified "$STAGE/$NODE_DIST" "$NODE_DIST" \
  "https://nodejs.org/dist/v${NODE_VER}/${NODE_DIST}" \
  "https://npmmirror.com/mirrors/node/v${NODE_VER}/${NODE_DIST}"
mkdir -p "$OUT/node" "$STAGE/node"
if [[ "$NODE_DIST" == *.zip ]]; then
  unzip -q "$STAGE/$NODE_DIST" -d "$STAGE/node"
  copy "$STAGE/node/node-v${NODE_VER}-win-x64/"* "$OUT/node/"
else
  tar xzf "$STAGE/$NODE_DIST" -C "$STAGE/node"
  NDIR="$(find "$STAGE/node" -maxdepth 1 -type d -name "node-v*" | head -1)"
  for sub in bin lib include share; do
    [ -d "$NDIR/$sub" ] && copy "$NDIR/$sub" "$OUT/node/"
  done
fi

# ---------- 4. PostgreSQL 17 + pgvector（bin/lib/share 同构摊平） ----------
echo "→ PostgreSQL + pgvector…"
mkdir -p "$OUT/pg"
if [ "$PLATFORM" = "mac" ]; then
  # Postgres.app 2.9.6-17 为 universal 二进制（arm64+x86_64 通吃）
  PGAPP_DIST="Postgres-${PGAPP_VER}.dmg"
  workloom_fetch_verified "$STAGE/pg.dmg" "$PGAPP_DIST" "https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/${PGAPP_DIST}"
  hdiutil attach -nobrowse -mountpoint "$STAGE/mnt" "$STAGE/pg.dmg" >/dev/null
  copy "$STAGE/mnt/Postgres.app/Contents/Versions/17/bin" "$OUT/pg/bin"
  copy "$STAGE/mnt/Postgres.app/Contents/Versions/17/lib" "$OUT/pg/lib"
  copy "$STAGE/mnt/Postgres.app/Contents/Versions/17/share" "$OUT/pg/share"
  hdiutil detach "$STAGE/mnt" >/dev/null
  [ -x "$OUT/pg/bin/postgres" ] || { echo "❌ PG 结构异常（postgres 缺失）"; exit 1; }
  ls "$OUT/pg/lib/postgresql/vector.dylib" >/dev/null || { echo "❌ pgvector 未随包"; exit 1; }
else
  # Windows：vendor/pg-win（与 pgvector 编译底座同源 EDB 全量树，82139ce 口径）+ CI 预编译 pgvector
  [ -f "vendor/pg-win/bin/postgres.exe" ] || { echo "❌ 缺 vendor/pg-win——先跑 scripts/build-pgvector-win.ps1"; exit 1; }
  node scripts/release-assets.mjs verify-windows-pg-provenance vendor/pg-win/WORKLOOM-PROVENANCE.txt
  copy vendor/pg-win/bin "$OUT/pg/bin"
  copy vendor/pg-win/lib "$OUT/pg/lib"
  copy vendor/pg-win/share "$OUT/pg/share"
  PV="vendor/pgvector-win"
  [ -f "$PV/lib/vector.dll" ] || { echo "❌ 缺 $PV/lib/vector.dll——先跑 scripts/build-pgvector-win.ps1"; exit 1; }
  node scripts/release-assets.mjs verify-windows-pg-provenance "$PV/WORKLOOM-PROVENANCE.txt"
  cp "$PV/lib/vector.dll" "$OUT/pg/lib/"
  cp "$PV"/share/extension/vector.control "$OUT/pg/share/extension/"
  cp "$PV"/share/extension/vector--*.sql "$OUT/pg/share/extension/"
  echo "✓ pgvector 合入（vector.dll + control + sql）"
fi

# ---------- 5. nats-server（JetStream；+20MB 开箱即持久化事件总线） ----------
echo "→ nats-server ${NATS_VER}…"
mkdir -p "$OUT/nats"
case "$PLATFORM-$ARCH" in
  mac-arm64) NATS_DIST="nats-server-${NATS_VER}-darwin-arm64.tar.gz" ;;
  mac-x64)   NATS_DIST="nats-server-${NATS_VER}-darwin-amd64.tar.gz" ;;
  win-x64)   NATS_DIST="nats-server-${NATS_VER}-windows-amd64.zip" ;;
esac
workloom_fetch_verified "$STAGE/$NATS_DIST" "$NATS_DIST" "https://github.com/nats-io/nats-server/releases/download/${NATS_VER}/${NATS_DIST}"
if [[ "$NATS_DIST" == *.zip ]]; then
  unzip -qo "$STAGE/$NATS_DIST" -d "$STAGE/nats-x"
  cp "$STAGE/nats-x/nats-server-${NATS_VER}-windows-amd64/nats-server.exe" "$OUT/nats/"
else
  mkdir -p "$STAGE/nats-x"
  tar xzf "$STAGE/$NATS_DIST" -C "$STAGE/nats-x"
  cp "$STAGE/nats-x/nats-server-${NATS_VER}-"*/nats-server "$OUT/nats/"
  chmod +x "$OUT/nats/nats-server"
fi

# ---------- 9. 载荷自检（v2.2.1 实证：NATS 段变量粘连致脚本中途异常但步骤未失败，
#      DMG 带着残缺载荷照出——装配脚本必须自证完整，防"静默半成品"） ----------
for f in runtime/node_modules/tsx/package.json runtime/node_modules/hono/package.json \
         runtime/scripts/migrate.ts runtime/scripts/product-runtime.mjs runtime/scripts/vite-product.mjs \
         runtime/product.manifest.json runtime/apps/web/vite.config.ts; do
  [ -f "$OUT/$f" ] || { echo "❌ 载荷自检失败：$f 缺失"; exit 1; }
done
# 种子脚本按仓各异（seed-aipm/seed-trading/seed-video…），存在其一即可
compgen -G "$OUT/runtime/scripts/seed*.ts" > /dev/null || { echo "❌ 载荷自检失败：runtime/scripts/seed*.ts 缺失"; exit 1; }
if [ "$PLATFORM" = "win" ]; then
  [ -f "$OUT/nats/nats-server.exe" ] || { echo "❌ 载荷自检失败：nats/nats-server.exe 缺失"; exit 1; }
  [ -f "$OUT/node/node.exe" ] || { echo "❌ 载荷自检失败：node/node.exe 缺失"; exit 1; }
else
  [ -f "$OUT/nats/nats-server" ] || { echo "❌ 载荷自检失败：nats/nats-server 缺失"; exit 1; }
  [ -f "$OUT/node/bin/node" ] || { echo "❌ 载荷自检失败：node/bin/node 缺失"; exit 1; }
  [ -f "$OUT/pg/bin/initdb" ] || { echo "❌ 载荷自检失败：pg/bin/initdb 缺失"; exit 1; }
fi
node scripts/payload-policy.mjs assert-runtime "$R"
echo "✓ 载荷自检通过"

# ---------- 10. 载荷压缩包（electron-builder extraResources 对 **/node_modules/** 有硬排除，
#      filter: ["**/*"] 无效——v2.2.0/v2.2.1 三轮实证；改单文件归档随包，
#      不受目录过滤规则影响，bootstrap 首启按需解压） ----------
echo "$VERSION" > "$OUT/PAYLOAD_VERSION"
rm -f dist-payload.tar.gz
tar -czf dist-payload.tar.gz -C "$OUT" .
[ -s dist-payload.tar.gz ] || { echo "❌ 载荷归档失败"; exit 1; }
tar -tzf dist-payload.tar.gz | node scripts/payload-policy.mjs assert-archive-list

SIZE=$(du -sh "$OUT" | cut -f1)
ASIZE=$(du -sh dist-payload.tar.gz | cut -f1)
echo "✅ 载荷就绪：${OUT}（${SIZE}）+ dist-payload.tar.gz（${ASIZE}）"
