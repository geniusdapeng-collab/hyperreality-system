#!/usr/bin/env bash
# ============================================================
# WorkLoom Release 本地发布脚本（W2；CI 之外的备用手动通道）
# 前置：macOS 上已 bash scripts/pack-macos.sh --version <tag> 产出 dist/
# 用法：GH_TOKEN=<pat> bash scripts/release.sh v1.1.0
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:?用法：GH_TOKEN=<pat> bash scripts/release.sh v1.1.0}"
: "${GH_TOKEN:?需要 GH_TOKEN（repo 权限 PAT，用完即清）}"
command -v node >/dev/null 2>&1 || { echo "❌ 缺少 Node.js，无法读取受保护产品身份"; exit 1; }
REPO="$(node scripts/product-runtime.mjs --field repository)"
PRODUCT_NAME="$(node scripts/product-runtime.mjs --field displayName)"
PRODUCT_ID="$(node scripts/product-runtime.mjs --field productId)"
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN" in
  "https://github.com/${REPO}"|"https://github.com/${REPO}.git"|"git@github.com:${REPO}.git") ;;
  *) echo "❌ product.manifest.json 仓库 ${REPO} 与 origin ${ORIGIN:-未配置} 不一致"; exit 1 ;;
esac
ZIP="dist/WorkLoom-macOS.zip"
SUM="dist/WorkLoom-macOS.zip.sha256"
[ -f "$ZIP" ] && [ -f "$SUM" ] || { echo "❌ 缺 $ZIP / ${SUM}——先跑 scripts/pack-macos.sh"; exit 1; }
unzip -l "$ZIP" | grep -q "PLACEHOLDER-NOT-FOR-RELEASE" && { echo "❌ 结构校验包禁止发布"; exit 1; }

API="https://api.github.com/repos/$REPO"
NOTES="${PRODUCT_NAME} ${VER}（macOS）——三步启航：下载解压 → 拖入应用程序 → 按系统提示首次打开。依赖全自带，无需 brew、sudo 或命令行。校验：shasum -a 256 -c WorkLoom-macOS.zip.sha256。产品标识：${PRODUCT_ID}。"
RELEASE_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({tag_name:process.argv[1],name:`${process.argv[2]} ${process.argv[1]}`,body:process.argv[3]}))' "$VER" "$PRODUCT_NAME" "$NOTES")"

echo "== 发布 $VER → $REPO =="
# 1. 建/取 Release
REL=$(curl -sf -X POST "$API/releases" -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  --data-binary "$RELEASE_PAYLOAD" 2>/dev/null) \
  || REL=$(curl -sf "$API/releases/tags/$VER" -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json")
RID=$(printf '%s' "$REL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const id=JSON.parse(s).id;if(!Number.isInteger(id))process.exit(1);process.stdout.write(String(id))})')
UP="https://uploads.github.com/repos/$REPO/releases/$RID/assets"
echo "→ release id=${RID}，上传资产…"
for f in "$ZIP" "$SUM"; do
  curl -sf --retry 4 -X POST "$UP?name=$(basename "$f")" \
    -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" >/dev/null && echo "  ✅ $(basename "$f")"
done
echo "✅ 已发布：https://github.com/$REPO/releases/tag/$VER"
echo "→ 下一步：在 product.manifest.json 登记的网站项目中核对正式下载入口"
