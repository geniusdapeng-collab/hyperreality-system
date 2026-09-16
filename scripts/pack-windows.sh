#!/usr/bin/env bash
# ============================================================
# WorkLoom Windows 发行包装配（W2 / D16 Windows 版，与 pack-macos.sh 同口径）
# 产出：dist/WorkLoom-Windows.zip + .sha256
#   WorkLoom/
#     runtime/  产品载荷（源码+迁移+种子+node_modules+web dist+VERSION）
#     node/     Node 24 win-x64 官方二进制
#     pg/       PostgreSQL 17 win-x64（zonky embedded binaries）+ pgvector（CI 预编译）
#     WorkLoom.bat  首启自愈启动器（装配→初始化→迁移→种子→起服务→开浏览器）
#
# 用法：
#   bash scripts/pack-windows.sh [--version vX.Y.Z] [--structure-only]
#   --structure-only：跳过 pgvector 预编译件合入（占位代替，禁分发此包）。
#   正式包必须先编译 pgvector：Windows CI 跑 scripts/build-pgvector-win.ps1 产出
#   vendor/pgvector-win/{lib,share} 后，本脚本自动合入。
#
# 下载源回退链（受限网络纪律，与仓内 GITHUB_API_BASES 同口径）：
#   Node：nodejs.org → npmmirror
#   PG：  Maven Central → 腾讯云 nexus 镜像
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/release-assets.sh

VERSION="v1.1.0"
STRUCTURE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --structure-only) STRUCTURE_ONLY=1; shift ;;
    *) echo "未知参数 $1"; exit 1 ;;
  esac
done

NODE_VER="24.19.0"
PG_ZONKY_VER="17.2.0"
NODE_TARBALL="node-v${NODE_VER}-win-x64.zip"
NODE_URLS=(
  "https://nodejs.org/dist/v${NODE_VER}/${NODE_TARBALL}"
  "https://npmmirror.com/mirrors/node/v${NODE_VER}/${NODE_TARBALL}"
)
ZONKY_JAR="embedded-postgres-binaries-windows-amd64-${PG_ZONKY_VER}.jar"
ZONKY_URLS=(
  "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/${PG_ZONKY_VER}/${ZONKY_JAR}"
  "https://mirrors.cloud.tencent.com/nexus/repository/maven-public/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/${PG_ZONKY_VER}/${ZONKY_JAR}"
)

STAGE="$(mktemp -d /tmp/workloom-pack-win.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/WorkLoom"
DIST="dist"
mkdir -p "$DIST" "$PKG"

echo "== 装配 WorkLoom Windows 包（$VERSION · win-x64）=="

# 产品边界只能来自受保护身份；应急线与正式 Electron 线必须同口径。
PLATFORM_OPS_MODE="$(node scripts/payload-policy.mjs platform-ops-mode)"
PRODUCT_MANIFEST_PATH="$(node scripts/product-runtime.mjs --manifest-path)"
case "$PLATFORM_OPS_MODE" in
  include|exclude) ;;
  *) echo "❌ 无效的载荷边界策略：$PLATFORM_OPS_MODE"; exit 1 ;;
esac

# ---------- 1. 产品载荷 runtime/（与 pack-macos.sh 同口径） ----------
R="$PKG/runtime"
mkdir -p "$R/apps/server" "$R/apps/web" "$R/packages" "$R/scripts"
# pnpm 的 node_modules 是 junction/symlink 结构：Windows zip 往返会丢链导致模块缺失
# （v2.0.8 冒烟实证 esbuild/vite 丢失）——拷贝必须解引用为实体目录
copy() { cp -aL "$1" "$2"; }
for f in package.json pnpm-workspace.yaml tsconfig.base.json .env.example; do
  [ -f "$f" ] && copy "$f" "$R/"
