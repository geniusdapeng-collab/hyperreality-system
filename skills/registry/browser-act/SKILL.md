---
name: 反封锁浏览器矩阵（BrowserAct 执行面 · 可选）
version: "1.0.0"
description: BrowserAct 开源技能库适配版——三层反封锁（指纹/TLS/代理 → 自动打码 → 人工接力）与多账号隔离浏览器矩阵。含云端依赖（stealth 额度/代理/打码为厂商 freemium 服务），默认不装配，按需安装并全程围栏收紧。
---

# 反封锁浏览器矩阵（BrowserAct 执行面 · 可选）

## 触发（何时用）

- 多账号矩阵运营（社媒/电商多店铺），需要账号级浏览器隔离（独立指纹+独立 IP）时；
- 目标站点反爬严格、基座 computer-use 的 stealth 层不足以穿透时；
- 需要"人机接力"：验证码/扫码时生成远程协助链接，用户任意设备接管后续接。

**先用基座，后用它**：computer-use（L1/L2/L3 + stealth.py + 拟人点击）能覆盖的场景，不启用本技能。

## 云依赖明示（安装前必读）

| 能力 | 性质 | 治理口径 |
|---|---|---|
| 基础自动化（chrome/chrome-direct） | 本地免费 | 直接可用 |
| stealth 浏览器（≤5）、打码、人机接力、stealth-extract | 厂商云 API（需客户自注册账号，免费额度） | 出站域 `api.browseract.com` 全声明、过三段瀑布审计 |
| stealth 浏览器（>5）、动态/静态住宅代理 | 厂商付费云 | 客户自购自配，API Key 只存本机；代理仅允许 custom-proxy（自带）模式优先 |

## 步骤

1. 客户侧本机安装 browser-act CLI 并自行注册获取 API Key（API Key 只存本机，不进技能正文、不进事件库）；
2. 账号矩阵建档：每账号固定身份（stable fingerprint + 客户自带静态代理），登记单账号日上限；
3. 任务执行：索引化指令操作（click 3 / input 2）；写动作逐条过围栏瀑布；
4. 验证码策略：默认「挂起转人工」（经 IM 审批卡推送接管链接）；自动打码须单独审批授权后启用；
5. 复核：每日动作量、异常率、封号信号进技能积分卡；命中风控即降速或挂起。

## 边界（什么不做）

- 不用厂商代理做客户数据中转——代理仅 custom-proxy（客户自带）为默认形态；
- 不批量抓取第三方受保护页面做内容库（ToS 合规红线）；
- 不超过单账号日上限（默认 3 动作/账号/日起步，试运行一周后才可申请上调，且任何放宽永不自动）；
- 无 API Key 不硬跑——缺 API Key 即停用并提示，不降级为无保护模式。

## 依赖与权限声明

- 依赖：browser-act CLI（技能级依赖，安装预检查验；上游 browser-act/skills，MIT）；
- 工具白名单：browser-act 命令组；
- 出站域：api.browseract.com（打码/ stealth /人机接力中继）；
- 建议围栏参数：accountDailyCap=3、proxyMode=custom-only、captchaSolve=approval-required、maxStealthBrowsers=5。
