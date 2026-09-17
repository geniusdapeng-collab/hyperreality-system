# PREVIEW_CHECKLIST · 三端预览验收清单

> 由 `pnpm preview:all` 一键拉起。验收口径：任意开发者克隆仓库后，三端可访问、数据饱满、交互无报错。
> 最近实测：2026-08-26（主仓，截图存档 `docs/demo/preview-shots/`）。

## 0. 启动验收

- [ ] `pnpm preview:all` 退出前打印糖果色横幅（三端地址 + "Mock 数据已加载"）
- [ ] 四个端口就绪：`:8787`（server）/ `:3000`（PC）/ `:3001`（B 移动）/ `:3002`（C 移动）

## 1. PC 端 · B 端工作台（http://localhost:3000）

| 验证点 | 预期 |
|---|---|
| 首页经营主页 | 糖果色主题、团队全员就位、"全模拟运行态"横幅常驻 |
| 晨报卡片 | 【晨报·公司CEO】含事件库规模、系统动态计数 |
| 顶部导航 | 工作台 / 董事长视图可切换，URL 随路由变化（/p0、/p21 等） |
| 待审批区 | 存在待拍板事项，✓批准/✕驳回可点击 |
| 底部输入 | "像跟公司CEO说话一样输入…" ASK 入口可输入发送 |

## 2. B 端移动 · 高保真 + 手机壳（http://localhost:3001）

| 验证点 | 预期 |
|---|---|
| 导航页 | 糖果色导航页，"运行时三端"三张卡片链接正确 |
| 演示页清单 | 自动列出 docs/demo 全部页面，含"打开 / 手机壳"双入口 |
| 手机壳容器 | `shell.html?page=service-front-b-mobile.html` 套 iPhone 壳（390×872）渲染无破版 |
| 案例页 | `service-front-b-mobile.html`（B 端移动）/ `service-front-c.html`（C 端）数据饱满 |

## 3. C 端移动 · AI 服务前台（http://localhost:3002）

| 验证点 | 预期 |
|---|---|
| 对话页 | 「星芒好物·AI 服务前台」在线、欢迎语、快捷入口（查订单/售后退换/物流催办/常见问题） |
| 底部 Tab | 对话 / 服务 / 工单 / 消息 / 我的 五 Tab 可切换 |
| 演示直登 | 免账密（SERVICE_C_DEMO_AUTH），发送消息有确定性应答 |
| 工单页 | 演示工单列表（含 SLA 超时样例） |

## 4. Mock 数据与能力

- [ ] 种子注入回报计数正常（员工/围栏/对象/事件/知识库 385 问）
- [ ] PC/C 两端数据同源（同一 PG，C 端工单在 PC 端人审台可见）
- [ ] 顶部"全模拟运行态"横幅三端口径一致
- [ ] computer-use 浏览器能力可自动打开三端并截图（见 docs/agent-computer-guide.md）

## 5. 截图存档

| 端 | 存档 |
|---|---|
| PC :3000 | `docs/demo/preview-shots/pc-3000.png` |
| B 移动导航 :3001 | `docs/demo/preview-shots/mobile-b-3001.png` |
| 手机壳容器 | `docs/demo/preview-shots/shell-guest.png` |
| C 移动 :3002 | `docs/demo/preview-shots/mobile-c-3002.png` |
