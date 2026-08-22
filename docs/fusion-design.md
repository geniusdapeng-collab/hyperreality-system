# 视频经理（HyperReality）· 融合设计

> SuperMickey 制作能力 × WorkLoom 人机协作底座 = AI视频制作智能经营系统
> 依据：`docs/supermickey-decomposition-map.md`（拆解台账）｜状态：已确认决策 v1.1

## 0. 已确认决策

| 项 | 决策 |
|---|---|
| 仓库 | `hyperreality`（中文名「视频经理」），私有，建在 geniusdapeng-collab 下 |
| 复刻 | 保留 workloom-im 完整 git 历史 |
| 渲染 | 产出**渲染脚本**入 CMS「脚本管理」模块：版本管理 + 工作台 MD 展示 + 本地编辑；支持批量自动提交 Seedance / 手动点击渲染 / 全自动化任务（渲染→发布→监控连锁） |
| 发布 | **全平台电脑模拟人工上传（RPA）**：抖音 / TikTok / 小红书 / 视频号 / B站 / YouTube |

## 1. 总体落位

```
vendor/supermickey/        # SuperMickey 活体代码整体入驻（CommonJS 零依赖，按台账剔除废弃区）
packages/video-studio/     # ★ 新增 TS 适配层（seam）：把 SuperMickey 引擎接到 dsh 运行时 + WorkData + 围栏
packages/base/asset-cms/   # ★ 新增底座包：素材/成片/渲染脚本 CMS
packages/base/publish-rpa/ # ★ 新增底座包：全平台模拟人工上传发布
packages/base/social-listening/ # ★ 新增底座包：账号数据监控 + 评论采集
bundles/ai-video/          # ★ 行业 Bundle：25 数码员工 preset + 围栏包 + Quest 管线 + 技能套件 + schema
```

**设计红线（继承双方纪律）**
1. 底座已有 11 个 base 包**零改动**（H-15）；视频能力全部经新增包 + Bundle 注入
2. SuperMickey 侧**规范唯一真源**原则保留：字段数/字数/语速等从 vendor 代码读取，不在 TS 层复制字面值
3. 所有外发动作（渲染提交/发布/评论回复）一律过 fence-engine；所有产物落 biz_events 五元事件

## 2. 数码员工编制（25 个 preset）

### 2.1 制作班组（21 个，映射拆解台账 §1）

| preset_key | 姓名 | kind | 关键 tools | fence 绑定 |
|---|---|---|---|---|
| director | 总导演 | orchestrator | project.create / pipeline.advance / gate.request | G2-G7 |
| intel-collector / intel-reviewer / intel-competitor / intel-verifier / intel-binder | 情报科五站 | research | research.search / dossier.write / dossier.read | G1 |
| creative-planner | 创意策划 | content | theme.generate / brief.parse | G2 |
| insight-analyst | 策略分析师（内部 4 角色） | analyst | insight.generate | G3 |
| prd-specialist | 制片人（内部 5 站） | content | prd.generate | G4 |
| scriptwriter | 剧本师 | content | script.generate / script.validate | — |
| scene-designer | 场景设计师 | content | scene.design | — |
| opening-designer | 片头设计师 | content | opening.design | — |
| visual-director | 视觉语言师 | content | visual.design | — |
| audio-designer | 音频设计师 | content | audio.design | — |
| continuity-reviewer | 导演评审 | reviewer | review.score / review.block | G6 |
| prompt-fuser | 提示词工程师 | content | prompt.fuse / prompt.refine / prompt.verify | G6 |
| field-inspector | 字段质检员（含修复） | reviewer | field.check / field.repair | — |
| portrait-artist | 定妆照美术指导 | artist | portrait.plan / portrait.render / refimage.verify | G5 |
| micromotion-stylist | 微动作增强师 | artist | motion.inject | — |
| render-operator | 渲染师 | operator | render.script.gen / render.submit / render.poll | G8 |
| post-editor | 剪辑师 | operator | post.compose / ffmpeg.run | — |

### 2.2 经营班组（4 个，新建）

| preset_key | 姓名 | 职责 | fence |
|---|---|---|---|
| trend-researcher | 调研员 | 趋势/竞品账号/爆款拆解/评论语义挖掘（珍妮纺织机范式泛化） | — |
| publish-operator | 发布专员 | RPA 模拟人工上传全平台；发布包校验 | G9 |
| metrics-watcher | 数据看板官 | 定时采集账号/视频数据、阈值告警、早八点战报（night-shift + inspection） | — |
| comment-operator | 评论区运营 | 评论采集→分类→候选回复；夸赞自动回/售后转人工/负面审批+告警 | G10 |

## 3. 审批点矩阵（10 门 → approvals 原生消息）

| 门 | 对象类型 | 触发动作 | 默认级别 | 说明 |
|---|---|---|---|---|
| G1 | dossier | dossier.confirm | review | 商品情报档案确认（可配 batchMode 自动） |
| G2 | theme | theme.confirm | review | 创意主题/Brief |
| G3 | insight | insight.confirm | review | 业务需求对齐清单 |
| G4 | prd | prd.confirm | review | PRD（时长唯一权威） |
| G5 | portrait_set | portrait.confirm | review | 定妆照（可配 auto） |
| G6 | prompt_package | prompt.confirm | review | 镜头提示词审核（含导演评分报告） |
| G7 | project | preproduction.finalize | review | 预生产最终确认 |
| G8 | render_script | render.submit | review | 渲染提交（烧额度，可降级 auto） |
| G9 | publish_task | publish.execute | review | 公网发布（新平台首发必审基线） |
| G10 | comment_reply | comment.reply | 三级分流 | 夸赞/感谢 auto；咨询/售后 review；负面/危机 review+告警；政治敏感等 block |

