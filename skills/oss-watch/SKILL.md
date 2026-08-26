---
name: oss-watch
description: 开源组件升级监测技能。当需要「扫描开源组件更新 / 执行开源组件更新计划 / 升级 DeepSeek Harness 等底座依赖 / 检查上游新版本」时使用。提供「清单登记 → 周期扫描 → 更新计划 → 一键执行 → 门禁测试 → 发布」的完整闭环，适用于 WorkLoom 全部底座仓库（WorkLoom IM / WorkLoom hotel / WorkLoom 获客系统 / hyperreality）。
allowed-tools: Read, Write, Bash, Grep, WebFetch
---

# oss-watch · 开源组件升级监测技能

> **定位**：WorkLoom 底座的开源组件生命周期管理机制。底座大量复用开源组件（DeepSeek Harness、React、Vite、tRPC、Hono、Playwright 等），上游持续迭代，本技能保证「**跟得上、升得稳、可回滚**」。
> **铁律**：扫描可以自动，**升级永不自动**——任何版本变更必须经「更新计划 → 人工触发 → 门禁测试 → 发布」四步，禁止裸 `pnpm update` 直接提交。

---

## 一、机制架构（四件套）

| 件 | 路径 | 作用 |
|---|---|---|
| **组件清单** | `oss-components.json`（仓库根） | 登记全部受监测组件：名称/仓库/现版/周期/升级通道/门禁级别/纪律备注 |
| **扫描器** | `scripts/oss-watch.sh` | 按周期到期性检查上游最新版，产出更新计划；只读不写依赖 |
| **更新计划** | `docs/oss-update-plan.md`（扫描产物） | 本周期「谁有新版、差多少、怎么升、过什么门禁」的执行单 |
| **状态账本** | `.oss-watch-state.json`（git 跟踪） | 每组件上次扫描时间/上次发现版本，保证周期纪律跨会话连续 |

package.json 一键入口：

```bash
pnpm oss:watch    # 扫描到期组件 → 生成/刷新《开源组件更新计划》
pnpm oss:plan     # 查看当前更新计划（不扫描）
```

---

## 二、周期策略（cadence）

| 周期 | 适用对象 | 判定 |
|---|---|---|
| **weekly（周检）** | 以周为单位快速迭代的明星项目：`@deepseek-ai/dsh`（DeepSeek Harness）、浏览器自动化栈（playwright/computer-use、stagehand、browser-use）、前端工具链（vite） | 距上次扫描 ≥7 天 |
| **monthly（月检）** | 稳定主流库与自托管服务：react、trpc、hono、tailwind、pg、zod、jose、tsx、vitest、litellm、mem0、langfuse、pgvector 等 | 距上次扫描 ≥30 天 |
| **event（即时）** | 供应链/安全事件驱动（有投毒史或 KEV 在列组件，如 litellm） | 不等周期，告警即查 |

清单中每个组件的 `cadence` 字段决定其周期；扫描器只处理**到期**组件，未到期自动跳过（这就是为什么组件量大也不会扰动开发节奏）。

---

## 三、标准流程（Agent 执行剧本）

### 步骤 0 · 人工一键触发

用户对 Agent 说「**跑一下开源组件更新**」，或在仓库根执行 `pnpm oss:watch`。二者等价——后者产出计划后同样由 Agent 接力。

### 步骤 1 · 扫描（只读）

```bash
pnpm oss:watch
```

- 按 cadence 筛选到期组件；npm 组件查 registry（优先 `registry.npmmirror.com`），GitHub 组件查 `git ls-remote --tags` / releases
- 与清单 `current` 比对，产出/刷新 `docs/oss-update-plan.md`，并把扫描时间写入 `.oss-watch-state.json`
- 退出码：`0`=全部最新；`2`=有可用更新（提醒，非错误）

### 步骤 2 · 宣读计划

Agent 必须先把计划读给用户听：**哪些组件有新版、跨几个版本、有没有 Breaking 提示、建议升/缓/跳过**，由用户圈定本批升级范围（默认全升，用户可划掉）。

### 步骤 3 · 执行升级（逐项）

