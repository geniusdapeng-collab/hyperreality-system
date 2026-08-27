# HyperReality 能力地图（Capability Map）

> 本文是**给 AI Coding Agent 看的系统全量能力清单**。每一条都标注了「是什么 / 怎么调用 / 怎么验证」。
> 可执行版：`bash scripts/agent-tour.sh [--full]`——按本清单逐项自检并打印 PASS/FAIL。
> 原则：**系统已有的能力，优先调用，不要重造；跑起来验证过，才算数。**
> 维护纪律：其他 Agent 会持续迭代本仓；改完能力面（脚本/包/技能/演示页）必须同步更新本文。最近全量审计：2026-08-26。

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
| 屏幕录制 | `start_recording` → 操作 → `stop_recording` | `/workspace/computer-use-recordings/` |

### L0+ 生产级 computer-use（packages/base/computer-use/，2026-08 新增）

沙箱能力的生产移植版 + 两项增强，用于专用工作站部署（数字员工的"身体"）。
详见 [`computer-use-production.md`](computer-use-production.md) 与模块 README（`packages/base/computer-use/README.md`）。

| 能力 | 调用 | 验证 |
|---|---|---|
| 工作站一键安装/预检（去硬编码，路径可配） | `pnpm computer:preflight`（toolkit/preflight_check.sh，env COMPUTER_USE_INSTALL_DIR） | 退出码 0 |
| 任意动作执行（65 个，CLI 透传） | `pnpm computer '{"action":"browser_snapshot"}'` | 返回 JSON |
| HTTP 远程驱动服务（增强，大脑/手分离） | `COMPUTER_USE_TOKEN=<令牌> pnpm computer:serve` → POST :9763/action | /health 探活 + 401 鉴权 |
| MCP server（增强，Agent 原生发现） | `pnpm computer:mcp`（stdio JSON-RPC，4 tools） | initialize/tools/list 握手 |
| publish-rpa 驱动注入 | `asPublishRpaDriver(new ToolkitDriver())`（driver.ts） | BrowserDriver 同形接口 |
| 端到端冒烟（12 项，需图形环境） | `pnpm computer:smoke` | PASS=12 FAIL=0 |
| 单测（CI 安全，8 例） | `pnpm vitest run packages/base/computer-use` | 全绿 |

## L1 运行层 · 把系统跑起来

| 能力 | 调用 | 验证 |
|---|---|---|
| **三端全貌一键预览（首启强制）** | `pnpm preview:all`（scripts/preview-all.sh）→ PC:3000 / B移动:3001（高保真+手机壳）/ C移动:3002（H5 服务前台），强制 Mock 模式 | 三端均可访问，验收见 `PREVIEW_CHECKLIST.md` |
| 环境一屏自检 | `pnpm doctor`（scripts/doctor.sh） | 退出码 0 无 ❌ 阻断项 |
| 数据库（PG17+pgvector） | `docker start workloom-im-pg`（初始建库见 `docker-compose.yml`） | health=healthy |
| 数据库迁移 | `pnpm db:migrate` | 迁移版本号推进无报错 |
| 开发双端 | `pnpm dev` → server:8787（tRPC `/trpc/*`）+ web:5173（启动提示 scripts/dev-note.js） | `curl -o /dev/null -w %{http_code} localhost:5173` = 200（8787 无 /healthz 属正常） |
| 一键启动（替代入口） | `bash scripts/start.sh`（macOS/Linux；自动补 .env） | 双端就绪 |
| 停止 | `bash scripts/stop.sh` | 端口释放 |
| 数据重置（回干净演示集） | `bash scripts/reset.sh` | 云栖酒店数据集复位 |
| 无 docker 环境重建 | `bash scripts/devbox.sh`（用户态，无需 root/docker） | 环境可用 |
| 酒店获客演示种子 | `pnpm db:seed` | 种子回报事件/员工/对象/知识库 385 问计数 |
| 短视频域种子 | `pnpm db:seed:video` | 同上 |
| 全链路演示脚本 | `pnpm demo` | 输出各链路演示结果 |
| 视频域 E2E 演示剧本 | `pnpm exec tsx --env-file=.env scripts/demo-video.ts` | 视频经理链路演示输出 |
| Mock 数据统一口径 | `mock/README.md` | 三端共享同一数据源 |

