# AUDIT.md · WorkLoom IM 底座审计与优化记录

> 本文件为审计历史事实源（追加不改旧）。每轮记录：范围 / 方法 / 问题分级 / 根因 / 方案 / commit / 回归证据。
> 分级口径：P0 阻断/安全漏洞 · P1 严重 bug/设计缺陷 · P2 一般缺陷/可维护性 · P3 优化建议。

---

## 第 11 轮 · 2026-08-21（基线 v1.4.0 → a5769a4）· D16 后新攻击面 + 未深读模块

### 范围与方法
D16 改造新攻击面（新表 RLS/函数边界/调用点遗漏）+ 未深读模块（model-router/
awareness/auth）+ 既有设计疑点（跨通道审批）+ E2E 输入边界对抗 + E6 dsh-gate 复验。

### 已修复（逐点增量提交）

| 编号 | 级别 | 问题 | 根因 | commit |
|---|---|---|---|---|
| #42 | **P1** | skill_publish_reviews 跨工作区越权（实测跨区篡改他区审核单成功） | 第 9 轮 0006 建表漏 RLS 且 reviewPublish 查询不带 workspace 过滤；0008 迁移 ENABLE+FORCE RLS 双口径收口 | `f6b79c7` |
| #43 | P2 | 同一事件 inapp/dingtalk 双通道审批行可各批一次（一动作双批双留痕） | L5.3 幂等仅在单审批行内成立；decide 锁同事件全部审批行，他行已终态按重复回调 | `a5769a4` |

### 验证无问题（无需修复）
- **model-router**：熔断/降级/峰谷（#12/#19 修复到位，0 点边界两制式均正确）。
- **auth loginAs**：工作区/成员双重 404 校验，演示口径自洽。
- **E2E 输入边界**：非法 JSON 400 / 类型错误 400 / zod 限长齐备（1MB title 有 max(500) 拦截）。
- **E6 dsh-gate**：D16 后事件桥兼容（jsonl 验链 + kill -9 重放零重复全绿）。
- **D16 函数边界**：GUC 伪造不改变 RLS 模型既有边界（WITH CHECK 与函数校验同口径，无新增开口）。

### P3 登记（不修）
- confirmSuggestion 跨阶段次级原子（产物已生成、确认事件独立留痕——丢失仅致重复建议，无数据损坏）。
- awareness.loadRecentEvents 无 LIMIT（演示期事件量小，生产需分页/物化投影）。
- skill_revocations 全局表无 RLS（kill switch 按设计全租户可见可读）。

### 门禁结果（干净库从零实测）
- 迁移 0001–0008 + seed 100% + verify-chain 100/100；typecheck 绿；
  base **174/174** · runtime 12/12 · suite **392/392**（+2 回归）· E6 dsh-gate 全绿。

### 当前游标 → 下一轮
- 剩余仅 P3 登记项与持续运营（dsh 跟进/suite 扩充）；建议进入新功能开发或真实部署准备。

---

## 第 10 轮 · 2026-08-21（基线 61dc6de → a8570e8）· D16 双池事务一致性落地（#1/A 清零）

### 背景与方案
#1/A（三轮登记的最后一个架构级问题）：业务状态写（app 池）与事件写（gateway 池）
两个连接两个事务——前者 COMMIT 后、后者写入前崩溃即「状态已变、审计无事件」。
**D16 ADR 采纳 SECURITY DEFINER 特权函数方案**（否决：合并角色=铁律 1 写入收口作废；
Outbox 表=26 处同步 eventId 语义全破；2PC=运维坑多）：单连接单事务内业务写 +
`append_event_insert()`（以 gateway 权限执行）同一 COMMIT。原子性 ✅、写入治理不破 ✅、
同步语义不变 ✅、DB 层新增上下文一致性 + 链式接龙双校验（防线更强）✅。

