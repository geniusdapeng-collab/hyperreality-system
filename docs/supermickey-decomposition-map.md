# SuperMickey 全量拆解台账

> 源仓库：`geniusdapeng-collab/super-mickey`（master，v2.12.1，884 文件 / 122 目录）
> 目标：把每个环节拆解为「数码员工 Agent / 技能 Skill / 底座包 / 配置 / 文档 / 废弃」六态，融合进视频经理（videomanager）
> 四态处置标记：**【保留】**原样移植 ｜ **【转换】**改造后移植 ｜ **【隔离】**不迁移仅归档 ｜ **【废弃】**一次性/失效代码

---

## 0. 拆解总账

| 处置 | 数量级 | 说明 |
|---|---|---|
| 数码员工 Agent | **21 个** | 见 §1 编制表 |
| 技能 Skill | **230+ 个** | 203 好莱坞技能 + 20 营销技能 + 若干功能技能 |
| 底座包 | **9 组** | LLM 网关/契约/闸机/确认/安全工具/事件/状态机/健康/日志 |
| 配置包 | **8 组** | 平台蓝图、字数口径、语速、角度目录、音乐映射等 |
| CI 工程纪律 | **5 件** | agent-preflight / version-check / smoke / 技能索引构建 / 技能生命周期 |
| 废弃/隔离 | **~120 文件** | legacy/ 43 + systems/ 零引用 68 + 一次性补丁脚本若干 |

---

## 1. 数码员工编制表（21 个）

| # | 员工 | 源模块 | 类型 | 职责 |
|---|---|---|---|---|
| 1 | **总导演**（制片编排） | `hyperreality-system/index.js`（HyperrealitySystem.create，3625 行编排 Layer -2→4） | 编排 | 全链路编排、7 确认门触发、截止预算管理 |
| 2 | **情报官·采集** | `engines/data-mining-engine/agents/` A1 ProductInfoCollector | LLM | 商品身份/图片评分（官方+30/电商+15/短边≥800px+20/AI 嫌疑 -100） |
| 3 | **情报官·评价** | 同上 A2 ReviewMiner | LLM | ≥10 样本、差评≥15%、原话矿前 12 条、40 字指纹去重 |
| 4 | **情报官·竞品** | 同上 A3 CompetitorScout | LLM | 直接竞品≤3、差异化空位计算 |
| 5 | **情报官·核验** | 同上 A4 CrossVerifier | 规则 | 置信度三级 confirmed/reported/inferred、价格离散度>30% 记冲突 |
| 6 | **情报官·装订** | 同上 A5 DossierBinder | 规则 | Schema 强校验、落盘 dossiers、30 天 stale |
| 7 | **创意策划** | `skills/creative-theme-generator/`（12 字段主题 + 动态类型解析） | LLM | 创意主题生成、Brief 确认单 |
| 8 | **策略分析师×4** | `engines/requirement-discovery-engine.js`（AudienceProfiler/SceneArchitect/RiskAssessor/ReferenceCurator） | LLM | 受众画像/传播场景/风险/参考案例 |
| 9 | **PRD 专员×5** | `engines/prd-generator/agents/`（agent-1~5，2 LLM + 3 规则） | 混合 | 5 段式 PRD v3（时长唯一权威源） |
| 10 | **剧本师** | `engines/script-engine/`（IntentParser/ScriptGenerator/ScriptValidator/Adapter） | LLM | 意图→剧本蓝图（IC-2 单一事实源） |
| 11 | **场景设计师** | `engines/production-engine/agents/scene-design-agent.js` | LLM | 场景卡（情绪弧线/光档/调色/屏幕方向） |
| 12 | **片头设计师** | `agents/opening-design-agent.js` + `opening-title-optimizer.js` | LLM | 片头 30 字段（25+5 专属） |
| 13 | **视觉语言师** | `agents/visual-language-agent.js` | LLM | 镜头视觉设计 |
| 14 | **音频设计师** | `agents/audio-design-agent.js` | LLM | 音频/配乐/卡点设计 |
| 15 | **连贯审查官**（导演评审 v4 实现体） | `agents/continuity-review-agent.js` + `cross-episode-validator.js` | LLM | 6 问评审 + 5 维评分 + 硬阻断 |
| 16 | **提示词融合师**（Prompt Engine v4） | `agents/prompt-fusion-agent.js`（25 字段 schema 硬编码）+ `semantic-refinement-pass.js` + `field-content-refiner.js` | LLM | 逐镜 25 字段融合、三阶段精炼 |
| 17 | **字段质检员/修复员** | `engines/field-quality/`（FieldCheckAgent 784 行 + FieldRepairAgent 977 行） | LLM+规则 | 25 字段规则+LLM 混合质检、修复迭代 |
| 18 | **定妆照美术指导** | `engines/portrait-studio/`（lead 8 角度/supporting 4/prop）+ `portrait-resolver.js`（studio/uploaded/text 三模式） | 混合 | 角色/商品定妆照，禁虚构外观 |
| 19 | **渲染师** | `engines/rendering-engine/` + `scripts/render-submitter-core.js`（Seedance Ark API） | 工具 | 提交渲染、绑定定妆照清单、渲染后验证 |
| 20 | **剪辑师** | `engines/post-production-engine/`（904 行：字幕/音乐/弹幕/多版本）+ ffmpeg 链 | 规则 | 后期合成、平台化包装 |
| 21 | **微动作增强师** | `seedance-micromotion/`（5 路流水线：面部/身体/眼神/呼吸/融合官） | LLM | 渲染前微动作注入 |

