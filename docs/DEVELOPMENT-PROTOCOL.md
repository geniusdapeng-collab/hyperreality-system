# WorkLoom 开发协作协议（轻量版 v1）

> 生效范围：workloom-im 唯一定义，base-sync 分发九仓只读副本。
> 定位：**不新造系统**——用 CNB 原生能力（Issue / 分支保护 / 流水线 / PR）+ 三个校验脚本，管住"谁在改什么、别撞车、会话断了能接上"。
> 优先级：十二条系统不变量（《产品与代码全景认知》§8）> 本协议 > 本仓 `AGENTS.md` > 会话内临时指令。
> 与《WorkLoom 分布式 AI 开发 Agent 协作机制 v0.1》的关系：本文件是它的**最小可执行子集**；账本服务、租约看门狗、考试院、错题本、蜂群经验属"重装备"，触发条件见 §7，未触发前不建。

## 1. 五条硬规则

1. **一任务一分支一 PR**：任务卡 = CNB Issue（标题 `[T-YYYYMMDD-XXXX] 目标`），分支 = `task/T-YYYYMMDD-XXXX`，一个会话同时只开一个任务。
2. **任务号进提交信息**：`<type>(<layer>): <摘要> [T-YYYYMMDD-XXXX]`，由 `scripts/ci/verify-commit-msg.mjs` 校验。
3. **先声明后落笔**：PR 描述里写明本次改动的路径清单；`scripts/ci/verify-lock-conflict.mjs` 会与同仓其它 open PR 比对，**模块级互斥路径重叠即拒**。
4. **合并在人、串行执行**：AI 只提 PR；合并由人按队列**一次一个**执行；合并后其余分支先 rebase 再继续。
5. **无回执不算完成**：任务收尾必须在 Issue 留 5 行回执——进展 / 决策 / 未完成 / 下一步 / 分支状态。

## 2. 四问（每次落笔前必答，答案写进 Issue）

1. 改的是公共机制、平台运营机制，还是行业语义？
2. 会不会动**租户边界 / 围栏 / 审批 / 事件 / 回执**这五个信任要素？（动了 → 升为 `review`，必须人审）
3. 该进基座、Andromeda，还是行业包？同步影响面是什么？
4. 如何测试、灰度、回滚？

四问答不清 → 判定 `review`，停止落笔，转人工澄清。冲突时 `block > review > auto`。

## 3. 目录围栏

| 级别 | 规则 |
|---|---|
| **block** | 子仓写 `platform-ops/**`、`bundles/platform/**`；基座写行业 bundle/种子/行业文档；Tiger 写真实券商/实盘/真实资金路径；秘密进任何文件；客户原始数据上行；mock/模拟回执未标识 |
| **review**（人审后执行） | 修改五个信任要素实现；`protocol/**`、`sync/**`、`ROOT_AGENTS`/本文件、`.cnb.yml`；跨仓改动 >3 仓；删除/迁移目录；涉钱、群发、外部发布、Tiger 执行链路；凭证与 CI 配置 |
| **auto** | 读操作、纯文档、测试补充，且不触及以上任一条 |

> 说明：基座内置示例 bundle（`bundles/ai-pm`、`bundles/hotel`、`bundles/platform`）是产品资产，**其正常维护不属于 block**；block 针对的是"把行业语义写进公共层"。

## 4. 锁：模块级互斥 + 路径重叠检测

- **模块级互斥**（同一时刻全网仅一个任务可动）：`sync/**`、`protocol/**`、`**/migrations/**`、根 `package.json`、`AGENTS.md`、`.cnb.yml`、`docs/DEVELOPMENT-PROTOCOL.md`。
- **普通路径**：同一文件被两个 open PR 同时修改 → 后到者拒（`LOCK_OVERLAP_MODE=warn` 可临时降级为告警）。
- 检测由 `scripts/ci/verify-lock-conflict.mjs` 在 PR 流水线自动执行，无需手工维护锁表；脚本按「PR 编号 / 分支名 / 源分支提交 SHA」三重排除自身 PR。
- 冲突处置：排队等待先到者合并；紧急任务转人工调度。

## 5. 提交规范（放宽版）

```
<type>(<layer>): <摘要> [T-YYYYMMDD-XXXX]
```

- `type`：`feat | fix | sync | protocol | exam | docs | chore | ci`（`ci` 为流水线/脚本类新增）
- `layer`：`base | platform | hotel | video | growth | ecom | tiger | eagle | fox`（按仓库映射，脚本自动推断）
- **豁免**（无需任务号）：`Merge` / `Revert` 提交、`sync(...)` 同步器产出、`chore(ci)`、`rescue:`、`HP-<数字>` 审计批次、`chore(deps)`。
- 过渡开关：`PROTOCOL_TASK_ID_OPTIONAL=1` 时只校格式、不强制任务号。
- body 建议附：四问的 q1/q3 摘要 + Issue 链接。本地 hook 可选（`core.hooksPath`），**CI 才是真闸门**。

## 5.1 任务卡标签体系（CNB 实测上限：每仓 10 个标签）

CNB 每仓**最多 10 个标签**（实测：创建第 11 个返回 201 但不落库），因此采用压缩标签集：

| 标签 | 含义 |
|---|---|
| `t/draft` | 已建卡，四问未答全 |
| `t/doing` | 已派发/已领/执行中（合并原 clarified/dispatched/leased/in-progress） |
| `t/review` | 待人审或待评审 |
| `t/done` | 已合并且有回执 |
| `t/blocked` | 阻塞或取消（须在 Issue 写明原因） |
| `risk/review` | 风险等级：人审 |
| `risk/block` | 风险等级：禁止（红线） |
| `src/human` | 来源：人 |
| `src/auto` | 来源：漂移报告 / 事故 / 考试失败（自动生成） |
| `protocol` | 协议类任务 |

配套：九仓均已创建这 10 个标签；任务集看板按 `t/*` 分列即可（无需 18 个细粒度状态）。

## 6. 交接与恢复

- 触发：上下文将满、任务阶段切换、会话暂停、跨终端接手前。
- 交接单（`protocol/handoff.schema.json` 字段）：`task_id / progress / decisions / open_questions / next_steps / worktree(branch, 未提交摘要) / protocol_version`。
- 存放：Issue 评论（首选）或 `docs/handoffs/H-<日期>-<序号>.json`（随 PR 提交）。
- 恢复顺序：读 Issue 任务卡 → 读最近交接单 → `git log` 对账 → 继续；**交接单与 git/Issue 冲突时以 Issue + 代码为准**。

## 7. 何时升级到"重装备"

满足**任一**条件才评估（否则不建）：① 真实并行账号/人 ≥3；② 跨终端交接每周 >2 次；③ 出现"无回执导致返工"≥2 次；④ 并发任务 >10。

届时再评估：事件账本服务、租约看门狗、协议考试院、错题本、多模型绩效路由、蜂群经验上行。

## 8. 落地检查（每周一次，1 分钟）

- 进行中的对话是否都有任务卡？（应 100%）
- 是否有两个 open PR 改了同一文件/同一互斥模块？（应 0）
- 是否有 PR 超过 24h 未合并？（应 0，或已在 Issue 说明原因）
- 合并是否严格串行？（应「是」）