### 交付（6 个 commit 逐批推送）
| commit | 内容 |
|---|---|
| `0e9e249` | D16 ADR + 0007 迁移（函数 OWNER=gateway/search_path 锁死/REVOKE PUBLIC/双校验）+ appendEventInTx/gatewayAppendOnClient 核心原语 + atomicity.test.ts 5 例（崩溃注入无孤儿/断链拒写/防伪造/A3 不变） |
| `8c9153d` | review-console：decide（状态+手势事件+校准记忆同事务）/expireSweep；upsertMemoryInTx |
| `3dde4e2` | skills：install/uninstall/publish 四处（emit 加 InTx 变体） |
| `f9cc2b3` | im-channels（#29 三段式并单事务，补偿逻辑由原子性取代）/inspection 派单/night-shift 六处 |
| `a8570e8` | loop.ts 三分支步骤级原子 + router setPlan/dispatch/proposeRule + forge/activateBundle |

B 级纯事件路径（cards/scan/sink/note 等）维持 gateway 池不变。

### 踩坑与回填
- **双 GUC 纪律**：append_event_insert 校验 tenant+workspace 双 GUC——registry/resumeNight/
  pauseAll/setTriggerEnabled 等手写事务单设 workspace 被函数拒写暴露（兜底生效符合设计），
  全部补齐；scoped() 封装天然双 GUC 无坑。
- dispatch 旧独立事件块删除防双写；proposeRule 三段（草稿+事件+审批行）重写为单事务。

### 门禁结果（干净库从零实测）
- 迁移 0001–0007 + seed H-1 100% + verify-chain 100/100；typecheck 6 项目绿；
  base **157/157**（+5 原子性用例）· runtime 12/12 · suite **390/390**；
- 安全门禁 7/7：append-only 双拒 / A3 旁路拒 / RLS 0 行 / TRUNCATE 拒 / fence 基线拒 / **D16 函数断链拒写（新）**。

### 当前游标 → 下一轮
- **全部待修复项清零**（#1/A 已闭合；A 类 3 项「确认不修」维持登记）。
- 建议：v1.4.0 打版（D15 五机制 + D16 原子性双里程碑）；industry 层真实技能上架流水线端到端演练。

---

## 第 9 轮 · 2026-08-21（基线 01f720d → 399c25d）· D15 五机制落地 + B-5 走查清零

### dsh 版本检查
npm latest=rc.7 / next=rc.8，与锁定 rc.8 一致——无新版本，无需升级。

### 交付
- **D15 五机制全部落地**（commit `e26efa3`，0006 迁移 + skills/publish.ts 新域）：
  ① 上架脱敏扫描（maskText PII + 敏感凭据词，命中即拒——提案门禁前置，扫描不过连提案都进不了）；
  ② 审核流水线（提案 → 两名不同成员复核[禁止自批/重复复核拒/驳回必填原因/终态幂等] → 完成置 industry+desensitized，全程事件留痕）；
  ③ 供应链注入评估（覆盖指令/窃取泄露/数据外发/越权诱导四类模式）；
  ④ 全局吊销 kill switch（installSkill 拒装留痕 + resolveAgentFenceBindings 装配排除，幂等）；
  ⑤ 版本通道（installed_version 快照 vs 当前版本，listSkillUpdates 列示不自动升级）。
- **industry 白名单开口**（isSignedSource：industry=desensitized 放行）——D15 前置机制全部就位后的既定动作。
- **B-5 走查清零**（commit `399c25d`）：expire 并发边界 2 用例（5 路 sweep 一致 / decide-sweep 竞态终态恰其一）；前后端契约对账入套件（40 调用点 vs 64 挂载点，实测零悬空）；apps/desktop 启动器走查无问题。
- suite 371→**390**（H 域 +16 / E 域 +2 / P 域 +1）。

### 踩坑与回填
- 迁移按文件名幂等：已应用文件追加 GRANT 不会重跑（0006 初版漏授权，手动补 + 文件修正，干净库验证通过）；
- suite H-33 初版用 R2 断言被种子安装行（skill-revenue-manager 快照含 R1/R2）干扰——断言绑定改用 R5；
- PublishError 本地错误类规避 registry↔publish 循环依赖。

### 门禁结果（干净库从零实测）
- 迁移 0001–0006 + seed H-1 100% + verify-chain 100/100；typecheck 6 项目绿；base 152/152 · **suite 390/390 ×2 连跑**。