> 新增经营员工（SuperMickey 没有，P5 新建）：**调研员**（趋势/竞品/评论挖掘）、**数据看板官**（发布后监控+早八点战报）、**评论区运营**（评论分类+候选回复）、**发布专员**（全平台 RPA 上传）。

## 2. 七个人工确认门 → IM 审批卡映射

源实现：`scripts/confirmation-*.js` 体系（HMAC-SHA256 签名 + run_id 绑定 + nonce 防重放 + webhook 推送）——**整体废弃，由 WorkLoom review-console 审批原生消息替代**（批准手势写回事件库，天然满足"不可伪造/可审计"）。

| 门 | 环节 | 原可跳过性 | 新围栏级别 |
|---|---|---|---|
| 1 | 商品情报档案 | batchMode 可跳 | 审批 |
| 2 | 创意主题 | 不可跳 | 审批 |
| 3 | 业务需求对齐清单 | 不可跳 | 审批 |
| 4 | PRD | 不可跳 | 审批 |
| 5 | 定妆照 | 可 auto/skip | 审批（可配自动） |
| 6 | 提示词审核 | 仅调试可跳 | 审批 |
| 7 | 预生产最终确认 | 仅调试可跳 | 审批 |
| +8（新增） | 渲染提交（花 API 额度） | — | 审批（可降级自动） |
| +9（新增） | 发布到公网平台 | — | 审批 |
| +10（新增） | 评论回复外发 | — | 三级分流（自动/审批/禁止） |

## 3. 质量闸机清单（全部【保留】移植为底座校验包）

| 闸机 | 源位置 | 说明 |
|---|---|---|
| PromptDeliveryGuard | `agents/prompt-delivery-guard.js` | 单镜 + 作品级 verifyPackage（片头在场/时长带/±15% 容差） |
| FieldGuard / FieldStandardizer / FieldConsistencyChecker | `engines/field-*.js`（204/799/995 行） | 字段守门/标准化唯一真源/25 维一致性 |
| PromptGuardian / RenderPipelineGuard | `engines/prompt-guardian.js`、`render-pipeline-guard.js` | 自动修复 + 渲染前强制检查 |
| ProductTruthChecker | `agents/product-truth-checker.js` | 事实红线一票否决 |
| MarketingComplianceGuard | `agents/marketing-compliance-guard.js` | L1 中文极限词/L2 英文欺骗词/L3 平台规则 |
| RequirementAlignmentGate | `engines/enhancers/requirement-alignment-gate.js` | 对齐阈值 0.7 |
| PortraitGuard | `systems/portrait-guard.js` | 无定妆照禁止提交渲染 |
| CameraCoherence / CoherenceValidator | `systems/camera-coherence/` | 运镜连贯性 |
| PipelineSchemas | `systems/schemas/pipeline-schemas.js` | 全链路数据契约（警告/严格双模式） |
| HandoffValidator + EvidenceLedger | `engines/data-mining-engine/pipeline/` | 情报层三层闸机 + 无源不入库 |
| PipelineIntegrityValidator | `production-engine/utils/pipeline-integrity-validator.js`（1248 行） | 管线完整性 |

