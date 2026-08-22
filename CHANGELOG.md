# Changelog

本文件记录 WorkLoom IM 底座的变更历史。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)。

## [1.9.2] - 2026-08-23 · 数字职场（D25-α）：等距 2.5D 办公区

### 新增

- **数字职场视图（P0 双视图，默认职场）**：等距 2.5D 办公区 Canvas 渲染（零素材程序化绘制）——员工五态实时动画：working=工位打字（屏幕字符滚动）/ blocked=遇阻踱步+「!」气泡 / asking=**走到 CEO 指挥台举手+聚光灯，点开原地三手势（批准/驳回后走回工位）** / celebrating=跳跃+彩带粒子 / idle=休息角待命；disabled 工位清空名牌变灰。顶栏 [职场|舞台] 切换（localStorage 记忆），舞台=保留 D23 全息卫星群（升旗仪式），职场=日常巡逻。
- **`packages/base/captain/floor`**：员工状态派生（全部只读 SQL 实时派生，动作即数据；优先级 asking>blocked>celebrating>working>idle）+ 场景包体系（声明式 JSON：地板/工位锚点/道具/CEO 指挥台/休息角/入口/主题色；`registerFloorSceneProvider()` 行业挂钩 + `bundles/<industry>/floor-scene.json` 磁盘约定 + 通用办公室兜底）。
- **行业场景包**：`bundles/hotel/floor-scene.json`（酒店前厅：前台柜台/房态看板/行李车/大堂吧）；片场包随 hyper 仓推广落地。
- **theater 端点扩展** `floor` 段（场景+员工态一次给齐；独立聚合故障不阻塞剧场主数据；行业值读取并入 RLS 事务，修复无 GUC 直查恒空）。

### 门禁验证

- ✅ suite 436/436（新增 V 域 8 条：场景兜底/注册优先/五态派生逐态/优先级/工位映射不越界，专属探针员工隔离近窗污染）· demo 44/44 · typecheck 全绿 · verify-chain 一致 · 浏览器实拍：职场五态同框 + 请示举手→原地批准→走回工位完整闭环

## [1.9.1] - 2026-08-22 · 落地向导（D24）：模拟运行态 → 真实经营

### 新增

- **模拟数据常显横幅（SimBanner）**：P0 经营剧场与舰桥全页面顶部常显——数据为演示种子或模型为内置 mock 时提示「当前为全模拟运行态」，按钮直达 `/onboarding`；事实源为新端点 `onboarding.status`（dataMode + LLM 装配 + 工作区规模），两者皆真实时自动熄灭。
- **落地向导四步（/onboarding）**：① 环境自检（自动：DB/事件库/团队/模型/数据模式）→ ② 真实大模型（DeepSeek/Kimi/智谱/OpenAI/自定义预设一键填；`onboarding.testLlm` 真实 round-trip 试调，`saveLlmConfig` **试调通过才落盘** .env 四变量 + process.env + 清装配缓存，全链即时真实化免重启）→ ③ 经营主体（写一店一档 `archive.business`）→ ④ 启用真实模式（`activateRealMode` 翻转 `profiles.archive.dataMode`，横幅熄灭）。全程五元事件留痕（`onboarding.llm_configured` / `workspace_profile` / `real_mode_activated`），API Key 只记掩码后 4 位。
- **ask 联网实时检索事实面**：`ASK_WEB_SEARCH=1` 开启，Bing 公开 RSS（keyless 零依赖）取实时网页结果与库内事实合并供模型合成；检索源标注入 `basis`，失败静默降级。
- **种子标记**：种子库写入 `dataMode=simulated`（横幅事实源；历史库缺省按模拟态处理，宁多提示不漏提示）。

### 修复

- `OpenAiCompatibleProvider` 支持免 key 网关/本地代理（apiKey 可空，自动省略 authorization 头）。
- `scripts/reset.sh`：有 docker 守护进程但无 `workloom-im-pg` 容器时误走 `docker exec` 导致重置失败——改为容器真实存在才走 docker 通道，否则回退本机 psql。

### 门禁验证

