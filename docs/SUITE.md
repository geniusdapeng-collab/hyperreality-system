# WorkLoom IM · 全场景测试套件用例清单（371 条）

> 执行入口：`pnpm suite`（`scripts/suite.ts`）。服务层 344 条直连 PG 逐条执行；E2E 27 条 spawn 真实 server 走 HTTP。
> 用例数据以前缀（SFX）隔离、可重跑、失败不中断、末尾汇总报告。CI 每次 push 全量执行（`.github/workflows/ci.yml` ci-gate）。
> 本清单由套件运行时导出，与实际执行逐条对应；新增用例后重新生成（`pnpm suite` 输出即权威）。

## 总览

| 段 | 域 | 覆盖 | 条数 |
|---|---|---|---|
| 服务层 | A | 三模式意图路由（Ask/Agent/Quest/clarify + LLM 分类器对抗） | 42 |
| 服务层 | B | 安全网关三段瀑布（权限 → 脱敏 → 高风险授权） | 35 |
| 服务层 | C | 围栏判定（种子 R1–R6 真实规则 + DSL 对抗） | 29 |
| 服务层 | D | 事件库与检索（11 维过滤 + NL 翻译与降级） | 20 |
| 服务层 | E | 审批流（三手势/权重/幂等/过期/批量/并发） | 34 |
| 服务层 | F | IM 多通道（入站映射/访客/并发重推/手势回调/卡片出站/回执失败） | 31 |
| 服务层 | G | 夜班与触发器（状态机/暂停恢复/决策包） | 18 |
| 服务层 | H | 技能体系（工作区隔离/版本/dry-run/冲突/签名白名单） | 20 |
| 服务层 | I | 组织记忆（脱敏写入/语义检索/生命周期/归因） | 12 |
| 服务层 | J | 巡检（重试告警/派单幂等/回链升级） | 10 |
| 服务层 | K | 模型路由（分级/降级链/熔断/记忆复用/账单投影） | 10 |
| 服务层 | L | desktop 高危与多模态（图片占位/设计稿引用） | 8 |
| 服务层 | M | 注入与边界（SQL 注入字符/深嵌套/控制字符/伪造 ID） | 18 |
| 服务层 | N | 并发压测（连接池/编号唯一/审批竞态/哈希链不断） | 12 |
| 服务层 | O | 店长日常场景（晨间问数/派单/审批闭环/夜班/IM 指令/日终链自检） | 16 |
| 服务层 | P | 系统层（迁移核验/RLS 池卫生/回滚/防注入/token 伪造/大 payload/跨租户隔离） | 14 |
| 服务层 | Q | 异常 case 与压测（审批风暴/重推风暴/写风暴/巨报文/畸形回调/锁竞争/断链检测） | 15 |
| E2E | H | HTTP E2E 权限矩阵（spawn 真实 server：三角色 × 关键 API、401/403/越权空/越版） | 27 |
| | | **合计** | **371** |

## 域 A · 三模式意图路由（Ask/Agent/Quest/clarify + LLM 分类器对抗）（42 条）