done
[ -f "$PRODUCT_MANIFEST_PATH" ] || { echo "❌ 缺受保护产品清单"; exit 1; }
copy "$PRODUCT_MANIFEST_PATH" "$R/product.manifest.json"
[ -f "$R/.env.defaults" ] || copy .env.example "$R/.env.defaults"
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
mkdir -p "$R/scripts"
copy scripts/migrate.ts "$R/scripts/"
copy scripts/desktop-bootstrap-db.mjs "$R/scripts/"
copy scripts/product-runtime.mjs "$R/scripts/"
copy scripts/vite-product.mjs "$R/scripts/"
for sf in scripts/seed*.ts; do copy "$sf" "$R/scripts/"; done  # 全部行业种子随包（按 DESKTOP_SEED_SCRIPT 选用）
printf '%s\n' "$VERSION" > "$R/VERSION"
# 源码不携带 node_modules：各包自带 pnpm 链接版会抢占解析且缺嵌套依赖（v2.0.8 esbuild 缺失实证），
# 运行期统一由下方 npm 扁平化安装的根 node_modules 提供
find "$R/apps" "$R/packages" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true

# ---------- 2. 依赖与 web 构建产物 ----------
if [ ! -d node_modules ] || [ ! -d apps/web/node_modules ]; then
  echo "→ pnpm install…"; pnpm install --frozen-lockfile
fi
if [ ! -f apps/web/dist/index.html ]; then
  echo "→ 构建 web…"; pnpm -C apps/web build
fi
copy apps/web/dist "$R/apps/web/dist"
echo "→ 运行期依赖：npm 扁平化安装（pnpm 链接布局无法过 Windows zip 往返，v2.0.8 实证）…"
# 从本产品受控 runtime lock 执行 win32-x64 npm ci；不得继承构建宿主平台。
NM_STAGE="$STAGE/nm-pkg"
NPM_REG="${NPM_REGISTRY:-https://registry.npmjs.org}"
node scripts/runtime-deps-lock.mjs stage "$NM_STAGE" --os win32 --cpu x64 --registry "$NPM_REG"
copy "$NM_STAGE/node_modules" "$R/node_modules"
# 所有内部工作区包按 package name 动态注册；行业包与仙女座 platform-ops 不得遗漏。
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

# ---------- 3. Node win-x64 官方二进制 ----------
echo "→ Node $NODE_VER win-x64…"
mkdir -p "$PKG/node"
workloom_fetch_verified "$STAGE/$NODE_TARBALL" "$NODE_TARBALL" "${NODE_URLS[@]}"
mkdir -p "$STAGE/node"
if command -v unzip >/dev/null; then unzip -q "$STAGE/$NODE_TARBALL" -d "$STAGE/node"; else tar -xf "$STAGE/$NODE_TARBALL" -C "$STAGE/node"; fi
mv "$STAGE/node/node-v${NODE_VER}-win-x64/"* "$PKG/node/"

# ---------- 4. PostgreSQL 17 win-x64（优先 vendor/pg-win 同源树；否则 zonky 回退） ----------
mkdir -p "$PKG/pg"
if [ -f "vendor/pg-win/bin/postgres.exe" ]; then
  echo "→ PG 运行时：vendor/pg-win（与 pgvector 编译底座同源，ABI 一致）…"
  node scripts/release-assets.mjs verify-windows-pg-provenance vendor/pg-win/WORKLOOM-PROVENANCE.txt
  cp -a vendor/pg-win/bin vendor/pg-win/lib vendor/pg-win/share "$PKG/pg/"
else
  echo "→ PG 运行时：zonky ${PG_ZONKY_VER}（回退；注意与 pgvector ABI 需同小版本）…"
  workloom_fetch_verified "$STAGE/pg.jar" "$ZONKY_JAR" "${ZONKY_URLS[@]}"
  mkdir -p "$STAGE/pgjar"
  if command -v unzip >/dev/null; then unzip -q -o "$STAGE/pg.jar" -d "$STAGE/pgjar"; else tar -xf "$STAGE/pg.jar" -C "$STAGE/pgjar"; fi
  TXZ="$(find "$STAGE/pgjar" -name '*.txz' | head -1)"
  [ -n "$TXZ" ] || { echo "❌ zonky jar 内未找到 .txz"; exit 1; }
  mkdir -p "$STAGE/pgsql"
  tar -xJf "$TXZ" -C "$STAGE/pgsql"
  [ -f "$STAGE/pgsql/bin/postgres.exe" ] || { echo "❌ PG 结构异常（postgres.exe 缺失）"; exit 1; }
  cp -a "$STAGE/pgsql/bin" "$STAGE/pgsql/lib" "$STAGE/pgsql/share" "$PKG/pg/"
  rm -rf "$PKG/pg/lib/pkgconfig" 2>/dev/null || true