### 当前游标 → 下一轮
- 剩余待办仅剩：#1/A Outbox（架构性改造，真实部署前立项走 ADR）；A 类 3 项「确认不修」维持登记。
- 建议：industry 层首个真实技能走一遍完整上架流水线做端到端演练（提案→复核→上架→安装→吊销→恢复）。

---

## 第 8 轮 · 2026-08-21（基线 v1.2.0 → 8a5a57b）· 英文 README 同步 + 官网核对 + industry 层安全评估

### dsh 版本检查
npm latest=rc.7 / next=rc.8，与锁定 rc.8 一致——无新版本，无需升级。

### 交付
- **README_EN.md 与中文版全量对齐**：60 秒 AI 助手速览（英文版）、开发者快速开始（migrate 自动建角色口径）、Tests badge 补挂、dsh 链接修正、路线图统一、文档表补 SUITE/DECISIONS/AUDIT。
- **apps/site 官网一致性核对结论**：双页面（中/英）无测试数字、无 dsh 版本声称，外链全部指向本仓库与 Release——**无需修改**。
- **D15 ADR（industry 层开放前置门禁）**：结论「暂不开放」——desensitized 仅为人工标志、无审核留痕、技能正文 prompt 注入面无评估、无全局吊销、无版本通道。五项机制位（上架脱敏扫描/审核流水线/注入评估/kill switch/版本通道）全部落地前维持白名单外；机制落地时回归测试进 suite H 域。

### 当前游标 → 下一轮
- D15 五项机制位逐项实施（每项独立 commit + suite 回归）；suite 用例随新机制扩充（目标 +25）；apps/desktop 桌面包构建链路走查（此前未深读）。

---

## 第 7 轮 · 2026-08-21（基线 6dc4199 → v1.2.0）· ADR 回收 + 用例清单 + README 开源化

### dsh 版本检查
npm latest=rc.7 / next=rc.8，与锁定 rc.8 一致——无新版本，无需升级。

### 交付
- **ADR 回收**：DECISIONS.md 补「历史决策回收」节（D2/D4/D5/D7/D12/D14 有出处者登记，D1/D3/D6/D8–D11 无出处如实标注待考）。
- **docs/SUITE.md**：371 用例清单入库（套件运行时导出，与实际执行逐条对应）。
- **README 开源化**（项目所有者方向：让开发者的 AI 克隆后快速上手）：
  - 新增「⚡ 给 AI 助手的 60 秒速览」：一句话定位 / 仓库地图 / 最小跑通路径 / 适用与不适用 / 事实源索引 / 修改纪律（含 #22 P0 教训指引）；
  - 开发者快速开始修正补全：实测发现 migrate 自动建双角色（原指引手动建角色多余且易错），已按「删库删角色从零」实测验证新指引；
  - 测试数更正（168 vitest + 371 suite）、dsh 失效链接改 npm 官方包页、路线图版本口径统一、文档表补 SUITE/DECISIONS/AUDIT。
- **v1.2.0 tag 打版**：延续项目历史版本线（v1.1.0 开源首发之后），质量基线版。CHANGELOG 的 0.1.x 为审计批次号序列，自本条目起与 tag 版本线对齐。

### 门禁结果（干净库全流程实测）
- 迁移 0001–0005 + seed H-1 100% + verify-chain 100/100；typecheck 6 项目绿；base 152/152 · runtime 12/12 · shared 4/4 · **suite 371/371**。

### 当前游标 → 下一轮
- README_EN.md 与中文版同步；官网（apps/site）内容与新质量数据一致性核对；技能市场 industry 层开放的前置安全评估。

---

## 第 6 轮 · 2026-08-21（基线 db5b46a → 1bebcaa）· 用例集打磨扩充（O/P/Q）

