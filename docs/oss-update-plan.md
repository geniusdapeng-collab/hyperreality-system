# 开源组件更新计划（oss-watch）

> 生成：2026-09-19T03:13:55.000Z ｜ 登记组件有更新 **28** 个 ｜ 直接依赖有更新 **33** 个
> 使用：人工圈定范围 → Agent 逐项升级 → 按 gate 过门禁 → 全绿后发布。**升级永不自动。**

## 一、登记组件更新（待人工圈定）

| 组件 | 现版 | 最新 | 周期 | 门禁 | 备注 |
|---|---|---|---|---|---|
| `DeepSeek Harness（dsh）` | 0.1.2-rc.1 | **0.1.5-rc.2** | weekly | runtime-gate | Agent 运行时地基：锁版 + 内部 fork 镜像，任何新版本（含 rc 预发布）即触发升级；永远单独一批，必过 E |
| `node-addon-require-builtin` | 0.1.5 | **0.1.6** | monthly | standard | dsh 原生插件加载依赖；随 dsh 锁定树升级 |
| `dsh-im 多平台 IM 接入插件` | 0.2.2 | **4.21.2** | monthly | standard | 钉钉/企微/飞书官方通道首批启用；安装走 pin 版本 + integrity 校验；观察名单（微信 iLink、Wha |
| `Hono` | 4.13.5 | **4.13.8** | monthly | full | HTTP 服务层；与 @hono/node-server 同批升级 |
| `tRPC` | 11.18.0 | **11.19.0** | monthly | full | server/client 必须同版同批升级，跨版本混用会直接破坏三端类型契约 |
| `Zod` | 4.4.3 | **4.6.5** | monthly | standard | 事件与契约校验；v4 与 v3 API 差异大，升级必须全量跑契约测试 |
| `jose（JWT/JWS）` | 6.2.10 | **6.2.12** | monthly | full | 会话与租户令牌签发/校验；升级后必须过登录、跨租户越权（RLS）用例 |
| `yaml` | 2.9.0 | **2.9.1** | monthly | standard | bundle 与技能 YAML 解析器；与 yaml-governance（治理固定解析器）保持 2.9.0 同版 |
| `js-yaml` | 4.2.0 | **5.4.2** | monthly | standard | dsh CLI 配置解析依赖；随 dsh 锁定树升级 |
| `Execa` | 10.0.0 | **10.0.1** | monthly | standard | 子进程调用封装；升级注意 ESM-only 与 Node 版本要求 |
| `ws` | 8.21.0 | **8.21.3** | monthly | full | WebSocket 服务端；升级后过实时通道与重连用例 |
| `NATS Server（内嵌事件总线）` | v2.11.4 | **v2.15.0** | monthly | full | 官方二进制 pin 版本 + 校验下载；桌面端以 JetStream 形态拉起；二进制缺失时显式降级 memory 形态 |
| `React` | 19.2.8 | **19.3.0** | monthly | full | React 19；与 react-dom、@types/react 同批升级；升级后必须过三端视觉与交互门禁 |
| `react-dom` | 19.2.8 | **19.3.0** | monthly | full | 必须与 react 严格同版 |
| `React Router` | 8.3.0 | **8.4.0** | monthly | full | 路由与数据加载；大版本升级需核对路由表与深链（含 bare 路由返回出口） |
| `TanStack Query` | 5.102.5 | **5.103.1** | monthly | full | 服务端状态缓存；升级复核轮询失效策略（心跳类页面） |
| `Vite` | 8.2.2 | **8.3.0** | weekly | standard | 构建工具链；与 @vitejs/plugin-react、@tailwindcss/vite 同批联动；v8 走 rol |
| `@vitejs/plugin-react` | 6.1.0 | **6.1.1** | monthly | standard | 与 vite 同批升级 |
| `three.js` | 0.185.1 | **0.186.0** | monthly | full | 3D 渲染；与 @react-three/fiber、drei、postprocessing、three-stdlib  |
| `pixi.js` | 6.5.10 | **8.21.0** | monthly | full | 当前锁 v6 线（pixi-live2d-display 兼容上限）；升级 v7/v8 必须同步替换 live2d 显示 |
| `Electron` | 44.1.1 | **44.4.2** | monthly | full | 桌面壳（正式产品形态）；升级必须过打包载荷校验、真实窗口响应式与托盘/夜班行为验收 |
| `Vitest` | 4.1.11 | **5.0.1** | monthly | standard | 各 workspace 版本需对齐（历史存在 v3/v4 混用）；升级后全量跑 pnpm test |
| `tsx` | 4.23.12 | **4.23.13** | monthly | standard | TS 直跑器；升级后过 db:migrate/db:seed 与 server 启动 |
| `concurrently` | 9.2.4 | **10.0.5** | monthly | smoke | 开发编排；升级不影响生产载荷 |
| `Node.js` | 24.19.0 | **v26.9.0** | monthly | full | 引擎下限 >=24（dsh 的 zstd 会话持久化要求）；桌面载荷内嵌 24.19.0，升级需重建载荷并过 app 冒 |
| `pnpm` | 10.14.0 | **12.4.2** | monthly | standard | lockfile v9 格式；升级必须九仓同步（packageManager 字段），否则 frozen-lockfil |
| `npm（桌面载荷安装器）` | 11.17.0 | **12.0.2** | monthly | standard | 载荷安装器版本与 package-lock.json 绑定；升级需重跑 runtime:deps:refresh/ver |
| `Playwright（Python · computer-use 工具链）` | >=1.40.0 | **1.46.0** | monthly | standard | 与 Node 侧 @playwright/test 独立版本线；浏览器二进制由 playwright install 管 |