## 4. 硬编码规范清单（配置化迁移，唯一真源原则）

| 规范 | 值 | 真源位置 | 迁移目标 |
|---|---|---|---|
| 镜头字段数 | 内容 25 / 片头 30（+5 专属） | `config/audit-standards.js` + `prompt-fusion-agent.js` schema | Bundle 配置 + zod schema |
| Prompt 长度 | 硬上限 3000；理想 2470-3000；精炼后 ≥1200 | `config/prompt-length.js` | 配置 |
| 语速 | 3.5 字/秒（slow 2.5） | `config/speech-rate.js` | 配置 |
| 单镜时长 | 3-15 秒 | `engines/duration-constraint/` | 配置 |
| 场景类型 | opening/establishing/conflict/emotional_climax/resolution | `script-engine/core/scene-type-normalizer.js` | 枚举 schema |
| 创意主题 | 12 字段 | `skills/creative-theme-generator/SKILL.md` | 技能规范 |
| 平台蓝图 | tiktok/抖音/小红书/视频号/快手/B站（画幅/时长带/速率/钩子/CTA/文字政策） | `config/platform-profiles.js` | Bundle 配置（P5 扩展 YouTube 等） |
| PRD 结构 | prd-schema-v3（551 行） | `engines/prd-generator/schema/` | zod schema |
| 接口契约 IC-1~IC-5 | UserIntent/ScriptBlueprint/ShotPrompt/RenderedClip/FinalVideo | `architecture-v2/interface-contract-v1.md` | 数码员工间消息契约（zod） |
| 合规词库 | 三级 | `marketing-compliance-guard.js` | 围栏规则包 |
| 情报铁律 | 置信度三级/图片评分/竞品≤3/stale 30 天 | `data-mining-engine/` | 技能规范 |

## 5. 底座包迁移清单

| 包 | 源 | 处置 |
|---|---|---|
| LLM 网关 | `systems/llm-reasoning-engine.js`（10 处引用最高频）+ `shields/llm-gateway/`（死代码，概念保留） | 【转换】接入 dsh model-router，不搬代码 |
| 确认中间件 | `scripts/confirmation-*` 全家 + `run-coordinator.js` + `preproduction-gatekeeper.js` | 【转换】由 review-console 替代，代码不迁移 |
| 渲染提交核心 | `scripts/render-submitter-core.js`（binding-manifest 强制、提交后验证） | 【保留】包装为渲染师工具 |
| safe-* 工具族 | `hyperreality-system/utils/` 13 件（safe-fs/safe-clone/safe-regex/safe-random/json-salvage 等） | 【保留】入 shared |
| 事件/状态机 | `infrastructure/event-bus.js` + `core/pipeline-state-machine.js` + `llm-concurrency-limiter.js` | 【转换】事件落 WorkData；状态机由 Quest replay 替代 |
| 健康监控 | `shields/health-monitor/`（461 行） | 【转换】概念并入 night-shift |
| 审计日志 | `systems/audit-logger.js`（JSONL）+ `pipeline-logger.js` | 【转换】由 WorkData 五元事件替代 |
| 工程纪律 CI | `scripts/agent-preflight.js`、`version-check.js`、`preflight_check.js`、根 `smoke-test.js`、`.github/workflows/ci.yml` | 【保留】改造进 CI |
| 技能治理 | `scripts/build-skill-index.js`、`compile-skills.js`、`skill-lifecycle-report.js` + `docs/skill-supply-spec.md` | 【转换】对接 WorkLoom 技能市场三级体系 |

