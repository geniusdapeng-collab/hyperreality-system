# WorkLoom 开源组件清单 · hyperreality-system

<!-- 自动生成，请勿手改：node scripts/oss-inventory.mjs --write -->

> 生成器：`scripts/oss-inventory.mjs`（离线事实）＋ `scripts/oss-watch.sh`（上游最新版本）
> 仓库：workloom-ai/hyperreality-system ｜ 最近一次上游扫描：2026-09-19T03:13:55.000Z
> 统计：登记组件 91 个 ｜ npm 直接依赖 155 个 ｜ Python 依赖 5 个 ｜ 容器镜像 2 个

## 0. 维护机制（四件事）

| 时机 | 动作 | 命令 |
|---|---|---|
| 依赖变更（改 package.json / lockfile / requirements） | CI 门禁：清单必须同步刷新，否则红灯 | `pnpm oss:check` |
| 每周（CNB crontab + 基座审计任务） | 扫描上游最新版本，有更新则进更新计划并开 PR | `pnpm oss:watch` |
| 安全事件（CVE / 供应链投毒） | 不等周期，立即全量扫描 | `pnpm oss:watch --all` |
| 发布前 | 复核清单新鲜度与更新计划 | `pnpm oss:plan` |

升级纪律：**扫描自动；升级走独立 PR（按 `docs/oss-update-plan.md` 组批 + 门禁 + 协议 §1/§9.5 合并），破坏性/大版本升级按 §3 人审放行**。

## 1. 登记组件（治理清单 · 人工登记 + 自动探测当前版本 + 自动扫描上游最新版本）

