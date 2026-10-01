# WorkLoom 开发协作协议（轻量版 v1，2026-09-22 修订）

> 生效范围：workloom-im 唯一定义，base-sync 分发各订阅仓只读副本（舰队清单见 `sync/child-repos.json`；新仓由每日舰队扫描自动纳管；隔离副本仓不适用，见 §11）。
> 定位：**不新造系统**——用 CNB 原生能力（Issue / 分支保护 / 流水线 / PR）+ 三个校验脚本，管住"谁在改什么、别撞车、会话断了能接上"。
> 优先级：十二条系统不变量（《产品与代码全景认知》§8）> 本协议 > 本仓 `AGENTS.md` > 会话内临时指令。
> 与《WorkLoom 分布式 AI 开发 Agent 协作机制 v0.1》的关系：本文件是它的**最小可执行子集**；账本服务、租约看门狗、考试院、错题本、蜂群经验属"重装备"，触发条件见 §7，未触发前不建。
> 修订记录：2026-09-22 · 新增 §11「隔离副本车道」（growthtest / growthmatrix 双向不同步）；统一任务号书写为 `T-YYYY-MMDD-XXXX` 并同步提交门禁提示。

## 1. 五条硬规则

1. **一任务一分支一 PR**：任务卡 = CNB Issue（标题 `[T-YYYY-MMDD-XXXX] 目标`），分支 = `task/T-YYYY-MMDD-XXXX`，一个会话同时只开一个任务。
2. **任务号进提交信息**：`<type>(<layer>): <摘要> [T-YYYY-MMDD-XXXX]`，由 `scripts/ci/verify-commit-msg.mjs` 校验（正则 `\[T-\d{4}-\d{4}-\d{4}\]`）。
3. **先声明后落笔**：PR 描述里写明本次改动的路径清单；`scripts/ci/verify-lock-conflict.mjs` 会与同仓其它 open PR 比对，**模块级互斥路径重叠即拒**。
4. **合并在机器、串行执行、人保留叫停权**：AI 只提 PR；**门禁全绿且无冲突时，由 AI 按队列一次一个直接合并**（默认 squash）；合并后其余分支先 rebase 再继续。人不再承担逐 PR 合并操作，保留随时叫停、要求回滚与例外裁决的权利；涉及真实资金 / 实盘、生产秘密与生产配置、协议文本语义变更的 PR，必须在描述中显著标注并提供回滚路径。
   - 在途 / 未完成的 PR 必须置为 **WIP（草稿）**——WIP PR 不参与任何合并；
   - `risk/review` 标签的 PR 需人审放行（移除该标签，或 Issue / 会话里有明确指令）后由 AI 合并；`risk/block` 永不合并；
   - 无人值守通道（`sync/merge-sync-prs.mjs`，每 30 分钟随 fanout 运行）只碰**门禁全绿、无风险标签、且不落在治理路径**的 PR；代码类 PR 另需最近提交过 10 分钟冷却期。其余 PR 仍由会话内 AI 在拿到放行后显式合并。
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

> 凭据纪律（2026-09-30 修订）：凭据**来源不设限**——受控秘密存储、本地环境配置，或当前任务中由产品所有者提供的会话令牌（含对话中给出的令牌）都可用于执行已授权操作；但**任何凭据的落盘与外发一律 block**（源码、提交、文档、提示词模板、日志、报告、Issue/PR 正文与评论、同步产物、Git remote URL、shell 历史）。会话凭据只在需要它的那条命令内注入、用完即弃，疑似外泄立即停止并轮换。完整条款见 `AGENTS.md` §7。

## 4. 锁：模块级互斥 + 路径重叠检测