## 6. 技能内容库（【保留】批量转换）

- **好莱坞工业电影技能工厂**：203 个 .md（10 题材 × 9 导演 + 微表情系列 ~30 + 孤独系列 3 等），`skills/好莱坞工业电影技能工厂/技能系列/镜头级专项/`
- **营销技能 20 个**：`skills/social-marketing/skills/`（钩子 4 式/种草 3/演示 3/剪辑 3/UGC 3/收尾 4）
- **功能技能**：seedance-shot-design（纯指令技能 + 6 份知识库）、opening-cinematic（片头 6 件）、story-craft-engine（编剧 8 件）、情绪三件套、增强器五件套、marketing-brief、camera-coherence
- **知识库 references**：cinematography/audio-tags/director-styles/quality-anchors/scenarios/seedance-specs → 组织记忆 RAG 资料
- **模板**：`templates/` 5 件（scene-card/shot-card-v4/prompt-v4/director-review-form/project-config）

## 7. 废弃/隔离清单（不带入新仓库）

| 区 | 内容 |
|---|---|
| `legacy/`（43 文件） | 同名诱饵 field-guard 等 19 + 失效 scripts 4 + theme-diversity-test-engine 9 + micromotion-test 5 + 备份 5 |
| `systems/` 零引用文件（68 个） | 逐个核对后隔离；其中合规族/增强族概念由活体模块覆盖 |
| 一次性脚本 | `patch-*.py` 6 件、`start-g001.sh`、`start-preproduction{,-v2}.sh`（硬编码作者路径）、`submit-production-v6.3-patch2.sh`、`prepare-render-submit.js`、`process-remaining-shots.js`、`fix-render-prompts.js`、`clean-beast-database.js`、`internal/check|fix-code-consistency.sh` |
| 半死代码 | `shields/stability-shield.js`（produce 从未被调用）、`infrastructure/saga-orchestrator.js`（主链路未消费）、`systems/event-bus-pilot.js`（与 event-bus 重复）、`llm-gateway`（未接线） |
| 旧版子系统 | `seedance-director/`（依赖仓库外 openclaw 技能，悬空引用）、`seedance-agent/`（ESM 重构分支，**其 Agent Loop/权限门/状态机/通知器抽象作为架构参照，代码不搬**） |
| 后期四实现收敛 | `systems/post-production-pipeline.js`、`seedance-post-production/`、`scripts/post-production-*` → 全部收敛到 `engines/post-production-engine/`，仅吸收 ffmpeg 路径解析健壮性 |
| 历史文档 | 4 份审计/诊断 md、`docs/report-to-user.md` → 归档不带入 |
| 示例业务数据 | `data/nirath-*`（山海经 IP 数据）、`tasks/EX-005` 样例 → 作为 demo 种子可选 |

## 8. 外部耦合点（拆出时必须处理）

1. `scripts/confirmation-*` → review-console 审批卡（已设计）
2. `systems/llm-reasoning-engine.js` → dsh model-router（OpenAI 兼容端点四环境变量）
3. `scripts/render-submitter-core.js` → 渲染师工具（Seedance Ark API，密钥走 .env）
4. `../characters/` 定妆照存储 → asset-cms 素材库
5. `panda-cineforge`（Python 微服务 :8765，F1-F7 技能召回）→ 可选外部工具服务，首期标记为「禁用/可插拔」
6. 密钥双名统一：`ARK_API_KEY` / `VOLCENGINE_ARK_API_KEY` → 统一 `VOLCENGINE_ARK_API_KEY`；`KIMI_API_KEY` 等 → 底座 `LLM_*` 四变量

## 9. website/ 资产处置

React 19 + shadcn 官网（99 文件）。**【隔离】**不迁入产品代码；shadcn ui 组件与 i18n 机制作为舰桥「片库/看板」新页面的参考；营销文案不搬。

---

**覆盖声明**：本台账基于 master 全量克隆（884 文件）逐区精读产出，顶层 24 个目录 + 根 24 文件全部登记；逐文件级四态明细在执行移植时以 git commit 为准逐批落实。
