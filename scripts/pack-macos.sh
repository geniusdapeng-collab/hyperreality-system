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
NODE_TARBALL="node-v${NODE_VER}-darwin-${ARCH}.tar.gz"
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

# 1. App 骨架（Info.plist + launcher，仓库内版本化）
[ -f apps/desktop/WorkLoom.app/Contents/Info.plist ] || { echo "❌ 缺 apps/desktop 骨架"; exit 1; }
copy apps/desktop/WorkLoom.app "$APP"
chmod +x "$APP/Contents/MacOS/WorkLoom"

# 2. 产品载荷 runtime/
echo "→ 装配产品载荷…"
R="$APP/Contents/Resources/runtime"
mkdir -p "$R"
# 源码与配置（白名单制，dist/供应商/测试夹具不进包）
for p in package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json; do cp "$p" "$R/"; done
cp .env.example "$R/.env.defaults"
for d in apps/server apps/web packages bundles; do
  rsync -aR --exclude node_modules --exclude dist --exclude .dsh-home --exclude 'dsh-gate/out' "$d" "$R/"
done
mkdir -p "$R/scripts"
cp scripts/migrate.ts scripts/desktop-bootstrap-db.mjs "$R/scripts/"
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
echo "→ 并入 node_modules（pnpm 软链结构需 zip -y 保软链）…"
copy node_modules "$R/node_modules"
for d in apps/server apps/web packages/shared packages/db packages/base packages/runtime; do
  [ -d "$d/node_modules" ] && { mkdir -p "$R/$d"; copy "$d/node_modules" "$R/$d/node_modules"; }
done

# 4. Node darwin 官方二进制
echo "→ Node $NODE_VER darwin-${ARCH}…"
curl -sfL --retry 4 -o "$STAGE/$NODE_TARBALL" "$NODE_URL"
mkdir -p "$APP/Contents/Resources/node"
tar xzf "$STAGE/$NODE_TARBALL" -C "$APP/Contents/Resources/node" --strip-components=1

# 5. Postgres.app（DMG 挂载仅 macOS 可行）
if [ "$STRUCTURE_ONLY" = "1" ]; then
  echo "⚠️  structure-only：跳过 Postgres.app 挂载（占位目录代替，禁分发此包）"
  mkdir -p "$APP/Contents/Resources/pg/Postgres.app/Contents/Versions/17/bin"
  printf 'structure-only placeholder\n' > "$APP/Contents/Resources/pg/PLACEHOLDER-NOT-FOR-RELEASE"
else
  echo "→ Postgres.app ${PGAPP_VER}（内置 pgvector 0.8.6）…"
  curl -sfL --retry 4 -o "$STAGE/pg.dmg" "$PGAPP_URL"
  hdiutil attach -nobrowse -mountpoint "$STAGE/mnt" "$STAGE/pg.dmg" >/dev/null
  mkdir -p "$APP/Contents/Resources/pg"
  ditto "$STAGE/mnt/Postgres.app" "$APP/Contents/Resources/pg/Postgres.app"
  hdiutil detach "$STAGE/mnt" >/dev/null
  # 结构断言：PG 17 主程序与 pgvector 扩展在位
  # 注：macOS 上 PG≥16 的动态库后缀为 .dylib（非 .so），见 PostgresApp src-17/makefile（vector.dylib）
  [ -x "$APP/Contents/Resources/pg/Postgres.app/Contents/Versions/17/bin/postgres" ] || { echo "❌ Postgres.app 结构异常"; exit 1; }
  ls "$APP/Contents/Resources/pg/Postgres.app/Contents/Versions/17/lib/postgresql/vector.dylib" >/dev/null || { echo "❌ pgvector 未随包"; exit 1; }
  ls "$APP/Contents/Resources/pg/Postgres.app/Contents/Versions/17/share/postgresql/extension/vector.control" >/dev/null || { echo "❌ pgvector control 缺失"; exit 1; }
fi

# ---------- 5.5 内嵌 nats-server（P0-3 决策点 4：+20MB 开箱即持久化事件总线） ----------
NATS_VER="v2.11.4"
case "$ARCH" in arm64) NATS_ARCH="arm64" ;; x86_64) NATS_ARCH="amd64" ;; *) echo "❌ 未知 arch $ARCH"; exit 1 ;; esac
if [ "$STRUCTURE_ONLY" = "1" ]; then
  mkdir -p "$APP/Contents/Resources/nats"
  printf 'structure-only placeholder
' > "$APP/Contents/Resources/nats/PLACEHOLDER-NOT-FOR-RELEASE"
else
  echo "→ nats-server ${NATS_VER} darwin-${NATS_ARCH}…"
  curl -sfL --retry 4 -o "$STAGE/nats.tgz" "https://github.com/nats-io/nats-server/releases/download/${NATS_VER}/nats-server-${NATS_VER}-darwin-${NATS_ARCH}.tar.gz"
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
