#!/usr/bin/env bash
# ============================================================
# WorkLoom macOS 发行包装配（W2 / D16）
# 产出：dist/WorkLoom-macOS.zip + .sha256
#   WorkLoom.app/Contents/Resources/
#     runtime/  产品载荷（源码+迁移+种子+node_modules+web dist+VERSION）
#     node/     Node 24 darwin 官方二进制（免 brew 免 sudo）
#     pg/       Postgres.app 2.9.6-17（内置 PG 17.11 + pgvector 0.8.6，与总纲 pin 一致）
# 用法：
#   bash scripts/pack-macos.sh [--version vX.Y.Z] [--arch arm64|x86_64]
#   bash scripts/pack-macos.sh --structure-only   # Linux/无 macOS：只装配并校验结构（跳过 DMG 挂载与 darwin 可执行验证）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/release-assets.sh

VERSION="v1.1.0"
ARCH="arm64"
STRUCTURE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --structure-only) STRUCTURE_ONLY=1; shift ;;
    *) echo "未知参数 $1"; exit 1 ;;
  esac
done

NODE_VER="24.19.0"
PGAPP_VER="2.9.6-17"
case "$ARCH" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64|x64) NODE_ARCH="x64" ;;
  *) echo "❌ 未知 arch $ARCH"; exit 1 ;;
esac
NODE_TARBALL="node-v${NODE_VER}-darwin-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VER}/${NODE_TARBALL}"
PGAPP_URL="https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-${PGAPP_VER}.dmg"

STAGE="$(mktemp -d /tmp/workloom-pack.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/WorkLoom.app"
DIST="dist"
mkdir -p "$DIST"

# ditto 为 macOS 专属；structure-only 模式（Linux）回落 cp -a
copy() { if command -v ditto >/dev/null 2>&1; then ditto "$1" "$2"; else cp -a "$1" "$2"; fi }

echo "== 装配 WorkLoom.app（$VERSION · darwin-${ARCH}）=="

PLATFORM_OPS_MODE="$(node scripts/payload-policy.mjs platform-ops-mode)"
PRODUCT_MANIFEST_PATH="$(node scripts/product-runtime.mjs --manifest-path)"
case "$PLATFORM_OPS_MODE" in
  include|exclude) ;;
  *) echo "❌ 无效的载荷边界策略：$PLATFORM_OPS_MODE"; exit 1 ;;
esac

# 1. App 骨架（Info.plist + launcher，仓库内版本化）
[ -f apps/desktop/WorkLoom.app/Contents/Info.plist ] || { echo "❌ 缺 apps/desktop 骨架"; exit 1; }
copy apps/desktop/WorkLoom.app "$APP"
chmod +x "$APP/Contents/MacOS/WorkLoom"
mkdir -p "$APP/Contents/Resources"
cp apps/desktop/electron/bootstrap.cjs "$APP/Contents/Resources/bootstrap.cjs"

# 2. 产品载荷 runtime/
echo "→ 装配产品载荷…"
R="$APP/Contents/Resources/runtime"
mkdir -p "$R"
# 源码与配置（白名单制，dist/供应商/测试夹具不进包）
for p in package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json; do cp "$p" "$R/"; done
[ -f "$PRODUCT_MANIFEST_PATH" ] || { echo "❌ 缺受保护产品清单"; exit 1; }
cp "$PRODUCT_MANIFEST_PATH" "$R/product.manifest.json"
cp .env.example "$R/.env.defaults"
RUNTIME_SOURCE_DIRS=(apps/server apps/web packages bundles)
[ "$PLATFORM_OPS_MODE" = "include" ] && RUNTIME_SOURCE_DIRS+=(platform-ops)
for d in "${RUNTIME_SOURCE_DIRS[@]}"; do
  rsync -aR --exclude node_modules --exclude dist --exclude .dsh-home --exclude 'dsh-gate/out' "$d" "$R/"
done
mkdir -p "$R/scripts"
cp scripts/migrate.ts scripts/desktop-bootstrap-db.mjs scripts/product-runtime.mjs scripts/vite-product.mjs "$R/scripts/"
cp scripts/seed*.ts "$R/scripts/"  # 全部行业种子随包（按 .env.defaults DESKTOP_SEED_SCRIPT 选用）
printf '%s\n' "$VERSION" > "$R/VERSION"

# 3. 依赖与 web 构建产物（需在装配机先 pnpm install + build）
if [ ! -d node_modules ] || [ ! -d apps/web/node_modules ]; then
  echo "→ pnpm install…"; pnpm install --frozen-lockfile
fi
if [ ! -f apps/web/dist/index.html ]; then
  echo "→ 构建 web…"; pnpm -C apps/web build
fi
copy apps/web/dist "$R/apps/web/dist"
echo "→ 运行期依赖：受控 npm ci（darwin-${NODE_ARCH}，扁平实体目录）…"
NM_STAGE="$STAGE/nm-pkg"
NPM_REG="${NPM_REGISTRY:-https://registry.npmjs.org}"
node scripts/runtime-deps-lock.mjs stage "$NM_STAGE" --os darwin --cpu "$NODE_ARCH" --registry "$NPM_REG"
copy "$NM_STAGE/node_modules" "$R/node_modules"
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
for f in node_modules/tsx/package.json node_modules/hono/package.json scripts/migrate.ts \
         scripts/product-runtime.mjs scripts/vite-product.mjs product.manifest.json apps/web/vite.config.ts; do
  [ -f "$R/$f" ] || { echo "❌ 应急载荷自检失败：runtime/$f 缺失"; exit 1; }