- **模块级互斥**（同一时刻全网仅一个任务可动）：`sync/**`、`protocol/**`、`**/migrations/**`、根 `package.json`、`AGENTS.md`、`.cnb.yml`、`docs/DEVELOPMENT-PROTOCOL.md`。
- **普通路径**：同一文件被两个 open PR 同时修改 → 后到者拒（`LOCK_OVERLAP_MODE=warn` 可临时降级为告警）。
- 检测由 `scripts/ci/verify-lock-conflict.mjs` 在 PR 流水线自动执行，无需手工维护锁表；脚本按「PR 编号 / 分支名 / 源分支提交 SHA」三重排除自身 PR。
- 冲突处置：排队等待先到者合并；紧急任务转人工调度。
- **事件语义（2026-09-27 修订）**：拦截只发生在 **PR 事件**（先到先得，后到者排队）；**push 事件**（main 上的合并提交）下重叠降级为**提醒**——合并已经发生，门禁拦不住任何东西，若仍判红则每次并发合并都会把 main 打红（实测：`workloom-growth` #211 合入后，因在途 #206/#209 同改 `bundles/ai-video/bundle.json` 被判红，同一内容 PR 门禁全绿）。需要 push 也按 fail 处理时用 `LOCK_OVERLAP_MODE=fail` 或 `--strict`。

## 5. 提交规范（放宽版）

```
<type>(<layer>): <摘要> [T-YYYY-MMDD-XXXX]
```

- `type`：`feat | fix | sync | protocol | exam | docs | test | chore | ci`（`test` 测试类、`ci` 流水线/脚本类）
- `layer`：`base | platform | hotel | video | growth | ecom | tiger | eagle | fox`（按仓库映射，脚本自动推断）
- **豁免**（无需任务号）：`Merge` / `Revert` 提交、`sync(...)` 同步器产出、`chore(ci)`、`rescue:`、`HP-<数字>` 审计批次、`chore(deps)`。
- **过渡期祖父规则**：早于 `2026-09-19T00:00+08:00` 的提交只校验 `type`（存量分支与并行车道不追溯；layer/任务号问题降级为告警）；此后的新提交必须满足 type + layer + 任务号。
- 过渡开关：`PROTOCOL_TASK_ID_OPTIONAL=1` 时只校格式、不强制任务号。
- layer 与目标仓不一致时按**告警**处理（不阻断合并），仅 `type` 非法与缺任务号（过渡期后）属于硬失败。
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

配套：十个订阅仓均已创建这 10 个标签（隔离副本仓不参与纳管，见 §11）；任务集看板按 `t/*` 分列即可（无需 18 个细粒度状态）。

## 6. 交接与恢复

- 触发：上下文将满、任务阶段切换、会话暂停、跨终端接手前。
- 交接单（`protocol/handoff.schema.json` 字段）：`task_id / progress / decisions / open_questions / next_steps / worktree(branch, 未提交摘要) / protocol_version`。
- 存放：Issue 评论（首选）或 `docs/handoffs/H-<日期>-<序号>.json`（随 PR 提交）。
- 恢复顺序：读 Issue 任务卡 → 读最近交接单 → `git log` 对账 → 继续；**交接单与 git/Issue 冲突时以 Issue + 代码为准**。

## 7. 何时升级到"重装备"

满足**任一**条件才评估（否则不建）：① 真实并行账号/人 ≥3；② 跨终端交接每周 >2 次；③ 出现"无回执导致返工"≥2 次；④ 并发任务 >10。

届时再评估：事件账本服务、租约看门狗、协议考试院、错题本、多模型绩效路由、蜂群经验上行。

## 10. 实验车道（fox / growth 等深度定制仓）

问题：`workroom-fox` 与 `WorkLoom-growth` 在共享壳之上做了**深度游戏化定制**（fox：3D 汇报舞台 + 实景商业游戏 M2-a；growth：hud/star-ring/P0 的经营游戏化）。这些**不是基座能力**，如果强行与基座保持一致，会被两类机制抹掉或卡死：

1. **普通 base-sync**：若实验路径落在 `include` 内，同步会覆盖；
2. **三端客户端基座升级**：受管根 `apps/{web,webb,webc}` 内的差异，只要不在 `allowedIndustryExtensionPaths` 白名单里，就会被判 `ILLEGAL_INDUSTRY_APP_PATH` / `MANAGED_FILE_MODIFIED` 并 **fail-close**（升级被拒）。

