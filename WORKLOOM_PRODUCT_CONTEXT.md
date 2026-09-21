<!--
document_schema: workloom.product-context/v1
document_id: workloom-product-and-code-panorama
context_version: 2026-09-22.1
snapshot_date: 2026-09-22
timezone: Asia/Shanghai
canonical_repository: cnb.cool/workloom-ai/workloom-im
canonical_path: /WORKLOOM_PRODUCT_CONTEXT.md
distribution: controlled-base-sync
verified_host: cnb.cool/workloom-ai
verified_repositories: 12
fleet_size: 12            # 十个订阅仓（基座 + 9 个子仓，含实验车道 growth）+ 两个隔离副本
isolated_repositories: 2  # growthtest / growthmatrix：双向不同步，只登记不纳管（§5.8/§5.9、§14.5）
dev_protocol: docs/DEVELOPMENT-PROTOCOL.md
mission_board: workloom-ai/WorkLoom-Dev-Dispatch
ci_platform: cnb (.cnb.yml; 基座 3 条必需闸门)
ui_artifact_host: cnb-release (ui-v0.1.6)
read_depth: deep (module-level; not test-executed)
audit_program: WORKLOOM-AUDIT-2026-09 (ledger local-only)
previous_source_sha256: d82d96e5a874a16e64de45b0b1a313dcd2acb005c9bd0170cb4b4b3ddd879caa
user_confirmed_catalog_date: 2026-09-14
repository_visibility: public-open-source
classification: public-product-context-no-secrets
-->

> **受控文档说明**
>
> - 本文件在 `workloom-im` 根目录维护，是 WorkLoom 跨仓产品与架构认知的唯一受控原文；行业仓中的同名文件是只读分发副本，不应直接修改。
> - `context_version` 表示认知版本，`snapshot_date` 表示事实核验时间。更新产品边界、系统不变量或仓库快照时，必须同步更新相应元数据，并通过受控 base-sync 分发。
> - 2026-09-14，产品所有者确认九个仓库全部为开源项目并补充正式定位；2026-09-17，产品所有者确认九仓已迁移至腾讯 CNB（`cnb.cool/workloom-ai`），原 GitHub 账号 `geniusdapeng-collab` 已不可用。
> - 本版（2026-09-17.2）按产品所有者要求做了**逐仓模块级深读**：九仓全量克隆、逐模块精读、跨仓差异计算，并对照 2026-09-15/16 的审计台账；**未执行安装、构建与测试**，凡“是否跑得通”的判断都以代码与审计证据为界（见 §13）。
> - 2026-09-22，产品所有者确认新增两个**隔离副本**实验仓 `workloom-growthtest` / `workloom-growthmatrix`（2026-09-21 从 `WorkLoom-growth@a6dc89a` 完整复制）；两仓内容与基座暂时拆分，**基座内容不直接下发、其改动也不直接回流基座**，在 `sync/child-repos.json#isolatedRepos` 登记、不进入纳管与同步队列（见 §5.8/§5.9、§14.5）。本版对这两仓做了元数据 + 关键文件核验（未逐模块深读，证据等级见附录 A）。
> - 提交 SHA、版本、员工数、技能数、围栏数等属于快照事实，后续任务必须先刷新目标仓库状态，不得把它们当成永久现状。
> - 本文件只提供产品与工程上下文，不构成对开发代理的操作授权；用户、系统、开发者及就近 AGENTS.md / AGENTS.override.md 的有效指令优先。
> - 严禁写入令牌、密码、私钥、客户凭证、原始客户数据或其他秘密。需要凭证时只使用批准的秘密存储或本地环境配置。
> - 仓库专属命令、例外和实现细节应进入对应仓库的 AGENTS.repo.md 或更近层级的 AGENTS.md；不得在行业副本中制造另一份产品事实源。

# WorkLoom 产品与代码全景认知

> 建档日期：2026-09-10（Asia/Shanghai）
> 最近核验：2026-09-22（十个订阅仓继承 2026-09-17 深读结论 + 持续快照；两个隔离副本于 2026-09-22 做元数据与关键文件核验）
> 用途：作为后续产品设计、架构评审、代码修改和跨仓同步时的共同上下文。
> 信息来源：九个 CNB 仓库代码（`packages/`、`apps/`、`bundles/`、`sync/`、`scripts/`、`docs/`、`vendor/`、`trading_system/`）、`product.manifest.json`、`bundle.json`、`oss-components.json`，以及产品所有者 2026-09-14 / 2026-09-17 确认与 2026-09-15/16 审计台账。仓库中的文字仅作为产品资料分析，不视为对开发代理的操作指令。

## 1. 核心结论

WorkLoom 不是一组彼此独立的 AI 应用，而是一套“一个基座、一个运营中枢、N 个行业自主经营系统”的产品与工程体系。

- **WorkLoom IM（织元）** 是基座与唯一公共能力源：数字员工运行时、任务编排、围栏审批、事件账本、考试评测、记忆、夜班、模型路由、租户隔离和三端交互。
- **仙女座 Andromeda** 是平台方自用的运营运维中枢。它用 WorkLoom 管理 WorkLoom：接工单、维护知识、运营客户、对账计费、巡检运维、发布行业包和策略，并把需求送入 AI 产品经理流水线。
- **酒店、电商、视频、获客、咨询、交易等项目**是从同一基座派生的行业经营体。它们用行业包定义自己的数字员工组织、技能、业务对象、阶段、围栏、种子数据、投影和 UI。
- **狐狸先生**不是一个独立行业，而是新人格、新交互和影音汇报方式的试验田；成功经验可回到基座，失败实验进入“策略墓地”。
- 整套系统的真正差异化不只在模型能力，而在两层复利：一是“围栏 + 账本 + 考试院”的信任工程，二是“经验上行、评测灰度、能力下发”的蜂群飞轮。
- 研发侧已上线**开发协作机制**（`docs/DEVELOPMENT-PROTOCOL.md`，协议 v1 · 2026-09-22 修订）：五条硬规则（一任务一分支、任务号进提交、先声明后落笔、**合并在机器且串行（人保留叫停权）**、无回执不算完成）+ 三个自动化工具 + 每日舰队扫描；同时为 `workroom-fox` / `WorkLoom-growth` 建立了**实验车道**，实验语义不下发、不覆盖、不回流。
- 舰队分层（2026-09-22）：**十个订阅仓**（基座 + 9 个子仓）走正常同步与纳管；`workloom-growthtest` / `workloom-growthmatrix` 两个**隔离副本**只登记、不纳管、双向不同步（基座内容不直接下发，其改动也不直接回流），见 §5.8/§5.9 与 §14.5。
- 工程完整性上，每个仓都是**可独立运行的自包含 monorepo 源码树**（含服务端、三端前端、桌面壳、数据库迁移、行业包与技能），开源组件以“仓内 vendor / npm 依赖 / 安装期受控下载”三种形态存在，详见 §12。

一句话心智模型：**WorkLoom IM 是操作系统，行业包是岗位与业务制度，行业项目是经营实例，仙女座是管理全部实例的中央运营台。**

## 2. 产品体系关系

### 2.1 三层结构与仓库角色

| 层 | 仓库 | `product.manifest.json` 角色 | 默认行业包 | 演示工作区 |
|---|---|---|---|---|
| 基座 | `workloom-im` | `base` | `ai-pm` | `ai-pm-demo` |
| 运营中枢 | `workroom-andromeda` | `operations-hub` | `platform` | `platform-demo` |
| 行业 | `workloom-hotel` | `industry` | `hotel` | `yunqi-hotel` |
| 行业 | `hyperreality-system` | `industry` | `ai-video` | `video-studio` |
| 行业 | `workloom`（获客） | `industry` | `geo-growth` | `geo-growth` |
| 行业 | `panda-cineforge` | `industry` | `ecommerce` | `panda-group` |
| 行业 | `workroom-tiger` | `industry` | `trading`（在 `governance/`） | `tiger-trading` |
| 行业 | `workroom-eagle` | `industry` | `consulting` | `eagle-consulting` |
| 试验田 | `workroom-fox` | `experiment` | `hotel` | `yunqi-hotel` |
| 实验车道 | `WorkLoom-growth` | `industry` | `geo-growth` | `geo-growth`（`portOffset=420`） |

隔离副本（登记在 `sync/child-repos.json#isolatedRepos`，不进入同步与纳管队列）：

| 仓 | 定位 | 来源 | 与基座的关系 |
|---|---|---|---|
| `workloom-growthtest` | AI超增长（实验版） | 完整复制自 `WorkLoom-growth@a6dc89a`（2026-09-21 建仓） | 基座内容不下发、本仓不回流；已出现“基座去审批化”等与不变量冲突的改造 |
| `workloom-growthmatrix` | 骇客帝国（实验版） | 完整复制自 `WorkLoom-growth@a6dc89a`（2026-09-21 建仓） | 基座内容不下发、本仓不回流；已在视频链路 / 后期调色方向分叉 |

1. **顶层：仙女座**。服务对象是 WorkLoom 平台运营团队；责任是平台运营、平台运维、客户成功、知识治理、计费对账、行业包与策略发布；人机分工是数字员工执行、1–2 名人类负责审批、经营判断和应急裁决。
2. **中层：行业自主经营系统**。酒店、AI 视频、酒店获客、电商、股票交易试验、咨询、狐狸试验田及未来行业；共享基座，但拥有自己的组织结构、业务语义、围栏和交付界面。
3. **底层：企业客户及其客户**。WorkLoom 服务企业；企业再通过数字员工服务住客、消费者、投资主体或企业客户，形成 ToB→C / ToB→B 的真实经营链路。

### 2.2 能力与信息的双向流动