### 方法
按项目所有者方向，先扩充打磨用例集再全量跑：新增三域 45 条（326→371）——
**O 店长日常场景 16 条**（晨间问数/晨会派单/待办巡阅/钉钉卡片审批闭环/高危桌面授权链/
差评 Quest 审批恢复/夜班晨收与熔断/IM 下指令/访客咨询/NL 查账/组织记忆/技能目录/
巡检消解/日终链自检/多成员留痕）、**P 系统层 14 条**（迁移落位/RLS 池卫生/连接复用/
事务回滚/防注入/token 伪造篡改/1MB 大 payload/Unicode 往返/跨 tenant 隔离/PK 兜底/
schema 拒非法/池超载 80/数据自隔离）、**Q 异常压测 15 条**（审批风暴 100/重推风暴 50/
写风暴 200/巨报文 100KB/畸形回调/锁竞争 10 路/夜班并发 20/记忆风暴 50/检索风暴 30/
围栏判定 1000 次<2s/PII 1000 条<2s/批量审批 100/断链注入检测/decide 20 路竞态）。

### 暴露并修复

| 编号 | 级别 | 问题 | 根因 | commit |
|---|---|---|---|---|
| #41 | **P1** | 非法审批手势被静默当作「驳回」写库 | validateGesture 不校验手势类型本身，bogus 穿透到 decide 状态映射落 rejected，且绕过 L5.2 驳回原因必填 | `0c2dba4` |

另修正套件自身 6 处口径（卡片 join payload / pauseAll 前置 confirmNight / parity 异常判定 /
pending 统计范围 / memory kind 白名单与 limit / 同班次巡检幂等去重）；suite 命令加
TOOL_UNVERIFIED_RATE=0 保证确定性（与 runtime.test.ts 同口径）。

### 门禁结果
- **suite 371/371 ×2 连跑稳定**；base 152/152 · runtime 12/12 · typecheck 全绿。

### 当前游标 → 下一轮
- 套件用例清单文档同步刷新（371 条）；v0.2.0 release tag 打版演练；D1–D12 ADR 回收。

---

## 第 5 轮 · 2026-08-21（基线 e7085e4 → cd9ee1d）· CI 门禁接入 + P3 收口

### dsh 版本检查
npm 最新 rc.7（latest）/ rc.8（next），与锁定 rc.8 一致——**无新版本，无需升级**。

### 已交付（逐点增量提交）

| 项 | 内容 | commit |
|---|---|---|
| CI 门禁 | `.github/workflows/ci.yml`：push/PR 触发，PG17+pgvector service → migrate/seed 双跑幂等 → verify-chain → typecheck → 三包测试（RUN_DB_TESTS=1 全开）→ suite 326 用例 → web build → dsh-gate E6。**GitHub 实测三次运行全部 success**（62162a1/4ddd1c7/cd9ee1d） | `62162a1` |
| D13 ADR | 补建 docs/DECISIONS.md；事件编号锁与哈希链粒度论证（tenant 锁+workspace 链为有意设计：锁降级会致跨区编号碰撞→事件静默丢弃；tenant 单链需 RLS 开口） | `4ddd1c7` |
| #40 | uninstallSkill 撤销清单读安装时快照（与 #17 口径对齐） | `cd9ee1d` |

### P3 余量最终评估（登记不修，附理由）
- **JWT 无吊销**：演示口径（登录即选种子成员），生产 IdP 对接（停车场项）时一并解决。
- **PII 占位符无盐 sha256(8)**：低熵可枚举但以 DB 读权限为前提；加盐会破坏「同值同占位可关联」的 F1.4 归因口径，权衡后维持。
- **appendEvent created_at 取声明时间**：种子演示剧本依赖剧本时间渲染曲线；事件时间与接收时间分离属语义增强，收益低于迁移成本，登记待真实部署再议。

### 门禁结果
- base 152/152 · runtime 12/12 · shared 4/4 · suite 326/326 · typecheck 全绿 · **CI（ci-gate）GitHub 实测 success ×3**。

### 当前游标 → 下一轮
- D1–D12 从 README/VENDOR/注释回收进 DECISIONS.md；suite 用例随新功能滚动扩充（每新能力至少 +5 用例）；release tag 打版流程演练（v0.2.0 候选）。

---

## 第 4 轮 · 2026-08-21（基线 e7085e4 → b70ea6e）· 全场景测试套件

