# DECISIONS.md · WorkLoom IM 底座架构决策记录（ADR）

> 追加不改旧。本文件于审计第 5 轮补建（第 1 轮登记的事实源偏差：远程 main 此前无治理文档）。
> D1–D12 已于第 7 轮回收（见下方「历史决策回收」节，仅登记代码/文档中有明确出处者）；自 D13 起在此追加。

---

## 历史决策回收（D1–D14，2026-08-21 第 7 轮整理）

> 出处为代码注释/VENDOR 文档中的 `(D<n>)` 引用。无出处者不臆造，如实标注「待考」。

| 编号 | 决策 | 出处 |
|---|---|---|
| D1 | 待考（仓库内无引用） | — |
| D2 | 首版唯一行业 Bundle = `bundles/hotel`（workloom-hotel） | `apps/server/src/trpc/router.ts` |
| D3 | 待考（仓库内无引用） | — |
| D4 | LLM 默认 mock provider 全流程可跑（OpenAI 兼容网关 + 内置确定性 Mock；无真实凭据可开发可测试） | `packages/base/model-router/providers.ts`、`im-channels/cards.ts` |
| D5 | DDL 事实源 = migrations 手写 SQL；`schema.ts` 仅类型镜像，不生 DDL | `packages/db/src/schema.ts` |
| D6 | 待考（仓库内无引用） | — |
| D7 | 首版审批/通道仅 inapp 本地回环；外部 IM 连接器进停车场；手势回调后由回调侧回发结果卡（原地更新简化语义） | `review-console/index.ts`、`im-channels/registry.ts`、`cards.ts` |
| D8 | 待考（仓库内无引用） | — |
| D9 | 待考（仓库内无引用） | — |
| D10 | 待考（引用点已不可考） | — |
| D11 | 待考（仓库内无引用） | — |
| D12 | dsh（DeepSeek Harness）作 L1 运行时地基：vendor 锁定 + integrity 核验 + seam 精确对接（plugins 薄壳适配），九域护城河自研 | `vendor/dsh/VENDOR.md`、`packages/runtime/plugins/README.md` |
| D14 | 审批卡片从 inapp 升级为多通道（dingtalk/wecom/feishu 经 dsh-im；未启用通道拒绝并留痕） | `im-channels/callback.ts`、`cards.ts` |

> D13 起为审计期新决策，见下。D 编号有缺（D13 前无 D13 前史可考者）不影响使用——新决策顺延编号即可。

---

## D13 · 事件编号锁粒度与哈希链粒度（2026-08-21，审计 #32 后续评估）

**背景**：`appendEvent` 的 advisory 锁是 tenant 级（`event-chain:<tenantId>`），但链尾读取在 RLS 下按 workspace 过滤——同 tenant 多 workspace 时，锁粒度（tenant）与链粒度（workspace）不一致。

**选项评估**：

| 方案 | 分析 | 结论 |
|---|---|---|
| A. 锁降 workspace 级 | 编号分配 `MAX(seq)+1` 在 RLS 下按 workspace 过滤；两区并发会分配相同 E-N → `UNIQUE(tenant_id,event_id)` 冲突 → ON CONFLICT DO NOTHING → **第二方事件被静默幂等丢弃（数据丢失）** | ❌ 否决 |
| B. 维持 tenant 锁 + workspace 链 | 编号 tenant 内全局单调唯一；每 workspace 一条独立审计链（prev_hash 自本区 GENESIS 起）；verify-chain 按 workspace 分段验证，口径自洽 | ✅ 采纳 |
| C. tenant 单链（链尾读取绕过 RLS） | 需 owner 通道或 SECURITY DEFINER 函数读他区链尾——RLS 防线开口，安全降级 | ❌ 否决 |
| D. event_id 加 workspace 前缀 | 破坏 PRD 展示口径（E-N），且 UNIQUE 约束需重建 | ❌ 否决 |

**决策（B）**：语义定型为「event_id = tenant 级唯一编号（锁保证）；哈希链 = workspace 级审计链（RLS 保证）」。两者粒度不同是**有意设计**而非缺陷：编号唯一性服务于幂等键，链完整性服务于单工作区审计验证。

**验证**：`pnpm db:verify-chain` 按 workspace 分段逐条重算（干净库 100/100 一致，CI 门禁项）。

---

## D15 · 技能市场 industry 层开放的前置门禁（2026-08-21，第 8 轮安全评估）