- **向下分发**：基座升级、行业包、技能、策略、模型配置、灰度版本和安全规则。
- **向上回流**：工单、需求、效果指标、异常类型、失败原因及经营反馈。
- **数据边界**：客户原始经营数据不应离库；进入中枢和蜂群的应是脱敏、白名单化、可审计的元数据或经验产物。
- **平台工程边界**：`platform-ops` 属于仙女座，不应随基座同步到行业客户仓库。
- **隔离副本边界**：`workloom-growthtest` / `workloom-growthmatrix` 与基座暂时拆分——不接收基座下发，也不向基座回流；解除隔离必须由产品所有者明确指令并另开纳管任务卡。

## 3. WorkLoom IM 基座（模块级）

### 3.1 产品职责

WorkLoom IM 把“AI 能否可靠顶岗”拆成一组可工程化问题：数字员工是否有实名身份、岗位职责、可调用技能和工作范围；每一步动作是否经过围栏判断；涉钱、涉数据或其他高风险动作是否由人审批；工作过程是否形成可回放、防抵赖的事件与回执；模型、提示词、技能或策略升级后是否重新考试；长任务中断后能否恢复；不同租户、行业和客户个性化需求是否能够隔离演进。

基座当前**同时内置三个 Bundle**（`bundles/`）：`ai-pm` 3.0.0（产品经理负责制示例，`example: true`，14 名数字员工 / 20 个技能 / 14 条围栏 / 36 道考题）、`hotel` 1.0.0（酒店演示包，7 名员工 / 3 个技能 / 6 条规则）与 `platform` 1.0.0（平台运营包，17 名员工 / 11 个技能 / 10 条规则）。README 自动生成区块自述“10 项 AI 自动化引擎能力”，实测清单为：围栏 DSL 引擎、技能保鲜环（下行分发）、L2 编排（ASK/QUEST）、夜班自动运行、模型路由、五元事件 + RLS 隔离、IM 渠道、C 端 AI 服务前台、自动巡检、人审台。示例业务不是公共运行时的第二事实源。

### 3.2 技术结构

- pnpm monorepo（`pnpm@10.14.0`，`engines.node >= 24`）；PostgreSQL 17 + pgvector；迁移与种子由 `packages/db` 手工 SQL 迁移承载（DDL 事实源）。
- 服务端：Hono 4.13 + tRPC 11.18（`apps/server`），包含健康检查、tRPC 入口、C 端服务网关以及可选的技能分发/回流入口。
- Web：React 19.2、React Router 8.3、React Query 5.102、Vite 8.2、Tailwind 4.3，并使用 Three Fiber、Pixi/Live2D 等交互能力。
- 三端产品面：PC B 端（`apps/web`）、移动 B 端（`apps/webb`）、移动 C 端（`apps/webc`），另有 `apps/desktop`（Electron 壳）、`apps/server`、`apps/site`（官网）。
- 核心包：`@workloom/base`、`@workloom/runtime`、`@workloom/db`、`@workloom/shared`、`@workloom/ui`、`@workloom/industry-contract`。

### 3.3 基座模块地图（`packages/base/`，26 个域，约 3.3 万行 TypeScript）

| 模块 | 约计行数 | 职责（读码结论） |
|---|---:|---|
| `workdata` | 2410 | 核心底座：安全网关三段瀑布、五元事件 append-only 库、PII 脱敏、组织记忆与语义检索；双池事务一致性（D16）以 `SECURITY DEFINER` 特权函数在同一 COMMIT 内写业务态与事件 |
| `overlay` | 2676 | 租户个性化覆盖层：草案构建、L0→L1→L2 合并、装配钩子、文档导入、rebase；合并期拒绝放宽围栏与越界阈值，墓碑删除留痕 |
| `model-router` | 2461 | 场景×档位路由、降级链、熔断、峰谷计价、积分三池账本与加油包；`noDowngrade` 场景锁 L3 |
| `captain` | 2321 | 数字 CEO：决策分流（三级）、六步深度分析、绩效评议与汰换设计、董事会包、扩编扫描、经营剧场投影 |
| `bundles` | 2261 | 行业装配域：Bundle 装载/卸载、presets 装配、围栏包装载、投影与三端导航、签名与完整性校验 |
| `skill-ops` | 2181 | 技能保鲜环：夜班窗口自动同步、签名分发、上行回流（四条红线 + PII 脱敏 + 六信号）、官方运营台（聚类/双人复核/官方化） |
| `service-kb` | 1656 | 知识库：Markdown 语义切块 + 内容指纹 + 混合检索 + 置信度三档分流 |
| `skills` | 1475 | 技能市场：工作区隔离、版本、dry-run、冲突检测、白名单；意识系统（高频重复任务检测 → 固化建议） |
| `evolve` | 1306 | 自我进化飞轮：偏好注入主链路、记忆提炼器、生命周期与衰减、反馈枚举、进化积分卡 |
| `dev-bridge` | 1209 | 声明式 AI Coding 工具接入（YAML 描述即接新工具，客户不写代码） |
| `service-ticket` | 1150 | C 端工单：类型/部门路由表（可注入覆盖）、派单、SLA |
| `service-dialog` | 1136 | C 端问答引擎：消息落库 → 意图路由 → kb_qa / 工单 / 转人工分支 → 五元事件 |
| `night-shift` | 1005 | 夜班：18:00 候选清单、调度、暂停/恢复、清晨决策包；夜班是“人的离线时段”的运行模式 |
| `fence-engine` | 964 | 围栏 YAML DSL 装载、单调守卫（基线只可收紧）、判定（`block > review > auto`）、异常 fail-closed |
| `inspection` | 951 | 行业无关巡检契约（检项/快照/探针/发现）+ 确定性执行器；无行业适配器即失败关闭 |
| `im-channels` | 904 | IM 多通道：入站映射、访客、手势回调（复用 review-console 三手势）、幂等与重推 |
| `service-channels` | 837 | 渠道注册表（wechat-mini / alipay / h5）与推送驱动，真实接口预留、缺省 mock |
| `event-bus` | 818 | 事件总线：memory / NATS / Redis 三实现 + mirrored 兼容层 + 延迟与重放语义 |
| `eval-core` | 755 | 考试院：硬断言 DSL（零 token、可复现）、红线与 scorecard、错题沉淀 |
| `computer-use` | 790 | 三层感知（CDP/AXTree/截图，65 动作）CLI/MCP/HTTP 驱动，含仓内 vendor `toolkit/` |
| `review-console` | 563 | 审批状态机：三手势（批准/修改/驳回）、角色门禁、权重、幂等与过期 |
| `tenancy` | 509 | 多租户上下文与演示身份 JWT（真实 IdP 对接列入停车场） |
| `audit-core` | 414 | 通用审计编排：覆盖度降级、软预算、编号、排序、聚合、异常不阻塞 |
| `wizard` | 273 | 行业落地向导状态机与编排（技能一/二/三 → 交付配置），行业内容零预置 |
| `testing` | 55 | 内存假 pg（只登记被测代码真实发出的 SQL，未注册即抛错，防假阳性） |

补充：`packages/runtime` 是 dsh seam 适配层（意图路由、Ask/Agent/Quest 循环、装配、工具、剧本），`packages/shared` 承载五元 zod schema 与枚举，`packages/ui` 是三端共享组件与视觉语言（经稳定版本分发）。

### 3.4 关键执行链路

`用户输入 → 意图路由 → 预设/班组装配 → Quest/TaskGraph → 每步围栏判断 → 自动执行或人工审批 → 回执 → 事件账本 → 记忆/评测/投影`

- 意图会被分为问答、单 Agent 和多步骤 Quest 三种模式（`packages/runtime/src/intent.ts`）；LLM 分类 + 规则兜底 + 澄清分支（含糊指令先反问，不盲目建任务），超时降级可见可取消，误路由可终止并以逆向补偿事件回滚。
- 班组装配要求人员档案、阶段和目标齐全；有效权限是预设与已安装技能围栏绑定的并集，而不是模型自行决定。
- Quest 的每一步都先走围栏，再执行、评审或阻断；没有回执就不能宣称完成；步骤 ID 与事件 ID 支持重放与断点续做。

### 3.5 WorkData 与账本、围栏、考试院、覆盖层

WorkData 事件以五元结构记录业务事实（`packages/shared/src/event-schema.ts`）：`who`（谁做的）、`context`（租户/会话/任务/环境）、`object`（业务对象）、`decision`（判断或动作）、`rule_impact`（规则与风险影响）。配合回执 schema、模型调用轨迹、哈希链、PII 深度脱敏（`[PII:KIND:hash8]`）、租户 RLS 与重放前缀，承担黑匣子、审计证据和经验素材三种职责；schema v1 字段只读冻结，行业扩展只允许在 `context`/`object`/`decision` 内加字段。

- **围栏与审批**：服务网关顺序是 `权限校验 → PII 脱敏 → 高风险审批校验 → 写入事件`；围栏判定是确定性纯函数，冲突 `block > review > auto`，写操作无命中按 `default_level`，求值异常按阻断。高风险审批必须存在、未过期、内容匹配、状态已批准，伪造 ref 必拒；驳回必填原因枚举、修改必带新值；跨渠道回调靠幂等与单次消费收敛。
- **考试院与进化**：上岗考试（示例包 36 题含 16 道 AI 专项与红线题）；评测核心表含 `holdout` 隐藏集口径（防应试）；失败/驳回/修改手势经 `badcase-harvest`、`eval-forge`、记忆提炼器沉淀为评测资产与组织记忆，并回流为偏好注入。
- **个性化覆盖层**：基座与行业默认资产不被客户直接改写；客户配置以覆盖层叠加（`merge.ts`/`rebase.ts`/`assembly-hook.ts`）；围栏只能收紧（基线 `is_baseline` 单调守卫 + 合并期二次校验）；可生成快照与回滚，rebase 区分兼容/可自动回退/需人工决策。
- **事件总线与可靠性**：`EVENT_BUS=memory|nats|redis`（缺省自动探测，安装包可内嵌 NATS）+ mirrored 兼容层；设计目标含 ack、重放、延时任务、至少一次投递。仙女座在此基础上叠加 outbox、投影、限流熔断、慢车道、租约、漏触发对账、SLO 燃烧率、热更新、主备 fencing 与容量模型。