### 方法
应项目所有者要求构建全场景测试套件 `pnpm suite`（scripts/suite.ts，npm script 入库）：
**14 域 326 条场景用例逐条执行**——三模式意图路由(34)/网关瀑布(30)/围栏判定(28)/
事件库检索(20)/审批流(34)/IM 通道(32)/夜班(18)/技能(20)/记忆(12)/巡检(10)/
模型路由(10)/desktop 高危与多模态(8)/注入边界(18)/并发压测(12) + HTTP E2E 权限矩阵(27，spawn 真实 server)。
用例数据套件前缀（SFX）隔离、可重跑、失败不中断、末尾汇总报告。

### 套件首跑暴露并修复

| 编号 | 级别 | 问题 | 根因 | commit |
|---|---|---|---|---|
| #36 | P2 | 时间检索东八区格式（+08:00）被误拒 | SAFE_VALUE 白名单缺 `+` | `fa0d484` |
| #37 | P2 | 疑问词在句中/句尾路由漏判（「房价是多少」→ quest 误判） | ask 判定只认开头疑问词/句尾「吗」 | `6c75648` |
| #38 | P2 | 派单事件不进线程事件流（P2 行动消息流缺环） | emit 未挂 sessionId，仅 links 回链 | `5a17ec8` |
| #39 | P2 | recall NL 用例跨天运行假红 | 断言依赖种子剧本时间落在昨夜窗口 | `fa0d484` |

另修自用例缺陷 9 类（API 签名适配/异步探针/解构层级/上限位清理），套件现已 326/326 全绿且复跑稳定。

### 门禁结果（干净库全流程实测）
- 迁移 0001–0005 + seed H-1 100% + verify-chain 100/100 一致；typecheck 6 项目绿。
- base 152/152 · runtime 12/12 · shared 4/4 · web build 绿 · **suite 326/326（服务层 299 + E2E 27）**。

### 当前游标 → 下一轮
- 套件纳入 CI 门禁（release.yml 仅 build，未见 test 阶段——下轮评估接入）；哈希链粒度 ADR；P3 余量收口。

---

## 第 3 轮 · 2026-08-20（基线 be7d768 → 6ca5592）· 深度对抗测试

### 方法
- 新增 DB 哈希链全库重算验证（此前无任何工具验过链自洽性）；router.ts 全量 24 个 mutation 权限矩阵逐一核对；Quest 生命周期链路推演；PII/围栏 DSL 对抗性输入 20 项；网关调用点 actor/who 静态比对 26 处。

### 已修复（逐点增量提交）

| 编号 | 级别 | 问题 | 根因 | commit |
|---|---|---|---|---|
| #32 | **P1** | 种子 100 条事件哈希用生产口径重算**全部不符** | seed 用 JSON.stringify（构造键序）算哈希 vs 生产 canonicalJson（字典序）+ zod parse 后对象——同链两种算法混杂，审计锚点事实源不一致 | `90225ac` |
| #33 | **P1** | readonly 可直接调 API 派遣 Quest（实测创建线程成功）等 14 个写操作无角色校验 | 权限校验靠各 router 自觉；前端隐藏（E2.6）服务端未强制 | `80f54ca` |
| #34 | **P1** | Quest 挂起审批通过后永远卡 pending_review | decide 副作用只有围栏激活；replay 对已批准步骤再次挂起（死循环） | `84c1c4f` |
| #35 | P2→修 | 网关不校验 actor/who 一致性，可伪造他人归因留痕 | 两身份独立传入，26 处调用点靠人工约定 | `6ca5592` |

### 对抗测试结论（验证通过，无需修复）
- **PII 脱敏 14 项**：手机号/身份证(含末位 X)/Luhn 有效卡必脱；13 位时间戳/订单号不误脱；占位符不被二次命中；混合计数准确。
- **围栏 DSL 6 项**：5000 层括号嵌套（RangeError 按 block 兜底）、除零、未知根标识符、__proto__ 路径、超大数字、引号注入——全部按 block 或正确未命中，无注入面。
- **verify-chain 工具入库**（`pnpm db:verify-chain`）：干净库 100/100 条逐条重算一致，纳入门禁。

### 门禁结果（干净库全流程实测）
- 迁移 0001–0005 + seed H-1 100% + 复跑幂等 + verify-chain 100/100 一致；typecheck 6 项目绿。
- base **152/152**、runtime **12/12**、shared 4/4、web build 绿、E6 dsh-gate 全绿。
- 权限实测：readonly 调 dispatch/inspection.run/sweep/nightShift.note/fence.dryRun 全部 403；manager 正常 SUCCESS。