- **A-01** ask 句式「请问上周 OCC 多少？」→ ask
- **A-02** ask 句式「查一下昨天的入住率」→ ask
- **A-03** ask 句式「统计本月差评分布」→ ask
- **A-04** ask 句式「什么是保底价？」→ ask
- **A-05** ask 句式「为什么周末房价高？」→ ask
- **A-06** ask 句式「哪家渠道评分最低？」→ ask
- **A-07** ask 句式「今天天气怎么样？」→ ask
- **A-08** ask 句式「现在满房了吗？」→ ask
- **A-09** ask 句式「问一下夜班跑完了吗」→ ask
- **A-10** ask 句式「房价是多少」→ ask
- **A-11** agent 句式「逐步生成三版文案，每」→ agent
- **A-12** agent 句式「一步步来，先草稿给我」→ agent
- **A-13** agent 句式「我们商量着调价」→ agent
- **A-14** agent 句式「先采集再让我确认每一」→ agent
- **A-15** agent 句式「每一步都要我点头」→ agent
- **A-16** agent 句式「先出个初稿给我看再定」→ agent
- **A-17** quest 句式「把周五雅致大床房调价」→ quest
- **A-18** quest 句式「回复携程那条 2 分」→ quest
- **A-19** quest 句式「今晚夜班跑一遍对账」→ quest
- **A-20** quest 句式「把竞对价格拉一遍」→ quest
- **A-21** quest 句式「生成下周小红书文案」→ quest
- **A-22** quest 句式「把 812 房间关房」→ quest
- **A-23** quest 句式「退款给订单 1001」→ quest
- **A-24** quest 句式「调价到 ¥468」→ quest
- **A-25** quest 句式「帮我把差评都回了」→ quest
- **A-26** quest 句式「跑一轮巡检」→ quest
- **A-27** 含糊「帮我看看」→ clarify 反问
- **A-28** 含糊「看看」→ clarify 反问
- **A-29** 含糊「在吗？」→ clarify 反问
- **A-30** 含糊「你好」→ clarify 反问
- **A-31** 含糊「怎么处理？」→ clarify 反问
- **A-32** 含糊「怎么样了？」→ clarify 反问
- **A-33** 含糊「嗯」→ clarify 反问
- **A-34** 含糊「？？？」→ clarify 反问
- **A-35** 空字符串 → clarify
- **A-36** 500 字长指令不炸
- **A-37** LLM 分类器正常 JSON
- **A-38** LLM 输出垃圾 → 规则兜底
- **A-39** LLM 输出 markdown 包裹 JSON 可解析
- **A-40** LLM 输出越权 mode → 规则兜底
- **A-41** 提示词注入不劫持分类（分隔符内为数据）
- **A-42** 超时降级 timeout_fallback

## 域 B · 安全网关三段瀑布（权限 → 脱敏 → 高风险授权）（35 条）

- **B-01** 写动作前缀「price.adjust」识别
- **B-02** 写动作前缀「order.refund」识别
- **B-03** 写动作前缀「review.reply」识别
- **B-04** 写动作前缀「content.draft」识别
- **B-05** 写动作前缀「content.publish」识别
- **B-06** 写动作前缀「refund.apply」识别
- **B-07** 写动作前缀「desktop.gui」识别
- **B-08** 写动作前缀「trigger.create」识别
- **B-09** 读动作「order.list」识别
- **B-10** 读动作「review.list」识别
- **B-11** 读动作「pms.price.read」识别
- **B-12** 读动作「inspection.scan」识别
- **B-13** 读动作「competitor.fetch」识别
- **B-14** registerWriteActions 注册新写动作生效
- **B-15** 未声明 fence_bindings 的 Agent 写动作系统级禁写（F2.10）
- **B-16** 只读 preset 写动作被拒（L9.1）
- **B-17** 声明 bindings 的 Agent 写动作放行
- **B-18** 人类 actor 不受 agent 段①限制
- **B-19** 高危 Agent 写动作缺 approvalRef 被拒（L3.5）
- **B-20** 高危 Agent 带 approvalRef 放行
- **B-21** actor/who 分叉伪造被拒
- **B-22** PII PHONE 事件落库为占位符
- **B-23** PII IDCARD 事件落库为占位符
- **B-24** PII EMAIL 事件落库为占位符
- **B-25** PII QQ 事件落库为占位符
- **B-26** PII BANKCARD 事件落库为占位符
- **B-27** zod 非法事件被拒且不落库
- **B-28** gatewayAppendIdempotent 自带 ID 重复丢弃
- **B-29** 事件 context tenant/workspace 强制覆写防伪造
- **B-30** context.time 进入 created_at（声明时间）
- **B-31** 哈希链续接：新事件 prev_hash=链尾
- **B-32** 哈希可按 canonicalJson 重算
- **B-33** GENESIS 首条口径
- **B-34** 并发 20 写事件编号无重复
- **B-35** sessionId 落库可查