## 4. 仙女座与 AI 产品经理流水线

仙女座是平台自用经营体，不是另一个客户行业版：既有与行业项目相同的数字员工/技能/围栏结构，也有平台专属工程运维能力。

### 4.1 组织与职责

- 平台 Bundle 当前定义 **23 名平台数字员工**：技术支持工单组、知识管理组、客户成功组、计费账务组、平台运维组、行业包运营组、策略运营组，以及账号域 6 名（账号专员、登录卫士、生命周期专员、权限审计员、伙伴瞭望员、密钥保管员）。
- 需求通过客户、运营、内部三类入口进入，以工单为账本、以技术支持为桥梁、以知识库为弹药；运营机制以自生长为引擎：工单、知识、运行证据、评测与复盘持续转化为可审计、可灰度、可回滚的能力改进。

### 4.2 AI-PM 流水线

14 名数字员工（产品总监领队 + 需求分析师、竞品侦察、数据洞察、用户倾听、文档撰写、行业雷达、发布守卫、研发派发、模型侦察、评测官、提示词主理、红队官、知识保鲜官）。需求先经过澄清四问与确认单再进入研发；变更经过人审立项、开发、评测、灰度、发布、验收和第 3 天回访；关键节点向客户回传。这不是“自动写代码”的单点能力，而是把产品研发本身做成受围栏、评测与发布闸门约束的自主流水线。

### 4.3 平台专属能力（`platform-ops/`，读码结论）

`platform-ops/src/` 是一方工程资产，模块即防线：

| 子域 | 文件 | 作用 |
|---|---|---|
| `safety` | `change-classifier.ts` / `change-gate.ts` / `protected-paths.ts` / `blast-radius.ts` / `change-freeze.ts` / `sandbox.ts` / `standby.ts` | 变更分级 C0–C3、保护清单闸、G1–G6 闸门流水线、影响范围分析、熔断、沙箱演练、主备切换 |
| `accounts` | `operators.ts` / `totp.ts` / `totp-db.ts` / `dashboards.ts` | 平台账号运营、TOTP、看板 |
| `bus` | `outbox-relay.ts` / `stream.ts` | 事务消息 relay 与流 |
| `gateway` | `ingest-gateway.ts` / `push-gateway.ts` | 接入与推送网关 |
| `hotupdate` | `rollout.ts` / `asset-cache.ts` | 热更新灰度与资产缓存 |
| `runtime` | `lease.ts` / `slo.ts` / `trigger-watchdog.ts` | 租约、SLO、漏触发看门狗 |
| `stability` / `capacity` | `load-model.ts`（+stability 域） | 限流熔断、容量模型 |

配套 `safety/`（受保护清单、镜像落点、演练制度）与 CI `safety-gate`：镜像备份落点为“工蜂 / CNB 双托管”，每日 03:30 夜班窗口 + main 推送后执行；季度故障演练（杀主库 RTO ≤60s、杀 Redis RTO ≤10min、误删保护文件恢复 ≤30min 等）。这些能力属于运营中枢边界，不得下发客户行业仓（基座/行业载荷按产品身份排除 `platform-ops`，见 §13 的 B-01.PB-1）。

## 5. 十二个仓库的定位与代码理解

组织 `workloom-ai` 当前共 12 个仓（2026-09-22 核验）：**十个订阅仓**（基座 + 9 个子仓，含实验车道 `WorkLoom-growth`）参与同步与纳管；**两个隔离副本**（§5.8/§5.9）只登记、双向不同步。下表为 2026-09-17 深读快照（各仓 `main` 均为单次 rescue 提交，括号内为被保存的本地树来源 SHA）；`WorkLoom-growth` 与两个隔离副本为 2026-09-18 之后新增，分别按 2026-09-20 与 2026-09-22 快照记录。

