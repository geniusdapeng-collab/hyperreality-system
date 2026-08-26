---
name: oss-watch
description: 开源组件升级监测与执行技能。触发语：「升级开源组件」「扫描开源组件更新」「执行开源组件更新计划」「升级 DeepSeek Harness 等底座依赖」。提供「清单登记 → 周期扫描 → 更新计划 → 一键执行 → 全量门禁 → 发布」完整闭环。适用于 WorkLoom 全部底座仓库（WorkLoom IM / WorkLoom hotel / WorkLoom 获客系统 / hyperreality），任何 AI Coding Agent 克隆仓库后可直接使用。
allowed-tools: Read, Write, Bash, Grep, WebFetch
---

# oss-watch · 开源组件升级监测与执行技能

> **一句话用法**：对本仓库的 AI Coding Agent 说「**升级开源组件**」，即自动走完全流程：扫描 → 出计划 → 你圈范围 → 逐项升级 → 门禁 → 发布。
> **铁律**：扫描可以自动，**升级永不自动**。任何版本变更必须经「更新计划 → 人工圈定 → 门禁测试 → 发布」四步，禁止裸 `pnpm update` 直接提交。

---

## 〇、适用仓库（四大底座 · 克隆即用）

| 仓库 | GitHub 地址 | 角色 |
|---|---|---|
| WorkLoom IM 底座 | `https://github.com/geniusdapeng-collab/workloom-im` | **试点仓**（升级先行，全绿后其余三仓跟升） |
| WorkLoom hotel | `https://github.com/geniusdapeng-collab/workloom-hotel` | 酒店行业版 |
| WorkLoom 获客系统 | `https://github.com/geniusdapeng-collab/workloom` | GEO 获客版 |
| hyperreality | `https://github.com/geniusdapeng-collab/hyperreality-system` | 视频经理版 |

四仓底层同构：同一套组件清单、同一套门禁、同一套机制。**后续项目均以这四仓为母版复制，本技能随仓继承**。

---

## 一、机制四件套（仓库内）

| 件 | 路径 | 作用 |
|---|---|---|
| **组件清单** | `oss-components.json`（仓库根） | 35 个受监测组件：name / **repo（GitHub 地址）** / channel / current / cadence / gate / notes |
| **扫描器** | `scripts/oss-watch.sh` | 按周期到期性检查上游最新版，产出更新计划；只读不写依赖 |
| **更新计划** | `docs/oss-update-plan.md`（扫描产物） | 「谁有新版、差多少、怎么升、过什么门禁、新能力评估」执行单 |
| **状态账本** | `.oss-watch-state.json`（git 跟踪） | 上次扫描时间/上次发现版本，保证周期纪律跨会话连续 |

```bash
pnpm oss:watch    # 一键触发：扫描到期组件 → 生成/刷新《开源组件更新计划》
pnpm oss:plan     # 只看当前计划（不扫描）
```

## 二、组件仓库地址的登记纪律（回答「不列地址有没有影响」）

**有影响，且分通道影响不同**——所以清单中每个组件都**必须**填 `repo` 字段：

| channel | 更新检查依赖 | 缺 repo 地址的后果 |
|---|---|---|
| `npm`（react/hono/dsh 等） | npm registry（npmmirror），**不依赖 repo** | 版本比对不受影响，但**无法跳 CHANGELOG 审 Breaking、无法判断仓库活性**——大版本升级变盲人 |
| `github`（stagehand/gui-agents 等） | `git ls-remote --tags <repo>`，**强依赖** | 该组件直接失盲，扫描器降级为「人工复核」 |
| `docker`（litellm/pgvector 等） | 镜像 tag + 仓库 releases，**强依赖** | 只能人工核对，地址缺失即失联 |
| `skill`（computer-use 等） | 技能源快照 diff，**强依赖** | 无法溯源更新 |

多命名空间 tag 的仓库（如 tauri 的 `tauri-v2.x` 与 `v1.x` 并存）须加 `tag_prefix` 字段（清单内 tauri 已配 `tauri-v`），否则 semver 排序会选错命名空间。

## 三、周期策略（cadence）

| 周期 | 对象 | 到期判定 |
|---|---|---|
| **weekly** | 明星快迭代：`@deepseek-ai/dsh`、vite、playwright/computer-use、stagehand、browser-use | ≥7 天 |
| **monthly** | 稳定主流库与自托管服务（react/trpc/hono/pg/zod/litellm/langfuse 等） | ≥30 天 |
| **event** | 有投毒史/KEV 在列组件（litellm） | 不等周期，告警即查 |

未到期组件自动跳过——组件量大也不扰动开发节奏。

## 四、标准流程（Agent 执行剧本）

### 0. 环境预检（**每次执行前必跑**，沉淀自 2026-08-26 实战）

```bash
# ① Node 版本：项目 engines 要求 >=24（dsh rc.2 起硬性依赖 node:zlib 的 zstd API）
node -v   # 必须 ≥24；不足则：NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 24 && corepack enable
# ② corepack/pnpm 代理（直连 npmjs 不通时必须）：
export COREPACK_NPM_REGISTRY=https://registry.npmmirror.com COREPACK_INTEGRITY_KEYS=0
# ③ 数据库：docker start workloom-im-pg
#    注意容器映射 5432 而 .env 用 5433——缺转发时：socat TCP-LISTEN:5433,fork,reuseaddr TCP:127.0.0.1:5432 &
# ④ 测试/套件前清残留服务（防跨仓打错库）：
pkill -f "[t]sx.*src/index"; pkill -f "[v]ite"
#    ⚠ pkill 模式必须带 [t] 字符类——裸写 pkill -f "tsx.*" 会匹配 pkill 自己的命令行导致自杀
# ⑤ 套件（suite）必须在净库单跑：脏库重置 = drop/create 数据库 → pnpm db:migrate → pnpm db:seed → 单次跑完
#    （套件用例有状态切换，重复跑/残留库会出现 simulated/real 串台、并发上限误报）
```