### 10.1 解法：三层资产 + 声明式实验路径 + 双向护栏

| 层 | 内容 | 规则 |
|---|---|---|
| L0 公共能力 | `packages/{base,runtime,shared,db,ui}`、`apps/server/src`、`scripts/**` | 基座唯一下发，禁止实验语义回流 |
| L1 行业语义 | 各行业 bundle / seed / 服务前台 | 经 bundle 槽位注入，可下发 |
| L2 实验语义 | fox 的游戏舞台与赛季引擎、growth 的经营游戏化 | **只在该仓存在**：不下发、不覆盖、不回流（要进基座必须先走提案任务卡） |

实验仓在 `sync/child-repos.json` 里显式声明（`sync/child-repos.json` 是机器可读事实源）：

```json
{
  "repo": "workloom-ai/workroom-fox",
  "lane": "experiment",
  "experimentNote": "为何属于实验语义",
  "experimentPaths": ["apps/web/src/campaign/**", "apps/web/src/components/fox-campaign/**"],
  "industryExtensionPaths": ["apps/*/src/campaign/**", "apps/*/src/components/fox-campaign/**"]
}
```

- `experimentPaths`：实验定制的**实际路径**（护栏据此检查）；
- `industryExtensionPaths`：**仓级扩展白名单**，被 `client-foundation` 合并进全局白名单 → 这些路径在 UI 升级时不再被判分叉、也不会被覆盖；
- 命令：`node scripts/tools/experiment-guard.mjs [--check]` 校验这两件事（每日 cron 自动跑；违规即红）。

### 10.2 实验仓的三条纪律

1. **只增不改基座契约**：可以新增实验目录（并登记进 `experimentPaths`），但不修改 `packages/**`、`apps/server/src/**` 的公共行为；
2. **公共化必须提案**：实验里验证成功的通用交互能力，先写提案任务卡（L2→L1→L0），不得整包搬进基座；
3. **新实验仓接入即声明**：舰队扫描发现新仓 → 纳管时同步填写 `lane/experimentNote/experimentPaths/industryExtensionPaths`，否则护栏会报警（`MISSING_NOTE` / `MISSING_PATHS` / `UI_UPGRADE_WOULD_FAIL`）。

### 10.3 受管文件分叉容差（2026-09-27 新增，解除 fox 波次暂停）

**问题**：实验仓声明的自有路径（`industryExtensionPaths`）如果**同时**出现在稳定客户端基座快照里
（例如 fox 的 `apps/*/src/pages/p0/**`、`apps/*/src/voice/**`），或**已被旧 state 登记成基座受管文件**，
`client-foundation` 会 fail closed（`客户端基座快照不得占用行业扩展路径` /
`state 不得把行业扩展登记成基座受管文件`），波次永久卡住。fox 自 0.1.8 起就停在这里。

**决策（产品所有者指令：解决 fox/tiger 覆盖）**：实验车道引入**受管文件分叉容差**，但不是"放宽校验"，而是**退管迁移**：

| 项 | 规则 |
|---|---|
| 生效范围 | 默认 `lane: experiment` 的仓；**产品分叉仓**可在 `sync/child-repos.json` 显式声明 `tolerateExtensionSnapshotOverlap: true` 获得同一容差（2026-09-30 起，T-2026-0930-0003「仓级扩展路径全链路」）；未声明者（含 tiger 这类行业仓）保持严格 fail closed |
| 触发条件 | 稳定快照占用该仓声明的 `industryExtensionPaths`，或旧 state 已把这类路径登记为受管文件 |
| 动作 | 这些路径**不覆盖、不删除**，从新 state 的 `managedFiles` 移除，并在 `state.retiredManagedForks` 留痕（路径 + 退管版本 + 原因） |
| 代价（必须知情） | 退管路径**从此不再接收基座更新**，由该仓自持；要拿回基座版本需先删除声明并另开迁移任务卡 |
| 门禁一致性 | rollout 把 `lane` 与 `industryExtensionPaths` 写入仓内 `.workloom-ui-governance.json`；仓内自包含门禁（`verify-client-foundation-consumer.mjs`）据此豁免这些路径，不再要求各仓自持一份扩展声明文件 |
| 单一事实源 | 仓级扩展路径只认 `sync/child-repos.json#children[].industryExtensionPaths`；仓内私改该声明会在下一次 rollout fail closed |