## L2 验证层 · 质量与发布纪律（硬性）

| 能力 | 调用 | 验证 |
|---|---|---|
| 主测试套件（445 条） | `pnpm suite` | 全绿，exit 0 |
| **发布门禁（未全过禁止发布）** | `pnpm release:gate` | 全项通过，exit 1=禁止发布 |
| 五元事件验链 | `pnpm db:verify-chain` | 链完整无断点 |
| C 端服务台 HTTP 冒烟 | `node scripts/e2e-service-c.mjs`（node 直连，不经 vitest） | 全项通过 |
| dsh headless 回归门禁 | `bash scripts/dsh-gate.sh`（kill -9 重放验收） | 退出码 0 |
| 服务台评估（金标集） | `node scripts/eval/service-c-eval.mjs`（golden-set.json，报告入 scripts/eval/report/） | 命中率达标 |
| 类型检查 / 单元测试 | `pnpm typecheck` / `pnpm test` | 全绿 |
| 能力巡游（本地图可执行版） | `bash scripts/agent-tour.sh [--full]` | PASS 全绿 |

> 注意：跑测试前**先停掉 8787/5173 残留服务**——残留服务不仅致 E2E 打错库，dev 侧夜班/扩编等后台节拍产生的提案与事件还会污染套件断言（实测 R-26 误报）。若库已被运行态数据污染：`bash scripts/reset.sh` 或重建库 → `pnpm db:migrate && pnpm db:seed` 后重跑。

## L3 底座包层 · packages/

系统**自身**内置的自动化机制，改代码时优先复用，不要绕过：

### packages/base/（业务底座）

| 包 | 能力 | 关键点 |
|---|---|---|
| `publish-rpa` | 全平台 RPA 发布（抖音/小红书/B站/YouTube 参考实现 + TikTok/视频号占位） | 适配器不 import playwright，注入 `BrowserDriver` 接口即可接真浏览器（接法见 agent-computer-guide §4） |
| `fence-engine` | 围栏 DSL 执行引擎（事前裁决） | 支持列表字面量/`in`/`contains`/`contains_any`；缺失路径比较语境宽容 |
| `captain` | L2 编排（ASK/QUEST 规划与派发） | QUEST 内容域五步拆解模板 |
| `night-shift` | 夜班自动运行（离线任务推进） | ensureReady 幂等 |
| `model-router` | 模型路由（离线确定性模型/mock 可跑） | `TOOL_UNVERIFIED_RATE=0` 关闭扰动 |
| `workdata` | 五元事件 + RLS 工作区隔离 + 记忆/检索 | 事件号源走 `biz_events_max_event_no()` SECURITY DEFINER 函数 |
| `im-channels` | IM 渠道（企微等出入站） | 通道驱动可 mock；插件安装见 scripts/install-im-channels.sh |
| `service-channels` / `service-dialog` / `service-kb` / `service-ticket` | C 端客服四件：渠道/对话/知识库/工单 | C 端网关 `/c/*`；知识库 385 问预置 |
| `inspection` / `review-console` | 巡检 / 人审台 | 审批必审项由围栏驱动 |
| `asset-cms` / `cost-ledger` / `deal-flow` / `social-listening` | 资产管理 / 成本台账 / 交易流 / 社媒监听 | 见各自 README |
| `bundles` | Bundle 装配器（preset/围栏/技能/触发器装载） | 装配在 RLS 属地工作区内执行 |
| `skills` | 技能安装/卸载/灰度/冲突检测 | 签名源与资产复用校验 |
| `tenancy` | 租户/工作区/成员 + 演示 token | signDemoToken/verifyToken |
| `wizard` | 落地向导（接真实数据） | docs/02 配套 |
| `testing` | 测试工具基座 | 套件共用 |