## 二、执行剧本（逐项）

1. 每项单独 commit：`pnpm update <pkg>@<latest>`（工作区包用 `pnpm -C <包目录> update`）→ 更新 `oss-components.json` 的 current
2. 门禁：smoke=`pnpm typecheck`｜standard=+`pnpm test`｜full=+`pnpm suite`｜runtime-gate=+`bash scripts/dsh-gate.sh`
3. 失败立即回滚该批并在本文件标「⛔ 阻塞」；全绿 → push 并标「✅ 已发布(hash)」
4. dsh 永远单独一批；发布前建议先做仓库快照（git bundle）

## 三、新能力评估（人工裁决区 · 大版本升级必填）

> 底层升级常带来新能力而非仅修复。下列大跨度项请逐项评估「能否产品化」，结论写回本文件。

| 组件 | 跨度 | 发布说明 | 新能力线索与产品化设想（人工填写） |
|---|---|---|---|
| `DeepSeek Harness（dsh）` | 0.1.2-rc.1 → 0.1.5-rc.2（minor/patch） | 见 repo releases |  |
| `node-addon-require-builtin` | 0.1.5 → 0.1.6（minor/patch） | 见 repo releases |  |
| `dsh-im 多平台 IM 接入插件` | 0.2.2 → 4.21.2（⚠ major） | 见 repo releases |  |
| `Hono` | 4.13.5 → 4.13.8（minor/patch） | 见 repo releases |  |
| `tRPC` | 11.18.0 → 11.19.0（minor/patch） | 见 repo releases |  |
| `Zod` | 4.4.3 → 4.6.5（minor/patch） | 见 repo releases |  |
| `jose（JWT/JWS）` | 6.2.10 → 6.2.12（minor/patch） | 见 repo releases |  |
| `yaml` | 2.9.0 → 2.9.1（minor/patch） | 见 repo releases |  |
| `js-yaml` | 4.2.0 → 5.4.2（⚠ major） | 见 repo releases |  |
| `Execa` | 10.0.0 → 10.0.1（minor/patch） | 见 repo releases |  |
| `ws` | 8.21.0 → 8.21.3（minor/patch） | 见 repo releases |  |
| `NATS Server（内嵌事件总线）` | v2.11.4 → v2.15.0（minor/patch） | 见 repo releases |  |
| `React` | 19.2.8 → 19.3.0（minor/patch） | 见 repo releases |  |
| `react-dom` | 19.2.8 → 19.3.0（minor/patch） | 见 repo releases |  |
| `React Router` | 8.3.0 → 8.4.0（minor/patch） | 见 repo releases |  |
| `TanStack Query` | 5.102.5 → 5.103.1（minor/patch） | 见 repo releases |  |
| `Vite` | 8.2.2 → 8.3.0（minor/patch） | 见 repo releases |  |
| `@vitejs/plugin-react` | 6.1.0 → 6.1.1（minor/patch） | 见 repo releases |  |
| `three.js` | 0.185.1 → 0.186.0（minor/patch） | 见 repo releases |  |
| `pixi.js` | 6.5.10 → 8.21.0（⚠ major） | 见 repo releases |  |
| `Electron` | 44.1.1 → 44.4.2（minor/patch） | 见 repo releases |  |
| `Vitest` | 4.1.11 → 5.0.1（⚠ major） | 见 repo releases |  |
| `tsx` | 4.23.12 → 4.23.13（minor/patch） | 见 repo releases |  |
| `concurrently` | 9.2.4 → 10.0.5（⚠ major） | 见 repo releases |  |
| `Node.js` | 24.19.0 → v26.9.0（⚠ major） | 见 repo releases |  |
| `pnpm` | 10.14.0 → 12.4.2（⚠ major） | 见 repo releases |  |
| `npm（桌面载荷安装器）` | 11.17.0 → 12.0.2（⚠ major） | 见 repo releases |  |
| `Playwright（Python · computer-use 工具链）` | >=1.40.0 → 1.46.0（⚠ major） | 见 repo releases |  |