### P3 清单剩余
- 哈希链粒度 ADR（tenant 锁 vs workspace 链）；JWT 无吊销；PII 占位符无盐；uninstallSkill revokedBindings 实时值；created_at 客户端可控；#1/A Outbox。

### 当前游标 → 下一轮
- 哈希链粒度 ADR 评估；expireSweep/expire 并发边界压测；apps/web 与 server 契约一致性抽查（前端调用的 procedure 名与后端挂载对账）。

---

## 第 2 轮 · 2026-08-20（基线 c595348 → be7d768）

### 范围
- dsh rc.8 强制升级（见上方「dsh 升级登记」）+ P3 清单前 2 项 DB 层加固 + apps/web 前端九大页走查。

### 已修复（逐点增量提交）

| 编号 | 级别 | 问题 | 根因 | commit |
|---|---|---|---|---|
| #30 | P3→修 | 表 owner 可 TRUNCATE 清空事件库 | 行级触发器不拦 TRUNCATE；0004 增语句级触发器（全角色生效） | `9c07416` |
| #31 | P3→修 | fence_rules 全局基线 `*` 行可被 app/gateway 写入 | RLS WITH CHECK 放行 `workspace_id='*'`；0005 增触发器仅 owner 可写 | `be7d768` |

### 前端走查结论（无新问题）
- 铁律 4「隐藏非置灰」执行到位（P1/P2/P3/P6 显式口径 + DevMatrix 专项用例）；disabled 用法均为功能性不可用（空文本/busy/无批量项），非权限置灰。
- 无 XSS 面（无 dangerouslySetInnerHTML/eval）；轮询定时器全部有 useEffect 清理；#18 修复点（text.trim() 判定）正确；无凭据硬编码（演示 JWT 存 localStorage，口径已在注释声明）。

### 门禁结果（干净库全流程实测）
- 迁移 0001–0005 + seed H-1 100% + 复跑幂等（0 写 100 弃）；typecheck 6 项目绿。
- base **150/150**（含 #30/#31 新回归）、runtime 11/11、shared 4/4、web build 绿、E6 dsh-gate 全绿（rc.8）。
- 安全门禁 7/7：append-only  UPDATE/DELETE 拒、旁路 INSERT 拒、RLS 不设/错设 0 行、**TRUNCATE 全角色拒（新）**、**fence `*` 基线写拒（新）**。

### P3 清单剩余（下轮评估）
- 哈希链粒度（tenant 锁 vs workspace 链）——方案级，走 ADR；JWT 无吊销；PII 占位符无盐；uninstallSkill revokedBindings 读实时值；created_at 客户端可控；#1/A Outbox（沿用）。

### 当前游标 → 下一轮
- 哈希链粒度 ADR 评估；apps/server router.ts 剩余 procedure 深读（本轮抽查）；P3 余量逐项收口。

---

## dsh 升级登记 · 2026-08-20（rc.6 → rc.8，commit 9b7a8d0）

- **触发**：官方 rc.7（08-17）/ rc.8（08-19）发布；项目所有者当日新决策——**任何新版本（含 rc/beta/alpha）即升，不得等稳定版**（取代 VENDOR.md 原「稳定 1.x 才升级」旧口径，决策已同步回填 VENDOR.md 与审计技能）。
- **升级内容**：vendor/dsh → rc.8（integrity 与 registry 逐字符一致 ✅）；dsh-gate pin rc.8 + lock 更新 + node-pty rebuild。
- **rc.8 变更面**：CLI 聚合包 lib 字节与 rc.6 一致；subagent Codex / Claude Code 改为按需安装 Profile Bundle；SQLite 新存储格式不向下兼容（沙箱 DSH_HOME 新建，无历史会话，无迁移负担）。
- **兼容性实测**：E6 dsh-gate 门禁全绿（workloom-fence 挂 tools/pre-execute 正常、事件桥 37 条验链通过、H-5 kill -9 重放零重复），plugins 薄壳适配器零改动。
- **subagent 插件已装**（DSH_HOME web profile）：`@deepseek-ai/dsh-subagent-claude-code@0.1.0-rc.8` + `@deepseek-ai/dsh-subagent-codex@0.1.0-rc.8`，`--dump-config` 确认两插件加载正常；实际调度需目标机安装 codex / claude-code CLI 本体与凭据（沙箱不验证真实调用）。

