---
name: data-mining-engine
description: >
  珍妮纺织机·数据挖掘引擎。SuperMickey 全链路的情报层（Stage -2），
  在创意主题生成之前运行。五个 Agent 串行流水线：商品情报采集员 →
  用户评价矿工 → 竞品侦察员 → 交叉验证官 → 档案装订员，产出《商品情报
  档案》（含商品图 manifest）与六张下游摘要卡。使用时机：社媒营销/商品
  推广类任务，或任何需要商品真实情报支撑的创作任务。
---

# 珍妮纺织机 · 数据挖掘引擎 — 执行手册

> 隐喻：把棉花（散落的商品信息）纺成纱布（结构化情报档案），
> 供下游裁剪成各种衣服（Brief / 主题 / PRD / 镜头提示词）。

## 一、模块定位与铁律

**定位**：全链路最上游（Stage -2），营销/商品模式强制激活，纯故事模式跳过。
与主链路松耦合：档案命中即复用，未命中才跑流水线，**任何故障不得阻塞主流程**。

**五条铁律（全 Agent 通用，违者出站即被闸机拦截）**：

1. **无源不入库**：每条事实/观点必须挂证据编号（EvidenceLedger 登记），
   无来源的内容一律剔除并记入 gaps。
2. **置信度三级**：confirmed（官方或 ≥2 独立来源）/ reported（单一来源）/
   inferred（推理）。inferred 禁止进入 pros/cons 事实区与任何摘要卡。
3. **原文不改写**：用户评价的语义一字不改，聚合只做归类不做润色。
4. **缺站显式标记**：采集不到的维度写进 gaps，禁止留空装作完整。
5. **禁止虚构外观**：商品图必须真实来源，AI 生成图/概念图/渲染图直接出局。

## 二、运行模式

| 模式 | 流程 | 适用 |
|------|------|------|
| spec | `engine.plan(input)` 产出三份《任务书》→ 执行 Agent 就地检索回填 → `engine.assemble(traceId, input, raw)` | LLM 就地执行（supermickey-studio 技能运行时默认） |
| api  | `engine.run(input)` 全自动 | 注入 executor(stage, plan) 检索执行器的环境 |

**输入契约**：`{ name(必填), brand?, category?, model?, price_band?, sellingPointCandidates? }`

## 三、流水线协议（Agent 间数据管道）

```
input
  → [A1] --信封--> [A2] --信封--> [A3] --信封--> [A4] --信封--> [A5]
        每站出站必过两道关：Envelope.verify（完整性）→ HandoffValidator（契约闸机）
        证据账本（EvidenceLedger）全程共享，证据编号随信封流转
```

- **信封**：`{ envelope_id, trace_id, stage, agent, mode, payload, evidence_refs, prev_checksum, checksum, created_at }`。
  校验和 sha256 链式锁定，防串包防跳站；trace_id 全程一致，任何情报可倒查。
- **闸机三层**：L1 结构硬校验（缺必填→阻断）；L2 纪律硬校验（事实区无证据编号→阻断）；
  L3 丰度软校验（量不足→放行但记 gap）。
- **缺站降级**：A1 是硬依赖（身份事实缺失全线停摆）；A2/A3 缺站记 gap 继续，
  档案照样装订，下游只看到"标记了缺口"的档案。

## 四、Agent 分册

### A1 商品情报采集员（ProductInfoCollector）

**使命**：把"官方事实"和"真实外观"钉死。

**任务书（plan）产出**：
- 查询矩阵（实物 8 路 / 服务 6 路）：官网、旗舰店商品页、参数规格、价格、
  官方产品图、实拍开箱、白底图；带型号时追加"型号甄别"查询（剔除同系列旧款）。
- 提取模板：身份字段 + 规格字段提示 + 价格规则（全价格样本，禁单一价格，币种必标）。
- 回填格式：identity（每个规格值可带 source_url）+ images（url/source/page_url/angle/尺寸）。

**蒸馏（distill）逻辑**：
- 规格表只收带来源的键值，无源规格保留但记 gap 降级。
- 价格带归一：全样本取 min-max 区间。
- 官方卖点无源剔除（出事实区，记 gap）。
- 商品图逐张评分：官方渠道 +30 / 电商详情 +15 / 短边≥800px +20 / 带角度 +5 /
  AI 嫌疑 -100（出局）/ 水印 -10。按分排序，第一名即英雄照候选，
  编号 `{品牌前缀}-HERO-001`，其余 `-REF-NNN`。
- 授权风险分级：官方 low / 电商 mid / 其他 high（只标记不拦截，图仅作定妆照参考）。
- 有效图低于 2 张打 `needs_more_reference`（与定妆照门槛对齐）。

**质量自检**：输出必须过 A1_COLLECT 闸机（商品名非空 + 规格表 + 图候选数组在位）。

### A2 用户评价矿工（ReviewMiner）

**使命**：挖出营销弹药与避坑地图。

**任务书（plan）产出**：
- 7 路基础查询（综合口碑/差评区/踩雷贴/知乎/小红书/测评/追评）
  + 每个候选卖点 1 路定向验证查询（"官方吹的，用户认不认"）。
- 样本目标：≥10 条，差评/中评占比 ≥15%（防偏倚）。
- 回填格式：`[{ text(原文), source, url, rating?, date?, suspect? }]`。

**蒸馏（distill）逻辑**：
- 清洗：suspect 水军出局、40 字指纹去重、<4 字无效出局，清洗量上报。
- 方面级情感抽取：10 方面词库（质量/外观/续航/尺寸便携/性能/性价比/物流包装/
  客服售后/易用性/安全健康），rating 优先于词典定情感。