**暂停仓恢复步骤**：① 在 `sync/child-repos.json` 把 `uiRolloutWave` 从 `paused` 改回真实波次；
② `node sync/ui-upgrade-pr.mjs --rollout --wave <波次>`（默认按波次顺序，先到先得）；
③ 升级 PR 门禁全绿后合并；④ 确认 `state.retiredManagedForks` 与仓内文件一一对应。

### 10.4 仓级扩展路径全链路（2026-09-30 新增，解除 workloom 波次暂停）

**问题**：§10.3 的分叉容差只对 `lane: experiment` 生效。但 **产品分叉仓**（如 workloom：
2026-09-29 按产品所有者指令把整树复刻为 `WorkLoom-growth@2edea37`，客户端成为"三端壳之上的产品层"）
同样需要它——否则升级会 fail closed（workloom 实测 85 冲突：`MANAGED_FILE_MODIFIED` 19 /
`MANAGED_FILE_DELETED` 6 / `UNTRACKED_MANAGED_FILE` 40 / `ILLEGAL_INDUSTRY_APP_PATH` 20），
而"整包覆盖"又等于替换产品 UI。

**决策（产品所有者指令：完成 loop/客户端收尾）**：把分叉容差从"实验车道专用"升级为
**仓级显式声明**，即「仓级扩展路径全链路」。能力与代价与 §10.3 相同，差别在**适用面与登记要求**：

| 项 | 规则 |
|---|---|
| 生效范围 | `lane: experiment`（§10.3）**或** 在 `sync/child-repos.json` 显式声明 `children[].tolerateExtensionSnapshotOverlap = true` 的产品分叉仓（T-2026-0930-0003 起） |
| 登记要求 | 必须同时给出原因（`clientForkReason` 或 `rolloutResumeNote`，≥20 字，写明产品分叉的事实依据）与非空 `industryExtensionPaths`；该容差与 `uiRolloutWave: paused` 互斥（二选一） |
| 采纳基座版 | 可选 `adoptBaseClientPaths`（同样只允许 `apps/` 前缀、不含 `..`，且不得与扩展路径重叠）：这些路径"既有指纹不可信但不是本仓定制"，升级时**按稳定快照覆盖/重建**——例如 `apps/*/package.json`（必须由基座通道写入 `@workloom/ui` 版本与 lock 完整性）与纯文案代差的页面 |
| 退管留痕 | 与 §10.3 相同：路径从新 state 的 `managedFiles` 移除，记入 `state.retiredManagedForks`（含退管版本与原因），从此不接收基座更新 |
| 单一事实源 | 仍然只认 `sync/child-repos.json`；仓内 `.workloom-client-extensions.json` 仅供本仓自包含门禁参考，不参与 rollout 判定（仓内私改会在下一次 rollout fail closed） |
| 门禁 | `validateChildInventory` 逐条失败闭合（缺理由 / 空扩展路径 / paused 冲突 / 非法路径 / 未开容差却给 adopt 路径）；引擎 `planClientFoundation` 对"扩展路径与采纳路径重叠"抛错 |

**两个实测坑（照抄清单时必看）**：
1. `apps/*/package.json` **不能**放进 `industryExtensionPaths`：扩展路径会被从稳定快照里过滤掉，而
   `materializeUiVersion` 必须读它来写 `@workloom/ui` 版本 → 直接报 `客户端基座缺少 package.json`（硬错）。
2. 它也不能不声明：0.1.1 时代的旧 state 没登记过它，内容又与快照不同 → `UNTRACKED_MANAGED_FILE` 卡死。
   **唯一正解**是上面第 3 行那类「采纳基座版」声明（覆盖它、同时保留 `setUiVersion` 通道）。
   同理，宽口径如 `apps/webb/src/**` 会把必需入口 `apps/webb/src/main.tsx` 过滤掉（`稳定客户端基座缺少真实生产入口`），要用具体文件/子目录。