done
node scripts/payload-policy.mjs assert-runtime "$R"

# 4. Node darwin 官方二进制
echo "→ Node $NODE_VER darwin-${ARCH}…"
workloom_fetch_verified "$STAGE/$NODE_TARBALL" "$NODE_TARBALL" "$NODE_URL"
mkdir -p "$APP/Contents/Resources/node"
tar xzf "$STAGE/$NODE_TARBALL" -C "$APP/Contents/Resources/node" --strip-components=1

# 5. Postgres.app（DMG 挂载仅 macOS 可行）
if [ "$STRUCTURE_ONLY" = "1" ]; then
  echo "⚠️  structure-only：跳过 Postgres.app 挂载（占位目录代替，禁分发此包）"
  mkdir -p "$APP/Contents/Resources/pg/bin"
  printf 'structure-only placeholder\n' > "$APP/Contents/Resources/pg/PLACEHOLDER-NOT-FOR-RELEASE"
else
  echo "→ Postgres.app ${PGAPP_VER}（内置 pgvector 0.8.6）…"
  workloom_fetch_verified "$STAGE/pg.dmg" "Postgres-${PGAPP_VER}.dmg" "$PGAPP_URL"
  hdiutil attach -nobrowse -mountpoint "$STAGE/mnt" "$STAGE/pg.dmg" >/dev/null
  mkdir -p "$APP/Contents/Resources/pg"
  copy "$STAGE/mnt/Postgres.app/Contents/Versions/17/bin" "$APP/Contents/Resources/pg/bin"
  copy "$STAGE/mnt/Postgres.app/Contents/Versions/17/lib" "$APP/Contents/Resources/pg/lib"
  copy "$STAGE/mnt/Postgres.app/Contents/Versions/17/share" "$APP/Contents/Resources/pg/share"
  hdiutil detach "$STAGE/mnt" >/dev/null
  # 结构断言：PG 17 主程序与 pgvector 扩展在位
  # 注：macOS 上 PG≥16 的动态库后缀为 .dylib（非 .so），见 PostgresApp src-17/makefile（vector.dylib）
  [ -x "$APP/Contents/Resources/pg/bin/postgres" ] || { echo "❌ Postgres.app 结构异常"; exit 1; }
  ls "$APP/Contents/Resources/pg/lib/postgresql/vector.dylib" >/dev/null || { echo "❌ pgvector 未随包"; exit 1; }
  ls "$APP/Contents/Resources/pg/share/postgresql/extension/vector.control" >/dev/null || { echo "❌ pgvector control 缺失"; exit 1; }
fi

# ---------- 5.5 内嵌 nats-server（P0-3 决策点 4：+20MB 开箱即持久化事件总线） ----------
NATS_VER="v2.11.4"
case "$ARCH" in arm64) NATS_ARCH="arm64" ;; x86_64|x64) NATS_ARCH="amd64" ;; *) echo "❌ 未知 arch $ARCH"; exit 1 ;; esac
if [ "$STRUCTURE_ONLY" = "1" ]; then
  mkdir -p "$APP/Contents/Resources/nats"
  printf 'structure-only placeholder
' > "$APP/Contents/Resources/nats/PLACEHOLDER-NOT-FOR-RELEASE"
else
  echo "→ nats-server ${NATS_VER} darwin-${NATS_ARCH}…"
  NATS_DIST="nats-server-${NATS_VER}-darwin-${NATS_ARCH}.tar.gz"
  workloom_fetch_verified "$STAGE/nats.tgz" "$NATS_DIST" "https://github.com/nats-io/nats-server/releases/download/${NATS_VER}/${NATS_DIST}"
  tar -xzf "$STAGE/nats.tgz" -C "$STAGE"
  mkdir -p "$APP/Contents/Resources/nats"
  cp "$STAGE/nats-server-${NATS_VER}-darwin-${NATS_ARCH}/nats-server" "$APP/Contents/Resources/nats/"
  chmod +x "$APP/Contents/Resources/nats/nats-server"
  [ -x "$APP/Contents/Resources/nats/nats-server" ] || { echo "❌ nats-server 未随包"; exit 1; }
fi

# 6. 打包 + 校验和（保软链）
echo "→ 压缩…"
ZIP="$DIST/WorkLoom-macOS.zip"
rm -f "$ZIP" "$ZIP.sha256"
( cd "$STAGE" && zip -qry "$OLDPWD/$ZIP" WorkLoom.app )
( cd "$DIST" && shasum -a 256 "WorkLoom-macOS.zip" > "WorkLoom-macOS.zip.sha256" )
SIZE=$(du -h "$ZIP" | cut -f1)
echo "✅ 产出 ${ZIP}（${SIZE}）+ sha256"
if [ "$STRUCTURE_ONLY" = "1" ]; then echo "⚠️  本包为结构校验产物，PLACEHOLDER 在位，禁止上传 Release"; fi
exit 0