### 1. 扫描：`pnpm oss:watch` → 宣读计划（组件/现版/最新/跨度/建议）→ 用户圈定范围

### 2. 逐项升级（**一批一 commit**，dsh 永远单独一批）

| 类型 | 动作 |
|---|---|
| npm pin 依赖 | `pnpm update <pkg>@<target> --filter <workspace>`（**filter 匹配不到时改用 `pnpm -C <包目录> update`**——workspace 命名过滤对私有包不稳定）→ 同步清单 current |
| dsh 锁版 | 单独一批 → 更新 `packages/runtime/dsh-gate` pin → **查依赖变化**（rc.2 移除了 node-pty，dsh-gate.sh 已条件化；再升级时先 diff 依赖树） |
| 外部服务选型 | 只更新清单登记与镜像 tag 建议，不动运行时 |

### 3. 门禁矩阵（升级后必过，**组件升级时全部执行，不可只跑 smoke**）

| gate | 命令 | 适用 |
|---|---|---|
| smoke | `pnpm typecheck` | typescript/@types 等纯类型组件 |
| standard | typecheck + `pnpm test` | 一般 npm 依赖 |
| full | standard + **`pnpm suite`（全场景套件，445 用例）** | 运行时路径组件（trpc/hono/react/pg/react-router） |
| runtime-gate | full + **`bash scripts/dsh-gate.sh`（E6：围栏瀑布+哈希链+H-5 kill -9 重放）** | dsh 及 Agent 运行时相关 |

任一失败 → **立即回滚该批**，计划中标「⛔ 阻塞+原因」，禁止带伤发布。

### 4. 发布与四仓跟升

- 全绿 → commit（`chore(oss): <pkg> a→b（门禁明细）`）→ push → 计划标「✅ 已发布(hash)」
- **IM 试点全绿 → 其余三仓同版本跟升**（可跳重复分析，不可跳门禁；每仓独立建库跑全量）
- 跟升同样一批一 commit，消息注明「IM 试点批次 hash」

## 五、新能力评估（每次升级计划必填 · 人工裁决）

底层组件升级常带来**新能力**而不仅是修复。计划的「新能力评估」模块列出线索，是否产品化由人判断。2026-08 批次示例：

| 组件 | 新能力线索 | 产品化设想（待人工裁决） |
|---|---|---|
| vite 8.2.2 | **rolldown 内核**（Rust bundler）+ `codeSplitting` 原生配置 | 三端构建提速；用 codeSplitting 治 500kB chunk 告警做路由级分包 |
| typescript 7.0.2 | 原生化工具链，检查速度数量级提升 | 全仓 typecheck 进 CI 快档；monorepo 全量检查可提频到每 commit |
| react-router 8.3.0 | 数据路由/中间件能力增强 | P0 经营主页等重数据页可上服务端数据流，减首屏等待 |
| vitest 4.1.11 | 浏览器模式/并发隔离增强 | e2e 可迁浏览器模式，补 Canvas 剧场视觉回归 |
| @deepseek-ai/dsh rc.2 | **zstd 会话持久化**（session-persistence-jsonl 压缩）+ 移除 node-pty 依赖 | 审计链存储成本降；可把长会话归档开放给「全景档案」页做时间轴回放 |
| react-query 5.102.5 | 增量查询/缓存细节优化 | 经营主页 5s 心跳可更细粒度失效，降轮询压力 |

## 六、历史踩坑（每次升级前重读）

1. **Node 版本是硬门禁**：dsh rc.2 起必须 Node ≥24（`createZstdDecompress`），低版本报 `node:zlib does not provide export`——先对齐 engines 再升级。
2. **set -euo pipefail 下的 find 静默中止**：`PTY=$(find 不存在目录 ...)` 返回非零直接杀脚本——兜底 `|| true`（dsh-gate.sh 已修）。
3. **fixture 门控互踩**：store.ts「空表才灌」遇上 seed.ts「扩充运行态先占表」→ 新装环境 e2e 七连挂（D36）。幂等 fixture 不得用空表门控（已修，四仓同批）。
4. **残留服务打错库**：hyperreality 套件打到 wl-geo 的服务（并发上限误报、simulated/real 串台）——测试前必 `pkill -f "[t]sx.*src/index"`。
5. **套件状态残留**：模式切换类用例（H-05/07/09）要求净库单跑；失败先想「库干不干净」，再想代码。
6. **corepack 双坑**：默认 registry 拉不到 pnpm + 镜像签名校验失败——固定 `COREPACK_NPM_REGISTRY` + `COREPACK_INTEGRITY_KEYS=0`。
7. **pnpm --filter 包名匹配不稳**：私有 workspace 包用 `pnpm -C <dir>` 直操作。
8. **tag 命名空间**：tauri 双轨 tag（tauri-v2/v1.x）——清单配 `tag_prefix`。
9. **转发随沙箱休眠中断**：5433 突然 ECONNREFUSED 先查 socat 进程，别怀疑代码。
10. **中断残留误判**：上次中断的套件留下的测试行会污染后续断言（H-33 式）——净库是最高优先级排障动作。

## 七、登记与同步纪律

- 新装运行时依赖必须同步登记进 `oss-components.json`（含 repo 地址）；AGPL 仅独立进程并注明。
- 四仓清单底座段一致；改清单四仓同批。
- 归档/停更上游每季度复核活性；供应链/CVE 事件走 event 通道即时查。