## 四、直接依赖更新（全量清单扫描结果）

| 包 | 现版 | 最新 | 类型 | 备注 |
|---|---|---|---|---|
| `@deepseek-ai/dsh` | 0.1.2-rc.1 | 0.1.5-rc.2 | prod | — |
| `@deepseek-ai/dsh-experimental-agent-team` | 0.1.2-rc.1 | 0.1.5-alpha.2 | dev | 随 dsh 批次 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 0.1.2-rc.1 | 0.1.5-alpha.2 | dev | 随 dsh 批次 |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 0.1.2-rc.1 | 0.1.5-alpha.2 | dev | 随 dsh 批次 |
| `@tanstack/react-query` | 5.102.5 | 5.103.1 | prod | — |
| `@trpc/client` | 11.18.0 | 11.19.0 | prod | — |
| `@trpc/server` | 11.18.0 | 11.19.0 | prod | — |
| `@types/node` | 24.13.3 | 26.6.1 | dev | — |
| `@types/pg` | 8.11.0 | 8.23.1 | dev | — |
| `@types/react` | 19.2.0 | 19.3.0 | dev | — |
| `@types/react-dom` | 19.2.0 | 19.3.0 | dev | — |
| `@types/three` | 0.185.4 | 0.186.0 | dev | — |
| `@vitejs/plugin-react` | 6.1.0 | 6.1.1 | dev/prod | — |
| `concurrently` | 9.2.4 | 10.0.5 | dev | — |
| `electron` | 44.1.1 | 44.4.2 | dev | — |
| `execa` | 10.0.0 | 10.0.1 | dev | 随 dsh 批次 |
| `hono` | 4.13.5 | 4.13.8 | prod | — |
| `jose` | 6.2.10 | 6.2.12 | prod | — |
| `js-yaml` | 4.2.0 | 5.4.2 | prod | 随 dsh 批次 |
| `node-addon-require-builtin` | 0.1.4 | 0.1.6 | prod | 随 dsh 批次 |
| `pixi.js` | 6.5.10 | 8.21.0 | prod | — |
| `react` | 19.2.8 | 19.3.0 | prod | — |
| `react-dom` | 19.2.8 | 19.3.0 | prod | — |
| `react-router` | 8.3.0 | 8.4.0 | prod | — |
| `three` | 0.185.1 | 0.186.0 | prod | — |
| `tsx` | 4.23.12 | 4.23.13 | dev/prod | — |
| `typescript-governance` | 5.9.3 | 7.0.2 | dev | — |
| `vite` | 8.2.2 | 8.3.0 | dev/prod | — |
| `vitest` | 4.1.11 | 5.0.1 | dev | — |
| `ws` | 8.21.0 | 8.21.3 | dev | 随 dsh 批次 |
| `yaml` | 2.9.0 | 2.9.1 | dev/prod | — |
| `yaml-governance` | 2.9.0 | 2.9.1 | dev | — |
| `zod` | 4.4.3 | 4.6.5 | prod | — |

> 说明：直接依赖含传递层升级线索；批量升级前先按「登记组件」批次处理运行时关键路径，避免一次跨度过大。

