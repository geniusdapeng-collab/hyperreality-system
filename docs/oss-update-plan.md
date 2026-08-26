# 开源组件更新计划（oss-watch）

> 生成：2026-08-26 18:09 ｜ 本周期扫描 35 个组件（按周期跳过 0 个未到期）｜ 有更新 **11** 个
> 使用：人工圈定范围 → Agent 逐项升级 → 按 gate 过门禁 → 全绿后发布。**升级永不自动。**

## 一、可用更新（待人工圈定）

| 组件 | 现版 | 最新 | 周期 | 门禁 | 备注 |
|---|---|---|---|---|---|
| `@deepseek-ai/dsh` | 0.1.1-rc.1 | **0.1.1-rc.2** | weekly | runtime-gate | Agent 运行时地基（DeepSeek Harness）锁版+内部 fork；永远单独一批升级，必过 E6 回归与 H |
| `vite` | 7.3.6 | **8.2.2** | weekly | standard | 前端工具链，与 @vitejs/plugin-react、@tailwindcss/vite 同批联动 |
| `react-router` | 7.18.2 | **8.3.0** | monthly | full |  |
| `@tanstack/react-query` | 5.101.4 | **5.102.5** | monthly | full |  |
| `hono` | 4.13.2 | **4.13.5** | monthly | full | MIT；与 @hono/node-server 同批 |
| `zod` | 4.x | **4.4.3** | monthly | standard |  |
| `jose` | 6.2.9 | **6.2.10** | monthly | standard | JWT/JWS |
| `tsx` | 4.x | **4.23.12** | monthly | smoke |  |
| `vitest` | 3.x | **4.1.11** | monthly | standard |  |
| `typescript` | 5.9.x | **7.0.2** | monthly | smoke |  |
| `tauri` | 2.x（桌面壳） | **2.11.5** | monthly | standard | Apache-2.0/MIT |

## 二、执行剧本（逐项）

1. 每项单独 commit：`pnpm update <pkg>@<latest>` → 更新 oss-components.json 的 current
2. 门禁：smoke=`pnpm -r typecheck`｜standard=+`pnpm test`｜full=+全场景套件｜runtime-gate=+dsh-gate E6
3. 失败立即回滚该批并在本文件标「⛔ 阻塞」；全绿 → push 并标「✅ 已发布(hash)」
4. dsh 永远单独一批；IM 试点全绿后其余三仓同版跟升
## 附：本周期已核对为最新

| 组件 | 现版 | 上游最新 |
|---|---|---|
| `playwright` | （随 computer-use 运行环境） | 1.62.1 |
| `stagehand` | 选型在案（剧本主路径） | v2.2.0 |
| `browser-use` | 选型在案（长尾冷启动探索） | 0.13.8 |
| `react` | 19.2.8 | 19.2.8 |
| `@trpc/server` | 11.18.0 | 11.18.0 |
| `tailwindcss` | 4.3.3 | 4.3.3 |
| `pg` | 8.23.0 | 8.23.0 |
| `deepeval` | CI 质量门（选型在案） | v4.1.8 |
| `promptfoo` | 红队评测（选型在案） | 0.122.0 |
| `openadapt` | 选型在案（录制回放） | v1.14.0 |
| `copilotkit` | 选型在案（AG-UI 组件库） | 4.9.1 |
| `echarts` | 选型在案 | 6.1.0 |
| `litestream` | 选型在案（社区版备份） | v0.5.16 |

## 附：人工复核项（docker/skill/选型在案组件）

- `computer-use`：sandbox-snapshot-2026-08
- `litellm`：v1.89.3-stable（哈希 pin）
- `mem0`：自托管内核（选型在案）
- `presidio`：独立服务进程（选型在案）
- `langfuse`：v3 自托管（选型在案）
- `skyvern`：选型在案（视觉抗改版）
- `gui-agents`：选型在案（Agent-S3）
- `wrenai`：独立进程（选型在案）
- `lago`：停车场（可选独立计费进程）
- `pgvector`：PG17+pgvector（docker workloom-im-pg）
- `browserskill`：观察项（2026-08-26 评估：Borrow 协议可借鉴）