- ✅ suite 428/428（新增 5 条 D24 E2E：模拟态事实源 / stub 实证 saveLlmConfig→via=llm 真实推理 / mock 还原 / 主体写入+真实模式切换+复位）· demo 44/44 · typecheck 全绿 · verify-chain 全库一致 · 全新克隆首次安装验证（install→migrate→seed→dev 开箱运行态 + 横幅 + 向导浏览器四步点击流全通）

## [1.5.0] - 2026-08-21 · 行业落地向导批次

### 新增

- **`packages/base/wizard`（行业落地向导）**：首次装机的产品化引导状态机（welcome→industry_select→research→design→delivery→activated→handover，paused 断点续跑），编排"技能一（竞品调研）/技能二（一线调研）→技能三（落地方案）→技能四（交付配置）"Quest 序列；行业内容零预置（D18）；激活门禁与装配检查单同口径；能力裁剪激活（community 版向导全程可跑，超版本能力"已配置·待升级解锁"）；反哺上报四红线校验（D19）。17 条纯函数单测全绿。
- **`skills/official/` 官方套件（D19）**：`industry-entry/` 落地四技能（industry-benchmark-research v1.2 / industry-frontline-research v1.2 / workloom-industry-landing-design v1.3 / delivery-config v1.0）+ 快速上线骨架模板；`product-feedback/feedback-insight` 反哺信息每日聚类分析技能。配套磁盘加载器 `packages/base/skills/official.ts`（frontmatter 解析 + 扫描入库，bundle=null）。
- **文档**：`docs/04-行业落地向导-用户版.md`、`docs/methodology/01-行业落地三技能体系.md`（协作关系与调用契约）；`docs/DECISIONS.md` 新增 D17（官方套件顶层目录）/D18（向导行业无关+能力裁剪激活）/D19（反哺隐私红线）。

### 纪律

- 向导只编排任务与依赖，不含任何工期/时间点（排期禁令）；底座代码零行业词汇。

## [1.4.1] - 2026-08-21 · 深度安全修复（审计第 11 轮）

### 安全修复

- **#42 skill_publish_reviews 跨工作区越权（P1）**：0006 新表漏 RLS——任何工作区可读写他区上架审核单（实测篡改成功）。0008 迁移 ENABLE+FORCE RLS 双口径收口。
- **#43 审批同事件跨通道幂等**：inapp/dingtalk 双通道审批行此前可各批一次（一动作双批）。decide 锁同事件全部审批行，他行已终态按重复回调处理。

### 门禁验证

- ✅ base 174/174 · runtime 12/12 · suite 392/392 · typecheck 全绿 · 干净库 8 迁移 + verify-chain 100/100 · E6 dsh-gate 全绿

## [1.4.0] - 2026-08-21 · 双池事务一致性（D16，审计第 10 轮）

### 架构修复

- **#1/A 双池事务一致性（SECURITY DEFINER 方案，D16 ADR）**：业务状态写与事件写从此同一事务同一 COMMIT——`append_event_insert()` 特权函数（gateway 权限执行，app 角色仍无直接 INSERT，铁律 1 不破）；DB 层新增上下文一致性（防伪造）与链式接龙（断链拒写）双校验。30 处「业务+事件」调用点全部事务内化（decide/expireSweep/install/uninstall/publish/ingestInbound/派单/夜班/触发器/Quest 循环/setPlan/dispatch/proposeRule/forge/activateBundle）。
- **原子性回归**：atomicity.test.ts（同事务双生 / 崩溃注入无孤儿 / 断链拒写 / 防伪造 / A3 不变）。

### 门禁验证

- ✅ base 157/157 · runtime 12/12 · suite 390/390 · typecheck 全绿 · 干净库 7 迁移 + verify-chain 100/100 · 安全门禁 7/7

## [1.3.0] - 2026-08-21 · industry 上架门禁五机制（审计第 9 轮）

### 新特性

- **D15 五机制落地**：industry 技能上架门禁——①上架脱敏扫描（PII+敏感词强制检测）②审核流水线（双人复核/禁止自批/全程留痕）③供应链注入评估（四类注入模式拦截）④全局吊销 kill switch（安装与装配双点排除）⑤版本通道（安装版本快照+更新提示）。配套 0006 迁移（skill_publish_reviews / skill_revocations / skill_installs.installed_version）。
- **industry 白名单开口**：desensitized 的 industry 技能可安装（D15 前置机制就位后的既定动作）。

