# vendor/dsh-im · 多平台 IM 机器人接入插件锁定信息（D14 / B11）

| 项 | 值 |
|---|---|
| 包 | `@xmanrui/dsh-im`（dsh 宿主插件；inject: `connection` / `credentials` / `webServer` 全文档化 seam） |
| 锁定版本 | `0.2.2` |
| 来源 | `https://registry.npmjs.org/@xmanrui/dsh-im/-/dsh-im-0.2.2.tgz` |
| integrity | `sha512-o06B3WseVZkkKb6SWcRIzbvlMkoUtsCKmCPDz8okGDtVTdQvPWwOk6XPBrnBKD2MmzThkmA+UNWj+a6cjwe6mQ==`（registry 元数据核验 ✅） |
| License | MIT（可自由使用和二次开发） |
| 上游仓库 | `github.com/xmanrui/dsh-im` |
| engines | node >= 22.19（本项目 Node 24 LTS 满足） |
| 关键依赖 | dingtalk-stream 2.1.4 / @wecom/aibot-node-sdk 1.0.7 / @tencent-connect/qqbot-* / qrcode 1.5.4 |
| 入库日期 | 2026-08-17 |
| 入库方式 | 文档锁定（不 vendored 源码）；安装走 `scripts/install-im-channels.sh`（pin 版本 + integrity 校验） |

## 接入边界（D14）

- **首批启用三官方通道**：钉钉（dingtalk-stream）、企业微信（aibot-node-sdk）、飞书 —— 与 `approvals.channel` 枚举对账（packages/base/im-channels/registry.ts）。
- **观察名单不启用**：微信（iLink 长轮询，非官方协议）、WhatsApp（baileys，非官方协议）——合规风险，待官方 API 方案。
- **Slack**：枚举位保留（DDL 已含），dsh-im 未覆盖，status=planned。
- 微信扫码/凭据双接入方式、流式输出（微信除外）由 dsh-im 提供；流式语义本项目首版不接（审批卡片为一次性消息，F5.5）。

## 纪律（同 vendor/dsh 口径）

- 锁版本 + integrity 校验入库；升级前对照 registry 元数据 diff，并跑 im-channels 契约测试全绿。
- 凭据单向提交本机 Host（dsh 设置页），RPC 不回传 Secret，管理 RPC 默认仅回环 —— 与本项目 L7.3（凭据永不经事件明文）口径一致。
- 通道核心逻辑（注册表/入站幂等/卡片出站/手势回调）在 `packages/base/im-channels`（自研护城河，D12 双轨纪律）；dsh-im 只做 L1 通道适配。
- 早期快速演进风险：2026-08-14 创建、当日 0.1.0→0.2.2 五连发 → 锁版纪律兜底，未经评估不跟版。

## 安装

```bash
bash scripts/install-im-channels.sh        # pin 0.2.2 + integrity 校验 + dsh profile 挂载
IM_DRIVER=mock                              # 默认 mock 驱动（无凭据全流程可跑，D4 同纪律）
```
