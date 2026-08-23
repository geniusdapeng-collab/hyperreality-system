# @workloom/webc · AI 服务前台（C 端）

面向住客/客户的 H5「AI 服务前台」：AI 对话、服务大厅（建工单）、工单进度、消息通知、会员中心。
React 19 + Vite + Tailwind v4（令牌制）+ TS strict。后端契约 `baseURL=/c`（见 `src/lib/types.ts`）。

## 企业接入：只填内容，零改前端

**接入只需两步，均不涉及代码：**

1. **替换配置** `public/service-front.config.json`（品牌、主题、入口、文案）；
2. **替换知识库内容**（服务端知识文档，决定 AI 回答与引用来源）。

配置文件加载失败或字段缺失时自动落内置默认值，永不白屏。配置项一览：

| 字段 | 说明 |
| --- | --- |
| `brandName` | 品牌名（页头、欢迎语、通知卡落款、游客昵称前缀） |
| `agentName` | AI 前台名字（在线状态、打字中提示、历史会话入口） |
| `logoText` | 头像/Logo 字符（emoji 或单字） |
| `theme.primary` | 主色 hex（金色族：行动按钮、强调、会员） |
| `theme.secondary` | 辅色 hex（青色族：引用来源、信息） |
| `welcomeText` | 首轮欢迎语，支持 `{brand}` / `{agent}` 占位符 |
| `quickReplies[]` | 对话页快捷 chips：`{label, sendText?}` 或 `{label, serviceKind?}` |
| `serviceEntries[]` | 服务大厅入口：`{kind, title, desc, icon, sla, titlePlaceholder?}`（kind 须在后端工单白名单内：delivery/repair/complaint/other/service_request/consult） |
| `memberLevels` | 会员等级展示映射：后端 `level` → 前端展示文案 |
| `enableTabs[]` | 底部 Tab 开关（chat/service/tickets/messages/me，可关掉不用的） |
| `supportPhone` | 客服电话（「我的」页 tel: 直拨，留空则不展示） |

主题色在运行时注入 CSS 变量（`--color-gold*` ← primary，`--color-holo*` ← secondary），
全站 Tailwind 令牌即时换色，无需重新构建之外的任何改动。

## 开发

```bash
pnpm -F @workloom/webc dev        # 默认 5176，代理 /c → SERVER_PORT(默认 8787)
pnpm -F @workloom/webc typecheck
pnpm -F @workloom/webc build
```

## 关键体验机制

- **首屏并行预取**：session + orders + member 并行（`src/lib/prefetch.ts`），「我的」页秒开。
- **会话本地缓存**：最近 20 条消息存 localStorage，重开恢复（`ChatPage`）。
- **降级不静默**：任何 API 失败落演示数据并标注「演示数据」角标；发送失败的消息可点「重发」或「演示应答」。
- **断网感知**：offline/online 横幅提示，恢复后自动重建会话并重预取。
- **轮询节能**：工单详情 10s 轮询随 `visibilitychange` 暂停/恢复。
- **键盘适配**：`visualViewport` 驱动 `--app-height`，移动端输入栏不被顶出可视区。
- **未读红点**：严格按 `/c/notifications` 的 `read` 字段统计（30s 轮询）。