### 测试

- suite 371→390：H 域 D15 回归 16 条 + expire 并发边界 2 条 + 前后端契约对账 1 条（实测零悬空）。

### 门禁验证

- ✅ suite 390/390 ×2 连跑 · base 152/152 · typecheck 全绿 · 干净库 6 迁移 + seed + verify-chain 100/100

## [1.2.1] - 2026-08-21 · 文档同步与 industry 层安全评估（审计第 8 轮）

### 文档

- **README_EN.md 与中文版全量对齐**（60 秒 AI 助手速览英文版 / 快速开始 / badge / 链接 / 路线图）。
- **D15 ADR**：技能市场 industry 层开放前置门禁——结论「暂不开放」，先建五项机制位（上架脱敏扫描 / 审核流水线留痕 / 供应链注入评估 / 全局吊销 kill switch / 版本通道升级提示）。
- apps/site 官网核对：无过时数据，无需修改。

## [1.2.0] - 2026-08-21 · 质量基线版（审计第 7 轮；tag 版本线与项目历史对齐，前序 0.1.x 为审计批次号）

### 文档与开源化

- **README 重写**：新增「给 AI 助手的 60 秒速览」（定位/仓库地图/最小跑通路径/适用与不适用/事实源索引/修改纪律）；开发者快速开始修正（migrate 自动建双角色，从零实测验证）；测试数更正（168 vitest + 371 suite）；dsh 链接修正。
- **docs/SUITE.md**：371 条全场景用例清单入库（运行时导出）。
- **docs/DECISIONS.md**：D1–D14 历史 ADR 回收（有出处者登记，无出处如实标注）。

### 门禁验证

- ✅ suite 371/371 · base 152/152 · runtime 12/12 · shared 4/4 · typecheck 全绿 · verify-chain 100/100 · 干净库全流程

## [0.1.7] - 2026-08-21 · 用例集扩充批次（审计第 6 轮）

### 安全修复

- **#41 审批手势类型白名单（P1）**：非法手势（bogus）此前穿透校验被静默当作「驳回」写库（绕过 L5.2 原因必填）。validateGesture 入口白名单，非法类型抛 INVALID_GESTURE。

### 测试基建

- **suite 326→371 用例**：新增 O 店长日常场景（16）/ P 系统层（14）/ Q 异常压测（15）三域；suite 命令加 TOOL_UNVERIFIED_RATE=0 确定性执行。

### 门禁验证

- ✅ suite 371/371 ×2 连跑 · base 152/152 · runtime 12/12 · typecheck 全绿

## [0.1.6] - 2026-08-21 · CI 门禁 + 决策记录批次（审计第 5 轮）

### 基建

- **CI 质量门禁**（.github/workflows/ci.yml）：push/PR to main 触发——PG17+pgvector service、迁移种子幂等双跑、verify-chain、typecheck、三包测试（DB 集成全开）、suite 326 用例、web build、dsh-gate E6。GitHub 实测 success。
- **docs/DECISIONS.md 补建**：ADR 从此入库；D13 登记事件编号锁与哈希链粒度决策（tenant 锁 + workspace 链为有意设计，附三方案否决论证）。

### 修复

- **#40** uninstallSkill 撤销清单读安装时快照（与 #17 口径对齐，作者改绑定后留痕不再失真）。

### 门禁验证

- ✅ CI ci-gate success ×3（GitHub 实测）· base 152/152 · runtime 12/12 · suite 326/326 · typecheck 全绿

## [0.1.5] - 2026-08-21 · 全场景测试套件批次（审计第 4 轮）

### 测试基建

- **`pnpm suite` 全场景套件**（scripts/suite.ts）：14 域 326 条场景用例逐条执行——三模式意图路由/网关瀑布/围栏判定/事件检索/审批流/IM 通道/夜班/技能/记忆/巡检/模型路由/desktop 高危与多模态/注入边界/并发压测 + HTTP E2E 权限矩阵（spawn 真实 server）。用例前缀隔离、可重跑、失败汇总报告。

### 套件暴露修复

