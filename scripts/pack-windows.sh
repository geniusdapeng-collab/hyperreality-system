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

fetch() { # fetch <url...> -o <out>：按序回退
  local out="${@: -1}"; local urls=("${@:1:$#-1}")
  for u in "${urls[@]}"; do
    echo "  ↓ $u"
    if curl -sfL --retry 3 -o "$out" "$u"; then return 0; fi
    echo "  ⚠️  失败，回退下一源"
  done
  echo "❌ 全部下载源失败：$out"; return 1
}

STAGE="$(mktemp -d /tmp/workloom-pack-win.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/WorkLoom"
DIST="dist"
mkdir -p "$DIST" "$PKG"

echo "== 装配 WorkLoom Windows 包（$VERSION · win-x64）=="

# ---------- 1. 产品载荷 runtime/（与 pack-macos.sh 同口径） ----------
R="$PKG/runtime"
mkdir -p "$R/apps/server" "$R/apps/web" "$R/packages" "$R/scripts"
copy() { cp -a "$1" "$2"; }
for f in package.json pnpm-workspace.yaml tsconfig.base.json .env.example; do
  [ -f "$f" ] && copy "$f" "$R/"
done
[ -f "$R/.env.defaults" ] || copy .env.example "$R/.env.defaults"
for d in apps/server apps/web/src apps/web/index.html apps/web/public apps/web/package.json apps/web/vite.config.ts apps/web/tsconfig.json packages/db packages/base packages/shared packages/runtime bundles; do
  [ -e "$d" ] || continue
  mkdir -p "$R/$(dirname "$d")"
  copy "$d" "$R/$(dirname "$d")/"
done
mkdir -p "$R/scripts"
copy scripts/migrate.ts "$R/scripts/"
copy scripts/seed.ts "$R/scripts/"
printf '%s\n' "$VERSION" > "$R/VERSION"

# ---------- 2. 依赖与 web 构建产物 ----------
if [ ! -d node_modules ] || [ ! -d apps/web/node_modules ]; then
  echo "→ pnpm install…"; pnpm install --frozen-lockfile
fi
if [ ! -f apps/web/dist/index.html ]; then
  echo "→ 构建 web…"; pnpm -C apps/web build
fi
copy apps/web/dist "$R/apps/web/dist"
echo "→ 并入 node_modules…"
copy node_modules "$R/node_modules"
for d in apps/server apps/web packages/shared packages/db packages/base packages/runtime; do
  [ -d "$d/node_modules" ] && { mkdir -p "$R/$d"; copy "$d/node_modules" "$R/$d/node_modules"; }
done

# ---------- 3. Node win-x64 官方二进制 ----------
echo "→ Node $NODE_VER win-x64…"
mkdir -p "$PKG/node"
fetch "${NODE_URLS[@]}" -o "$STAGE/$NODE_TARBALL"
unzip -q "$STAGE/$NODE_TARBALL" -d "$STAGE/node"
mv "$STAGE/node/node-v${NODE_VER}-win-x64/"* "$PKG/node/"

# ---------- 4. PostgreSQL 17 win-x64（zonky jar → txz 解包） ----------
echo "→ PostgreSQL $PG_ZONKY_VER win-x64（zonky）…"
fetch "${ZONKY_URLS[@]}" -o "$STAGE/pg.jar"
unzip -q -o "$STAGE/pg.jar" -d "$STAGE/pgjar"
TXZ="$(find "$STAGE/pgjar" -name '*.txz' | head -1)"
[ -n "$TXZ" ] || { echo "❌ zonky jar 内未找到 .txz"; exit 1; }
mkdir -p "$STAGE/pgsql"
tar -xJf "$TXZ" -C "$STAGE/pgsql"
# zonky 解出为 pgsql/{bin,lib,include,share}
[ -f "$STAGE/pgsql/bin/postgres.exe" ] || { echo "❌ PG 结构异常（postgres.exe 缺失）"; exit 1; }
mkdir -p "$PKG/pg"
cp -a "$STAGE/pgsql/bin" "$STAGE/pgsql/lib" "$STAGE/pgsql/share" "$PKG/pg/"
rm -rf "$PKG/pg/lib/pkgconfig" 2>/dev/null || true

# ---------- 5. pgvector（CI 预编译合入；structure-only 占位） ----------
if [ "$STRUCTURE_ONLY" = "1" ]; then
  echo "⚠️  structure-only：pgvector 占位（禁分发此包）"
  printf 'structure-only placeholder\n' > "$PKG/pg/PLACEHOLDER-NOT-FOR-RELEASE"
else
  PV="vendor/pgvector-win"
  [ -f "$PV/lib/vector.dll" ] || { echo "❌ 缺 vendor/pgvector-win/lib/vector.dll——先在 Windows CI 跑 scripts/build-pgvector-win.ps1"; exit 1; }
  cp "$PV/lib/vector.dll" "$PKG/pg/lib/"
  cp "$PV"/share/extension/vector.control "$PKG/pg/share/extension/"
  cp "$PV"/share/extension/vector--*.sql "$PKG/pg/share/extension/"
  echo "✓ pgvector 合入（vector.dll + control + sql）"
fi

# ---------- 6. 启动器 ----------
copy apps/desktop/windows/WorkLoom.bat "$PKG/WorkLoom.bat"

# ---------- 7. 打包 + 校验和 ----------
echo "→ 压缩…"
ZIP="$DIST/WorkLoom-Windows.zip"
rm -f "$ZIP" "$ZIP.sha256"
( cd "$STAGE" && zip -qry "$OLDPWD/$ZIP" WorkLoom )
( cd "$DIST" && shasum -a 256 "WorkLoom-Windows.zip" > "WorkLoom-Windows.zip.sha256" )
SIZE=$(du -h "$ZIP" | cut -f1)
echo "✅ 产出 ${ZIP}（${SIZE}）+ sha256"
if [ "$STRUCTURE_ONLY" = "1" ]; then echo "⚠️  本包为结构校验产物，PLACEHOLDER 在位，禁止上传 Release"; fi
exit 0