| 仓库 | HEAD 快照 | 定位 | 代码层面的主要差异 |
|---|---:|---|---|
| [`workloom-im`](https://cnb.cool/workloom-ai/workloom-im) | `3c74ee0`（源于 `cfd8658`） | 公共基座 | 26 个 base 域 + runtime/shared/db/ui；三端 + 桌面 + 官网；`bundles/{ai-pm,hotel,platform}`；`scripts/suite.ts` 21 域约 371 条场景用例 |
| [`workroom-andromeda`](https://cnb.cool/workloom-ai/workroom-andromeda) | `cc34a1a`（源于 `cae5196`） | 平台运营运维中枢 | `bundles/platform`（23 员工 / 11 技能 / 10 规则）+ `platform-ops/src`（9 子域）+ `safety/`；三端以平台运营为首页 |
| [`workloom-hotel`](https://cnb.cool/workloom-ai/workloom-hotel) | `85887a9`（源于 `bed4f6e`） | 酒店自主经营系统 | `bundles/hotel` 3.2.0：11 员工 / 26 技能 / 基线 20 条 + 4 个业态补丁；体检→影子→托管三阶段 |
| [`hyperreality-system`](https://cnb.cool/workloom-ai/hyperreality-system) | `a2cfc91`（源于 `5583faf`） | AI 视频社媒营销经营体 | `bundles/ai-video` 1.0.0：33 员工 / 9 技能 / 5 条管线 / 235 条素材库；`vendor/supermickey` 制作引擎 |
| [`workloom`](https://cnb.cool/workloom-ai/workloom) | `2a2b390`（源于 `50bdb23`） | 酒店获客复合系统 | 三包组合：`geo-growth` 1.0.0（16/6/17）+ `ai-video` 1.0.0（33/8/21）+ `hotel` 3.4.0（16/30/74） |
| [`panda-cineforge`](https://cnb.cool/workloom-ai/panda-cineforge) | `0005634`（源于 `876a002`） | 电商自主经营系统 | `bundles/ecommerce` 1.0.0：82 员工 / 161 技能 / 28 对象 / 8 阶段 / R1–R30 + 4 补丁；`packages/connectors` 连接器层 |
| [`WorkLoom-growth`](https://cnb.cool/workloom-ai/WorkLoom-growth) | `e887ffca` | 获客增长·实验车道 | 与 `workloom` 同源的**第二实例**：`productId=workloom-ai-growth`、`portOffset=420`、`appId=…workloomgrowth`；游戏化经营定制（`hud/**`、`star-ring/**`、`pages/p0/**`）；登记 `lane: experiment`，实验语义不下发/不覆盖/不回流 |
| [`workroom-tiger`](https://cnb.cool/workloom-ai/workroom-tiger) | `394cd47`（源于 `b8a59f5`） | 全球资产管理高风险试验 | Python 交易内核（23 个顶层模块 + agents/markets/portfolio/redline/llm/providers 等子域）+ `governance/` 治理壳 + `trading` 0.1.0（37 员工 / 19 围栏） |
| [`workroom-eagle`](https://cnb.cool/workloom-ai/workroom-eagle) | `efcae26`（源于 `acba266`） | 鹰眼 AI 咨询管理系统 | `bundles/consulting` 2.0.0：22 员工 / 199 技能 / 9 条基线围栏 / 4 套服务前台知识；`ai-pm` 1.0.0 与 `hotel` 1.0.0 为兼容包 |
| [`workroom-fox`](https://cnb.cool/workloom-ai/workroom-fox) | `7dfa488`（源于 `2cc4167`） | “懂汇报的狐狸先生”试验田 | 同源酒店版（`hotel` 3.2.0，与酒店仓仅差 `bundle.json` 与 `service-front/client.json`）+ M1 视听层（audio/voice/loommate） |

> 快照说明：上表 HEAD 是 2026-09-17 深读时的值；此后各仓持续演进（例如 `workloom-im` 2026-09-22 的 `main` 已到 `3a39a26`，`workloom-hotel` 到 `21c680b`）。引用时以各仓 `main` 实时值为准。

### 5.1 WorkLoom Hotel

- 采用 `audit-only → shadow → managed` 三阶段取得经营权；体检分两档：`fast-scan`（15–30 分钟快照快扫）与 `inspection-suite`（1–2 周持续体检）；体检期由 `fences/patches/audit-only-patch.yml` 物理阻断全部写操作。
- 11 个岗位 preset：前台、客房、收益、渠道对账、口碑、巡检、竞对、内容、电话前台、桌面助理、业主驾驶舱；26 个技能含夜审、收益矩阵、渠道对账、超售倒挂看门狗（`overbooking-parity-guard`）、差评危机、语音前台（`phone-concierge`）、断点根因闭环。
- 围栏结构：`hotel-baseline.yml` 20 条 + 四个业态补丁（低星单体 4 / 民宿 4 / 无人酒店 6 / 体检模式 19），共 53 条规则；三套审批模板（民宿一人店、无人酒店委托型、集团门店分级型）。
- 三端：PC 工作台、店主端（移动 B）、住客端（移动 C）+ 数字孪生演示（`demo/twin`）。

### 5.2 WorkRoom Fox

- 与酒店仓同源（`hotel` bundle 3.2.0），未形成独立行业语义；`sync/child-repos.json` 明确标注“其基座演进不回流”。
- M1“视听觉醒”在 `apps/web/src/` 落地为独立层：`audio/{AudioEngine,ambience,sfx}`（三层音效，WebAudio 程序化合成、零音频资产）、`voice/{VoiceEngine,SubtitleBar}`（端侧 `speechSynthesis`，7+1 音色、优先级队列、熔断强制打断、TTS 不可用降级纯字幕）、导演运镜（事件驱动镜头 + 日频次熔断 ≤6 次）与视线感知（注视 1.5s 引发点头与状态浮层）。
- 数字人：`apps/web/src/components/loommate/`（Live2D 主后端 + 登记文档 `VENDOR.md`），详见 §12。
- 账号实验覆盖门店四角色、一人多店统一待办、伙伴协作授权；这些是酒店实例语义，不得回灌公共层。

### 5.3 HyperReality

- `bundles/ai-video` 1.0.0：33 个岗位、9 个技能、5 条管线、235 条素材库条目；管线为 `narrative-film`（叙事片）、`marketing-film`（营销片）、`account-ops`（账号经营）、`ads-creative-factory`（投流素材工厂）、`settlement-recon`（分账对账）。
- 叙事片管线步骤（读 YAML）：剧本蓝图 → 场景设计 → 片头设计（30 字段）→ 视觉语言 → 音频设计 → 连贯性导演评审 → 提示词融合 → 字段质检 → 定妆照 → 预生产确认 → 渲染 → 后期 → 成片入库；每步 = 一张 Quest 任务卡，产物写五元事件、断点续跑继承 replay。
- 25/30 字段镜头卡：内容镜头 25 字段、片头 30 字段（+5 专属），字段标准化以 `FieldStandardizer` 为唯一真源，导出前 25 字段非空硬检查，P0 致命级 12 字段 / P1 核心级 7 字段分级校验。
- 生产引擎以 `vendor/supermickey/`（约 11MB，四层架构：剧本→制作→渲染→后期）为基线，配合三供应商降级链与全平台 RPA 发布；成本按“文本加工费 / 视频原材料费”分池，渲染额度 ledger 由 `render.submit` 事件投影。

### 5.4 WorkLoom 获客系统

- 三包精确版本组合：主包 `geo-growth` 1.0.0（16 员工 / 6 技能 / 4 管线 / 17 条围栏）+ `ai-video` 1.0.0 + `hotel` 3.4.0。
- `geo-growth` 4 条管线：`intel-fusion`（选题情报双向流动）、`dual-content-factory`（内容一次生产两处变现）、`visibility-watch`（AI 能见度监测）、`ops-rhythm`（双域经营节拍）。
- `dual-content-factory` 步骤（读 YAML）：脚本成套 → 实拍/AI 生成分流 → 脚本人审（gate G9）→ GEO 六段式改写 → 事实红线校验（gate G-GEO2）→ GEO 外发必审（gate G-GEO1）→ 社媒组分发 → 信源组分发 → 结果回写一客一档；双审制（传播力 + 事实结构）与实体锚点逐字一致是硬约束。
- 6 个 GEO 技能：`geo-query-craft`（四词类 × 双语的 query 集）、`ai-answer-rewrite`（六段式改写）、`visibility-monitor`（豆包/DeepSeek/元宝/ChatGPT 多平台采集 + 截图存证）、`citation-reverse`（引用源逆向）、`entity-consistency-check`（实体一致性巡检）、`dual-entry-inquiry`（双入口归因）。
- 本仓内嵌 `hotel` 3.4.0 比酒店主仓 3.2.0 更新：多出 `ai-receptionist`、`channel-watcher`、`company-ceo`、`coupon-operator`、`guest-success` 等岗位与 `coupon-ops`、`hotel-geo-content`、`intent-radar`、`lead-concierge` 等技能（获客域扩展）。

### 5.5 Panda Cineforge

- `bundles/ecommerce` 1.0.0：82 个岗位、161 个技能（其中 48 个标注“★门道固化”）、28 类经营对象、8 个经营阶段；技能覆盖选品/刊登/广告/客服/售后/库存/履约/财务/合规/组织全域（`acos-fuse`、`ads-autopilot`、`aftersale-defender`、`appeal-kit`、`board-report`、`cash-sandbox` 等）。
- 围栏：`ecom-baseline.yml` 30 条（R1–R30）+ 四个业态补丁（腰部卖家 6 / 体检模式 12 / 中国多平台 6 / 跨境集团 8），共 62 条；客户补丁只可收紧。
- 平台接入层是独立包 `packages/connectors`（`@workloom/connectors`）：类型 + 接口契约 + 注册表 + mock 适配器（`PLATFORM_PROFILES`），开发时必须区分真实连接与体验模式，禁止让演示回执伪装成平台成功。
- 服务层与测试已按电商语义改写（见 `sync/child-repos.json` 的 `extraExclude`：service 三件套测试、workdata/tenancy 等测试文件在本仓不参与基座同步）。

### 5.6 Eagle

- `bundles/consulting` 2.0.0：22 个数字员工、199 个专业技能（189 个细分 + 10 个核心管线技能）、9 条基线围栏、4 套服务前台知识（`faq` / `client` / `client-guide` / `service-catalog`）。
- “一企一档”分七区：基本面、经营仪表盘、认知沉积、人物志、行动账本、文件库、价值台账；三条宪法是认知资产归客户（local-first）、每条建议挂依据链（五元事件 + 哈希链）、客户数据不外发（围栏 C-R9）。
- 人机分工铁律：澄清会、访谈执行、诊断定调、汇报会、续约谈判 5 类高信任场景由围栏 C-R4（block）禁止 AI 替身；30 个服务环节中 11 个可自动、13 个人机协作、6 个必须人做。
- 信任公式：`信任 = 判断力 × 上下文深度 × 可归因性`。仓内 `ai-pm` 1.0.0 与 `hotel` 1.0.0 仅为兼容/回归用途。

### 5.7 Tiger

- 双栈架构：Python 交易内核在仓库根（`main.py` + `trading_system/`，23 个顶层模块 + `agents/`、`markets/`、`portfolio/`、`redline/`、`llm/`、`providers/`、`tech_chain/`、`search/`、`cleaning/`、`review/` 等子域）；WorkLoom 治理壳在 `governance/`（`base-sync` 的 `pathPrefix=governance/`）。
- 21 环节管线由 `trading_system/redline/` 的 `STEP_REGISTRY` 定义（search.collect → clean.rule_base → clean.llm_semantic → clean.cross_validate → data.prepare → tech.monitor → tech.cycle_linkage → tech.sentiment → tech.risk → tech.fusion → sector.narrative → layer1.mrs → …）；`ExecutionTracer.assert_complete()` 强制逐环节打点，缺环即 `RedlineViolation`；LLM 环节唯一合法降级是 `Passthrough`（透传披露），代码库中不存在“LLM 失败→改用规则计算”的分支，并由 pytest 注入故障锁定。
- 决策栈：L0 全市场扫描 → L1 MRS 市场许可（≥6 才可标准开仓，<4.0 全面禁开仓）→ L2 SHS 主线确认（≥7.5）→ L2b ICS 链景气 → L3 TSS 买点评分（≥7.2）→ L4 风控闸门（1R = 净值 0.8%、单票 ≤20%、结构/时间双轨止损、Kill Switch）。
- `trading_system/config.py` 是所有阈值/权重/档位表的单一事实源；`trading_system/gate.py`（v6.0）统一闸门引擎让生产与回测共用同一实现（修复了 v5.4 审计发现的“生产改了回测没改”漂移）；`governance_bridge.py` 把内核动作翻译为五元事件，append-only 写入 `reports/governance_events.jsonl` 并维护 SHA-256 哈希链。
- 多市场：`markets/{us,cn,hk}.py` + `registry.py` 唯一解析出口；组合层 `portfolio/{allocator,sentinel,steward}.py` 对应全球资产配置官/宏观哨兵/风险官与收益稳定官。
- 治理包 `governance/bundles/trading` 0.1.0：37 个岗位 preset、10 个技能目录（6 个已入签名索引）、19 条由 `config.py` 生成的围栏规则（R-T0~R-T15 + R-P1~R-P3，生成器产物为唯一发布物）；测试 `tests/` 31 个文件（含 `test_v54_audit_fixes.py`、`test_gen_fences.py`）。
- 合规边界：仅模拟盘、不做真实下单；运行报告如实标注离线合成数据与 LLM 透传；结果不构成投资建议。

### 5.8 WorkLoom-growthtest（隔离副本 · AI超增长·实验版）

- **来源与身份**（CNB 元数据 + 仓内 manifest，2026-09-22 核验）：2026-09-21T00:28Z 建仓，完整复制自 `workloom-ai/WorkLoom-growth@a6dc89a`；`product.manifest.json` 为 `productId=workloom-ai-growth`、`role=industry`、`packageName=workloom-ai-acquisition`、`defaultBundle=geo-growth`、`appId=com.geniusdapeng.workloomgrowth`、`portOffset=420`，与 `workloom` / `WorkLoom-growth` 同产品身份。
- **当前 HEAD**：`main@98d5ecde`（`feat(growth): 基座去审批化——下线审批中心/任务中心与统一待办的审批状态，保留业务链路关卡 [T-2026-0921-0043] (#8)`）——这是**与基座不变量（高风险必须人审、先围栏后动作）直接分叉**的改造，属于激进实验，不能进基座、也不能下发。
- **隔离状态**：`sync/child-repos.json#isolatedRepos` 登记（`syncPolicy: none-in-none-out`）；分支列表只有 `main` + `task/*`（无 `sync/base-*`，说明基座 fanout 从未向其推送）；仓内 `.workloom-base-sync.json` 继承自复制源（`lastSyncedBaseSha=8789675` / `lastRequiredAssetsBaseSha=ae3f9e3`，2026-09-20T11:14Z），**冻结不再更新**。
- **在途改动**（2026-09-22 快照，2 条 open PR）：调色择优「配方驱动」（`T-2026-0921-0044`）、growth 视频链路修复批次（`sync/video-chain-fixes-20260921`）。
- **受控文档副本**：建仓时随源复制了 `WORKLOOM_PRODUCT_CONTEXT.md`（`d82d96e5…`，即 2026-09-19.2 版）与 `docs/DEVELOPMENT-PROTOCOL.md`（`db574333…`）；隔离期内不接收更新，**不代表最新认知**，引用时以基座原文为准。

### 5.9 WorkLoom-growthmatrix（隔离副本 · 骇客帝国·实验版）

- **来源与身份**：2026-09-21T00:46Z 建仓，同样完整复制自 `workloom-ai/WorkLoom-growth@a6dc89a`；manifest 身份字段与 §5.8 相同（同 `productId` / `appId` / 端口），`displayName=骇客帝国`。
- **当前 HEAD**：`main@0d41de9`（`fix(growth): 补回视频生成媒体目录资产并让产品内容门禁接受 CNB 地址 [T-2026-0921-0004] (#4)`）；分叉方向偏视频链路与后期调色（见在途 PR）。
- **隔离状态**：与 §5.8 完全相同——`isolatedRepos` 登记、无 `sync/base-*` 分支、基座资产摘要冻结在复制点。
- **在途改动**（2026-09-22 快照，3 条 open PR）：调色择优「配方驱动」（`T-2026-0921-0043`）、移植后期调色能力（调色师岗位 + 4 技能 + 13 题材配方库 + 工位桥 + 择优机制，`T-2026-0921-0042`）、growth 视频链路修复批次（`sync/video-chain-fixes-20260921-mx`）。
- **共同风险**：两仓同 `productId` 与 `appId`，若将来解除隔离，必须先统一产品身份（productId / 端口 / 演示工作区）再纳管，否则安装包、桌面身份与演示工作区会互相覆盖（协议 §9.3 注意条款）。

## 6. 基座同步与仓库治理

基座通过同步配置向子仓分发公共代码，同时保护行业差异。三端的导航、布局、状态接线与客户端 API 契约本身也是 WorkLoom IM 基座能力，不是各行业仓可以自行复制演进的页面代码：

- **范围声明**：`sync/base-scope.json`（v13）是同步边界的唯一事实源。include 公共 packages、runtime、shared、db、server 源码、desktop、scripts 与 `docker-compose.yml`；exclude 行业 bundles、demo、docs、mock、vendor、design-system、三端页面与行业服务、迁移与行业技能等。
- **订阅清单**：`sync/child-repos.json`（v5）维护子仓、`pathPrefix`（Tiger 为 `governance/`）、`uiRolloutWave`（W1–W5 波次）与仓级 `extraExclude`（Panda 的电商化改写文件、Tiger 的服务层测试）；顶层 `isolatedRepos` 登记**双向不同步**的隔离副本（growthtest / growthmatrix），舰队扫描、纳管与 fanout 按此过滤。
- **根级必备资产**：`WORKLOOM_PRODUCT_CONTEXT.md`（本文）整文件验真下发；`AGENTS.md` 只按受控区块（`WORKLOOM-CONTEXT:BEGIN/END`）合并；`.github/workflows/base-sync-heartbeat.yml` 由模板复制。
- **受保护实例资产**：`electron-builder.yml` 与 `product.manifest.json` 不被整文件覆盖，身份字段（appId、productName、demoWorkspaceSlug、demoMemberNo、ports、publish）属于部署实例。
- **UI 与三端基座**：`@workloom/ui` 与三端客户端基座按同一稳定版本经升级 PR 分波下发；行业扩展只允许落在 `apps/*/src/{extensions,projections,config/industry,theme/industry}/**` 等显式排除路径。
- **污染守卫**：路径黑名单含 `^bundles/`、`^demo/`、`^docs/demo`、`^scripts/seed`、`^scripts/demo` 与 `hotel-baseline`、`ai-pm`、`yunqi`、`ecommerce`、`panda-cineforge`、`platform-ops` 等子串；单次常规同步上限 200 文件，新行业接入放宽至 450，超限即中止并要求人工核对。
- **平台工程不出仓**：Andromeda 的 `extraExclude` 显式排除 `platform-ops/**`，与 `safety/` 保护清单、载荷身份策略（B-01.PB-1）形成三重护栏。
- **实际同步基线**（2026-09-22 实测，快照事实，引用前先刷新）：各订阅子仓的 `.workloom-base-sync.json` 在最近一轮 required-only fanout（2026-09-21T16:26Z）后记录 `lastRequiredAssetsBaseSha=9bd0d268…`（本批基座合并点），`lastSyncedBaseSha=55f57a9…`（实验车道 `WorkLoom-growth` 为 `8789675…`，因其 lastSyncedBaseSha 仅在 full 波次推进）；`requiredRootAssetsSha256` 随“基座 fanout → 子仓 `sync/base-*` PR → 门禁全绿自动合并”的通道持续收敛（2026-09-19 起，机制见 `docs/FLEET-AUTO-SYNC.md`；运行时代码按协议 §1/§9.5 走代码车道——门禁全绿 + 冷却期 + 串行，同样由 AI 合并，人保留叫停权）。

后续跨仓开发默认顺序：先判断能力属于公共基座、平台中枢还是行业包；公共机制优先在 `workloom-im` 实现并通过同步下发；行业语义仅在对应 bundle/子仓实现；平台运营工程仅在 Andromeda；同步后逐仓运行类型检查、测试、围栏/评测和打包门禁，不能只看文件复制成功。

## 7. 官网产品规划的近期重点（含 2026-09-17 代码落地核对）

### P0

- 租户个性化覆盖层：**已交付且专项审计中**（`packages/base/overlay/` 2676 行，含合并/回复/rebase/文档导入；本批 HP-01 正在做跨租户与只紧不松的动态验证）。
- L1 自然语言需求入口：**已交付**（意图路由 + 澄清反问 + 行业落地向导 `wizard/`）。
- 事件总线持久化与可靠重放：**已交付**（memory/NATS/Redis + mirrored + 重放前缀；本批 HP-22/HP-23/HP-36 待做故障注入与持久化专项）。
- 长任务中断/恢复看板：**部分交付**（Quest 步骤级 replay 与断点续跑在 runtime；未见独立看板页）。
- 失败轨迹自动转评测用例（错题本闭环）：**部分交付**（`eval-core` + `holdout` + `badcase-harvest`/`eval-forge` + 失败回流种子；全自动归因到用例的端到端仍需验收，属 HP-04 范围）。

### P1

- 反向访谈与更完整的需求澄清：**未见实现**（仅规划文本）。
- L2 多角色编排：**已交付**（ASK/QUEST 编排 + captain 节拍 + 夜班调度）。
- 投影快照和事件 Schema Registry：**部分交付**（`projections:generate`/`projections:check` 生成并校验三端投影；事件 schema 冻结在 `packages/shared`，未见独立 Registry 服务）。
- TaskGraph：**未见实现**（仅出现在链路描述与规划中）。
- 蜂群经验上传白名单与匿名化：**已交付**（`skill-ops` autosync/reflux/console + PII 脱敏 + 六信号本地计算 + 双人复核）。
- 任务经济学、吞吐与留存平滑度指标：**未见实现**。

### P2

- 从共性中挖掘个性化需求：**未见实现**。
- 蜂群匿名化和经验数据库：**部分交付**（回流通道闭合，官方侧聚类/复核/官方化在 `skill-ops/console.ts`）。
- 完整的经验上行—评测—灰度—下发飞轮：**部分交付**（上行与下发闭合，考试/灰度依赖评测体系继续补强，属 HP-04/HP-25）。
- 与行业伙伴共建更深的业务模型：**进行中**（六条行业线各自沉淀 bundle）。

## 8. 后续开发必须守住的系统不变量

1. **租户隔离**：数据库 RLS、运行时上下文和缓存键都必须带租户边界（HP-34 待专项）。
2. **只增不改**：经营事件、审批证据和关键回执不可静默覆盖；修正应产生新事件。
3. **先围栏后动作**：任何入口和子调用都不能绕过统一网关（权限 → 脱敏 → 审批 → 事件）。
4. **高风险必须人审**：涉钱、涉敏感数据、群发、外部发布、交易与破坏性变更不能被默认自动化。
5. **无回执不算完成**：UI 状态、审计和任务恢复都以真实回执为准。
6. **客户原始数据不上行**：蜂群只接收经过白名单、脱敏与审核的元数据/经验。
7. **覆盖层只能收紧**：客户个性化不能突破平台不可变红线（`is_baseline` 单调守卫 + 合并期复核）。
8. **平台工程不出仓**：`platform-ops` 与平台账户/运维秘密只属于 Andromeda；载荷按产品身份排除并有后验检查。
9. **演示与真实能力分明**：mock、模拟回执和体验模式必须在界面与事件中明确标识（连接器层、LLM 透传、离线合成数据）。
10. **版本变更先考试再灰度**：模型、技能、行业包、策略和热更新都要可回滚。
11. **秘密不进代码或上下文文件**：令牌、密钥和客户凭证只应进入受控秘密存储或本地环境配置（当前桌面签名 secrets 未配置，见 §13）。
12. **高风险金融边界**：Tiger 在明确授权、合规设计和长期纸面验证完成前，不接真实资金与自动实盘。
13. **单一事实源**：策略阈值（Tiger `config.py`）、围栏生成物、同步边界（`sync/base-scope.json`）、订阅关系（`sync/child-repos.json`）、产品身份（`product.manifest.json`）各自只有一个写入点。
14. **底座行业零残留**：`packages/{base,runtime,shared,db}` 不得出现行业词（注释同责，D18）；行业语义一律经 bundle/seed 槽位注入，由 `scripts/hardcode-scan.mjs` 复扫。

## 9. 已发现、需要优先核实的漂移

### 9.1 托管迁移后的引用失配（2026-09-18 已解决）

**已修复**：九仓 `product.manifest.json#repository`、`.workloom-runtime-deps/metadata.json#product.repository`、`.workloom-base-sync.json#baseRepo`、`sync/child-repos.json`（baseRepo 与 8 个 children）、同步器/校验器常量与测试夹具、README 与官网链接全部切到 `cnb.cool/workloom-ai`；`runtime:deps:verify` 的输入摘要已随标识迁移刷新。

**仍待处理**：

- 迁移后的 `main` 历史仍是单次 “rescue” 提交（CNB 侧保留），依赖 `git log`/blame 的审计路径需另行设计；
- `.github/workflows/*` 保留为遗留（CNB 上不生效），发布类工作流需按需迁移；
- ~~自动 fanout 的 GitHub App 未配置（DEF-P2-0016），跨仓同步暂以受控脚本 + PR 执行。~~ **已解决（2026-09-19）**：CNB 原生 fanout（`sync/fanout-cnb.mjs`）按资产摘要做漂移预检并对漂移子仓开 `sync/base-*` PR，纯同步 PR 由 `sync/merge-sync-prs.mjs` 在白名单 + 全门禁 success 后自动合并；GitHub App 不再需要。

### 9.1.1 CNB 闸门落地（2026-09-18）

九仓已全部在 CNB 上建立流水线（`.cnb.yml`）：

- **基座 `workloom-im`**：`static-gate`（安装/秘密扫描/runtime 锁/typecheck/UI 治理/供应链与发布策略/base-sync 与客户端接入/三端构建）、`db-gate`（PG17+pgvector/迁移种子幂等/哈希链/集成测试/server E2E/全场景套件）、`ui-gate`（三端构建 + Playwright 响应式/视觉/无障碍）三条均为**必需检查**；`ui-release`（`api_trigger_ui_release`）负责构建并发布 `@workloom/ui` 到 CNB Release；
- **八个子仓**：`static-gate`（安装/产品身份/三端构建）与 `db-gate`（PG17+pgvector/迁移/种子幂等/验链）为**阻断**；`test-gate`（typecheck/主测试/全场景套件）为**显式非阻断**，登记既有债务；
- **UI 制品**：`@workloom/ui` 已从失效的 GitHub Release 迁移到 CNB Release（迁移首发 `ui-v0.1.1`，91,187 字节），`integrityByVersion` 同步更新；这是台账 DEF-P1-0015「下游 CI 既有红灯」的根因修复。截至 2026-09-22 最新已发布制品为 **`ui-v0.1.6`**（2026-09-19T14:04Z），订阅仓按 `.workloom-ui.json` 记录各自消费版本（实测例：workloom-hotel `0.1.6`、WorkLoom-growth `0.1.1`，随 ui-v* 波次推进）；
- **视觉基线**：Linux 基线在 CNB 同镜像内重生成后入库，`ui-gate` 由非阻断转为必需（实测约 4 分钟全绿）。

### 9.2 `bundles/platform` 双份漂移

基座 `workloom-im/bundles/platform`（17 员工、`provides.skills` 11、无账号运营导航槽）与仙女座 `workroom-andromeda/bundles/platform`（23 员工、账号域 6 名、`service-front/client.json`、账号运营导航槽）同为 1.0.0 但内容指纹不同；仙女座侧另有 6 个账号域技能目录（`account-health-daily`、`grant-watch`、`key-baseline`、`least-privilege-audit`、`lifecycle-run`、`login-anomaly-scan`）**未进入 `provides.skills` 签名索引**。需要确认基座内 platform bundle 的定位，避免两套平台岗位定义分叉。

### 9.3 行业包版本倒挂

- 酒店：主仓 `workloom-hotel` 为 3.2.0（11 员工 / 26 技能 / 基线 20 条），获客仓 `workloom` 内嵌 `hotel` 3.4.0（16 员工 / 30 技能 / 基线 26 条 + 补丁），即**行业主包落后于消费方副本**；狐狸仓与酒店仓同为 3.2.0，但 `bundle.json` 与 `service-front/client.json` 已分叉。
- 视频：`ai-video` 1.0.0 在 `hyperreality-system` 与 `workloom` 中内容不同（前者含 `fences/patches`、`service-front`、`segment-defaults.yml`、`fast-scan` 技能共 9 个；后者 8 个技能）。
- 治理包：`trading` 0.1.0 的 10 个技能目录只有 6 个进入 `provides.skills`。
- AI-PM：`ai-pm` 3.0.0 在基座与酒店仓指纹一致，仙女座为本地改写版；Eagle 保留 1.0.0（9 员工）兼容包。

建议：为每个 bundle 建立“唯一发布仓 + 精确版本消费”约束，消费方只按版本引用、不本地改写；跨仓版本比较由脚本产出。

### 9.4 随仓文档的版本漂移（深读新增）

- `docs/SUITE.md` 在九仓内容完全相同（同一 SHA），但只列 A–Q + HTTP E2E 域；`scripts/suite.ts` 实际已有 **21 个域**（新增 R 数字CEO、V 数字职场 floor、W 大版本融合回归、Y 技能保鲜环），即用例清单文档落后于代码。
- `docs/HARDCODE-AUDIT.md` 在九仓有 6 种不同版本（workloom-im 与 andromeda 相同；hotel/fox 相同；panda、hyperreality、workloom 各自不同），`docs/AUDIT.md` 有 3 种版本；同一份“审计事实源”在不同仓内容不一致。
- `docs/HARDCODE-AUDIT.md` 记录的基座门禁数字（base 385/385、suite 445/445）与 README 徽章（168 vitest + 371 suite）口径不一致，需要明确“哪一次运行、哪个仓、哪条命令”的导出口径。
- 基座内部用例数口径分裂：`ci.yml` 注释与步骤名写 326，README 与 `docs/SUITE.md` 写 371（服务层 344 + HTTP E2E 27），`docs/HARDCODE-AUDIT.md` 写 445，而 `scripts/suite.ts` 域注册实测约 369。建议以 suite 运行时导出为唯一口径并自动写入 README 与 CI 步骤名。
- README 与 bundle 统计漂移依旧：HyperReality README 写“25 人班组 / 三条管线”而 bundle 为 33 preset / 5 条管线；酒店 README 写“25 个技能套件”而 bundle 为 26。

建议：版本、员工数、技能数、围栏数、管线数、用例数一律由脚本从 `bundle.json` / `product.manifest.json` / `suite.ts` 自动生成到 README、docs 与官网；审计类文档按仓生成而不是复制粘贴。

### 9.5 基座目录边界仍混装

`workloom-im` 根目录仍同时存在 `bundles/platform/` 与 `platform-ops/`，而污染守卫把两者都列为禁止同步路径。需要产品所有者确认：基座中的 platform bundle / platform-ops 是可清理资产还是应完全移出；拆分前先建立迁移、同步污染守卫与回滚方案。

### 9.6 试验田语义出现在基座与行业仓文档

`docs/tech-design-m1.md`（M1 视听觉醒）同时存在于基座、酒店仓与狐狸仓的 `docs/`。需要确认它是公共交互能力设计还是误入主仓的试验项目文档，并据此决定保留、抽象或迁移；试验仓语义不得成为公共基座默认值。

## 10. 后续协作的默认判断框架

收到新需求时，先回答四个问题：

1. 它改变的是公共运行机制、平台运营机制，还是某个行业的业务语义？
2. 它会不会改变租户边界、围栏、审批、事件与回执这五个信任要素？
3. 它应该进入基座、Andromeda，还是一个/多个行业包；如何同步和防污染？
4. 它如何被测试、进入考试院、灰度、回滚，并把真实失败变成新的评测资产？

只有这四项回答清楚，才进入实现。开发前另需核对：目标仓 HEAD 是否变化、`bundle.json` 统计是否变化、审计台账中该能力域是否有未关闭的 P0/P1。

## 11. 凭证与“记忆”说明

- 本文没有保存任何令牌、密钥或客户凭证；十二仓均为开源项目，读取与继承上下文不需要私人令牌（本次核验即匿名只读克隆）。
- 十个订阅仓根目录持有 `WORKLOOM_PRODUCT_CONTEXT.md`（随基座同步刷新）与根级 `AGENTS.md`；两个隔离副本中的同名文件是**建仓时复制的冻结副本**（2026-09-19.2 版），隔离期内不更新，不代表最新认知。
- `workloom-im` 是本文唯一受控原文；订阅仓只接收校验过的副本；隔离副本不接收下发。新行业仓必须通过 `sync/adopt.sh --new-industry` 接入；有意与基座拆分的仓登记进 `sync/child-repos.json#isolatedRepos`（协议 §11）。
- 多仓审计台账（`AUDIT_PROGRESS.md` 等）目前只存在本地，因为 `workroom-andromeda` 是公开仓、不能承载敏感发现；在独立私有控制仓提供前，权威台账的落点问题（BLK-CTL-05-001）仍未关闭。
- 本次核验方式：匿名 `git clone --depth 30 https://cnb.cool/workloom-ai/<repo>.git` + 逐模块精读（模块入口注释、导出面、围栏/管线/技能定义、测试清单、审计文档），跨仓做内容指纹与差异比对；**未执行安装、构建、测试或数据库操作**。
- 未来任务应把本文作为可版本化的持久项目上下文，而不是模型的隐式跨对话记忆；实际开发前仍应检查目标仓最新提交和仓内规则，避免把 2026-09-17 快照当成永久现状。

## 12. 开源组件与仓库完整性（回答“每个仓是不是完整系统”）

### 12.1 三种存放形态

1. **仓内 vendor（随仓克隆即得，可离线阅读与审计）**
   - `vendor/dsh/`：DeepSeek Harness 运行时地基（`@deepseek-ai/dsh` 0.1.2-rc.1，MIT，约 68KB 的锁版 + 内部 fork 基线；Tiger 在 `governance/vendor/dsh/`）。
   - `vendor/dsh-im/`：dsh IM 通道插件（MIT，回馈上游形态），九个仓都有。
   - `vendor/supermickey/`：视频制作引擎（约 11MB，四层架构：剧本→制作→渲染→后期，含 `architecture-v2`、`seedance-micromotion`、`systems`、`templates`），**只在 `hyperreality-system` 与 `workloom`（获客）** 中。
   - `packages/base/computer-use/toolkit/`（约 296KB）：Anthropic computer-use 能力栈的仓内 vendored 形态，与 65 动作三层感知同栈。
   - 数字人素材：`apps/web/public/models/kaykit/`（5 个 GLB 角色 + 道具，**CC0 可商用**，76 组骨骼动画）；`apps/web/public/live2d/`（Mao 模型 4.4MB + shizuku 备份，**Live2D Free Material License，可商用**），配 `apps/web/src/components/loommate/`（Live2D 主后端 + 兜底海报 + 口型/表情/动作驱动四要素，登记文档 `VENDOR.md`）。写实 3D TalkingHead 路径因许可与观感问题已于 2026-09-06 移除。
2. **npm 依赖（锁定但不随仓携带）**：React、Hono、tRPC、Vite、Tailwind、Three Fiber、Pixi/Live2D 渲染插件、pg、zod 等，由 `package.json` + `pnpm-lock.yaml` 锁定，安装时从 registry 获取；共享 UI 包 `@workloom/ui` 作为**版本化制品**分发（2026-09-18 起托管在 CNB Release，由 `ui-release` 流水线构建发布，`integrityByVersion` 记录 SHA-512；截至 2026-09-22 的最高版本/最新发布为 `ui-v0.1.6`（86,345 字节，2026-09-19T14:04Z；平台未设 `is_latest` 标记），下载形如 `https://cnb.cool/workloom-ai/workloom-im/-/releases/download/ui-v0.1.6/workloom-ui-0.1.6.tgz`，具体版本以 CNB Release 列表与各仓 `.workloom-ui.json` 为准）。
3. **安装期受控下载（带 sha256，不随仓携带）**：Node 24.19.0（darwin arm64/x64、win x64）、npm 11.17.0、PostgreSQL 17（PostgresApp / zonky 嵌入包）、nats-server 2.11.4 等，登记在 `scripts/release-assets.json` 与各仓 `.workloom-runtime-deps/`（含 `metadata.json` 与 `package-lock.json` 的精确闭包；B-01.SC-4 已做到每产品 runtime lock + 三目标 os/cpu 闭包 + 12 直接依赖 verify）。

补充机制（2026-09-19 升级）：`oss-components.json` 已扩为**全量清单 v2**，并新增**每周上游扫描机制**（`feat(base): 开源组件全量清单 v2 + 每周上游扫描机制`，commit `44f48c38`）。`oss-components.json`（根目录）是受监测开源组件清单（name / repo / channel / current / cadence / gate / scope / notes），配 `skills/oss-watch/SKILL.md`、`scripts/oss-watch.sh` 与 `.oss-watch-state.json`，实现“清单登记 → 周期扫描 → 更新计划 → 一键执行 → 全量门禁 → 发布”；纪律是**扫描自动、升级走独立 PR 并由 AI 在门禁全绿后按协议 §1/§9.5 合并**（破坏性/大版本升级按 §3 人审放行，人保留叫停与回滚权）。清单里相当一部分是“选型在案、未进运行时”（如 mem0、presidio、langfuse、deepeval、promptfoo、skyvern、gui-agents、wrenai、lago、copilotkit、tauri、litestream 等），不要把清单条目等同于已集成组件。

### 12.2 结论

- **每个仓都是完整可运行的源码系统**：服务端 + 三端应用 + 桌面壳 + 数据库迁移/种子 + 行业包 + 技能 + 脚本 + 测试 + 官网，克隆后按 `pnpm setup` 即可拉起（依赖联网下载 npm 包与运行时资产）。Tiger 是特例：Python 交易内核在根目录，WorkLoom 治理壳在 `governance/`。
- **但“仓库完整”不等于“制品自包含”**：npm 依赖与 Node/PG/NATS 二进制不在仓内（这是刻意设计，且有摘要锁与供应链门禁）；LLM 密钥、平台连接器凭据、桌面签名证书均不在仓内。
- **开源组件是否在仓里，取决于通道**：dsh / dsh-im / supermickey / computer-use toolkit / 数字人素材（KayKit、Live2D）在仓内；React/Hono 等在 npm；Node/PG/NATS 在安装期下载；其余是选型登记。

## 13. 审计程序与验证成熟度（2026-09-15/16 → 09-18）

产品所有者于 2026-09-15/16 运行了多仓审计程序 `WORKLOOM-AUDIT-2026-09`（台账 `AUDIT_PROGRESS.md`、高优清单 `WorkLoom-高优核心能力审计执行清单.md`），冻结基座 `main@4f2296f…`，并要求“公共根因先在 WorkLoom IM 修复、再受控同步下游”。截至本版核验：

**工程化落地（2026-09-18 新增）**

- CNB 闸门已接管原 GitHub Actions 的角色：基座三条必需流水线 + 子仓分层闸门（详见 §9.1.1）；
- `@workloom/ui` 制品、仓库标识、九仓闸门三件事已全部完成并实测；
- 仍需人工配置：CNB 分支保护规则（当前令牌无仓库设置权限）；桌面签名/公证 secrets（BLK-B-01-003）。

**已合并并有门禁证据的修复（代码中可验证）**

- `B-01.1`（P0）：非交互重置可能直接清库 → 危险目标全部 fail-closed，客户工作区阻断并强制备份（`scripts/reset-safety.test.mjs`）。
- `B-01.PG-1/PG-2`（P0）：桌面数据库实例归属与鉴权 → `pg_ctl + PGDATA/port` 双验、三角色 SCRAM 正反向验证、旧 trust/MD5 前向迁移、状态绑定与进程锁（`scripts/desktop-bootstrap-db.mjs` 等）。
- `B-01.SC-1…SC-4`（P0/P1）：供应链与发布 → 资产摘要锁与原子下载（`scripts/release-assets.json` + `release-assets.test.mjs`）、发布旁路封禁（`release-publisher-policy.test.mjs`）、签名最小作用域与 Action SHA 固定（`action-pins.json` + `action-trust-policy.test.mjs`）、单一原子 publisher 与不可变 Release（`desktop-release-policy.test.mjs`、`desktop-release-state.test.mjs`）、每产品 runtime lock（`runtime-deps-lock.mjs`）。
- `B-01.PB-1`（P0）：平台工程边界 → 基座/行业载荷按受保护产品身份排除 `platform-ops`，运行目录与归档二次检查。
- 八个下游仓已从 `4f2296f…` 完成受控同步，每仓 27/27 治理测试 + runtime lock verify + 二次 detect clean；新增 P0/P1 = 0。

**进行中/未关闭（决定了“代码可信度边界”）**

- `HP-01`（tenant-overlay）进行中：`AUDITING`；其余 36 项中，`HP-29` `IN_PROGRESS/PARTIAL`、`HP-30` `PARTIAL`、`HP-31` `VERIFYING`，**其余 33 项为 `READY`（尚未审计）**。
- 三个发布 P1 未修（并入 HP-29）：不可变发行重跑恢复（DEF-P1-0012）、latest 并发 TOCTOU（DEF-P1-0013）、Artifact 来源摘要未贯穿下载边界（DEF-P1-0014）。
- 下游八仓一般 CI 仍有既有红灯（DEF-P1-0015，typecheck 与 ui-contract，属 SC-4 之前债务）。
- ~~自动 fanout 的 GitHub App 未配置（DEF-P2-0016），此前同步为手工受控；迁移到 CNB 后需重新设计。~~ **已关闭（2026-09-19）**：改由 CNB 原生 fanout + 纯同步 PR 自动合并承接（见 §6 与 `docs/FLEET-AUTO-SYNC.md`）。
- 桌面真实签名/公证/Bundle 私钥 secrets 未配置（BLK-B-01-003），阻断真实 desktop 发行，不阻断代码合并。
- 权威审计台账的私有落点未定（BLK-CTL-05-001）。

**读取方式说明**：本文的“已交付/部分交付/未见实现”判断来自代码结构、定义文件与既有审计证据；未被 HP 批次覆盖的能力域，尚不能视为“经过独立审计验证”。

## 14. 开发协作机制与舰队治理（2026-09-19 新增；2026-09-22 增补隔离副本车道）

**协议正文**：`docs/DEVELOPMENT-PROTOCOL.md`（workloom-im 唯一定义，随 base-sync 分发各订阅仓只读副本；当前协议 **v1 · 2026-09-22 修订**，含新增 §11 隔离副本车道）。核心是"不新造系统"——用 CNB 原生能力 + 三个校验脚本管住"谁在改什么、别撞车、会话断了能接上"。

### 14.1 五条硬规则

1. 一任务一分支一 PR：任务卡 = CNB Issue（标题 `[T-YYYY-MMDD-XXXX]`），分支 = `task/T-YYYY-MMDD-XXXX`（提交门禁正则 `\[T-\d{4}-\d{4}-\d{4}\]`）；
2. 提交标题 `<type>(<layer>): <摘要> [T-…]`；type ∈ `feat|fix|sync|protocol|exam|docs|test|chore|ci`；layer 仅告警；2026-09-19 起新提交必须带任务号（此前提交按过渡期祖父规则放行）；
3. 先声明后落笔：与同仓其它 open PR 改到同一文件或同一互斥模块（`sync/`、`protocol/`、`migrations/`、`.cnb.yml`、`AGENTS.md`、根 `package.json`）→ **先到先得**（编号小者优先），后到者排队；
4. 合并在机器、串行执行：AI 只提 PR，门禁全绿后由 AI 按队列一次一个合并（squash），人保留叫停与回滚权；
5. 无回执不算完成：Issue 必须留 5 行回执并关单。

### 14.2 自动化边界（哪些不用人管）

| 环节 | 自动化方式 |
|---|---|
| 提交规范校验 / 并发冲突检测 | 每仓 `.cnb.yml` 协议门禁 stage（`scripts/ci/verify-*.mjs`，含自检与真实校验） |
| 类型检查 / 测试 / 构建 / 迁移种子验链 / 三端视觉 | 基座三条必需流水线（static/db/ui）+ 各仓 static/db 阻断 |
| 禁止直推 / 强推 / 删除 / NPC 自批 | CNB 分支保护规则（十个订阅仓已配；隔离副本仓不新增/修改） |
| **新仓发现与纳管** | 每日 cron（09:00）`scripts/tools/fleet-scan.mjs --issue --provision`：识别 → 开扫描卡 → 自动建纳管 PR（隔离副本仓按 `isolatedRepos` 跳过，只单列报告） |
| 任务卡建卡 / 回执 / 关单 | `scripts/tools/task.mjs new|list|receipt` |
| 实验路径护栏 | 每日 cron `scripts/tools/experiment-guard.mjs --check` |
| **基座资产分发**（根级受控资产 → 各仓 `sync/base-*` PR → 合并） | 30 分钟 cron + `api_trigger_base_sync`：`sync/fanout-cnb.mjs` + `sync/merge-sync-prs.mjs`（仅纯同步 PR 自动合并，白名单见协议 §9.4） |
| **代码类 PR 合并 / 高风险裁决 / 协议发布** | **AI 执行合并**（门禁全绿 + 串行；`risk/review` 放行后合并，`risk/block` 永不合并）；**人**保留高风险裁决与随时叫停 / 回滚权 |

### 14.3 工具与服务

| 工具 | 作用 |
|---|---|
| `scripts/tools/cnb-api.mjs` | CNB API 封装（含分支保护全字段 payload——少字段会被平台判 400） |
| `scripts/tools/fleet-rules.mjs` | WorkLoom 仓识别（manifest schema / base-sync state / bundle schema 三级）、舰队差分、隔离副本集合（`isolatedFleet` / `isIsolated`） |
| `scripts/tools/fleet-scan.mjs` | 扫描组织 → 分类 → 与 `sync/child-repos.json` 差分 → `--issue` / `--provision` / `--check` |
| `scripts/tools/provision-protocol.mjs` | 单仓纳管（10 标签 + 分支保护 + 协议资产 + 协议门禁 stage + PR），幂等；隔离副本默认拒管（`--allow-isolated` 才放行） |
| `scripts/tools/task.mjs` | 任务卡 `new` / `list` / `receipt` |
| `scripts/tools/experiment-guard.mjs` | 实验车道护栏：实验路径不得被 base-sync 覆盖、必须进 UI 扩展白名单；同时校验隔离副本登记完整且未混入 `children`（`ISOLATED_IN_CHILDREN`） |
| `sync/fanout-cnb.mjs` | 基座 fanout：资产摘要漂移预检 → 只对真漂移子仓 clone → 建 `sync/base-*` PR（在途去重、不强推）；入口过滤隔离副本（`isolatedRepos` 不下发） |
| `sync/merge-sync-prs.mjs` | 纯同步 PR 自动合并：分支前缀 + 文件白名单 + 全部门禁 success 三条件齐备才合并 |

**任务集看板**：`workloom-ai/WorkLoom-Dev-Dispatch`（纳入十仓，按 `t/*` 标签分列；CNB 任务集名不允许空格与中文）。**标签体系**：每仓 10 个（CNB 硬上限，实测第 11 个返回 201 但不落库）。隔离副本仓不参与任务集看板与协议纳管。

### 14.4 实验车道（fox / growth 的深度定制保护）

`workroom-fox`（3D 汇报舞台 + 实景商业游戏 M2-a）与 `WorkLoom-growth`（经营游戏化）在共享壳上做了深度定制，**不属于基座能力**。保护机制三层：

1. **声明**：`sync/child-repos.json` 标 `lane: experiment` + `experimentNote` + `experimentPaths` + 仓级 `industryExtensionPaths`；
2. **工具支持**：`sync/client-foundation.mjs` 支持仓级扩展白名单（`extraAllowedIndustryExtensionPaths`）→ 实验路径在三端基座升级时不再被判"行业分叉"、也不会被覆盖；
3. **护栏**：`experiment-guard` 每日检查"是否会被同步覆盖 / 是否会被判分叉 / 是否漏写声明"，违规即红。

纪律：实验仓只增不改基座契约；实验验证成功的通用能力必须先走提案任务卡（L2→L1→L0）才能进基座。

### 14.5 隔离副本车道（growthtest / growthmatrix，2026-09-22 新增）

`workloom-growthtest` / `workloom-growthmatrix` 是 2026-09-21 从 `WorkLoom-growth@a6dc89a` 完整复制的**激进改造实验副本**，产品所有者（2026-09-22）明确：**内容暂时与基座拆分——基座内容不直接同步这两仓，这两仓也不直接同步回基座**。与 §14.4 实验车道的区别是：实验车道仍在同步队列内（收基座资产、实验路径受保护），隔离副本**完全不在同步队列内**。

- **登记**：`sync/child-repos.json#isolatedRepos`（`lane: isolated`、`syncPolicy: none-in-none-out`、`copiedFrom`、`isolatedSince`、`declaredBy/At`、`note`）；
- **扫描**：`fleet-scan` 把隔离仓计入"已知"、单列为隔离副本，不开扫描任务卡、不建纳管 PR；
- **纳管**：`provision-protocol` 默认拒绝隔离仓；恢复必须由产品所有者明确指令 + 另开任务卡 + `--allow-isolated`；
- **分发**：`fanout-cnb` 读取 `isolatedRepos` 在入口过滤（即使误写进 `children` 也拦下）；
- **护栏**：`experiment-guard --check` 校验登记完整性（`note` / `isolatedSince` / `syncPolicy`）并拦截 `ISOLATED_IN_CHILDREN`；违规在基座门禁判红；
- **回流**：隔离副本的改动不进基座、不下发其他仓；通用能力要公共化须另开提案任务卡按 L2→L1→L0 重做。

## 附录 A · 核验方法与覆盖率（2026-09-17 深读 + 2026-09-22 增补）

| 项 | 内容 |
|---|---|
| 仓库 | 2026-09-17：九仓全量克隆（`--depth 30`），HEAD 与远端 `ls-remote` 逐仓比对一致 |
| 深度 | 逐模块精读：基座 26 个域 + runtime/shared/db/ui 出口与关键实现；各行业仓独有代码（管线 YAML 步骤、围栏规则、技能定义、连接器层、Python 内核、治理壳、M2/M1 前端层） |
| 跨仓 | bundle 内容指纹、同版本差异、`provides` 与磁盘资产一致性、同步范围与污染守卫、运行时锁与发布资产清单 |
| 未做 | 未安装依赖、未构建、未运行 vitest/suite/Playwright、未连接 PostgreSQL、未执行任何 push 或仓库写入 |
| 体量 | 九仓合计约 8,600 个源码/文档文件、约 167 万行（含 ts/tsx/py/sql/yml/json/md） |
| 2026-09-22 增补（隔离副本） | 对 `workloom-growthtest` / `workloom-growthmatrix` 做 **B/D 级**核验：CNB API 元数据（建仓时间、描述、open PR 数）+ `git ls-remote`（HEAD、分支列表）+ `git show` 关键文件（`product.manifest.json`、`.workloom-base-sync.json`、受控文档摘要、最近提交）；**未逐模块精读、未安装、未构建、未跑测试**。两仓 `git ls-tree -r` 实测各约 2,130 个文件（继承 growth 完整树）。 |

## 附录 B · 快照与统计口径

| 仓库 | HEAD | bundle（preset / skill / 围栏规则） | 备注 |
|---|---|---|---|
| workloom-im | `3c74ee0` | ai-pm 3.0.0（14 / 20 / 14）；hotel 1.0.0（7 / 3 / 6）；platform 1.0.0（17 / 11 / 10） | 26 base 域 ≈ 3.3 万行 TS；suite 21 域 ≈ 371 条 |
| workroom-andromeda | `cc34a1a` | platform 1.0.0（23 / 17 目录、11 入签名 / 10）；ai-pm 3.0.0；hotel 1.0.0 | `platform-ops/src` 9 子域 + `safety/` |
| workloom-hotel | `85887a9` | hotel 3.2.0（11 / 26 / 53）；ai-pm 3.0.0（14 / 20 / 14） | suite 443 / demo 44（README 徽章口径） |
| hyperreality-system | `a2cfc91` | ai-video 1.0.0（33 / 9 / 33）；hotel 1.0.0；ai-pm 1.0.0 | 5 条管线 / 235 素材库 / vendor supermickey |
| workloom | `2a2b390` | geo-growth 1.0.0（16 / 6 / 17）；ai-video 1.0.0（33 / 8 / 21）；hotel 3.4.0（16 / 30 / 74） | 4 条 GEO 管线 / 12 个高保真演示页 |
| panda-cineforge | `0005634` | ecommerce 1.0.0（82 / 161 / 62） | suite 392 / demo 43；`packages/connectors` |
| workroom-tiger | `394cd47` | trading 0.1.0（37 / 10 目录、6 入签名 / 19） | Python 21 环节 STEP_REGISTRY；31 个测试文件 |
| workroom-eagle | `efcae26` | consulting 2.0.0（22 / 199 / 9）；ai-pm 1.0.0；hotel 1.0.0 | suite 445（README 徽章口径）；4 套服务前台知识 |
| workroom-fox | `7dfa488` | hotel 3.2.0（11 / 26 / 53） | M1 视听层（audio/voice/loommate）；9 项 AI 自动化能力 |
| WorkLoom-growth（实验车道） | `6bc16631`（2026-09-22 云端 main） | 与 `workloom` 同源第二实例；本轮未复读 bundle 统计 | `productId=workloom-ai-growth`、`portOffset=420`；游戏化定制 hud / star-ring / pages/p0 |
| workloom-growthtest（隔离副本） | `98d5ecde`（2026-09-22 云端 main） | 继承自 `WorkLoom-growth@a6dc89a`；本轮未复核统计 | **双向不同步**；已做「基座去审批化」改造；2 条 open PR；2,130 个文件 |
| workloom-growthmatrix（隔离副本） | `0d41de9d`（2026-09-22 云端 main） | 继承自 `WorkLoom-growth@a6dc89a`；本轮未复核统计 | **双向不同步**；视频链路 / 后期调色分叉；3 条 open PR；2,129 个文件 |

口径说明：preset/skill 数取自 `bundle.json` 与目录实际内容；围栏规则数按 `fences/**/*.yml` 中 `- id:` / `- rule_id:` 条目计数（含业态补丁）；“入签名”指是否列入 `bundle.json` 的 `provides`；suite 用例数按 `scripts/suite.ts` 域注册统计（约 369–371，README 记 371）；README 徽章中的 suite 数字为各仓自述，未在本次核验中复跑。
