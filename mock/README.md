# /mock — 模拟数据统一口径（Mock 模式）

> 本目录是**全仓模拟数据的唯一权威说明**。三端（PC / B 端移动 / C 端移动）共享同一套 Mock 数据源，
> `pnpm preview:all` 会强制启用 Mock 模式——无论是否配置真实后端/密钥，开箱即用。

## Mock 数据从哪来（三端共享同一数据源）

| 层 | 来源 | 说明 |
|---|---|---|
| 业务数据 | `scripts/seed*.ts`（`pnpm db:seed` / `db:seed:video`，幂等） | 云栖酒店获客演示数据集：员工/围栏/对象/事件/订单/线索/券/会话/工单/知识库 385 问 |
| 模型应答 | 内置确定性模型（`packages/base/model-router`，离线可跑） | `TOOL_UNVERIFIED_RATE=0` 关闭扰动，输出稳定可复现 |
| C 端身份 | 演示直登（`SERVICE_C_DEMO_AUTH=true`） | h5/openid 免登，无需真实渠道 code 交换凭据 |
| 高保真页面 | `docs/demo/*.html`（12 页，糖果色） | B 端移动/C 端获客等场景的静态高保真，经 3001 端口 + 手机壳容器预览 |

## 运行态标识

系统界面顶部常驻横幅：「当前为全模拟运行态：经营数据是演示种子数据，应答由内置确定性模型生成」——
这是刻意设计，开发者/客户一眼可辨数据性质；接入真实数据走「落地向导」（`docs/02-新客户首次接入完整流程.md`）。

## 演示账号 / 入口

| 端 | 地址 | 身份 |
|---|---|---|
| PC · B 端工作台 | http://localhost:3000 | 公司 CEO（演示租户 MEM-001） |
| B 端移动（高保真） | http://localhost:3001 | 店主/店长视角（静态页免登） |
| C 端 AI 服务前台 | http://localhost:3002 | 演示住客（h5/openid 演示直登，免账密） |

## 重置模拟数据

```bash
docker exec workloom-im-pg psql -U postgres \
  -c "DROP DATABASE workloom WITH (FORCE);" -c "CREATE DATABASE workloom;"
pnpm db:migrate && pnpm db:seed   # 需要短视频域再补 db:seed:video
```