## 域 C · 围栏判定（种子 R1–R6 真实规则 + DSL 对抗）（29 条）

- **C-01** 种子基线规则装载 ≥6 条且含 R1-R6
- **C-02** R1 涨幅 ≤8% → auto
- **C-03** R2 破保底价 ¥380 → block 熔断
- **C-04** R6 差评回复 → review 挂起
- **C-05** 读类动作无命中恒 auto（不进 default_level）
- **C-06** 写类动作无命中走 default_level
- **C-07** deny 优先并集：block > review > auto
- **C-08** when 求值异常按 block 且留痕
- **C-09** rule_impact 含版本号（附录 E）
- **C-10** 子调用同瀑布无后门（judgeSubCall ≡ judge）
- **C-11** DSL 算术+比较+逻辑组合
- **C-12** DSL abs/min/max 函数
- **C-13** DSL 除零抛 FenceEvalError
- **C-14** DSL 空条件恒命中
- **C-15** DSL 字符串比较
- **C-16** DSL 布尔字面量与 not
- **C-17** DSL 括号优先级
- **C-18** DSL 非法字符拒绝
- **C-19** DSL 未知根标识符拒绝
- **C-20** DSL 深层路径取值
- **C-21** DSL 5000 层嵌套按异常处理不炸进程
- **C-22** 默认档 defaultLevel=block 写类无命中熔断
- **C-23** 判定结果 impacts 只含命中规则
- **C-24** 基线 R2 与 R1 并集：涨幅 2% 但破保底 → block
- **C-25** 多对象类型规则不匹配对象跳过
- **C-26** 动作不匹配跳过
- **C-27** 触发名带规则名（triggeredBy 展示口径）
- **C-28** 写类无命中 triggeredBy 含 default 说明
- **C-29** evalCondition 类型错误抛异常

## 域 D · 事件库与检索（11 维过滤 + NL 翻译与降级）（20 条）

- **D-01** 结构化检索：action 过滤命中
- **D-02** 检索：objectType 过滤
- **D-03** 检索：actor 过滤
- **D-04** 检索：actorType=human
- **D-05** 检索：ruleResult=blocked 命中种子熔断样本
- **D-06** 检索：ruleId 过滤
- **D-07** 检索：时间范围过滤
- **D-08** 检索：sessionId 过滤
- **D-09** 检索：全文 text 片段
- **D-10** 检索：非法字符字段拒绝
- **D-11** 检索：分页游标连续
- **D-12** 检索：limit 上限截断 200
- **D-13** NL 检索：Mock 翻译器结构化
- **D-14** NL 检索：翻译超时降级不伪造结果
- **D-15** NL 翻译器规则直译 R2
- **D-16** 事件五元 zod 完整（附录 E 回读）
- **D-17** links 溯源字段落库
- **D-18** model_trace 计量字段落库
- **D-19** receipt 回执位落库
- **D-20** 越权工作区检索返回空（L7.1）

## 域 E · 审批流（三手势/权重/幂等/过期/批量/并发）（34 条）

