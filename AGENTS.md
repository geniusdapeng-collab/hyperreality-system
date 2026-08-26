# AGENTS.md — 给 AI Coding Agent 的入场指引

> 你正在 HyperReality（AI 视频创作工作台）仓库中工作。本文件是你进入仓库后**最先要读**的文件。

## 0. 最重要的一件事：你有"手"

本仓库运行在带图形桌面的沙箱中，**内置了完整的电脑/浏览器自动操作能力**（computer-use）。
不要只用 curl 和日志判断系统行为——你可以像人一样打开浏览器、点击、输入、截图，对运行中的系统做端到端验证。

**30 秒上手（照抄即可）：**

```bash
# 1. 预检（自动安装/拉起 Xvfb 桌面 + Chromium CDP:9222 + VNC:5900/noVNC:6080），必须最先跑
bash /root/.codebuddy/skills/computer-use/scripts/preflight_check.sh

# 2. 连接浏览器并打开本系统 Web 端
python3 /root/.codebuddy/skills/computer-use/scripts/computer_tool.py '{"action": "browser_connect"}'
python3 /root/.codebuddy/skills/computer-use/scripts/computer_tool.py '{"action": "browser_goto", "url": "http://localhost:5173"}'

# 3. 读页面结构（零 token）、点击、截图
python3 /root/.codebuddy/skills/computer-use/scripts/computer_tool.py '{"action": "browser_snapshot"}'
python3 /root/.codebuddy/skills/computer-use/scripts/computer_tool.py '{"action": "browser_click", "selector": "text=工作台"}'
python3 /root/.codebuddy/skills/computer-use/scripts/computer_tool.py '{"action": "screenshot"}'
```

## 1. 首次启动：先看三端全貌（强制）

```bash
pnpm preview:all     # 一键拉起三端 + Mock 数据固化（无需真实后端/密钥）
#  🖥 PC 端 B 端工作台        http://localhost:3000
#  📱 B 端移动（高保真+手机壳） http://localhost:3001
#  📱 C 端 AI 服务前台 H5      http://localhost:3002
```

**未完成 preview:all 视为环境初始化未完成。** 验收清单：`PREVIEW_CHECKLIST.md`；Mock 口径：`mock/README.md`。

## 2. 一键能力巡游（强烈建议进仓第一件事）

```bash
bash scripts/agent-tour.sh          # 环境+数据+服务+浏览器四层自检（约 1~3 分钟）
bash scripts/agent-tour.sh --full   # 追加种子编排 + 全部测试套件 + 发布门禁
```

巡游全绿 = 你已掌握本仓全部能力的调用方式。**全量能力清单见 [`docs/capability-map.md`](docs/capability-map.md)**；
浏览器操作完整指南见 [`docs/agent-computer-guide.md`](docs/agent-computer-guide.md)。

## 3. 系统怎么跑起来

```bash
docker start workloom-im-pg          # PG17 + pgvector（如未创建见 docker-compose.yml）
pnpm install                         # npm 源受限时用 registry.npmmirror.com
pnpm dev                             # server :8787（tRPC /trpc/*）+ web :5173
pnpm db:seed                         # 演示种子（可选；短视频域另有 db:seed:video）
```

验证服务就绪：`curl -s -o /dev/null -w "%{http_code}" http://localhost:5173` 返回 `200`。
（8787 无 `/healthz`，以进程监听为准；跑测试前**先停掉残留的 8787/5173 服务**，否则 E2E 打错库、后台节拍污染断言。）

## 4. 验证纪律（本仓库硬性要求）

- 改完代码必须跑：`pnpm suite`（445 条）；
- 发布前必须跑：`pnpm release:gate`（未全过禁止发布，见 `docs/release-checklist.md`）
- 改事件/号源代码后跑：`pnpm db:verify-chain`
- **UI 改动必须用浏览器能力实际打开页面截图核对**，禁止"改了就算完成"
- 改了能力面（脚本/包/技能/演示页）必须跑 `pnpm capabilities` 重新生成人类版导览；`pnpm capabilities:check` 校验同步

## 5. 仓库速览

| 目录 | 内容 |
|---|---|
| `apps/server` | tRPC 服务端（:8787） |
| `apps/web` / `apps/webc` | B 端 PC 工作台 / C 端 H5（:5173） |
| `packages/base` | 底座包：workdata（事件/RLS）、fence-engine（围栏 DSL）、publish-rpa（全平台 RPA 发布）等 |
| `bundles/` | 行业 Bundle：`ai-video/`（短视频创作域）、`hotel/` |
| `skills/official/` | 自带技能：industry-entry / product-feedback / demo-mirror / cross-platform-review / deal-flow / ripping-reverse |
| `scripts/` | `suite*.ts` 测试套件、`seed*.ts` 种子、`release-gate.ts` 发布门禁、`agent-tour.sh` 能力巡游、`preview-all.sh` 三端预览 |
| `docs/` | 设计规范、方案、测试目录、**capability-map.md**、**agent-computer-guide.md** |

## 附：开源组件更新（oss-watch）

- 一键触发：`pnpm oss:watch`（扫描到期组件 → 生成 `docs/oss-update-plan.md`）；`pnpm oss:plan` 只看计划。
- 周期：dsh/前端工具链/浏览器自动化=周检，其余=月检，litellm 等有投毒史组件=事件驱动。
- 纪律：扫描可自动，**升级永不自动**——圈定范围 → 逐项升级 → 按 gate 过门禁（smoke/standard/full/runtime-gate）→ 全绿才发布；dsh 永远单独一批。
- 完整机制：`skills/oss-watch/SKILL.md`；组件登记：`oss-components.json`（新装依赖必须同步登记）。