- **#36** 检索时间白名单补 `+`（东八区 ISO 格式此前被误拒）。
- **#37** 意图路由疑问词增强（句中/句尾疑问词 + 动作词优先——「房价是多少」不再误判 quest）。
- **#38** 巡检派单事件挂 sessionId=threadId（P2 线程事件流完整）。
- **#39** recall NL 用例时间窗解耦（跨天运行假红消除）。

### 门禁验证

- ✅ suite 326/326（复跑稳定）· base 152/152 · runtime 12/12 · shared 4/4 · typecheck 全绿 · web build 绿 · verify-chain 100/100

## [0.1.4] - 2026-08-20 · 深度对抗测试批次（审计第 3 轮）

### 安全修复

- **#32 种子哈希链与生产口径不一致（P1）**：seed 用 JSON.stringify 键序算哈希 vs 生产 canonicalJson——种子 100 条用生产口径重算全部不符（同链两种算法混杂）。seed 统一导入 eventHash（zod parse 后对象），新增 `pnpm db:verify-chain` 全库链验证工具。
- **#33 写操作统一角色守卫（P1）**：readonly 实测可派遣 Quest 等 14 个写操作无服务端校验（前端隐藏未配服务端强制）。新增 writeProcedure / capabilityWriteProcedure 统一接入。
- **#35 网关 actor/who 身份一致性**：分叉伪造归因留痕无机制兜底，段①新增一致性校验。

### 功能正确性修复

- **#34 Quest 挂起审批通过后可恢复执行（P1）**：此前审批通过线程永卡 pending_review（replay 死循环）。runQuest 加载已批准挂起步骤映射，批准即带 approvalRef 执行（basis 留痕「经审批 \<id\> 批准执行」），Quest 生命周期闭环。

### 门禁验证

- ✅ base 152/152 · runtime 12/12 · shared 4/4 · typecheck 全绿 · web build 绿 · E6 dsh-gate 全绿
- ✅ verify-chain 100/100 一致 · 权限实测 readonly 全 403 / manager 正常 · PII/DSL 对抗 20 项全过

## [0.1.3] - 2026-08-20 · dsh rc.8 升级 + 安全加固批次（审计第 2 轮）

### 变更

- **dsh 升级 0.1.0-rc.6 → 0.1.0-rc.8**：vendor/dsh 全量替换（integrity 与 registry 逐字符一致）；dsh-gate pin rc.8 + node-pty rebuild。rc.8 新能力：Codex / Claude Code 作为按需安装的 subagent Profile Bundle（web profile 已装 `@deepseek-ai/dsh-subagent-claude-code` / `@deepseek-ai/dsh-subagent-codex`）；SQLite 新存储格式不向下兼容（升级前备份 DSH_HOME 数据目录）。**升级策略变更（项目所有者 2026-08-20 决策）：官方任何新版本（含 rc/beta/alpha）即升，不再等稳定版。**

### 安全加固

- **#30 biz_events TRUNCATE 触发器**（0004 迁移）：行级触发器不拦 TRUNCATE，表 owner 此前可清空事件库；语句级触发器对全角色生效，清库只能 DROP+重迁移。
- **#31 fence_rules 全局基线写入收口**（0005 迁移）：app/gateway 角色禁写 `workspace_id='*'` 行（原 RLS WITH CHECK 放行，任何工作区上下文可污染全租户基线），仅 owner 可写。

### 门禁验证

- ✅ base 150/150 · runtime 11/11 · shared 4/4 · typecheck 全绿 · web build 绿 · E6 dsh-gate 全绿（rc.8）
- ✅ 安全门禁 7/7（新增 TRUNCATE 拒 / fence `*` 写拒）· 迁移 0001–0005 + seed 幂等复跑

## [0.1.2] - 2026-08-20 · 审计修复批次（首轮独立审计，详见 docs/AUDIT.md）

### 安全修复

- **#22 RLS 事务级上下文失效（P0）**：#2/#20 把 `set_config(...,false)` 改事务级 `true`，但 15 个文件 40+ 封装无显式事务，autocommit 下设置语句结束即失效 → RLS 恒 NULL → 登录/审批/夜班/巡检/技能/召回 fail-closed 全不可用（此前 DB 集成测试全部 skip 未暴露，实测 37/144 红）。统一改为 BEGIN→set_config→fn→COMMIT/ROLLBACK；decide() 重构消除事务嵌套；测试断言池直查统一事务封装（原断言恒 0 行假绿/假红）。
- **#23 team 技能跨工作区互覆盖（P1）**：skills 全局表无 RLS，teamSkillId 仅名称派生，同名技能 ON CONFLICT 互覆盖。ID 内嵌 workspaceId（`skill-t-<ws>-<slug>`）；listSkills 按 scope 隔离；installSkill 追加本工作区归属校验（他区按 NOT_SIGNED 拦截留痕）。