- **E-01** 采纳 → approved + 手势权重 1
- **E-02** 编辑后采纳 → edited + 权重 2 + edited_after
- **E-03** 驳回 → rejected + 权重 3 + 原因枚举
- **E-04** 驳回缺原因枚举被拒（L5.2）
- **E-05** 驳回原因自由文本 >200 字被拒
- **E-06** 编辑后采纳缺 edited_after 被拒
- **E-07** readonly 审批 403（L5.1）
- **E-08** 重复回调幂等 deduped（L5.3）
- **E-09** 过期快照手势被拒并标 expired（E5.3）
- **E-10** 不存在审批 NOT_FOUND
- **E-11** 手势事件经网关落库（approval.gesture）
- **E-12** 手势事件 links 溯源被审事件
- **E-13** 驳回原因枚举回流偏好记忆（F1.7）
- **E-14** 批量采纳：普通项通过
- **E-15** 批量采纳：高危项跳过须逐条
- **E-16** 批量采纳：已处理项跳过
- **E-17** 批量采纳：不存在项跳过不中断
- **E-18** 批量采纳 readonly 403
- **E-19** 队列投影含被审事件 payload（F5.1）
- **E-20** 队列按状态过滤
- **E-21** 队列 limit 生效
- **E-22** expireSweep 过期普通项标 expired + 写事件
- **E-23** expireSweep 高危过期项不自动放行（L5.4）
- **E-24** expireSweep 未到期项不动
- **E-25** 并发 8 路 decide 同一审批：仅 1 路生效
- **E-26** 审批快照字段完整（before/after/expires_at）
- **E-27** decided_by/decided_at 留痕
- **E-28** UNIQUE(event_id,channel) 重复建行幂等
- **E-29** 手势 reason_enum 写入 gesture JSON
- **E-30** manager 角色有审批权
- **E-31** 审批事件在事件库可检索（G8 留痕）
- **E-32** 队列越权工作区返回空
- **E-33** 手势权重常量 1/2/3 映射
- **E-34** 空 approvalIds 批量返回空结果

## 域 F · IM 多通道（入站映射/访客/并发重推/手势回调/卡片出站/回执失败）（31 条）

- **F-01** 合法入站消息落事件 + 成员映射
- **F-02** 访客消息 who=ext: 口径
- **F-03** 重复投递幂等返回原 eventId
- **F-04** 并发 8 路重推仅落 1 条
- **F-05** 通道文本 PII 脱敏（手机号不落明文）
- **F-06** 缺 channelMsgId 拒绝
- **F-07** 缺 conversationId 拒绝
- **F-08** 缺 senderOpenId 拒绝
- **F-09** 空文本拒绝
- **F-10** 超长文本 >2000 拒绝
- **F-11** 未启用通道拒绝（slack planned）
- **F-12** 未知通道拒绝
- **F-13** openid 映射查询命中
- **F-14** openid 未映射返回 null
- **F-15** 手势回调 approve 生效 + 回执
- **F-16** 手势回调未映射 openid 拒绝（E5.2）
- **F-17** 手势回调 readonly 成员无权（L5.1 通道同权）
- **F-18** 手势回调重复 deduped + 回执明示已处理
- **F-19** 手势回调 reject 带原因
- **F-20** 手势回调 edit 带新值
- **F-21** 回执发送失败不影响审批结果（#21 口径）
- **F-22** 审批卡片字段完整（三手势/过期位/diff）
- **F-23** 卡片出站留痕 approval.card.sent
- **F-24** Mock 驱动出站盒单调递增
- **F-25** 通道注册表三官方启用
- **F-26** slack 保留 planned 不启用
- **F-27** 入站消息 2000 字边界接受
- **F-28** 入站 kind=direct/group 落库
- **F-29** 入站 sentAt 声明时间落 context
- **F-30** 手势回调缺 approvalId 锚点报错
- **F-31** mapped_member 字段落库（映射留痕）

## 域 G · 夜班与触发器（状态机/暂停恢复/决策包）（18 条）

- **G-01** ensureReady 创建夜班 ready + 幂等
- **G-02** confirmNight ready→running + 围栏快照（F2.6）
- **G-03** confirmNight 非 ready 拒绝（状态机守卫）
- **G-04** pauseAll 标记 paused_by=night-shift
- **G-05** resumeNight 只恢复夜班暂停，不覆盖手动暂停（#13 口径）
- **G-06** 候选清单构建（F4.1）
- **G-07** 决策包投影三栏统计（F4.4）
- **G-08** 夜班开启留痕事件（G8）
- **G-09** 暂停留痕含计时（G5 口径）
- **G-10** 触发器创建 cron 落库
- **G-11** 触发器创建 event 落库
- **G-12** 触发器停用/启用开关
- **G-13** 夜班配置 night_config 读取
- **G-14** ensureReady 不同日期不同班次
- **G-15** confirmNight 候选计数落库
- **G-16** 夜班暂停再恢复状态机闭环
- **G-17** 触发器列表按工作区隔离
- **G-18** 夜班事件 who=system 归因