**背景**：skills 三级（official / team / industry）中 industry「脱敏后跨组织共享」在 `isSignedSource` 首版不放行（return false），`installSkill` 对 `desensitized=false` 拦截。路线图拟开放 industry 层，本轮做前置安全评估。

**现状防线**：desensitized 标志拦截（L8.1）、team 级 workspace 前缀隔离（#23）、安装冲突审批（detectFenceConflicts）、运行时按安装快照算围栏并集（#24）、卸载读快照撤销（#40）。

**结论：暂不开放，先建五项机制位**（全部就位前维持 industry 白名单外）：

| # | 机制位 | 风险（不建的后果） |
|---|---|---|
| 1 | **上架脱敏扫描**（非人工标志）：forge/上架流水线强制跑 PII 检测（复用 maskText）+ 敏感词清单，正文命中即拒 | desensitized 是人工勾选，无机制验证——含客人 PII 的技能正文可跨组织泄露 |
| 2 | **审核流水线留痕**：上架 = 提案事件 + 异工作区双人复核手势（复用 approvals 域），全程进事件库 | 无审核留痕则「谁批的上架」不可问责，违背黑匣子原则 |
| 3 | **供应链注入评估**：industry 技能正文进入 Agent 上下文（prompt 面），上架前需经注入对抗用例集（复用套件 M 域模式） | 恶意技能可诱导 Agent 越权写动作（围栏按声明绑定判定，声明之外的行为约束依赖正文可信） |
| 4 | **全局吊销列表（kill switch）**：发现恶意/缺陷技能时运营方可全局吊销，运行时装配（resolveAgentFenceBindings）与 install 双点排除 | 当前无撤销通道——已安装的恶意技能只能逐工作区手动卸载 |
| 5 | **版本通道与升级提示**：industry 技能版本变更对已安装工作区可见（不自动升级），变更 diff 进审批 | 作者发新版后已装工作区无感知，静默滞留旧版（含已知缺陷版本） |

**验证口径**：五项机制各自带回归测试进 `scripts/suite.ts`（H 域扩充）；全部落地后再评 industry 白名单开口（届时本 ADR 追加修订记录，不改旧文）。

---

## D16 · 双池事务一致性：SECURITY DEFINER 特权函数方案（2026-08-21，#1/A 立项）

**背景（#1/A，三轮登记后立项）**：业务状态写（app 池）与事件写（gateway 池）是两个连接两个事务——前者 COMMIT 后、后者写入前崩溃，即「状态已变、审计无事件」，事件溯源断页。演示期可接受，生产合规不可接受。

**方案评估**：

| 方案 | 分析 | 结论 |
|---|---|---|
| A. 合并双角色单事务 | 真原子；但 app 角色获得 biz_events 直接 INSERT 能力——**铁律 1 写入收口作废**，任何 app 代码路径可绕过三段瀑布直写事件（触发器只防 UPDATE/DELETE/TRUNCATE，防不了直写） | ❌ 否决（安全降级换原子性，本末倒置） |
| B. 经典 Outbox 表 + relay | 保留双角色；但事件变异步——26 处调用点依赖同步 eventId 与即时可见（审批卡 links、replay 步进、IM 事件流），读己之写语义全破 | ❌ 否决（语义代价过大） |
| C. 2PC | pg 两阶段提交运维坑多（prepared 事务残留卡 VACUUM） | ❌ 否决 |
| **D. SECURITY DEFINER 特权函数** | 单连接单事务内：业务写 + `SELECT append_event_insert(...)`（函数以 gateway 权限执行插入）→ 同 COMMIT。原子性 ✅；app 角色仍无法直接 INSERT（只能调用受控函数）✅；同步 eventId 语义不变 ✅；函数在 DB 层自校验上下文一致性与链式接龙（断链拒写）——防线比现状更强 | ✅ 采纳 |

**实施要点**：
- 0007 迁移：`append_event_insert()`（SECURITY DEFINER，OWNER=workloom_gateway，`SET search_path=pg_catalog, public` 防劫持；REVOKE PUBLIC，仅 GRANT EXECUTE 给 app/gateway）。
- events.ts 抽 `appendEventInTx(client)`（不含 BEGIN/COMMIT，调用方持有事务）；gateway.ts 加 `gatewayAppendOnClient`（三段瀑布 + InTx 写入）。
- 全部「业务写 + 事件写」调用点迁移为同一事务（按包分批 commit）；纯事件写路径维持 gateway 池不变。
- 回归：崩溃注入用例（业务写后强制失败 → 事件与状态同滚回，无孤儿）。