## 4. Quest 管线模板（bundles/ai-video/pipelines/）

```yaml
# narrative-film.yml（叙事片管线）
quest: narrative-film
steps: [script → scene → opening → visual+audio → continuity → prompt-fuse
        → field-check → G6 → portrait → G5 → G7 → render-script → G8 → render → post → 成片入库]
# marketing-film.yml（营销片管线，前置情报层）
quest: marketing-film
steps: [intel×5站 → G1 → creative → G2 → truth-check(阻断闸) → insight → G3
        → prd → G4 → 叙事片后半段同构 → publish-plan → G9 → publish → watch]
# account-ops.yml（账号经营管线，7×24）
quest: account-ops
steps: [metrics.collect(每2h) → threshold.check → 早八点战报
        评论采集(每30min) → 分类 → G10分流 → 回复/转人工]
```

每步 = Quest 任务卡；断点续跑继承 dsh replay；每步产物写 biz_events。

## 5. 数据模型扩展（`packages/db/migrations/0009_video_studio.sql`）

新表（全部 RLS + append-only 事件联动）：

| 表 | 说明 |
|---|---|
| `video_projects` | 一部片子/一个营销 Campaign（关联 thread_id） |
| `video_assets` | 素材库：商品图/参考图/定妆照/片段/成片；含 kind、version、source_url、provenance、license_risk、hero_image_id、sha256 |
| `render_scripts` | **渲染脚本 CMS 核心表**：project_id、shot_id、版本链（parent_version）、status（draft/approved/submitted/rendering/done/failed）、md 正文、25/30 字段 JSON、字符数校验快照 |
| `render_jobs` | Seedance 提交记录：task_id、script_version、cost、result_url |
| `publish_tasks` | 发布任务：platform（douyin/tiktok/xhs/shipinhao/bilibili/youtube）、账号、文案、定时、RPA 执行状态 |
| `account_metrics` | 账号/视频指标时序（播放/点赞/评论/分享/转化），夜班采集落账 |
| `comments` + `comment_replies` | 评论采集与回复（意图分类、分流级别、外发回执） |

对象/阶段枚举进 `bundles/ai-video/schemas/objects.json|stages.json`。

## 6. 渲染脚本 CMS 模块（asset-cms 子模块，决策 4 落地）

- **生成**：提示词工程师交付后，逐镜生成渲染脚本（MD 格式，含 25/30 字段 + 定妆照绑定 + 平台蓝图参数），入 `render_scripts` v1
- **版本管理**：每次人工/Agent 修改产生新版本（parent_version 链），diff 可见；版本即审批对象
- **工作台展示**：舰桥新增「片库·脚本」页，MD 渲染展示 + 字段结构侧栏 + 字数口径实时校验（2470-3000/≤3000）
- **本地编辑**：工作台内嵌 MD 编辑器直接改；保存即新版本 + 自动重跑 PromptDeliveryGuard
- **提交模式三档**（G8 围栏控制）：
  1. **手动**：点「渲染」单镜提交 Seedance
  2. **批量**：整片批量提交，渲染师轮询回填 render_jobs
  3. **自动化连锁**：triggers 定义 `render.done → post.compose → publish_task → watch` 全自动流（默认全链 review，信任后可逐环降 auto）

## 7. 全平台 RPA 发布（publish-rpa，决策 5 落地）

- 形态：**电脑模拟人工上传**（desktop 端内嵌 Playwright/Chromium 操作浏览器；Mac 桌面包首发）
- 平台适配器：`adapters/{douyin,tiktok,xiaohongshu,shipinhao,bilibili,youtube}.ts`，统一接口 `login check → upload(video, cover, caption, tags, schedule) → receipt`
- 每平台适配器含：上传入口 URL、表单定位器、平台文案规格（标题字数/话题/合集/定时规则，与 platform-profiles 对齐）、成功回执检测、失败重试与人工接管点
- 风控纪律：模拟人工节奏（打字延迟/分页等待）、单账号日上限、异常即挂起转人工；登录态由用户本人在桌面包内完成，凭据只存本机（credentials 表引用，不落明文）
- 首期实现 douyin + xiaohongshu + bilibili + youtube 四适配器参考实现，tiktok/shipinhao 预留接口（需真实账号环境联调）

## 8. 环境变量统一

| 用途 | 统一变量 |
|---|---|
| LLM | 沿用底座 `LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`（vendor 层经适配器读取，STORMAXE_*/SUPERMICKEY_* 别名仅 vendor 内部兼容） |
| 渲染 | `VOLCENGINE_ARK_API_KEY`、`SEEDANCE_ENDPOINT`、`SEEDREAM_ENDPOINT` |
| 发布 | 平台登录态走桌面包本地 session，无环境变量 |

## 9. vendor/supermickey 入驻边界

带入（按台账【保留/转换】）：`hyperreality-system/` 全量（含 engines/skills/config/infrastructure/utils）、`systems/` 活体 17 件、`seedance-micromotion/`、`scripts/render-submitter-core.js`、`templates/`、`architecture-v2/`、203+20 技能 md、CI 四件套脚本
不带入：legacy/、website/、seedance-director/、seedance-agent/（仅作架构参照）、systems/ 零引用 68 件、一次性补丁脚本、nirath 示例数据（留作 demo 种子备选）
适配点（packages/video-studio）：`HyperrealitySystem.create` 的 7 确认门 hook 到 review-console；`_resolveLLMEngine` 接 model-router；`rendering-engine` 改走 render_scripts CMS；产物落 biz_events。