**首发适用**：`workloom` 24 条扩展路径 + 2 条采纳基座版路径（三端 `package.json`、`apps/webb/src/Auth.tsx`）→
`ready=true`（退管 71 条、更新 5 文件 + 新建 `styles/subtitle.css`）；`WorkLoom-growth` 39 条扩展路径 +
1 条采纳基座版路径（三端 `package.json`）→ `ready=true`（退管 71 条、更新 4 文件 + 新建 `styles/subtitle.css`）。
两仓的声明都可用 `work/tools/simulate-workloom-plan.mjs` 只读复现。
恢复/回滚：删除 `tolerateExtensionSnapshotOverlap`/`adoptBaseClientPaths`（必要时保留 `industryExtensionPaths`）、
`uiRolloutWave` 改回 `paused` 并补 `rolloutPauseNote`，即可回到"挂起"状态。

**UI 消费契约在分叉仓的边界（2026-09-30 补，T-2026-0929-0001 follow-up）**：`UI_CONSUMER_CONTRACT_FAILED`
（中文边界 / 动态值映射 / 文字出口 / 共享组件渲染等）只约束**基座受管面**。对已声明分叉容差的仓，
这些发现降级为 `advisories`（保留在 preflight 报告里可查、可另立产品迁移任务卡），**不再阻断波次推进**——
否则 `targetVersionApplied` 永远为 false，会把 W3B 之后的整条波次链永久卡死（workloom / growth 实测各 207 项）。
非分叉仓不受影响，仍是硬门禁；回滚即删除该降级逻辑。

## 11. 隔离副本车道（isolated：双向不同步，2026-09-22 新增）

**背景**：`workloom-growthtest`（AI超增长·实验版）与 `workloom-growthmatrix`（骇客帝国·实验版）是 2026-09-21 从
`WorkLoom-growth@a6dc89a` 完整复制出来的**激进改造实验副本**，内容暂时与基座拆分：基座内容不直接同步进这两仓，
这两仓的内容也不直接回流基座（产品所有者 2026-09-22 明确指令）。

**与 §10 实验车道的区别**：实验车道仍在同步队列内（拿基座资产、只是实验路径受护栏保护）；隔离副本**完全不在同步队列内**，
既不收也不发。因此二者用不同登记位：

| 车道 | 登记位 | 是否收基座资产 | 是否回流基座 | 纳管/门禁 |
|---|---|---|---|---|
| 实验车道（fox / growth） | `children[].lane = experiment` | 收（实验路径受白名单保护） | 不回流（需提案） | 纳管（10 标签 + 门禁） |
| 隔离副本（growthtest / growthmatrix） | `isolatedRepos[]`（顶层） | **不收** | **不回流** | **不纳管**：扫描跳过、不建扫描卡/纳管 PR、不新增/修改分支保护 |

**机器可读事实源**（`sync/child-repos.json`）：

```json
{
  "repo": "workloom-ai/workloom-growthtest",
  "lane": "isolated",
  "syncPolicy": "none-in-none-out",
  "copiedFrom": "workloom-ai/WorkLoom-growth@a6dc89a",
  "isolatedSince": "2026-09-21",
  "declaredBy": "product-owner",
  "declaredAt": "2026-09-22",
  "note": "为什么隔离 / 解除条件"
}
```

**四条硬规则**：

1. **不进 children**：隔离仓一旦出现在 `children` 里，fanout 会把基座内容推过去；`experiment-guard --check` 会报 `ISOLATED_IN_CHILDREN` 并在基座门禁判红；
2. **不纳管**：`fleet-scan.mjs` 把隔离仓从「新发现 WorkLoom 仓」里剔除（只单列报告）；`provision-protocol.mjs` 默认拒绝为隔离仓建纳管 PR，确需恢复必须由产品所有者明确指令 + 显式传 `--allow-isolated`；
3. **不下发**：`sync/fanout-cnb.mjs` 读取 `isolatedRepos` 并在入口过滤——即使隔离仓被误写进 `children` 也拦下（宁可少同步一个仓，也不把基座内容推给隔离副本）；
4. **不回流**：隔离副本的改造不进入基座、不下发给任何其他仓；其中的通用能力若要公共化，必须另开提案任务卡，按 L2→L1→L0 重新实现与评审。