## 域 H · 技能体系（工作区隔离/版本/dry-run/冲突/签名白名单）（20 条）

- **H-01** teamSkillId 内嵌 workspace（#23 口径）
- **H-02** 同名技能跨区不互覆盖
- **H-03** 同名再生成版本递增
- **H-04** 未 dry-run 拒装（F8.3）
- **H-05** dry-run 预览 → 安装放行
- **H-06** 重复安装幂等 deduped
- **H-07** 安装即绑定快照（#17 口径）
- **H-08** 卸载即并集收缩
- **H-09** 他区技能安装拦截（#23）
- **H-10** industry 未脱敏拦截（L8.1）
- **H-11** 围栏冲突进审批不静默（E8.1）
- **H-12** isSignedSource 白名单口径
- **H-13** detectFenceConflicts 缺失识别
- **H-14** isAssetReusable 验证闸门
- **H-15** 技能列表 team 隔离
- **H-16** listInstalls 安装记录可查
- **H-17** 卸载未安装技能报错（L8.3 幂等约束）
- **H-18** 技能安装事件留痕（skill.installed）
- **H-19** CHECK 约束：team 技能 ID 必须 skill-t- 前缀（#16）
- **H-20** dry-run 报告结构（replayed/perRule）

## 域 I · 组织记忆（脱敏写入/语义检索/生命周期/归因）（12 条）

- **I-01** 写入记忆脱敏（手机号不落明文 F1.8）
- **I-02** 结构化检索：scope/kind 过滤
- **I-03** 语义检索返回距离
- **I-04** upsert 同 ID 覆盖更新
- **I-05** 生命周期 active→superseded
- **I-06** 重复迁移报错（幂等约束）
- **I-07** 归因反查来源事件（验收断言）
- **I-08** 使用记录闭环（memory_usage）
- **I-09** recalled 记忆不出现在 active 检索
- **I-10** recalled 状态可检索（回收区）
- **I-11** embedding 维度 1536
- **I-12** 跨工作区记忆不可见

## 域 J · 巡检（重试告警/派单幂等/回链升级）（10 条）

- **J-01** 巡检扫描正常快照 → ok
- **J-02** 探针失败重试后写 inspect.run.failed（不静默）
- **J-03** 异常快照产出 anomaly 事件
- **J-04** 一键派单建线程回链（F9.3）
- **J-05** 重复派单幂等
- **J-06** 不存在异常派单 NOT_FOUND
- **J-07** 处理成功回链写事件
- **J-08** 处理失败升级严重度 + 转需介入（E9.3）
- **J-09** 巡检状态条投影可读
- **J-10** 派单事件 links 回异常事件

## 域 K · 模型路由（分级/降级链/熔断/记忆复用/账单投影）（10 条）

- **K-01** 任务分类：content.publish → flagship
- **K-02** 任务分类：price.adjust → standard
- **K-03** 任务分类：depthHint=deep → flagship
- **K-04** 峰谷窗口判定函数可调用
- **K-05** 主调度：健康模型直答 + 计量
- **K-06** 降级链：首选不健康 → 次选 + 降级留痕（L6.1 不静默）
- **K-07** 全链不可用 → unavailable/queued
- **K-08** 熔断：超限挂起（L6.4）
- **K-09** 记忆复用零消耗（F6.1）
- **K-10** 账单投影聚合（L6.3 只投影不重算）

## 域 L · desktop 高危与多模态（图片占位/设计稿引用）（8 条）

- **L-01** desktop.gui 为写类动作（前缀表含 desktop.）
- **L-02** desktop-agent 未声明 bindings 禁写
- **L-03** desktop-agent 高危无逐次授权拒绝
- **L-04** desktop-agent 高危带逐次授权放行
- **L-05** 多模态输入（图片 base64 占位）事件落库不炸
- **L-06** 多模态文本中的 PII 仍被脱敏
- **L-07** design 稿链接引用落库
- **L-08** desktop 只读巡检 preset 禁写（L9.1）