### packages/ 其他

| 包 | 能力 |
|---|---|
| `db` | 全部 SQL 迁移（0001~0017+，sha256 漂移拒跑） |
| `runtime` | 意图路由（规则+LLM 分类器）、QUEST 执行、L3 工具注册 |
| `shared` | 跨端共享类型/工具 |
| `video-studio` | 视频成片管线（ai-video 域配套） |

## L4 行业 Bundle 层 · bundles/

| Bundle | 内容 | 入口 |
|---|---|---|
| `hotel/` | 酒店垂直包 |
| `ai-video/` | 短视频创作域 | `bundles/ai-video/` |

## L5 技能资产层 · skills/official/

系统自带的可复用技能（Agent 可按各 SKILL.md 加载执行）：

`industry-entry`（行业接入向导）· `product-feedback`（产品反馈闭环）· `demo-mirror`（演示镜像）· `cross-platform-review`（跨端走查）· `deal-flow`（交易流）· `ripping-reverse`（拆解逆向）

## L6 演示/发布/运维资产层

| 资产 | 位置/调用 | 用途 |
|---|---|---|
| 高保真演示页（6 页，糖果色） | `docs/demo/`，经 `pnpm preview:all` :3001 + 手机壳 `shell.html` 预览 | 三端演示 |
| 三端验收清单 | `PREVIEW_CHECKLIST.md` | preview:all 验收口径 |
| 官网静态站 | `apps/site/`（index.html / en.html / shots） | 对外产品故事 |
| Mac 桌面包 | `apps/desktop/HyperReality.app`；打包 `bash scripts/pack-macos.sh` | 桌面发行（RPA 真机发布载体） |
| 发布脚本 | `bash scripts/release.sh` | 版本发布流程 |
| IM 通道插件安装 | `bash scripts/install-im-channels.sh` | dsh-im 通道接入 |
| TTL 生命周期清扫 | `pnpm exec tsx --env-file=.env scripts/cleanup-ttl.ts` | 过期数据清理 |
| 变更记录 | `CHANGELOG.md` | 版本口径 |
| 视觉规范 | `docs/design-system.md`（Candy Design System v1.0） | UI 改动必须遵守 |
| 发布清单 | `docs/release-checklist.md` | 发布前对照 |
| 用户文档（4 篇） | `docs/01~04-*.md` | 业务口径参考 |

---

## 第三方 Agent 最容易漏掉的能力（举一反三清单，全量审计版）

1. **computer-use 浏览器操作**——不跑 preflight 直接 `browser_connect` 必失败，系统跑起来也从没被真正打开看过。
2. **`pnpm preview:all`**——三端全貌唯一入口，只起 dev 只能看到 PC 一端。
3. **`pnpm doctor`**——环境问题排查入口，比盲目重装快得多。
4. **`pnpm release:gate`** + **`bash scripts/dsh-gate.sh`**——发布门禁与 dsh 回归门禁都是硬性纪律。
5. **`pnpm db:verify-chain`**——改事件/号源相关代码后必跑。
6. **`node scripts/e2e-service-c.mjs` / `scripts/eval/`**——C 端服务台的冒烟与金标评估，改 service-* 包后必跑。
7. **publish-rpa 的 BrowserDriver 注入点**——系统真机发布能力的接缝，接上 CDP 即可真跑。
8. **`scripts/reset.sh`**——演示数据被污染后的一键复位，别手工清库。
9. **skills/official/**——仓库自带技能，别在外面临时发明流程。
10. **apps/site 官网 + docs/demo 演示页**——向人展示系统时直接用，不用现做 PPT。
11. **`bash scripts/devbox.sh`**——无 docker/root 环境的替代重建路径。
12. **`scripts/cleanup-ttl.ts`**——TTL 数据清扫，验证生命周期逻辑时使用。