**纪律**：SECURITY DEFINER 函数三铁律——①`SET search_path` 锁死；②函数体只做上下文校验 + 链校验 + 插入，不含业务逻辑；③OWNER 权限最小化（gateway 仅 biz_events INSERT）。
## D17：官方套件独立顶层目录 `skills/official/`

**背景**：行业落地方法论技能（竞品调研/一线调研/落地方案设计/交付配置）与反哺分析技能是**随底座分发的官方资产**，不属于任何行业 Bundle。技能注册表中 SkillRow.bundle 可空（level=official），代码已支持非 Bundle 来源的官方技能。

**选项评估**：

| 方案 | 分析 | 结论 |
|---|---|---|
| A. `skills/official/` 顶层目录 | 技能是内容资产而非代码包；与 bundles/ 平级符合仓库直觉；loader 扫描挂载，底座代码零行业词汇 | ✅ 采纳 |
| B. `packages/base/skills/` 内 | 该包是技能注册机制代码，混入内容资产职责不清 | ❌ 否决 |
| C. 塞进 bundles/hotel | 方法论技能行业无关，放酒店 Bundle 违反"底座不预置行业"红线 | ❌ 否决 |

**决策（A）**：`skills/official/industry-entry/`（落地四技能+模板）与 `skills/official/product-feedback/`（反哺分析技能）为官方套件家；`packages/base/skills/official.ts` 提供磁盘扫描加载器，seed 时入库。

## D18：落地向导是行业无关的产品能力

**背景**：向导编排"技能一/二/三→交付配置"的 Quest 序列，是客户首次装机的主路径。

**决策**：向导状态机与编排逻辑进底座（`packages/base/wizard`），但**行业内容零预置**——行业差异全部在运行期由技能产出与六槽装配生成。向导全流程不因版本中断：community 版采用**能力裁剪激活**（调研与配置全程可跑，激活时夜班/巡检等超版本能力显示"已配置·待升级解锁"），把向导转化为版本升级的自然漏斗，而非硬中断。

## D19：反哺上报的隐私红线

**背景**：落地中"WorkLoom 当前无法消化"的内容可经客户上报给团队，驱动产品自我迭代。

**决策**：四条红线缺一禁止发送——①opt-in（默认不发送，可随时关闭）②发送前完整预览可编辑 ③过 PII 脱敏管道且仅含能力缺口描述、不含客户经营数据 ④发送行为写入事件库留痕。传输：HTTPS 端点为主、邮件降级；GitHub Issues 会暴露客户信息，明确否决。团队侧 feedback-insight 技能**每日**定时聚类分析产出《产品迭代建议日报》，进审批队列，人审后才转 backlog。

## D20：三模式真实运行态与模型可插拔契约（能力回流自酒店行业版）

**背景**：酒店行业版（workloom 仓库）样板间工程中，三模式（ask 问询 / agent 逐步商量 / quest 自主执行）完成真实化并经受真机演示检验。该能力属行业无关的底座能力，回流主仓。

**决策**：
1. **统一 LLM 调用面**：server 内 `llmCall()` 单点装配——`LLM_PROVIDER≠mock` 且凭据齐备即全链真实（意图分类 B8 / 任务规划 B9 / ask 应答合成）；默认 mock 全链确定性兜底（via=rule 留痕，D4 全流程可跑）。模型出站强制脱敏（L6.2）不可绕过。
2. **ask 问询执行器**（`packages/runtime/src/ask.ts`）：事实块实时取数 + 模型/模板双轨合成；**行业事实面经 `registerAskFactProvider()` 注册**（落地向导装载行业包时调用），未注册用底座通用事实面（事件库规模/动作分布/待审批/线程/围栏/记忆）。
3. **agent 模式**：runQuest 非 block 步骤一律强制人工确认（复用 #34 批准恢复闭环），逐步商量直至 completed。
4. **B9 真模型规划**（planQuestSmart）：工具白名单逐条校验 + 步数上限 + **数据水合**（价格类步骤补 before/after/context，防 E2.1 缺路径误熔断；越线不兜底，留给围栏熔断）；解析/校验失败 → 确定性模板兜底。
5. **确定性默认值**：`TOOL_UNVERIFIED_RATE` 默认 0（混沌旋钮改工程显式开启），消除「3/3 完成仍 failed」偶发。