## 域 M · 注入与边界（SQL 注入字符/深嵌套/控制字符/伪造 ID）（18 条）

- **M-01** SQL 注入字符进 object.id 参数化安全
- **M-02** unicode 控制字符文本落库
- **M-03** emoji/多字节文本落库
- **M-04** 深嵌套 params（100 层）落库
- **M-05** 空 after 对象落库
- **M-06** 非法 event_id 注入 idempotent 被拒
- **M-07** event_id 格式必须 E-N（zod regex）
- **M-08** 时间字段非法格式拒绝
- **M-09** rule_impact 非数组拒绝
- **M-10** who.type 枚举外拒绝
- **M-11** 检索 from>to 倒置范围返回空
- **M-12** 审批 reasonText 恰好 200 字接受
- **M-13** 线程标题 500 字边界
- **M-14** 技能名纯特殊字符 slug 兜底 unnamed
- **M-15** 围栏 when 超长表达式（10KB）可解析
- **M-16** 消息文本含占位符样式字符串不混淆
- **M-17** 负数与零参数 DSL 判定
- **M-18** 租户错配写入 RLS 拒绝

## 域 N · 并发压测（连接池/编号唯一/审批竞态/哈希链不断）（12 条）

- **N-01** 并发 50 查询池不耗尽
- **N-02** 并发 20 事件写编号唯一（advisory 串行）
- **N-03** 并发 10 线程创建 ID 不冲突
- **N-04** 并发 5 路同审批仅 1 路生效
- **N-05** 并发入站不同消息互不干扰
- **N-06** 并发 ensureReady 同日期幂等
- **N-07** 对象写锁持锁期间他人超时（E2.5）
- **N-08** 并发写读一致（写后立即读可见）
- **N-09** 连接池卫生：连续 100 次借还无泄漏
- **N-10** 网关并发不同工作区互不串链（各自 workspace 链独立）
- **N-11** 压测：100 条事件连写链不断
- **N-12** 压测：审批批量 50 建 50 批

## 域 O · 店长日常场景（晨间问数/派单/审批闭环/夜班/IM 指令/日终链自检）（16 条）

- **O-01** 晨间问数：口语化提问路由 ask + NL 检索可达
- **O-02** 晨会派单：一句话调价任务跑通到 completed
- **O-03** 待办巡阅：店长清空 3 条待审批
- **O-04** 钉钉卡片审批闭环：发卡 → 手势批准 → 状态同步
- **O-05** 高危桌面操作授权链：无授权拒 → 审批 → 带授权放行
- **O-06** 差评 Quest 审批恢复闭环：挂起 → 批准 → 重放完成
- **O-07** 夜班晨收：确认班次 → 取决策包给店长过目
- **O-08** 夜班应急：店长一键熔断再恢复
- **O-09** IM 下指令：钉钉文本进事件库且可路由为任务
- **O-10** 访客咨询：未映射 openid 按外部访客留痕
- **O-11** 自然语言查账：店长口语检索被驳回的调价
- **O-12** 店长看组织记忆：驳回校准偏好可见
- **O-13** 店长看技能目录：官方可见 + team 仅本工作区
- **O-14** 店长发起巡检并消解异常：扫描 → 派单 → 标记处理
- **O-15** 一天收尾：本工作区哈希链自检（接龙 + 重算一致）
- **O-16** 多成员同日操作各自留痕（who 维度可检索）

## 域 P · 系统层（迁移核验/RLS 池卫生/回滚/防注入/token 伪造/大 payload/跨租户隔离）（14 条）