| 组件类型 | 动作 |
|---|---|
| npm pin 依赖 | `pnpm update <pkg>@<target> --filter <workspace>` → 更新 `oss-components.json` 的 `current` |
| dsh 锁版 fork | 同步内部 fork 镜像 → 比对 CHANGELOG → 更新 pin（`packages/runtime/dsh-gate`）→ **单独一批，不与其他组件混升** |
| 沙箱能力（computer-use 等 skill） | 同步技能源 → diff 审核 → 更新 SKILL 快照 |
| 外部服务选型（litellm/langfuse/pgvector 等） | 只更新清单登记与镜像 tag 建议，不动运行时（服务侧另行部署评审） |

纪律：**一批一 commit**，commit message 记 `chore(oss): <pkg> a.b.c → x.y.z`；dsh 永远单独一批。

### 步骤 4 · 门禁测试（升级后必过）

按清单中每个组件的 `gate` 级别执行：

| 门禁 | 命令 | 适用 |
|---|---|---|
| **smoke** | `pnpm -r typecheck` | 纯类型/工具链组件（typescript、@types/*） |
| **standard** | typecheck + `pnpm test`（三包测试） | 一般 npm 依赖 |
| **full** | typecheck + test + **全场景套件（326 用例）** | 运行时路径组件（trpc/hono/react/pg） |
| **runtime-gate** | full + **dsh-gate E6 回归** | dsh 及 Agent 运行时相关 |

全部通过 → 进入步骤 5；任一失败 → **立即回滚该批**（`git checkout -- .` 或 `git revert`），在计划中标记「⛔ 阻塞 + 失败原因」，禁止带伤发布。

### 步骤 5 · 发布

- 门禁全绿 → commit → push → 在 `docs/oss-update-plan.md` 标记「✅ 已发布（commit hash）」
- 同步纪律：四仓底座一致——同一组件升级在 IM 验证通过后，**其余三仓（hotel / 获客系统 / hyperreality）按同版本跟升**，保持底座同版（见 §五）

---

## 四、清单字段规范（oss-components.json）

```json
{
  "name": "@deepseek-ai/dsh",
  "repo": "https://github.com/deepseek-ai/harness",
  "channel": "npm",                  // npm | github | docker | skill
  "current": "0.1.1-rc.1",
  "cadence": "weekly",               // weekly | monthly | event
  "gate": "runtime-gate",            // smoke | standard | full | runtime-gate
  "scope": "packages/runtime/dsh-gate",
  "notes": "运行时地基，锁版+内部 fork 镜像；永远单独一批升级"
}
```

登记纪律：**凡进入运行时的开源组件必须入清单**（新装依赖时同步登记）；归档/停更上游每季度复核一次活性；AGPL 组件仅独立进程形态登记并注明。

## 五、四仓同步纪律

1. 本技能四仓同构（IM / hotel / 获客系统 / hyperreality 各持一份，内容一致，仅清单按仓微调）。
2. 升级以 **IM 为试点仓**：IM 先升 → 门禁全绿 → 观察无回归 → 其余三仓同版本跟升（允许跳过重复分析，不可跳过门禁）。
3. `oss-components.json` 的底座公共段四仓保持一致；改清单（增删组件/调周期）须四仓同批。
4. 这四仓是后续项目的复制母版——**本机制随仓复制自动继承**，新项目首件事是跑 `pnpm oss:watch` 校准清单。

## 六、常见坑

1. **直连 npm/GitHub 可能不通**：registry 走 `registry.npmmirror.com`，git 走 ghfast 代理（同仓库 git 纪律）。
2. **dsh 不可混批**：运行时地基升级必须单独一批 + runtime-gate 全量门禁 + H-5 kill -9 重放。
3. **计划文件不入 git 历史噪音**：`docs/oss-update-plan.md` 每次扫描整体重写，diff 即本周期变化。
4. **版本跨度大先读 CHANGELOG**：major 跨版本组件在计划中标注「⚠ 先审 Breaking」，必要时拆批。
5. **门禁失败不回滚是最大事故**：任何一批带伤合入，后续所有扫描结果都不可信。