### 功能正确性修复

- **#24 技能围栏绑定运行时不生效（P1）**：resolveAgentFenceBindings 无消费点，装配只读 preset 声明。assemblePreset 同事务并入 skill_installs 安装时快照（安装即生效、卸载即收缩）。
- **#26 appendEvent 幂等丢弃返回错误 hash/seq**：#4 只修了 appendEventIdempotent，主路径同根残留；去重时同事务回读 DB 真实值。
- **#27 routeIntent 超时未取消 LLM 调用**：classify 签名无 signal，AbortController 只赢 race；signal 接线到分类器（#7 名不副实补正）。
- **#28 冲突审批 approval_id 同毫秒碰撞**：makeReadableId("AP", Date.now()%100000) 熵不足，改事件派生 apr-e-\<eventId\>（同 loop.ts 口径）。
- **#29 IM 入站并发重推双写（TOCTOU）**：查重与写事件非原子；新增 im_inbound_dedupe 幂等键表（0003 迁移）原子占位，事件写失败补偿删占位。
- **顺带**：withObjectLock 的 SET LOCAL statement_timeout 挪到 BEGIN 后（事务外无效果，锁等待无超时兜底）；dispatch 并发上限检查移入事务（原池直查 fail-open 恒 0 行）。

### 测试健壮性

- **#25 runtime 全流程测试 flaky（~27% 失败率）**：静态 import 使 TOOL_UNVERIFIED_RATE=0 设置被击穿（模块级常量提前定型）；loop.js 改动态 import。H-15 测试 hotel 资产路径改 import.meta.url 定位（原 cwd 敏感）+ finally 还原 industry（防污染残留）。
- security-audit 增 #22 回归用例（autocommit 反例 fail-closed + 池连接卫生）。

### 数据库迁移

- 新增 `packages/db/migrations/0003_im_inbound_dedupe.sql`：`im_inbound_dedupe` 幂等键表（PK(workspace_id,channel,channel_msg_id)，RLS 同口径）。

### 门禁验证

- ✅ typecheck 全绿（6 个项目）
- ✅ shared 4/4 · **base 148/148（含 54 个原 skip 的 DB 集成测试，×3 连跑）** · runtime 11/11（×5 连跑）
- ✅ 安全门禁 6/6（append-only 双保险 / 旁路直写防控 / RLS 隔离）· seed 幂等复跑
- ✅ server `/health` + `/trpc/system.health` 200（db:up）· web build 绿 · 端到端 loginAs→members/threads/approvals 实测通过

## [0.1.1] - 2026-08-20 · Bug 修复批次

### 安全修复

- **#9 提示词注入防护**：`routeIntent` 的 LLM 分类器 prompt 用 `<user_input>` 结构化分隔符隔离用户输入，声明分隔符内为数据非指令，防止用户输入劫持分类结果绕过审批路由（F3.2）。
- **#2/#20/N RLS 配置统一**：全部非测试代码的 `set_config('app.workspace_id', ..., false)` 改为 `true`（事务级），消除会话级 RLS 变量泄漏到连接池的跨租户数据泄漏风险（F7.1/L7.1）。
- **#17 技能 fence_bindings 安装时快照**：`skill_installs` 表新增 `fence_bindings_snapshot` 列，安装时快照绑定；运行时 `resolveAgentFenceBindings` 读快照而非 `skills.fence_bindings` 实时值，防止技能作者更新绑定绕过 E8.1 冲突检测。
- **#16 isSignedSource DB 约束**：`skills` 表新增 CHECK 约束 `skills_team_id_format`，强制 `level='team'` 的技能 ID 必须以 `skill-t-` 开头，与 `isSignedSource` 逻辑一致，DB 层防伪造签名。

### 数据一致性修复