**解除隔离（回到受控舰队）时的动作**：产品所有者明确指令 → 另开纳管任务卡 → 从 `isolatedRepos` 移除并写入 `children`
（含 `lane` / 波次 / `extraExclude`）→ 跑 `provision-protocol.mjs --allow-isolated` 补齐协议资产与门禁 → 由 fanout 纳入正常波次。
在收到显式指令前，不得以"顺手对齐"为名向这两仓推送任何基座资产。

## 9. 舰队维护与自动化（2026-09-18 新增）

### 9.1 自动 vs 人工（边界写死）

| 环节 | 谁来做 | 怎么实现 |
|---|---|---|
| 提交规范校验 | **自动** | `.cnb.yml` 协议门禁 stage → `scripts/ci/verify-commit-msg.mjs` |
| 并发冲突检测（同文件/同互斥模块） | **自动** | 同上 → `scripts/ci/verify-lock-conflict.mjs`（比对同仓 open PR） |
| 合并前闸门（类型/测试/构建/迁移种子验链/视觉） | **自动** | 各仓 `.cnb.yml`（基座 static/db/ui 三道必需） |
| 分支保护（禁直推/禁强推/必需状态检查） | **自动** | CNB 平台规则（十个订阅仓已配；隔离副本仓不再新增/修改） |
| 新仓发现与纳管 | **自动** | 每日 cron：`scripts/tools/fleet-scan.mjs --issue --provision` → 开扫描卡 + 建纳管 PR（**隔离副本仓跳过**，见 §11） |
| 基座资产分发（根级受控资产 → 各仓 `sync/base-*` PR） | **自动** | 每 30 分钟 cron + `api_trigger_base_sync`：`sync/fanout-cnb.mjs`（详见《FLEET-AUTO-SYNC.md》§1） |
| 任务卡创建/回执/关单 | **半自动** | `scripts/tools/task.mjs new|receipt|close`（一条命令，不再手写 JSON） |
| 分支创建、提交、提 PR | 由 AI/人执行 | 用任务号命名分支即可 |
| **合并（代码类 PR）** | **AI / 流水线**（门禁全绿 + 串行，一次一个） | 协议 §1；会话内由 AI 直接合并，无人值守时由 `sync/merge-sync-prs.mjs` 按 §9.5 车道合并 |
| **合并（纯同步 PR）** | **条件自动** | 仅 `sync/base-*` 且改动全在非执行性资产白名单、全部门禁 success 时由 `sync/merge-sync-prs.mjs` 合并；含治理资产则显式审查（协议 §9.4） |
| 高风险裁决与叫停 / 回滚 | **人来** | 协议 §3；协议文本语义变更由 AI 按 §1 合并，人保留叫停权 |

结论：门禁、扫描、纳管与根级资产**开同步 PR**是自动的；非执行性资产和符合 §9.5 的普通代码可无人值守合并。治理资产同步 PR 须显式审查后由会话内 AI 合并，人保留高风险裁决、叫停与回滚权。

### 9.4 纯同步 PR 的自动合并（2026-09-19 新增）

- 自动合并的判定逻辑在 `sync/fanout-rules.mjs#autoMergeEligibility`（纯函数、有单测），执行器是
  `sync/merge-sync-prs.mjs`；两者与 fanout（`sync/fanout-cnb.mjs`）共同构成"基座改一次、
  舰队跟一次"的闭环，机制说明见 `docs/FLEET-AUTO-SYNC.md`。
- 免审白名单只含非执行性根级资产：`WORKLOOM_PRODUCT_CONTEXT.md`、`AI-AUTONOMOUS-OPERATIONS.md`、`.workloom-base-sync.json`。
  `sync/**`、`AGENTS.md`、本协议、验收规范/执行器和工作流均可改变治理行为，**即使位于 `sync/base-*` 分支也不得由无人值守通道合并**；需按 §3 显式审查后由会话内 AI 合并。
