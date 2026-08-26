# HyperReality 能力地图（Capability Map）

> 本文是**给 AI Coding Agent 看的系统全量能力清单**。每条标注「是什么 / 怎么调用 / 怎么验证」。
> 可执行版：`bash scripts/agent-tour.sh [--full]`——按本清单逐项自检并打印 PASS/FAIL。
> 原则：**系统已有的能力，优先调用，不要重造；跑起来验证过，才算数。**

---

## L0 环境层 · 沙箱电脑/浏览器操作（computer-use）

沙箱内置三层感知桌面操作能力（技能目录 `/root/.codebuddy/skills/computer-use/`）。
**这是最容易被第三方 Agent 忽略、也最关键的一项**——详见 [`agent-computer-guide.md`](agent-computer-guide.md)。

| 能力 | 调用 | 验证 |
|---|---|---|
| 桌面预检（一键拉起 Xvfb/浏览器/VNC） | `bash /root/.codebuddy/skills/computer-use/scripts/preflight_check.sh` | 退出码 0 |
| L1 浏览器 DOM 操作（零 token） | `computer_tool.py '{"action":"browser_goto"/"browser_snapshot"/"browser_click"/"browser_fill", ...}'` | 返回 JSON 含 url/snapshot |
| L2 全 GUI 无障碍树（零 token） | `computer_tool.py '{"action":"accessibility_tree","app_name":"chromium"}'` | 返回语义树 |
| L3 截图/键鼠（高 token，兜底） | `computer_tool.py '{"action":"screenshot"/"left_click"/"type"/"key", ...}'` | base64 图像 |
| 人类旁观窗口（noVNC） | 预检后打开 6080 端口预览 | 用户可实时观看 |

## L1 运行层 · 把系统跑起来

| 能力 | 调用 | 验证 |
|---|---|---|
| 环境一屏自检 | `pnpm doctor` | 退出码 0 无 ❌ 阻断项 |
| 数据库（PG17+pgvector） | `docker start workloom-im-pg` | health=healthy |
| 数据库迁移 | `pnpm db:migrate` | 无报错 |
| 启动双端 | `pnpm dev` → server:8787 + web:5173 | `curl -o /dev/null -w %{http_code} localhost:5173` = 200（8787 无 /healthz 属正常） |
| 演示种子 | `pnpm db:seed` | 种子回报计数 |
| 短视频域种子 | `pnpm db:seed:video` | 同上 |
| 全链路演示脚本 | `pnpm demo` | 输出各链路演示结果 |

## L2 验证层 · 质量与发布纪律（硬性）

| 能力 | 调用 | 验证 |
|---|---|---|
| 主测试套件（445 条） | `pnpm suite` | 全绿，exit 0 |
| **发布门禁（未全过禁止发布）** | `pnpm release:gate` | 全项通过，exit 1=禁止发布 |
| 五元事件验链 | `pnpm db:verify-chain` | 链完整无断点 |
| 类型检查 / 单元测试 | `pnpm typecheck` / `pnpm test` | 全绿 |

> 注意：跑测试前**先停掉 8787/5173 残留服务**——残留服务不仅致 E2E 打错库，dev 侧夜班/扩编等后台节拍产生的提案与事件还会污染套件断言。若库已被运行态数据污染：重建库 → `pnpm db:migrate && pnpm db:seed` 后重跑。

## L3 系统内自动化层 · packages/base 底座能力

| 包 | 能力 | 关键点 |
|---|---|---|
| `publish-rpa` | 全平台 RPA 发布（抖音/小红书/B站/YouTube 参考实现 + TikTok/视频号占位） | 适配器不 import playwright，注入 `BrowserDriver` 接口即可接真浏览器（接法见 agent-computer-guide §4） |
| `fence-engine` | 围栏 DSL 执行引擎（事前裁决） | 支持列表字面量/`in`/`contains`/`contains_any` |
| `captain` | L2 编排（ASK/QUEST 规划与派发） | QUEST 内容域五步拆解模板 |
| `night-shift` | 夜班自动运行 | ensureReady 幂等 |
| `model-router` | 模型路由（离线确定性模型/mock 可跑） | `TOOL_UNVERIFIED_RATE=0` 关闭扰动 |
| `workdata` | 五元事件 + RLS 工作区隔离 | 事件号源走 `biz_events_max_event_no()` SECURITY DEFINER 函数 |
| `im-channels` / `service-*` | IM 渠道 / C 端客服（对话/知识库/工单/渠道） | C 端网关 `/c/*` |
| `inspection` / `review-console` | 巡检 / 人审台 | 审批必审项由围栏驱动 |
| `asset-cms` / `cost-ledger` / `deal-flow` / `social-listening` | 资产管理 / 成本台账 / 交易流 / 社媒监听 | 见各自 README |

## L4 行业 Bundle 层 · bundles/

| Bundle | 内容 | 入口 |
|---|---|---|
| `ai-video/` | 短视频创作域 | `bundles/ai-video/` |
| `hotel/` | 酒店垂直包 | `bundles/hotel/` |

## L5 技能资产层 · skills/official/

`industry-entry`（行业接入向导）· `product-feedback`（产品反馈闭环）· `demo-mirror`（演示镜像）· `cross-platform-review`（跨端走查）· `deal-flow`（交易流）· `ripping-reverse`（拆解逆向）

## L6 演示资产层 · docs/

| 资产 | 位置 | 用途 |
|---|---|---|
| 高保真演示页（糖果色） | `docs/demo/` | 直接用浏览器打开演示 |
| 视觉规范 | `docs/design-system.md`（Candy Design System） | UI 改动必须遵守 |
| 发布清单 | `docs/release-checklist.md` | 发布前对照 |
| 融合设计 | `docs/fusion-design.md` | 架构口径 |
| 用户文档（4 篇） | `docs/01~04-*.md` | 业务口径参考 |

---

## 第三方 Agent 最容易漏掉的能力（举一反三清单）

1. **computer-use 浏览器操作**——不跑 preflight 直接 `browser_connect` 必失败。
2. **`pnpm doctor`**——环境问题排查入口。
3. **`pnpm release:gate`**——发布门禁是硬性纪律，不是可选项。
4. **`pnpm db:verify-chain`**——改事件/号源相关代码后必跑。
5. **publish-rpa 的 BrowserDriver 注入点**——系统真机发布能力的接缝，接上 CDP 即可真跑。
6. **skills/official/** + **docs/demo 演示页**——自带资产，别临时重造。