- **#10 expireSweep 写事件**：过期审批状态变更现在经网关写 `approval.expired` 事件，不再只改表不写事件，符合铁律 1（一切写入必经网关，F5.7/E5.3）。
- **#11 runQuest 重放跳过被阻塞步骤**：`existingStepIds` 只收录真正执行完成（auto）的步骤，排除 block/review 事件（按 `basis` 前缀「熔断：」「越围栏挂起：」识别），避免重放时跳过从未执行的步骤（E3.3/H-5）。
- **#4 appendEventIdempotent 去重返回正确 hash**：去重时从 DB 取回已存在事件的真实 `hash`/`seq` 返回，避免调用方拿到错误 hash 断链（L1.4）。

### 功能正确性修复

- **#12 模型路由熔断不丢弃回答**：熔断时 `RouteResult` 新增 `budgetExceeded` 标志并仍返回 `text`，避免白烧 token（F6.5/L6.4）。
- **#13 resumeNight 区分夜班暂停与手动暂停**：`threads` 表新增 `paused_by` 列；`pauseAll` 标记 `paused_by='night-shift'`；`resumeNight` 只恢复该标记的线程，不覆盖用户手动暂停（F4.3/E4.2）。
- **#5 isWriteAction 与围栏规则同步**：网关新增 `registerWriteActions` 运行时注册接口，行业 Bundle 新增写类动作后可注册到网关，避免硬编码前缀未覆盖而放行未声明 fence_bindings 的 Agent 写动作（F2.10）。
- **#6 confirmNight 围栏快照严谨化**：围栏版本快照查询限定 `is_baseline=true` + `ORDER BY version DESC` 确定性排序，避免取到非基线规则或随机版本（F2.6）。
- **#19 currentWindow 支持非跨午夜窗口**：峰谷窗口判定支持跨午夜（`start > end`，如 22:00-08:00）和非跨午夜（`start < end`，如 09:00-17:00）两种配置（F6.3）。
- **#21 回执失败不传播**：`handleGestureCallback` 的 `driver.sendText` 失败时只记录日志，不让成功的审批操作「看起来失败」（F5.5）。
- **#18 P1 dispatchState 卡 typing**：`dispatch` 的 `finally` 块用 `text.trim()` 判断而非闭包旧值 `draft`，避免成功派遣后 DispatchBar 卡在 typing 态。

### 设计改进

- **#8 PII 银行卡加 Luhn 校验**：`BANKCARD` 规则新增 `verify` 二次校验，用 Luhn 算法过滤订单号/时间戳等非卡数字，避免误脱敏破坏业务语义（F1.10）。
- **#7 routeIntent 超时取消 LLM 调用**：超时后调用 `AbortController.abort()` 真正取消底层 LLM 请求，避免 token 浪费（F3.2）。
- **#14/#15 withObjectLock 改用阻塞锁 + 64位 key**：改用 `pg_advisory_xact_lock`（阻塞版，内核管理等待队列）+ md5 前 16 位转 bigint 的 64 位 hash key，避免轮询占用 gateway 连接 5 秒和 `hashtext` 32 位碰撞（E2.5）。

### 架构优化

- **K mock 工具随机返回 synced:false**：demo 工具通过 `TOOL_UNVERIFIED_RATE` 环境变量控制（默认 10%）随机返回 `synced:false`，让 E3.7 回执校验路径在开发阶段就被走到。
- **L 连接池扩容**：`app` 池 10→30，`gateway` 池 4→20，`owner` 池 2→5，避免并发请求耗尽连接。

### 数据库迁移

- 新增 `packages/db/migrations/0002_bugfix.sql`：
  - `threads` 表新增 `paused_by` 列 + 索引（#13）
  - `skill_installs` 表新增 `fence_bindings_snapshot` 列（#17）
  - `skills` 表新增 CHECK 约束 `skills_team_id_format`（#16）

### 门禁验证

- ✅ typecheck 全绿（13 个项目）
- ✅ shared 包测试 4/4 绿
- ✅ base 包测试 90 passed（54 skipped 为 DB 集成测试）
- ✅ runtime 包测试 5 passed（4 skipped 为 DB 集成测试）

### 未纳入本批次

- **#1/A 双池事务一致性（Outbox 方案）**：架构性大改造，影响面贯穿全栈，需单独评估，留待下个版本。