---

## 第 1 轮 · 2026-08-20（基线 a596e2a → c595348）

### 范围与方法
- 全量代码走查：安全网关 / append-only / 围栏引擎 / 权限 / RLS / 多租户 / IM 通道 / 夜班 / 巡检 / 技能体系 / runtime / tRPC 路由。
- 沙箱自建 Node 24.9 + PostgreSQL 17.11 + pgvector 0.8.6 实测：迁移 + 种子 + **开启此前全部 skip 的 DB 集成测试**（RUN_DB_TESTS=1）。
- dsh 版本检查：官方仓库 deepseek-ai/deepseek-harness 已发布 **rc.7（2026-08-17）/ rc.8（2026-08-19）**，npm latest=rc.7、next=rc.8；diff rc.6→rc.8：CLI `lib/*.js` 字节一致，仅 agent-presets 配置与 package.json 依赖 bump。**按 vendor/dsh/VENDOR.md 纪律「稳定 1.x 发布后才升级」，保持 rc.6 锁定不升级**，本登记备查。

### 已修复（逐点增量提交）

| 编号 | 级别 | 问题 | 根因 | commit |
|---|---|---|---|---|
| #22 | **P0** | 全量读路径 fail-closed 失效（登录/审批/夜班/巡检/技能/召回不可用；RUN_DB_TESTS=1 实测 37/144 红） | #2/#20 把 `set_config(...,false)` 改事务级 `true`，但 15 个文件 40+ 封装（connect→set_config→fn→release）无显式事务，autocommit 下事务级设置语句结束即失效 → RLS 上下文恒 NULL | `cb4f154` |
| #23 | **P1** | team 技能跨工作区互覆盖 + 列表跨区可见 + 他区可装 | skills 全局表无 RLS，teamSkillId 仅名称派生，ON CONFLICT DO UPDATE 互覆盖 | `4383ef6` |
| #24 | **P1** | 技能「安装即绑定围栏」运行时不生效 | resolveAgentFenceBindings 定义后无消费点，assembly 只读 agents.fence_bindings | `04aa1e1` |
| #25 | P2 | runtime 全流程测试 ~27% 概率失败（flaky）；H-15 测试 cwd 敏感 | demo 工具 10% 随机 synced:false；测试静态 import 使 env 设置失效；process.cwd() 相对路径 | `630d24b` `c595348` |
| #26 | P2 | appendEvent 幂等丢弃返回错误 hash/seq | #4 只修了 appendEventIdempotent，主路径同根残留 | `0c1f4f3` |
| #27 | P2 | routeIntent 超时未真正取消 LLM 调用 | AbortController 只赢 race，classify() 无 signal 参数（#7 名不副实） | `f2332ea` |
| #28 | P2 | 冲突审批 approval_id 同毫秒碰撞 | makeReadableId("AP", Date.now()%100000) 熵不足，改事件派生 apr-e-\<id\> | `e4796a3` |
| #29 | P2 | IM 入站并发重推可双写事件 | 查重与写事件非原子（TOCTOU）；改 im_inbound_dedupe 幂等键表原子占位（0003 迁移） | `c7eb8cf` |
| 顺带 | P2 | withObjectLock 锁等待无超时兜底 | SET LOCAL statement_timeout 在 BEGIN 之前（事务外无效果），已挪正（随 #22 commit） | `cb4f154` |
| 顺带 | P2 | dispatch 并发上限检查 fail-open 恒 0 行 | threads 计数走池直查无 RLS 上下文，已移入事务（随 #22 commit） | `cb4f154` |
| 顺带 | P2 | H-15 测试污染种子 industry（断言中断残留 copycat） | 还原逻辑不在 finally；另测试断言池直查在 RLS 下恒 0 行（假绿/假红） | `cb4f154` |