| # | 组件 | 开源地址 / 许可 | 当前使用版本 | 上游最新 | 状态 | 使用位置 | 注意事项 |
|---|---|---|---|---|---|---|---|
| 1 | DeepSeek Harness（dsh） | [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · MIT | 0.1.2-rc.1 | **0.1.5-rc.2** ⬆ | 运行时 | vendor/dsh（审计基线）、packages/runtime/dsh-gate（锁定运行时） | Agent 运行时地基：锁版 + 内部 fork 镜像，任何新版本（含 rc 预发布）即触发升级；永远单独一批，必过 E6 回归与 H-5 kill -9 重放；升级前必须 diff 依赖树（0.1.2-rc.1 已移除 node-pty；rc.2 起要求 Node ≥24 的 zstd API） |
| 2 | Cordis（插件元框架） | [github.com/cordiverse/cordis](https://github.com/cordiverse/cordis) · MIT | 4.0.2 | 4.0.2 | 运行时 | 随 dsh 分发（插件元框架）、packages/runtime/plugins | 插件可撤销效果是技能绑定围栏、插件卸载即撤销的运行时保证；实际版本以 dsh 锁定树为准（上游独立仓为 4.0.0-rc 线，跟随 dsh 升级） |
| 3 | Schemastery | [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · MIT | 3.18.2 | 3.18.2 | 运行时 | 随 dsh 分发（配置 schema 引擎） | 配置文件校验引擎；随 dsh 锁定树升级，不单独升级 |
| 4 | node-addon-require-builtin | [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · MIT | 0.1.6 | 0.1.6 | 运行时 | 随 dsh 分发（原生插件加载） | dsh 原生插件加载依赖；随 dsh 锁定树升级 |
| 5 | dsh-im 多平台 IM 接入插件 | [github.com/xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) · MIT | 0.2.2 | **4.21.2** ⬆ | 运行时 | vendor/dsh-im（文档锁定）、scripts/install-im-channels.sh | 钉钉/企微/飞书官方通道首批启用；安装走 pin 版本 + integrity 校验；观察名单（微信 iLink、WhatsApp baileys 等非官方协议）不启用；Slack 枚举位保留未接线 |
| 6 | Hono | [github.com/honojs/hono](https://github.com/honojs/hono) · MIT | 4.13.8 | 4.13.8 | 运行时 | apps/server | HTTP 服务层；与 @hono/node-server 同批升级 |
| 7 | @hono/node-server | [github.com/honojs/node-server](https://github.com/honojs/node-server) · MIT | 2.1.1 | 2.1.1 | 运行时 | apps/server | 随 hono 同批升级；服务端启动路径变更需过 server 契约与 E2E |
| 8 | tRPC | [github.com/trpc/trpc](https://github.com/trpc/trpc) · MIT | 11.19.0 | 11.19.0 | 运行时 | apps/server（@trpc/server）、apps/web（@trpc/client） | server/client 必须同版同批升级，跨版本混用会直接破坏三端类型契约 |
| 9 | Drizzle ORM | [github.com/drizzle-team/drizzle-orm](https://github.com/drizzle-team/drizzle-orm) · Apache-2.0 | 0.45.2 | 0.45.2 | 运行时 | packages/db（client.ts / schema.ts） | 类型源与查询构造；DDL 事实源仍是手写 SQL migrations（D5 纪律：schema.ts 只做类型映射，禁止用 drizzle-kit 生成迁移） |
| 10 | node-postgres（pg） | [github.com/brianc/node-postgres](https://github.com/brianc/node-postgres) · MIT | 8.23.0 | 8.23.0 | 运行时 | packages/db、packages/base、apps/server | PG 驱动；每个 workspace 必须同版，避免多实例连接池语义漂移 |
| 11 | Zod | [github.com/colinhacks/zod](https://github.com/colinhacks/zod) · MIT | 4.6.5 | 4.6.5 | 运行时 | apps/server、packages/base、packages/runtime | 事件与契约校验；v4 与 v3 API 差异大，升级必须全量跑契约测试 |
| 12 | jose（JWT/JWS） | [github.com/panva/jose](https://github.com/panva/jose) · MIT | 6.2.12 | 6.2.12 | 运行时 | apps/server、packages/base | 会话与租户令牌签发/校验；升级后必须过登录、跨租户越权（RLS）用例 |
| 13 | yaml | [github.com/eemeli/yaml](https://github.com/eemeli/yaml) · ISC | 2.9.0 | **2.9.1** ⬆ | 运行时 | bundle/preset 解析、skills 声明、根脚本 | bundle 与技能 YAML 解析器；与 yaml-governance（治理固定解析器）保持 2.9.0 同版 |
| 14 | js-yaml | [github.com/nodeca/js-yaml](https://github.com/nodeca/js-yaml) · MIT | 4.2.0 | **5.4.2** ⬆ | 运行时 | 随 dsh 分发（CLI 配置解析） | dsh CLI 配置解析依赖；随 dsh 锁定树升级 |
| 15 | Commander | [github.com/tj/commander.js](https://github.com/tj/commander.js) · MIT | 15.0.0 | 15.0.0 | 运行时 | 随 dsh 分发（CLI 参数） | dsh CLI 参数解析；随 dsh 锁定树升级 |
| 16 | Execa | [github.com/sindresorhus/execa](https://github.com/sindresorhus/execa) · MIT | 10.0.0 | **10.0.1** ⬆ | 运行时 | 随 dsh 分发（子进程执行） | 子进程调用封装；升级注意 ESM-only 与 Node 版本要求 |
| 17 | ws | [github.com/websockets/ws](https://github.com/websockets/ws) · MIT | 8.21.0 | **8.21.3** ⬆ | 运行时 | apps/server（实时通道） | WebSocket 服务端；升级后过实时通道与重连用例 |
| 18 | Agent Client Protocol SDK | [github.com/zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol) · Apache-2.0 | 1.4.0 | 1.4.0 | 运行时 | apps/server、packages/runtime | 外部客户端（编辑器）接入协议；协议字段演进需与 dsh 的 acp 形态联调 |
| 19 | PostgreSQL | [github.com/postgres/postgres](https://github.com/postgres/postgres) · PostgreSQL License | 17.11 | —（未扫描） | 运行时 | 桌面内嵌 PG（pack-macos / pack-windows）、docker-compose（CI/开发） | 桌面载荷内嵌 17.x（Postgres.app 2.9.6-17 / EDB 树），CI 用 pgvector/pgvector:pg17 镜像；小版本升级必须重跑迁移与 RLS 用例；服务器小版本以 PGDG 发布人工复核 |
| 20 | pgvector | [github.com/pgvector/pgvector](https://github.com/pgvector/pgvector) · PostgreSQL License | 0.8.6 | v0.8.6 | 运行时 | docker-compose 镜像 pgvector/pgvector:pg17、桌面内嵌（vector.dylib / vector.dll） | 向量检索扩展；扩展版本与 PG 主版本绑定，升级必须同时更新镜像与桌面载荷并跑检索用例 |
| 21 | NATS Server（内嵌事件总线） | [github.com/nats-io/nats-server](https://github.com/nats-io/nats-server) · Apache-2.0 | v2.11.4 | **v2.15.0** ⬆ | 随包二进制 | scripts/embedded-nats.mjs、pack-macos / pack-windows（随包二进制）、apps/desktop/electron/bootstrap.cjs | 官方二进制 pin 版本 + 校验下载；桌面端以 JetStream 形态拉起；二进制缺失时显式降级 memory 形态（事件总线不是启动阻断项）；升级需复核事件重放与 outbox 语义 |
| 22 | SQLite（经 dsh 会话索引） | [github.com/sqlite/sqlite](https://github.com/sqlite/sqlite) · Public Domain | 随 dsh（Node 内建 sqlite，无独立版本） | —（未扫描） | 运行时 | @deepseek-ai/dsh-session-query-sqlite（随 dsh） | 会话检索索引；由 dsh 内部使用 Node 内建 sqlite，无第三方 npm 依赖；升级随 dsh 批次 |
| 23 | Redis（事件总线备选后端） | [github.com/redis/redis](https://github.com/redis/redis) · RSALv2 / SSPLv1 / AGPLv3 | 适配器已实现（自研 RESP2 客户端），服务未部署 | 8.10.2 | 停车场（已选型未引入） | packages/base/event-bus/adapters/redis.ts（生产备选） | ⚠ 许可证非 OSI 标准许可：只允许独立服务进程形态，不得链接进分发包；实现走自研 RESP2（node:net），不引入第三方 redis 客户端；启用前必须过崩溃恢复（PEL/XPENDING）与延迟队列用例 |
| 24 | React | [github.com/facebook/react](https://github.com/facebook/react) · MIT | 19.2.8 | **19.3.0** ⬆ | 运行时 | apps/web、apps/webc、apps/webb、packages/ui | React 19；与 react-dom、@types/react 同批升级；升级后必须过三端视觉与交互门禁 |
| 25 | react-dom | [github.com/facebook/react](https://github.com/facebook/react) · MIT | 19.2.8 | **19.3.0** ⬆ | 运行时 | apps/web、apps/webc、apps/webb | 必须与 react 严格同版 |
| 26 | React Router | [github.com/remix-run/react-router](https://github.com/remix-run/react-router) · MIT | 8.4.0 | 8.4.0 | 运行时 | apps/web | 路由与数据加载；大版本升级需核对路由表与深链（含 bare 路由返回出口） |
| 27 | TanStack Query | [github.com/TanStack/query](https://github.com/TanStack/query) · MIT | 5.103.1 | 5.103.1 | 运行时 | apps/web | 服务端状态缓存；升级复核轮询失效策略（心跳类页面） |
| 28 | Vite | [github.com/vitejs/vite](https://github.com/vitejs/vite) · MIT | 8.3.0 | 8.3.0 | 开发/构建 | apps/web、apps/webc、apps/webb | 构建工具链；与 @vitejs/plugin-react、@tailwindcss/vite 同批联动；v8 走 rolldown 内核，升级后必须过三端生产构建 |
| 29 | @vitejs/plugin-react | [github.com/vitejs/vite-plugin-react](https://github.com/vitejs/vite-plugin-react) · MIT | 6.1.1 | 6.1.1 | 开发/构建 | apps/web、apps/webc、apps/webb | 与 vite 同批升级 |
| 30 | Tailwind CSS | [github.com/tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) · MIT | 4.3.3 | 4.3.3 | 开发/构建 | apps/web、apps/webc、apps/webb、packages/ui | v4 令牌制；升级后必须过 Candy 设计系统纯色验证与三端视觉基线 |
| 31 | @tailwindcss/vite | [github.com/tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) · MIT | 4.3.3 | 4.3.3 | 开发/构建 | apps/web、apps/webc、apps/webb | 必须与 tailwindcss 严格同版 |
| 32 | three.js | [github.com/mrdoob/three.js](https://github.com/mrdoob/three.js) · MIT | 0.186.0 | 0.186.0 | 运行时 | apps/web（3D 舞台/数字人） | 3D 渲染；与 @react-three/fiber、drei、postprocessing、three-stdlib 同批升级（版本矩阵敏感），升级后必须过真实渲染截图 |
| 33 | @react-three/fiber | [github.com/pmndrs/react-three-fiber](https://github.com/pmndrs/react-three-fiber) · MIT | 9.7.0 | 9.7.0 | 运行时 | apps/web | React 19 适配线；与 three 主版本绑定，同批升级 |
| 34 | @react-three/drei | [github.com/pmndrs/drei](https://github.com/pmndrs/drei) · MIT | 10.7.8 | 10.7.8 | 运行时 | apps/web | 随 fiber/three 同批升级 |
| 35 | @react-three/postprocessing | [github.com/pmndrs/react-postprocessing](https://github.com/pmndrs/react-postprocessing) · MIT | 3.1.1 | 3.1.1 | 运行时 | apps/web | 后处理特效；随 three 同批升级 |
| 36 | three-stdlib | [github.com/pmndrs/three-stdlib](https://github.com/pmndrs/three-stdlib) · MIT | 2.36.1 | 2.36.1 | 运行时 | apps/web | three 官方 examples 的 TS 移植；与 three 主版本对齐 |
| 37 | pixi.js | [github.com/pixijs/pixijs](https://github.com/pixijs/pixijs) · MIT | 6.5.10 | **8.21.0** ⬆ | 运行时 | apps/web（数字人/2D 舞台） | 当前锁 v6 线（pixi-live2d-display 兼容上限）；升级 v7/v8 必须同步替换 live2d 显示层 |
| 38 | pixi-live2d-display | [github.com/guansss/pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) · MIT | 0.4.0 | 0.4.0 | 运行时 | apps/web（Live2D 数字人） | 0.4.0 仅支持 pixi v6 线；升级前先确认上游是否已适配 pixi v7+，否则锁版不动 |
| 39 | Electron | [github.com/electron/electron](https://github.com/electron/electron) · MIT | 44.1.1 | **44.4.2** ⬆ | 运行时 | apps/desktop | 桌面壳（正式产品形态）；升级必须过打包载荷校验、真实窗口响应式与托盘/夜班行为验收 |
| 40 | electron-builder | [github.com/electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) · MIT | 26.15.3 | 26.15.3 | 开发/构建 | apps/desktop（打包/签名） | 安装包与签名链路；升级后过 app:pack / app:dist 与发布资产校验 |
| 41 | Playwright | [github.com/microsoft/playwright](https://github.com/microsoft/playwright) · Apache-2.0 | 1.63.0 | 1.63.0 | 开发/构建 | 三端 E2E（apps/*）、packages/base/computer-use/toolkit（Python 版，随工具链安装） | E2E 与 computer-use 浏览器驱动共用；升级必须重建 Linux 视觉基线（CNB ui-gate 在同一镜像内跑）；Python 侧版本由 toolkit/requirements.txt 约束 |
| 42 | @axe-core/playwright | [github.com/dequelabs/axe-core-npm](https://github.com/dequelabs/axe-core-npm) · MPL-2.0 | 未引入 | 4.13.0 | 开发/构建 | 三端无障碍门禁 | 与 @playwright/test 版本矩阵敏感，同批升级 |
| 43 | Vitest | [github.com/vitest-dev/vitest](https://github.com/vitest-dev/vitest) · MIT | 3.2.0 / 4.1.11 / 5.0.1 | **5.0.1** ⬆ | 开发/构建 | packages/*、apps/server | 各 workspace 版本需对齐（历史存在 v3/v4 混用）；升级后全量跑 pnpm test |
| 44 | tsx | [github.com/privatenumber/tsx](https://github.com/privatenumber/tsx) · MIT | 4.23.12 / 4.23.13 | **4.23.13** ⬆ | 开发/构建 | 根脚本、apps/server | TS 直跑器；升级后过 db:migrate/db:seed 与 server 启动 |
| 45 | TypeScript | [github.com/microsoft/TypeScript](https://github.com/microsoft/TypeScript) · Apache-2.0 | 5.9.0 / 7.0.2 | **7.0.2** ⬆ | 开发/构建 | 全仓 typecheck | 7.0 原生化工具链；部分包仍锁 5.9（治理/UI 消费校验），升级按包分批，避免一次全仓 |
| 46 | typescript-governance（别名固定解析器） | [github.com/microsoft/TypeScript](https://github.com/microsoft/TypeScript) · Apache-2.0 | 5.9.3 | —（未扫描） | CI/流水线 | UI 治理/消费校验固定解析器（npm:typescript@5.9.3） | 治理脚本的固定解析器，不随主 TypeScript 升级；改动需与 sync/install-ui-governance.mjs 的 dependency 声明同步 |
| 47 | yaml-governance（别名固定解析器） | [github.com/eemeli/yaml](https://github.com/eemeli/yaml) · ISC | 2.9.0 | —（未扫描） | CI/流水线 | UI 治理脚本固定 YAML 解析器（npm:yaml@2.9.0） | 与 sync/base-scope.json#uiGovernanceCapability.yamlDependency 保持同版 |
| 48 | concurrently | [github.com/open-cli-tools/concurrently](https://github.com/open-cli-tools/concurrently) · MIT | 9.2.4 | **10.0.5** ⬆ | 开发/构建 | pnpm dev（多进程编排） | 开发编排；升级不影响生产载荷 |
| 49 | jsdom | [github.com/jsdom/jsdom](https://github.com/jsdom/jsdom) · MIT | 30.1.0 | 30.1.0 | 开发/构建 | 前端单测环境 | DOM 测试环境；升级后跑三端单测 |
| 50 | esbuild | [github.com/evanw/esbuild](https://github.com/evanw/esbuild) · MIT | 未引入 | 0.28.2 | 运行时 | 桌面运行载荷（native 构建产物随包） | 传递依赖（vite/tsx 链路）随包分发；桌面载荷锁三平台二进制，升级必须重跑 runtime:deps:refresh + 载荷边界校验 |
| 51 | rolldown | [github.com/rolldown/rolldown](https://github.com/rolldown/rolldown) · MIT | 未引入 | 1.2.9 | 开发/构建 | vite 8 打包内核（native 二进制） | 随 vite 升级；桌面载荷含三平台绑定，注意 onlyBuiltDependencies 白名单 |
| 52 | lightningcss | [github.com/parcel-bundler/lightningcss](https://github.com/parcel-bundler/lightningcss) · MPL-2.0 | 未引入 | 1.33.0 | 开发/构建 | vite 8 CSS 管线（native 二进制） | 随 vite 升级；MPL 属弱 copyleft，仅构建期使用，不分发源码 |
| 53 | @tailwindcss/oxide | [github.com/tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) · MIT | 未引入 | 4.3.3 | 开发/构建 | tailwind v4 原生引擎（native 二进制） | 与 tailwindcss 同批升级；三平台二进制进载荷白名单 |
| 54 | LiteLLM Proxy | [github.com/BerriAI/litellm](https://github.com/BerriAI/litellm) · MIT | 停车场（VPC 模型网关未接入运行时） | 1.43.10 | 停车场（已选型未引入） | 模型网关（VPC 本地模型/第三方聚合，规划位） | ⚠ 2026-03 PyPI 供应链投毒（1.82.7/1.82.8）+ CVE-2026-42208 SQL 注入（修复于 1.83.7，CISA KEV 在列）：接入时强制镜像哈希 pin + cosign 验签 + 仅内网监听 + 虚拟密钥分域轮换；安全告警即查不等周期 |
| 55 | mem0 | [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) · Apache-2.0 | 停车场（组织记忆现由自研 workdata 承担） | 0.0.18 | 停车场（已选型未引入） | 组织记忆引擎（规划位） | ★ 当前组织记忆由自研 workdata 实现；若引入，必须保留自有归因/脱敏层，且只作独立服务进程 |
| 56 | Microsoft Presidio | [github.com/microsoft/presidio](https://github.com/microsoft/presidio) · MIT | 停车场（D7 决策：中文 PII 用薄自研正则 + 占位符协议替代） | 2.2.355 | 停车场（已选型未引入） | PII 识别与脱敏（规划位） | ★ 现网走自研中文 PII 正则（零出站）；引入 Presidio 时必须作为独立服务进程，且出站脱敏强制段保持不变 |
| 57 | Langfuse | [github.com/langfuse/langfuse](https://github.com/langfuse/langfuse) · MIT（ee/ 目录除外） | 停车场（观测导出按 OTEL GenAI 语义预留契约） | v4.38.0 | 停车场（已选型未引入） | 可观测性/评测平台（规划位） | 2026-01 被 ClickHouse 收购；v3 自托管 footprint 重（PG+ClickHouse+Redis+S3），边缘节点只按轻量导出契约对接；ee/ 目录为商业许可，不得使用 |
| 58 | DeepEval | [github.com/confident-ai/deepeval](https://github.com/confident-ai/deepeval) · Apache-2.0 | 停车场（评测数据飞轮长期预留） | 1.0.0 | 停车场（已选型未引入） | LLM 回归评测（规划位） | 长期预留：审批手势/驳回原因/轨迹回放已沉淀在消息流，按导出契约接评测，不提前建设管道 |
| 59 | Promptfoo | [github.com/promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) · MIT | 停车场（红队/多模型对比，规划位） | 0.123.1 | 停车场（已选型未引入） | LLM 红队评测（规划位） | 仅作 CI 评测工具（devDependency 形态），不进运行时载荷 |
| 60 | Stagehand | [github.com/browserbase/stagehand](https://github.com/browserbase/stagehand) · MIT | 停车场（L3 执行面主路径剧本，规划位） | 4.1.0 | 停车场（已选型未引入） | 浏览器自动化分层执行面（L3 剧本） | L3 主路径：确定性代码 + LLM 局部决策；接入时须走 PlatformAdapter 统一抽象，禁止业务直接 import |
| 61 | browser-use | [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use) · MIT | 停车场（L4 冷启动探索，规划位） | 0.13.10 | 停车场（已选型未引入） | 浏览器自动化分层执行面（L4 探索） | 只用于新平台冷启动，探明后必须固化为 L3 剧本；不得直接进生产主路径 |
| 62 | Skyvern | [github.com/Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern) · AGPL-3.0 | 停车场（视觉抗改版降级路径，规划位） | 1.0.48 | 停车场（已选型未引入） | 浏览器自动化（视觉驱动降级路径） | ⚠ AGPL-3.0：只允许独立进程形态，禁止链接进分发包；启用前过法务与出站声明 |
| 63 | computer-use（vendored 工具箱） | [github.com/anthropics/anthropic-quickstarts](https://github.com/anthropics/anthropic-quickstarts) · MIT | repo-vendored-2026-08 | —（未扫描） | 运行时 | packages/base/computer-use（三层感知：CDP/AXTree/截图） | vendored 进仓并本地加固；上游为参考实现（无版本号），升级=人工比对；生产部署纪律见 docs/computer-use-production.md；publish-rpa 的 BrowserDriver 上游 |
| 64 | SRT Whiteboard Animation（手绘白板渲染器，随仓分发） | [github.com/geeklee/srt-whiteboard-animation](https://github.com/geeklee/srt-whiteboard-animation) · MIT | kit-696a724 | —（未扫描） | 运行时 | scripts/whiteboard/engine（补丁后的上游渲染脚本：parse_srt / render_stream_whiteboard / stream_render / merge_scenes / render_annotation_preview / prepare_env）、scripts/whiteboard/lib + film.mts（本仓扩展：编排 / 分句配音 / 分幕 / 标注 / 混流）、scripts/whiteboard/lineart_tools.py（本仓扩展：sketch / analyze / check / hand） | 字幕驱动的手绘白板渲染器：本地确定性 CPU 渲染、零 API 依赖、MIT 可商用。Python 依赖闭包见 scripts/whiteboard/engine/requirements.txt（opencv-python/numpy/PyAV/Pillow，全部宽松许可）；venv 由 scripts/whiteboard/engine-install.mts 幂等安装、不入库。本能力自带全部依赖，不要求宿主仓有视频制作子系统 |
| 65 | BrowserAct 技能包 | [github.com/browser-act/skills](https://github.com/browser-act/skills) · MIT | 观察项（技能市场执行面技能，L2 审批安装） | —（未扫描） | 观察项 | skills/registry/browser-act（执行面技能·可选） | freemium 云依赖（stealth/代理/打码付费）：适配纪律 proxyMode=custom-only、凭据留在客户本机、出站 api.browseract.com 全声明；未进入默认运行时 |
| 66 | Tencent BrowserSkill | [github.com/Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) · MIT | 观察项（2026-08-26 评估：Borrow 协议可借鉴） | cli-v0.3.0 | 观察项 | 浏览器桥接对照组（publish-rpa 权限模型参照） | 只作对照评估，暂不入运行时；publish-rpa 真机发布的权限模型参照对象 |
| 67 | Scrapling | [github.com/D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling) · BSD-3-Clause | 观察项（技能市场执行面技能） | v0.4.15 | 观察项 | skills/registry/scrapling-collector（纯本地零出站） | 纯本地零出站采集技能；经 skill:forge 集成，随技能市场分发 |
| 68 | OpenAdapt | [github.com/OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) · MIT | 停车场（录制回放/流程固化规划位） | v1.16.0 | 停车场（已选型未引入） | 流程固化（人工流程→确定性剧本） | 与意识系统构成「检测高频任务→建议固化→录制编译→剧本上线」管道，未接运行时 |
| 69 | Agent-S3（gui-agents） | [github.com/simular-ai/Agent-S](https://github.com/simular-ai/Agent-S) · Apache-2.0 | 停车场（桌面 GUI 操控对照实现） | v0.3.2 | 停车场（已选型未引入） | 桌面 GUI 操控（对照/备选） | 与自有 computer-use 能力对照复核；若引入只作独立进程，虚拟输入通道不得劫持真实鼠标 |
| 70 | WrenAI | [github.com/Canner/WrenAI](https://github.com/Canner/WrenAI) · Apache-2.0 | 停车场（G1 消息图谱 NL 检索：现走薄自译 NL→结构化过滤器） | wren-core-py-v0.8.0 | 停车场（已选型未引入） | 消息图谱 NL 检索（规划位） | 只允许使用其 governed text-to-SQL 引擎能力，且必须独立进程；现网结构回归由薄自译实现承担 |
| 71 | Lago | [github.com/getlago/lago](https://github.com/getlago/lago) · AGPL-3.0 | 停车场（计量计费由自研计量承担） | v1.53.0 | 停车场（已选型未引入） | 计量计费（可选独立进程） | ⚠ AGPL-3.0 独立部署；现网计量=自研遥测 seam 逐消息 + 账单投影，未引入 |
| 72 | E2B（执行沙箱 SDK） | [github.com/e2b-dev/E2B](https://github.com/e2b-dev/E2B) · Apache-2.0 | 停车场（不可信代码执行隔离规划位） | e2b@2.51.0 | 停车场（已选型未引入） | 执行沙箱（SaaS 默认形态规划） | 若启用 SaaS 形态，客户代码外发必须经出站声明与审批；首选仍是本地沙箱策略 |
| 73 | Daytona | [github.com/daytonaio/daytona](https://github.com/daytonaio/daytona) · AGPL-3.0 | 停车场（VPC 自托管沙箱规划位） | v0.190.0 | 停车场（已选型未引入） | 执行沙箱（VPC 自托管，Kata 强化隔离） | ⚠ AGPL-3.0 独立进程；仅在客户 VPC 内自托管形态评估 |
| 74 | Tauri | [github.com/tauri-apps/tauri](https://github.com/tauri-apps/tauri) · Apache-2.0 / MIT | 停车场（桌面壳候选，正式形态已选 Electron） | tauri-v3.0.0-alpha.1 | 停车场（已选型未引入） | 桌面壳（候选） | 双轨 tag（tauri-v2.x / v1.x）需 tag_prefix 收敛；当前桌面形态为 Electron，Tauri 仅保留为低配门店候选 |
| 75 | Taro | [github.com/NervJS/taro](https://github.com/NervJS/taro) · MIT | 停车场（小程序端候选，移动端现走响应式 Web） | 4.2.1 | 停车场（已选型未引入） | 微信小程序（候选） | 若启用需一套 React 码出小程序（只读+审批+一键暂停），当前未接入 |
| 76 | CopilotKit | [github.com/CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit) · MIT | 停车场（Agent 卡片/审批组件候选） | 1.72.0 | 停车场（已选型未引入） | Agent 对话/审批组件（候选） | 仅作组件库复用（AG-UI 协议），消息流必须由 dsh 承接；引入前核对与自有 review-console 的边界 |
| 77 | ECharts | [github.com/apache/echarts](https://github.com/apache/echarts) · Apache-2.0 | 停车场（工作台图表候选，现网图表为自研轻量组件） | 6.1.0 | 停车场（已选型未引入） | 工作台图表（候选） | 体积较大（需按需引入）；若引入需过三端视觉门禁与首屏预算 |
| 78 | TipTap | [github.com/ueberdosis/tiptap](https://github.com/ueberdosis/tiptap) · MIT | 停车场（写作编辑器候选） | 3.31.3 | 停车场（已选型未引入） | 工作台写作编辑器（候选） | 编辑器事务→防抖合并→事件流的约定在引入时必须保留（文档即事件） |
| 79 | SheetJS | [git.sheetjs.com/sheetjs/sheetjs](https://git.sheetjs.com/sheetjs/sheetjs) · Apache-2.0 | 停车场（表格导入导出候选） | 0.18.5 | 停车场（已选型未引入） | 数据表格导入导出（候选） | npm 上的 xlsx 为旧版快照，官方已迁至自建源（cdn.sheetjs.com）；引入时从官方源锁定版本 |
| 80 | PptxGenJS | [github.com/gitbrent/PptxGenJS](https://github.com/gitbrent/PptxGenJS) · MIT | 停车场（现网用 python-pptx 服务端生成） | 4.0.1 | 停车场（已选型未引入） | 工作台幻灯片导出（候选） | 若引入，与 python-pptx 二选一，避免两套 PPT 生成链路 |
| 81 | Fabric.js | [github.com/fabricjs/fabric.js](https://github.com/fabricjs/fabric.js) · MIT | 停车场（设计画布候选） | 7.4.0 | 停车场（已选型未引入） | 设计画布（候选） | 注意与自研 dev-bridge/devfabric 命名区分（同名非同一组件）；Canvas 性能需在低配门店 PC 验证 |
| 82 | WeasyPrint | [github.com/Kozea/WeasyPrint](https://github.com/Kozea/WeasyPrint) · BSD-3-Clause | 停车场（服务端 PDF 渲染候选，现网审计导出为自研） | 62.3 | 停车场（已选型未引入） | 审计报告 PDF 服务端渲染（候选） | 引入前提：确定性渲染 ≤30s、仅独立进程（依赖系统 libpango/cairo） |
| 83 | Litestream | [github.com/benbjohnson/litestream](https://github.com/benbjohnson/litestream) · Apache-2.0 | 停车场（边缘节点 SQLite 备份候选） | v0.5.17 | 停车场（已选型未引入） | 边缘节点 SQLite 连续备份（候选） | 边缘/社区版形态未启用；启用前定义恢复演练与保留策略 |
| 84 | sqlite-vec | [github.com/asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) · MIT / Apache-2.0 | 停车场（边缘向量索引候选） | v0.1.9 | 停车场（已选型未引入） | 边缘节点向量检索（候选） | 与 pgvector 保留同一检索契约，避免双实现语义漂移 |
| 85 | SeaweedFS | [github.com/seaweedfs/seaweedfs](https://github.com/seaweedfs/seaweedfs) · Apache-2.0 | 停车场（VPC 对象存储候选） | 4.47 | 停车场（已选型未引入） | VPC 对象存储（候选） | SaaS 形态默认走云 OSS/S3；自托管仅在客户 VPC 方案中评估 |
| 86 | KayKit Adventurers（3D 素材） | [github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) · CC0-1.0 | kaykit-2026-08（5 角色 GLB + 道具） | —（未扫描） | 素材/资产 | apps/web/public/models/kaykit（真人风数字员工角色/动画） | CC0 可商用免署名；76 组骨骼动画、贴图内嵌单文件；装备节点显隐做外观差异化，新增素材需过三端渲染截图 |
| 87 | Node.js | [github.com/nodejs/node](https://github.com/nodejs/node) · MIT | 24.19.0 | **v26.9.0** ⬆ | 随包二进制 | CI 构建镜像与桌面载荷内嵌运行时 | 引擎下限 >=24（dsh 的 zstd 会话持久化要求）；桌面载荷内嵌 24.19.0，升级需重建载荷并过 app 冒烟 |
| 88 | pnpm | [github.com/pnpm/pnpm](https://github.com/pnpm/pnpm) · MIT | 10.14.0 | **12.4.2** ⬆ | 开发/构建 | 包管理与 lockfile 格式 | lockfile v9 格式；升级必须九仓同步（packageManager 字段），否则 frozen-lockfile 安装失败 |
| 89 | npm（桌面载荷安装器） | [github.com/npm/cli](https://github.com/npm/cli) · Artistic-2.0 | 11.17.0 | **12.0.2** ⬆ | 随包二进制 | .workloom-runtime-deps（受控 npm ci 安装桌面运行载荷） | 载荷安装器版本与 package-lock.json 绑定；升级需重跑 runtime:deps:refresh/verify |
| 90 | python-pptx | [github.com/scanny/python-pptx](https://github.com/scanny/python-pptx) · MIT | 按需安装（未锁定版本） | 1.0.2 | 开发/构建 | scripts/build-capability-pptx.py（能力清单 PPT 生成） | 本地工具链依赖，不随产品分发；版本未锁定属已知缺口（建议后续补 requirements 引脚） |
| 91 | Playwright（Python · computer-use 工具链） | [github.com/microsoft/playwright-python](https://github.com/microsoft/playwright-python) · Apache-2.0 | >=1.40.0 | **1.46.0** ⬆ | 开发/构建 | packages/base/computer-use/toolkit（安装脚本按 requirements 拉取） | 与 Node 侧 @playwright/test 独立版本线；浏览器二进制由 playwright install 管理，升级需同步预检脚本断言 |

## 2. 全量直接依赖（本仓事实，含上游最新）

### 2.1 npm 直接依赖（155 个，解析自 pnpm-lock.yaml）

| 包 | 当前版本 | 声明 | 类型 | 出现位置 | 上游最新 |
|---|---|---|---|---|---|
| `@agentclientprotocol/sdk` | 1.4.0（声明） | 1.4.0 | 开发 | vendor/dsh/package.json | 1.4.0 |
| `@deepseek-ai/cordis` | 4.0.2（声明） | ^4.0.2 | 生产 | vendor/dsh/package.json | 4.0.2 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.17（声明） | ^1.0.17 | 生产 | vendor/dsh/package.json | 1.0.17 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.7（声明） | ^1.0.7 | 生产 | vendor/dsh/package.json | 1.0.7 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.3（声明） | ^1.0.3 | 生产 | vendor/dsh/package.json | 1.0.3 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.4（声明） | ^1.1.4 | 生产 | vendor/dsh/package.json | 1.1.4 |
| `@deepseek-ai/dsh` | 0.1.6-alpha.2 | 0.1.6-alpha.2 | 生产 | packages/runtime/dsh-gate/package.json | 0.1.5-rc.2 |
| `@deepseek-ai/dsh-acp` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-acp-app` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.2-alpha.2 |
| `@deepseek-ai/dsh-agent` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-agent-instructions` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-agent-tool-presentation` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-app-boot` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-attachment-local` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-base` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-bash-local` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-client-ui-agent-preset` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-client-ui-cordis` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-cmdline` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-command-compact` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-command-goal` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-compaction-basic` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-cordis-client-runner` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-credentials-local` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-deepseek-llm-api-extensions` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.1.2-alpha.2 |
| `@deepseek-ai/dsh-experimental-agent-team` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | **0.1.5-alpha.2** ⬆ |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | **0.1.5-alpha.2** ⬆ |
| `@deepseek-ai/dsh-experimental-code-runtime-python` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | —（未扫描） |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | **0.1.5-alpha.2** ⬆ |
| `@deepseek-ai/dsh-fs-local` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-fs-observation-policy` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-fs-sandbox` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-goal` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-goal-round-driver` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-headless` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-home-paths` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-hooks-claude-code` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.5 |
| `@deepseek-ai/dsh-hooks-codex` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-host-frontend-static` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-host-webserver` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-jobs-local` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-launch-environment` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-llm` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-llm-deepseek` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-llm-mock-server` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-llm-pi-ai` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-llm-replay` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-loader-smoke` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-mcp-client` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-persona` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-plan-mode` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-plugin-package-inventory-deepseek` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.1.2-alpha.2 |
| `@deepseek-ai/dsh-pwsh-local` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-pwsh-sandbox` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-sandbox-local` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-sandbox-policy` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-schedule` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-sdk-app` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.2-alpha.2 |
| `@deepseek-ai/dsh-sdk-minimal` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.2-alpha.2 |
| `@deepseek-ai/dsh-session` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-session-checkpoint-policy` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-session-log-deepseek` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.1.2-alpha.2 |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-session-projection` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-session-query` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-session-reference` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-settings` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-settings-file` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-shell-env` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-skill` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-skill-filesystem` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-subagent` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-subagent-fork-in-process` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-subprocess-local` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-system-prompt` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-terminal` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-terminal-bash` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-time-context` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tmux-context` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-token-meter` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-ask-user` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-bash` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-bash-persistent` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-cordis` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-fs` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-fs-search` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-goal` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-jobs` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/dsh-tool-pwsh` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.0-rc.8 |
| `@deepseek-ai/dsh-tool-ralph` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-skill` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-str-replace-editor` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-subagent` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-subagent-control` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-todo` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-web` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tool-workflow` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-tools` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-user-approval` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 开发 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-web-app` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-webhook` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.2-alpha.2 |
| `@deepseek-ai/dsh-webhook-github` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.1.2-alpha.2 |
| `@deepseek-ai/dsh-workflow-worker-thread` | 0.1.2-rc.1（声明） | ^0.1.2-rc.1 | 生产 | vendor/dsh/package.json | 0.0.1-rc.3 |
| `@deepseek-ai/schemastery` | 3.18.2（声明） | ^3.18.2 | 生产 | vendor/dsh/package.json | 3.18.2 |
| `@hono/node-server` | 2.1.1（声明） | 2.1.1 | 生产 | .workloom-runtime-deps/package.json、apps/server/package.json | 2.1.1 |
| `@playwright/test` | 1.63.0（声明） | 1.63.0 | 开发 | apps/web/package.json | 1.63.0 |
| `@react-three/drei` | 10.7.8（声明） | ^10.7.8 | 生产 | apps/web/package.json | 10.7.8 |
| `@react-three/fiber` | 9.7.0（声明） | ^9.7.0 | 生产 | apps/web/package.json | 9.7.0 |
| `@react-three/postprocessing` | 3.1.1（声明） | ^3.1.1 | 生产 | apps/web/package.json | 3.1.1 |
| `@tailwindcss/vite` | 4.3.3（声明） | 4.3.3 | 开发/生产 | .workloom-runtime-deps/package.json、apps/web/package.json、apps/webc/package.json | 4.3.3 |
| `@tanstack/react-query` | 5.103.1（声明） | 5.103.1 | 生产 | apps/web/package.json | 5.103.1 |
| `@trpc/client` | 11.19.0（声明） | 11.19.0 | 生产 | apps/web/package.json、apps/webb/package.json | 11.19.0 |
| `@trpc/server` | 11.19.0（声明） | 11.19.0 | 生产 | .workloom-runtime-deps/package.json、apps/server/package.json | 11.19.0 |
| `@types/js-yaml` | 4.0.9（声明） | ^4.0.9 | 开发 | vendor/dsh/package.json | 4.0.9 |
| `@types/node` | 24.0.0 / 24.13.3 | ^24.0.0 | 开发 | apps/server/package.json、package.json、packages/video-studio/package.json | **26.6.1** ⬆ |
| `@types/pg` | 8.23.1（声明） | ^8.23.1 | 开发 | apps/server/package.json、packages/base/package.json、packages/db/package.json 等 4 处 | 8.23.1 |
| `@types/react` | 19.2.0（声明） | ^19.2.0 | 开发 | apps/web/package.json、apps/webb/package.json、apps/webc/package.json | **19.3.0** ⬆ |
| `@types/react-dom` | 19.2.0（声明） | ^19.2.0 | 开发 | apps/web/package.json、apps/webb/package.json、apps/webc/package.json | **19.3.0** ⬆ |
| `@types/three` | 0.186.0（声明） | ^0.186.0 | 开发 | apps/web/package.json | 0.186.0 |
| `@types/ws` | 8.18.1（声明） | 8.18.1 | 开发 | vendor/dsh/package.json | 8.18.1 |
| `@vitejs/plugin-react` | 6.1.1（声明） | 6.1.1 | 开发/生产 | .workloom-runtime-deps/package.json、apps/web/package.json、apps/webb/package.json 等 4 处 | 6.1.1 |
| `@workloom/ui` | 0.1.14（声明） | 0.1.14 | 生产 | apps/web/package.json、apps/webb/package.json、apps/webc/package.json | —（未扫描） |
| `commander` | 15.0.0（声明） | ^15.0.0 | 生产 | vendor/dsh/package.json | 15.0.0 |
| `concurrently` | 9.2.4 | ^9.1.0 | 开发 | package.json | **10.0.5** ⬆ |
| `drizzle-orm` | 0.45.2（声明） | 0.45.2 / ^0.45.2 | 生产 | .workloom-runtime-deps/package.json、packages/db/package.json | 0.45.2 |
| `electron` | 44.1.1 | ^44.1.1 | 开发 | package.json | **44.4.2** ⬆ |
| `electron-builder` | 26.15.3 | ^26.15.3 | 开发 | package.json | 26.15.3 |
| `execa` | 10.0.0（声明） | ^10.0.0 | 开发 | vendor/dsh/package.json | **10.0.1** ⬆ |
| `hono` | 4.13.8（声明） | 4.13.8 | 生产 | .workloom-runtime-deps/package.json、apps/server/package.json | 4.13.8 |
| `jose` | 6.2.12（声明） | 6.2.12 | 生产 | .workloom-runtime-deps/package.json、apps/server/package.json、packages/base/package.json | 6.2.12 |
| `js-yaml` | 4.2.0（声明） | ^4.2.0 | 生产 | vendor/dsh/package.json | **5.4.2** ⬆ |
| `jsdom` | 30.1.0 | ^30.0.1 / ^30.1.0 | 开发 | apps/web/package.json、apps/webc/package.json、package.json | 30.1.0 |
| `node-addon-require-builtin` | 0.1.4（声明） | ^0.1.4 | 生产 | vendor/dsh/package.json | **0.1.6** ⬆ |
| `pg` | 8.23.0 | 8.23.0 | 生产 | .workloom-runtime-deps/package.json、package.json、packages/base/package.json 等 5 处 | 8.23.0 |
| `pixi-live2d-display` | 0.4.0（声明） | ^0.4.0 | 生产 | apps/web/package.json | 0.4.0 |
| `pixi.js` | 6.5.10（声明） | ^6.5.10 | 生产 | apps/web/package.json | **8.21.0** ⬆ |
| `postprocessing` | 6.39.5（声明） | ^6.39.5 | 生产 | apps/web/package.json | —（未扫描） |
| `react` | 19.2.8（声明） | 19.2.8 | 生产 | apps/web/package.json、apps/webb/package.json、apps/webc/package.json | **19.3.0** ⬆ |
| `react-dom` | 19.2.8（声明） | 19.2.8 | 生产 | apps/web/package.json、apps/webb/package.json、apps/webc/package.json | **19.3.0** ⬆ |
| `react-router` | 8.4.0（声明） | 8.4.0 | 生产 | apps/web/package.json | 8.4.0 |
| `tailwindcss` | 4.3.3（声明） | 4.3.3 | 开发 | apps/web/package.json、apps/webc/package.json | 4.3.3 |
| `three` | 0.186.0（声明） | ^0.186.0 | 生产 | apps/web/package.json | 0.186.0 |
| `three-stdlib` | 2.36.1（声明） | ^2.36.1 | 生产 | apps/web/package.json | 2.36.1 |
| `tsx` | 4.23.12 / 4.23.13 | 4.23.12 / ^4.23.12 / ^4.23.13 | 开发/生产 | .workloom-runtime-deps/package.json、apps/server/package.json、package.json 等 4 处 | 4.23.13 |
| `typescript` | 5.9.0 / 7.0.2 | ^5.9.0 / ^7.0.2 | 开发 | apps/server/package.json、apps/web/package.json、apps/webb/package.json 等 12 处 | 7.0.2 |
| `typescript-governance → npm:typescript` | 5.9.3 | npm:typescript@5.9.3 | 开发 | package.json | **7.0.2** ⬆ |
| `vite` | 8.3.0（声明） | 8.3.0 | 开发/生产 | .workloom-runtime-deps/package.json、apps/web/package.json、apps/webb/package.json 等 4 处 | 8.3.0 |
| `vitest` | 3.2.0 / 4.1.11 / 5.0.1 | ^3.2.0 / ^4.1.11 / ^5.0.1 | 开发 | apps/webb/package.json、package.json、packages/audit-engine/package.json 等 8 处 | 5.0.1 |
| `ws` | 8.21.0（声明） | 8.21.0 | 开发 | vendor/dsh/package.json | **8.21.3** ⬆ |
| `yaml` | 2.9.0 | 2.9.0 | 开发/生产 | .workloom-runtime-deps/package.json、apps/server/package.json、package.json 等 4 处 | **2.9.1** ⬆ |
| `yaml-governance → npm:yaml` | 2.9.0 | npm:yaml@2.9.0 | 开发 | package.json | **2.9.1** ⬆ |
| `zod` | 4.6.5（声明） | 4.6.5 / ^4.6.5 | 生产 | .workloom-runtime-deps/package.json、apps/server/package.json、packages/base/package.json 等 7 处 | 4.6.5 |

### 2.2 Python 依赖（5 个）

| 包 | 当前版本 | 声明 | 出现位置 | 上游最新 |
|---|---|---|---|---|
| `av` | 18.1.0 | ==18.1.0 | scripts/whiteboard/engine/requirements.txt | —（未扫描） |
| `numpy` | 2.5.3 | ==2.5.3 | scripts/whiteboard/engine/requirements.txt | —（未扫描） |
| `opencv-python` | 5.0.0.93 | ==5.0.0.93 | scripts/whiteboard/engine/requirements.txt | —（未扫描） |
| `Pillow` | 12.3.0 | ==12.3.0 | scripts/whiteboard/engine/requirements.txt | —（未扫描） |
| `playwright` | >=1.40.0（下限声明） | >=1.40.0 | packages/base/computer-use/toolkit/requirements.txt | 1.46.0 |

### 2.3 容器镜像（2 个）

| 镜像 | 出现位置 |
|---|---|
| `node:24.19.0-bookworm` | .cnb.yml |
| `pgvector/pgvector:pg17` | .cnb.yml、docker-compose.yml#postgres |

### 2.4 工具链

| 项 | 版本/要求 | 来源 |
|---|---|---|
| Node.js | `>=24.0.0` | package.json#engines |
| pnpm | `pnpm@10.14.0` | package.json#packageManager |
| 桌面载荷 npm | `11.17.0` | .workloom-runtime-deps/metadata.json |
| CI 构建镜像 | `node:24.19.0-bookworm` | .cnb.yml |

## 3. 有可用更新

登记组件滞后 19 个，直接依赖滞后 18 个 —— 逐项执行单见 `docs/oss-update-plan.md`。
- `DeepSeek Harness（dsh）` 0.1.2-rc.1 → **0.1.5-rc.2**（门禁 runtime-gate）
- `dsh-im 多平台 IM 接入插件` 0.2.2 → **4.21.2**（门禁 standard）
- `yaml` 2.9.0 → **2.9.1**（门禁 standard）
- `js-yaml` 4.2.0 → **5.4.2**（门禁 standard）
- `Execa` 10.0.0 → **10.0.1**（门禁 standard）
- `ws` 8.21.0 → **8.21.3**（门禁 full）
- `NATS Server（内嵌事件总线）` v2.11.4 → **v2.15.0**（门禁 full）
- `React` 19.2.8 → **19.3.0**（门禁 full）
- `react-dom` 19.2.8 → **19.3.0**（门禁 full）
- `pixi.js` 6.5.10 → **8.21.0**（门禁 full）
- `Electron` 44.1.1 → **44.4.2**（门禁 full）
- `Vitest` 3.2.0 / 4.1.11 / 5.0.1 → **5.0.1**（门禁 standard）
- `tsx` 4.23.12 / 4.23.13 → **4.23.13**（门禁 standard）
- `TypeScript` 5.9.0 / 7.0.2 → **7.0.2**（门禁 smoke）
- `concurrently` 9.2.4 → **10.0.5**（门禁 smoke）
- `Node.js` 24.19.0 → **v26.9.0**（门禁 full）
- `pnpm` 10.14.0 → **12.4.2**（门禁 standard）
- `npm（桌面载荷安装器）` 11.17.0 → **12.0.2**（门禁 standard）
- `Playwright（Python · computer-use 工具链）` >=1.40.0 → **1.46.0**（门禁 standard）