- 门禁仍然先行：PR 必须全部门禁 success、平台状态明确为 `mergeable`、非 WIP、无 `risk/review` / `risk/block` 标签；**缺少状态检查、风险标签清单或可合并状态时不自动合并**。入队后、实际合并前重读源分支 HEAD、目标 `main`、路径、门禁、标签和 WIP；变化则退出本轮并重新判定。
- 白名单外的普通代码按 §9.5 进入代码车道；治理路径不因从同步车道回落而获得免审资格。一次同步 PR 同时包含普通资产和治理文件时，整条 PR 等待显式审查，不能把“已开 PR”写成“已下发完成”。

### 9.5 代码类 PR 的机器合并（2026-09-19 修订）

- 判定逻辑：`sync/fanout-rules.mjs#codeMergeEligibility`（纯函数、有单测），执行器同样是
  `sync/merge-sync-prs.mjs`——同一脚本先跑纯同步车道（§9.4），再跑代码车道。
- 代码车道准入（全部满足）：分支在任务/行业/实验/维护车道（`task/ industry/ experiment/ chore/ docs/ fix/ audit/ rescue/`）；
  全部门禁 success；平台 `mergeable_state=mergeable`；非 WIP；无 `risk/review`、`risk/block` 标签；
  分支最近一次提交已过 **10 分钟冷却期**（避免合并"会话仍在写"的 PR）；改动不落在治理/高风险路径
  （`platform-ops/**`、`bundles/platform/**`、`protocol/**`、`sync/**`、`docs/DEVELOPMENT-PROTOCOL.md`、
  `AGENTS.md`、`.cnb.yml`、`.github/**`、`**/migrations/**`、验收规范与执行器——只有 §9.4 的非执行性资产在同步波次里放行）。
- 串行约束：**同一仓库每轮最多合并一条代码类 PR**；其余候选项留待下一轮（先 rebase 再合），
  与 §1 规则 4 的"合并后其余分支先 rebase 再继续"一致。
- 非纯同步的 `sync/base-*-full` 波次（携带运行时代码的基座升级）同样走代码车道：门禁全绿 + 冷却期
  已过才由机器合并；若混有 §9.4 的治理路径则停在显式审查队列。任何一个条件不满足都只报告、不合并。
- 治理路径（协议文本、`.cnb.yml`、迁移、平台工程等）永远不进无人值守通道：由会话内 AI 在
  获得明确指令/放行后显式合并，人保留叫停权。

### 9.2 工具用法

```bash
# 任务卡：建卡（自动分配 T-YYYY-MMDD-XXXX，打 t/draft）
node scripts/tools/task.mjs new --repo workloom-ai/workloom-hotel --title "修复差评 SLA" \
  --q1 industry --q3 workloom-hotel --q4 "单测+打包门禁；回滚=revert"
# 任务卡：回执 + 关单
node scripts/tools/task.mjs receipt --repo workloom-ai/workloom-hotel --id T-2026-0919-0001 \
  --progress "..." --decisions "..." --next "..." --close

# 舰队扫描：列出组织内所有 WorkLoom 仓，标出未纳管的新仓
node scripts/tools/fleet-scan.mjs                 # 人读报告
node scripts/tools/fleet-scan.mjs --json          # 机器可读
node scripts/tools/fleet-scan.mjs --check         # 有新仓则退出码 1（可做门禁）
node scripts/tools/fleet-scan.mjs --issue --provision   # 开扫描卡 + 自动纳管（cron 用的就是这条）

# 单仓纳管（幂等）：标签 + 分支保护 + 协议资产 + 门禁 stage + PR
node scripts/tools/provision-protocol.mjs --repo workloom-ai/<name> [--dry-run]
# 隔离副本护栏：实验路径 + 隔离登记（含"隔离仓误入 children"检查）
node scripts/tools/experiment-guard.mjs [--check]
```