fi

# ---------- 5. pgvector（CI 预编译合入；structure-only 占位） ----------
if [ "$STRUCTURE_ONLY" = "1" ]; then
  echo "⚠️  structure-only：pgvector 占位（禁分发此包）"
  printf 'structure-only placeholder\n' > "$PKG/pg/PLACEHOLDER-NOT-FOR-RELEASE"
else
  PV="vendor/pgvector-win"
  [ -f "$PV/lib/vector.dll" ] || { echo "❌ 缺 vendor/pgvector-win/lib/vector.dll——先在 Windows CI 跑 scripts/build-pgvector-win.ps1"; exit 1; }
  node scripts/release-assets.mjs verify-windows-pg-provenance "$PV/WORKLOOM-PROVENANCE.txt"
  cp "$PV/lib/vector.dll" "$PKG/pg/lib/"
  cp "$PV"/share/extension/vector.control "$PKG/pg/share/extension/"
  cp "$PV"/share/extension/vector--*.sql "$PKG/pg/share/extension/"
  echo "✓ pgvector 合入（vector.dll + control + sql）"
fi

# ---------- 5.5 内嵌 nats-server（P0-3 决策点 4：+20MB 开箱即持久化事件总线） ----------
NATS_VER="v2.11.4"
if [ "$STRUCTURE_ONLY" = "1" ]; then
  mkdir -p "$PKG/nats"
  printf 'structure-only placeholder
' > "$PKG/nats/PLACEHOLDER-NOT-FOR-RELEASE"
else
  echo "→ nats-server ${NATS_VER} windows-amd64…"
  NATS_DIST="nats-server-${NATS_VER}-windows-amd64.zip"
  workloom_fetch_verified "$STAGE/nats.zip" "$NATS_DIST" "https://github.com/nats-io/nats-server/releases/download/${NATS_VER}/${NATS_DIST}"
  unzip -qo "$STAGE/nats.zip" -d "$STAGE/nats-x"
  mkdir -p "$PKG/nats"
  cp "$STAGE/nats-x/nats-server-${NATS_VER}-windows-amd64/nats-server.exe" "$PKG/nats/"
  [ -f "$PKG/nats/nats-server.exe" ] || { echo "❌ nats-server.exe 未随包"; exit 1; }
fi

# ---------- 6. 启动器 ----------
copy apps/desktop/windows/WorkLoom.bat "$PKG/WorkLoom.bat"
copy apps/desktop/electron/bootstrap.cjs "$PKG/bootstrap.cjs"

for f in node_modules/tsx/package.json node_modules/hono/package.json scripts/migrate.ts \
         scripts/product-runtime.mjs scripts/vite-product.mjs product.manifest.json apps/web/vite.config.ts; do
  [ -f "$R/$f" ] || { echo "❌ 应急载荷自检失败：runtime/$f 缺失"; exit 1; }
done
node scripts/payload-policy.mjs assert-runtime "$R"

# ---------- 7. 打包 + 校验和 ----------
echo "→ 压缩…"
ZIP="$DIST/WorkLoom-Windows.zip"
rm -f "$ZIP" "$ZIP.sha256"
if command -v zip >/dev/null; then ( cd "$STAGE" && zip -qry "$OLDPWD/$ZIP" WorkLoom ); else ( cd "$STAGE" && tar -a -cf "$OLDPWD/$ZIP" WorkLoom ); fi
( cd "$DIST" && { command -v sha256sum >/dev/null && sha256sum "WorkLoom-Windows.zip" || shasum -a 256 "WorkLoom-Windows.zip"; } > "WorkLoom-Windows.zip.sha256" )
SIZE=$(du -h "$ZIP" | cut -f1)
echo "✅ 产出 ${ZIP}（${SIZE}）+ sha256"
if [ "$STRUCTURE_ONLY" = "1" ]; then echo "⚠️  本包为结构校验产物，PLACEHOLDER 在位，禁止上传 Release"; fi
exit 0