- **P-01** 迁移落位核验：0003 幂等表 + 0004/0005 触发器存在
- **P-02** RLS 池卫生：未设上下文的连接读业务表 0 行
- **P-03** 错误 SQL 后池连接仍可复用
- **P-04** 事务中途出错回滚不留脏数据
- **P-05** 参数化防注入：恶意参数原样当值处理
- **P-06** 伪造/篡改 token 一律验签失败
- **P-07** 大 payload 事件（1MB 文本）写读一致
- **P-08** Unicode/emoji/零宽字符事件往返不失真
- **P-09** 空 params / null 字段事件可写（schema 容忍最小事件）
- **P-10** 跨 tenant 数据互不可见（L7.1 租户级隔离）
- **P-11** approvals 主键重复插入被拒（PK 兜底）
- **P-12** 非法事件 draft 被 schema 拒绝（缺 who）
- **P-13** 池超载排队：并发 80 查询全部完成
- **P-14** 套件数据自我隔离：他工作区视角查不到套件事件

## 域 Q · 异常 case 与压测（审批风暴/重推风暴/写风暴/巨报文/畸形回调/锁竞争/断链检测）（15 条）

- **Q-01** 审批风暴：100 审批并发 decide 全部恰好一次终态
- **Q-02** 入站重推风暴：同消息 50 路并发仅 1 条事件
- **Q-03** 写风暴：200 事件分批并发后链完整
- **Q-04** IM 巨报文（100KB 文本）按明确口径处理不炸
- **Q-05** 畸形回调三连：非法手势 / 不存在审批 / 空 openid
- **Q-06** 对象锁 10 路竞争：串行化全部完成无死锁
- **Q-07** 夜班并发开工：20 路 ensureReady 同日仅 1 个班次
- **Q-08** 记忆风暴：50 条并发 upsert 后检索完整
- **Q-09** 检索风暴：30 组异构过滤并发全部返回
- **Q-10** 围栏判定压测：1000 次混合判定 < 2s
- **Q-11** PII 脱敏压测：1000 条混合文本 < 2s
- **Q-12** 批量审批 100 条一次批完
- **Q-13** 断链注入可检测：篡改 prev_hash 链验证立即报警（事务内构造，不污染库）
- **Q-14** 同审批 20 路并发 decide 仅 1 路生效
- **Q-15** 巡检并发 5 路：同班次幂等去重（同 runId 不重复出报告）

## 域 H · HTTP E2E 权限矩阵（spawn 真实 server：三角色 × 关键 API、401/403/越权空/越版）（27 条）

- **H-01** GET /health 200
- **H-02** /trpc/system.health db:up
- **H-03** loginAs 三成员签发 JWT
- **H-04** loginAs 错误工作区 404
- **H-05** loginAs 错误成员 404
- **H-06** 无 token 调受保护 procedure → 401
- **H-07** 伪造 token → 401
- **H-08** readonly 调 threads.dispatch → 403（E2.6 服务端强制）
- **H-09** readonly 调 inspection.run → 403（E2.6 服务端强制）
- **H-10** readonly 调 approvals.sweep → 403（E2.6 服务端强制）
- **H-11** readonly 调 nightShift.note → 403（E2.6 服务端强制）
- **H-12** readonly 调 fence.dryRun → 403（E2.6 服务端强制）
- **H-13** readonly 调 im.inbound → 403（E2.6 服务端强制）
- **H-14** readonly 查询 threads.list 放行
- **H-15** readonly 查询 members.list 放行
- **H-16** readonly 查询 approvals.list 放行（L5.5 可看不可批）
- **H-17** manager 调 threads.dispatch 放行
- **H-18** manager 调 approvals.sweep 放行
- **H-19** manager 调 auth.setPlan → 403（owner-only）
- **H-20** owner setPlan community → manager 调 dispatch 403 越版（H-10）→ 恢复 pro
- **H-21** 伪造 workspace 的 token 查询返回空（L7.1）
- **H-22** threads.events 越权线程返回空
- **H-23** approvals.decide readonly → 403
- **H-24** skills.install readonly → 403
- **H-25** bundles.activate readonly → 403
- **H-26** E2E 端到端：dispatch → clarify 反问（含糊指令不建任务）
- **H-27** E2E 端到端：dispatch 建任务 → threads.get 可查