**落地向导自动化契约**：接行业配置即真实运行 = ①写 LLM_* 四 env ②`registerAskFactProvider` 注册行业事实面 ③装载行业 bundle（六槽）。三步完成，代码零改动。

## D21：数字CEO（公司CEO/集团CEO）三层指挥链底座内核

**背景**：董事长只要「听汇报、批少数决策」的经营模式（产品方案 v1.3）。行业无关内核落底座，行业版提供宪章内容与 KPI 定义。

**决策**：
1. **治理状态机**（§12 责任真空解法）：`disabled → shadow → trial → suspended → active`，存于一店一档 `archive.charter`；**默认关闭（opt-in）**，深度授权（风险揭示 risk-v1 + 五项条款逐条确认 + 边界三滑杆 + 试用计划 + 身份核验 + 签署留痕）方可启用；到期**自动降级仅汇报，绝不自动续期**；一键撤回即时生效。全部迁移五元留痕（不可篡改）。
2. **五级审批路由**：approvals +tier（0009 迁移）；L2 公司CEO 裁决（现 review 级 ~90%）/ L3 集团CEO（跨区）/ L4 董事长（越自治带/超上限/围栏放宽/宪章变更）；裁决策略「带内放行、贴边上浮、无判据保守上浮」（拒绝默认镜像）。
3. **CEO Loop 节拍引擎**：简报（日/周/月/集团）+ L2 队列裁决 + 目标偏差立项 + 自治熔断（KPI 破下限自动收紧一档）；简报/裁决双轨合成（via=llm/rule，数字全真）；行业事实面经 `registerBriefingFactProvider` 注册（落地向导契约延展）。
4. **依据链强制**：Decision Memo 空 basis 拒生成；影子模式 dry_run 全留痕。
5. 与 D20 同一 LLM 调用面；集团CEO在单店模型退化为汇报出口（编制不空转），多店聚合在视图层逐工作区 RLS 轮询（不开跨区后门）。

## D22：数字CEO v2.0——决策中枢/员工管理/董事会沟通（三大职责机器映射）

**背景**：董事长拍板的 v2.0 升级方案（人类 CEO 三职责映射：做决策/培养团队/向董事会汇报）。

**决策**：
1. **决策三级分流**（decision.ts）：微决策（小额可逆）规则直通 <1s；常规单模型推理 <10s；重大（已拍板三条件：>2×上限/不可逆/多对象域）走**六步深度管线**——情报采集/案例回忆（org_memory）/多方案生成/红队对抗（critic+围栏语义校验）/影响预估/Memo Pro；试用态重大一律上浮。
2. **决策日记与命中率**：ceo.decision 携带 expected（目标+回测时点）；runOutcomeReviewBeat 到期对账（命中≥95%/偏离≥80%/打脸）；命中率数据驱动授权扩缩建议（>85% 扩 / <60% 收），进月度董事会包。
3. **员工管理**（hr.ts）：绩效档案六指标（产出/通过率/返工/越线/归因/断点）→ 周度评议（表扬/关注/辅导）→ **辅导改善→汰换重生**两级（已拍板：不修破车直接换新车）——《汰换诊断书》+ 新员工设计方案 → L4 批 → 旧停用新上岗（approvals.decide 钩子自动执行），旧员工留痕转训练案例库（基因重组）。
4. **汇报 2.0**：月度董事会包五段式（概览/决策质量/团队/宪章提案/下月重点）；赞/踩反馈入组织记忆（奖励信号）。
5. **扩编不设上限**（已拍板）：编制健康度扫描（覆盖缺口>积压>过载优先级）→ 招聘提案 → L4 逐单批。

## D23：经营剧场是系统的默认投影（不是第 N 个页面）

**决策**：首页（/）= 经营剧场 P0——界面三要素（形象/实况/聊天框）；P1–P21 全部能力成为剧场的「镜头」（可下钻，剧场管感觉、工作台管操作）。形象为「织元体」全息数字CEO（纯 SVG+CSS+Canvas 零素材，光核/三层光环/粒子；颜色=治理态）；员工=卫星群（呼吸灯随真实动作、颜色=绩效、点击看绩效卡）；仪式感工程（开门礼/请示聚光灯/里程碑/夜间模式）为产品一等公民。全部状态来自真实事件（captain.theater 5s 心跳），董事长不说话剧场照常运转。
