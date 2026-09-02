---
name: 自适应数据采集框架（Scrapling 采集面）
version: "1.0.0"
description: 用 Scrapling 做批量公开数据采集——自适应元素定位（页面改版自动重定位）、爬虫模板（CrawlSpider/SitemapSpider 等）、断点恢复、自动限速、结构化导出。适用于竞品监控、比价、内容采集等高频批量场景。
---

# 自适应数据采集框架（Scrapling 采集面）

## 触发（何时用）

- **批量数据采集**：要从一批页面/整个站点抓取结构化数据（价格、房源、商品、文章），不是操作单个页面时；
- **目标站结构会变动**：选择器经常失效、需要"记一次、自动跟着页面改版走"的自适应定位时；
- **需要现成爬虫范式**：整站爬取（CrawlSpider）、站点地图（SitemapSpider）、Feed/Shopify 采集，不想从零写循环时；
- **需要后台 API 数据**：页面数据其实来自 XHR/fetch 接口，用 capture_xhr 直接收响应比解析 DOM 更快时；
- **需要结构化交付**：结果直接导出 JSON/JSONL/CSV/XML 进下游流程时。

**何时不用它（分工纪律）**：

| 场景 | 用谁 |
|---|---|
| 单次页面操作（点击/填表/截图/登录态操作） | computer-use 或 browser-playwright 技能 |
| 固定流程固化（每天同样的点击序列） | browser-playwright 技能 |
| 多账号矩阵、强反封锁对抗、Cloudflare 付费级防护 | browser-act 技能（可选，须审批） |
| 采集公开页面数据、结构变动频繁的站点 | **本技能** |

## 步骤

1. **判断抓取层级**：静态页用 Fetcher（纯 HTTP，最快）；动态渲染用 DynamicFetcher（Playwright Chromium）；有拦截用 StealthyFetcher（指纹伪装）。能用浅的就不用深的；
2. **记住关键元素**：首次解析用 `auto_save=True` 保存元素特征，后续调用传 `adaptive=True`——页面改版后按相似度自动重新定位，不再因选择器失效返工；
3. **批量任务用 Spider**：`start_urls` + `parse` 声明式写法；开 `AutoThrottle`（按目标站响应自动调速，被限速按 Retry-After 退避）；大任务开断点保存（Ctrl+C 可恢复）；
4. **接口数据直接收**：数据来自后台 API 时用 `capture_xhr` 收 XHR 响应，跳过 DOM 解析；
5. **导出进下游**：内置 JSON/JSONL/CSV/XML 导出，直接对接 WorkData 或文件交付；
6. **多会话**：不同目标/不同反爬级别用会话路由（sid）分流，代理经 ProxyRotator 轮换（客户自带代理）。

## 边界（什么不做）

- **只采公开数据**：目标站须为公开页面或客户已获授权；目标站清单进围栏审批（fenceParams.targetDomainsRequireApproval），未批准的目标不采；
- **尊重 robots.txt**：`respect_robots_txt=True` 为默认；关闭须审批并留痕；
- **不硬闯反爬**：StealthyFetcher 的指纹伪装用于正常采集防误伤；`solve_cloudflare` 级对抗默认关闭，开启须审批（与 browser-act 同纪律）；Akamai/DataDome 级企业防护不硬碰，转人工评估；
- **限速是天条**：AutoThrottle 常开；单目标站日请求上限由 fenceParams.dailyActionCap 约束，默认 500 起；
- 登录态由用户本人完成，API Key 与登录态只存本机，不进技能正文、不出站；
- 采到的数据按 WorkData 三段瀑布处理（PII 脱敏后才可进上下文或出站）。

## 安装与依赖

```bash
pip install "scrapling[fetchers]"   # Python ≥ 3.10
scrapling install                    # 下载浏览器依赖（DynamicFetcher 用）
```

MCP 服务器形态（`scrapling[ai]`）为可选增强，默认不启用；启用须审批并声明出站。