- 聚合：方面 → {point, mentions, 代表原话, source_refs, root_cause}，
  差评自动归根因桶（quality_defect/endurance_gap/...）。
- 场景提炼：人群/场景/时刻模式库（母婴/通勤/学生/户外/运动/夜间/高温/厨房/美妆）。
- 原话矿：情绪浓度 ≥1 且 8-80 字，按浓度排序取前 12。
- 偏倚警报：清洗后 ≥3 条且零差评 → 强制记 gap（真实商品必有差评）。

### A3 竞品侦察员（CompetitorScout）

**使命**：搞清楚跟谁抢注意力、哪里是空位。

**任务书（plan）产出**：
- 4 路发现查询（榜单/知乎横评/对头测评/小红书推荐）。
- 单竞品画像模板：价格/卖点/广告套路/差评 4 路 + 回填格式。
- 选择纪律：只留直接竞品（同品类且价格带重叠），封顶 3 个，
  每个竞品至少 1 条带来源卖点才准入列。

**蒸馏（distill）逻辑**：
- 相关性排序：品类贴合 +2 / 价格中点差 ≤30% +3 / 证据量加分。
- 空位计算：our_opening（我方有而竞品没讲的点）、
  crowded_points（竞品全在讲的点，硬碰硬下策）、
  weakness_openings（竞品弱点 = 我方攻击面）。

### A4 交叉验证官（CrossVerifier）

**使命**：装订前的事实审判（本模块命脉）。

**四把法尺**：
1. 定级：官方来源或 ≥2 独立来源 → confirmed；单一来源 → reported；
   无源 → 清除出事实区（记 purged）。独立来源按域名去重，防"一贴十转算十源"。
2. 冲突裁决：价格样本离散度 >30% 记 conflict，官方渠道优先；
   无官方则降级 reported 并要求下游标注浮动。
3. 无源清洗：观点/原话/竞品条目凡无证据编号一律清除，审判记录入 verification_report。
4. 优缺点签发：仅 confirmed/reported 进 pros_cons；
   官方宣称与用户共识分区标注（claim_nature: official/user），
   官方主打不等于用户认账。

### A5 档案装订员（DossierBinder）

**使命**：装订、校验、分发、沉淀。

**三道工序**：
1. 钩子预制：
   - data_points：规格硬数字 + 价格锚点（数据式钩子原料）。
   - conflicts：官方宣称 vs 用户吐槽的同方面反差、竞品弱点（冲突式钩子原料）。
   - questions：痛点/场景转译的疑问式钩子种子。
2. 装订：按 Schema 组装 → DossierSchema.validate 强校验 → 失败即拒收抛错。
3. 分发：六张摘要卡 + 落盘 `data/dossiers/{product_id}/`（dossier.json +
   images/manifest.json）+ 索引登记（默认 30 天 stale，可配置）。

## 四点五、人工确认闸（与创意主题确认同级）

档案装订完成后、注入下游之前，必须过人工确认：

1. 系统生成《商品情报档案确认单》（盒式，confirmation-sheet.js），
   摆出影响下游决策的关键事实：档案编号、商品、价格带（含置信度）、
   商品图数量与英雄照编号、卖点候选、竞品、证据条数，以及全部情报缺口。
2. 走系统标准确认通道（type: data-mining-dossier），等待 approve/reject。
3. **确认通过**：摘要卡注入 metadata._dataDossier，Brief 自动回填。
4. **驳回**：情报层整体退出本次任务，主流程无情报继续（不阻塞）。
5. 复用命中的档案同样要过确认闸（确认的是"这份旧情报还能不能用"）。
6. 批量模式（batchMode / skipDataMiningReview）免询问自动通过。

## 五、下游消费契约（六张摘要卡）

各环节只拿切片，不读全档（防情报过载冲垮下游上下文）：

| 卡 | 消费方 | 内容要点 |
|----|--------|----------|
| brief_card | MarketingBriefParser | 卖点≤3（用户共识优先于官方宣称）、人群、竞品、heroImageId |
| theme_card | CreativeThemeGenerator | 情绪锚点、避坑点、差异化空位、高频场景、原话灵感 |
| insight_card | RequirementDiscoveryEngine | 人群画像、共识点、差评地图、市场位势、竞品简报 |
| prd_card | PRDGenerator | 演示场景、卖点证据、合规红线（有真实吐槽的方面禁绝对化宣称）、钩子候选 |
| portrait_manifest | ProductPortraitBranch | 英雄照编号 + 参考图 manifest（免重复检索，只需核对真实性） |
| router_material | MarketingSkillRouter | 品类、实物/服务、钩子素材、风格信号 |

## 六、质量门清单（每次运行必过）

- [ ] 五站信封齐全，checksum 链式一致
- [ ] 事实区条目 100% 挂证据编号，inferred 0 条入档
- [ ] 评价样本清洗量上报，偏倚样本已警报
- [ ] 商品图 ≥2 张或已打 needs_more_reference
- [ ] 竞品 ≤3 且全部带来源卖点
- [ ] 官方宣称与用户共识在 pros 中分区标注
- [ ] 六张摘要卡齐全且无非 confirmed/reported 条目
- [ ] 档案落盘 + 索引登记完成

## 七、故障与降级

| 故障 | 行为 |
|------|------|
| A1 身份事实缺失 | 全线停摆，返回 ok:false + fatal error（身份都没有，档案无意义） |
| A2/A3 缺站或异常 | 记 gap 继续，档案照常装订 |
| A5 校验失败 | 抛错拒收（宁缺毋滥），主链路捕获后降级为无档案运行 |
| 档案过期（stale） | consume 返回 stale:true，由调用方决定沿用或重跑 |