纳管判定规则（`scripts/tools/fleet-rules.mjs`）：仓库根 `product.manifest.json` 的 `schemaVersion` 以 `workloom.product/` 开头 → WorkLoom 仓；缺失时退化为 `.workloom-base-sync.json` 或 `bundles/*/bundle.json` 的 schema 标记。已纳管集合 = 基座仓 + `sync/child-repos.json` 的 children + `isolatedRepos`（隔离副本计入"已知"，但永不进入纳管/分发通道）。

### 9.3 新仓纳管后的三件事（自动完成，人工只需审 PR）

1. 标签体系（10 个）+ `main` 分支保护（强制 PR + 必需状态检查 + 禁强推/删除）；
2. 协议资产副本 + `.cnb.yml` 协议门禁 stage；
3. 本仓写入 `sync/child-repos.json`（舰队清单），后续 base-sync 波次照常覆盖。

> 注意：新仓若与既有仓同 `productId`（例如 `WorkLoom-growth` 与 `workloom` 都是 `workloom-ai-acquisition`），说明它是同一产品的第二实例或副本——纳管只保证协议一致，**产品身份（productId/端口/演示工作区）需要人确认后统一**。

> 补充（2026-09-22）：若新仓是**有意与基座拆分的隔离副本**（如 growthtest / growthmatrix），不要纳管——按 §11 写入 `isolatedRepos` 并保持双向不同步；只有产品所有者明确要求回到受控舰队时才重新纳管。

## 8. 落地检查（每周一次，1 分钟）

- 进行中的对话是否都有任务卡？（应 100%）
- 是否有两个 open PR 改了同一文件/同一互斥模块？（应 0）
- 是否有门禁全绿却超过 24h 未合并的 PR？（应 0——由 AI 按 §1/§9.5 直接合并，或已在 Issue 说明阻塞原因）
- `risk/review` PR 是否都在拿到放行后由 AI 执行了合并（而不是等人来点）？（应「是」）
- 合并是否严格串行？（应「是」）

## 12. 交付排雷机制（MCD v1.0，2026-09-29 新增）

**定位**：本协议解决"别撞车、可交接、门禁全绿"；MCD 解决"问题是否被系统性挖出、修复是否真有断言兜底、验收是否独立"。两者叠加使用，不新造并行流程。

**触发（调用声明）**：命中「排雷 / 排雷式交付 / 系统性排查 / 交付前排查 / 交付体检 / 挖问题 / 问题台账 / 修复排期 / 假修复 / 联动地雷 / MCD / mine-clear」任一意图 → 先读 `docs/MINE-CLEAR-DELIVERY-SPEC.md`，再用 `node scripts/delivery/mine-clear.mjs` 建台账。"独立验收 / 上线前验收"仍走 RDAS v3.1（§6 最低验证标准）。

**五条硬约束**（与 §1 五条硬规则同级）：

1. **一轮排雷/修复 = 一张任务卡 + 一条 `task/T-…` 分支**；台账落 `outputs/mine-clear/<任务号>/`，`ledger.json` 必须随 PR 提交（证据文件可按体量决定是否入库，但断言输出路径必须可追溯）；
2. **无证据不上账**：问题卡必须有 `文件:行号@commit` 与触发路径；断言必须可运行——`node scripts/delivery/mine-clear.mjs gate --ledger <台账>` 是硬闸，判红不得交付；
3. **修复者不自验**：`verified_by ≠ fixed_by`（独立会话/角色），无法满足时必须写 `waiver.reason` 与批准来源；
4. **P0（突破核心不变量 / 安全）未闭环** → 不得进入 RDAS 验收，不得并入发布分支；
5. **M6 交接**必须用 `mine-clear.mjs handoff`（未闭环项逐条给回归路径），验收结论只许三档：完全通过 / 有条件通过 / 不通过。

**风险分级**：MCD 本体是规范 + 台账 schema/模板 + 本地编排脚本（`scripts/delivery/**`），不改产品运行时；一旦排雷结论落到运行时代码改动，按 §3 目录围栏照常判 `auto / review / block`，治理路径仍需人审放行。
