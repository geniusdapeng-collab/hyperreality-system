#!/usr/bin/env bash
# install-im-channels.sh · dsh-im IM 通道插件安装（D14/B11）
# 纪律：pin 版本 + integrity 校验 + 幂等；凭据安装后在 dsh 设置页手动配置（永不经事件明文，L7.3）
set -euo pipefail

PKG="@xmanrui/dsh-im"
VERSION="0.2.2"
INTEGRITY="sha512-o06B3WseVZkkKb6SWcRIzbvlMkoUtsCKmCPDz8okGDtVTdQvPWwOk6XPBrnBKD2MmzThkmA+UNWj+a6cjwe6mQ=="
PROFILE="${DSH_PROFILE:-web}"

echo "==> dsh-im 安装（${PKG}@${VERSION}，profile=${PROFILE}）"

# 1) integrity 校验（registry 元数据为准；防供应链漂移）
META_INTEGRITY="$(npm view "${PKG}@${VERSION}" dist.integrity 2>/dev/null || true)"
if [ -z "${META_INTEGRITY}" ]; then
  echo "✗ 无法获取 ${PKG}@${VERSION} registry 元数据（网络/权限）"; exit 1
fi
if [ "${META_INTEGRITY}" != "${INTEGRITY}" ]; then
  echo "✗ integrity 漂移：期望 ${INTEGRITY}，实际 ${META_INTEGRITY}（锁版纪律 D14，拒绝安装）"; exit 1
fi
echo "✓ integrity 校验通过（${INTEGRITY:0:24}…）"

# 2) 幂等检查：已挂同名插件则跳过
if command -v dsh >/dev/null 2>&1 && dsh plugin --profile "${PROFILE}" list 2>/dev/null | grep -q "${PKG}"; then
  echo "✓ ${PKG} 已在 profile「${PROFILE}」挂载，跳过（幂等）"
  exit 0
fi

# 3) 挂载（cordis.patch.yml 机制，与 B0 hello-fence 同构：- insert: [{id, name}]）
dsh plugin --profile "${PROFILE}" add "${PKG}@${VERSION}"
echo "✓ ${PKG}@${VERSION} 已挂载到 profile「${PROFILE}」"
echo ""
echo "下一步："
echo "  1) dsh web → 设置页「IM机器人」配置通道凭据（钉钉/企微/飞书，扫码或手动凭据）"
echo "  2) .env 置 IM_DRIVER=dsh-im 启用真实通道（默认 mock，无凭据全流程可跑）"
echo "  3) 通道状态与注册表对账：GET /trpc/im.channels"