### 登记不修（P3，下轮评估）
1. **fence_rules RLS WITH CHECK 允许写 `workspace_id='*'`**：任何 workspace 上下文可插/改全局基线行（服务层有审批流兜底，DB 层未强制；建议 DB 层拒 `*` 写入或改 owner 通道）。
2. **哈希链粒度不一致**：advisory 锁为 tenant 级，但 RLS 把链尾读取限到 workspace → tenant 视角链分叉。当前验证口径（dsh jsonl）不受影响；如需 tenant 单链属方案级变更，走 ADR。
3. **biz_events 缺 TRUNCATE 触发器**：表 owner 可清空事件库（行级触发器不拦 TRUNCATE）。
4. **JWT 无吊销 + verifyToken 缺字段校验弱**：成员被移出后旧 token 24h 内有效（演示口径，生产 IdP 对接时解决）。
5. **PII 占位符无盐 sha256(8)**：低熵数据（手机号）可枚举反查（需 DB 读权限为前提，风险可控）。
6. **uninstallSkill 事件 revokedBindings 读实时值**：运行时收缩按快照正确，仅留痕数值可能不准。
7. **appendEvent created_at 取客户端 payload.context.time**：事件时间可被声明方伪造（建议 DB 默认 now() 与服务端时间分离）。
8. **#1/A 双池事务一致性（Outbox）**：沿用 0.1.1 既有登记，架构性改造另评。

### 门禁清单结果（全部实测通过）
- typecheck 全包绿（6 项目）；shared 4/4；**base 148/148（含 54 个原 skip 的 DB 集成测试 + 5 个新回归用例，×3 连跑稳定）**；runtime 11/11（×5 连跑稳定）。
- 迁移 0001–0003 + 种子 H-1 完整率 100%；seed 复跑幂等（新写 0 / 丢弃 100）。
- 安全门禁 6/6：gateway UPDATE/DELETE biz_events 被拒；app INSERT biz_events 被拒；不设/错设 workspace 上下文 0 行；正确上下文可见。
- server `/health` + `/trpc/system.health` 200（db:up）；web build 绿。
- 端到端实测：loginAs 签 JWT → members.list 3 人 / threads.list / approvals.list 全部真实返回（#22 修复前 loginAs 即 NOT_FOUND）。

### 事实源偏差登记
- 仓库 docs/ 无 PROGRESS.md / DECISIONS.md / MASTERPLAN.md / RELAY.md（技能协议假定的治理文档在远程 main 不存在）；本轮起以 CHANGELOG.md + 本文件 + 代码为事实源。
- 仓库实为 **public**（非私有），License Apache-2.0；README badge 的 dsh 链接（deepseek-ai/dsh）与实际上游（deepseek-ai/deepseek-harness）不一致，建议修正。

### 当前游标 → 下一轮
- 评估 P3 清单第 1–3 项（DB 层加固，一个 commit 一项）；
- apps/web 前端九大页走查（本轮聚焦后端与数据层，前端仅 build 验证 + DispatchBar #18 修复点代码确认）；
- dsh 稳定 1.x 发布后按 §2.5 流程升级评估。

## dsh 0.1.1-rc.1 升级登记（2026-08-21，随发布即升纪律）

- **触发**：官方发布 `0.1.1-rc.1`（npm latest/next 双 tag 同指，发布 2026-08-21T06:49Z）。
- **变更面实测 diff（rc.8→rc.1）**：CLI 聚合包 `lib/*.js` 与 config/presets 字节一致；README 仅链接修正；变更集中在全家桶子包统一 bump（语义化小版本线）。
- **动作**：vendor/dsh 换基线 rc.1（integrity `sha512-HVauMT0F…DcZz0w==` 与 registry 逐字符一致 ✅）；dsh-gate pin 0.1.1-rc.1 + 独立 lock 更新 + node-pty 重建；README 中英版本引用同步。
- **门禁实测**（在酒店版主线同变更实测）：E6 dsh-gate 全绿（用例一全链 37 条验链 ✅ + H-5 kill -9 崩溃重放零重复 ✅）；typecheck 6/6 · base 174/174 · runtime 12/12。
